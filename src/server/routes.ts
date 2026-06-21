import express from 'express';
import multer from 'multer';
import { sql } from './db.js';
import { generateEmbedding, searchKnowledgeBase, handleConversationalChat, handleConversationalChatStream, transcribeAudio, generateSpeech, dbCreateOrder, BRAND, BRAND_GREETING, appendHistory } from './ai.js';
import { GoogleGenAI } from "@google/genai";
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export const router = express.Router();

const CLOUDINARY_CONFIGURED = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

async function uploadToCloudinary(buffer: Buffer, folder: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error || !result) reject(error || new Error("No upload result"));
        else resolve(result.secure_url);
      }
    );
    uploadStream.end(buffer);
  });
}

// Basic health check endpoint
router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Public: featured products for the chat carousel — latest 6 + top-sold 6
router.get("/products/featured", async (_req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const [latest, popular] = await Promise.all([
      sql`
        SELECT id, name, description, price, category, image_url
        FROM products WHERE stock > 0
        ORDER BY created_at DESC LIMIT 6
      `,
      sql`
        SELECT p.id, p.name, p.description, p.price, p.category, p.image_url,
               COALESCE(SUM((item->>'quantity')::integer), 0)::integer AS units_sold
        FROM products p
        LEFT JOIN orders o ON o.status != 'cancelled'
        LEFT JOIN jsonb_array_elements(o.items) AS item
          ON (item->>'product_id')::integer = p.id
        WHERE p.stock > 0
        GROUP BY p.id
        ORDER BY units_sold DESC, p.created_at DESC
        LIMIT 6
      `,
    ]);
    res.json({ latest, popular });
  } catch (err) {
    console.error("Featured products error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// Public: GET single product details by id
router.get("/products/:id", async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const data = await sql`
      SELECT id, name, description, price, category, stock, image_url 
      FROM products WHERE id = ${req.params.id}
    `;
    if (data.length === 0) return res.status(404).json({ error: "Mahsulot topilmadi" });
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Public branding config — used by frontend to render shop name, assistant name, colors
router.get("/config", (_req, res) => {
  res.json({
    shopName: BRAND.shopName,
    assistantName: BRAND.assistantName,
    greeting: BRAND_GREETING,
    brandColor: BRAND.brandColor,
    currency: BRAND.currency,
  });
});

import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: { error: "Juda ko'p so'rov yuborildi. Iltimos 15 daqiqadan so'ng qayta urinib ko'ring." }
});

router.use(apiLimiter);

const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_PASSWORD;
if (!process.env.JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET env o'rnatilmagan. ADMIN_PASSWORD ishlatilyapti (xavfsiz emas). .env ga JWT_SECRET qo'shing.");
}

const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      jwt.verify(token, JWT_SECRET as string);
      next();
    } catch (err) {
      res.status(401).json({ error: "Yaroqsiz yoki muddati tugagan token" });
    }
  } else {
    res.status(401).json({ error: "Ruxsat etilmagan (Unauthorized)" });
  }
};

router.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET as string, { expiresIn: '24h' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: "Noto'g'ri parol" });
  }
});

