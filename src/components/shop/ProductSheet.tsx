import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, ShoppingBag } from 'lucide-react';
import type { Product } from '../../lib/types';
import { maxQuantity } from '../../lib/cart';
import { formatPrice } from '../../lib/format';
import ProductImage from './ProductImage';
import Sheet from './Sheet';
import Stepper from './Stepper';

export default function ProductSheet({ product, inCart, currency, assistantName, onClose, onAdd }: {
  product: Product;
  inCart: number;
  currency: string;
  assistantName: string;
  onClose: () => void;
  onAdd: (quantity: number) => void;
}) {
  const max = maxQuantity(product);
  const soldOut = max === 0;
  const [quantity, setQuantity] = useState(1);
  const askAssistant = `/chat?q=${encodeURIComponent(`Mana shu mahsulot haqida ko'proq ma'lumot bering: "${product.name}" (ID: ${product.id})`)}`;

  const footer = soldOut ? (
    <button type="button" disabled className="w-full py-3 rounded-2xl bg-gray-100 text-gray-400 font-bold">Hozircha mavjud emas</button>
  ) : (
    <div className="flex items-center gap-3">
      <Stepper min={1} max={max} value={quantity} onChange={setQuantity} />
      <button
        type="button"
        onClick={() => { onAdd(quantity); onClose(); }}
        className="flex-1 py-3 rounded-2xl bg-amber-500 hover:bg-amber-600 active:scale-[0.98] transition text-white font-bold flex items-center justify-center gap-2 shadow cursor-pointer"
      >
        <ShoppingBag className="w-5 h-5" />
        {formatPrice(Number(product.price) * quantity)} {currency}
      </button>
    </div>
  );

  return (
    <Sheet title={product.name} onClose={onClose} footer={footer}>
      <div className="relative aspect-square sm:aspect-[4/3] rounded-2xl overflow-hidden bg-gray-50">
        <ProductImage src={product.image_url} alt={product.name} className="absolute inset-0 w-full h-full" />
      </div>

      <div className="mt-4 flex items-start justify-between gap-3">
        <p className="text-2xl font-extrabold text-amber-600">
          {formatPrice(product.price)} <span className="text-base font-semibold">{currency}</span>
        </p>
        {product.category && (
          <span className="bg-amber-50 text-amber-700 text-xs font-semibold px-3 py-1 rounded-full shrink-0">{product.category}</span>
        )}
      </div>

      <p className={`mt-1 text-sm font-medium ${soldOut ? 'text-red-500' : max <= 5 ? 'text-red-500' : 'text-green-600'}`}>
        {soldOut ? 'Hozircha mavjud emas' : max <= 5 ? `Omborda oxirgi ${product.stock} dona` : 'Omborda bor'}
        {inCart > 0 && <span className="text-gray-500 font-normal"> · savatda {inCart} ta</span>}
      </p>

      {product.description && (
        <p className="mt-4 text-sm text-gray-700 leading-relaxed whitespace-pre-line">{product.description}</p>
      )}

      <Link
        to={askAssistant}
        className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 px-4 py-2 rounded-xl transition"
      >
        <MessageCircle className="w-4 h-4" /> {assistantName}dan so'rash
      </Link>
    </Sheet>
  );
}
