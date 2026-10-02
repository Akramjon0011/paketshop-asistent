// The admin's "Suhbatlar" page: who talked to Malika, about what, and how each answer was produced. Every message is a
// conversation_history row; a conversation is all rows of one Telegram user or one web session. Answers carry `meta`
// (model, time, tools, requests created, amounts the number guard questioned, unanswered topics), customer messages
// the name / voice / photo marks. Admin only.

import type { Sql } from './db.js';

export type ConversationChannel = 'telegram' | 'web' | 'site';
const CHANNELS: ConversationChannel[] = ['telegram', 'web', 'site'];
const FLAGS = ['request', 'gap', 'check', 'fallback'] as const;

export type ConversationSummary = {
  key: string;                 // "tg:<telegram id>" | "web:<session id>"
  channel: ConversationChannel;
  name: string | null;
  phone: string | null;
  messages: number;
  first_at: string;
  last_at: string;
  last_question: string | null;
  requests: number[];          // requests created in the conversation
  gaps: number;                // answers with an unanswered topic
  checks: number;              // answers whose amounts the number guard questioned
  fallbacks: number;           // answers given by a backup model
};

// tg:<digits> or web:<session id> (Mini App ids, "site_<id>" from paketshop.uz)
const KEY = /^(?:tg:\d{1,20}|web:[A-Za-z0-9_-]{1,100})$/;
export const isConversationKey = (key: string) => KEY.test(key);

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

// LIKE pattern for a literal search text
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;

const requestIds = (lists: unknown): number[] => {
  const ids = new Set<number>();
  for (const list of Array.isArray(lists) ? lists : []) {
    for (const id of Array.isArray(list) ? list : []) if (Number.isInteger(id)) ids.add(id);
  }
  return [...ids].sort((a, b) => b - a);
};

export async function listConversations(
  db: Sql,
  opts: { days?: unknown; channel?: unknown; flag?: unknown; q?: unknown; limit?: unknown } = {},
): Promise<ConversationSummary[]> {
  const days = clamp(opts.days, 1, 365, 30);
  const limit = clamp(opts.limit, 1, 200, 60);
  const channel = CHANNELS.includes(opts.channel as ConversationChannel) ? String(opts.channel) : null;
  const flag = (FLAGS as readonly string[]).includes(String(opts.flag)) ? String(opts.flag) : null;
  const q = typeof opts.q === 'string' && opts.q.trim() ? likePattern(opts.q.trim().slice(0, 100)) : null;

  const rows = await db`
    WITH msgs AS (
      SELECT id, telegram_id, web_session_id, role, content, meta, created_at,
             CASE WHEN telegram_id IS NOT NULL THEN 'tg:' || telegram_id::text ELSE 'web:' || web_session_id END AS key,
             CASE WHEN telegram_id IS NOT NULL THEN 'telegram' WHEN left(web_session_id, 5) = 'site_' THEN 'site' ELSE 'web' END AS channel
      FROM conversation_history
      WHERE created_at > now() - make_interval(days => ${days})
        AND (telegram_id IS NOT NULL OR web_session_id IS NOT NULL)
    ),
    convs AS (
      SELECT key, MIN(channel) AS channel, MIN(telegram_id) AS telegram_id, MIN(web_session_id) AS web_session_id,
             COUNT(*)::int AS messages, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
             (array_agg(content ORDER BY id DESC) FILTER (WHERE role = 'user'))[1] AS last_question,
             (array_agg(meta->>'name' ORDER BY id DESC) FILTER (WHERE meta->>'name' IS NOT NULL))[1] AS meta_name,
             jsonb_agg(meta->'requests') FILTER (WHERE meta ? 'requests') AS request_lists,
             COUNT(*) FILTER (WHERE meta ? 'gaps')::int AS gaps,
             COUNT(*) FILTER (WHERE meta ? 'corrected' OR meta ? 'unverified')::int AS checks,
             COUNT(*) FILTER (WHERE meta->>'fallback' = 'true')::int AS fallbacks,
             bool_or(content ILIKE COALESCE(${q}::text, '')) AS matches
      FROM msgs
      GROUP BY key
    )
    SELECT c.key, c.channel, c.messages, c.first_at, c.last_at, c.last_question, c.request_lists, c.gaps, c.checks, c.fallbacks,
           COALESCE(ct.name, cw.name, c.meta_name) AS name, COALESCE(ct.phone, cw.phone) AS phone
    FROM convs c
    LEFT JOIN customers ct ON ct.telegram_id = c.telegram_id
    LEFT JOIN customers cw ON cw.web_session_id = c.web_session_id
    WHERE (${channel}::text IS NULL OR c.channel = ${channel}::text)
      AND (${q}::text IS NULL OR c.matches)
      AND (${flag}::text IS NULL
        OR (${flag}::text = 'request' AND c.request_lists IS NOT NULL)
        OR (${flag}::text = 'gap' AND c.gaps > 0)
        OR (${flag}::text = 'check' AND c.checks > 0)
        OR (${flag}::text = 'fallback' AND c.fallbacks > 0))
    ORDER BY c.last_at DESC
    LIMIT ${limit}`;

  return rows.map((row: any) => ({
    key: row.key,
    channel: row.channel,
    name: row.name ?? null,
    phone: row.phone ?? null,
    messages: Number(row.messages),
    first_at: row.first_at,
    last_at: row.last_at,
    last_question: row.last_question ? String(row.last_question).slice(0, 160) : null,
    requests: requestIds(row.request_lists),
    gaps: Number(row.gaps),
    checks: Number(row.checks),
    fallbacks: Number(row.fallbacks),
  }));
}

