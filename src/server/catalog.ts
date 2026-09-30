// Catalog access for the assistant (list / search / details / quotes / requests) and the paketshop.uz sync.
// Every function takes the database handle as a parameter so it can be tested without a live Neon connection.

import { createHash } from 'crypto';
import type { Sql } from './db.js';
import { fetchInfoSections, fetchProducts, type SiteProduct, type SiteSection } from './paketshop.js';
import { notifyNewRequest } from './notify.js';
import { tashkentNow } from './shopInfo.js';

const SOURCE = 'paketshop.uz';
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

// ---------- shaping rows for the model ----------

type Row = Record<string, any>;

// The model gets neutral codes/English notes (not Uzbek sentences) so it phrases everything in the customer's own language
// instead of mixing languages; the system prompt explains each code.
function availability(note: string | null): 'in_stock' | 'low_stock' | 'check_with_manager' {
  if (note && /mavjud/i.test(note)) return 'in_stock';
  if (note && /kam/i.test(note)) return 'low_stock';
  return 'check_with_manager';
}

function compact(r: Row) {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    name_ru: r.name_ru || undefined,
    category: r.category,
    price_per_pack: r.price_on_request ? null : num(r.price),
    price_on_request: r.price_on_request ? true : undefined,
    pack_unit: r.pack_unit || 'qadoq',
    pieces_per_pack: num(r.pack_qty),
    approx_price_per_piece: r.price_on_request ? null : num(r.unit_price),
    availability: availability(r.stock_note),
  };
}

function detailed(r: Row) {
  const tiers = Array.isArray(r.price_tiers) ? r.price_tiers : [];
  return {
    ...compact(r),
    description: String(r.description || '').slice(0, 1200),
    description_ru: r.description_ru ? String(r.description_ru).slice(0, 600) : undefined,
    min_order_packs: num(r.min_order),
    packs_per_box: num(r.packs_per_box),
    pieces_per_box: num(r.box_qty),
    volume_prices: tiers.length ? tiers : undefined,
    volume_prices_note: tiers.length ? "Only for these quantity ranges; for other quantities the manager sets the price" : undefined,
    product_page: r.url || undefined,
  };
}

// ---------- search ----------

const escapeLike = (s: string) => s.replace(/[\\%_]/g, m => `\\${m}`);

// Light stemming so "stakanlar" finds "stakan" and "пакеты" finds "пакет"
function stem(token: string): string {
  let t = token;
  if (t.length >= 6) t = t.replace(/(larning|larni|lari|lar|ning|dan|ga|ni|da)$/i, '');
  if (t.length >= 5 && /[а-яё]/i.test(t)) t = t.replace(/(ами|ями|ов|ев|ей|ы|и|а|я|е|у|ю)$/i, '');
  return t.length >= 2 ? t : token;
}

