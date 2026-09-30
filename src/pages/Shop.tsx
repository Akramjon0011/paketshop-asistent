import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Package, RefreshCw, Search, ShoppingBag, Sparkles } from 'lucide-react';
import { cartActions, useCart } from '../lib/cart';
import { formatPrice } from '../lib/format';
import { DEFAULT_BRAND, type BrandConfig, type Product } from '../lib/types';
import ProductCard from '../components/shop/ProductCard';
import ProductSheet from '../components/shop/ProductSheet';
import CartSheet from '../components/shop/CartSheet';

export default function Shop() {
  const [brand, setBrand] = useState<BrandConfig>(DEFAULT_BRAND);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [selected, setSelected] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const { lines, count, total } = useCart();

  const loadProducts = useCallback((fresh = false) => {
    setLoadError(false);
    // The catalog is edge-cached for ~30s; after an order we bypass it so stock is up to date
    fetch(`/api/products${fresh ? `?t=${Date.now()}` : ''}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: unknown) => {
        if (!Array.isArray(data)) throw new Error('bad payload');
        setProducts(data as Product[]);
        cartActions.sync(data as Product[]);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    loadProducts();
    fetch('/api/config')
      .then(r => (r.ok ? r.json() : null))
      .then((cfg: BrandConfig | null) => { if (cfg) setBrand(cfg); })
      .catch(() => { /* keep defaults */ });
  }, [loadProducts]);

  // Categories (case-insensitive, first spelling wins)
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of products ?? []) {
      const label = p.category?.trim();
      if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
    }
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [products]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (products ?? []).filter(p => {
      if (category !== 'all' && (p.category?.trim().toLowerCase() ?? '') !== category) return false;
      if (!q) return true;
      return `${p.name} ${p.description ?? ''} ${p.category ?? ''}`.toLowerCase().includes(q);
    });
  }, [products, query, category]);

  const inCart = (id: number) => lines.find(l => l.product.id === id)?.quantity ?? 0;

  return (
    <div className="min-h-dvh bg-gray-50 font-sans pb-28">
      <header className="bg-amber-500 text-white shadow-md sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="bg-white/20 p-2 rounded-full shrink-0"><Package className="w-6 h-6" /></div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight truncate">{brand.shopName}</h1>
              <p className="text-amber-100 text-xs">Onlayn do'kon</p>
            </div>
          </div>
          <button type="button" onClick={() => setCartOpen(true)} aria-label="Savat" className="relative bg-white/20 hover:bg-white/30 p-2.5 rounded-full transition cursor-pointer shrink-0">
            <ShoppingBag className="w-5 h-5" />
            {count > 0 && (
              <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-white text-amber-600 text-xs font-extrabold flex items-center justify-center">{count}</span>
            )}
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 pt-4">
        <Link to="/chat" className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-400 text-white px-4 py-3 shadow-sm hover:shadow-md transition">
          <div className="bg-white/25 p-2 rounded-full shrink-0"><Sparkles className="w-5 h-5" /></div>
          <div className="min-w-0">
            <p className="font-bold leading-tight">{brand.assistantName} bilan gaplashing</p>
            <p className="text-xs text-amber-50 leading-snug">Yozing yoki ovoz bilan ayting — tanlashda yordam beradi</p>
          </div>
        </Link>

        <div className="mt-4 relative">
          <Search className="w-5 h-5 text-gray-400 absolute left-4 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Mahsulot qidirish..."
            type="search"
            className="w-full bg-white border border-gray-200 rounded-2xl pl-12 pr-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500"
          />
        </div>

        {categories.length > 1 && (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {[{ key: 'all', label: 'Hammasi' }, ...categories].map(c => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategory(c.key)}
                className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold transition cursor-pointer ${
                  category === c.key ? 'bg-amber-500 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-100'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        <div className="mt-4">
          {products === null && !loadError && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="bg-white rounded-2xl border border-gray-100 overflow-hidden animate-pulse">
                  <div className="aspect-square bg-gray-100" />
                  <div className="p-3 space-y-2"><div className="h-3 bg-gray-100 rounded w-4/5" /><div className="h-4 bg-gray-100 rounded w-1/2" /></div>
                </div>
              ))}
            </div>
          )}

          {loadError && products === null && (
            <div className="text-center py-16 text-gray-500">
              <p className="font-semibold">Mahsulotlarni yuklab bo'lmadi</p>
              <button type="button" onClick={() => loadProducts()} className="mt-3 inline-flex items-center gap-2 text-amber-700 font-semibold cursor-pointer">
                <RefreshCw className="w-4 h-4" /> Qayta urinish
              </button>
            </div>
          )}

          {products !== null && visible.length === 0 && (
            <div className="text-center py-16 text-gray-500">
              <p className="font-semibold">{products.length === 0 ? "Hozircha mahsulotlar yo'q" : 'Hech narsa topilmadi'}</p>
              {products.length > 0 && (
                <p className="text-sm mt-1">Boshqa so'z bilan qidirib ko'ring yoki {brand.assistantName}dan so'rang.</p>
              )}
            </div>
          )}

          {visible.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {visible.map(p => (
                <ProductCard
                  key={p.id}
                  product={p}
                  inCart={inCart(p.id)}
                  currency={brand.currency}
                  onOpen={() => setSelected(p)}
                  onAdd={() => cartActions.add(p)}
                  onSetQuantity={(n) => cartActions.setQuantity(p.id, n)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Floating chat shortcut + cart bar */}
      <Link
        to="/chat"
        aria-label={`${brand.assistantName}ga yozish`}
        className={`fixed right-4 z-30 flex items-center gap-2 bg-white text-amber-700 font-bold text-sm pl-3 pr-4 py-2.5 rounded-full shadow-lg border border-amber-100 hover:shadow-xl transition-all ${count > 0 ? 'bottom-24' : 'bottom-5'}`}
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        <MessageCircle className="w-5 h-5" /> {brand.assistantName}
      </Link>

      {count > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-30 px-4 pt-2 bg-gradient-to-t from-gray-50 via-gray-50/95 to-transparent pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="w-full max-w-5xl mx-auto flex items-center justify-between bg-amber-500 hover:bg-amber-600 active:scale-[0.99] transition text-white rounded-2xl px-5 py-3.5 shadow-lg cursor-pointer"
          >
            <span className="flex items-center gap-2 font-bold"><ShoppingBag className="w-5 h-5" /> Savat · {count} ta</span>
            <span className="font-extrabold">{formatPrice(total)} {brand.currency}</span>
          </button>
        </div>
      )}

      {selected && (
        <ProductSheet
          product={selected}
          inCart={inCart(selected.id)}
          currency={brand.currency}
          assistantName={brand.assistantName}
          onClose={() => setSelected(null)}
          onAdd={(qty) => cartActions.add(selected, qty)}
        />
      )}

      {cartOpen && (
        <CartSheet
          currency={brand.currency}
          onClose={() => setCartOpen(false)}
          onOrdered={() => loadProducts(true)}
        />
      )}
    </div>
  );
}
