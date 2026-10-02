// Bridge to the paketshop.uz storefront:
//  - reads the live catalogue from the site's API (no more page scraping for products),
//  - hands customers' requests over to the site's CRM as a lead,
//  - recognises the site's own server-to-server calls (shared secret) so rate limits count real visitors.
// Everything is inactive until ASSISTANT_API_KEY is set (the same secret the site holds), and every failure falls back
// to the previous behaviour (HTML reader, own Telegram alert).

import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import type { PriceTier, ProductVariant, SiteProduct } from './paketshop.js';

const MIN_KEY_LENGTH = 24;
const PAGE_SIZE = 100;
const MAX_PAGES = 30;

type Fetch = typeof fetch;

export function siteApiKey(): string | null {
  const key = process.env.ASSISTANT_API_KEY?.trim();
  return key && key.length >= MIN_KEY_LENGTH ? key : null;
}

// www: the apex domain redirects (308) and fetch would drop the Authorization header on a cross-origin redirect
export function siteBaseUrl(): string {
  return (process.env.SITE_URL?.trim() || 'https://www.paketshop.uz').replace(/\/+$/, '');
}

export const bridgeEnabled = () => siteApiKey() !== null;

// ---------- calls coming from the site ----------

const digest = (value: string) => createHash('sha256').update(value).digest();

export function hasSiteKey(authorization: string | undefined): boolean {
  const key = siteApiKey();
  if (!key) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(key));   // equal-length digests: nothing leaks about the key
}

// Rate limit per customer. Requests forwarded by the storefront come from one server address, so they carry the
// visitor's address in X-Client-IP; it is trusted only together with the shared key.
export function rateLimitKey(req: Request): string {
  if (hasSiteKey(req.headers.authorization)) {
    const forwarded = String(req.headers['x-client-ip'] ?? '').trim();
    if (forwarded.length > 0 && forwarded.length <= 64 && /^[0-9a-f:.]+$/i.test(forwarded)) return `site:${ipKeyGenerator(forwarded)}`;
  }
  return ipKeyGenerator(req.ip ?? 'unknown');
}

// ---------- catalogue ----------

const SALE_UNIT_UZ: Record<string, string> = { PIECE: 'dona', PACK: 'qadoq', CARTON: 'korobka', ROLL: 'rulon', KILOGRAM: 'kg' };
const BASE_UNIT_UZ: Record<string, string> = { PIECE: 'dona', METER: 'metr', KILOGRAM: 'kg', ROLL: 'rulon', LITER: 'litr' };

// The site's availability enum -> neutral code for the model + the wording the site itself shows (kept in stock_note)
const AVAILABILITY: Record<string, { code: string; note: string }> = {
  IN_STOCK: { code: 'in_stock', note: 'Omborda mavjud' },
  LOW_STOCK: { code: 'low_stock', note: 'Kam qoldi' },
  CHECK_AVAILABILITY: { code: 'check_with_manager', note: 'Qoldiqni aniqlang' },
  ON_ORDER: { code: 'on_order', note: 'Buyurtma asosida' },
  OUT_OF_STOCK: { code: 'out_of_stock', note: "Vaqtincha yo'q" },
  DISCONTINUED: { code: 'discontinued', note: 'Sotuvdan chiqarilgan' },
};
const availabilityOf = (status: unknown) => AVAILABILITY[String(status)] ?? AVAILABILITY.CHECK_AVAILABILITY;

const DIMENSION_KEYS: Record<string, string> = {
  lengthCm: 'length_cm', widthCm: 'width_cm', heightCm: 'height_cm',
  volumeMl: 'volume_ml', diameterMm: 'diameter_mm', thicknessMicron: 'thickness_micron',
};

