import { Telegraf, Markup } from "telegraf";
import { handleConversationalChat, generateSpeech, transcribeAudio, generateEmbeddingsBatch, BRAND, type ChatUserContext } from './ai.js';
import { sql, initDb } from './db.js';
import { adminChatIds } from './notify.js';
import { recordEvent as recordBotEvent, readEvents } from './events.js';
import { planCatalogSync, applyCatalogSync, type SyncPlan } from './catalog.js';
import { formatGapList, gapGroups } from './gaps.js';
import { examSummary, runExam, saveExam } from './exam.js';
import { Mp3Encoder } from '@breezystack/lamejs';
import { createHash } from 'crypto';
import { normalizeUzbekPhone } from './siteBridge.js';
import { SHOP } from './shopInfo.js';
import { customerRequests, formatMyRequests, repeatableRequest } from './myRequests.js';

// Helper to wrap raw 24kHz 16-bit Mono PCM in a standard WAV container for Telegram playback
function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  
  // "RIFF"
  header.write("RIFF", 0);
  // File size - 8
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  // "WAVE"
  header.write("WAVE", 8);
  // "fmt "
  header.write("fmt ", 12);
  // Subchunk1Size (16 for PCM)
  header.writeUInt32LE(16, 16);
  // AudioFormat (1 for PCM)
  header.writeUInt16LE(1, 20);
  // NumChannels
  header.writeUInt16LE(numChannels, 22);
  // SampleRate
  header.writeUInt32LE(sampleRate, 24);
  // ByteRate = SampleRate * NumChannels * BitsPerSample/8
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  // BlockAlign = NumChannels * BitsPerSample/8
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  // BitsPerSample
  header.writeUInt16LE(bitsPerSample, 34);
  // "data"
  header.write("data", 36);
  // Subchunk2Size (data size)
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

// Encode raw 24kHz 16-bit mono PCM to MP3 in pure JS. Telegram plays an MP3 sent via sendVoice as a voice message,
// and there is no ffmpeg binary on Vercel.
function pcmToMp3(pcmBuffer: Buffer, sampleRate = 24000, kbps = 48): Buffer {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  // slice() copies, which also guarantees the 2-byte alignment Int16Array needs
  const samples = new Int16Array(pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + sampleCount * 2));
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const chunks: Buffer[] = [];
  const push = (out: Int8Array | Uint8Array) => {
    if (out.length) chunks.push(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  };
  const blockSize = 1152 * 8;
  for (let i = 0; i < samples.length; i += blockSize) {
    push(encoder.encodeBuffer(samples.subarray(i, i + blockSize)));
  }
  push(encoder.flush());
  return Buffer.concat(chunks);
}

// Telegraf errors embed the request payload (including the webhook secret) — log only the description
function describeErr(err: any): string {
  return err?.response?.description ? `${err.response.error_code} ${err.response.description}` : String(err?.message || err);
}

// Fixed bot texts follow the customer's Telegram language. The assistant's own answers follow the language the
// customer writes in, so the greeting also says, in the other language, that both languages are fine.
type BotLang = 'uz' | 'ru';
const RUSSIAN_SPEAKING = ['ru', 'be', 'uk', 'kk', 'ky', 'tg'];
const langOf = (code?: string): BotLang =>
  RUSSIAN_SPEAKING.some(prefix => (code ?? '').toLowerCase().startsWith(prefix)) ? 'ru' : 'uz';
// Language of an answer: more Cyrillic than Latin letters means Russian
const textLang = (text: string): BotLang =>
  (text.match(/[а-яё]/gi)?.length ?? 0) > (text.match(/[a-z]/gi)?.length ?? 0) ? 'ru' : 'uz';
const ruPage = (url: string) => url.replace(/^(https:\/\/[^/]+)\/uz(?=\/|$)/, '$1/ru');