router.get("/knowledge", async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const data = await sql`SELECT * FROM knowledge_base ORDER BY created_at DESC`;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

import { v2 as cloudinary } from 'cloudinary';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadImageMemory = multer({ 
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  storage: multer.memoryStorage()
});

router.post("/knowledge", requireAdmin, uploadImageMemory.single('image'), async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  const { question, answer, video_url } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "Missing fields" });
  
  let image_url = null;
  if (req.file) {
    if (!CLOUDINARY_CONFIGURED) {
      return res.status(500).json({ error: "Rasm yuklash uchun Cloudinary sozlanmagan. CLOUDINARY_* env'larni qo'shing." });
    }
    try {
      image_url = await uploadToCloudinary(req.file.buffer, 'paketshop');
    } catch (err) {
      console.error("Cloudinary upload failed:", err);
      return res.status(500).json({ error: "Rasm yuklashda xatolik yuz berdi" });
    }
  }

  try {
    // Generate embedding for the knowledge entry
    const embeddingText = `${question} ${answer}`;
    const embedding = await generateEmbedding(embeddingText);
    const vectorStr = embedding ? `[${embedding.join(',')}]` : null;

    const result = vectorStr 
      ? await sql`
          INSERT INTO knowledge_base (question, answer, image_url, video_url, embedding) 
          VALUES (${question}, ${answer}, ${image_url}, ${video_url || null}, ${vectorStr}::vector) 
          RETURNING *
        `
      : await sql`
          INSERT INTO knowledge_base (question, answer, image_url, video_url) 
          VALUES (${question}, ${answer}, ${image_url}, ${video_url || null}) 
          RETURNING *
        `;
    res.json(result[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put("/knowledge/:id", requireAdmin, uploadImageMemory.single('image'), async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  const { question, answer, video_url, remove_image } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "Missing fields" });

  let image_url: string | null | undefined = undefined; // undefined = don't touch
  if (req.file) {
    if (!CLOUDINARY_CONFIGURED) {
      return res.status(500).json({ error: "Rasm yuklash uchun Cloudinary sozlanmagan" });
    }
    try {
      image_url = await uploadToCloudinary(req.file.buffer, 'paketshop');
    } catch (err) {
      console.error("Cloudinary upload failed:", err);
      return res.status(500).json({ error: "Rasm yuklashda xatolik" });
    }
  } else if (remove_image === 'true') {
    image_url = null;
  }

  try {
    const embeddingText = `${question} ${answer}`;
    const embedding = await generateEmbedding(embeddingText);
    const vectorStr = embedding ? `[${embedding.join(',')}]` : null;

    let result;
    if (image_url === undefined) {
      result = vectorStr
        ? await sql`
            UPDATE knowledge_base SET question = ${question}, answer = ${answer},
              video_url = ${video_url || null}, embedding = ${vectorStr}::vector
            WHERE id = ${req.params.id} RETURNING *
          `
        : await sql`
            UPDATE knowledge_base SET question = ${question}, answer = ${answer},
              video_url = ${video_url || null}
            WHERE id = ${req.params.id} RETURNING *
          `;
    } else {
      result = vectorStr
        ? await sql`
            UPDATE knowledge_base SET question = ${question}, answer = ${answer},
              image_url = ${image_url}, video_url = ${video_url || null}, embedding = ${vectorStr}::vector
            WHERE id = ${req.params.id} RETURNING *
          `
        : await sql`
            UPDATE knowledge_base SET question = ${question}, answer = ${answer},
              image_url = ${image_url}, video_url = ${video_url || null}
            WHERE id = ${req.params.id} RETURNING *
          `;
    }
    if (result.length === 0) return res.status(404).json({ error: "Topilmadi" });
    res.json(result[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/knowledge/:id", requireAdmin, async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    await sql`DELETE FROM knowledge_base WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const uploadMemory = multer({ 
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  storage: multer.memoryStorage()
});

router.post("/knowledge/upload", requireAdmin, uploadMemory.single('file'), async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    let extractedText = "";
    const fileName = req.file.originalname;

    if (req.file.mimetype === 'application/pdf') {
      if (typeof globalThis.DOMMatrix === 'undefined') {
          globalThis.DOMMatrix = class DOMMatrix {} as any;
      }
      const pdfParse = require('pdf-parse');
      const pdfData = await pdfParse(req.file.buffer);
      extractedText = pdfData.text;
    } 
    else if (req.file.mimetype.startsWith('image/')) {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
      const base64Data = req.file.buffer.toString('base64');
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  data: base64Data,
                  mimeType: req.file.mimetype
                }
              },
              { text: "Ushbu rasmdagi barcha yozuvlarni, narxlarni, mahsulotlarni va boshqa foydali ma'lumotlarni matn ko'rinishida yozib ber. Hech qanday ortiqcha gap qo'shma, faqat ichidagi bor ma'lumotni tuzilgan shaklda ber." }
            ]
          }
        ]
      });
      extractedText = response.text || "";
    } else {
      return res.status(400).json({ error: "Faqat PDF va Rasm (JPG, PNG) qo'llab-quvvatlanadi" });
    }

    if (!extractedText.trim()) {
      return res.status(400).json({ error: "Fayldan hech qanday matn o'qib bo'lmadi" });
    }

    const question = `Fayl ma'lumoti: ${fileName}`;
    
    // Generate embedding for file content
    const embeddingText = `${question} ${extractedText.substring(0, 2000)}`;
    const embedding = await generateEmbedding(embeddingText);
    const vectorStr = embedding ? `[${embedding.join(',')}]` : null;

    const result = vectorStr
      ? await sql`
          INSERT INTO knowledge_base (question, answer, embedding) 
          VALUES (${question}, ${extractedText}, ${vectorStr}::vector) 
          RETURNING *
        `
      : await sql`
          INSERT INTO knowledge_base (question, answer) 
          VALUES (${question}, ${extractedText}) 
          RETURNING *
        `;
    
    res.json(result[0]);
  } catch (err) {
    console.error("File upload parsing error:", err);
    res.status(500).json({ error: "Faylni o'qishda xatolik yuz berdi" });
  }
});