// Shape returned by GET /api/assistant/catalog (AssistantProduct in the site's lib/domain/assistantCatalog.ts)
export type ApiProduct = {
  sku: string;
  legacySku: string | null;
  url: { uz: string; ru: string };
  name: { uz: string; ru: string };
  shortDescription: { uz: string; ru: string };
  description: { uz: string; ru: string };
  category: { slug: string; name: { uz: string; ru: string } };
  priceMode: string;
  publicPrice: number | null;
  availabilityStatus: string;
  baseUnit: string;
  saleUnit: string;
  unitsPerPack: number;
  packsPerCarton: number;
  unitsPerCarton: number;
  minimumOrderQuantity: number;
  orderStep: number;
  dimensions?: Record<string, number>;
  images?: string[];
  variants?: Array<{
    sku: string; color: string | null; size: string | null; volumeMl: number | null; thicknessMicron: number | null;
    unitsPerPack: number | null; price: number | null; availabilityStatus: string;
  }>;
  priceTiers?: Array<{ minQuantity: number; maxQuantity: number | null; price: number; priceUnit: string }>;
};

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPair = (v: unknown) => isObject(v) && typeof v.uz === 'string' && typeof v.ru === 'string';
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function isApiProduct(v: unknown): v is ApiProduct {
  return isObject(v)
    && typeof v.sku === 'string' && v.sku.trim() !== ''
    && isPair(v.url) && isPair(v.name) && isPair(v.shortDescription) && isPair(v.description)
    && isObject(v.category) && isPair(v.category.name)
    && typeof v.priceMode === 'string' && typeof v.saleUnit === 'string' && typeof v.availabilityStatus === 'string'
    && positive(v.unitsPerPack) && positive(v.packsPerCarton) && positive(v.unitsPerCarton)
    && positive(v.minimumOrderQuantity) && positive(v.orderStep)
    && (v.publicPrice === null || typeof v.publicPrice === 'number');
}

