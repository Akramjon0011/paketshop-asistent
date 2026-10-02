import { formatPrice } from './format';

// A product as the Mini App shows it (GET /api/catalog)
export type CatalogProduct = {
  id: number;
  sku: string;
  name: string;
  category: string | null;
  price: number | null;      // per pack (or carton); null = price on request
  price_from: boolean;
  pack_unit: string;
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

const STOCK: Record<string, { label: string; dot: string }> = {
  in_stock: { label: 'Omborda bor', dot: 'bg-emerald-500' },
  low_stock: { label: 'Kam qoldi', dot: 'bg-amber-500' },
  on_order: { label: 'Buyurtma asosida', dot: 'bg-sky-500' },
  out_of_stock: { label: "Vaqtincha yo'q", dot: 'bg-red-500' },
  discontinued: { label: 'Sotuvdan chiqarilgan', dot: 'bg-gray-400' },
  check_with_manager: { label: 'Qoldiqni aniqlang', dot: 'bg-gray-400' },
};

export const stockOf = (code: string) => STOCK[code] ?? STOCK.check_with_manager;

export function priceText(p: CatalogProduct): string {
  if (p.price === null) return "Narxi so'raladi";
  return `${formatPrice(p.price)} so'm${p.price_from ? 'dan' : ''}`;
}

// "1 qadoq · 2 300 dona": makes clear the price above is for a whole pack
export function packText(p: CatalogProduct): string | null {
  if (!p.pack_qty) return null;
  return `1 ${p.pack_unit} · ${formatPrice(p.pack_qty)} dona${p.variants > 1 ? ` · ${p.variants} xil` : ''}`;
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
