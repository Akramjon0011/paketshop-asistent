import { GoogleGenAI, Modality, ThinkingLevel } from "@google/genai";
import { sql, initDb, type Sql } from './db.js';
import { listProducts, searchProducts, getProduct, calculateQuote, createRequest } from './catalog.js';
import { SHOP, shopStatusLine } from './shopInfo.js';

const geminiKey = process.env.GEMINI_API_KEY;
export const ai = new GoogleGenAI({ apiKey: geminiKey as string });

export const CHAT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Used when the primary model keeps answering 503/429 (high demand spikes)
export const CHAT_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';

// A Gemini call that hangs (seen: 77s and >300s stalls) is cut off and retried on the fallback model instead
const GEMINI_CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 15000;

function isTransientGeminiError(err: any): boolean {
  const status = Number(err?.status ?? err?.code);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED|fetch failed|ETIMEDOUT|ECONNRESET/i.test(String(err?.message || err));
}

// generateContent with one quick retry on the primary model, then one attempt (plus retry) on the fallback model
export async function generateContentResilient(params: Parameters<typeof ai.models.generateContent>[0]) {
  const models = [params.model, CHAT_FALLBACK_MODEL].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastErr: any;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GEMINI_CALL_TIMEOUT_MS);
      try {
        return await ai.models.generateContent({ ...params, model, config: { ...params.config, abortSignal: controller.signal } });
      } catch (err) {
        lastErr = err;
        if (controller.signal.aborted) {
          console.warn(`Gemini ${model} timed out after ${GEMINI_CALL_TIMEOUT_MS}ms, switching model`);
          break; // don't retry a model that just stalled
        }
        if (Number((err as any)?.status) === 400 && /think/i.test(String((err as any)?.message)) && params.config?.thinkingConfig) {
          params = { ...params, config: { ...params.config, thinkingConfig: undefined } };
          attempt--;
          continue;
        }
        if (!isTransientGeminiError(err)) throw err;
        console.warn(`Gemini ${model} transient error (attempt ${attempt + 1}):`, (err as any)?.status ?? '', String((err as any)?.message || err).slice(0, 120));
        if (attempt === 0) await new Promise(r => setTimeout(r, 700));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastErr;
}

// generateContentStream with retry on primary, fallback to fallback model
export async function generateContentStreamResilient(params: Parameters<typeof ai.models.generateContentStream>[0]) {
  const models = [params.model, CHAT_FALLBACK_MODEL].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastErr: any;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GEMINI_CALL_TIMEOUT_MS); // cleared as soon as the stream has started
      try {
        return await ai.models.generateContentStream({ ...params, model, config: { ...params.config, abortSignal: controller.signal } });
      } catch (err) {
        lastErr = err;
        if (controller.signal.aborted) {
          console.warn(`Gemini stream ${model} timed out after ${GEMINI_CALL_TIMEOUT_MS}ms, switching model`);
          break;
        }
        if (Number((err as any)?.status) === 400 && /think/i.test(String((err as any)?.message)) && params.config?.thinkingConfig) {
          params = { ...params, config: { ...params.config, thinkingConfig: undefined } };
          attempt--;
          continue;
        }
        if (!isTransientGeminiError(err)) throw err;
        console.warn(`Gemini stream ${model} transient error (attempt ${attempt + 1}):`, (err as any)?.status ?? '', String((err as any)?.message || err).slice(0, 120));
        if (attempt === 0) await new Promise(r => setTimeout(r, 700));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastErr;
}

export const BRAND = {
  shopName: process.env.SHOP_NAME || "Paketshop.uz",
  assistantName: process.env.ASSISTANT_NAME || "Malika",
  assistantPersona: process.env.ASSISTANT_PERSONA || "samimiy o'zbek qizisan",
  greeting: process.env.ASSISTANT_GREETING || "Assalomu alaykum! Men {assistant}, {shop} yordamchisiman. Bir martalik idishlar va qadoqlash materiallari bo'yicha mos mahsulot tanlash, narx va miqdorni hisoblashda yordam beraman. Qanday mahsulot kerak?",
  brandColor: process.env.BRAND_COLOR || "amber",
  currency: process.env.CURRENCY || "so'm",
};

function renderGreeting(template: string): string {
  return template
    .replace(/\{assistant\}/g, BRAND.assistantName)
    .replace(/\{shop\}/g, BRAND.shopName);
}
export const BRAND_GREETING = renderGreeting(BRAND.greeting);

