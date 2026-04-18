import { Telegraf } from "telegraf";
import { GoogleGenAI, Modality } from "@google/genai";
import path from "path";
import fs from 'fs';
import os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import { fileURLToPath } from 'url';
import { SYSTEM_INSTRUCTION, searchKnowledgeBase } from './ai.js';

const __filename = fileURLToPath(import.meta.url);
// the public directory will be relative to project root. We are in src/server, so project root is ../..
const projectRoot = path.join(path.dirname(__filename), '../..');

export function setupBot(app: any) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || botToken === 'MY_TELEGRAM_BOT_TOKEN') {
    console.warn("TELEGRAM_BOT_TOKEN is missing or invalid. Telegram bot will not be started.");
    return;
  }

  const bot = new Telegraf(botToken);
  const userChats = new Map<number, any>();
  
  bot.start((ctx) => {
    ctx.reply("Salom! Men Malika, Paketshop.uz'dan. Qanday yordam kerak?");
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
      await ctx.sendChatAction('typing');
      
      const msgText = ctx.text;

      // RAG: Search relevant knowledge for THIS specific message
      const ragContext = await searchKnowledgeBase(msgText, 3);
      
      let chat = userChats.get(userId);
      if (!chat) {
        const currentAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
        chat = await currentAi.chats.create({
          model: 'gemini-2.5-flash',
          config: {
            systemInstruction: SYSTEM_INSTRUCTION + ragContext,
            temperature: 0.7,
          }
        });
        userChats.set(userId, chat);
      }

      const response = await chat.sendMessage({ message: ragContext ? `${msgText}\n\n---\nQo'shimcha kontekst:\n${ragContext}` : msgText });
      const responseText = response.text || "Kechirasiz, men tushuna olmadim.";
      
      let finalResponseText = responseText;
      let imageUrls: string[] = [];
      let videoUrls: string[] = [];

      finalResponseText = finalResponseText.replace(/\[IMAGE: (.*?)\]/g, (match, url) => {
        imageUrls.push(url);
        return "";
      });

      finalResponseText = finalResponseText.replace(/\[VIDEO: (.*?)\]/g, (match, url) => {
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

      // Generate Voice Buffer FIRST
      let oggBuffer: Buffer | null = null;
      try {
          await ctx.sendChatAction('record_voice');
          const currentAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
          const ttsResponse = await currentAi.models.generateContent({
             model: 'gemini-3.1-flash-tts-preview',
             contents: [{ parts: [{ text: responseText }] }],
             config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
                },
             },
          });
          const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
             const pcmBuffer = Buffer.from(base64Audio, 'base64');
             oggBuffer = await new Promise<Buffer>((resolve, reject) => {
               const tmpPcm = path.join(os.tmpdir(), `tts_${Date.now()}.pcm`);
               const tmpOgg = path.join(os.tmpdir(), `tts_${Date.now()}.ogg`);
               fs.writeFileSync(tmpPcm, pcmBuffer);
               
               ffmpeg()
                 .input(tmpPcm)
                 .inputFormat('s16le')
                 .inputOptions(['-ar 24000', '-ac 1'])
                 .audioCodec('libopus')
                 .audioFrequency(48000)
                 .audioChannels(1)
                 .format('ogg')
                 .output(tmpOgg)
                 .on('end', () => {
                   const ogg = fs.readFileSync(tmpOgg);
                   try { fs.unlinkSync(tmpPcm); } catch {}
                   try { fs.unlinkSync(tmpOgg); } catch {}
                   resolve(ogg);
                 })
                 .on('error', (err: any) => {
                   try { fs.unlinkSync(tmpPcm); } catch {}
                   try { fs.unlinkSync(tmpOgg); } catch {}
                   reject(err);
                 })
                 .run();
             });
          }
      } catch (e: any) {
         console.error("Telegram bot TTS error:", e);
      }

      // NOW send everything together
      if (imageUrls.length > 0) {
         const firstImage = imageUrls[0];
         const imagePath = path.join(projectRoot, 'public', firstImage);
         if (fs.existsSync(imagePath)) {
            await ctx.replyWithPhoto({ source: imagePath }, { caption: plainText });
         } else {
            await ctx.reply(plainText);
         }
      } else {
         await ctx.reply(plainText);
      }

      if (oggBuffer) {
         await ctx.replyWithVoice({ source: oggBuffer });
      }

    } catch (err: any) {
      console.error("Bot error processing message:", err);
      await ctx.reply(`Uzur, texnik xatolik yuz berdi.`);
    }
  });

  bot.catch(err => console.error("Bot error:", err));

  if (process.env.VERCEL) {
      console.log("Running in Vercel Serverless Webhook mode");
      const domain = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
      if (domain) {
          const webhookPath = `/api/telegram`;
          const webhookUrl = `https://${domain}${webhookPath}`;
          app.use(webhookPath, bot.webhookCallback(webhookPath));
          bot.telegram.setWebhook(webhookUrl).then(() => {
              console.log("Vercel Webhook set to", webhookUrl);
          }).catch(console.error);
      }
  } else {
      bot.launch().catch(err => console.error("Failed to launch bot:", err));
      console.log("Telegram bot started successfully in polling mode.");
      process.once('SIGINT', () => bot.stop('SIGINT'));
      process.once('SIGTERM', () => bot.stop('SIGTERM'));
  }
}
