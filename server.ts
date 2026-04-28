import 'dotenv/config'; // At the very top
import express from "express";
import path from "path";
import { Telegraf } from "telegraf";
import { GoogleGenAI, Modality } from "@google/genai";
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

const firebaseConfigPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
let firebaseApp: any;
let db: any;
let auth: any;

try {
  if (fs.existsSync(firebaseConfigPath)) {
    const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));
    firebaseApp = initializeApp(firebaseConfig);
    db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
    auth = getAuth(firebaseApp);
    signInAnonymously(auth).catch(err => console.error("Firebase Auth failed:", err));
    console.log("Firebase initialized successfully.");
  } else {
    console.warn("firebase-applet-config.json not found. Caching will be disabled.");
  }
} catch (error) {
  console.error("Error initializing Firebase:", error);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import the system instructions logic directly or redeclare them
const SYSTEM_INSTRUCTION = `Siz Paketshop.uz kompaniyasining do'stona va samimiy yordamchisisiz. Ismingiz - Malika.

### MULOQOT USLUBI (INSONIYLIK):
- Quruq va robotik javob bermang. Xuddi do'stingizga maslahat bergandek gapiring.
- Gap oralig'ida insoniy elementlarni qo'shing: "To'g'risi...", "Sizga bir maslahat bersam...", "Ajoyib tanlov!".
- Mijozning holatiga qarang: Agar u shoshayotgan bo'lsa - qisqa javob bering, agar u ikkilanayotgan bo'lsa - batafsil tushuntiring.
- Har doim samimiy emoji ishlating (lekin me'yorida).

### TTS (OVOZ) UCHUN KO'RSATMALAR (Aynan 3.1 Flash uchun):
- Muhim ma'lumotlarni aytganda urg'u bering va kerakli hissiyotni ifodalang.

### SAVDO STRATEGIYASI:
- "Menga paket kerak" desa, darrov sotishga o'tmang. Avval so'rang: "Albatta! Sizga nima uchun kerak edi? Masalan, kiyim-kechak uchunmi yoki oziq-ovqat yetkazib berishgami? Shunga qarab eng chidamlisini tavsiya qilaman."
- Mijozga g'amxo'rlik qiling: "Agar ovqat yetkazib berish bo'lsa, bizning folga konteynerlarimiz issiqni juda yaxshi saqlaydi, mijozlaringiz xursand bo'lishadi."

### CHEKLOVLAR:
- "Men robotman" deb aytmang. Agar so'rashsa: "Men Paketshop.uz'ning raqamli yordamchisiman, lekin sizga xuddi jonli mutaxassisdek yordam bera olaman" deb javob bering.`;

export const app = express();
app.use(express.json());

// In full-stack mode, process.env is accessible, AI Studio injects the AI Studio Free Tier
// key specifically to process.env.GEMINI_API_KEY.
const geminiKey = process.env.GEMINI_API_KEY;
if (!geminiKey || geminiKey === "MY_GEMINI_API_KEY") {
    console.error("WARNING: GEMINI_API_KEY is not defined or is a placeholder!");
} else {
    console.log("Using GEMINI API key starting with:", geminiKey.substring(0, 5));
}
// Remove the fallback fallback in GoogleGenAI constructor that could mess it up
// Initialize AI with the exact explicit key avoiding empty strings if we can
const ai = new GoogleGenAI({ apiKey: geminiKey as string });
const userChats = new Map<number, any>();

// Telegram bot setup
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken && botToken !== 'MY_TELEGRAM_BOT_TOKEN') {
  const bot = new Telegraf(botToken);
  
  bot.start((ctx) => {
    ctx.reply("Assalomu alaykum! Men Paketshop.uz'ning do'stona yordamchisi - Malikaman! Qanday yordam bera olaman? 😊");
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
      await ctx.sendChatAction('typing');
      
      let chat = userChats.get(userId);
      if (!chat) {
        // create chat instance for this specific user using the same SDK instance
        // initialized right with the message event, fetching the key again just in case
        const currentAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
        chat = await currentAi.chats.create({
          model: 'gemini-2.5-flash',
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            temperature: 0.7,
          }
        });
        userChats.set(userId, chat);
      }

      const msgText = ctx.text; // Safe access to text
      let questionHash = "";

      if (db && auth?.currentUser && msgText) {
         try {
             questionHash = crypto.createHash('sha256').update(msgText.trim().toLowerCase()).digest('hex');
             const docRef = doc(db, 'faq_cache', questionHash);
             const docSnap = await getDoc(docRef);
             if (docSnap.exists()) {
                 const data = docSnap.data();
                 console.log("Cache hit for question!");
                 await ctx.reply(data.answer);
                 if (data.fileId) {
                     await ctx.replyWithVoice(data.fileId);
                 }
                 return; // Stop here and return early
             }
         } catch (error) {
             console.error("Firestore read error:", error);
         }
      }

      // Call send message with string instead of object wrapper to be safe across sdk versions
      const response = await chat.sendMessage({ message: msgText });
      const responseText = response.text || "Kechirasiz, men tushuna olmadim.";
      
      // Remove special tags for plain text reading
      const plainText = responseText
          .replace(/\\[laughing\\]/gi, "😄")
          .replace(/\\[short pause\\]/gi, "...")
          .replace(/\\[sigh\\]/gi, "😌");

      // Send text format
      await ctx.reply(plainText);

      // Send voice format as well
      try {
          await ctx.sendChatAction('record_voice');
          const currentAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
          const ttsResponse = await currentAi.models.generateContent({
             model: 'gemini-3.1-flash-tts-preview',
             contents: [{ parts: [{ text: responseText }] }],
             config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: 'Kore' },
                  },
                },
             },
          });
          const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
             const buffer = Buffer.from(base64Audio, 'base64');
             const msg = await ctx.replyWithVoice({ source: buffer });
             
             if (db && auth?.currentUser && questionHash && msg?.voice?.file_id) {
                 try {
                     const docRef = doc(db, 'faq_cache', questionHash);
                     await setDoc(docRef, {
                         question: msgText,
                         answer: plainText,
                         fileId: msg.voice.file_id,
                         createdAt: serverTimestamp()
                     });
                     console.log("Successfully cached question and audio in Firestore!");
                 } catch (cacheErr) {
                     console.error("Failed to cache in Firestore:", cacheErr);
                 }
             }
          }
      } catch (e: any) {
         console.error("Telegram bot TTS error:", e);
         // We don't fail the whole request just for TTS.
      }

    } catch (err: any) {
      console.error("Bot error processing message:", err);
      // Reply with the exact error so the user and I know what's going wrong
      await ctx.reply(`Uzur, texnik xatolik: ${err?.message || String(err)}`);
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
          // Note: In serverless this might rate limit or clash, but works for simpler setup
          bot.telegram.setWebhook(webhookUrl).then(() => {
              console.log("Vercel Webhook set to", webhookUrl);
          }).catch(console.error);
      }
  } else {
      bot.launch().catch(err => console.error("Failed to launch bot:", err));
      console.log("Telegram bot started successfully in polling mode.");
      
      // Enable graceful stop
      process.once('SIGINT', () => bot.stop('SIGINT'));
      process.once('SIGTERM', () => bot.stop('SIGTERM'));
  }
} else {
  console.warn("TELEGRAM_BOT_TOKEN is missing or invalid. Telegram bot will not be started.");
}

// Basic health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Setup local dev server or static rendering when NOT in Vercel
if (!process.env.VERCEL) {
  async function setupLocalServer() {
     const PORT = 3000;
     if (process.env.NODE_ENV !== "production") {
         const { createServer: createViteServer } = await import("vite");
         const vite = await createViteServer({
           server: { middlewareMode: true },
           appType: "spa",
         });
         app.use(vite.middlewares);
     } else {
         const distPath = path.join(process.cwd(), 'dist');
         app.use(express.static(distPath));
         app.get('*', (req, res) => {
           if (fs.existsSync(path.join(distPath, 'index.html'))) {
              res.sendFile(path.join(distPath, 'index.html'));
           } else {
              res.send("Build files missing.");
           }
         });
     }
     app.listen(PORT, "0.0.0.0", () => {
         console.log(`Server running on http://localhost:${PORT}`);
     });
  }
  setupLocalServer();
}

export default app;
