import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, MessagesSquare, Search } from 'lucide-react';
import { CRM_STATUS, LOCAL_STATUS } from '../lib/requestStatus';

// Admin → "Suhbatlar": every conversation with Malika (Telegram, Mini App, paketshop.uz widget) and, under each answer,
// how it was produced: model, time, tools, request created, amounts the number guard questioned, unanswered topics.

type Channel = 'telegram' | 'web' | 'site';

type ConversationItem = {
  key: string;
  channel: Channel;
  name: string | null;
  phone: string | null;
  messages: number;
  first_at: string;
  last_at: string;
  last_question: string | null;
  requests: number[];
  gaps: number;
  checks: number;
  fallbacks: number;
};

type Meta = {
  name?: string; voice?: boolean; image?: boolean; contact?: boolean; askContact?: boolean;
  model?: string; fallback?: boolean; ms?: number; tools?: string[]; requests?: number[];
  corrected?: number[]; unverified?: number[]; nudged?: boolean; gaps?: Array<{ kind: string; topic: string }>;
};

type ConversationDetail = {
  key: string;
  channel: Channel;
  customer: { name: string | null; phone: string | null; address: string | null } | null;
  summary: string | null;
  messages: Array<{ id: number; role: 'user' | 'model'; content: string; meta: Meta | null; created_at: string }>;
  requests: Array<{ id: number; total_price: number; status: string; crm_status: string | null; on_site: boolean; created_at: string }>;
};

const CHANNEL: Record<Channel, { label: string; tone: string }> = {
  telegram: { label: 'Telegram', tone: 'bg-sky-50 text-sky-700 border-sky-100' },
  web: { label: 'Mini App', tone: 'bg-amber-50 text-amber-700 border-amber-100' },
  site: { label: 'Sayt', tone: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
};

const TOOL_LABEL: Record<string, string> = {
  list_products: 'katalog', search_products: 'qidiruv', get_product_details: 'mahsulot',
  calculate_quote: 'hisob', create_request: "so'rov", check_order_status: 'holat',
};

const FLAGS: Array<[string, string]> = [
  ['', 'Hammasi'], ['request', "So'rov qoldirgan"], ['gap', 'Javobsiz savol'], ['check', 'Narx tekshiruvi'], ['fallback', 'Zaxira model'],
];

const amount = (n: number) => Number(n).toLocaleString('en-US').replace(/,/g, ' ');
const pad = (n: number) => String(n).padStart(2, '0');
// "02.10 22:41" (the browser's locale would give "10-02", easily read as February)
const when = (value: string) => {
  const d = new Date(value);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const shortModel = (model: string) => model.replace(/^gemini-/, '');

// Answers keep the assistant's tags ([IMAGE: …], [BUYURTMA: id]); shown as short marks
const readable = (text: string) => text
  .replace(/\[IMAGE:[^\]]*\]/gi, '🖼')
  .replace(/\[VIDEO:[^\]]*\]/gi, '🎬')
  .replace(/\[BUYURTMA:\s*(\d+)\]/gi, '🛒 mahsulot #$1');

