import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

export const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

export async function initDb() {
  if (!sql) return;
  try {
    // Enable pgvector extension
    await sql`CREATE EXTENSION IF NOT EXISTS vector;`;

    // 1. Knowledge Base Table
    await sql`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await sql`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS image_url TEXT;`;
    await sql`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS video_url TEXT;`;
    await sql`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS embedding vector(768);`;
    // HNSW index for fast cosine-distance similarity search
    try {
      await sql`
        CREATE INDEX IF NOT EXISTS idx_knowledge_embedding_hnsw
        ON knowledge_base USING hnsw (embedding vector_cosine_ops);
      `;
    } catch (idxErr) {
      console.warn("HNSW index creation skipped (pgvector may be too old):", idxErr);
    }
    console.log("Knowledge base table checked/created with pgvector support");

    // 2. Products Table
    await sql`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price NUMERIC NOT NULL,
        image_url TEXT,
        category TEXT,
        stock INTEGER DEFAULT 10,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("Products table checked/created");

    // 3. Orders Table
    await sql`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        delivery_address TEXT NOT NULL,
        items JSONB NOT NULL,
        total_price NUMERIC NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("Orders table checked/created");

    // 3.5. Customers Table for CRM & personalization
    await sql`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE,
        web_session_id TEXT UNIQUE,
        name TEXT,
        phone TEXT,
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("Customers table checked/created");

    // 3.55. Simple key-value settings (e.g. last webhook URL)
    await sql`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("App settings table checked/created");

    // 3.6. Conversation History — persists chat per user (serverless-safe)
    await sql`
      CREATE TABLE IF NOT EXISTS conversation_history (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT,
        web_session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_history_telegram ON conversation_history(telegram_id, created_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_history_web ON conversation_history(web_session_id, created_at DESC);`;
    console.log("Conversation history table checked/created");

    // 3.7. Conversation summary — older context compressed into a paragraph
    await sql`
      CREATE TABLE IF NOT EXISTS conversation_summary (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE,
        web_session_id TEXT UNIQUE,
        summary TEXT NOT NULL,
        last_summarized_history_id INTEGER,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("Conversation summary table checked/created");


    // 4. Seed initial products if database is empty
    const productCountRes = await sql`SELECT COUNT(*)::integer as count FROM products`;
    const count = productCountRes[0]?.count || 0;
    if (count === 0) {
      console.log("Seeding initial products into database...");
      await sql`
        INSERT INTO products (name, description, price, category, stock, image_url) VALUES
        ('Samarqand noni', 'Samarqandning mashhur va to''yimli, o''ziga xos ta''mga ega bo''lgan an''anaviy noni. Tandirdan yangi uzilgan.', 15000, 'Non mahsulotlari', 50, 'https://res.cloudinary.com/dbtdtj6te/image/upload/v1716223400/non.jpg'),
        ('Parkent shirin uzumi', 'Toshkent viloyati Parkent tumanining tog''oldi hududlarida yetishtirilgan sershira, shirin va yangi uzilgan qora uzum.', 30000, 'Mevalar', 30, 'https://res.cloudinary.com/dbtdtj6te/image/upload/v1716223400/uzum.jpg'),
        ('Marg''ilon milliy atlasi', 'Farg''ona vodiysining qadimiy Marg''ilon shahrida ipak tolalardan to''qilgan, milliy naqshlar tushirilgan sharf yoki mato.', 180000, 'Kiyim va matolar', 15, 'https://res.cloudinary.com/dbtdtj6te/image/upload/v1716223400/atlas.jpg'),
        ('Sirdaryo asal qovuni', 'Sirdaryo viloyatining sershira, o''ta shirin va hidli, og''izda eriydigan asal qovuni.', 45000, 'Mevalar', 20, 'https://res.cloudinary.com/dbtdtj6te/image/upload/v1716223400/qovun.jpg'),
        ('Chilonzor somsasi (go''shtli)', 'Chilonzordagi mashhur katta tandirda pishirilgan, mayda to''g''ralgan mol go''shti va piyoz bilan to''ldirilgan sershira somsa.', 12000, 'Taomlar', 100, 'https://res.cloudinary.com/dbtdtj6te/image/upload/v1716223400/somsa.jpg')
      `;
      console.log("Seeding completed successfully!");
    }
  } catch (err) {
    console.error("DB init error:", err);
  }
}
