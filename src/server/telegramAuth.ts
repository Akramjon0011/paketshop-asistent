// Telegram Mini App launch data (window.Telegram.WebApp.initData) is signed with the bot token, so the server can
// trust the Telegram account it names: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

import { createHmac, timingSafeEqual } from 'crypto';

export type TelegramWebAppUser = { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string };

const MAX_AGE_SEC = 24 * 3600;   // a Mini App can stay open for a while; older launch data is not accepted

export function verifyInitData(
  initData: unknown,
  botToken = process.env.TELEGRAM_BOT_TOKEN,
  now = Date.now(),
): TelegramWebAppUser | null {
  if (typeof initData !== 'string' || !initData || initData.length > 4096 || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  if (!/^[a-f0-9]{64}$/i.test(hash)) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > MAX_AGE_SEC) return null;
  try {
    const user = JSON.parse(params.get('user') ?? 'null');
    return Number.isSafeInteger(user?.id) && user.id > 0 ? user : null;
  } catch {
    return null;
  }
}