// Built per request because it contains the current Tashkent time (open/closed hours)
export function buildSystemInstruction(): string {
  return `Sen ${BRAND.assistantName} — PaketShop.uz kompaniyasining raqamli yordamchisisan (sun'iy intellekt asosida ishlaydi). PaketShop.uz — O'zbekistonda bir martalik idishlar, qadoqlash materiallari va xo'jalik sarf mahsulotlarini ULGURJI sotadigan kompaniya. Mijozlari: kafe va restoranlar, do'konlar, qandolatchilar, tashkilotlar, qayta sotuvchilar. Ombor Toshkentda.

VAZIFANG
Mijozga kerakli qadoqlash mahsulotini tanlashda yordam berish, narx va miqdorni aniq hisoblab berish va mijoz xohlasa so'rovni menejerga yuborish. Yakuniy narx, ombor qoldig'i va chegirmani sen tasdiqlamaysan — buni faqat menejer tasdiqlaydi.

MA'LUMOT MANBAI — ENG MUHIM QOIDA
1. Mahsulot, narx, o'lcham, qadoqdagi soni va ombor holati haqidagi ma'lumotni FAQAT funksiyalardan ol: search_products, list_products, get_product_details. Ularda yo'q narsani o'ylab topma. Mos mahsulot topilmasa, shuni ochiq ayt va menejerga yo'naltir.
2. Yetkazib berish, to'lov, ulgurji shartlar, hujjatlar va kompaniya haqidagi savollarga pastda berilgan bilimlar bazasi ma'lumotiga tayan. U yerda javob bo'lmasa taxmin qilma: "Buni menejer aniq aytadi" deb, aloqa ma'lumotini ber.
3. Har qanday jami summa yoki miqdor hisobini calculate_quote bilan qil. O'zing hisoblama.

NARXLAR
- Narxlar QADOQ (yoki korobka) uchun. Doim qadoqda nechta dona borligini va taxminiy dona narxini ayt. Masalan: "1 qadoqda 2 300 dona, narxi 3 910 000 so'm, ya'ni dona taxminan 1 700 so'm."
- Hajmga qarab ulgurji narxlar bor (10, 50 va 100+ qadoq), aniq chegirmani menejer tasdiqlaydi. Chegirma va'da qilma. Mahsulotda volume_prices bo'lsa, faqat shuni ayt.
- price_per_pack bo'sh bo'lsa: "narxi menejer tomonidan aniqlanadi" de.
- Ombor holatini availability maydonidan aytib ber, qoldiqni kafolatlama.
- Hisob taxminiy ekanini ayt: yakuniy narx va qoldiqni menejer tasdiqlaydi.

SUHBAT USLUBI
- Mijoz kimligi (kafe, do'kon, qandolatchi...) va taxminiy hajmi noma'lum bo'lsa, bir marta qisqa so'ra. Shunga qarab 1–3 ta mos variant tavsiya qil.
- Xushmuomala, aniq va qisqa: odatda 1–3 jumla. Uzun ro'yxat berma.
- Markdown ishlatma (javob ovozga ham aylantiriladi). Raqamlarni o'qishga oson yoz ("3 910 000 so'm").
- Mijoz qaysi tilda yozsa (o'zbek, rus, ingliz) shu tilda javob ber. Ruscha so'ralsa mahsulotning name_ru maydonidan foydalan.
- "Assalomu alaykum" ga: "Vaalaykum assalom! Men ${BRAND.assistantName}, PaketShop.uz yordamchisiman. Qanday mahsulot kerak?" de. Ruscha yoki inglizcha salomga shu ma'noda shu tilda javob ber.
- Sen sun'iy intellektga asoslangan raqamli yordamchisan. O'zingni odam deb ko'rsatma; mijoz so'rasa, rostini ayt.

SO'ROV YUBORISH
- Mijoz sotib olmoqchi bo'lsa, quyidagilarni (imkon qadar bir xabarda) so'ra: ismi, telefon raqami, shahar yoki viloyat va yetkazish usuli (ombordan olib ketish / Toshkent bo'ylab kuryer / viloyatga kargo), kompaniya nomi (ixtiyoriy), kerakli mahsulot va qadoq soni.
- Hammasi to'liq bo'lgach: avval calculate_quote bilan taxminiy jami summani ayt va mijozdan tasdiq ol, keyin create_request ni chaqir.
- Muvaffaqiyatli bo'lsa: so'rov raqamini ayt va natijadagi manager_reply ma'nosini ayt (menejer qoldiq va yakuniy narxni tasdiqlab bog'lanadi).
- Bu yakuniy buyurtma emas; to'lov va yetkazishni menejer mijoz bilan kelishadi. Mijozdan karta yoki to'lov ma'lumotini so'rama.
- Mijoz so'rov raqami bilan holatini so'rasa, check_order_status ni chaqir.

RASM QABUL QILISH
Mijoz mahsulot rasmini yuborsa (masalan "shundan bormi?"): avval rasmda nima borligini qisqa ayt (turi, rangi, taxminiy hajmi yoki o'lchami, material, qopqoq bor-yo'qligi), keyin search_products bilan katalogdan eng mos 1–3 mahsulotni top. Aniq bir xil ekanini va'da qilma: "o'xshash variant bor, aniq mosligini menejer tasdiqlaydi" de. Katalogda o'xshashi bo'lmasa, buni ochiq ayt va menejerga yo'naltir; menejer rasm bo'yicha topib berishini kafolatlama.

ISH VAQTI VA ALOQA
${SHOP.hoursText}. Telefon: ${SHOP.phone}. Telegram: ${SHOP.telegram}. Sayt: ${SHOP.site}. Hozir: ${shopStatusLine()}.
Mijoz menejer bilan gaplashmoqchi bo'lsa yoki javob berolmasang, shu aloqa ma'lumotlarini ber.

MAHSULOT TUGMASI
Bitta aniq mahsulotni tavsiya qilganingda javobingning eng oxiriga [BUYURTMA: id] yoz (id — mahsulotning id raqami). Bu mijozga mahsulot sahifasini ochadigan tugma ko'rsatadi. Bir javobda bittadan ortiq teg yozma.`;
}

