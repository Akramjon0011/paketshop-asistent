import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { STRINGS, type Lang } from '../lib/i18n';

// "So'rovlarim": the customer's own requests with the status the managers set (the same list as the bot's
// /sorovlarim). The server finds them by this session and, inside Telegram, by the signed Telegram account.

type RequestStatus = 'NEW' | 'CONTACTED' | 'IN_PROGRESS' | 'WON' | 'LOST' | 'pending' | 'processing' | 'delivered' | 'cancelled';
type MyRequest = { id: number; created_at: string; total: number; status: RequestStatus; items: Array<{ name: string; packs: number | null; unit: string | null }> };

const TONE: Record<RequestStatus, string> = {
  NEW: 'bg-blue-50 text-blue-700 border-blue-100',
  pending: 'bg-blue-50 text-blue-700 border-blue-100',
  CONTACTED: 'bg-amber-50 text-amber-700 border-amber-100',
  IN_PROGRESS: 'bg-purple-50 text-purple-700 border-purple-100',
  processing: 'bg-purple-50 text-purple-700 border-purple-100',
  WON: 'bg-green-50 text-green-700 border-green-100',
  delivered: 'bg-green-50 text-green-700 border-green-100',
  LOST: 'bg-gray-100 text-gray-600 border-gray-200',
  cancelled: 'bg-gray-100 text-gray-600 border-gray-200',
};

const amount = (n: number) => Number(n).toLocaleString('en-US').replace(/,/g, ' ');
const pad = (n: number) => String(n).padStart(2, '0');
const day = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
};

export default function MyRequestsSheet({ open, lang, webSessionId, onClose, onRepeat }: {
  open: boolean;
  lang: Lang;
  webSessionId: string;
  onClose: () => void;
  onRepeat: (id: number) => void;
}) {
  const t = STRINGS[lang];
  const [items, setItems] = useState<MyRequest[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setItems(null);
    setFailed(false);
    const initData = (window as any).Telegram?.WebApp?.initData;
    fetch('/api/my-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(initData ? { 'X-Telegram-Init-Data': initData } : {}) },
      body: JSON.stringify({ webSessionId }),
    })
      .then(async res => {
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        setItems(Array.isArray(data.items) ? data.items : []);
      })
      .catch(() => setFailed(true));
  }, [webSessionId]);

  useEffect(() => {
    if (open && webSessionId) load();
  }, [open, webSessionId, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label={t.myRequestsTitle}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-gray-50 w-full sm:max-w-xl max-h-[88dvh] rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col overflow-hidden">
        <div className="bg-white border-b border-gray-100 p-4 flex items-start justify-between gap-3 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{t.myRequestsTitle}</h2>
            <p className="text-xs text-gray-500">{t.myRequestsSubtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 -m-1 rounded-full hover:bg-gray-100 text-gray-500 cursor-pointer" aria-label={t.close}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">
          {failed ? (
            <div className="py-12 text-center text-sm text-gray-500 space-y-3">
              <p>{t.myRequestsFailed}</p>
              <button type="button" onClick={load} className="px-4 py-2 rounded-xl bg-amber-500 text-white font-semibold cursor-pointer">{t.retry}</button>
            </div>
          ) : items === null ? (
            <div className="py-12 flex justify-center text-amber-500"><Loader2 className="w-7 h-7 animate-spin" /></div>
          ) : items.length === 0 ? (
            <p className="py-12 px-6 text-center text-sm text-gray-500">{t.myRequestsEmpty}</p>
          ) : items.map(r => (
            <div key={r.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-gray-900">#{r.id}</span>
                <span className="text-xs text-gray-400">{day(r.created_at)}</span>
              </div>
              {r.items.length > 0 && (
                <ul className="mt-1.5 text-sm text-gray-700 space-y-0.5">
                  {r.items.slice(0, 3).map((item, i) => (
                    <li key={i}>{item.name}{item.packs ? ` — ${item.packs} ${t.unit(item.unit)}` : ''}</li>
                  ))}
                  {r.items.length > 3 && <li className="text-gray-400">{t.moreItems(r.items.length - 3)}</li>}
                </ul>
              )}
              <div className="mt-2.5 flex items-center justify-between gap-2 flex-wrap">
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${TONE[r.status] ?? TONE.pending}`}>
                  {t.requestStatus[r.status] ?? t.requestStatus.pending}
                </span>
                {r.total > 0 && <span className="text-sm font-bold text-amber-700">{amount(r.total)} {t.sum}</span>}
              </div>
              {r.items.length > 0 && (
                <button
                  type="button"
                  onClick={() => onRepeat(r.id)}
                  className="mt-3 w-full text-sm font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl py-2 transition-colors cursor-pointer"
                >
                  {t.repeat}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