export function queryTokens(query: string): string[] {
  const q = query
    .toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/(?<=\d)\s*[х×*]\s*(?=\d)/g, 'x')   // 20х30, 20×30, 20*30 -> 20x30
    .replace(/(?<=\d)\s+x\s+(?=\d)/g, 'x');       // 20 x 30 -> 20x30
  return [...new Set(q.split(/[^\p{L}\p{N}'x.,]+/u).map(t => t.replace(/^[.,']+|[.,']+$/g, '')).filter(t => t.length >= 2).map(stem))].slice(0, 8);
}

export async function listProducts(db: Sql, category?: string) {
  const cat = category?.trim();
  const rows = cat
    ? await db`SELECT id, sku, name, name_ru, category, price, price_on_request, pack_unit, pack_qty, unit_price, stock_note
               FROM products WHERE active AND (category ILIKE ${'%' + escapeLike(cat) + '%'} OR category_ru ILIKE ${'%' + escapeLike(cat) + '%'})
               ORDER BY category, id`
    : await db`SELECT id, sku, name, name_ru, category, price, price_on_request, pack_unit, pack_qty, unit_price, stock_note
               FROM products WHERE active ORDER BY category, id`;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.category ?? '-', (counts.get(r.category ?? '-') ?? 0) + 1);
  return {
    success: true,
    categories: [...counts.entries()].map(([name, count]) => ({ name, count })),
    products: rows.map(compact),
  };
}

export async function searchProducts(db: Sql, query: string) {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return listProducts(db);
  const patterns = tokens.map(t => `%${escapeLike(t)}%`);
  const rows = await db`
    SELECT * FROM (
      SELECT id, sku, name, name_ru, category, price, price_on_request, pack_unit, pack_qty, unit_price, stock_note,
        (SELECT COUNT(*) FROM unnest(${patterns}::text[]) AS p
          WHERE (coalesce(sku, '') || ' ' || name || ' ' || coalesce(name_ru, '') || ' ' || coalesce(category, '') || ' ' || coalesce(category_ru, '')
                 || ' ' || coalesce(description, '') || ' ' || coalesce(description_ru, '')) ILIKE p) AS score
      FROM products WHERE active
    ) t WHERE score > 0 ORDER BY score DESC, id LIMIT 8`;
  if (rows.length === 0) return { success: true, products: [], message: "No product in the catalog matched this query" };
  return { success: true, products: rows.map(compact) };
}

export async function getProduct(db: Sql, id: number) {
  const r = await db`SELECT id, sku, name, name_ru, description, description_ru, category, category_ru, price, price_on_request,
      pack_unit, pack_qty, pack_qty_unit, packs_per_box, box_qty, unit_price, min_order, price_tiers, stock_note, url, image_url
    FROM products WHERE id = ${id} AND active`;
  if (r.length === 0) return { error: "Product not found" };
  return { success: true, product: detailed(r[0]) };
}

// ---------- quotes ----------

export type QuoteInput = { product_id: number; packs: number };

type Tier = { from: number; to: number | null; unit?: string; price: number };

export async function calculateQuote(db: Sql, items: QuoteInput[]) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 30) return { error: "Invalid product list" };
  const lines: any[] = [];
  let total = 0;
  const unpriced: string[] = [];
  const notes: string[] = [];

  for (const item of items) {
    const packs = Number(item?.packs);
    const id = Number(item?.product_id);
    if (!Number.isInteger(id) || !Number.isInteger(packs) || packs < 1 || packs > 100000) return { error: "Invalid product id or number of packs" };
    const rows = await db`SELECT id, sku, name, price, price_on_request, pack_unit, pack_qty, pack_qty_unit, min_order, price_tiers
                          FROM products WHERE id = ${id} AND active`;
    const p = rows[0];
    if (!p) return { error: `Product not found (id ${id})` };

    const unit = p.pack_unit || 'qadoq';
    const pieces = p.pack_qty ? Number(p.pack_qty) * packs : null;
    if (p.price_on_request || !(Number(p.price) > 0)) {
      unpriced.push(p.name);
      lines.push({ product_id: p.id, sku: p.sku, name: p.name, packs, unit, pieces, price_per_pack: null, line_total: null, note: "Price on request: the manager sets it" });
      continue;
    }

    let price = Number(p.price);
    let tierApplied: Tier | null = null;
    const tiers: Tier[] = Array.isArray(p.price_tiers) ? p.price_tiers : [];
    for (const t of tiers) {
      if (packs >= t.from && (t.to === null || packs <= t.to)) { tierApplied = t; price = Number(t.price); }
    }
    const lineNotes: string[] = [];
    if (tierApplied) lineNotes.push(`Volume price applied for ${tierApplied.from}${tierApplied.to ? '–' + tierApplied.to : '+'} ${unit}`);
    const maxTier = tiers.reduce((m, t) => Math.max(m, t.to ?? t.from), 0);
    if (tiers.length && packs > maxTier) lineNotes.push("Beyond the listed volume tiers: the manager sets the price for this quantity");
    if (p.min_order && packs < Number(p.min_order)) lineNotes.push(`Minimum order is ${p.min_order} ${unit}`);

    const lineTotal = price * packs;
    total += lineTotal;
    lines.push({ product_id: p.id, sku: p.sku, name: p.name, packs, unit, pieces, price_per_pack: price, line_total: lineTotal, note: lineNotes.join('; ') || undefined });
  }

  if (unpriced.length) notes.push(`Price on request, NOT included in the total: ${unpriced.join(', ')}`);
  notes.push("This is an estimate: the manager confirms stock and the final price.");
  return { success: true, lines, total_estimate: total, currency: "so'm", priced_all: unpriced.length === 0, notes };
}

// ---------- requests (orders that a manager confirms) ----------

export type RequestInput = {
  customer_name: string;
  customer_phone: string;
  region: string;
  delivery_method?: string;
  company?: string;
  notes?: string;
  items: QuoteInput[];
};

export type RequestContext = { telegramId?: number; webSessionId?: string };

const HOURLY_LIMIT_PER_PHONE = 3;
const HOURLY_LIMIT_TOTAL = 40;

