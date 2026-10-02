// What became of the requests Malika collected. Requests handed over to paketshop.uz are worked on in the site CRM:
// refreshCrmStatuses() copies the managers' status onto the request row (orders.crm_status), so the admin statistics,
// the weekly report and the morning reminder agree with the CRM. Requests that never reached the site keep the status
// set in the assistant's own admin (pending / processing / delivered / cancelled), counted as the same five outcomes.

import type { Sql } from './db.js';
import { fetchLeadStatuses, type SiteLeadStatus } from './siteBridge.js';
import { formatAmount } from './numberGuard.js';
import { SHOP, tashkentNow } from './shopInfo.js';

type Fetch = typeof fetch;

export const OUTCOMES = ['NEW', 'CONTACTED', 'IN_PROGRESS', 'WON', 'LOST'] as const;
export type Outcome = (typeof OUTCOMES)[number];

// Worded as on the site's "Leadlar" page
export const OUTCOME_LABELS: Record<Outcome, string> = {
  NEW: 'Yangi', CONTACTED: "Bog'lanildi", IN_PROGRESS: 'Jarayonda', WON: 'Yutildi', LOST: "Yo'qotildi",
};

const REFRESH_DAYS = 60;

// Reads the CRM status of recent handed-over requests (newest first, at most 200) and stores it on their rows.
// `read` is 0 while `handedOver` is not when the site could not be asked: the stored statuses are then the last known.
export async function refreshCrmStatuses(db: Sql, opts: { fetch?: Fetch } = {}): Promise<{ handedOver: number; read: number }> {
  const rows = await db`
    SELECT id, site_lead_id FROM orders
    WHERE site_lead_id IS NOT NULL AND created_at > now() - make_interval(days => ${REFRESH_DAYS})
    ORDER BY created_at DESC LIMIT 200`;
  if (!rows.length) return { handedOver: 0, read: 0 };
  const statuses = await fetchLeadStatuses(rows.map((row: any) => String(row.site_lead_id)), opts);
  const read = rows.flatMap((row: any) => {
    const lead = statuses.get(String(row.site_lead_id));
    return lead ? [{ id: row.id, status: lead.status, updated_at: lead.updatedAt, lost_reason: lead.lostReason }] : [];
  });
  if (read.length) {
    await db`
      UPDATE orders AS o
      SET crm_status = v.status, crm_updated_at = v.updated_at, crm_lost_reason = v.lost_reason, crm_checked_at = now()
      FROM jsonb_to_recordset(${JSON.stringify(read)}::jsonb) AS v(id integer, status text, updated_at timestamptz, lost_reason text)
      WHERE o.id = v.id`;
  }
  return { handedOver: rows.length, read: read.length };
}

// Stores one status read elsewhere (check_order_status asks the site about a single request). Never throws.
export async function storeCrmStatus(db: Sql, orderId: number, lead: SiteLeadStatus): Promise<void> {
  try {
    await db`UPDATE orders
             SET crm_status = ${lead.status}, crm_updated_at = ${lead.updatedAt}, crm_lost_reason = ${lead.lostReason}, crm_checked_at = now()
             WHERE id = ${orderId}`;
  } catch (err) {
    console.warn('Storing the CRM status failed:', String((err as any)?.message || err));
  }
}

export type OutcomeSummary = {
  days: number;
  total: number;
  estimate: number;
  byStatus: Array<{ status: Outcome; count: number; estimate: number }>;   // all five, in OUTCOMES order
};

// Requests of the last `days` days by outcome, with their estimated value (calculate_quote totals)
export async function outcomeSummary(db: Sql, days = 30): Promise<OutcomeSummary> {
  const rows = await db`
    SELECT
      CASE
        WHEN crm_status IS NOT NULL THEN crm_status
        WHEN status = 'processing' THEN 'IN_PROGRESS'
        WHEN status = 'delivered' THEN 'WON'
        WHEN status = 'cancelled' THEN 'LOST'
        ELSE 'NEW'
      END AS outcome,
      COUNT(*)::int AS count,
      COALESCE(SUM(total_price), 0)::numeric AS estimate
    FROM orders
    WHERE created_at > now() - make_interval(days => ${days})
    GROUP BY 1`;
  const byStatus = OUTCOMES.map(status => {
    const row: any = rows.find((r: any) => r.outcome === status);
    return { status, count: Number(row?.count ?? 0), estimate: Number(row?.estimate ?? 0) };
  });
  return {
    days,
    total: byStatus.reduce((n, r) => n + r.count, 0),
    estimate: byStatus.reduce((n, r) => n + r.estimate, 0),
    byStatus,
  };
}

