// "Mening so'rovlarim": the requests a customer created — from their Telegram account and/or this web session — with
// the status the managers set in the site CRM. No phone number is needed: the Telegram account (or the session) is
// the proof, and only requests created from it are listed.

import type { Sql } from './db.js';
import { fetchLeadStatuses } from './siteBridge.js';
import { storeCrmStatus } from './outcomes.js';
import { formatAmount } from './numberGuard.js';
import { SHOP } from './shopInfo.js';

type Fetch = typeof fetch;
type Lang = 'uz' | 'ru';

// CRM statuses first; requests that never reached the site keep the assistant admin's own status
export type RequestStatus = 'NEW' | 'CONTACTED' | 'IN_PROGRESS' | 'WON' | 'LOST' | 'pending' | 'processing' | 'delivered' | 'cancelled';

export type MyRequest = {
  id: number;
  created_at: string;
  total: number;
  status: RequestStatus;
  items: Array<{ name: string; packs: number | null; unit: string | null }>;
};

const LIMIT = 10;
const KNOWN: RequestStatus[] = ['NEW', 'CONTACTED', 'IN_PROGRESS', 'WON', 'LOST', 'pending', 'processing', 'delivered', 'cancelled'];

export async function customerRequests(
  db: Sql,
  who: { telegramId?: number | null; webSessionId?: string | null },
  opts: { fetch?: Fetch } = {},
): Promise<MyRequest[]> {
  const tg = who.telegramId ?? null;
  const web = who.webSessionId ?? null;
  if (!tg && !web) return [];
  const rows = await db`
    SELECT id, items, total_price, status, crm_status, site_lead_id, created_at FROM orders
    WHERE (${tg}::bigint IS NOT NULL AND telegram_id = ${tg}::bigint)
       OR (${web}::text IS NOT NULL AND web_session_id = ${web}::text)
    ORDER BY created_at DESC
    LIMIT ${LIMIT}`;

  // The current CRM status of these requests (the stored one when the site cannot be asked)
  const leads = await fetchLeadStatuses(rows.filter((r: any) => r.site_lead_id).map((r: any) => String(r.site_lead_id)), opts);
  for (const row of rows as any[]) {
    const lead = row.site_lead_id ? leads.get(String(row.site_lead_id)) : undefined;
    if (lead && lead.status !== row.crm_status) {
      await storeCrmStatus(db, row.id, lead);
      row.crm_status = lead.status;
    }
  }

  return rows.map((row: any) => {
    const status = (row.crm_status || row.status) as RequestStatus;
    const items = (Array.isArray(row.items) ? row.items : []).map((item: any) => ({
      name: String(item?.name ?? '').slice(0, 120),
      packs: Number.isFinite(Number(item?.packs ?? item?.quantity)) ? Number(item.packs ?? item.quantity) : null,
      unit: item?.unit ? String(item.unit) : null,
    }));
    return {
      id: row.id,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      total: Number(row.total_price) || 0,
      status: KNOWN.includes(status) ? status : 'pending',
      items,
    };
  });
}

// What the customer sees (not the managers' CRM words)
export const STATUS_TEXT: Record<Lang, Record<RequestStatus, string>> = {
  uz: {
    NEW: "Qabul qilindi, menejer tez orada bog'lanadi",
    pending: "Qabul qilindi, menejer tez orada bog'lanadi",
    CONTACTED: "Menejer siz bilan bog'landi",
    IN_PROGRESS: 'Jarayonda: narx, qoldiq va yetkazish kelishilmoqda',
    processing: "Jo'natishga tayyorlanmoqda",
    WON: 'Kelishildi ✅',
    delivered: 'Topshirildi ✅',
    LOST: 'Yopildi',
    cancelled: 'Bekor qilindi',
  },
  ru: {
    NEW: 'Принята, менеджер скоро свяжется',
    pending: 'Принята, менеджер скоро свяжется',
    CONTACTED: 'Менеджер связался с вами',
    IN_PROGRESS: 'В работе: согласуем цену, наличие и доставку',
    processing: 'Готовится к отправке',
    WON: 'Согласована ✅',
    delivered: 'Доставлена ✅',
    LOST: 'Закрыта',
    cancelled: 'Отменена',
  },
};

const UNIT_RU: Record<string, string> = { qadoq: 'упак.', korobka: 'кор.', dona: 'шт.', rulon: 'рул.', kg: 'кг' };