export async function createRequest(db: Sql, input: RequestInput, ctx: RequestContext = {}) {
  const name = String(input?.customer_name ?? '').trim();
  const phone = String(input?.customer_phone ?? '').trim();
  const region = String(input?.region ?? '').trim();
  if (!name || name.length > 100) return { error: "The customer's name is required" };
  if (phone.replace(/\D/g, '').length < 9 || phone.length > 20) return { error: "The phone number is invalid" };
  if (!region || region.length > 200) return { error: "The city or region is required" };

  const quote: any = await calculateQuote(db, input.items);
  if (quote.error) return quote;

  const address = [region, input.delivery_method?.trim()].filter(Boolean).join(' · ').slice(0, 300);
  const notes = [input.company?.trim() && `Kompaniya: ${input.company.trim()}`, input.notes?.trim()].filter(Boolean).join('\n').slice(0, 1000) || null;
  const itemsJson = JSON.stringify(quote.lines);

  // Same customer sending the same request again (model retry / double tap): return the existing one
  const dup = await db`SELECT id FROM orders WHERE customer_phone = ${phone} AND items = ${itemsJson}::jsonb AND created_at > now() - interval '10 minutes' LIMIT 1`;
  if (dup.length) return { success: true, request_id: dup[0].id, duplicate: true, total_estimate: quote.total_estimate, priced_all: quote.priced_all, ...hoursInfo() };

  // Abuse guard: this endpoint is public and every request pings the managers
  const recent = await db`SELECT COUNT(*) FILTER (WHERE customer_phone = ${phone})::int AS by_phone, COUNT(*)::int AS total
                          FROM orders WHERE created_at > now() - interval '1 hour'`;
  if (recent[0].by_phone >= HOURLY_LIMIT_PER_PHONE || recent[0].total >= HOURLY_LIMIT_TOTAL) {
    return { error: "Too many requests right now. Ask the customer to phone the manager instead." };
  }

  const inserted = await db`
    INSERT INTO orders (customer_name, customer_phone, delivery_address, items, total_price, status, notes)
    VALUES (${name}, ${phone}, ${address}, ${itemsJson}::jsonb, ${quote.total_estimate}, 'pending', ${notes})
    RETURNING id`;
  const requestId = inserted[0].id;

  // CRM: remember the customer so next time we don't have to ask again
  try {
    if (ctx.telegramId) {
      await db`INSERT INTO customers (telegram_id, name, phone, address) VALUES (${ctx.telegramId}, ${name}, ${phone}, ${region})
               ON CONFLICT (telegram_id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, address = EXCLUDED.address`;
    } else if (ctx.webSessionId) {
      await db`INSERT INTO customers (web_session_id, name, phone, address) VALUES (${ctx.webSessionId}, ${name}, ${phone}, ${region})
               ON CONFLICT (web_session_id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, address = EXCLUDED.address`;
    }
  } catch (crmErr) {
    console.error("CRM sync failed after request:", crmErr);
  }

  await notifyNewRequest({
    requestId,
    customerName: name,
    customerPhone: phone,
    region: address,
    company: input.company?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    lines: quote.lines,
    total: quote.total_estimate,
    pricedAll: quote.priced_all,
    source: ctx.telegramId ? 'Telegram bot' : ctx.webSessionId ? 'Veb-sayt' : "Noma'lum",
  });

  return { success: true, request_id: requestId, total_estimate: quote.total_estimate, priced_all: quote.priced_all, ...hoursInfo() };
}

function hoursInfo() {
  const now = tashkentNow();
  return {
    working_hours_now: now.open,
    manager_reply: now.open
      ? "A manager usually contacts the customer within 10–15 minutes"
      : "It is outside working hours (Mon–Sat 09:00–20:00): a manager will contact the customer on the next working day",
  };
}

// ---------- paketshop.uz sync ----------

export type SiteData = { products: SiteProduct[]; sections: SiteSection[]; errors: string[] };

export type SyncPlan = {
  site: SiteData;
  kbEntries: { question: string; answer: string }[];
  newProducts: string[];
  changed: { sku: string; name: string; changes: string[] }[];   // price / stock note / name changes worth telling the manager
  contentChanged: number;   // other fields changed (description, photo, pack sizes, ...)
  unchanged: number;
  deactivate: { id: number; name: string }[];
  firstSync: boolean;
  existingSiteProducts: number;   // active products already imported from the site
  oldKbEntries: number;
  kbChanged: boolean;       // the imported knowledge entries differ from what is stored
  needsWrite: boolean;      // anything at all to write (products or knowledge)
  problems: string[];       // reasons why applying would be refused
};

