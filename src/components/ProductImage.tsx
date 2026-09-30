import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';

// Product photo with a neat placeholder when the URL is missing or broken (no alt-text / broken-image icon)
export default function ProductImage({ src, alt, className = '' }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return (
      <div className={`bg-gradient-to-br from-amber-50 to-amber-100 flex items-center justify-center ${className}`} role="img" aria-label={alt}>
        <Package className="w-10 h-10 text-amber-300" />
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={`object-cover ${className}`} />;
}