// RAG Search endpoint for web chat
router.post("/knowledge/search", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Query is required" });
  try {
    const context = await searchKnowledgeBase(query, 3);
    res.json({ context });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Reindex all existing knowledge base entries with embeddings
router.post("/knowledge/reindex", requireAdmin, async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const data = await sql`SELECT id, question, answer FROM knowledge_base WHERE embedding IS NULL`;
    let updated = 0;
    for (const item of data) {
      const embeddingText = `${item.question} ${item.answer}`.substring(0, 3000);
      const embedding = await generateEmbedding(embeddingText);
      if (embedding) {
        const vectorStr = `[${embedding.join(',')}]`;
        await sql`UPDATE knowledge_base SET embedding = ${vectorStr}::vector WHERE id = ${item.id}`;
        updated++;
      }
    }
    res.json({ success: true, total: data.length, updated });
  } catch (err) {
    console.error("Reindex error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// Public: GET customer details by webSessionId (for checkout form pre-fill)
router.get("/customers/session/:webSessionId", async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const data = await sql`
      SELECT name, phone, address FROM customers 
      WHERE web_session_id = ${req.params.webSessionId}
      LIMIT 1
    `;
    if (data.length === 0) return res.json(null);
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Public: POST create order directly from checkout form
router.post("/orders", async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  const { customer_name, customer_phone, delivery_address, items, webSessionId } = req.body;
  if (!customer_name || !customer_phone || !delivery_address || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Barcha maydonlar to'ldirilishi shart va mahsulotlar ro'yxati kamida bitta elementdan iborat bo'lishi kerak" });
  }
  try {
    const result = await dbCreateOrder(
      customer_name,
      customer_phone,
      delivery_address,
      items,
      undefined,
      webSessionId
    );
    
    if (result.success && webSessionId) {
      const itemsList = items.map((i: any) => `${i.quantity} dona "${i.name || 'mahsulot'}"`).join(', ');
      const userMsg = `Menga ${itemsList} mahsulotidan buyurtma bering. (Ism: ${customer_name}, Tel: ${customer_phone}, Manzil: ${delivery_address})`;
      const modelMsg = `Rahmat! Buyurtmangiz qabul qilindi. Buyurtma raqami: #${result.order_id}. Jami: ${Number(result.total_price).toLocaleString()} so'm. Tez orada kuryerimiz siz bilan bog'lanadi.`;
      await appendHistory({ webSessionId }, 'user', userMsg);
      await appendHistory({ webSessionId }, 'model', modelMsg);
    }
    
    res.json(result);
  } catch (err) {
    console.error("Direct order creation error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Conversational Commerce Routes ---

// 1. Chat with Malika (Conversational E-Commerce)
router.post("/chat", async (req, res) => {
  const { message, history, webSessionId } = req.body;
  if (!message) return res.status(400).json({ error: "Xabar majburiy" });
  try {
    const replyText = await handleConversationalChat(message, history || [], { webSessionId });
    res.json({ reply: replyText });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Tizimda xatolik yuz berdi" });
  }
});

// 1.2. Streaming chat (SSE) — text appears progressively
router.post("/chat/stream", async (req, res) => {
  const { message, history, webSessionId } = req.body;
  if (!message) {
    res.status(400).json({ error: "Xabar majburiy" });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const writeEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const fullText = await handleConversationalChatStream(
      message,
      history || [],
      { webSessionId },
      (chunk) => writeEvent('chunk', { text: chunk })
    );
    writeEvent('done', { reply: fullText });
    res.end();
  } catch (err) {
    console.error("Chat stream error:", err);
    writeEvent('error', { error: "Tizimda xatolik yuz berdi" });
    res.end();
  }
});

// 1.1. Reset conversation for a web session
router.post("/chat/reset", async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  const { webSessionId } = req.body;
  if (!webSessionId) return res.status(400).json({ error: "webSessionId required" });
  try {
    await sql`DELETE FROM conversation_history WHERE web_session_id = ${webSessionId}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 1.5. Voice Chat with Malika
router.post("/chat/voice", uploadMemory.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Audio fayl yuborilmadi" });
  }
  
  const { webSessionId } = req.body;
  let history: any[] = [];
  if (req.body.history) {
    try {
      history = JSON.parse(req.body.history);
    } catch (e) {
      console.warn("Failed to parse history in voice chat route", e);
    }
  }

  try {
    // 1. Transcribe audio to text
    const mimeType = req.file.mimetype || 'audio/webm';
    console.log(`🎙️ Web voice message upload received: size=${req.file.size} bytes, mime=${mimeType}`);
    
    const transcribedText = await transcribeAudio(req.file.buffer, mimeType);
    if (!transcribedText) {
      return res.status(400).json({ error: "Ovozli xabarni eshitib bo'lmadi. Iltimos qaytadan yozib ko'ring." });
    }
    
    console.log(`🎙️ Transcribed voice to: "${transcribedText}"`);

    // 2. Feed text into conversational chat
    const replyText = await handleConversationalChat(transcribedText, history, { webSessionId });

    // 3. Clean and convert reply text to TTS audio
    const speechText = replyText
      .replace(/\[IMAGE: (.*?)\]/g, '')
      .replace(/\[VIDEO: (.*?)\]/g, '')
      .replace(/https?:\/\/[^\s]+/g, '') // remove URLs
      .replace(/[#_*\[\]]/g, '')        // remove styling characters
      .trim();

    let voiceBase64 = null;
    if (speechText) {
      voiceBase64 = await generateSpeech(speechText);
    }

    res.json({
      transcription: transcribedText,
      reply: replyText,
      audio: voiceBase64 // Base64 PCM data
    });

  } catch (err) {
    console.error("Voice chat route error:", err);
    res.status(500).json({ error: "Ovozli xabarni ishlashda xatolik yuz berdi" });
  }
});

// 2. Admin: List all products
router.get("/admin/products", requireAdmin, async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const data = await sql`SELECT * FROM products ORDER BY created_at DESC`;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 3. Admin: Create a new product
router.post("/admin/products", requireAdmin, uploadImageMemory.single('image'), async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  const { name, description, price, category, stock } = req.body;
  if (!name || !price) return res.status(400).json({ error: "Name and Price are required" });

  let image_url = null;
  if (req.file) {
    if (!CLOUDINARY_CONFIGURED) {
      return res.status(500).json({ error: "Rasm yuklash uchun Cloudinary sozlanmagan. CLOUDINARY_* env'larni qo'shing." });
    }
    try {
      image_url = await uploadToCloudinary(req.file.buffer, 'paketshop_products');
    } catch (err) {
      console.error("Cloudinary upload failed:", err);
      return res.status(500).json({ error: "Rasm yuklashda xatolik yuz berdi" });
    }
  }

  try {
    const result = await sql`
      INSERT INTO products (name, description, price, category, stock, image_url)
      VALUES (${name}, ${description || null}, ${price}, ${category || null}, ${stock || 10}, ${image_url})
      RETURNING *
    `;
    res.json(result[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 3.5. Admin: Update an existing product
router.put("/admin/products/:id", requireAdmin, uploadImageMemory.single('image'), async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  const { name, description, price, category, stock, remove_image } = req.body;
  if (!name || !price) return res.status(400).json({ error: "Name va Price majburiy" });

  let image_url: string | null | undefined = undefined;
  if (req.file) {
    if (!CLOUDINARY_CONFIGURED) {
      return res.status(500).json({ error: "Rasm yuklash uchun Cloudinary sozlanmagan" });
    }
    try {
      image_url = await uploadToCloudinary(req.file.buffer, 'paketshop_products');
    } catch (err) {
      console.error("Cloudinary upload failed:", err);
      return res.status(500).json({ error: "Rasm yuklashda xatolik" });
    }
  } else if (remove_image === 'true') {
    image_url = null;
  }

  try {
    const result = image_url === undefined
      ? await sql`
          UPDATE products SET name = ${name}, description = ${description || null},
            price = ${price}, category = ${category || null}, stock = ${stock || 0}
          WHERE id = ${req.params.id} RETURNING *
        `
      : await sql`
          UPDATE products SET name = ${name}, description = ${description || null},
            price = ${price}, category = ${category || null}, stock = ${stock || 0},
            image_url = ${image_url}
          WHERE id = ${req.params.id} RETURNING *
        `;
    if (result.length === 0) return res.status(404).json({ error: "Mahsulot topilmadi" });
    res.json(result[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 3.6. Admin: Bulk import products from CSV
// CSV format: name,price,description,category,stock,image_url (first row = headers)
function parseCSV(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map(s => s.trim());
  };

  const headers = parseRow(lines[0]).map(h => h.toLowerCase());
  return lines.slice(1).map(line => {
    const cells = parseRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => row[h] = cells[i] || '');
    return row;
  });
}

router.post("/admin/products/bulk", requireAdmin, uploadImageMemory.single('file'), async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  if (!req.file) return res.status(400).json({ error: "CSV fayl yuborilmadi" });

  try {
    const text = req.file.buffer.toString('utf-8');
    const rows = parseCSV(text);
    if (rows.length === 0) return res.status(400).json({ error: "CSV bo'sh yoki noto'g'ri formatda" });

    let inserted = 0;
    const errors: string[] = [];

    for (const [idx, row] of rows.entries()) {
      const name = row.name?.trim();
      const priceStr = row.price?.trim();
      if (!name || !priceStr) {
        errors.push(`Qator ${idx + 2}: name yoki price yo'q`);
        continue;
      }
      const price = parseFloat(priceStr);
      if (isNaN(price)) {
        errors.push(`Qator ${idx + 2}: price raqam emas (${priceStr})`);
        continue;
      }
      const stock = parseInt(row.stock || '10', 10) || 10;
      try {
        await sql`
          INSERT INTO products (name, description, price, category, stock, image_url)
          VALUES (${name}, ${row.description || null}, ${price}, ${row.category || null}, ${stock}, ${row.image_url || null})
        `;
        inserted++;
      } catch (err) {
        errors.push(`Qator ${idx + 2}: ${String(err)}`);
      }
    }

    res.json({ success: true, inserted, total: rows.length, errors });
  } catch (err) {
    console.error("Bulk import error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// 4. Admin: Delete a product
router.delete("/admin/products/:id", requireAdmin, async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    await sql`DELETE FROM products WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 4.5. Admin: List all customers with order counts and total spent
router.get("/admin/customers", requireAdmin, async (_req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const data = await sql`
      SELECT
        c.id, c.telegram_id, c.web_session_id, c.name, c.phone, c.address, c.created_at,
        COALESCE(o.order_count, 0)::integer as order_count,
        COALESCE(o.total_spent, 0)::numeric as total_spent
      FROM customers c
      LEFT JOIN (
        SELECT customer_phone,
               COUNT(*) as order_count,
               SUM(total_price) as total_spent
        FROM orders
        GROUP BY customer_phone
      ) o ON o.customer_phone = c.phone
      ORDER BY c.created_at DESC
    `;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 4.6. Admin: Get one customer's order history
router.get("/admin/customers/:id/orders", requireAdmin, async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const custRes = await sql`SELECT phone FROM customers WHERE id = ${req.params.id}`;
    if (custRes.length === 0) return res.status(404).json({ error: "Topilmadi" });
    const phone = custRes[0].phone;
    if (!phone) return res.json([]);
    const data = await sql`
      SELECT * FROM orders WHERE customer_phone = ${phone} ORDER BY created_at DESC
    `;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 4.7. Admin: Analytics dashboard data
router.get("/admin/analytics", requireAdmin, async (_req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const [
      totals,
      statusCounts,
      dailyRevenue,
      topProducts,
      todaySnapshot,
      conversionData,
    ] = await Promise.all([
      sql`
        SELECT
          COUNT(*)::integer AS total_orders,
          COALESCE(SUM(total_price), 0)::numeric AS total_revenue,
          COUNT(DISTINCT customer_phone)::integer AS unique_customers
        FROM orders
        WHERE status != 'cancelled'
      `,
      sql`
        SELECT status, COUNT(*)::integer AS count
        FROM orders
        GROUP BY status
      `,
      sql`
        SELECT
          DATE(created_at) AS day,
          COALESCE(SUM(total_price), 0)::numeric AS revenue,
          COUNT(*)::integer AS orders
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '30 days' AND status != 'cancelled'
        GROUP BY DATE(created_at)
        ORDER BY day ASC
      `,
      sql`
        SELECT
          (item->>'product_id')::integer AS product_id,
          (item->>'name') AS name,
          SUM((item->>'quantity')::integer)::integer AS units_sold,
          SUM((item->>'quantity')::integer * (item->>'price')::numeric)::numeric AS revenue
        FROM orders, jsonb_array_elements(items) AS item
        WHERE status != 'cancelled'
        GROUP BY product_id, name
        ORDER BY units_sold DESC
        LIMIT 5
      `,
      sql`
        SELECT
          COALESCE(SUM(total_price) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND status != 'cancelled'), 0)::numeric AS today_revenue,
          COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE)::integer AS today_orders,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND status != 'cancelled')::integer AS week_orders
        FROM orders
      `,
      sql`
        SELECT
          COUNT(DISTINCT COALESCE(telegram_id::text, web_session_id))::integer AS chat_users,
          (SELECT COUNT(DISTINCT customer_phone)::integer FROM orders WHERE status != 'cancelled') AS buying_customers
        FROM conversation_history
      `,
    ]);

    const conv = conversionData[0] as any;
    const conversionRate = conv?.chat_users > 0
      ? Math.round((conv.buying_customers / conv.chat_users) * 100)
      : 0;

    res.json({
      totals: totals[0],
      statusCounts,
      dailyRevenue,
      topProducts,
      today: todaySnapshot[0],
      conversion: { chatUsers: conv?.chat_users || 0, buyingCustomers: conv?.buying_customers || 0, rate: conversionRate },
    });
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// 5. Admin: List all orders
router.get("/admin/orders", requireAdmin, async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  try {
    const data = await sql`SELECT * FROM orders ORDER BY created_at DESC`;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 6. Admin: Update order status
router.patch("/admin/orders/:id", requireAdmin, async (req, res) => {
  if (!sql) return res.status(500).json({ error: "Database not connected" });
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "Status is required" });
  try {
    const result = await sql`
      UPDATE orders SET status = ${status} WHERE id = ${req.params.id} RETURNING *
    `;
    res.json(result[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
