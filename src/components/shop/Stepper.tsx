import { Minus, Plus } from 'lucide-react';

export default function Stepper({ value, min = 0, max, onChange, size = 'md', fullWidth = false }: {
  value: number;
  min?: number;
  max: number;
  onChange: (next: number) => void;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
}) {
  const box = size === 'sm' ? 'w-8 h-8' : 'w-10 h-10';
  const btn = `${box} rounded-full flex items-center justify-center bg-white border border-gray-200 text-gray-700 shadow-sm active:scale-95 transition disabled:opacity-40 disabled:active:scale-100`;
  return (
    <div className={fullWidth ? 'flex items-center justify-between w-full' : 'inline-flex items-center gap-2'}>
      <button type="button" aria-label="Kamaytirish" className={btn} disabled={value <= min && min > 0} onClick={() => onChange(value - 1)}>
        <Minus className="w-4 h-4" />
      </button>
      <span className="min-w-6 text-center font-bold text-gray-900 tabular-nums">{value}</span>
      <button type="button" aria-label="Ko'paytirish" className={btn} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
