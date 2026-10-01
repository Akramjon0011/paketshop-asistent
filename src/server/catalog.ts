// Catalog access for the assistant (list / search / details / quotes / requests) and the paketshop.uz sync.
// Every function takes the database handle as a parameter so it can be tested without a live Neon connection.

import { createHash } from 'crypto';
import type { Sql } from './db.js';
import { fetchInfoSections, fetchProducts, type SiteProduct, type SiteSection } from './paketshop.js';
import { notifyNewRequest, type RequestNotice } from './notify.js';
import { bridgeEnabled, fetchSiteCatalog, submitSiteLead, type LeadInput, type SiteLead } from './siteBridge.js';
import { tashkentNow } from './shopInfo.js';

const SOURCE = 'paketshop.uz';
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

// ---------- shaping rows for the model ----------

type Row = Record<string, any>;

// The model gets neutral codes/English notes (not Uzbek sentences) so it phrases everything in the customer's own language
// instead of mixing languages; the system prompt explains each code.
const AVAILABILITY_CODES = new Set(['in_stock', 'low_stock', 'check_with_manager', 'on_order', 'out_of_stock', 'discontinued']);

// Rows read from the storefront API carry the code itself; rows read from HTML only have the site's wording
function availability(r: Row): string {
  if (AVAILABILITY_CODES.has(r.availability)) return r.availability;
  const note: string | null = r.stock_note;
  if (note && /mavjud/i.test(note)) return 'in_stock';
  if (note && /kam/i.test(note)) return 'low_stock';
  return 'check_with_manager';
}

// "3850000" -> "3 850 000": ready-to-copy text, so the model doesn't have to regroup digits (where it once slipped)
const grouped = (n: number | null) => (n === null || !Number.isFinite(n) ? undefined : n.toLocaleString('en-US').replace(/,/g, ' '));

// "Shaffof · 80 ml · 40 mkm": what tells one variant of a product from another
function variantOption(v: Row): string {
  return [v.color, v.size, v.volume_ml ? `${v.volume_ml} ml` : null, v.thickness_micron ? `${v.thickness_micron} mkm` : null]
    .filter(Boolean).join(' · ') || String(v.sku);
}

// Variants can differ in pieces per pack and price (sauce cups: 20 ml = 2 000 pcs, 80 ml = 600 pcs per pack)
function variantView(v: Row, priceOnRequest: boolean) {
  const price = priceOnRequest ? null : num(v.price);
  const pieces = num(v.pieces_per_pack);
  return {
    sku: v.sku,
    option: variantOption(v),
    pieces_per_pack: pieces ?? undefined,
    pieces_per_pack_text: grouped(pieces),
    price_per_pack: price ?? undefined,
    price_per_pack_text: grouped(price),
    availability: AVAILABILITY_CODES.has(v.availability) ? v.availability : 'check_with_manager',
  };
}

const variantsOf = (r: Row): Row[] => (Array.isArray(r.variants) ? r.variants : []);

function compact(r: Row) {
  const price = r.price_on_request ? null : num(r.price);
  const perPiece = r.price_on_request ? null : num(r.unit_price);
  const pieces = num(r.pack_qty);
  const variants = variantsOf(r);
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    name_ru: r.name_ru || undefined,
    category: r.category,
    price_per_pack: price,
    price_per_pack_text: grouped(price),
    price_on_request: r.price_on_request ? true : undefined,
    starting_price: !r.price_on_request && r.price_from ? true : undefined,   // the price is "from X": depends on the variant
    pack_unit: r.pack_unit || 'qadoq',
    pieces_per_pack: pieces,
    pieces_per_pack_text: grouped(pieces),
    approx_price_per_piece: perPiece,
    approx_price_per_piece_text: grouped(perPiece),
    availability: availability(r),
    variants: variants.length ? variants.slice(0, 8).map(v => variantView(v, !!r.price_on_request)) : undefined,
  };
}