const day = (iso: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}`;
};

function itemsLine(items: MyRequest['items'], lang: Lang): string {
  const shown = items.slice(0, 2).map(item => {
    const unit = item.unit ? (lang === 'ru' ? UNIT_RU[item.unit] ?? item.unit : item.unit) : lang === 'ru' ? 'упак.' : 'qadoq';
    return item.packs ? `${item.name} — ${item.packs} ${unit}` : item.name;
  });
  if (items.length > 2) shown.push(lang === 'ru' ? `и ещё ${items.length - 2}` : `va yana ${items.length - 2} ta`);
  return shown.join('; ');
}

// The list as a Telegram message
export function formatMyRequests(list: MyRequest[], lang: Lang, assistant = { uz: 'Malika', ru: 'Малика' }): string {
  if (!list.length) {
    return lang === 'ru'
      ? `У вас пока нет заявок. Напишите, какой товар нужен — ${assistant.ru} рассчитает цену и оформит заявку.`
      : `Sizda hali so'rov yo'q. Qanday mahsulot kerakligini yozing — ${assistant.uz} narxini hisoblab, so'rovni rasmiylashtiradi.`;
  }
  const blocks = list.map(r => [
    `#${r.id} · ${day(r.created_at)}${r.total > 0 ? ` · ${formatAmount(r.total)} ${lang === 'ru' ? 'сум' : "so'm"}` : ''}`,
    ...(r.items.length ? [itemsLine(r.items, lang)] : []),
    `${lang === 'ru' ? 'Статус' : 'Holati'}: ${STATUS_TEXT[lang][r.status]}`,
  ].join('\n'));
  const head = lang === 'ru' ? '📋 Ваши заявки:' : "📋 Sizning so'rovlaringiz:";
  const foot = lang === 'ru'
    ? `Вопросы — пишите сюда или ${SHOP.telegram}, тел. ${SHOP.phone}.`
    : `Savol bo'lsa, shu yerga yozing yoki ${SHOP.telegram}, tel. ${SHOP.phone}.`;
  return [head, '', blocks.join('\n\n'), '', foot].join('\n').slice(0, 4000);
}

// ---------- ordering the same again ----------

export type RepeatItem = {
  product_id: number;
  variant_sku: string | null;
  packs: number;
  unit: string;
  name: string;
  line_total: number | null;   // what it came to then
  available: boolean;          // still in the catalogue
};
export type RepeatRequest = { id: number; total: number; items: RepeatItem[] };

// One of the customer's own requests, to order the same again; null when it is not theirs or has nothing to repeat
export async function repeatableRequest(
  db: Sql,
  id: number,
  who: { telegramId?: number | null; webSessionId?: string | null },
): Promise<RepeatRequest | null> {
  const tg = who.telegramId ?? null;
  const web = who.webSessionId ?? null;
  if (!Number.isSafeInteger(id) || id < 1 || (!tg && !web)) return null;
  const rows = await db`
    SELECT id, items, total_price FROM orders
    WHERE id = ${id}
      AND ((${tg}::bigint IS NOT NULL AND telegram_id = ${tg}::bigint) OR (${web}::text IS NOT NULL AND web_session_id = ${web}::text))`;
  if (!rows[0]) return null;
  const lines = (Array.isArray(rows[0].items) ? rows[0].items : [])
    .filter((line: any) => Number.isInteger(Number(line?.product_id)) && Number(line?.packs) > 0);
  if (!lines.length) return null;

  // A line's sku differs from the product's own sku when a variant was chosen
  const ids = [...new Set(lines.map((line: any) => Number(line.product_id)))];
  const products = await db`SELECT id, sku FROM products
                            WHERE active AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::int)`;
  const ownSku = new Map<number, string | null>(products.map((p: any) => [Number(p.id), p.sku ? String(p.sku) : null]));
  return {
    id: rows[0].id,
    total: Number(rows[0].total_price) || 0,
    items: lines.map((line: any) => {
      const productId = Number(line.product_id);
      const sku = line.sku ? String(line.sku) : null;
      const lineTotal = line.line_total === null || line.line_total === undefined ? NaN : Number(line.line_total);
      return {
        product_id: productId,
        variant_sku: ownSku.has(productId) && sku && sku !== ownSku.get(productId) ? sku : null,
        packs: Number(line.packs),
        unit: line.unit ? String(line.unit) : 'qadoq',
        name: String(line.name ?? '').slice(0, 160),
        line_total: Number.isFinite(lineTotal) && lineTotal > 0 ? lineTotal : null,
        available: ownSku.has(productId),
      };
    }),
  };
}

// System-prompt lines for a repeat (internal, in Uzbek like the rest of the prompt). The amounts of then are allowed
// for the number guard, so the answer may compare them with today's.
export function repeatHint(r: RepeatRequest): string {
  const lines = r.items.map(i => `- ${i.name}: product_id ${i.product_id}${i.variant_sku ? `, variant_sku ${i.variant_sku}` : ''}, ${i.packs} ${i.unit}`
    + `${i.line_total ? `, o'shanda ${formatAmount(i.line_total)} so'm` : ''}${i.available ? '' : " — HOZIR KATALOGDA YO'Q"}`);
  return `\n\nTAKRORIY SO'ROV: mijoz avvalgi #${r.id} so'rovini takrorlamoqchi${r.total ? ` (o'shanda taxminiy jami ${formatAmount(r.total)} so'm)` : ''}. O'sha so'rovdagi mahsulotlar:\n${lines.join('\n')}\n`
    + `Katalogdagi mahsulotlarni calculate_quote bilan BUGUNGI narxda hisobla va natijani qisqa ayt; narx o'zgargan bo'lsa (o'shanda va hozir), buni ayt; katalogda yo'q mahsulotni ochiq ayt. `
    + `So'ng "Shu bilan so'rov yuboraymi yoki miqdorni o'zgartiramizmi?" deb so'ra. Mijoz rozi bo'lsa, saqlangan ma'lumotlari bilan create_request ni chaqir.`;
}