// The site stores Uzbek apostrophes as ‘ ’ ʻ ʼ while customers type ': the same normalisation as the HTML reader, otherwise
// a search for "tog'ora" would not find "tog‘ora"
const normalizeLine = (s: string) => s.replace(/[‘’ʻʼ`´]/g, "'").replace(/[ \t]+/g, ' ').trim();
const normalizeText = (s: string | null | undefined) => (s ?? '').split('\n').map(normalizeLine).filter(Boolean).join('\n');

// Same meaning as the fields the HTML reader produced, so quotes, search and the sync keep working unchanged.
// For products with variants the product page shows the first available variant (status, pieces per pack, and its price
// when the product itself has none); the assistant tells the same story, and lists every variant in the details.
export function apiToSiteProduct(p: ApiProduct): SiteProduct {
  const allVariants = p.variants ?? [];
  const shown = allVariants.find(v => v.availabilityStatus === 'IN_STOCK' || v.availabilityStatus === 'LOW_STOCK') ?? allVariants[0];
  const basePrice = positive(p.publicPrice) ? p.publicPrice : null;
  const price = basePrice ?? (p.publicPrice === null && p.priceMode !== 'REQUEST_ONLY' && p.priceMode !== 'LOGIN_REQUIRED' && positive(shown?.price) ? shown!.price : null);
  const unitsPerPack = positive(shown?.unitsPerPack) ? shown!.unitsPerPack! : p.unitsPerPack;
  const unitsPerCarton = positive(shown?.unitsPerPack) ? shown!.unitsPerPack! * p.packsPerCarton : p.unitsPerCarton;
  const carton = p.saleUnit === 'CARTON';
  const packQty = carton ? unitsPerCarton : unitsPerPack;   // pieces in one priced unit
  const availability = availabilityOf(shown?.availabilityStatus ?? p.availabilityStatus);

  const tiers: PriceTier[] = price === null ? [] : (p.priceTiers ?? []).map(t => ({
    from: t.minQuantity,
    to: t.maxQuantity ?? null,
    unit: SALE_UNIT_UZ[t.priceUnit] ?? 'qadoq',
    price: t.price,
  }));

  const hidePrices = p.priceMode === 'REQUEST_ONLY' || p.priceMode === 'LOGIN_REQUIRED';
  const variants: ProductVariant[] = allVariants.slice(0, 30).map(v => ({
    sku: v.sku,
    color: v.color ? normalizeLine(v.color) : null,
    size: v.size ? normalizeLine(v.size) : null,
    volume_ml: v.volumeMl ?? null,
    thickness_micron: v.thicknessMicron ?? null,
    pieces_per_pack: v.unitsPerPack ?? null,
    price: hidePrices || !positive(v.price) ? null : v.price,
    availability: availabilityOf(v.availabilityStatus).code,
  }));

  const dimensions = Object.fromEntries(
    Object.entries(p.dimensions ?? {})
      .filter(([key, value]) => key in DIMENSION_KEYS && positive(value))
      .map(([key, value]) => [DIMENSION_KEYS[key], value]),
  );

  const name = normalizeLine(p.name.uz || p.name.ru || p.sku);
  return {
    url: p.url.uz,
    sku: p.sku,
    name,
    name_ru: normalizeLine(p.name.ru) || null,
    description: normalizeText(p.description.uz || p.shortDescription.uz) || name,
    description_ru: normalizeText(p.description.ru || p.shortDescription.ru) || null,
    category: normalizeLine(p.category.name.uz) || null,
    category_ru: normalizeLine(p.category.name.ru) || null,
    price,
    price_on_request: price === null,
    pack_unit: SALE_UNIT_UZ[p.saleUnit] ?? 'qadoq',
    pack_qty: packQty,
    pack_qty_unit: BASE_UNIT_UZ[p.baseUnit] ?? 'dona',
    packs_per_box: p.packsPerCarton > 1 ? p.packsPerCarton : null,
    box_qty: unitsPerCarton > 1 ? unitsPerCarton : null,
    unit_price: price !== null && packQty > 0 ? Math.round(price / packQty) : null,
    min_order: p.minimumOrderQuantity,
    price_tiers: tiers,
    stock_note: availability.note,
    image_url: p.images?.[0] ?? null,
    availability: availability.code,
    price_from: p.priceMode === 'FROM_PRICE',
    order_step: p.orderStep > 1 ? p.orderStep : null,
    variants,
    dimensions: Object.keys(dimensions).length ? dimensions : null,
  };
}

// Reads every active product from the storefront; throws when the API cannot be used (caller falls back to the HTML reader)
export async function fetchSiteCatalog(opts: { fetch?: Fetch } = {}): Promise<{ products: SiteProduct[]; errors: string[] }> {
  const key = siteApiKey();
  if (!key) throw new Error('ASSISTANT_API_KEY is not set');
  const doFetch = opts.fetch ?? fetch;
  const products: SiteProduct[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('/api/assistant/catalog', siteBaseUrl());
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (cursor) url.searchParams.set('cursor', cursor);

    let data: any;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await doFetch(url, {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'PaketshopAssistant/1.0' },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        break;
      } catch (err) {
        if (attempt >= 2) throw new Error(`site catalog API: ${String((err as any)?.message || err)}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!isObject(data) || !Array.isArray(data.products)) throw new Error('site catalog API: unexpected response');
    for (const raw of data.products) {
      if (!isApiProduct(raw)) { errors.push(`site catalog API: skipped an invalid product (${isObject(raw) ? String(raw.sku) : typeof raw})`); continue; }
      if (seen.has(raw.sku)) continue;
      seen.add(raw.sku);
      products.push(apiToSiteProduct(raw));
    }

    cursor = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
    if (!cursor) return { products, errors };
  }
  throw new Error('site catalog API: too many pages');
}

// ---------- diagnostics ----------

export type BridgeStatus = {
  configured: boolean;   // ASSISTANT_API_KEY is set here
  site: string;
  catalog?: { ok: boolean; status: number; hint?: string };
};

const STATUS_HINTS: Record<number, string> = {
  401: "Kalitlar mos emas: ikkala Vercel loyihasida ASSISTANT_API_KEY bir xil bo'lishi kerak (keyin ikkalasini redeploy qiling).",
  404: "Saytda katalog API'si yo'q: integratsiya PR'i hali merge yoki deploy qilinmagan.",
  503: "Saytda ASSISTANT_API_KEY o'rnatilmagan (yoki 24 belgidan qisqa), yoki o'rnatilgandan keyin sayt redeploy qilinmagan.",
};

let statusCache: { at: number; value: BridgeStatus } | null = null;