// Everything the sync stores for a product; a different fingerprint means the site changed something
export function fingerprint(p: SiteProduct): string {
  const fields = [p.name, p.description, p.price, p.image_url, p.category, p.url, p.name_ru, p.description_ru, p.category_ru,
    p.price_on_request, p.pack_unit, p.pack_qty, p.pack_qty_unit, p.packs_per_box, p.box_qty, p.unit_price, p.min_order,
    p.price_tiers, p.stock_note];
  return createHash('sha1').update(JSON.stringify(fields)).digest('hex');
}

export async function readSite(): Promise<SiteData> {
  const [{ products, errors }, { sections, errors: e2 }] = await Promise.all([fetchProducts(), fetchInfoSections()]);
  return { products, sections, errors: [...errors, ...e2] };
}

// "Katalog" overview entries so questions like "nima sotasiz?" hit the knowledge base
function catalogOverview(products: SiteProduct[]): { question: string; answer: string }[] {
  const build = (lang: 'uz' | 'ru') => {
    const by = new Map<string, string[]>();
    for (const p of products) {
      const cat = (lang === 'ru' ? p.category_ru : p.category) ?? '—';
      by.set(cat, [...(by.get(cat) ?? []), lang === 'ru' ? (p.name_ru ?? p.name) : p.name]);
    }
    const lines = [...by.entries()].map(([cat, names]) => `${cat} (${names.length}): ${names.slice(0, 4).map(n => n.split(/[,(—–]/)[0].trim()).join('; ')}${names.length > 4 ? '…' : ''}`);
    return lang === 'ru'
      ? { question: 'Каталог PaketShop.uz: какие товары вы продаёте? Категории', answer: `Оптовый каталог PaketShop.uz (цены указаны за упаковку/коробку):\n${lines.join('\n')}`.slice(0, 1500) }
      : { question: "PaketShop.uz katalogi: qanday mahsulotlar sotasiz? Kategoriyalar", answer: `PaketShop.uz ulgurji katalogi (narxlar qadoq/korobka uchun):\n${lines.join('\n')}`.slice(0, 1500) };
  };
  return [build('uz'), build('ru')];
}

export async function planCatalogSync(db: Sql, site?: SiteData): Promise<SyncPlan> {
  const data = site ?? await readSite();
  const existing = await db`SELECT id, sku, name, price, stock_note, active, source, sync_hash FROM products`;
  const bySku = new Map<string, Row>(existing.filter(r => r.sku).map(r => [r.sku as string, r]));
  const siteSkus = new Set(data.products.map(p => p.sku!));

  const newProducts: string[] = [];
  const changed: SyncPlan['changed'] = [];
  let contentChanged = 0;
  let unchanged = 0;
  let productsNeedWrite = false;
  for (const p of data.products) {
    const old = bySku.get(p.sku!);
    if (!old) { newProducts.push(`${p.sku} — ${p.name}`); productsNeedWrite = true; continue; }
    const changes: string[] = [];
    const oldPrice = old.price === null ? null : Number(old.price);
    if ((p.price ?? 0) !== (oldPrice ?? 0)) changes.push(`narx ${oldPrice ?? '—'} → ${p.price ?? 'narxsiz'}`);
    if ((p.stock_note ?? null) !== (old.stock_note ?? null)) changes.push(`holat "${old.stock_note ?? '—'}" → "${p.stock_note ?? '—'}"`);
    if (p.name !== old.name) changes.push('nomi');
    if (!old.active) changes.push('qayta faollashadi');
    const hashDiffers = old.sync_hash !== fingerprint(p);
    if (hashDiffers) productsNeedWrite = true;
    if (changes.length) changed.push({ sku: p.sku!, name: p.name, changes });
    else if (hashDiffers && old.sync_hash) contentChanged++;   // a missing hash (rows synced before hashes existed) is not a change
    else unchanged++;
  }

  const firstSync = !existing.some(r => r.source === SOURCE);
  const deactivate = existing
    .filter(r => r.active !== false)
    .filter(r => (firstSync ? !(r.sku && siteSkus.has(r.sku)) : r.source === SOURCE && !(r.sku && siteSkus.has(r.sku))))
    .map(r => ({ id: r.id as number, name: r.name as string }));

  const kbEntries = [
    ...data.sections.map(s => ({ question: s.question, answer: s.answer })),
    ...catalogOverview(data.products),
  ];
  const oldKbRows = await db`SELECT question, answer FROM knowledge_base WHERE source = ${SOURCE}`;
  const kbKey = (e: { question: string; answer: string }) => `${e.question}\u0000${e.answer}`;
  const oldKbKeys = new Set(oldKbRows.map(r => kbKey(r as any)));
  const kbChanged = oldKbRows.length !== kbEntries.length || kbEntries.some(e => !oldKbKeys.has(kbKey(e)));
  const existingSiteProducts = existing.filter(r => r.source === SOURCE && r.active !== false).length;

  const problems: string[] = [];
  if (data.products.length < 10) problems.push(`Saytdan faqat ${data.products.length} ta mahsulot o'qildi (kamida 10 kerak)`);
  if (data.sections.length < 10) problems.push(`Saytdan faqat ${data.sections.length} ta ma'lumot bo'limi o'qildi (kamida 10 kerak)`);
  if (data.errors.length > 5) problems.push(`Saytni o'qishda ${data.errors.length} ta xato bo'ldi`);

  return {
    site: data, kbEntries, newProducts, changed, contentChanged, unchanged, deactivate, firstSync, existingSiteProducts,
    oldKbEntries: oldKbRows.length, kbChanged,
    needsWrite: productsNeedWrite || deactivate.length > 0 || kbChanged,
    problems,
  };
}