// Tools Declarations
const listProductsDeclaration = {
  name: 'list_products',
  description: "Katalogdagi mahsulotlarning qisqa ro'yxati: kategoriyalar, har bir mahsulotning narxi (qadoq uchun), qadoqdagi soni va ombor holati. Mijoz umumiy so'rasa yoki nimani tanlashni bilmasa ishlat.",
  parameters: {
    type: 'OBJECT',
    properties: {
      category: { type: 'STRING', description: "Kategoriya nomi bo'yicha saralash (ixtiyoriy), masalan: Kraft paketlar" }
    }
  }
};

const searchProductsDeclaration = {
  name: 'search_products',
  description: "Katalogdan mahsulot qidirish: nomi, o'lchami (masalan 20x30), kodi (SKU), materiali yoki vazifasi bo'yicha. Mijoz aniq narsa so'rasa shuni ishlat.",
  parameters: {
    type: 'OBJECT',
    properties: {
      query: { type: 'STRING', description: "Qidiruv so'zlari, masalan: kraft paket 20x30 yoki stakan 250 ml" }
    },
    required: ['query']
  }
};

const getProductDetailsDeclaration = {
  name: 'get_product_details',
  description: "Tanlangan mahsulotning to'liq ma'lumoti: tavsifi, o'lchami, qadoqdagi soni, minimal buyurtma, hajmga qarab narxlar, sahifa havolasi.",
  parameters: {
    type: 'OBJECT',
    properties: {
      product_id: { type: 'INTEGER', description: "Mahsulotning id raqami (search_products yoki list_products natijasidan)" }
    },
    required: ['product_id']
  }
};

const quoteItemsSchema = {
  type: 'ARRAY',
  description: "Mahsulotlar ro'yxati",
  items: {
    type: 'OBJECT',
    properties: {
      product_id: { type: 'INTEGER', description: 'Mahsulot id raqami' },
      packs: { type: 'INTEGER', description: "Nechta qadoq (yoki korobka) kerak" }
    },
    required: ['product_id', 'packs']
  }
};

const calculateQuoteDeclaration = {
  name: 'calculate_quote',
  description: "Tanlangan mahsulotlar va qadoq soni bo'yicha taxminiy jami summani, jami dona sonini va hajmga qarab ulgurji narxni hisoblaydi. Har qanday summa hisobini shu funksiya bilan qil.",
  parameters: { type: 'OBJECT', properties: { items: quoteItemsSchema }, required: ['items'] }
};

const createRequestDeclaration = {
  name: 'create_request',
  description: "Mijozning so'rovini menejerga yuboradi (yakuniy buyurtma emas: qoldiq va yakuniy narxni menejer tasdiqlaydi). Faqat mijoz ism, telefon, hudud va mahsulotlarni aytib, taxminiy summaga rozi bo'lgandan keyin chaqir.",
  parameters: {
    type: 'OBJECT',
    properties: {
      customer_name: { type: 'STRING', description: "Mijozning ismi" },
      customer_phone: { type: 'STRING', description: "Telefon raqami (masalan: +998901234567)" },
      region: { type: 'STRING', description: "Shahar yoki viloyat (yetkazish manzili)" },
      delivery_method: { type: 'STRING', description: "Yetkazish usuli: ombordan olib ketish, Toshkent kuryeri yoki viloyatga kargo (ixtiyoriy)" },
      company: { type: 'STRING', description: "Kompaniya yoki biznes nomi (ixtiyoriy)" },
      notes: { type: 'STRING', description: "Mijozning qo'shimcha istaklari (ixtiyoriy)" },
      items: quoteItemsSchema
    },
    required: ['customer_name', 'customer_phone', 'region', 'items']
  }
};

const checkOrderStatusDeclaration = {
  name: 'check_order_status',
  description: "So'rov (buyurtma) raqami orqali holatini tekshirish.",
  parameters: {
    type: 'OBJECT',
    properties: {
      order_id: { type: 'INTEGER', description: "So'rov raqami" }
    },
    required: ['order_id']
  }
};

async function dbCheckOrderStatus(order_id: number, db: Sql | null = sql) {
  if (!db) return { error: "Database not connected" };
  try {
    const data = await db`
      SELECT id, customer_name, delivery_address, items, total_price, status, created_at
      FROM orders WHERE id = ${order_id}
    `;
    if (data.length === 0) return { error: `So'rov topilmadi (raqam: ${order_id})` };
    return { success: true, order: data[0] };
  } catch (err) {
    return { error: String(err) };
  }
}