// Is the link to the storefront working? Reads one product with the shared key; only the outcome is reported, never data.
export async function checkSiteBridge(opts: { fetch?: Fetch; fresh?: boolean } = {}): Promise<BridgeStatus> {
  if (!opts.fresh && statusCache && Date.now() - statusCache.at < 30000) return statusCache.value;
  const key = siteApiKey();
  const site = siteBaseUrl();
  let value: BridgeStatus;
  if (!key) {
    value = { configured: false, site };
  } else {
    try {
      const url = new URL('/api/assistant/catalog', site);
      url.searchParams.set('limit', '1');
      const res = await (opts.fetch ?? fetch)(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'PaketshopAssistant/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      const data: any = await res.json().catch(() => null);
      const ok = res.ok && isObject(data) && Array.isArray(data.products);
      value = {
        configured: true,
        site,
        catalog: { ok, status: res.status, ...(ok ? {} : { hint: STATUS_HINTS[res.status] ?? `Sayt kutilmagan javob qaytardi (HTTP ${res.status}).` }) },
      };
    } catch (err) {
      value = { configured: true, site, catalog: { ok: false, status: 0, hint: `Saytga ulanib bo'lmadi: ${String((err as any)?.message || err).slice(0, 120)}` } };
    }
  }
  statusCache = { at: Date.now(), value };
  return value;
}

// One product as the storefront API returns it and as the assistant stores it (public fields only), to explain a
// difference between the site and the assistant's answers.
export async function inspectSiteProduct(sku: string, opts: { fetch?: Fetch } = {}): Promise<{ api: ApiProduct | null; mapped: SiteProduct | null; error?: string }> {
  const key = siteApiKey();
  if (!key) return { api: null, mapped: null, error: 'ASSISTANT_API_KEY is not set' };
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('/api/assistant/catalog', siteBaseUrl());
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await (opts.fetch ?? fetch)(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'PaketshopAssistant/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { api: null, mapped: null, error: `HTTP ${res.status}` };
      const data: any = await res.json();
      const raw = Array.isArray(data?.products) ? data.products.find((p: any) => p?.sku === sku) : undefined;
      if (raw) return { api: raw, mapped: isApiProduct(raw) ? apiToSiteProduct(raw) : null };
      cursor = typeof data?.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
      if (!cursor) break;
    }
    return { api: null, mapped: null, error: 'not found' };
  } catch (err) {
    return { api: null, mapped: null, error: String((err as any)?.message || err).slice(0, 150) };
  }
}

// ---------- requests -> site CRM ----------

// Same rule as the site's normalizeUzbekPhone: "+998" + 9 digits, anything else is not accepted by its lead API
export function normalizeUzbekPhone(value: unknown): string | null {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9) digits = `998${digits}`;
  return /^998\d{9}$/.test(digits) ? `+${digits}` : null;
}

export type LeadInput = {
  name: string;
  phone: string;
  city?: string;
  company?: string;
  note?: string;       // request number, estimate, delivery, comments
  products?: string;   // what the customer asked for
  source: string;      // "AI yordamchi (Telegram)" ...
  locale?: 'uz' | 'ru';
};

export type SiteLead = { id: string; notified: boolean };

const clip = (s: string | undefined, max: number) => (s ?? '').trim().slice(0, max);

