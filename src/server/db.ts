import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

export const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
export type Sql = NonNullable<typeof sql>;

// Bump when the DDL below changes; cold starts skip all DDL when the stored version matches.
const SCHEMA_VERSION = '2026-09-30-b2b-catalog';

// All DDL for the schema, run as one transaction (one round trip instead of ~30)
export function schemaStatements(db: Sql) {
  return [
    db`CREATE EXTENSION IF NOT EXISTS vector`,

    // Knowledge base (RAG). `source` marks rows imported from paketshop.uz so a sync can replace exactly those.
    db`CREATE TABLE IF NOT EXISTS knowledge_base (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    db`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS image_url TEXT`,
    db`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS video_url TEXT`,
    db`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS embedding vector(768)`,
    db`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS source TEXT`,

    // Products. Catalog fields (sku, pack info, ...) come from the paketshop.uz sync.
    db`CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price NUMERIC NOT NULL,
      image_url TEXT,
      category TEXT,
      stock INTEGER DEFAULT 10,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS url TEXT`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS name_ru TEXT`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS description_ru TEXT`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS category_ru TEXT`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS price_on_request BOOLEAN DEFAULT FALSE`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_unit TEXT`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_qty INTEGER`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_qty_unit TEXT`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS packs_per_box INTEGER`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS box_qty INTEGER`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_price NUMERIC`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS min_order INTEGER`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS price_tiers JSONB`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_note TEXT`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS source TEXT`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`,
    db`ALTER TABLE products ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP`,
    db`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku)`,

    // Orders double as the assistant's "requests" (a manager confirms stock and the final price)
    db`CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      delivery_address TEXT NOT NULL,
      items JSONB NOT NULL,
      total_price NUMERIC NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    db`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT`,

    // CRM
    db`CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      web_session_id TEXT UNIQUE,
      name TEXT,
      phone TEXT,
      address TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Simple key-value settings (webhook cache, bot events, schema version)
    db`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Conversation history (persisted per user, serverless-safe) + rolling summary
    db`CREATE TABLE IF NOT EXISTS conversation_history (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      web_session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    db`CREATE INDEX IF NOT EXISTS idx_history_telegram ON conversation_history(telegram_id, created_at DESC)`,
    db`CREATE INDEX IF NOT EXISTS idx_history_web ON conversation_history(web_session_id, created_at DESC)`,
    db`CREATE TABLE IF NOT EXISTS conversation_summary (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      web_session_id TEXT UNIQUE,
      summary TEXT NOT NULL,
      last_summarized_history_id INTEGER,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  ];
}

let initPromise: Promise<void> | null = null;

// Idempotent and memoised: callers that need the schema (tools, sync) can simply `await initDb()`.
export function initDb(): Promise<void> {
  if (!sql) return Promise.resolve();
  if (!initPromise) initPromise = runInit(sql);
  return initPromise;
}

async function runInit(db: Sql): Promise<void> {
  try {
    let current: string | undefined;
    try {
      const rows = await db`SELECT value FROM app_settings WHERE key = 'schema_version'`;
      current = rows[0]?.value;
    } catch { /* app_settings doesn't exist yet: first run */ }
    if (current === SCHEMA_VERSION) return;

    await db.transaction(schemaStatements(db));

    // HNSW index for fast cosine-distance search; optional (older pgvector versions lack it)
    try {
      await db`CREATE INDEX IF NOT EXISTS idx_knowledge_embedding_hnsw ON knowledge_base USING hnsw (embedding vector_cosine_ops)`;
    } catch (idxErr) {
      console.warn("HNSW index creation skipped (pgvector may be too old):", idxErr);
    }

    await db`
      INSERT INTO app_settings (key, value, updated_at) VALUES ('schema_version', ${SCHEMA_VERSION}, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
    `;
    console.log(`Database schema updated to ${SCHEMA_VERSION}`);
  } catch (err) {
    console.error("DB init error:", err);
    initPromise = null; // allow a retry on the next call
  }
}
