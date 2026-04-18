import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import { SYSTEM_INSTRUCTION, searchKnowledgeBase } from './ai.js';

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

      // Send response — use Cloudinary URLs for images (no local files on Vercel)
      if (imageUrls.length > 0) {
         const firstImage = imageUrls[0];
         // Cloudinary or external URLs — send directly
         if (firstImage.startsWith('http')) {
            await ctx.replyWithPhoto({ url: firstImage }, { caption: plainText });
         } else {
            await ctx.reply(plainText);
         }
      } else {
         await ctx.reply(plainText);
      }

    } catch (err: any) {
      console.error("Bot error processing message:", err);
      await ctx.reply("Uzur, texnik xatolik yuz berdi. Iltimos qayta urinib ko'ring.");
    }
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
          
          bot.telegram.setWebhook(webhookUrl).then(() => {
              console.log("✅ Vercel Webhook set to", webhookUrl);
          }).catch((err: any) => {
              console.error("❌ Failed to set webhook:", err);
          });
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

