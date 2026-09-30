import { Telegraf, Markup } from "telegraf";
import { handleConversationalChat, generateSpeech, transcribeAudio, generateEmbeddingsBatch, BRAND } from './ai.js';
import { sql, initDb } from './db.js';
import { adminChatIds } from './notify.js';
import { recordEvent as recordBotEvent, readEvents } from './events.js';
import { planCatalogSync, applyCatalogSync, type SyncPlan } from './catalog.js';
import { Mp3Encoder } from '@breezystack/lamejs';
import { createHash } from 'crypto';

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

// Short human-readable summary of what a catalog sync would do
function describePlan(plan: SyncPlan): string {
  const unpriced = plan.site.products.filter(p => p.price_on_request).length;
  const lines = [
    `📦 paketshop.uz: ${plan.site.products.length} ta mahsulot${unpriced ? ` (${unpriced} tasi narxsiz)` : ''}, ${plan.kbEntries.length} ta ma'lumot bo'limi o'qildi.`,
    `Yangi: ${plan.newProducts.length} · O'zgargan: ${plan.changed.length} · O'zgarmagan: ${plan.unchanged}${plan.contentChanged ? ` · Tavsif/rasm o'zgargan: ${plan.contentChanged}` : ''}`,
    `Bilimlar bazasi: ${plan.kbChanged ? "yangilanadi" : "o'zgarmagan"}${plan.needsWrite ? '' : ' · Qo\'llash kerak emas, hammasi dolzarb.'}`,
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
Bilimlar bazasi: ${res.knowledge} bo'lim (${res.embedded} tasi qidiruvga tayyor)`);
    } catch (err: any) {
      console.error("Catalog sync failed:", describeErr(err));
      await recordBotEvent('catalog_sync_failed', describeErr(err));
      await ctx.reply(`Sinxronlashda xatolik: ${describeErr(err).slice(0, 300)}`);
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
    await ctx.reply("Suhbat tarixi tozalandi. Yangidan boshlaymiz!");
  });

  const getWebAppButton = (text: string, url: string) => {
    return url.startsWith('https://') 
      ? Markup.button.webApp(text, url)
      : Markup.button.url(text, url);
  };

  bot.command('webapp', async (ctx) => {
    const webAppUrl = process.env.APP_URL || "http://localhost:3000";
    await ctx.reply("Yordamchini ochish uchun quyidagi tugmani bosing:", 
      Markup.inlineKeyboard([
        [getWebAppButton("💬 Yordamchini ochish", webAppUrl)]
      ])
    );
  });

  bot.start(async (ctx) => {
    const welcomeText = `Assalomu alaykum! Men ${BRAND.assistantName}, PaketShop.uz yordamchisiman. Bir martalik idish va qadoqlash materiallari bo'yicha mos mahsulot tanlashda va narxni hisoblashda yordam beraman. Qanday mahsulot kerak?`;
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    
    // Try sending with inline button, fallback to plain text if Telegram rejects the URL
    try {
      if (appUrl.startsWith('https://')) {
        await ctx.reply(welcomeText, Markup.inlineKeyboard([
          [getWebAppButton("\ud83d\uded2 Do'konni ochish", appUrl)]
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
    
    try {
      await ctx.sendChatAction('record_voice');
      const voiceBase64 = await generateSpeech(welcomeText);
      if (voiceBase64) {
         const pcmBuffer = Buffer.from(voiceBase64, 'base64');
         try {
            await ctx.replyWithVoice({ source: pcmToMp3(pcmBuffer), filename: 'welcome.mp3' });
         } catch (voiceSendErr) {
            console.warn("Voice (MP3) failed on start, falling back to WAV audio player:", describeErr(voiceSendErr));
            await recordBotEvent('start_voice_mp3_failed', describeErr(voiceSendErr));
            const wavBuffer = pcmToWav(pcmBuffer);
            await ctx.replyWithAudio({ source: wavBuffer, filename: 'welcome.wav' }, { title: BRAND.assistantName, performer: BRAND.shopName });
         }
      }
    } catch (voiceErr) {
      console.error("Error sending voice message to Telegram on start:", describeErr(voiceErr));
      await recordBotEvent('start_voice_failed', describeErr(voiceErr));
    }
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
          await ctx.telegram.sendMessage(
            chatId, 
            "Kechirasiz, ovozli xabarni eshita olmadim. Iltimos, qayta yozib ko'ring yoki matn yuboring.", 
            replyOptions
          );
          return;
        }

        console.log(`🎙️ Transcribed voice message: "${transcribedText}"`);
        await ctx.telegram.sendMessage(chatId, `🎙️ Siz: "${transcribedText}"`, replyOptions);
        queryText = transcribedText;
      } else if (isPhoto) {
        // A photo (or an image sent as a file): let the assistant look at it
        const doc = messageObj.document;
        const fileId = doc ? doc.file_id : messageObj.photo?.[messageObj.photo.length - 1]?.file_id;
        const link = await ctx.telegram.getFileLink(fileId);
        const imgRes = await fetch(link.href, { signal: AbortSignal.timeout(15000) });
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
        if (imgBuffer.length > 6 * 1024 * 1024) {
          await ctx.telegram.sendMessage(chatId, "Rasm juda katta. Iltimos, kichikroq rasm yuboring.", replyOptions);
          return;
        }
        images = [{ data: imgBuffer.toString('base64'), mimeType: doc?.mime_type || 'image/jpeg' }];
        queryText = (messageObj.caption || '').trim() || "Mijoz mahsulot rasmini yubordi. Katalogda shunga o'xshash mahsulot bormi?";
      } else {
        queryText = messageObj.text || "";
      }

      if (!queryText.trim()) return;

      console.log(`📨 Telegram message from ${userId}: "${queryText}"`);

      // History is loaded/persisted inside handleConversationalChat via userContext
      const responseText = await handleConversationalChat(queryText, [], { telegramId: userId }, undefined, images);

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

      if (videoUrls.length > 0) {
         plainText += "\n\nBatafsil video: " + videoUrls.join(", ");
      }

      // Send response
      if (imageUrls.length > 0) {
         const firstImage = imageUrls[0];
         if (firstImage.startsWith('http')) {
            await ctx.telegram.sendPhoto(chatId, firstImage, { ...replyOptions, caption: plainText });
         } else {
            await ctx.telegram.sendMessage(chatId, plainText, replyOptions);
         }
      } else {
         await ctx.telegram.sendMessage(chatId, plainText, replyOptions);
      }

      // Generate and send Voice TTS Note
      try {
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
        await ctx.telegram.sendMessage(chatId, "Uzur, texnik xatolik yuz berdi. Iltimos qayta urinib ko'ring.", replyOptions);
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
      } else {
          console.error("❌ No Vercel domain found for webhook setup");
      }
  } else {
      bot.launch().catch(err => console.error("Failed to launch bot:", err));
      console.log("Telegram bot started successfully in polling mode.");
      process.once('SIGINT', () => bot.stop('SIGINT'));
      process.once('SIGTERM', () => bot.stop('SIGTERM'));
  }
}