// Returns null whenever the lead could not be stored on the site (not configured, phone not accepted, site down...):
// the caller then alerts the managers itself. Never throws, never retries (a retry could create a duplicate lead).
export async function submitSiteLead(input: LeadInput, opts: { fetch?: Fetch } = {}): Promise<SiteLead | null> {
  const key = siteApiKey();
  if (!key) return null;
  const phone = normalizeUzbekPhone(input.phone);
  const name = clip(input.name, 160);
  if (!phone || name.length < 2) return null;

  // The site validates this strictly (unknown fields are rejected), so only its documented fields are sent
  const body: Record<string, unknown> = {
    type: 'chat',
    name,
    phone,
    locale: input.locale ?? 'uz',
    attribution: { source: clip(input.source, 100), utm_source: 'ai_assistant', utm_medium: 'chat' },
  };
  const optional: Record<string, string> = {
    city: clip(input.city, 120),
    organizationName: clip(input.company, 200),
    note: clip(input.note, 1000),
    products: clip(input.products, 500),
  };
  for (const [field, value] of Object.entries(optional)) if (value) body[field] = value;

  try {
    const res = await (opts.fetch ?? fetch)(new URL('/api/leads', siteBaseUrl()), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'PaketshopAssistant/1.0' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data: any = await res.json().catch(() => null);
    if (res.status === 201 && isObject(data) && data.success === true && (typeof data.id === 'string' || typeof data.id === 'number')) {
      return { id: String(data.id), notified: data.notified === true };
    }
    console.warn(`Site lead rejected: HTTP ${res.status} ${isObject(data) ? String(data.error ?? '').slice(0, 120) : ''}`);
    return null;
  } catch (err) {
    console.warn('Site lead failed:', String((err as any)?.message || err));
    return null;
  }
}

// ---------- request status <- site CRM ----------

export type SiteLeadStatus = { status: string; lostReason: string | null; updatedAt: string | null };

const LEAD_ID = /^[a-z0-9]{8,40}$/i;
const LEAD_STATUSES = new Set(['NEW', 'CONTACTED', 'IN_PROGRESS', 'WON', 'LOST']);
const MAX_LEAD_IDS = 50;

// The status the managers set in the site CRM for requests the assistant handed over (GET /api/assistant/leads).
// Returns whatever could be read: an empty map when not configured, before the site has the endpoint (404) or when the
// site is down, so callers fall back to what they know themselves. Never throws.
export async function fetchLeadStatuses(ids: string[], opts: { fetch?: Fetch } = {}): Promise<Map<string, SiteLeadStatus>> {
  const result = new Map<string, SiteLeadStatus>();
  const key = siteApiKey();
  const wanted = [...new Set(ids.map(id => String(id ?? '').trim()).filter(id => LEAD_ID.test(id)))];
  if (!key || !wanted.length) return result;

  const batches: string[][] = [];
  for (let i = 0; i < wanted.length && batches.length < 4; i += MAX_LEAD_IDS) batches.push(wanted.slice(i, i + MAX_LEAD_IDS));
  await Promise.all(batches.map(async batch => {
    try {
      const url = new URL('/api/assistant/leads', siteBaseUrl());
      url.searchParams.set('ids', batch.join(','));
      const res = await (opts.fetch ?? fetch)(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'PaketshopAssistant/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        if (res.status !== 404) console.warn(`Site lead status: HTTP ${res.status}`);
        return;
      }
      const data: any = await res.json().catch(() => null);
      for (const lead of Array.isArray(data?.leads) ? data.leads : []) {
        if (!isObject(lead) || typeof lead.id !== 'string' || !batch.includes(lead.id) || !LEAD_STATUSES.has(lead.status)) continue;
        result.set(lead.id, {
          status: lead.status,
          lostReason: typeof lead.lostReason === 'string' && lead.lostReason.trim() ? lead.lostReason.trim().slice(0, 200) : null,
          updatedAt: typeof lead.updatedAt === 'string' ? lead.updatedAt : null,
        });
      }
    } catch (err) {
      console.warn('Site lead status failed:', String((err as any)?.message || err));
    }
  }));
  return result;
}

// Requests handed over to paketshop.uz are worked on in the site CRM: adds the status the managers set there
// (crm_status, crm_lost_reason, crm_updated_at) to the assistant's own request rows. Rows stay as they are when unknown.
export async function withCrmStatus<T extends { site_lead_id?: unknown }>(orders: T[], opts: { fetch?: Fetch } = {}): Promise<T[]> {
  const crm = await fetchLeadStatuses(orders.map(order => String(order.site_lead_id ?? '')).filter(Boolean), opts);
  return orders.map(order => {
    const lead = order.site_lead_id ? crm.get(String(order.site_lead_id)) : undefined;
    return lead ? { ...order, crm_status: lead.status, crm_lost_reason: lead.lostReason, crm_updated_at: lead.updatedAt } : order;
  });
}