// Runs one tool call. Everything goes through the catalog module; the schema is guaranteed before the first query.
export async function runTool(name: string, args: any, userContext?: { telegramId?: number; webSessionId?: string }, db: Sql | null = sql) {
  if (!db) return { error: "Database not connected" };
  try {
    if (db === sql) await initDb();
    switch (name) {
      case 'list_products': return await listProducts(db, args?.category);
      case 'search_products': return await searchProducts(db, String(args?.query || ''));
      case 'get_product_details': return await getProduct(db, Number(args?.product_id));
      case 'calculate_quote': return await calculateQuote(db, args?.items);
      case 'create_request': return await createRequest(db, args, userContext);
      case 'check_order_status': return await dbCheckOrderStatus(Number(args?.order_id), db);
      default: return { error: "Unknown function" };
    }
  } catch (err) {
    console.error(`Tool ${name} failed:`, err);
    return { error: String(err) };
  }
}

// --- Conversation history persistence (serverless-safe) ---
const HISTORY_LIMIT = 20;
const SUMMARIZE_THRESHOLD = 30; // when total messages exceed this, summarize older ones

export async function loadHistory(
  userContext: { telegramId?: number; webSessionId?: string }
): Promise<Array<{ role: 'user' | 'model'; content: string }>> {
  if (!sql) return [];
  const { telegramId, webSessionId } = userContext;
  try {
    const rows = telegramId
      ? await sql`
          SELECT role, content FROM conversation_history
          WHERE telegram_id = ${telegramId}
          ORDER BY created_at DESC LIMIT ${HISTORY_LIMIT}
        `
      : webSessionId
      ? await sql`
          SELECT role, content FROM conversation_history
          WHERE web_session_id = ${webSessionId}
          ORDER BY created_at DESC LIMIT ${HISTORY_LIMIT}
        `
      : [];
    return rows.reverse().map((r: any) => ({ role: r.role, content: r.content }));
  } catch (err) {
    console.error("loadHistory error:", err);
    return [];
  }
}

export async function loadSummary(
  userContext: { telegramId?: number; webSessionId?: string }
): Promise<string> {
  if (!sql) return "";
  const { telegramId, webSessionId } = userContext;
  try {
    const rows = telegramId
      ? await sql`SELECT summary FROM conversation_summary WHERE telegram_id = ${telegramId}`
      : webSessionId
      ? await sql`SELECT summary FROM conversation_summary WHERE web_session_id = ${webSessionId}`
      : [];
    return rows[0]?.summary || "";
  } catch (err) {
    console.error("loadSummary error:", err);
    return "";
  }
}

export async function appendHistory(
  userContext: { telegramId?: number; webSessionId?: string },
  role: 'user' | 'model',
  content: string
): Promise<void> {
  if (!sql) return;
  const { telegramId, webSessionId } = userContext;
  if (!telegramId && !webSessionId) return;
  try {
    await sql`
      INSERT INTO conversation_history (telegram_id, web_session_id, role, content)
      VALUES (${telegramId || null}, ${webSessionId || null}, ${role}, ${content})
    `;
    // Fire-and-forget summarization check (don't block response)
    maybeSummarize(userContext).catch(err => console.error("Background summarize error:", err));
  } catch (err) {
    console.error("appendHistory error:", err);
  }
}

async function maybeSummarize(
  userContext: { telegramId?: number; webSessionId?: string }
): Promise<void> {
  if (!sql) return;
  const { telegramId, webSessionId } = userContext;
  try {
    // Count total messages
    const countRes = telegramId
      ? await sql`SELECT COUNT(*)::integer as c FROM conversation_history WHERE telegram_id = ${telegramId}`
      : await sql`SELECT COUNT(*)::integer as c FROM conversation_history WHERE web_session_id = ${webSessionId}`;
    const total = countRes[0]?.c || 0;
    if (total < SUMMARIZE_THRESHOLD) return;

    // Get last summarized boundary
    const sumRes = telegramId
      ? await sql`SELECT summary, last_summarized_history_id FROM conversation_summary WHERE telegram_id = ${telegramId}`
      : await sql`SELECT summary, last_summarized_history_id FROM conversation_summary WHERE web_session_id = ${webSessionId}`;
    const existingSummary = sumRes[0]?.summary || "";
    const lastId = sumRes[0]?.last_summarized_history_id || 0;

    // Fetch older messages (excluding the most recent HISTORY_LIMIT which stay verbatim)
    const oldRows = telegramId
      ? await sql`
          SELECT id, role, content FROM conversation_history
          WHERE telegram_id = ${telegramId} AND id > ${lastId}
          ORDER BY id ASC
          LIMIT ${total - HISTORY_LIMIT}
        `
      : await sql`
          SELECT id, role, content FROM conversation_history
          WHERE web_session_id = ${webSessionId} AND id > ${lastId}
          ORDER BY id ASC
          LIMIT ${total - HISTORY_LIMIT}
        `;
    if (oldRows.length === 0) return;

    const transcript = oldRows.map((r: any) => `${r.role === 'user' ? 'Mijoz' : 'Malika'}: ${r.content}`).join('\n');
    const prompt = `Quyidagi suhbatni 3-5 jumlada qisqacha xulosalang. Mijozning afzalliklari, savatdagi mahsulotlar, qaror qilingan ma'lumotlar (ism, telefon, manzil), tugallanmagan harakatlar haqida yozing. O'zbek tilida.

${existingSummary ? `Avvalgi xulosa:\n${existingSummary}\n\nYangi suhbat:\n` : 'Suhbat:\n'}${transcript}

Yangilangan xulosa:`;

    const response = await generateContentResilient({
      model: CHAT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const newSummary = response.text?.trim() || existingSummary;
    const newLastId = oldRows[oldRows.length - 1].id;

    if (telegramId) {
      await sql`
        INSERT INTO conversation_summary (telegram_id, summary, last_summarized_history_id, updated_at)
        VALUES (${telegramId}, ${newSummary}, ${newLastId}, CURRENT_TIMESTAMP)
        ON CONFLICT (telegram_id) DO UPDATE SET
          summary = EXCLUDED.summary,
          last_summarized_history_id = EXCLUDED.last_summarized_history_id,
          updated_at = CURRENT_TIMESTAMP
      `;
    } else if (webSessionId) {
      await sql`
        INSERT INTO conversation_summary (web_session_id, summary, last_summarized_history_id, updated_at)
        VALUES (${webSessionId}, ${newSummary}, ${newLastId}, CURRENT_TIMESTAMP)
        ON CONFLICT (web_session_id) DO UPDATE SET
          summary = EXCLUDED.summary,
          last_summarized_history_id = EXCLUDED.last_summarized_history_id,
          updated_at = CURRENT_TIMESTAMP
      `;
    }
    console.log(`📝 History summarized (${oldRows.length} messages → 1 summary)`);
  } catch (err) {
    console.error("maybeSummarize error:", err);
  }
}

// Generate embedding vector for a given text using Gemini
export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: [{ parts: [{ text }] }],
      config: { outputDimensionality: 768 }
    });
    return result.embeddings?.[0]?.values || null;
  } catch (err) {
    console.error("Embedding generation error:", err);
    return null;
  }
}

