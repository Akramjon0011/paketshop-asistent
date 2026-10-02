import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { ProductTile } from './ProductTile';
import { searchKey, type CatalogProduct } from '../lib/catalog';

// The whole catalogue in a sheet over the chat: search, categories and small tiles. The chat stays the main place;
// tapping a tile hands the question to the assistant.
export default function CatalogSheet({
  open,
  products,
  failed,
  onRetry,
  onClose,
  onAsk,
}: {
  open: boolean;
  products: CatalogProduct[] | null;
  failed: boolean;
  onRetry: () => void;
  onClose: () => void;
  onAsk: (p: CatalogProduct) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products ?? []) if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return [...counts.entries()];
  }, [products]);

  const visible = useMemo(() => {
    const q = searchKey(query);
    return (products ?? []).filter(p =>
      (!category || p.category === category)
      && (!q || searchKey(`${p.name} ${p.sku} ${p.category ?? ''}`).includes(q)));
  }, [products, query, category]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label="Mahsulotlar katalogi">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-gray-50 w-full sm:max-w-3xl max-h-[88dvh] rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col overflow-hidden">
        <div className="bg-white border-b border-gray-100 p-4 pb-3 space-y-3 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Katalog</h2>
              <p className="text-xs text-gray-500">
                {products ? `${products.length} ta mahsulot · ` : ''}narxlar qadoq uchun · bosing, yordamchi batafsil aytib beradi
              </p>
            </div>
            <button type="button" onClick={onClose} className="p-2 -m-1 rounded-full hover:bg-gray-100 text-gray-500 cursor-pointer" aria-label="Yopish">
              <X className="w-5 h-5" />
            </button>
          </div>
          <label className="relative block">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Qidirish: stakan, kraft paket, 20x30..."
              className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-9 pr-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
            />
          </label>
          {categories.length > 1 && (
            <div className="flex gap-2 overflow-x-auto -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {[[null, products?.length ?? 0] as const, ...categories].map(([name, count]) => (
                <button
                  key={name ?? 'all'}
                  type="button"
                  onClick={() => setCategory(name)}
                  className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors cursor-pointer ${
                    category === name
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white text-gray-700 border-gray-200 hover:border-amber-300'
                  }`}
                >
                  {name ?? 'Hammasi'} <span className="opacity-70">{count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 sm:p-4">
          {failed ? (
            <div className="py-12 text-center text-sm text-gray-500 space-y-3">
              <p>Katalogni yuklab bo'lmadi.</p>
              <button type="button" onClick={onRetry} className="px-4 py-2 rounded-xl bg-amber-500 text-white font-semibold cursor-pointer">Qayta urinish</button>
            </div>
          ) : products === null ? (
            <div className="py-12 flex justify-center text-amber-500"><Loader2 className="w-7 h-7 animate-spin" /></div>
          ) : visible.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-500">Hech narsa topilmadi. Yordamchidan so'rab ko'ring: u o'xshash mahsulotni topib beradi.</p>
          ) : (
            <div className="grid grid-cols-2 min-[440px]:grid-cols-3 md:grid-cols-4 gap-3">
              {visible.map(p => <ProductTile key={p.id} product={p} onAsk={onAsk} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