export type ConversationDetail = {
  key: string;
  channel: ConversationChannel;
  customer: { name: string | null; phone: string | null; address: string | null } | null;
  summary: string | null;
  messages: Array<{ id: number; role: 'user' | 'model'; content: string; meta: Record<string, any> | null; created_at: string }>;
  requests: Array<{ id: number; total_price: number; status: string; crm_status: string | null; on_site: boolean; created_at: string }>;
};

const MAX_MESSAGES = 300;

export async function conversationDetail(db: Sql, key: string): Promise<ConversationDetail | null> {
  if (!isConversationKey(key)) return null;
  const tg = key.startsWith('tg:') ? key.slice(3) : null;
  const web = key.startsWith('web:') ? key.slice(4) : null;

  const [messages, customers, summaries] = await Promise.all([
    db`SELECT id, role, content, meta, created_at FROM conversation_history
       WHERE (${tg}::bigint IS NOT NULL AND telegram_id = ${tg}::bigint) OR (${web}::text IS NOT NULL AND web_session_id = ${web}::text)
       ORDER BY id DESC LIMIT ${MAX_MESSAGES}`,
    db`SELECT name, phone, address FROM customers
       WHERE (${tg}::bigint IS NOT NULL AND telegram_id = ${tg}::bigint) OR (${web}::text IS NOT NULL AND web_session_id = ${web}::text)
       LIMIT 1`,
    db`SELECT summary FROM conversation_summary
       WHERE (${tg}::bigint IS NOT NULL AND telegram_id = ${tg}::bigint) OR (${web}::text IS NOT NULL AND web_session_id = ${web}::text)
       LIMIT 1`,
  ]);
  if (!messages.length) return null;

  // Requests created in this conversation, plus the customer's other requests (same phone)
  const created = requestIds(messages.map((m: any) => m.meta?.requests));
  const phone = customers[0]?.phone ?? null;
  const requests = created.length || phone
    ? await db`SELECT id, total_price, status, crm_status, (site_lead_id IS NOT NULL) AS on_site, created_at FROM orders
               WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(created)}::jsonb)::int)
                  OR (${phone}::text IS NOT NULL AND customer_phone = ${phone}::text)
               ORDER BY id DESC LIMIT 20`
    : [];

  return {
    key,
    channel: tg ? 'telegram' : web!.startsWith('site_') ? 'site' : 'web',
    customer: customers[0] ? { name: customers[0].name ?? null, phone: customers[0].phone ?? null, address: customers[0].address ?? null } : null,
    summary: summaries[0]?.summary ?? null,
    messages: messages.reverse().map((m: any) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta ?? null, created_at: m.created_at })),
    requests: requests.map((r: any) => ({
      id: r.id, total_price: Number(r.total_price), status: r.status, crm_status: r.crm_status ?? null, on_site: !!r.on_site, created_at: r.created_at,
    })),
  };
}
