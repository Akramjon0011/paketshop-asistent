// Reads the public pages of https://www.paketshop.uz (the real store) so the assistant works from real
// products and real rules instead of hand-typed data. Read-only: nothing here writes to the database.

const SITE = 'https://www.paketshop.uz';

export type PriceTier = { from: number; to: number | null; unit: string; price: number };

export type SiteProduct = {
  url: string;
  sku: string | null;
  name: string;
  name_ru: string | null;
  description: string;
  description_ru: string | null;
  category: string | null;
  category_ru: string | null;
  price: number | null;          // price of one pack/box (UZS); null when the site says "Narxni aniqlang"
  price_on_request: boolean;
  pack_unit: string;             // what the price is for: "qadoq", "korobka", ...
  pack_qty: number | null;       // pieces in one priced unit
  pack_qty_unit: string | null;  // "dona", ...
  packs_per_box: number | null;  // some products: 1 korobka = N qadoq
  box_qty: number | null;        // pieces in one korobka
  unit_price: number | null;     // approximate price of one piece
  min_order: number | null;      // minimum number of packs
  price_tiers: PriceTier[];      // volume prices when the site lists them
  stock_note: string | null;     // site wording: "Omborda mavjud" / "Kam qoldi" / "Qoldiqni aniqlang"
  image_url: string | null;
};

export type SiteSection = { lang: 'uz' | 'ru'; page: string; url: string; question: string; answer: string };

// ---------- helpers ----------

// Apostrophe variants (‘ ’ ʻ ʼ ` ´) -> ASCII ', so text matches what customers type
const normalize = (s: string) => s.replace(/[‘’ʻʼ`´]/g, "'").replace(/[ \t]+/g, ' ').trim();
const plain = (l: string) => l.replace(/^####\s*/, '');

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function fetchText(url: string, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'PaketshopAssistant/1.0 (+https://paketshop-asistent.vercel.app)', 'Accept-Language': 'uz,ru;q=0.8' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${String((lastErr as any)?.message || lastErr)}`);
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// Page HTML -> clean lines. Headings are kept as "#### text" so pages can be cut into sections.
function pageLines(html: string): string[] {
  const body = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, __, inner) => `\n#### ${inner.replace(/<[^>]+>/g, ' ')}\n`);
  const text = decodeEntities(body.replace(/<[^>]+>/g, '\n'));
  return text.split('\n').map(l => normalize(l)).filter(Boolean);
}

// Drop the site header (up to the UZ/RU language switch) and the footer (bottom nav)
function mainLines(lines: string[]): string[] {
  const ruIdx = lines.findIndex(l => l === 'RU');
  const navIdx = lines.findIndex((l, i) => i > ruIdx && (l === 'Bosh sahifa' || l === 'Главная') && ['Qidiruv', 'Поиск'].includes(lines[i + 1]));
  return lines.slice(ruIdx + 1, navIdx > 0 ? navIdx : undefined);
}

function jsonLd(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1])); } catch { /* skip malformed block */ }
  }
  return out;
}

const num = (s: string | undefined | null) => (s ? Number(s.replace(/\s/g, '')) : NaN);

// ---------- sitemap ----------

export async function readSitemap(): Promise<{ urls: string[]; ruOf: Map<string, string> }> {
  const xml = await fetchText(`${SITE}/sitemap.xml`);
  const urls: string[] = [];
  const ruOf = new Map<string, string>();
  for (const block of xml.split('<url>').slice(1)) {
    const loc = block.match(/<loc>(.*?)<\/loc>/)?.[1];
    if (!loc) continue;
    urls.push(loc);
    const ru = block.match(/hreflang="ru"\s+href="([^"]+)"/)?.[1];
    if (ru) ruOf.set(loc, ru);
  }
  return { urls, ruOf };
}

// ---------- products ----------

const STOCK_WORDS = /(Omborda mavjud|Qoldiqni aniqlang|Kam qoldi)/i;

