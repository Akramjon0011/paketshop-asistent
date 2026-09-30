import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

// Bottom sheet on phones, centered dialog on larger screens. Closes on Esc / backdrop click and locks page scroll.
export default function Sheet({ title, onClose, children, footer }: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92dvh] flex flex-col shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
          <h2 className="text-lg font-bold text-gray-900 truncate">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Yopish" className="p-2 -mr-2 rounded-full text-gray-500 hover:bg-gray-100 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 pb-4 flex-1">{children}</div>
        {footer && <div className="shrink-0 border-t border-gray-100 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}
