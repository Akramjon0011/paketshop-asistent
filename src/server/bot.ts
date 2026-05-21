import { Telegraf } from "telegraf";
import { handleConversationalChat, generateSpeech, transcribeAudio, BRAND } from './ai.js';
import { sql } from './db.js';
import { spawn } from 'child_process';

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

// Convert raw PCM to OGG/Opus using FFmpeg
function pcmToOggOpus(pcmBuffer: Buffer, sampleRate = 24000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', '1',
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-f', 'ogg',
      'pipe:1'
    ]);

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => errChunks.push(chunk));

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const errStr = Buffer.concat(errChunks).toString();
        reject(new Error(`FFmpeg exited with code ${code}. Error: ${errStr}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });

    ffmpeg.stdin.write(pcmBuffer);
    ffmpeg.stdin.end();
  });
}

export function setupBot(app: any) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || botToken === 'MY_TELEGRAM_BOT_TOKEN') {
    console.warn("TELEGRAM_BOT_TOKEN is missing or invalid. Telegram bot will not be started.");
    return;
  }

  const bot = new Telegraf(botToken);
  
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

  bot.start(async (ctx) => {
    const welcomeText = `Salom! Men ${BRAND.assistantName}, ${BRAND.shopName}'dan. Qanday yordam kerak?`;
    await ctx.reply(welcomeText);
    try {
      await ctx.sendChatAction('record_voice');
      const voiceBase64 = await generateSpeech(welcomeText);
      if (voiceBase64) {
         const pcmBuffer = Buffer.from(voiceBase64, 'base64');
         try {
            const oggBuffer = await pcmToOggOpus(pcmBuffer);
            await ctx.replyWithVoice({ source: oggBuffer, filename: 'welcome.ogg' });
         } catch (oggErr) {
            console.warn("FFmpeg conversion failed on start, falling back to WAV audio player:", oggErr);
            const wavBuffer = pcmToWav(pcmBuffer);
            await ctx.replyWithAudio({ source: wavBuffer, filename: 'welcome.wav' }, { title: BRAND.assistantName, performer: BRAND.shopName });
         }
      }
    } catch (voiceErr) {
      console.error("Error sending voice message to Telegram on start:", voiceErr);
    }
  });

  // Unified handler to process incoming text and voice messages, supporting both regular and business chats
  async function processMessage(
    ctx: any, 
    messageObj: any, 
    isVoice: boolean, 
    businessConnectionId?: string
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
      } else {
        queryText = messageObj.text || "";
      }

      if (!queryText.trim()) return;

      console.log(`📨 Telegram message from ${userId}: "${queryText}"`);

      // History is loaded/persisted inside handleConversationalChat via userContext
      const responseText = await handleConversationalChat(queryText, [], { telegramId: userId });

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
          .replace(/\[laughing\]/gi, "😄")
          .replace(/\[short pause\]/gi, "...")
          .replace(/\[sigh\]/gi, "😌")
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
                  const oggBuffer = await pcmToOggOpus(pcmBuffer);
                  await ctx.telegram.sendVoice(chatId, { source: oggBuffer, filename: 'voice.ogg' }, replyOptions);
               } catch (oggErr) {
                  console.warn("FFmpeg conversion failed, falling back to WAV audio player:", oggErr);
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
      console.error("Bot error in processMessage:", err);
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

  // Bind Telegram Business Chatbot Handlers
  // Cast to any because older Telegraf type defs don't include 'business_message'
  (bot as any).on('business_message', async (ctx: any) => {
    const businessMessage = ctx.update?.business_message;
    if (!businessMessage) return;
    const isVoice = !!businessMessage.voice;
    console.log(`💼 Telegram Business message received: isVoice=${isVoice}, conn_id=${businessMessage.business_connection_id}`);
    await processMessage(ctx, businessMessage, isVoice, businessMessage.business_connection_id);
  });

  bot.catch((err: any) => console.error("Bot error:", err));

  if (process.env.VERCEL) {
      console.log("Running in Vercel Serverless Webhook mode");
      const domain = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
      if (domain) {
          const webhookPath = `/api/telegram`;
          const webhookUrl = `https://${domain}${webhookPath}`;
          
          // Don't pass res to handleUpdate — forces Telegraf to use standard API
          // method for replies, which is more reliable in serverless environments
          app.post(webhookPath, async (req: any, res: any) => {
            const updateId = req.body?.update_id || 'unknown';
            console.log(`📨 Webhook received update #${updateId}`);
            try {
              await bot.handleUpdate(req.body);
              console.log(`✅ Update #${updateId} processed`);
            } catch (err) {
              console.error(`❌ Update #${updateId} error:`, err);
            }
            res.status(200).json({ ok: true });
          });
          
          // Only call setWebhook if the URL changed (avoid Telegram rate limit on every cold start)
          (async () => {
            try {
              if (!sql) {
                await bot.telegram.setWebhook(webhookUrl);
                console.log("✅ Webhook set (no DB cache):", webhookUrl);
                return;
              }
              const cached = await sql`SELECT value FROM app_settings WHERE key = 'telegram_webhook_url'`;
              if (cached.length > 0 && cached[0].value === webhookUrl) {
                return; // already set, skip API call
              }
              await bot.telegram.setWebhook(webhookUrl);
              await sql`
                INSERT INTO app_settings (key, value, updated_at)
                VALUES ('telegram_webhook_url', ${webhookUrl}, CURRENT_TIMESTAMP)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
              `;
              console.log("✅ Vercel Webhook updated to", webhookUrl);
            } catch (err) {
              console.error("❌ Failed to set webhook:", err);
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

