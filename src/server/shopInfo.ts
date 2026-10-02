// Facts about the business the assistant speaks for (source: https://www.paketshop.uz/uz/contact and /delivery).
// Overridable from the environment so a phone number change doesn't need a code change.

export const SHOP = {
  phone: process.env.SHOP_PHONE || '+998 99 644 84 44',
  telegram: process.env.SHOP_TELEGRAM || '@paketshop_uz',
  // whose chat the "📞 Menejer bilan bog'lanish" buttons open (bot and Mini App)
  managerTelegram: process.env.SHOP_MANAGER_TELEGRAM || '@akramjon0011',
  site: process.env.SHOP_SITE || 'https://www.paketshop.uz',
  hoursText: process.env.SHOP_HOURS || 'Dushanba–Shanba 09:00–20:00 (yakshanba dam olish kuni)',
  city: 'Toshkent',
};

export const managerUrl = () => `https://t.me/${SHOP.managerTelegram.replace(/^@/, '').trim()}`;

// Business days/hours in Tashkent time (UTC+5, no DST). Mon–Sat 09:00–20:00.
const TZ = 'Asia/Tashkent';
const OPEN_HOUR = 9;
const CLOSE_HOUR = 20;

export function tashkentNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const isSunday = weekday === 'Sunday';
  const open = !isSunday && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
  return { weekday, hour, minute, open, isSunday, label: `${weekday} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

const UZ_WEEKDAYS: Record<string, string> = {
  Monday: 'dushanba', Tuesday: 'seshanba', Wednesday: 'chorshanba', Thursday: 'payshanba',
  Friday: 'juma', Saturday: 'shanba', Sunday: 'yakshanba',
};

// One line for the system prompt, e.g. "payshanba 18:36 (Toshkent vaqti) — menejerlar hozir ish vaqtida"
export function shopStatusLine(date = new Date()): string {
  const now = tashkentNow(date);
  const day = UZ_WEEKDAYS[now.weekday] ?? now.weekday;
  const time = `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`;
  return `${day} ${time} (Toshkent vaqti) — ${now.open ? 'menejerlar hozir ish vaqtida' : 'hozir ish vaqti emas, menejerlar keyingi ish kunida javob beradi'}`;
}
