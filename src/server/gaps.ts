// "What did customers ask that the assistant could not answer?" Collected from conversations so the shop can add the
// missing products or information to paketshop.uz (the next sync then teaches the assistant). Two signals:
//  - product: a catalogue search found nothing (deterministic),
//  - info:    the model ended its answer with [BILMADIM: topic] (the tag is removed before anyone sees the answer).

import type { Sql } from './db.js';

export type GapKind = 'product' | 'info';
export type Gap = { kind: GapKind; topic: string };
export type GapChannel = 'telegram' | 'web' | 'site' | 'api';

const GAP_TAG = /\[BILMADIM:\s*([^\]]*)\]/gi;

// Removes [BILMADIM: ...] tags from an answer and returns their topics
export function extractGapTags(text: string): { text: string; topics: string[] } {
  const topics: string[] = [];
  const cleaned = text
    .replace(GAP_TAG, (_m, topic: string) => {
      const t = topic.trim();
      if (t) topics.push(t);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, topics };
}

// "[BILMADIM: mahsulot: pitsa qutisi]" is a product the catalogue lacks; any other topic is missing information
export function gapFromTag(topic: string): Gap {
  const product = /^(?:mahsulot|product|товар)\s*[:\-—–]\s*(.+)$/i.exec(topic.trim());
  return product ? { kind: 'product', topic: product[1].trim() } : { kind: 'info', topic: topic.trim() };
}

// Customers sometimes type their phone number into a question: it never goes into the report
export function maskPersonal(text: string): string {
  return text.replace(/\+?\d[\d\s()-]{7,}\d/g, '***').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export const normalizeTopic = (s: string) =>
  s.toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

export function channelOf(ctx?: { telegramId?: number; webSessionId?: string }): GapChannel {
  if (ctx?.telegramId) return 'telegram';
  if (ctx?.webSessionId?.startsWith('site_')) return 'site';
  if (ctx?.webSessionId) return 'web';
  return 'api';
}

export async function recordGaps(db: Sql, gaps: Gap[], question: string, channel: GapChannel): Promise<number> {
  const q = maskPersonal(question);
  if (!q) return 0;
  const seen = new Set<string>();
  let stored = 0;
  for (const gap of gaps) {
    const topic = normalizeTopic(gap.topic);
    const key = `${gap.kind}|${topic}`;
    if (!topic || seen.has(key)) continue;
    seen.add(key);
    // The same question again within minutes (double tap, retry) is one gap
    const dup = await db`SELECT 1 FROM knowledge_gaps WHERE kind = ${gap.kind} AND topic = ${topic} AND question = ${q}
                           AND created_at > now() - interval '10 minutes' LIMIT 1`;
    if (dup.length) continue;
    await db`INSERT INTO knowledge_gaps (kind, topic, question, channel) VALUES (${gap.kind}, ${topic}, ${q}, ${channel})`;
    stored++;
  }
  return stored;
}

export type GapGroup = { kind: GapKind; topic: string; count: number; last_at: string; channels: string[]; questions: string[] };

// Unresolved gaps of the last `days`, most frequent first, with up to three recent questions each
export async function gapGroups(db: Sql, opts: { days?: number; limit?: number } = {}): Promise<GapGroup[]> {
  const days = Math.min(365, Math.max(1, Math.round(opts.days ?? 30)));
  const limit = Math.min(200, Math.max(1, Math.round(opts.limit ?? 50)));
  const rows = await db`
    SELECT kind, topic, COUNT(*)::int AS count, MAX(created_at) AS last_at,
           ARRAY_AGG(DISTINCT channel) AS channels,
           (ARRAY_AGG(question ORDER BY created_at DESC))[1:3] AS questions
    FROM knowledge_gaps
    WHERE NOT resolved AND created_at > now() - ${days}::int * interval '1 day'
    GROUP BY kind, topic
    ORDER BY count DESC, last_at DESC
    LIMIT ${limit}`;
  return rows.map((r: any) => ({
    kind: r.kind,
    topic: r.topic,
    count: Number(r.count),
    last_at: new Date(r.last_at).toISOString(),
    channels: (r.channels ?? []).filter(Boolean),
    questions: r.questions ?? [],
  }));
}

export async function resolveGap(db: Sql, kind: string, topic: string): Promise<number> {
  const rows = await db`UPDATE knowledge_gaps SET resolved = TRUE WHERE kind = ${kind} AND topic = ${topic} AND NOT resolved RETURNING id`;
  return rows.length;
}

const KIND_ICON: Record<string, string> = { product: '📦', info: 'ℹ️' };

export function formatGapList(groups: GapGroup[], max = 10): string[] {
  return groups.slice(0, max).map(g => `• ${KIND_ICON[g.kind] ?? '•'} ${g.topic} — ${g.count} marta`);
}

export async function weeklyDigestText(db: Sql): Promise<string> {
  const [groups, stats] = await Promise.all([
    gapGroups(db, { days: 7, limit: 10 }),
    db`SELECT
         (SELECT COUNT(DISTINCT COALESCE(telegram_id::text, web_session_id))::int FROM conversation_history
           WHERE created_at > now() - interval '7 days') AS chats,
         (SELECT COUNT(*)::int FROM orders WHERE created_at > now() - interval '7 days') AS requests`,
  ]);
  const s: any = stats[0] ?? {};
  const lines = ['📊 Haftalik hisobot (oxirgi 7 kun)', `Suhbatlar: ${Number(s.chats) || 0} · So'rovlar: ${Number(s.requests) || 0}`, ''];
  if (!groups.length) {
    lines.push("Javobsiz savollar yo'q: yordamchi hamma savolga javob topdi. 👍");
  } else {
    lines.push(`❓ Javobsiz savollar (${groups.reduce((n, g) => n + g.count, 0)} ta):`, ...formatGapList(groups), '',
      "📦 katalogda topilmagan mahsulot, ℹ️ yetishmagan ma'lumot. Saytga qo'shilsa, yordamchi keyingi sinxronlashdan keyin o'zi biladi.",
      "Batafsil: admin panel → Javobsiz savollar yoki /gaps.");
  }
  return lines.join('\n').slice(0, 3800);
}

const DIGEST_KEY = 'gap_digest_at';
const WEEK_MS = 7 * 24 * 3600 * 1000;

// Called by the daily cron: sends the report once a week. The first call only starts the weekly rhythm.
export async function maybeSendWeeklyDigest(db: Sql, send: (text: string) => Promise<void>, now = Date.now()): Promise<boolean> {
  const rows = await db`SELECT value FROM app_settings WHERE key = ${DIGEST_KEY}`;
  const last = Number(rows[0]?.value ?? 0);
  const remember = () => db`INSERT INTO app_settings (key, value, updated_at) VALUES (${DIGEST_KEY}, ${String(now)}, CURRENT_TIMESTAMP)
                             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`;
  if (!last) {
    await remember();
    return false;
  }
  if (now - last < WEEK_MS - 3 * 3600 * 1000) return false;   // a few hours of slack: the cron does not fire at the same second
  await send(await weeklyDigestText(db));
  await remember();
  return true;
}