function detailed(r: Row) {
  const tiers = Array.isArray(r.price_tiers) ? r.price_tiers : [];
  const variants = variantsOf(r);
  const dimensions = r.dimensions && typeof r.dimensions === 'object' && Object.keys(r.dimensions).length ? r.dimensions : undefined;
  return {
    ...compact(r),
    description: String(r.description || '').slice(0, 1200),
    description_ru: r.description_ru ? String(r.description_ru).slice(0, 600) : undefined,
    min_order_packs: num(r.min_order),
    order_step_packs: r.order_step && Number(r.order_step) > 1 ? Number(r.order_step) : undefined,
    packs_per_box: num(r.packs_per_box),
    pieces_per_box: num(r.box_qty),
    dimensions,
    variants: variants.length ? variants.map(v => variantView(v, !!r.price_on_request)) : undefined,
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

// Question words that say nothing about the product (they'd match descriptions by accident)
const STOPWORDS = new Set([
  'qancha', 'narxi', 'narx', 'narxini', 'turadi', 'bormi', 'bor', 'kerak', 'mavjud', 'nima', 'qanday', 'menga', 'sizda', 'sizlarda',
  'uchun', 'yoki', 'bilan', 'ham', 'hozir', 'qaysi', 'iltimos', 'olsam', 'ayting', 'aytib', 'berasizlarmi', 'berasizmi', 'salom',
  'сколько', 'стоит', 'цена', 'цену', 'есть', 'нужно', 'нужны', 'нужен', 'какие', 'можно', 'здравствуйте', 'пожалуйста', 'для',
  'price', 'how', 'much', 'have', 'you', 'the', 'for', 'what', 'need', 'please', 'hello', 'with',
]);

export function queryTokens(query: string): string[] {
  const q = query
    .toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/(?<=\d)\s*[х×*]\s*(?=\d)/g, 'x')   // 20х30, 20×30, 20*30 -> 20x30
    .replace(/(?<=\d)\s+x\s+(?=\d)/g, 'x');       // 20 x 30 -> 20x30
  const words = q.split(/[^\p{L}\p{N}'x.,]+/u).map(t => t.replace(/^[.,']+|[.,']+$/g, '')).filter(t => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(words.map(stem))].slice(0, 8);
}

export async function listProducts(db: Sql, category?: string) {
  const cat = category?.trim();
  const rows = cat
    ? await db`SELECT id, sku, name, name_ru, category, price, price_on_request, price_from, pack_unit, pack_qty, unit_price, stock_note, availability, variants
               FROM products WHERE active AND (category ILIKE ${'%' + escapeLike(cat) + '%'} OR category_ru ILIKE ${'%' + escapeLike(cat) + '%'})
               ORDER BY category, id`
    : await db`SELECT id, sku, name, name_ru, category, price, price_on_request, price_from, pack_unit, pack_qty, unit_price, stock_note, availability, variants
               FROM products WHERE active ORDER BY category, id`;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.category ?? '-', (counts.get(r.category ?? '-') ?? 0) + 1);
  return {
    success: true,
    categories: [...counts.entries()].map(([name, count]) => ({ name, count })),
    products: rows.map(compact),
  };
}

// minScore = how many of the query words a product must match (the auto-lookup before each answer asks for 2).
// nameOnly = ignore the long descriptions (they mention "delivery", "price"... and would match unrelated questions).
export async function searchProducts(db: Sql, query: string, opts: { minScore?: number; limit?: number; nameOnly?: boolean } = {}) {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return listProducts(db);
  const minScore = Math.max(1, opts.minScore ?? 1);
  const limit = Math.min(20, Math.max(1, opts.limit ?? 8));
  const nameOnly = !!opts.nameOnly;
  const patterns = tokens.map(t => `%${escapeLike(t)}%`);
  const rows = await db`
    SELECT * FROM (
      SELECT id, sku, name, name_ru, category, price, price_on_request, price_from, pack_unit, pack_qty, unit_price, stock_note, availability, variants,
        (SELECT COUNT(*) FROM unnest(${patterns}::text[]) AS p
          WHERE (coalesce(sku, '') || ' ' || name || ' ' || coalesce(name_ru, '') || ' ' || coalesce(category, '') || ' ' || coalesce(category_ru, '')
                 || ' ' || (CASE WHEN ${nameOnly}::boolean THEN '' ELSE coalesce(description, '') || ' ' || coalesce(description_ru, '') END)) ILIKE p) AS score
      FROM products WHERE active
    ) t WHERE score >= ${minScore} ORDER BY score DESC, id LIMIT ${limit}`;
  if (rows.length === 0) return { success: true, products: [], message: "No product in the catalog matched this query" };
  return { success: true, products: rows.map(compact) };
}

export async function getProduct(db: Sql, id: number) {
  const r = await db`SELECT id, sku, name, name_ru, description, description_ru, category, category_ru, price, price_on_request, price_from,
      pack_unit, pack_qty, pack_qty_unit, packs_per_box, box_qty, unit_price, min_order, order_step, price_tiers, stock_note, availability,
      variants, dimensions, url, image_url
    FROM products WHERE id = ${id} AND active`;
  if (r.length === 0) return { error: "Product not found" };
  return { success: true, product: detailed(r[0]) };
}

// ---------- quotes ----------

export type QuoteInput = { product_id: number; packs: number; variant_sku?: string };

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
    const rows = await db`SELECT id, sku, name, price, price_on_request, price_from, pack_unit, pack_qty, pack_qty_unit, min_order, order_step,
                            price_tiers, stock_note, availability, variants
                          FROM products WHERE id = ${id} AND active`;
    const p = rows[0];
    if (!p) return { error: `Product not found (id ${id})` };

    // A chosen variant brings its own pieces per pack (and price, when it has one)
    const variants = variantsOf(p);
    const wanted = typeof item?.variant_sku === 'string' ? item.variant_sku.trim().toLowerCase() : '';
    const variant = wanted ? variants.find(v => String(v.sku).toLowerCase() === wanted) : undefined;
    if (wanted && !variant) return { error: `Variant ${item.variant_sku} not found for product ${id}: use a sku from the product's variants list` };
    const name = variant ? `${p.name} — ${variantOption(variant)}` : p.name;
    const sku = variant?.sku ?? p.sku;
    const packQty = num(variant?.pieces_per_pack) ?? num(p.pack_qty);
    const variantsDiffer = !variant && new Set(variants.map(v => `${v.pieces_per_pack}|${v.price}`)).size > 1;
    const variantNote = variantsDiffer ? "This product has variants with different pack sizes or prices: ask which one and pass its variant_sku" : undefined;

    const unit = p.pack_unit || 'qadoq';
    const pieces = packQty ? packQty * packs : null;
    const ownPrice = num(variant?.price) ?? num(p.price);
    if (p.price_on_request || !(Number(ownPrice) > 0)) {
      unpriced.push(name);
      lines.push({ product_id: p.id, sku, name, packs, unit, pieces, pieces_text: grouped(pieces), price_per_pack: null, line_total: null,
        note: ["Price on request: the manager sets it", variantNote].filter(Boolean).join('; ') });
      continue;
    }

    let price = Number(ownPrice);
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
    const step = Number(p.order_step);
    if (step > 1 && (packs - (Number(p.min_order) || 1)) % step !== 0) lineNotes.push(`This product is ordered in steps of ${step} ${unit} (from ${Number(p.min_order) || 1}): the manager adjusts the quantity`);
    const stock = variant ? variantView(variant, false).availability : availability(p);
    if (stock === 'out_of_stock') lineNotes.push("Currently out of stock: the manager will say when it is available again");
    else if (stock === 'discontinued') lineNotes.push("This product is no longer sold: suggest an alternative");
    else if (stock === 'on_order') lineNotes.push("Made to order: the manager confirms the lead time");
    if (p.price_from && !num(variant?.price)) lineNotes.push("This is a starting price (from): the manager confirms the exact price for the chosen variant");
    if (variantNote) lineNotes.push(variantNote);

    const lineTotal = price * packs;
    const perPiece = packQty && packQty > 1 ? Math.round(price / packQty) : null;   // so "1 dona taxminan ..." can be quoted too
    total += lineTotal;
    lines.push({
      product_id: p.id, sku, name, packs, unit, pieces, price_per_pack: price, line_total: lineTotal,
      approx_price_per_piece: perPiece ?? undefined, approx_price_per_piece_text: grouped(perPiece),
      pieces_text: grouped(pieces), price_per_pack_text: grouped(price), line_total_text: grouped(lineTotal),
      note: lineNotes.join('; ') || undefined,
    });
  }

  if (unpriced.length) notes.push(`Price on request, NOT included in the total: ${unpriced.join(', ')}`);
  notes.push("This is an estimate: the manager confirms stock and the final price.");
  return { success: true, lines, total_estimate: total, total_estimate_text: grouped(total), currency: "so'm", priced_all: unpriced.length === 0, notes };
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

export type RequestContext = { telegramId?: number; webSessionId?: string; language?: 'uz' | 'ru' | 'en' };

// Injectable so tests don't call the storefront or Telegram
export type RequestDeps = {
  submitLead?: (lead: LeadInput) => Promise<SiteLead | null>;
  notify?: (notice: RequestNotice) => Promise<void>;
};

const HOURLY_LIMIT_PER_PHONE = 3;
const HOURLY_LIMIT_TOTAL = 40;

// Chat widget on paketshop.uz sends its conversations with a "site_" session id
const fromSiteWidget = (ctx: RequestContext) => !!ctx.webSessionId?.startsWith('site_');

export async function createRequest(db: Sql, input: RequestInput, ctx: RequestContext = {}, deps: RequestDeps = {}) {
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

  // Hand the request to the storefront CRM (a lead there). When that fails, or the site did not alert its managers,
  // the managers are alerted from here, so a request is never silent.
  let lead: SiteLead | null = null;
  try {
    lead = await (deps.submitLead ?? submitSiteLead)({
      name,
      phone,
      city: region,
      company: input.company?.trim(),
      note: [
        `So'rov #${requestId} (AI yordamchi).`,
        `Taxminiy jami: ${grouped(quote.total_estimate)} so'm${quote.priced_all ? '' : " (narxsiz mahsulotlarsiz)"}.`,
        input.delivery_method?.trim() && `Yetkazish: ${input.delivery_method.trim()}.`,
        input.notes?.trim() && `Izoh: ${input.notes.trim()}`,
      ].filter(Boolean).join(' '),
      products: quote.lines.map((l: any) => `${l.name}${l.sku ? ` [${l.sku}]` : ''} — ${l.packs} ${l.unit}`).join('; '),
      source: ctx.telegramId ? 'AI yordamchi (Telegram)' : fromSiteWidget(ctx) ? 'AI yordamchi (Sayt)' : 'AI yordamchi (Veb)',
      locale: ctx.language === 'ru' ? 'ru' : 'uz',
    });
  } catch (leadErr) {
    console.error("Hand-over to the site failed:", leadErr);   // the request is saved: the managers are alerted below
  }
  if (lead) {
    try {
      await db`UPDATE orders SET site_lead_id = ${lead.id} WHERE id = ${requestId}`;
    } catch (linkErr) {
      console.error("Could not store the site lead id:", linkErr);
    }
  }

  if (!lead?.notified || process.env.ALWAYS_NOTIFY_ADMINS === 'true') {
    await (deps.notify ?? notifyNewRequest)({
      requestId,
      customerName: name,
      customerPhone: phone,
      region: address,
      company: input.company?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      lines: quote.lines,
      total: quote.total_estimate,
      pricedAll: quote.priced_all,
      source: `${ctx.telegramId ? 'Telegram bot' : fromSiteWidget(ctx) ? 'paketshop.uz sayti (chat)' : ctx.webSessionId ? 'Veb-sayt' : "Noma'lum"}${lead ? ` · sayt CRM #${lead.id}` : ''}`,
    });
  }

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

export type SiteData = {
  products: SiteProduct[];
  sections: SiteSection[];
  errors: string[];
  productSource?: 'api' | 'html';   // where the products were read from (storefront API or page HTML)
};

type KbEntry = { question: string; answer: string };

export type SyncPlan = {
  site: SiteData;
  kbEntries: KbEntry[];     // everything the site currently provides as knowledge
  kbInsert: KbEntry[];      // entries that are new, changed, or stored without a search embedding
  kbDelete: { id: number; question: string; embedded: boolean }[];   // stored entries that are gone, changed or unsearchable
  newProducts: string[];
  changed: { sku: string; name: string; changes: string[] }[];   // price / stock note / name changes worth telling the manager
  contentChanged: number;   // other fields changed (description, photo, pack sizes, ...)
  unchanged: number;
  deactivate: { id: number; name: string }[];
  firstSync: boolean;
  existingSiteProducts: number;   // active products already imported from the site
  kbChanged: boolean;       // something to insert or delete in the imported knowledge
  kbMissingEmbeddings: number;   // stored entries that search cannot find yet (the embedding service failed during an earlier sync)
  needsWrite: boolean;      // anything at all to write (products or knowledge)
  problems: string[];       // reasons why applying would be refused
};

// Everything the sync stores for a product; a different fingerprint means the site changed something
export function fingerprint(p: SiteProduct): string {
  const fields: unknown[] = [p.name, p.description, p.price, p.image_url, p.category, p.url, p.name_ru, p.description_ru, p.category_ru,
    p.price_on_request, p.pack_unit, p.pack_qty, p.pack_qty_unit, p.packs_per_box, p.box_qty, p.unit_price, p.min_order,
    p.price_tiers, p.stock_note];
  // Fields only the storefront API provides join the hash only when present, so products read from HTML keep their old hash
  if (p.availability !== undefined || p.price_from || p.order_step || p.variants?.length || p.dimensions) {
    fields.push(p.availability ?? null, p.price_from ?? false, p.order_step ?? null, p.variants ?? [], p.dimensions ?? null);
  }
  return createHash('sha1').update(JSON.stringify(fields)).digest('hex');
}

// Products come from the storefront API when the bridge is configured (exact data: stock status, variants, steps);
// otherwise, or when the API fails, from the public pages. Information pages (delivery, payment, FAQ) are always read from HTML.
async function readProducts(): Promise<{ products: SiteProduct[]; errors: string[]; source: 'api' | 'html' }> {
  const notes: string[] = [];
  if (bridgeEnabled()) {
    try {
      return { ...(await fetchSiteCatalog()), source: 'api' };
    } catch (err) {
      notes.push(`Sayt API'si ishlamadi, mahsulotlar HTML orqali o'qildi: ${String((err as any)?.message || err).slice(0, 150)}`);
    }
  }
  const html = await fetchProducts();
  return { products: html.products, errors: [...notes, ...html.errors], source: 'html' };
}

export async function readSite(): Promise<SiteData> {
  const [{ products, errors, source }, { sections, errors: e2 }] = await Promise.all([readProducts(), fetchInfoSections()]);
  return { products, sections, errors: [...errors, ...e2], productSource: source };
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

  const kbEntries: KbEntry[] = [
    ...data.sections.map(s => ({ question: s.question, answer: s.answer })),
    ...catalogOverview(data.products),
  ];
  // Knowledge is synced as a diff: stored entries with the same text that search can already find stay untouched (and are not
  // embedded again); only new or changed entries are embedded. Entries stored without an embedding are invisible to search,
  // so they are replaced too: a sync after an embedding failure repairs them.
  const oldKbRows = await db`SELECT id, question, answer, (embedding IS NOT NULL) AS embedded FROM knowledge_base WHERE source = ${SOURCE}`;
  const kbKey = (e: KbEntry) => `${e.question}\u0000${e.answer}`;
  const wanted = new Set(kbEntries.map(kbKey));
  const kept = new Set<string>();
  const kbDelete: SyncPlan['kbDelete'] = [];
  for (const r of oldKbRows) {
    const key = kbKey(r as any);
    if (wanted.has(key) && r.embedded && !kept.has(key)) kept.add(key);
    else kbDelete.push({ id: r.id as number, question: r.question as string, embedded: !!r.embedded });
  }
  const kbInsert = kbEntries.filter(e => !kept.has(kbKey(e)));
  const kbMissingEmbeddings = oldKbRows.filter(r => !r.embedded).length;
  const kbChanged = kbInsert.length > 0 || kbDelete.length > 0;
  const existingSiteProducts = existing.filter(r => r.source === SOURCE && r.active !== false).length;

  const problems: string[] = [];
  if (data.products.length < 10) problems.push(`Saytdan faqat ${data.products.length} ta mahsulot o'qildi (kamida 10 kerak)`);
  if (data.sections.length < 10) problems.push(`Saytdan faqat ${data.sections.length} ta ma'lumot bo'limi o'qildi (kamida 10 kerak)`);
  if (data.errors.length > 5) problems.push(`Saytni o'qishda ${data.errors.length} ta xato bo'ldi`);

  return {
    site: data, kbEntries, kbInsert, kbDelete, newProducts, changed, contentChanged, unchanged, deactivate, firstSync, existingSiteProducts,
    kbChanged, kbMissingEmbeddings,
    needsWrite: productsNeedWrite || deactivate.length > 0 || kbChanged,
    problems,
  };
}

export type Embedder = (texts: string[]) => Promise<(number[] | null)[]>;

export async function applyCatalogSync(db: Sql, plan: SyncPlan, embed: Embedder) {
  if (plan.problems.length) throw new Error(`Sinxronlash to'xtatildi: ${plan.problems.join('; ')}`);

  // Embeddings first (network), so the database transaction below stays short. Only new or changed knowledge is embedded.
  let vectors: (number[] | null)[] = [];
  if (plan.kbInsert.length) {
    try {
      vectors = await embed(plan.kbInsert.map(e => `${e.question} ${e.answer}`.slice(0, 3000)));
    } catch (embedErr) {
      console.warn("Embedding failed, knowledge stays as it is:", embedErr);   // products are still synced
    }
  }
  // An entry that could not be embedded is not stored (search could not find it), and the older version of that entry,
  // which search can find, is kept: a failing embedding service never makes the knowledge base worse.
  const failedQuestions = new Set<string>();
  const kbRows: { entry: KbEntry; vector: string }[] = [];
  plan.kbInsert.forEach((entry, i) => {
    const v = vectors[i];
    if (v && v.length) kbRows.push({ entry, vector: `[${v.join(',')}]` });
    else failedQuestions.add(entry.question);
  });
  const kbDeleteIds = plan.kbDelete.filter(r => !(r.embedded && failedQuestions.has(r.question))).map(r => r.id);

  const statements: any[] = [];
  for (const p of plan.site.products) {
    statements.push(db`
      INSERT INTO products (sku, name, description, price, image_url, category, stock, url, name_ru, description_ru, category_ru,
        price_on_request, pack_unit, pack_qty, pack_qty_unit, packs_per_box, box_qty, unit_price, min_order, price_tiers, stock_note,
        availability, price_from, order_step, variants, dimensions, source, active, synced_at, sync_hash)
      VALUES (${p.sku}, ${p.name}, ${p.description}, ${p.price ?? 0}, ${p.image_url}, ${p.category}, 999999, ${p.url}, ${p.name_ru}, ${p.description_ru}, ${p.category_ru},
        ${p.price_on_request}, ${p.pack_unit}, ${p.pack_qty}, ${p.pack_qty_unit}, ${p.packs_per_box}, ${p.box_qty}, ${p.unit_price}, ${p.min_order},
        ${JSON.stringify(p.price_tiers)}::jsonb, ${p.stock_note},
        ${p.availability ?? null}, ${p.price_from ?? false}, ${p.order_step ?? null},
        ${p.variants ? JSON.stringify(p.variants) : null}::jsonb, ${p.dimensions ? JSON.stringify(p.dimensions) : null}::jsonb,
        ${SOURCE}, TRUE, CURRENT_TIMESTAMP, ${fingerprint(p)})
      ON CONFLICT (sku) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, price = EXCLUDED.price, image_url = EXCLUDED.image_url,
        category = EXCLUDED.category, stock = EXCLUDED.stock, url = EXCLUDED.url, name_ru = EXCLUDED.name_ru,
        description_ru = EXCLUDED.description_ru, category_ru = EXCLUDED.category_ru, price_on_request = EXCLUDED.price_on_request,
        pack_unit = EXCLUDED.pack_unit, pack_qty = EXCLUDED.pack_qty, pack_qty_unit = EXCLUDED.pack_qty_unit,
        packs_per_box = EXCLUDED.packs_per_box, box_qty = EXCLUDED.box_qty, unit_price = EXCLUDED.unit_price,
        min_order = EXCLUDED.min_order, price_tiers = EXCLUDED.price_tiers, stock_note = EXCLUDED.stock_note,
        availability = EXCLUDED.availability, price_from = EXCLUDED.price_from, order_step = EXCLUDED.order_step,
        variants = EXCLUDED.variants, dimensions = EXCLUDED.dimensions,
        source = EXCLUDED.source, active = TRUE, synced_at = CURRENT_TIMESTAMP, sync_hash = EXCLUDED.sync_hash`);
  }
  if (plan.deactivate.length) {
    statements.push(db`UPDATE products SET active = FALSE WHERE id = ANY(${plan.deactivate.map(d => d.id)}::int[])`);
  }
  if (kbDeleteIds.length) {
    statements.push(db`DELETE FROM knowledge_base WHERE id = ANY(${kbDeleteIds}::int[]) AND source = ${SOURCE}`);
  }
  for (const { entry, vector } of kbRows) {
    statements.push(db`INSERT INTO knowledge_base (question, answer, embedding, source) VALUES (${entry.question}, ${entry.answer}, ${vector}::vector, ${SOURCE})`);
  }

  await db.transaction(statements);

  // Report what is stored now, not what this run embedded: unchanged knowledge is not embedded again but stays searchable
  let knowledge = plan.kbEntries.length;
  let searchable = plan.kbEntries.length - failedQuestions.size;
  try {
    const stored = await db`SELECT COUNT(*)::int AS total, COUNT(embedding)::int AS embedded FROM knowledge_base WHERE source = ${SOURCE}`;
    knowledge = Number(stored[0].total);
    searchable = Number(stored[0].embedded);
  } catch (countErr) {
    console.warn("Could not count knowledge entries after the sync:", countErr);
  }
  return {
    products: plan.site.products.length,
    added: plan.newProducts.length,
    changed: plan.changed.length,
    deactivated: plan.deactivate.length,
    knowledge,
    knowledgeUpdated: kbRows.length > 0 || kbDeleteIds.length > 0,
    knowledgePending: failedQuestions.size,   // new or changed entries that could not be embedded (retried by the next sync)
    embedded: searchable,
  };
}
