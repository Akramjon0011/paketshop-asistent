import { formatPrice } from './format';
import type { Lang } from './i18n';

// A product as the Mini App shows it (GET /api/catalog)
export type CatalogProduct = {
  id: number;
  sku: string;
  name: string;
  name_ru: string | null;
  category: string | null;
  category_ru: string | null;
  price: number | null;      // per pack (or carton); null = price on request
  price_from: boolean;
  pack_unit: string;         // Uzbek word from the site: qadoq, korobka, dona, rulon, kg
  pack_qty: number | null;   // pieces in one pack
  unit_price: number | null;
  availability: string;
  image_url: string | null;
  url: string | null;        // product page on paketshop.uz
  variants: number;
};

let request: Promise<CatalogProduct[]> | null = null;

// Loaded once per page and shared by the strip, the catalogue sheet and the cards under answers; a failed load can be retried
export function loadCatalog(): Promise<CatalogProduct[]> {
  if (!request) {
    request = fetch('/api/catalog')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(data => (Array.isArray(data?.products) ? (data.products as CatalogProduct[]) : []))
      .catch(err => {
        request = null;
        throw err;
      });
  }
  return request;
}

export const productName = (p: CatalogProduct, lang: Lang) => (lang === 'ru' && p.name_ru) || p.name;
export const categoryName = (p: CatalogProduct, lang: Lang) => (lang === 'ru' && p.category_ru) || p.category;

// The site has every product page in both languages: /uz/product/... and /ru/product/...
export const pageUrl = (p: CatalogProduct, lang: Lang) =>
  p.url && lang === 'ru' ? p.url.replace(/^(https:\/\/[^/]+)\/uz(?=\/|$)/, '$1/ru') : p.url;

const STOCK: Record<string, { uz: string; ru: string; dot: string }> = {
  in_stock: { uz: 'Omborda bor', ru: 'В наличии', dot: 'bg-emerald-500' },
  low_stock: { uz: 'Kam qoldi', ru: 'Мало', dot: 'bg-amber-500' },
  on_order: { uz: 'Buyurtma asosida', ru: 'Под заказ', dot: 'bg-sky-500' },
  out_of_stock: { uz: "Vaqtincha yo'q", ru: 'Временно нет', dot: 'bg-red-500' },
  discontinued: { uz: 'Sotuvdan chiqarilgan', ru: 'Снят с продажи', dot: 'bg-gray-400' },
  check_with_manager: { uz: 'Qoldiqni aniqlang', ru: 'Уточнить наличие', dot: 'bg-gray-400' },
};

export function stockOf(code: string, lang: Lang): { label: string; dot: string } {
  const s = STOCK[code] ?? STOCK.check_with_manager;
  return { label: s[lang], dot: s.dot };
}

const UNIT_RU: Record<string, string> = { qadoq: 'упаковка', korobka: 'коробка', dona: 'шт.', rulon: 'рулон', kg: 'кг' };

// The site stores product photos on Cloudinary at 1200px (~200 KB each); a small tile asks Cloudinary for a small copy
// (~20 KB). Other addresses are used as they are.
export function thumbUrl(url: string | null, width: number): string | null {
  if (!url) return null;
  const m = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(?:[^/]*_[^/]*\/)?(v\d+\/.+)$/.exec(url);
  return m ? `${m[1]}c_limit,w_${width},q_auto,f_auto/${m[2]}` : url;
}

export function priceText(p: CatalogProduct, lang: Lang = 'uz'): string {
  if (p.price === null) return lang === 'ru' ? 'Цена по запросу' : "Narxi so'raladi";
  const amount = formatPrice(p.price);
  if (lang === 'ru') return `${p.price_from ? 'от ' : ''}${amount} сум`;
  return `${amount} so'm${p.price_from ? 'dan' : ''}`;
}

// "1 qadoq · 2 300 dona": makes clear the price above is for a whole pack
export function packText(p: CatalogProduct, lang: Lang = 'uz'): string | null {
  if (!p.pack_qty) return null;
  const pieces = formatPrice(p.pack_qty);
  if (lang === 'ru') {
    return `1 ${UNIT_RU[p.pack_unit] ?? p.pack_unit} · ${pieces} шт.${p.variants > 1 ? ` · ${p.variants} вар.` : ''}`;
  }
  return `1 ${p.pack_unit} · ${pieces} dona${p.variants > 1 ? ` · ${p.variants} xil` : ''}`;
}

// What customers type vs. what the catalogue says: ' for ʻ ‘ ’, 20x30 for 20х30 / 20×30, case and extra spaces
export const searchKey = (s: string) =>
  s.toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/(\d)\s*[х×*]\s*(\d)/g, '$1x$2')
    .replace(/\s+/g, ' ')
    .trim();

// A short, varied selection for the strip above the first message: one product per category in turn,
// preferring ones with a photo, a price and stock
export function featuredProducts(products: CatalogProduct[], limit = 10): CatalogProduct[] {
  const score = (p: CatalogProduct) => (p.image_url ? 4 : 0) + (p.price !== null ? 2 : 0) + (p.availability === 'in_stock' ? 1 : 0);
  const byCategory = new Map<string, CatalogProduct[]>();
  for (const p of products.filter(p => p.availability !== 'discontinued' && p.availability !== 'out_of_stock').sort((a, b) => score(b) - score(a))) {
    const key = p.category ?? '';
    byCategory.set(key, [...(byCategory.get(key) ?? []), p]);
  }
  const queues = [...byCategory.values()];
  const picked: CatalogProduct[] = [];
  while (picked.length < limit && queues.some(q => q.length)) {
    for (const q of queues) {
      const next = q.shift();
      if (next) picked.push(next);
      if (picked.length >= limit) break;
    }
  }
  return picked;
}
