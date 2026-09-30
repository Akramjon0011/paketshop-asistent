// Sends new-request notifications to the managers on Telegram.
// Set ADMIN_TELEGRAM_ID (comma-separated for several people) — a manager can get the number by sending /id to the bot.

export type RequestLine = {
  sku?: string | null;
  name: string;
  packs: number;
  unit: string;
  pieces?: number | null;
  price_per_pack: number | null;
  line_total: number | null;
};

export type RequestNotice = {
  requestId: number | string;
  customerName: string;
  customerPhone: string;
  region: string;
  company?: string;
  notes?: string;
  lines: RequestLine[];
  total: number;
  pricedAll: boolean;
  source: string;
};

const formatPrice = (n: number | string) => Number(n).toLocaleString('en-US').replace(/,/g, ' ');

export function adminChatIds(): string[] {
  return (process.env.ADMIN_TELEGRAM_ID || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function buildRequestMessage(o: RequestNotice): string {
  const currency = process.env.CURRENCY || "so'm";
  const lines = o.lines.map(l => {
    const qty = `${l.packs} ${l.unit}${l.pieces ? ` (${formatPrice(l.pieces)} dona)` : ''}`;
    const sum = l.line_total !== null ? ` = ${formatPrice(l.line_total)} ${currency}` : ' — narxi aniqlanadi';
    return `• ${l.name}${l.sku ? ` [${l.sku}]` : ''} — ${qty}${sum}`;
  });
  return [
    `📥 Yangi so'rov #${o.requestId}`,
    '',
    `👤 ${o.customerName}${o.company ? ` (${o.company})` : ''}`,
    `📞 ${o.customerPhone}`,
    `📍 ${o.region}`,
    '',
    ...lines,
    '',
    `💰 Taxminiy jami: ${formatPrice(o.total)} ${currency}${o.pricedAll ? '' : ' (narxsiz mahsulotlarsiz)'}`,
    ...(o.notes ? [`📝 ${o.notes}`] : []),
    `📲 Manba: ${o.source}`,
    '',
    "Qoldiq va yakuniy narxni tasdiqlab, mijozga bog'laning.",
  ].join('\n').slice(0, 4000);
}

export async function sendToAdmins(text: string, withAdminButton = true): Promise<void> {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = adminChatIds();
    if (!token || chatIds.length === 0) return;

    const appUrl = process.env.APP_URL;
    const reply_markup = withAdminButton && appUrl?.startsWith('https://')
      ? { inline_keyboard: [[{ text: '📋 Admin panel', url: new URL('admin', appUrl).toString() }]] }
      : undefined;

    await Promise.all(chatIds.map(async (chat_id) => {
      try {
        // Plain text (no parse_mode): customer-supplied fields can't break the formatting
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(4000),
          body: JSON.stringify({ chat_id, text, reply_markup })
        });
        if (!res.ok) console.warn(`Notification to ${chat_id} failed: ${res.status} ${(await res.text()).slice(0, 150)}`);
      } catch (err) {
        console.warn(`Notification to ${chat_id} failed:`, String((err as any)?.message || err));
      }
    }));
  } catch (err) {
    console.warn('Notification error:', String((err as any)?.message || err));
  }
}

// Never throws: a failed notification must not break request creation.
export async function notifyNewRequest(request: RequestNotice): Promise<void> {
  await sendToAdmins(buildRequestMessage(request));
}