const BOT_TEXT = {
  uz: {
    welcome: () => `Assalomu alaykum! Men ${BRAND.assistantName}, PaketShop.uz yordamchisiman. Bir martalik idish va qadoqlash materiallari bo'yicha mos mahsulot tanlashda va narxni hisoblashda yordam beraman. Qanday mahsulot kerak?\n\nПишите по-русски — отвечу по-русски.`,
    openApp: '💬 Yordamchini ochish',
    openAppHint: 'Yordamchini ochish uchun quyidagi tugmani bosing:',
    reset: 'Suhbat tarixi tozalandi. Yangidan boshlaymiz!',
    youSaid: (text: string) => `🎙️ Siz: "${text}"`,
    voiceFailed: "Kechirasiz, ovozli xabarni eshita olmadim. Iltimos, qayta yozib ko'ring yoki matn yuboring.",
    imageTooBig: 'Rasm juda katta. Iltimos, kichikroq rasm yuboring.',
    photoQuestion: "Mijoz mahsulot rasmini yubordi. Katalogda shunga o'xshash mahsulot bormi?",
    error: "Uzur, texnik xatolik yuz berdi. Iltimos qaytadan urinib ko'ring.",
    openOnSite: "🔗 Saytda ko'rish",
    video: 'Batafsil video: ',
    myRequests: "📋 Mening so'rovlarim",
    repeatButton: (id: number) => `🔁 #${id} ni takrorlash`,
    repeatText: (id: number) => `#${id} so'rovimni takrorlamoqchiman`,
    repeatMissing: "Bu so'rov topilmadi yoki unda takrorlanadigan mahsulot yo'q.",
    shareContact: '📱 Raqamimni yuborish',
    contactPlaceholder: 'Yoki raqamni yozing',
    leaveRequest: "✅ So'rov qoldirish",
    callManager: "📞 Menejer bilan bog'lanish",
    wantRequest: "So'rov qoldirmoqchiman",
    myContact: (phone: string, name: string) => `Mening telefon raqamim: ${phone}${name ? `, ismim: ${name}` : ''}`,
    contactCard: (phone: string, name: string) => `Kontakt: ${[name, phone].filter(Boolean).join(', ')}`,
    contactSaved: (phone: string) => `✅ Raqamingiz saqlandi: ${phone}. So'rov qoldirganingizda qayta so'ramayman.`,
  },
  ru: {
    welcome: () => `Здравствуйте! Я ${BRAND.assistantNameRu}, помощник PaketShop.uz. Помогу подобрать одноразовую посуду и упаковку, рассчитать цену и количество. Какой товар вам нужен?\n\nO'zbekcha yozsangiz, o'zbekcha javob beraman.`,
    openApp: '💬 Открыть помощника',
    openAppHint: 'Нажмите кнопку ниже, чтобы открыть помощника:',
    reset: 'История диалога очищена. Начнём заново!',
    youSaid: (text: string) => `🎙️ Вы: "${text}"`,
    voiceFailed: 'Извините, не удалось разобрать голосовое сообщение. Запишите ещё раз или напишите текстом.',
    imageTooBig: 'Фото слишком большое. Отправьте, пожалуйста, фото поменьше.',
    photoQuestion: 'Клиент прислал фото товара. Есть ли в каталоге похожий товар?',
    error: 'Извините, произошла техническая ошибка. Попробуйте ещё раз.',
    openOnSite: '🔗 Открыть на сайте',
    video: 'Видео: ',
    myRequests: '📋 Мои заявки',
    repeatButton: (id: number) => `🔁 Повторить #${id}`,
    repeatText: (id: number) => `Хочу повторить заявку #${id}`,
    repeatMissing: 'Заявка не найдена или в ней нет товаров для повтора.',
    shareContact: '📱 Отправить мой номер',
    contactPlaceholder: 'Или напишите номер',
    leaveRequest: '✅ Оставить заявку',
    callManager: '📞 Связаться с менеджером',
    wantRequest: 'Хочу оставить заявку',
    myContact: (phone: string, name: string) => `Мой номер телефона: ${phone}${name ? `, меня зовут ${name}` : ''}`,
    contactCard: (phone: string, name: string) => `Контакт: ${[name, phone].filter(Boolean).join(', ')}`,
    contactSaved: (phone: string) => `✅ Номер сохранён: ${phone}. При заявке больше не буду его спрашивать.`,
  },
};

// The "/" command menu: customers see their requests, a new conversation and the app; admins also the management
// commands. Descriptions follow the Telegram language. Registered only when this list (or the admin list) changes.
const CUSTOMER_COMMANDS = {
  uz: [
    { command: 'sorovlarim', description: "Mening so'rovlarim va ularning holati" },
    { command: 'reset', description: 'Yangi suhbat boshlash' },
    { command: 'webapp', description: 'Yordamchi ilovasini ochish' },
  ],
  ru: [
    { command: 'zayavki', description: 'Мои заявки и их статус' },
    { command: 'reset', description: 'Начать новый диалог' },
    { command: 'webapp', description: 'Открыть приложение помощника' },
  ],
};
const ADMIN_COMMANDS = [
  ...CUSTOMER_COMMANDS.uz,
  { command: 'sync', description: 'Katalogni saytdan yangilash (/sync apply)' },
  { command: 'gaps', description: 'Javobsiz savollar' },
  { command: 'exam', description: 'Sifat imtihoni' },
  { command: 'id', description: 'Telegram ID' },
];

async function registerCommands(telegram: Telegraf['telegram']): Promise<void> {
  const admins = adminChatIds();
  const key = createHash('sha256').update(JSON.stringify([CUSTOMER_COMMANDS, ADMIN_COMMANDS, admins])).digest('hex').slice(0, 24);
  if (sql) {
    const cached = await sql`SELECT value FROM app_settings WHERE key = 'telegram_commands'`;
    if (cached[0]?.value === key) return;
  }
  await telegram.setMyCommands(CUSTOMER_COMMANDS.uz);
  for (const code of RUSSIAN_SPEAKING) await telegram.setMyCommands(CUSTOMER_COMMANDS.ru, { language_code: code });
  for (const id of admins) {
    try {
      await telegram.setMyCommands(ADMIN_COMMANDS, { scope: { type: 'chat', chat_id: Number(id) } });
    } catch (err) {
      console.warn(`Admin command menu for ${id} failed (has the admin started the bot?):`, describeErr(err));
    }
  }
  if (sql) {
    await sql`INSERT INTO app_settings (key, value, updated_at) VALUES ('telegram_commands', ${key}, CURRENT_TIMESTAMP)
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`;
  }
}