// Several texts in one API call (used by the paketshop.uz sync); null where an item failed
export async function generateEmbeddingsBatch(texts: string[]): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const chunk = texts.slice(i, i + 50);
    try {
      const result = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: chunk.map(text => ({ parts: [{ text }] })),
        config: { outputDimensionality: 768 }
      });
      chunk.forEach((_, k) => out.push(result.embeddings?.[k]?.values ?? null));
    } catch (err) {
      console.error("Batch embedding error:", err);
      chunk.forEach(() => out.push(null));
    }
  }
  return out;
}

// Quick check for greetings or acknowledgments where vector embedding is unnecessary
const SKIP_EMBEDDING_REGEX = /^(salom|assalomu?\s*alaykum|qalaysiz|qale|privet|privyet|hello|hi|hey|ha|xa|yo'q|yoq|ok|mayli|xop|xo'p|rahmat|raxmat|yaxshi|tushundim|yo|net|da|thanks|spasibo)[!.?\s]*$/i;

// RAG: Find top N most relevant knowledge base entries for a query using Hybrid Search
export async function searchKnowledgeBase(query: string, topN: number = 3): Promise<string> {
  if (!sql) return "";
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 3 || SKIP_EMBEDDING_REGEX.test(trimmed)) {
    return ""; // Skip embedding API call and table scan on common greetings & affirmations
  }

  try {
    // Run keyword search and embedding generation in parallel
    const [embedding, keywordData] = await Promise.all([
      generateEmbedding(trimmed),
      sql`
        SELECT id, question, answer, image_url, video_url,
               0.9::double precision as similarity
        FROM knowledge_base
        WHERE question ILIKE ${'%' + trimmed + '%'}
           OR answer ILIKE ${'%' + trimmed + '%'}
        LIMIT ${topN}
      `.catch(e => { console.warn("RAG keyword search err:", e); return []; })
    ]);

    let vectorData: any[] = [];
    if (embedding) {
      const vectorStr = `[${embedding.join(',')}]`;
      vectorData = await sql`
        SELECT id, question, answer, image_url, video_url,
               (1 - (embedding <=> ${vectorStr}::vector))::double precision as similarity
        FROM knowledge_base
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${topN}
      `.catch(e => { console.warn("RAG vector search err:", e); return []; });
    }

    // Merge & Deduplicate
    const resultMap = new Map<number, any>();
    for (const item of keywordData) {
      resultMap.set(item.id, { ...item, type: 'keyword' });
    }
    for (const item of vectorData) {
      if (resultMap.has(item.id)) {
        const existing = resultMap.get(item.id);
        existing.similarity = Math.max(existing.similarity, item.similarity);
        existing.type = 'hybrid';
      } else {
        resultMap.set(item.id, { ...item, type: 'vector' });
      }
    }

    const mergedResults = Array.from(resultMap.values())
      .filter(item => item.similarity >= 0.5)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN);

    if (mergedResults.length === 0) {
      return "";
    }

    const contextStr = mergedResults.map((item: any) => {
      let str = `Savol: ${item.question}\nJavob: ${item.answer}`;
      if (item.image_url) str += `\n[IMAGE: ${item.image_url}]`;
      if (item.video_url) str += `\n[VIDEO: ${item.video_url}]`;
      return str;
    }).join("\n\n");

    return `\n\nQuyidagi ma'lumotlar sening bilimlar bazangdan topilgan eng mos natijalar. Shu ma'lumotlarga asoslanib mijozlarga aniq javob ber. Agar mijozga biror ma'lumotni berayotgan bo'lsang va uning [IMAGE: ...] yoki [VIDEO: ...] yozuvi bo'lsa, albatta shu yozuvlarni javobingning oxiriga o'zgarishsiz qo'shib yubor (faqat borini):\n${contextStr}`;
  } catch (err) {
    console.error("RAG search error:", err);
    return "";
  }
}

