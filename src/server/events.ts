import { sql } from './db.js';

// A tiny ring buffer of recent events kept in the database, so problems that are otherwise only in serverless logs
// (bot errors, Gemini quota / timeouts, catalog syncs) can be read at /api/telegram-status.
export async function recordEvent(kind: string, detail?: string, key = 'telegram_events'): Promise<void> {
  if (!sql) return;
  try {
    const rows = await sql`SELECT value FROM app_settings WHERE key = ${key}`;
    let events: any[] = [];
    try { events = JSON.parse(rows[0]?.value || '[]'); } catch { /* start fresh */ }
    events.unshift({ at: new Date().toISOString(), kind, detail: detail?.slice(0, 240) });
    const value = JSON.stringify(events.slice(0, 8));
    await sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${key}, ${value}, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
    `;
  } catch { /* diagnostics must never break the app */ }
}

export async function readEvents(key = 'telegram_events'): Promise<any[]> {
  if (!sql) return [];
  try {
    const rows = await sql`SELECT value FROM app_settings WHERE key = ${key}`;
    return JSON.parse(rows[0]?.value || '[]');
  } catch {
    return [];
  }
}
