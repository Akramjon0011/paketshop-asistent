import { ExternalLink } from 'lucide-react';
import ProductImage from './ProductImage';
import { packText, pageUrl, priceText, productName, stockOf, thumbUrl, type CatalogProduct } from '../lib/catalog';
import { STRINGS, type Lang } from '../lib/i18n';

function Stock({ code, lang }: { code: string; lang: Lang }) {
  const stock = stockOf(code, lang);
  return (
    <span className="text-[11px] text-gray-500 flex items-center gap-1">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${stock.dot}`} />
      {stock.label}
    </span>
  );
}

// Small card: photo, name, pack price, pieces per pack, stock. Tapping asks the assistant about the product; ↗ opens its
// page on paketshop.uz. `compact` (the strip above the first message) keeps only a low photo, the name and the price.
export function ProductTile({ product, lang, onAsk, compact = false, className = '' }: {
  product: CatalogProduct;
  lang: Lang;
  onAsk: (p: CatalogProduct) => void;
  compact?: boolean;
  className?: string;
}) {
  const t = STRINGS[lang];
  const name = productName(product, lang);
  const pack = packText(product, lang);
  const url = pageUrl(product, lang);
  return (
    <div className={`relative bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-amber-200 transition ${className}`}>
      <button
        type="button"
        onClick={() => onAsk(product)}
        className="block w-full text-left cursor-pointer"
        title={t.askTitle(name)}
      >
        <ProductImage src={thumbUrl(product.image_url, compact ? 240 : 360)} alt={name} className={compact ? 'w-full h-[72px]' : 'w-full aspect-square'} />
        <div className="p-2 space-y-0.5">
          <p className="text-xs font-semibold text-gray-800 leading-snug line-clamp-2 min-h-[2rem]">{name}</p>
          <p className={`text-xs font-bold ${product.price === null ? 'text-gray-500' : 'text-amber-600'}`}>{priceText(product, lang)}</p>
          {!compact && pack && <p className="text-[11px] text-gray-500 leading-tight">{pack}</p>}
          {!compact && <Stock code={product.availability} lang={lang} />}
        </div>
      </button>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute top-1.5 right-1.5 bg-white/90 hover:bg-white text-gray-600 rounded-full p-1.5 shadow"
          title={t.openOnSite}
          aria-label={`${name}: ${t.openOnSite}`}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  );
}

// The product an answer recommends ([BUYURTMA: id]), shown right under that answer
export function ProductCardInline({ product, lang }: { product: CatalogProduct; lang: Lang }) {
  const name = productName(product, lang);
  const pack = packText(product, lang);
  const url = pageUrl(product, lang);
  return (
    <div className="flex items-center gap-3 bg-amber-50/60 border border-amber-100 rounded-xl p-2">
      <ProductImage src={thumbUrl(product.image_url, 160)} alt={name} className="w-14 h-14 rounded-lg shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-semibold text-gray-800 leading-snug line-clamp-2">{name}</p>
        <p className="text-xs text-gray-600">
          <span className={`font-bold ${product.price === null ? 'text-gray-500' : 'text-amber-600'}`}>{priceText(product, lang)}</span>
          {pack ? ` · ${pack}` : ''}
        </p>
        <Stock code={product.availability} lang={lang} />
      </div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1 shadow-sm"
        >
          {STRINGS[lang].onSite} <ExternalLink className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  );
}