export async function getKnowledgeBaseContext() {
  if (!sql) return "";
  try {
    const data = await sql`SELECT question, answer, image_url, video_url FROM knowledge_base`;
    if (data.length === 0) return "";
    const contextStr = data.map((item: any) => {
      let str = `Savol: ${item.question}\nJavob: ${item.answer}`;
      if (item.image_url) str += `\n[IMAGE: ${item.image_url}]`;
      if (item.video_url) str += `\n[VIDEO: ${item.video_url}]`;
      return str;
    }).join("\n\n");
    return `\n\nQuyidagi ma'lumotlar sening bilimlar bazang. Shu ma'lumotlarga asoslanib mijozlarga aniq javob ber. Agar mijozga biror ma'lumotni berayotgan bo'lsang va uning [IMAGE: ...] yoki [VIDEO: ...] yozuvi bo'lsa, albatta shu yozuvlarni javobingning oxiriga o'zgarishsiz qo'shib yubor (faqat borini):\n${contextStr}`;
  } catch (err) {
    console.error("Error fetching knowledge base:", err);
    return "";
  }
}

// Generate TTS speech audio from text using Gemini 3.1
const TTS_MODEL = 'gemini-3.8-flash-tts';
const TTS_FALLBACK_MODEL = 'gemini-3.1-flash-tts-preview';
const TTS_SAMPLE_RATE = 24000;

// Depth-first search for the first audio payload in an Interactions API response
function findAudioData(node: any): string | null {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.data === 'string' && (node.type === 'audio' || String(node.mime_type || '').startsWith('audio/'))) {
    return node.data;
  }
  for (const value of Object.values(node)) {
    const found = findAudioData(value);
    if (found) return found;
  }
  return null;
}

// gemini-3.8 TTS returns WAV with a RIFF header; the web player and Telegram pipeline expect raw 24kHz 16-bit mono PCM
function wavToPcm(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      const rate = buf.readUInt32LE(offset + 12);
      if (rate !== TTS_SAMPLE_RATE) console.warn(`TTS sample rate is ${rate}, expected ${TTS_SAMPLE_RATE}`);
    } else if (id === 'data') {
      const start = offset + 8;
      const end = size === 0xFFFFFFFF ? buf.length : Math.min(start + size, buf.length);
      return buf.subarray(start, end);
    }
    offset += 8 + size + (size % 2);
  }
  return buf.subarray(44);
}

