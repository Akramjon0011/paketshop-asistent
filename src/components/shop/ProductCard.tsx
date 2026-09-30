import { ShoppingBag } from 'lucide-react';
import type { Product } from '../../lib/types';
import { maxQuantity } from '../../lib/cart';
import { formatPrice } from '../../lib/format';
import ProductImage from './ProductImage';
import Stepper from './Stepper';

export default function ProductCard({ product, inCart, currency, onOpen, onAdd, onSetQuantity }: {
  product: Product;
  inCart: number;
  currency: string;
  onOpen: () => void;
  onAdd: () => void;
  onSetQuantity: (quantity: number) => void;
}) {
  const max = maxQuantity(product);
  const soldOut = max === 0;
  const lowStock = !soldOut && Number(product.stock) <= 5;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden flex flex-col">
      <button type="button" onClick={onOpen} className="text-left flex-1 cursor-pointer">
        <div className="relative aspect-square bg-gray-50">
          <ProductImage src={product.image_url} alt={product.name} className="absolute inset-0 w-full h-full" />
          {soldOut && (
            <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
              <span className="bg-gray-800 text-white text-xs font-bold px-3 py-1 rounded-full">Tugagan</span>
            </div>
          )}
          {product.category && !soldOut && (
            <span className="absolute top-2 left-2 bg-white/90 backdrop-blur text-[11px] font-semibold text-amber-700 px-2 py-0.5 rounded-full max-w-[85%] truncate">
              {product.category}
            </span>
          )}
        </div>
        <div className="p-3 pb-2">
          <h3 className="text-sm font-semibold text-gray-900 leading-snug line-clamp-2 min-h-[2.5rem]">{product.name}</h3>
          <p className="mt-1 text-base font-extrabold text-amber-600">
            {formatPrice(product.price)} <span className="text-xs font-semibold">{currency}</span>
          </p>
          {lowStock && <p className="text-[11px] text-red-500 font-medium mt-0.5">Oxirgi {product.stock} dona</p>}
        </div>
      </button>

      <div className="px-3 pb-3">
        {soldOut ? (
          <button type="button" disabled className="w-full py-2 rounded-xl bg-gray-100 text-gray-400 text-sm font-semibold">
            Mavjud emas
          </button>
        ) : inCart > 0 ? (
          <div className="bg-amber-50 rounded-xl px-1.5 py-1">
            <Stepper size="sm" fullWidth value={inCart} max={max} onChange={onSetQuantity} />
          </div>
        ) : (
          <button
            type="button"
            onClick={onAdd}
            className="w-full py-2 rounded-xl bg-amber-500 hover:bg-amber-600 active:scale-[0.98] transition text-white text-sm font-bold flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
          >
            <ShoppingBag className="w-4 h-4" /> Savatga
          </button>
        )}
      </div>
    </div>
  );
}