// "Yangi: 3 · Bog'lanildi: 1 · Yutildi: 2 (5 400 000 so'm)" — empty when there were no requests
export function outcomeLine(summary: OutcomeSummary): string {
  return summary.byStatus
    .filter(row => row.count > 0)
    .map(row => `${OUTCOME_LABELS[row.status]}: ${row.count}${row.status === 'WON' && row.estimate > 0 ? ` (${formatAmount(row.estimate)} so'm)` : ''}`)
    .join(' · ');
}

export type WaitingRequest = {
  id: number;
  customer_name: string;
  customer_phone: string;
  total_price: number | string;
  created_at: Date | string;
  on_site: boolean;
};

const WAITING_HOURS = 12;   // at the 08:00 run: everything that came in before 20:00 (closing time) the day before

// Requests nobody has taken up: still "new" more than WAITING_HOURS after they came in. Requests older than a week are
// left out, so the reminder stops repeating them. A handed-over request counts only when the CRM was read in the last
// day, so a site outage cannot raise false alarms.
export async function waitingRequests(db: Sql): Promise<WaitingRequest[]> {
  const rows = await db`
    SELECT id, customer_name, customer_phone, total_price, created_at, (site_lead_id IS NOT NULL) AS on_site
    FROM orders
    WHERE created_at < now() - make_interval(hours => ${WAITING_HOURS})
      AND created_at > now() - interval '7 days'
      AND ((site_lead_id IS NOT NULL AND crm_status = 'NEW' AND crm_checked_at > now() - interval '1 day')
        OR (site_lead_id IS NULL AND status = 'pending'))
    ORDER BY created_at
    LIMIT 50`;
  return rows as unknown as WaitingRequest[];
}

const pad = (n: number) => String(n).padStart(2, '0');

function tashkentParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

const tashkentDay = (date: Date) => {
  const t = tashkentParts(date);
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
};

// "01.10 14:25" in Tashkent time
function stamp(value: Date | string): string {
  const t = tashkentParts(new Date(value));
  return `${pad(t.day)}.${pad(t.month)} ${pad(t.hour)}:${pad(t.minute)}`;
}

const SHOWN = 15;

export function reminderText(waiting: WaitingRequest[]): string {
  const lines = waiting.slice(0, SHOWN).map(r => {
    const total = Number(r.total_price);
    const sum = total > 0 ? `${formatAmount(total)} so'm` : 'narxi aniqlanadi';
    return `#${r.id} · ${r.customer_name} · ${r.customer_phone} · ${sum} · ${stamp(r.created_at)}${r.on_site ? '' : ' · saytga yetmagan'}`;
  });
  return [
    `⏰ Javob kutayotgan so'rovlar: ${waiting.length} ta`,
    "Kecha yoki undan oldin kelgan, lekin hali «Yangi» holatida. Mijozga bog'laning:",
    '',
    ...lines,
    ...(waiting.length > SHOWN ? [`… yana ${waiting.length - SHOWN} ta`] : []),
    '',
    `Bog'langach, holatini saytdagi «Leadlar» bo'limida o'zgartiring: ${SHOP.site}/uz/admin`,
    ...(waiting.some(r => !r.on_site) ? ["«Saytga yetmagan» so'rovlar faqat yordamchining admin panelida (Buyurtmalar)."] : []),
  ].join('\n').slice(0, 4000);
}

const REMINDER_KEY = 'lead_reminder_day';

// Morning reminder for the managers, called by the daily cron (08:00 Tashkent) after refreshCrmStatuses: requests that
// came in yesterday or earlier and are still "new". At most once a day, not on Sundays (day off), silent when there is
// nothing to remind. LEAD_REMINDER=off turns it off. Returns how many requests were listed.
export async function maybeSendLeadReminder(db: Sql, send: (text: string) => Promise<void>, now = new Date()): Promise<number> {
  if (process.env.LEAD_REMINDER === 'off' || tashkentNow(now).isSunday) return 0;
  const day = tashkentDay(now);
  const rows = await db`SELECT value FROM app_settings WHERE key = ${REMINDER_KEY}`;
  if (rows[0]?.value === day) return 0;
  const waiting = await waitingRequests(db);
  if (!waiting.length) return 0;
  await send(reminderText(waiting));
  await db`INSERT INTO app_settings (key, value, updated_at) VALUES (${REMINDER_KEY}, ${day}, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`;
  return waiting.length;
}
