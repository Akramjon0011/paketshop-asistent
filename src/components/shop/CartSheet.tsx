import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { cartActions, maxQuantity, useCart } from '../../lib/cart';
import { formatPrice } from '../../lib/format';
import { getWebSessionId } from '../../lib/session';
import ProductImage from './ProductImage';
import Sheet from './Sheet';
import Stepper from './Stepper';

type View = 'cart' | 'checkout' | 'done';

const inputClass = 'w-full bg-gray-50 border border-gray-300 rounded-xl px-4 py-3 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500';

export default function CartSheet({ currency, onClose, onOrdered }: {
  currency: string;
  onClose: () => void;
  onOrdered: () => void;
}) {
  const { lines, count, total } = useCart();
  const [view, setView] = useState<View>('cart');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<{ id: number; total: number } | null>(null);

  // Pre-fill details of a returning customer
  useEffect(() => {
    fetch(`/api/customers/session/${encodeURIComponent(getWebSessionId())}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data) return;
        setName(prev => prev || data.name || '');
        setPhone(prev => prev || data.phone || '');
        setAddress(prev => prev || data.address || '');
      })
      .catch(() => { /* optional convenience */ });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || lines.length === 0) return;
    if (!name.trim() || !phone.trim() || !address.trim()) {
      setError("Iltimos, barcha maydonlarni to'ldiring.");
      return;
    }
    if (phone.replace(/\D/g, '').length < 9) {
      setError("Telefon raqami noto'g'ri. Masalan: +998901234567");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: name.trim(),
          customer_phone: phone.trim(),
          delivery_address: address.trim(),
          items: lines.map(l => ({ product_id: l.product.id, name: l.product.name, quantity: l.quantity })),
          webSessionId: getWebSessionId(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || "Buyurtma berishda xatolik yuz berdi.");
      setOrder({ id: data.order_id, total: Number(data.total_price) });
      cartActions.clear();
      setView('done');
      onOrdered();
    } catch (err: any) {
      setError(err.message || "Buyurtmani rasmiylashtirishda xatolik yuz berdi.");
    } finally {
      setSubmitting(false);
    }
  };

  if (view === 'done' && order) {
    return (
      <Sheet title="Buyurtma qabul qilindi" onClose={onClose}
        footer={<button type="button" onClick={onClose} className="w-full py-3 rounded-2xl bg-amber-500 hover:bg-amber-600 text-white font-bold cursor-pointer">Do'konga qaytish</button>}>
        <div className="py-8 text-center">
          <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto" />
          <p className="mt-4 text-xl font-bold text-gray-900">Rahmat! Buyurtma #{order.id}</p>
          <p className="mt-2 text-gray-600">Jami: <b>{formatPrice(order.total)} {currency}</b></p>
          <p className="mt-1 text-sm text-gray-500">Tez orada kuryerimiz siz bilan bog'lanadi.</p>
        </div>
      </Sheet>
    );
  }

  if (view === 'checkout') {
    return (
      <Sheet title="Buyurtmani rasmiylashtirish" onClose={onClose}
        footer={
          <button type="submit" form="checkout-form" disabled={submitting}
            className="w-full py-3 rounded-2xl bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white font-bold flex items-center justify-center gap-2 shadow cursor-pointer">
            {submitting && <Loader2 className="w-5 h-5 animate-spin" />}
            Buyurtmani tasdiqlash · {formatPrice(total)} {currency}
          </button>
        }>
        <button type="button" onClick={() => { setView('cart'); setError(null); }} className="flex items-center gap-1 text-sm font-semibold text-amber-700 mb-4 cursor-pointer">
          <ArrowLeft className="w-4 h-4" /> Savatga qaytish
        </button>
        <form id="checkout-form" onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-xs font-bold text-gray-600 uppercase tracking-wide">Ism va familiyangiz</span>
            <input className={`${inputClass} mt-1`} value={name} onChange={e => setName(e.target.value)} placeholder="Ismingizni kiriting" autoComplete="name" maxLength={100} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-gray-600 uppercase tracking-wide">Telefon raqamingiz</span>
            <input className={`${inputClass} mt-1`} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+998901234567" type="tel" inputMode="tel" autoComplete="tel" maxLength={20} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-gray-600 uppercase tracking-wide">Yetkazib berish manzili</span>
            <textarea className={`${inputClass} mt-1 resize-none`} rows={3} value={address} onChange={e => setAddress(e.target.value)} placeholder="Shahar, tuman, ko'cha, uy/kvartira" autoComplete="street-address" maxLength={300} />
          </label>
          {error && <div className="text-red-600 text-sm bg-red-50 border border-red-100 rounded-xl p-3">{error}</div>}
        </form>
      </Sheet>
    );
  }

  return (
    <Sheet title={`Savat${count > 0 ? ` (${count})` : ''}`} onClose={onClose}
      footer={lines.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-gray-600">Jami</span>
            <span className="text-xl font-extrabold text-amber-600">{formatPrice(total)} {currency}</span>
          </div>
          <button type="button" onClick={() => setView('checkout')} className="w-full py-3 rounded-2xl bg-amber-500 hover:bg-amber-600 active:scale-[0.98] transition text-white font-bold shadow cursor-pointer">
            Buyurtma berish
          </button>
        </div>
      ) : undefined}>
      {lines.length === 0 ? (
        <div className="py-12 text-center text-gray-500">
          <p className="font-semibold">Savat bo'sh</p>
          <button type="button" onClick={onClose} className="mt-3 text-amber-700 font-semibold cursor-pointer">Xarid qilishni boshlash</button>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {lines.map(({ product, quantity }) => (
            <li key={product.id} className="py-3 flex gap-3">
              <ProductImage src={product.image_url} alt={product.name} className="w-16 h-16 rounded-xl shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 line-clamp-2">{product.name}</p>
                <p className="text-sm text-amber-600 font-bold mt-0.5">{formatPrice(Number(product.price) * quantity)} {currency}</p>
                <div className="mt-2 flex items-center justify-between">
                  <Stepper size="sm" min={1} max={maxQuantity(product)} value={quantity} onChange={(n) => cartActions.setQuantity(product.id, n)} />
                  <button type="button" aria-label={`${product.name}ni o'chirish`} onClick={() => cartActions.remove(product.id)} className="p-2 text-gray-400 hover:text-red-500 cursor-pointer">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