export function parseProductPage(html: string, url: string): Omit<SiteProduct, 'name_ru' | 'description_ru' | 'category_ru'> | null {
  const ld = jsonLd(html);
  const product = ld.find(b => b?.['@type'] === 'Product');
  if (!product) return null;
  const crumbs: string[] = (ld.find(b => b?.['@type'] === 'BreadcrumbList')?.itemListElement ?? []).map((i: any) => normalize(String(i.name)));
  const category = crumbs.length >= 3 ? crumbs[crumbs.length - 2] : null;

  const lines = mainLines(pageLines(html));
  const descStart = lines.findIndex(l => plain(l) === 'Tavsif');
  const descEnd = lines.findIndex((l, i) => i > descStart && /^O'xshash mahsulotlar$/i.test(plain(l)));
  // Everything above "Tavsif" is the buy box (status, price, pack sizes, tiers)
  const head = lines.slice(0, descStart >= 0 ? descStart : 60).map(plain).join(' ');

  const stockNote = head.match(STOCK_WORDS)?.[1] ?? null;
  const priceMatch = head.match(/(?:^|\s)1\s+([^\s:]+)\s*:\s*([\d ]+?)\s*so'm/i);
  const packUnit = priceMatch?.[1] ?? head.match(/Eng kam buyurtma\s+\d+\s+([^\s\d]+)/i)?.[1] ?? 'qadoq';
  const ldPrice = num(product.offers?.price);
  const price = Number.isFinite(ldPrice) && ldPrice > 0 ? ldPrice : (priceMatch ? num(priceMatch[2]) : NaN);

  const est = head.match(/Taxminiy 1 \S+ narxi\s*:\s*([\d ]+?)\s*so'm/i);
  const inPack = head.match(/Qadoqda\s+(\d[\d ]*?)\s+([^\s\d]+)/i);
  const inBoxPacks = head.match(/Korobkada\s+qadoq\s+(\d[\d ]*?)(?:\s|$)/i);
  const inBoxPieces = head.match(/Korobkada\s+(\d[\d ]*?)\s+([^\s\d]+)/i);
  const minOrder = head.match(/Eng kam buyurtma\s+(\d+)\s+/i);

  const packQty = inPack ? num(inPack[1]) : NaN;
  const boxQty = inBoxPieces ? num(inBoxPieces[1]) : NaN;
  // The price is for one korobka on some products (then "Qadoqda 1 dona" is meaningless for the maths)
  const pricedQty = packUnit.toLowerCase().startsWith('korob') ? boxQty : packQty;

  // Volume prices: "Ulgurji narx darajalari Miqdor Narx 5 –10 korobka 370 000 so'm"
  const tiers: PriceTier[] = [];
  const tierText = head.match(/Ulgurji narx darajalari([\s\S]*?)(?:Buyurtma miqdori|$)/i)?.[1] ?? '';
  for (const m of tierText.matchAll(/(\d+)\s*(?:[–-]\s*(\d+)|(\+))?\s*([^\s\d+–-]+)\s+([\d ]+?)\s*so'm/g)) {
    tiers.push({ from: Number(m[1]), to: m[2] ? Number(m[2]) : null, unit: m[4], price: num(m[5]) });
  }

  const description = descStart >= 0
    ? lines.slice(descStart + 1, descEnd > 0 ? descEnd : undefined).filter(l => !l.startsWith('####')).join('\n')
    : '';

  return {
    url: normalize(String(product.offers?.url || url)),
    sku: product.sku ? String(product.sku) : null,
    name: normalize(String(product.name)),
    description: description || normalize(String(product.description ?? '')),
    category,
    price: Number.isFinite(price) ? price : null,
    price_on_request: !Number.isFinite(price),
    pack_unit: packUnit,
    pack_qty: Number.isFinite(pricedQty) ? pricedQty : null,
    pack_qty_unit: (packUnit.toLowerCase().startsWith('korob') ? inBoxPieces?.[2] : inPack?.[2]) ?? null,
    packs_per_box: inBoxPacks ? num(inBoxPacks[1]) : null,
    box_qty: Number.isFinite(boxQty) ? boxQty : null,
    unit_price: est ? num(est[1]) : (Number.isFinite(price) && Number.isFinite(pricedQty) && pricedQty > 0 ? Math.round(price / pricedQty) : null),
    min_order: minOrder ? Number(minOrder[1]) : null,
    price_tiers: tiers,
    stock_note: stockNote,
    image_url: Array.isArray(product.image) ? product.image[0] ?? null : (product.image ?? null),
  };
}

// The Russian page only supplies the translated name / description / category
export function parseProductPageRu(html: string) {
  const ld = jsonLd(html);
  const product = ld.find(b => b?.['@type'] === 'Product');
  if (!product) return null;
  const crumbs: string[] = (ld.find(b => b?.['@type'] === 'BreadcrumbList')?.itemListElement ?? []).map((i: any) => normalize(String(i.name)));
  const lines = mainLines(pageLines(html));
  const descStart = lines.findIndex(l => plain(l) === 'Описание');
  const descEnd = lines.findIndex((l, i) => i > descStart && /^Похожие товары$/i.test(plain(l)));
  const description = descStart >= 0 ? lines.slice(descStart + 1, descEnd > 0 ? descEnd : undefined).filter(l => !l.startsWith('####')).join('\n') : '';
  return {
    name: normalize(String(product.name)),
    description: description || normalize(String(product.description ?? '')),
    category: crumbs.length >= 3 ? crumbs[crumbs.length - 2] : null,
  };
}

export async function fetchProducts(): Promise<{ products: SiteProduct[]; errors: string[] }> {
  const { urls, ruOf } = await readSitemap();
  const productUrls = urls.filter(u => /\/uz\/product\//.test(u));
  const errors: string[] = [];

  const products = (await pool(productUrls, 6, async (url): Promise<SiteProduct | null> => {
    try {
      const uz = parseProductPage(await fetchText(url), url);
      if (!uz || !uz.sku) {
        errors.push(`${url}: product data not found`);
        return null;
      }
      let ru: ReturnType<typeof parseProductPageRu> = null;
      const ruUrl = ruOf.get(url);
      if (ruUrl) {
        try { ru = parseProductPageRu(await fetchText(ruUrl)); } catch (e) { errors.push(`ru ${ruUrl}: ${String((e as any)?.message || e)}`); }
      }
      return { ...uz, name_ru: ru?.name ?? null, description_ru: ru?.description ?? null, category_ru: ru?.category ?? null };
    } catch (e) {
      errors.push(String((e as any)?.message || e));
      return null;
    }
  })).filter((p): p is SiteProduct => !!p);

  return { products, errors };
}

// ---------- information pages -> knowledge base entries ----------

const INFO_PAGES = ['faq', 'payment', 'delivery', 'wholesale', 'organizations', 'starter-kits', 'about', 'contact'];
const MAX_ENTRY = 1500;

// Buttons, form labels and step numbers that carry no information for a customer (uz + ru)
const JUNK_LINE = new RegExp([
  '^\d{2}$', '^←$',
  "^(Telegramda hisoblatish|So'rov yuborish|So'rovni yuborish|Katalogga o'tish|Katalogni ko'rish|Buyurtmani kuzatish|Tashkilotlar bo'limi|Biz bilan bog'lanish|Aloqa sahifasi|Bank orqali to'lov kerak|Shartnoma kerak)$",
  'roziman|соглас',
  '^(Рассчитать в Telegram|Отправить заявку|Отправить запрос|Перейти в каталог|Открыть каталог|Отследить заказ|Организациям|Связаться с нами|Нужна оплата через банк|Нужен договор)$',
].join('|'), 'i');

// On the payment/delivery pages a short label sits right above each heading ("Bepul", "Mijoz hisobidan"): fold it into the heading
function attachLabels(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('####') && l.length <= 32 && !/[.!?:]$/.test(l) && lines[i + 1]?.startsWith('####')) {
      out.push(`${lines[i + 1]} [${l}]`);
      i++;
    } else out.push(l);
  }
  return out;
}

// One knowledge-base entry per page (split at line boundaries when long), so steps and lists stay together
function pageEntries(lines: string[], page: string, url: string, lang: 'uz' | 'ru'): SiteSection[] {
  const cleaned = lines.filter(l => l.startsWith('####') || !JUNK_LINE.test(l));
  const withLabels = page === 'payment' || page === 'delivery' ? attachLabels(cleaned) : cleaned;
  const title = plain(withLabels.find(l => l.startsWith('####')) ?? page);
  // Headings become "<text>:" lines; a heading must never be left dangling at the end of a chunk
  const HEADING = '\u0001';
  const body = withLabels
    .filter(l => plain(l) !== title || !l.startsWith('####'))
    .map(l => (l.startsWith('####') ? `${HEADING}${plain(l)}:` : l));
  const isHeading = (l: string) => l.startsWith(HEADING);
  const render = (ls: string[]) => ls.map(l => (isHeading(l) ? `\n${l.slice(1)}` : l)).join('\n').trim();

  const chunks: string[] = [];
  let cur: string[] = [];
  const size = () => cur.reduce((n, l) => n + l.length + 1, 0);
  for (const line of body) {
    if (cur.length && size() + line.length + 1 > MAX_ENTRY) {
      const carry: string[] = [];
      while (cur.length && isHeading(cur[cur.length - 1])) carry.unshift(cur.pop()!);
      if (cur.length) chunks.push(render(cur));
      cur = carry;
    }
    cur.push(line);
  }
  while (cur.length && isHeading(cur[cur.length - 1])) cur.pop();
  if (cur.length) chunks.push(render(cur));

  return chunks
    .filter(c => c.length >= 60)
    .map((answer, i) => ({ lang, page, url, question: chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title, answer }));
}

// FAQ answers live in <details><summary>question</summary>answer</details>
function faqSections(html: string, url: string, lang: 'uz' | 'ru'): SiteSection[] {
  const out: SiteSection[] = [];
  for (const m of html.matchAll(/<details[^>]*>([\s\S]*?)<\/details>/gi)) {
    const q = m[1].match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1];
    if (!q) continue;
    const question = normalize(decodeEntities(q.replace(/<[^>]+>/g, ' ')));
    const answer = normalize(decodeEntities(m[1].replace(/<summary[\s\S]*?<\/summary>/i, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '));
    if (question && answer) out.push({ lang, page: 'faq', url, question, answer });
  }
  return out;
}

export async function fetchInfoSections(): Promise<{ sections: SiteSection[]; errors: string[] }> {
  const errors: string[] = [];
  const jobs = INFO_PAGES.flatMap(page => (['uz', 'ru'] as const).map(lang => ({ page, lang })));
  const results = await pool(jobs, 6, async ({ page, lang }): Promise<SiteSection[]> => {
    const url = `${SITE}/${lang}/${page}`;
    try {
      const html = await fetchText(url);
      if (page === 'faq') {
        const faq = faqSections(html, url, lang);
        if (faq.length) return faq;
      }
      return pageEntries(mainLines(pageLines(html)), page, url, lang);
    } catch (e) {
      errors.push(String((e as any)?.message || e));
      return [];
    }
  });
  return { sections: results.flat(), errors };
}
