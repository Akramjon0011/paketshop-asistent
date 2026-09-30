// Sends new-order notifications to the shop owner(s) on Telegram.
// Set ADMIN_TELEGRAM_ID (comma-separated for several people) — the owner can get the number by sending /id to the bot.

export type OrderNotice = {
  orderId: number | string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number | string;
  source: string;
};

const formatPrice = (n: number | string) => Number(n).toLocaleString('en-US').replace(/,/g, ' ');

export function buildOrderMessage(o: OrderNotice): string {
  const currency = process.env.CURRENCY || "so'm";
  const lines = o.items.map(i => `• ${i.name} × ${i.quantity} = ${formatPrice(i.price * i.quantity)} ${currency}`);
  return [
    `🛒 Yangi buyurtma #${o.orderId}`,
    '',
    `👤 ${o.customerName}`,
    `📞 ${o.customerPhone}`,
    `📍 ${o.deliveryAddress}`,
    '',
    ...lines,
    '',
    `💰 Jami: ${formatPrice(o.total)} ${currency}`,
    `📲 Manba: ${o.source}`
  ].join('\n').slice(0, 4000);
}

// Never throws: a failed notification must not break order creation.
export async function notifyNewOrder(order: OrderNotice): Promise<void> {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = (process.env.ADMIN_TELEGRAM_ID || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!token || chatIds.length === 0) return;

    const text = buildOrderMessage(order);
    const appUrl = process.env.APP_URL;
    const reply_markup = appUrl?.startsWith('https://')
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
        if (!res.ok) console.warn(`Order notification to ${chat_id} failed: ${res.status} ${(await res.text()).slice(0, 150)}`);
      } catch (err) {
        console.warn(`Order notification to ${chat_id} failed:`, String((err as any)?.message || err));
      }
    }));
  } catch (err) {
    console.warn('Order notification error:', String((err as any)?.message || err));
  }
}