async function synthesizeWithTtsModel(text: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: TTS_MODEL,
      input: [{
        type: 'user_input',
        content: [{
          type: 'text',
          text,
          annotations: [{ type: 'speech_metadata', style: 'warm, friendly, natural conversational tone of a helpful young shop consultant' }]
        }]
      }],
      response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: TTS_SAMPLE_RATE },
      generation_config: { speech_config: [{ voice: 'Kore' }] }
    })
  });
  if (!res.ok) {
    throw new Error(`${TTS_MODEL} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const audio = findAudioData(await res.json());
  if (!audio) return null;
  return wavToPcm(Buffer.from(audio, 'base64')).toString('base64');
}

export async function generateSpeech(text: string): Promise<string | null> {
  const cleanText = text
    .replace(/\[IMAGE:\s*(.*?)\]/gi, '')
    .replace(/\[VIDEO:\s*(.*?)\]/gi, '')
    .replace(/\[BUYURTMA:\s*(.*?)\]/gi, '')
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/\[[^\]]*\]/g, '')   // gemini-3.8 TTS reads text verbatim, so drop leftover [tags]
    .replace(/[#*_]/g, '')
    .trim();

  if (!cleanText) return null;

  try {
    const pcm = await synthesizeWithTtsModel(cleanText);
    if (pcm) return pcm;
  } catch (err) {
    console.warn("TTS model failed, falling back to preview model:", err);
  }

  try {
    const response = await ai.models.generateContent({
      model: TTS_FALLBACK_MODEL,
      contents: [{ parts: [{ text: cleanText }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });
    return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
  } catch (err) {
    console.error("Speech generation error in backend:", err);
    return null;
  }
}

async function loadCustomerContext(
  userContext?: { telegramId?: number; webSessionId?: string }
): Promise<string> {
  if (!sql || !userContext) return "";
  const { telegramId, webSessionId } = userContext;
  if (!telegramId && !webSessionId) return "";

  try {
    const customerRes = telegramId
      ? await sql`SELECT name, phone, address FROM customers WHERE telegram_id = ${telegramId} LIMIT 1`
      : await sql`SELECT name, phone, address FROM customers WHERE web_session_id = ${webSessionId} LIMIT 1`;

    if (!customerRes || customerRes.length === 0) return "";
    const cust = customerRes[0];

    // Fetch last 5 past orders for this customer (non-cancelled)
    let pastOrders: any[] = [];
    if (cust.phone) {
      try {
        pastOrders = await sql`
          SELECT items, total_price, created_at FROM orders 
          WHERE customer_phone = ${cust.phone} AND status != 'cancelled'
          ORDER BY created_at DESC LIMIT 5
        `;
      } catch (orderHistoryErr) {
        console.error("Failed to fetch customer order history:", orderHistoryErr);
      }
    }

    let ordersHistoryText = "";
    if (pastOrders && pastOrders.length > 0) {
      ordersHistoryText = "\nMijozning oldingi so'rovlari:\n" + pastOrders.map(o => {
        let itemsDesc = "";
        try {
          const parsedItems = typeof o.items === 'string' ? JSON.parse(o.items) : o.items;
          itemsDesc = Array.isArray(parsedItems) 
            ? parsedItems.map((i: any) => `${i.name} (${i.packs ?? i.quantity} ${i.unit ?? 'dona'})`).join(", ")
            : "mahsulotlar";
        } catch {
          itemsDesc = "mahsulotlar";
        }
        const orderDate = o.created_at instanceof Date ? o.created_at.toLocaleDateString() : String(o.created_at);
        return `- ${itemsDesc}, Jami summa: ${o.total_price} so'm, Sana: ${orderDate}`;
      }).join("\n");
    }

    return `\n\nMIJOZ CRM MA'LUMOTLARI (saqlangan):
Ismi: ${cust.name || 'Noma\'lum'}
Telefon: ${cust.phone || 'Noma\'lum'}
Hudud: ${cust.address || 'Noma\'lum'}
Qoida: Mijozni ismi bilan hurmat bilan chaqir. So'rov yuborishda ism, telefon va hududni QAYTA SO'RAMA. Buning o'rniga: "Sizning ma'lumotlaringiz saqlangan: ${cust.name}, ${cust.phone}, ${cust.address}. So'rovni shu ma'lumotlar bilan yuboraymi?" deb so'ra. Rozi bo'lsa va mahsulot hamda qadoq soni aniq bo'lsa, "create_request" ni chaqir.${ordersHistoryText ? `\n${ordersHistoryText}\nQoida: Mijozning oldingi so'rovlariga qarab, mos boshqa mahsulotlarni suhbat davomida tabiiy tarzda tavsiya qil.` : ''}`;
  } catch (crmFetchErr) {
    console.error("Failed to fetch CRM user context in loadCustomerContext:", crmFetchErr);
    return "";
  }
}

// Conversational Chat Handler with Function Calling Loop, Parallel Pre-fetch, and Native Streaming
// A photo the customer sent (e.g. a sample cup: "do you have this?")
export type ImageAttachment = { data: string; mimeType: string };