export type Embedder = (texts: string[]) => Promise<(number[] | null)[]>;

export async function applyCatalogSync(db: Sql, plan: SyncPlan, embed: Embedder) {
  if (plan.problems.length) throw new Error(`Sinxronlash to'xtatildi: ${plan.problems.join('; ')}`);

  // Embeddings first (network), so the database transaction below stays short. Skipped when the knowledge text is unchanged.
  const vectors = plan.kbChanged ? await embed(plan.kbEntries.map(e => `${e.question} ${e.answer}`.slice(0, 3000))) : [];
  const embedded = vectors.filter(Boolean).length;

  const statements: any[] = [];
  for (const p of plan.site.products) {
    statements.push(db`
      INSERT INTO products (sku, name, description, price, image_url, category, stock, url, name_ru, description_ru, category_ru,
        price_on_request, pack_unit, pack_qty, pack_qty_unit, packs_per_box, box_qty, unit_price, min_order, price_tiers, stock_note,
        source, active, synced_at, sync_hash)
      VALUES (${p.sku}, ${p.name}, ${p.description}, ${p.price ?? 0}, ${p.image_url}, ${p.category}, 999999, ${p.url}, ${p.name_ru}, ${p.description_ru}, ${p.category_ru},
        ${p.price_on_request}, ${p.pack_unit}, ${p.pack_qty}, ${p.pack_qty_unit}, ${p.packs_per_box}, ${p.box_qty}, ${p.unit_price}, ${p.min_order},
        ${JSON.stringify(p.price_tiers)}::jsonb, ${p.stock_note}, ${SOURCE}, TRUE, CURRENT_TIMESTAMP, ${fingerprint(p)})
      ON CONFLICT (sku) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, price = EXCLUDED.price, image_url = EXCLUDED.image_url,
        category = EXCLUDED.category, stock = EXCLUDED.stock, url = EXCLUDED.url, name_ru = EXCLUDED.name_ru,
        description_ru = EXCLUDED.description_ru, category_ru = EXCLUDED.category_ru, price_on_request = EXCLUDED.price_on_request,
        pack_unit = EXCLUDED.pack_unit, pack_qty = EXCLUDED.pack_qty, pack_qty_unit = EXCLUDED.pack_qty_unit,
        packs_per_box = EXCLUDED.packs_per_box, box_qty = EXCLUDED.box_qty, unit_price = EXCLUDED.unit_price,
        min_order = EXCLUDED.min_order, price_tiers = EXCLUDED.price_tiers, stock_note = EXCLUDED.stock_note,
        source = EXCLUDED.source, active = TRUE, synced_at = CURRENT_TIMESTAMP, sync_hash = EXCLUDED.sync_hash`);
  }
  if (plan.deactivate.length) {
    statements.push(db`UPDATE products SET active = FALSE WHERE id = ANY(${plan.deactivate.map(d => d.id)}::int[])`);
  }
  if (plan.kbChanged) {
    statements.push(db`DELETE FROM knowledge_base WHERE source = ${SOURCE}`);
    plan.kbEntries.forEach((e, i) => {
      const vec = vectors[i] ? `[${vectors[i]!.join(',')}]` : null;
      statements.push(db`INSERT INTO knowledge_base (question, answer, embedding, source) VALUES (${e.question}, ${e.answer}, ${vec}::vector, ${SOURCE})`);
    });
  }

  await db.transaction(statements);
  return {
    products: plan.site.products.length,
    added: plan.newProducts.length,
    changed: plan.changed.length,
    deactivated: plan.deactivate.length,
    knowledge: plan.kbChanged ? plan.kbEntries.length : plan.oldKbEntries,
    knowledgeUpdated: plan.kbChanged,
    embedded,
  };
}