function Chip({ children, tone = 'bg-gray-50 text-gray-600 border-gray-200', title }: { children: React.ReactNode; tone?: string; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${tone}`}>{children}</span>;
}

function AnswerMeta({ meta }: { meta: Meta }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1.5 justify-end">
      {meta.model && (
        <Chip tone={meta.fallback ? 'bg-orange-50 text-orange-700 border-orange-200' : undefined} title={meta.fallback ? "Asosiy model band edi, zaxira model javob berdi" : undefined}>
          {meta.fallback ? 'zaxira: ' : ''}{shortModel(meta.model)}
        </Chip>
      )}
      {typeof meta.ms === 'number' && <Chip>{(meta.ms / 1000).toFixed(1)} s</Chip>}
      {meta.tools?.length ? <Chip title="Ishlatilgan vositalar">{meta.tools.map(t => TOOL_LABEL[t] ?? t).join(', ')}</Chip> : null}
      {meta.requests?.map(id => <Chip key={id} tone="bg-green-50 text-green-700 border-green-200">so'rov #{id}</Chip>)}
      {meta.corrected?.length ? (
        <Chip tone="bg-orange-50 text-orange-700 border-orange-200" title="Bu raqam(lar) ma'lumotlarda yo'q edi: javob bir marta qayta yozildi">
          narx tekshiruvi: {meta.corrected.map(amount).join(', ')}
        </Chip>
      ) : null}
      {meta.unverified?.length ? (
        <Chip tone="bg-red-50 text-red-700 border-red-200" title="Qayta yozilgandan keyin ham tasdiqlanmagan raqam">tasdiqlanmagan: {meta.unverified.map(amount).join(', ')}</Chip>
      ) : null}
      {meta.nudged && <Chip tone="bg-orange-50 text-orange-700 border-orange-200">funksiya eslatmasi</Chip>}
      {meta.askContact && <Chip tone="bg-sky-50 text-sky-700 border-sky-200" title="Telegram'da 'raqamni yuborish' tugmasi ko'rsatildi">📱 raqam so'raldi</Chip>}
      {meta.gaps?.map((g, i) => (
        <Chip key={i} tone="bg-purple-50 text-purple-700 border-purple-200">{g.kind === 'product' ? '📦' : 'ℹ️'} javobsiz: {g.topic}</Chip>
      ))}
    </div>
  );
}

export default function ConversationsPanel({ token }: { token: string }) {
  const [days, setDays] = useState(30);
  const [channel, setChannel] = useState('');
  const [flag, setFlag] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ days: String(days) });
    if (channel) params.set('channel', channel);
    if (flag) params.set('flag', flag);
    if (search) params.set('q', search);
    setLoading(true);
    setError('');
    fetch(`/api/admin/conversations?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async res => {
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!cancelled) setItems(Array.isArray(data.items) ? data.items : []);
      })
      .catch(() => { if (!cancelled) setError("Suhbatlarni yuklab bo'lmadi"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, days, channel, flag, search]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true);
    fetch(`/api/admin/conversations/${encodeURIComponent(selected)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async res => {
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!cancelled) setDetail(data);
      })
      .catch(() => { if (!cancelled) { setDetail(null); setError("Suhbatni ochib bo'lmadi"); } })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selected, token]);

  const select = (key: string) => setSelected(prev => (prev === key ? prev : key));

  return (
    <div className="space-y-4 animate-fadeIn">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <div className="flex justify-between items-start gap-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <MessagesSquare className="w-5 h-5 text-amber-500" /> Suhbatlar
            </h2>
            <p className="text-xs text-gray-500 font-medium max-w-2xl">
              Mijozlar Malika bilan qanday gaplashgani. Har bir javob ostida: qaysi model, qancha vaqtda, qaysi vositalar bilan
              javob bergani, so'rov yaratilgani, narx tekshiruvi va javobsiz qolgan mavzular.
            </p>
          </div>
          <span className="bg-amber-100 text-amber-800 text-xs font-bold px-3 py-1 rounded-full border border-amber-200 shrink-0">
            {items.length} ta
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
          <select value={days} onChange={e => setDays(Number(e.target.value))} className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white text-gray-800">
            <option value={1}>Bugun va kecha</option>
            <option value={7}>7 kun</option>
            <option value={30}>30 kun</option>
            <option value={90}>90 kun</option>
          </select>
          <select value={channel} onChange={e => setChannel(e.target.value)} className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white text-gray-800">
            <option value="">Barcha kanallar</option>
            <option value="telegram">Telegram</option>
            <option value="web">Mini App</option>
            <option value="site">Sayt (paketshop.uz)</option>
          </select>
          <select value={flag} onChange={e => setFlag(e.target.value)} className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white text-gray-800">
            {FLAGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <form onSubmit={e => { e.preventDefault(); setSearch(query.trim()); }} className="flex gap-1">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Matn bo'yicha qidirish"
              className="min-w-0 flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white text-gray-800"
            />
            <button type="submit" className="px-3 rounded-xl bg-amber-500 text-white" title="Qidirish"><Search className="w-4 h-4" /></button>
          </form>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl text-sm">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* List */}
        <div className={`lg:col-span-2 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden ${selected ? 'hidden lg:block' : ''}`}>
          <div className="divide-y divide-gray-100 max-h-[720px] overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="p-12 flex justify-center text-amber-500"><Loader2 className="w-8 h-8 animate-spin" /></div>
            ) : items.length === 0 ? (
              <div className="p-12 text-center text-sm text-gray-400">Bu filtr bo'yicha suhbat yo'q.</div>
            ) : items.map(item => (
              <button
                key={item.key}
                onClick={() => select(item.key)}
                className={`w-full text-left p-4 hover:bg-amber-50/50 transition-colors ${selected === item.key ? 'bg-amber-50' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-bold text-gray-900 truncate">{item.name || 'Mehmon'}</span>
                  <Chip tone={CHANNEL[item.channel]?.tone}>{CHANNEL[item.channel]?.label ?? item.channel}</Chip>
                  <span className="ml-auto text-[11px] text-gray-400 whitespace-nowrap">{when(item.last_at)}</span>
                </div>
                {item.phone && <div className="text-xs text-amber-700 font-semibold mt-0.5">{item.phone}</div>}
                {item.last_question && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{item.last_question}</p>}
                <div className="flex flex-wrap gap-1 mt-2">
                  <Chip>{item.messages} xabar</Chip>
                  {item.requests.map(id => <Chip key={id} tone="bg-green-50 text-green-700 border-green-200">so'rov #{id}</Chip>)}
                  {item.gaps > 0 && <Chip tone="bg-purple-50 text-purple-700 border-purple-200">javobsiz: {item.gaps}</Chip>}
                  {item.checks > 0 && <Chip tone="bg-orange-50 text-orange-700 border-orange-200">narx tekshiruvi: {item.checks}</Chip>}
                  {item.fallbacks > 0 && <Chip tone="bg-orange-50 text-orange-700 border-orange-200">zaxira model: {item.fallbacks}</Chip>}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* One conversation */}
        <div className={`lg:col-span-3 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden ${selected ? '' : 'hidden lg:block'}`}>
          {!selected ? (
            <div className="p-16 text-center text-sm text-gray-400">Suhbatni ko'rish uchun ro'yxatdan tanlang.</div>
          ) : detailLoading && !detail ? (
            <div className="p-12 flex justify-center text-amber-500"><Loader2 className="w-8 h-8 animate-spin" /></div>
          ) : !detail ? (
            <div className="p-12 text-center text-sm text-gray-400">Suhbat topilmadi.</div>
          ) : (
            <>
              <div className="p-4 border-b border-gray-100 bg-gray-50">
                <button onClick={() => setSelected(null)} className="lg:hidden flex items-center gap-1 text-xs font-bold text-amber-700 mb-2">
                  <ArrowLeft className="w-3.5 h-3.5" /> Ro'yxatga qaytish
                </button>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-gray-900">{detail.customer?.name || detail.messages.find(m => m.meta?.name)?.meta?.name || 'Mehmon'}</span>
                  <Chip tone={CHANNEL[detail.channel]?.tone}>{CHANNEL[detail.channel]?.label}</Chip>
                  {detail.customer?.phone && <a href={`tel:${detail.customer.phone}`} className="text-xs font-semibold text-amber-700">{detail.customer.phone}</a>}
                  {detail.customer?.address && <span className="text-xs text-gray-500">{detail.customer.address}</span>}
                </div>
                {detail.requests.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {detail.requests.map(r => (
                      <Chip key={r.id} tone={r.crm_status && CRM_STATUS[r.crm_status] ? CRM_STATUS[r.crm_status].tone : undefined}>
                        so'rov #{r.id} · {amount(r.total_price)} so'm · {r.crm_status && CRM_STATUS[r.crm_status] ? `CRM: ${CRM_STATUS[r.crm_status].label}` : (LOCAL_STATUS[r.status] ?? r.status)}
                      </Chip>
                    ))}
                  </div>
                )}
                {detail.summary && (
                  <p className="mt-2 text-xs text-gray-600 bg-white border border-gray-200 rounded-lg px-3 py-2">
                    <span className="font-bold">Oldingi qism xulosasi: </span>{detail.summary}
                  </p>
                )}
              </div>
              <div className="p-4 space-y-3 max-h-[640px] overflow-y-auto bg-white">
                {detail.messages.map(m => m.role === 'user' ? (
                  <div key={m.id} className="flex flex-col items-start">
                    <div className="max-w-[85%] bg-gray-100 text-gray-800 text-sm rounded-2xl rounded-tl-sm px-3 py-2 whitespace-pre-wrap break-words">{m.content}</div>
                    <div className="flex gap-1 mt-1 text-[11px] text-gray-400">
                      <span>{when(m.created_at)}</span>
                      {m.meta?.voice && <span>· 🎤 ovozli xabar</span>}
                      {m.meta?.image && <span>· 🖼 rasm</span>}
                      {m.meta?.contact && <span>· 📱 raqam Telegram tugmasi orqali</span>}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="flex flex-col items-end">
                    <div className="max-w-[85%] bg-amber-50 border border-amber-100 text-gray-800 text-sm rounded-2xl rounded-tr-sm px-3 py-2 whitespace-pre-wrap break-words">{readable(m.content)}</div>
                    <div className="text-[11px] text-gray-400 mt-1">Malika · {when(m.created_at)}</div>
                    {m.meta && <AnswerMeta meta={m.meta} />}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