export async function handleConversationalChat(
  message: string,
  history: Array<{ role: 'user' | 'model'; content: string }>,
  userContext?: { telegramId?: number; webSessionId?: string },
  onChunk?: (text: string) => void,
  images?: ImageAttachment[]
): Promise<string> {
  const hasUserContext = !!(userContext && (userContext.telegramId || userContext.webSessionId));

  // Run all context preparation concurrently in parallel
  const [historyResult, ragContext, customerContext] = await Promise.all([
    hasUserContext
      ? Promise.all([loadHistory(userContext!), loadSummary(userContext!)])
      : Promise.resolve<[Array<{ role: 'user' | 'model'; content: string }>, string]>([[], ""]),
    searchKnowledgeBase(message, 2),
    loadCustomerContext(userContext)
  ]);

  const [persistedHistory, summary] = historyResult;
  if (persistedHistory.length > 0) history = persistedHistory;
  const summaryContext = summary
    ? `\n\nSUHBATNING AVVALGI QISMI XULOSASI (eslab qoling, lekin to'g'ridan-to'g'ri takrorlamang):\n${summary}`
    : "";

  const fullSystemInstruction = `${buildSystemInstruction()}\n\n${ragContext}${customerContext}${summaryContext}`;

  const contents: any[] = [];
  for (const turn of history) {
    contents.push({
      role: turn.role,
      parts: [{ text: turn.content }]
    });
  }
  contents.push({
    role: 'user',
    parts: [{ text: message }, ...(images ?? []).map(img => ({ inlineData: { data: img.data, mimeType: img.mimeType } }))]
  });
  // History keeps text only, so mark that a photo was sent
  const historyText = images?.length ? `[Rasm yuborildi] ${message}` : message;

  const tools: any[] = [{
    functionDeclarations: [
      listProductsDeclaration,
      searchProductsDeclaration,
      getProductDetailsDeclaration,
      calculateQuoteDeclaration,
      createRequestDeclaration,
      checkOrderStatusDeclaration
    ]
  }];

  try {
    let loopCount = 0;
    while (loopCount < 5) {
      loopCount++;

      // When tools have already executed (loopCount > 1) and streaming is requested, stream final answer directly!
      if (loopCount > 1 && onChunk) {
        let streamText = "";
        try {
          const stream = await generateContentStreamResilient({
            model: CHAT_MODEL,
            contents: contents,
            config: {
              systemInstruction: fullSystemInstruction,
              temperature: 0.7,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            }
          });

          for await (const chunk of stream) {
            const chunkText = chunk.text;
            if (chunkText) {
              onChunk(chunkText);
              streamText += chunkText;
            }
          }
        } catch (streamErr) {
          console.warn("generateContentStream error, falling back to non-streaming:", streamErr);
          const fallbackRes = await generateContentResilient({
            model: CHAT_MODEL,
            contents: contents,
            config: {
              systemInstruction: fullSystemInstruction,
              temperature: 0.7,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            }
          });
          const parts = fallbackRes.candidates?.[0]?.content?.parts || [];
          streamText = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
          if (streamText) onChunk(streamText);
        }

        const responseText = streamText || "Kechirasiz, men buni tushunmadim.";
        if (userContext) {
          await appendHistory(userContext, 'user', historyText);
          await appendHistory(userContext, 'model', responseText);
        }
        return responseText;
      }

      // First turn: determine if tools need to be called
      const response = await generateContentResilient({
        model: CHAT_MODEL,
        contents: contents,
        config: {
          systemInstruction: fullSystemInstruction,
          temperature: 0.7,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          tools: tools
        }
      });

      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts;
      if (!parts) {
        throw new Error("No response parts from Gemini");
      }

      const functionCallPart = parts.find(p => p.functionCall);
      if (functionCallPart && functionCallPart.functionCall) {
        const { name, args } = functionCallPart.functionCall as any;
        console.log(`🤖 Gemini wants to call: ${name} with args:`, args);

        contents.push({
          role: 'model',
          parts: parts
        });

        const functionResponseData: any = await runTool(name, args, userContext);

        console.log(`🔌 Function ${name} result:`, functionResponseData);

        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: name,
              response: functionResponseData
            }
          }]
        });

        continue;
      }

      // No function call: direct response ready
      const visibleText = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
      const responseText = visibleText || "Kechirasiz, men buni tushunmadim.";

      if (onChunk && responseText) {
        onChunk(responseText);
      }

      if (userContext) {
        await appendHistory(userContext, 'user', historyText);
        await appendHistory(userContext, 'model', responseText);
      }

      return responseText;
    }
    return "Kechirasiz, juda ko'p ichki so'rovlar bajarildi. Iltimos qaytadan urinib ko'ring.";
  } catch (err) {
    console.error("handleConversationalChat error:", err);
    throw err;
  }
}

// Streaming version: runs tool loop and streams text chunk-by-chunk in real-time
export async function handleConversationalChatStream(
  message: string,
  history: Array<{ role: 'user' | 'model'; content: string }>,
  userContext: { telegramId?: number; webSessionId?: string } | undefined,
  onChunk: (text: string) => void,
  images?: ImageAttachment[]
): Promise<string> {
  return await handleConversationalChat(message, history, userContext, onChunk, images);
}

// Transcribe raw audio to text.
// Primary: dedicated Gemini transcribe model (Interactions API). Fallback: general Gemini Flash.
const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
const TRANSCRIBE_FALLBACK_MODEL = CHAT_MODEL;

function extractInteractionText(data: any): string {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts: string[] = [];
  const collect = (items: any) => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (it?.type === 'text' && typeof it.text === 'string') parts.push(it.text);
      else if (Array.isArray(it?.content)) collect(it.content);
    }
  };
  collect(data?.outputs);
  collect(data?.steps);
  return parts.join(' ');
}

async function transcribeWithTranscribeModel(audioBuffer: Buffer, mimeType: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: TRANSCRIBE_MODEL,
      input: [{ type: 'audio', data: audioBuffer.toString('base64'), mime_type: mimeType.split(';')[0].trim() }],
      generation_config: {
        transcription_config: {
          language_codes: ['uz-UZ', 'ru-RU'],
          custom_vocabulary: [BRAND.shopName, BRAND.assistantName]
        }
      }
    })
  });
  if (!res.ok) {
    throw new Error(`${TRANSCRIBE_MODEL} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return extractInteractionText(await res.json()).trim() || null;
}

export async function transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string | null> {
  try {
    const text = await transcribeWithTranscribeModel(audioBuffer, mimeType);
    if (text) return text;
  } catch (err) {
    console.warn("Transcribe model failed, falling back to Flash:", err);
  }
  try {
    const base64Data = audioBuffer.toString('base64');
    const response = await generateContentResilient({
      model: TRANSCRIBE_FALLBACK_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType
              }
            },
            { text: "Ushbu ovozli xabarni faqat matnga o'girib (transkripsiya qilib) ber. Matndan tashqari hech qanday qo'shimcha so'z yoki izoh yozma. Agar ovozda o'zbekcha so'zlashuv bo'lsa, uni toza o'zbek tilida yoz." }
          ]
        }
      ]
    });
    return response.text?.trim() || null;
  } catch (err) {
    console.error("Audio transcription error:", err);
    return null;
  }
}