// The product an answer recommends ([BUYURTMA: id]): its photo and page, so the Telegram reply can show the product.
// Business chats keep plain text messages.
async function recommendedProduct(text: string, businessChat: boolean): Promise<{ image: string | null; url: string | null } | null> {
  const id = /\[BUYURTMA:\s*(\d+)\]/i.exec(text)?.[1];
  if (!id || !sql || businessChat) return null;
  try {
    const rows = await sql`SELECT image_url, url FROM products WHERE id = ${id} AND active`;
    if (!rows[0]) return null;
    const https = (u: unknown) => (typeof u === 'string' && u.startsWith('https://') ? u : null);
    return { image: https(rows[0].image_url), url: https(rows[0].url) };
  } catch (err) {
    console.warn("Recommended product lookup failed:", err);
    return null;
  }
}

// Short human-readable summary of what a catalog sync would do
function describePlan(plan: SyncPlan): string {
  const unpriced = plan.site.products.filter(p => p.price_on_request).length;
  const lines = [
    `📦 paketshop.uz: ${plan.site.products.length} ta mahsulot${unpriced ? ` (${unpriced} tasi narxsiz)` : ''}, ${plan.kbEntries.length} ta ma'lumot bo'limi o'qildi.`,
    `Mahsulotlar manbasi: ${plan.site.productSource === 'api' ? "sayt API'si (aniq ma'lumot)" : "sayt sahifalari (HTML)"}`,
    `Yangi: ${plan.newProducts.length} · O'zgargan: ${plan.changed.length} · O'zgarmagan: ${plan.unchanged}${plan.contentChanged ? ` · Tavsif/rasm o'zgargan: ${plan.contentChanged}` : ''}`,
    `Bilimlar bazasi: ${plan.kbChanged ? `yangilanadi (yangi/o'zgargan ${plan.kbInsert.length}, olib tashlanadi ${plan.kbDelete.length})` : "o'zgarmagan"}${plan.kbMissingEmbeddings ? ` · ${plan.kbMissingEmbeddings} ta bo'lim qidiruvga hali tayyor emas` : ''}${plan.needsWrite ? '' : ' · Qo\'llash kerak emas, hammasi dolzarb.'}`,
  ];
  if (plan.changed.length) lines.push('', "O'zgarishlar:", ...plan.changed.slice(0, 10).map(c => `• ${c.sku}: ${c.changes.join(', ')}`));
  if (plan.deactivate.length) {
    lines.push('', `Yashiriladi (o'chirilmaydi, faqat yordamchiga ko'rinmaydi): ${plan.deactivate.length} ta`,
      ...plan.deactivate.slice(0, 12).map(d => `• ${d.name}`));
    if (plan.firstSync) lines.push("(Birinchi sinxronlash: bazadagi eski namuna mahsulotlar shunday yashiriladi.)");
  }
  if (plan.site.errors.length) lines.push('', `Saytni o'qishda xatolar: ${plan.site.errors.length}`, ...plan.site.errors.slice(0, 3));
  if (plan.problems.length) lines.push('', '⚠️ ' + plan.problems.join('; '));
  return lines.join('\n').slice(0, 3800);
}

export function setupBot(app: any) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || botToken === 'MY_TELEGRAM_BOT_TOKEN') {
    console.warn("TELEGRAM_BOT_TOKEN is missing or invalid. Telegram bot will not be started.");
    return;
  }

  const bot = new Telegraf(botToken);

  // Set the Telegram Web App Chat Menu Button (requires HTTPS)
  const webAppUrl = process.env.APP_URL || "http://localhost:3000";
  if (webAppUrl.startsWith('https://')) {
    try {
      bot.telegram.setChatMenuButton({
        menuButton: {
          type: 'web_app',
          text: "💬 Yordamchi",
          web_app: { url: webAppUrl }
        }
      }).then(() => {
        console.log("✅ Telegram Web App Menu Button set successfully to", webAppUrl);
      }).catch(err => {
        console.warn("⚠️ Failed to set Telegram Web App Menu Button:", err.message || err);
      });
    } catch (menuErr: any) {
      console.warn("⚠️ Failed to set Telegram Web App Menu Button:", menuErr.message || menuErr);
    }
  } else {
    console.log("ℹ️ Telegram Web App Menu Button registration skipped (only HTTPS URLs are allowed by Telegram).");
  }
  
  // Lets the shop owner find the ID to put in ADMIN_TELEGRAM_ID (new-order notifications)
  bot.command('id', async (ctx) => {
    await ctx.reply(`Sizning Telegram ID: ${ctx.from.id}\n\nYangi buyurtma xabarlarini olish uchun shu raqamni ADMIN_TELEGRAM_ID muhit o'zgaruvchisiga yozing.`);
  });

  // Managers only: "/sync" previews what would change, "/sync apply" refreshes products and knowledge from paketshop.uz
  bot.command('sync', async (ctx) => {
    if (!adminChatIds().includes(String(ctx.from.id))) return; // stay silent for everyone else
    const apply = /\bapply\b/i.test((ctx.message as any)?.text ?? '');
    try {
      if (!sql) { await ctx.reply("Ma'lumotlar bazasi ulanmagan."); return; }
      await initDb();
      await ctx.reply(apply ? "Sinxronlash boshlandi (taxminan 30–60 soniya)..." : "paketshop.uz o'qilyapti, hech narsa o'zgartirilmaydi...");
      const plan = await planCatalogSync(sql);
      if (!apply) {
        await ctx.reply(`${describePlan(plan)}

${plan.problems.length ? '' : "Qo'llash uchun: /sync apply"}`.trim());
        return;
      }
      const res = await applyCatalogSync(sql, plan, generateEmbeddingsBatch);
      await recordBotEvent('catalog_synced', JSON.stringify(res));
      await ctx.reply(`✅ Tayyor.
Mahsulotlar: ${res.products} (yangi ${res.added}, o'zgargan ${res.changed}, yashirilgan ${res.deactivated})
Bilimlar bazasi: ${res.knowledge} bo'lim${res.knowledgeUpdated ? ' (yangilandi)' : " (o'zgarmagan edi)"}, qidiruvga tayyor: ${res.embedded}${res.knowledgePending ? `\n⚠️ ${res.knowledgePending} ta yangi bo'lim qidiruvga tayyorlanmadi (Gemini embedding xatosi); eskisi saqlandi. Birozdan keyin /sync apply ni qaytaring.` : ''}`);
    } catch (err: any) {
      console.error("Catalog sync failed:", describeErr(err));
      await recordBotEvent('catalog_sync_failed', describeErr(err));
      await ctx.reply(`Sinxronlashda xatolik: ${describeErr(err).slice(0, 300)}`);
    }
  });

  // Managers only: what customers asked in the last 30 days that the assistant could not answer (what to add to the site)
  bot.command('gaps', async (ctx) => {
    if (!adminChatIds().includes(String(ctx.from.id))) return;
    try {
      if (!sql) { await ctx.reply("Ma'lumotlar bazasi ulanmagan."); return; }
      await initDb();
      const groups = await gapGroups(sql, { days: 30, limit: 15 });
      await ctx.reply(groups.length
        ? ["❓ Javobsiz savollar (oxirgi 30 kun):", ...formatGapList(groups, 15), '',
            "📦 katalogda topilmagan mahsulot, ℹ️ yetishmagan ma'lumot.",
            "Saytga qo'shgach, admin panel → Javobsiz savollar bo'limida \"Hal qilindi\" deb belgilang."].join('\n')
        : "So'nggi 30 kunda javobsiz savollar yo'q. 👍");
    } catch (err: any) {
      await ctx.reply(`Xatolik: ${describeErr(err).slice(0, 200)}`);
    }
  });

  // Managers only: run the quality exam now (typical customer questions, answers checked automatically).
  // Kept under ~50 s so Telegram does not resend the update while it runs.
  bot.command('exam', async (ctx) => {
    if (!adminChatIds().includes(String(ctx.from.id))) return;
    try {
      if (!sql) { await ctx.reply("Ma'lumotlar bazasi ulanmagan."); return; }
      await initDb();
      await ctx.reply("🧪 Sifat imtihoni boshlandi: 20 ta savol, taxminan 1 daqiqa...");
      const report = await runExam(sql, { concurrency: 5, budgetMs: 45_000 });
      await saveExam(sql, report);
      await ctx.reply(examSummary(report, 12));
    } catch (err: any) {
      await ctx.reply(`Imtihonda xatolik: ${describeErr(err).slice(0, 200)}`);
    }
  });

  bot.command('reset', async (ctx) => {
    if (sql) {
      try {
        await sql`DELETE FROM conversation_history WHERE telegram_id = ${ctx.from.id}`;
      } catch (err) {
        console.error("Reset history error:", err);
      }
    }
    await ctx.reply(BOT_TEXT[langOf(ctx.from?.language_code)].reset);
  });

  // The customer's own requests and their status (no phone needed: the Telegram account is the proof). Private chats only.
  const showMyRequests = async (ctx: any) => {
    if (!ctx.from || ctx.chat?.type !== 'private') return;
    const lang = langOf(ctx.from.language_code);
    try {
      if (!sql) throw new Error('Database not connected');
      await initDb();
      const list = await customerRequests(sql, { telegramId: ctx.from.id });
      // "🔁 Repeat" under the most recent requests (Telegram keeps a keyboard short)
      const repeatRows = list.filter(r => r.items.length).slice(0, 5)
        .map(r => [{ text: BOT_TEXT[lang].repeatButton(r.id), callback_data: `repeat:${r.id}` }]);
      await ctx.reply(formatMyRequests(list, lang, { uz: BRAND.assistantName, ru: BRAND.assistantNameRu }),
        repeatRows.length ? { reply_markup: { inline_keyboard: repeatRows } } : {});
    } catch (err) {
      console.error("My requests failed:", err);
      await ctx.reply(BOT_TEXT[lang].error);
    }
  };
  bot.command(['sorovlarim', 'zayavki'], showMyRequests);
  bot.action('myreq', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await showMyRequests(ctx);
  });

  // "🔁 Repeat": Malika prices the same items at today's prices and offers to send the request again
  bot.action(/^repeat:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const message: any = ctx.callbackQuery.message;
    if (!ctx.from || !message || message.chat?.type !== 'private') return;
    const lang = langOf(ctx.from.language_code);
    const id = Number((ctx as any).match?.[1]);
    let repeat = null;
    try {
      if (sql) {
        await initDb();
        repeat = await repeatableRequest(sql, id, { telegramId: ctx.from.id });
      }
    } catch (err) {
      console.error("Repeat lookup failed:", err);
    }
    if (!repeat) {
      await ctx.reply(BOT_TEXT[lang].repeatMissing);
      return;
    }
    await processMessage(ctx, { from: ctx.from, chat: message.chat, text: BOT_TEXT[lang].repeatText(id), repeat }, false);
  });

  const getWebAppButton = (text: string, url: string) => {
    return url.startsWith('https://') 
      ? Markup.button.webApp(text, url)
      : Markup.button.url(text, url);
  };

  bot.command('webapp', async (ctx) => {
    const webAppUrl = process.env.APP_URL || "http://localhost:3000";
    const text = BOT_TEXT[langOf(ctx.from?.language_code)];
    await ctx.reply(text.openAppHint,
      Markup.inlineKeyboard([
        [getWebAppButton(text.openApp, webAppUrl)]
      ])
    );
  });

  bot.start(async (ctx) => {
    const text = BOT_TEXT[langOf(ctx.from?.language_code)];
    const welcomeText = text.welcome();
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    
    // Try sending with inline button, fallback to plain text if Telegram rejects the URL
    try {
      if (appUrl.startsWith('https://')) {
        await ctx.reply(welcomeText, Markup.inlineKeyboard([
          [getWebAppButton(text.openApp, appUrl)],
          [Markup.button.callback(text.myRequests, 'myreq')]
        ]));
      } else {
        // http:// URL — Telegram rejects inline URL buttons for non-HTTPS, send plain text
        await ctx.reply(welcomeText);
      }
    } catch (replyErr: any) {
      console.warn("/start reply with button failed, sending plain text:", replyErr.message);
      await recordBotEvent('start_button_reply_failed', describeErr(replyErr));
      try {
        await ctx.reply(welcomeText);
      } catch (plainErr) {
        console.error("/start plain text reply also failed:", describeErr(plainErr));
        await recordBotEvent('start_reply_failed', describeErr(plainErr));
      }
    }
    // No voice greeting: the assistant answers with voice only when the customer speaks (saves the TTS quota)
  });

  // Unified handler to process incoming text and voice messages, supporting both regular and business chats
  async function processMessage(
    ctx: any, 
    messageObj: any, 
    isVoice: boolean, 
    businessConnectionId?: string,
    isPhoto = false
  ) {
    if (!messageObj || !messageObj.from) return;
    const userId = messageObj.from.id;
    const chatId = messageObj.chat.id;
    const text = BOT_TEXT[langOf(messageObj.from.language_code)];

    // Helper options for Telegram Business context
    const replyOptions = businessConnectionId ? { business_connection_id: businessConnectionId } : {};

    const sendAction = async (action: 'typing' | 'record_voice') => {
      try {
        await ctx.telegram.sendChatAction(chatId, action, replyOptions);
      } catch (e) {
        console.warn("Failed to send chat action:", e);
      }
    };

    try {
      await sendAction('typing');

      let queryText = "";
      let images: { data: string; mimeType: string }[] | undefined;
      if (isVoice) {
        const voice = messageObj.voice;
        console.log(`🎙️ Voice message from ${userId} in chat ${chatId}: file_id=${voice.file_id}`);
        const link = await ctx.telegram.getFileLink(voice.file_id);
        const fileUrl = link.href;

        const fetchRes = await fetch(fileUrl);
        const arrayBuffer = await fetchRes.arrayBuffer();
        const audioBuffer = Buffer.from(arrayBuffer);

        const mimeType = voice.mime_type || 'audio/ogg';
        const transcribedText = await transcribeAudio(audioBuffer, mimeType);

        if (!transcribedText) {
          await ctx.telegram.sendMessage(chatId, text.voiceFailed, replyOptions);
          return;
        }

        console.log(`🎙️ Transcribed voice message: "${transcribedText}"`);
        await ctx.telegram.sendMessage(chatId, text.youSaid(transcribedText), replyOptions);
        queryText = transcribedText;
      } else if (isPhoto) {
        // A photo (or an image sent as a file): let the assistant look at it
        const doc = messageObj.document;
        const fileId = doc ? doc.file_id : messageObj.photo?.[messageObj.photo.length - 1]?.file_id;
        const link = await ctx.telegram.getFileLink(fileId);
        const imgRes = await fetch(link.href, { signal: AbortSignal.timeout(15000) });
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
        if (imgBuffer.length > 6 * 1024 * 1024) {
          await ctx.telegram.sendMessage(chatId, text.imageTooBig, replyOptions);
          return;
        }
        images = [{ data: imgBuffer.toString('base64'), mimeType: doc?.mime_type || 'image/jpeg' }];
        // A photo without a caption: the question is put in the customer's Telegram language, so the answer is too
        queryText = (messageObj.caption || '').trim() || text.photoQuestion;
      } else {
        queryText = messageObj.text || "";
      }

      if (!queryText.trim()) return;

      console.log(`📨 Telegram message from ${userId}: "${queryText}"`);

      // History is loaded/persisted inside handleConversationalChat via userContext
      const from = messageObj.from;
      const displayName = [[from.first_name, from.last_name].filter(Boolean).join(' '), from.username ? `@${from.username}` : '']
        .filter(Boolean).join(' ').trim();
      const chatContext: ChatUserContext = { telegramId: userId, displayName: displayName || undefined, voice: isVoice, contact: !!messageObj.sharedContact, repeat: messageObj.repeat };
      const responseText = await handleConversationalChat(queryText, [], chatContext, undefined, images);

      let finalResponseText = responseText;
      let imageUrls: string[] = [];
      let videoUrls: string[] = [];

      finalResponseText = finalResponseText.replace(/\[IMAGE: (.*?)\]/g, (_match, url) => {
        imageUrls.push(url);
        return "";
      });

      finalResponseText = finalResponseText.replace(/\[VIDEO: (.*?)\]/g, (_match, url) => {
        videoUrls.push(url);
        return "";
      });

      let plainText = finalResponseText
          .replace(/\[BUYURTMA:\s*\d+\]/gi, '')  // Buyurtma taglarni olib tashla
          .replace(/\[laughing\]/gi, "😄")
          .replace(/\[short pause\]/gi, "...")
          .replace(/\[sigh\]/gi, "😌")
          .replace(/\*\*(.+?)\*\*/gs, '$1')   // Telegram text has no markdown: drop **bold** the model sometimes adds
          .replace(/__(.+?)__/gs, '$1')
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

      // Links under the answer speak the answer's language (and open the Russian page for a Russian answer)
      const answerText = BOT_TEXT[textLang(plainText)];
      if (videoUrls.length > 0) {
         plainText += `\n\n${answerText.video}` + videoUrls.join(", ");
      }

      // A recommended product comes with its photo (as the message itself) and a button to its page on paketshop.uz
      const recommended = await recommendedProduct(finalResponseText, !!businessConnectionId);
      const pageUrl = recommended?.url ? (answerText === BOT_TEXT.ru ? ruPage(recommended.url) : recommended.url) : null;

      // Buttons under the answer (private chats; business chats keep plain messages):
      //  - the answer asks for the phone number -> "send my number" (Telegram shares the customer's own number),
      //  - a price was calculated -> "leave a request" / "contact a manager", next to the product page link.
      // A reply keyboard and an inline keyboard cannot share a message, so the number request wins.
      const actions = chatContext.actions;
      const canButtons = !businessConnectionId && messageObj.chat?.type === 'private';
      let buttons: Record<string, unknown> = {};
      if (canButtons && actions?.askContact) {
        buttons = { reply_markup: {
          keyboard: [[{ text: answerText.shareContact, request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
          input_field_placeholder: answerText.contactPlaceholder,
        } };
      } else {
        const rows: any[][] = [];
        if (pageUrl) rows.push([{ text: answerText.openOnSite, url: pageUrl }]);
        if (canButtons && actions?.quote) {
          rows.push([{ text: answerText.leaveRequest, callback_data: 'lead' }, { text: answerText.callManager, url: `https://t.me/${SHOP.telegram.replace(/^@/, '')}` }]);
        }
        // otherwise drop a "send my number" keyboard left from an earlier question
        buttons = rows.length ? { reply_markup: { inline_keyboard: rows } } : canButtons ? { reply_markup: { remove_keyboard: true } } : {};
      }

      // Send response
      if (imageUrls.length > 0) {
         const firstImage = imageUrls[0];
         if (firstImage.startsWith('http') && plainText.length <= 1024) {
            await ctx.telegram.sendPhoto(chatId, firstImage, { ...replyOptions, caption: plainText, ...buttons });
         } else {
            await ctx.telegram.sendMessage(chatId, plainText, { ...replyOptions, ...buttons });
         }
      } else if (recommended?.image && plainText.length <= 1024) {   // Telegram's caption limit
         try {
            await ctx.telegram.sendPhoto(chatId, recommended.image, { ...replyOptions, caption: plainText, ...buttons });
         } catch (photoErr) {
            console.warn("Product photo failed, sending text instead:", describeErr(photoErr));
            await ctx.telegram.sendMessage(chatId, plainText, { ...replyOptions, ...buttons });
         }
      } else {
         await ctx.telegram.sendMessage(chatId, plainText, { ...replyOptions, ...buttons });
      }

      // Voice answer only to a voice message: a typed question gets text (decided with the shop owner, saves the TTS quota)
      if (isVoice) try {
         const speechText = plainText
            .replace(/https?:\/\/[^\s]+/g, '') // remove URLs
            .replace(/[#_*\[\]]/g, '')        // remove styling characters
            .trim();

         if (speechText) {
            await sendAction('record_voice');
            const voiceBase64 = await generateSpeech(speechText);
            if (voiceBase64) {
               const pcmBuffer = Buffer.from(voiceBase64, 'base64');
               try {
                  await ctx.telegram.sendVoice(chatId, { source: pcmToMp3(pcmBuffer), filename: 'voice.mp3' }, replyOptions);
               } catch (voiceSendErr) {
                  console.warn("Voice (MP3) failed, falling back to WAV audio player:", describeErr(voiceSendErr));
                  await recordBotEvent('voice_mp3_failed', describeErr(voiceSendErr));
                  const wavBuffer = pcmToWav(pcmBuffer);
                  await ctx.telegram.sendAudio(chatId, { source: wavBuffer, filename: 'voice.wav' }, {
                     ...replyOptions,
                     title: BRAND.assistantName,
                     performer: BRAND.shopName
                  });
               }
            }
         }
      } catch (voiceErr) {
         console.error("Error sending voice message response to Telegram:", voiceErr);
      }

    } catch (err: any) {
      console.error("Bot error in processMessage:", describeErr(err));
      await recordBotEvent('process_error', describeErr(err));
      try {
        await ctx.telegram.sendMessage(chatId, text.error, replyOptions);
      } catch (sendErr) {
        console.error("Failed to send error message:", sendErr);
      }
    }
  }

  // Bind Standard Chat Handlers
  bot.on('text', async (ctx) => {
    await processMessage(ctx, ctx.message, false);
  });

  bot.on('voice', async (ctx) => {
    await processMessage(ctx, ctx.message, true);
  });

  bot.on('photo', async (ctx) => {
    await processMessage(ctx, ctx.message, false, undefined, true);
  });

  // A phone number shared with the "send my number" button (or a contact card). The customer's own number is saved,
  // so Malika does not ask for it again. If Malika had just asked for it, the conversation continues with it;
  // otherwise (e.g. shared from the Mini App, whose conversation is separate) the number is only confirmed.
  bot.on('contact', async (ctx) => {
    const contact = ctx.message.contact;
    const own = contact.user_id === ctx.from.id;
    const phone = normalizeUzbekPhone(contact.phone_number) ?? `+${String(contact.phone_number).replace(/\D/g, '')}`;
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();
    if (own && sql) {
      try {
        await initDb();
        await sql`INSERT INTO customers (telegram_id, name, phone) VALUES (${ctx.from.id}, ${name || null}, ${phone})
                  ON CONFLICT (telegram_id) DO UPDATE SET phone = EXCLUDED.phone, name = COALESCE(customers.name, EXCLUDED.name)`;
      } catch (err) {
        console.warn("Saving the shared phone number failed:", err);
      }
    }
    let asked = false;
    let lang = langOf(ctx.from.language_code);
    if (sql) {
      try {
        const last = await sql`SELECT content, meta FROM conversation_history WHERE telegram_id = ${ctx.from.id} AND role = 'model' ORDER BY id DESC LIMIT 1`;
        asked = !!last[0]?.meta?.askContact;
        if (last[0]?.content) lang = textLang(String(last[0].content));
      } catch { /* treated as not asked */ }
    }
    const text = BOT_TEXT[lang];
    if (own && !asked) {
      await ctx.reply(text.contactSaved(phone), { reply_markup: { remove_keyboard: true } });
      return;
    }
    await processMessage(ctx, { ...ctx.message, text: own ? text.myContact(phone, name) : text.contactCard(phone, name), sharedContact: own }, false);
  });

  // "✅ So'rov qoldirish" under a quote: continues as if the customer had written it
  bot.action('lead', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const message: any = ctx.callbackQuery.message;
    if (!message || !ctx.from) return;
    // keep the links, drop the button itself (a second tap would start the same request again)
    const rows = (message.reply_markup?.inline_keyboard ?? []).map((row: any[]) => row.filter(b => b.url)).filter((row: any[]) => row.length);
    await ctx.editMessageReplyMarkup(rows.length ? { inline_keyboard: rows } : undefined).catch(() => {});
    const lang = textLang(String(message.text || message.caption || ''));
    await processMessage(ctx, { from: ctx.from, chat: message.chat, text: BOT_TEXT[lang].wantRequest }, false);
  });

  // Images sent "as a file" (uncompressed); other documents are ignored
  bot.on('document', async (ctx) => {
    if (!String(ctx.message.document.mime_type || '').startsWith('image/')) return;
    await processMessage(ctx, ctx.message, false, undefined, true);
  });

  // Bind Telegram Business Chatbot Handlers
  // Cast to any because older Telegraf type defs don't include 'business_message'
  (bot as any).on('business_message', async (ctx: any) => {
    const businessMessage = ctx.update?.business_message;
    if (!businessMessage) return;
    const isVoice = !!businessMessage.voice;
    console.log(`💼 Telegram Business message received: isVoice=${isVoice}, conn_id=${businessMessage.business_connection_id}`);
    await processMessage(ctx, businessMessage, isVoice, businessMessage.business_connection_id);
  });

  bot.catch(async (err: any) => {
    console.error("Bot error:", describeErr(err));
    await recordBotEvent('bot_error', describeErr(err));
  });

  if (process.env.VERCEL) {
      console.log("Running in Vercel Serverless Webhook mode");
      const domain = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
      if (domain) {
          const webhookPath = `/api/telegram`;
          const webhookUrl = `https://${domain}${webhookPath}`;
          
          // Don't pass res to handleUpdate — forces Telegraf to use standard API
          // method for replies, which is more reliable in serverless environments
          const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

          // Diagnostics: what Telegram thinks about our webhook (no secrets in the output)
          let statusMemo: { at: number; body: any } | null = null;
          app.get('/api/telegram-status', async (_req: any, res: any) => {
            const [events, gemini] = await Promise.all([readEvents('telegram_events'), readEvents('gemini_events')]);
            if (statusMemo && Date.now() - statusMemo.at < 15000) return res.json({ ...statusMemo.body, events, gemini });
            try {
              const [me, info] = await Promise.all([bot.telegram.getMe(), bot.telegram.getWebhookInfo()]);
              const body = {
                bot: me.username,
                webhookUrl: info.url,
                expectedUrl: webhookUrl,
                hasSecret: !!webhookSecret,
                pendingUpdates: info.pending_update_count,
                lastErrorDate: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
                lastErrorMessage: info.last_error_message || null
              };
              statusMemo = { at: Date.now(), body };
              res.json({ ...body, events, gemini });
            } catch (err) {
              res.status(500).json({ error: describeErr(err) });
            }
          });
          app.post(webhookPath, async (req: any, res: any) => {
            if (webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
              return res.status(401).json({ ok: false });
            }
            const updateId = req.body?.update_id || 'unknown';
            console.log(`📨 Webhook received update #${updateId}`);
            const updateType = Object.keys(req.body || {}).find(k => k !== 'update_id') || 'unknown';
            try {
              await bot.handleUpdate(req.body);
              console.log(`✅ Update #${updateId} processed`);
              await recordBotEvent('handled', `${updateType} #${updateId}`);
            } catch (err) {
              console.error(`❌ Update #${updateId} error:`, describeErr(err));
              await recordBotEvent('handle_error', `${updateType} #${updateId}: ${describeErr(err)}`);
            }
            res.status(200).json({ ok: true });
          });
          
          // Only call setWebhook if the URL changed (avoid Telegram rate limit on every cold start)
          (async () => {
            try {
              const hookOpts = webhookSecret ? { secret_token: webhookSecret } : undefined;
              if (!sql) {
                await bot.telegram.setWebhook(webhookUrl, hookOpts);
                console.log("✅ Webhook set (no DB cache):", webhookUrl);
                return;
              }
              const cached = await sql`SELECT value FROM app_settings WHERE key = 'telegram_webhook_url'`;
              // Key covers URL, secret and bot token, so rotating either re-registers the webhook
              const cacheKey = createHash('sha256').update(`${webhookUrl}|${webhookSecret || ''}|${botToken}`).digest('hex').slice(0, 24);
              if (cached.length > 0 && cached[0].value === cacheKey) {
                return; // already set, skip API call
              }
              await bot.telegram.setWebhook(webhookUrl, hookOpts);
              await sql`
                INSERT INTO app_settings (key, value, updated_at)
                VALUES ('telegram_webhook_url', ${cacheKey}, CURRENT_TIMESTAMP)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
              `;
              console.log("✅ Vercel Webhook updated to", webhookUrl);
            } catch (err) {
              console.error("❌ Failed to set webhook:", describeErr(err));
            }
          })();
          // The command menu has its own change check (the webhook block above returns early when nothing changed)
          registerCommands(bot.telegram).catch(err => console.error("❌ Failed to set the command menu:", describeErr(err)));
      } else {
          console.error("❌ No Vercel domain found for webhook setup");
      }
  } else {
      bot.launch().catch(err => console.error("Failed to launch bot:", err));
      registerCommands(bot.telegram).catch(err => console.error("Failed to set the command menu:", describeErr(err)));
      console.log("Telegram bot started successfully in polling mode.");
      process.once('SIGINT', () => bot.stop('SIGINT'));
      process.once('SIGTERM', () => bot.stop('SIGTERM'));
  }
}

