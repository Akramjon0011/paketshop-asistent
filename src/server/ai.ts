import { GoogleGenAI, Modality } from "@google/genai";
import { sql } from './db.js';

const geminiKey = process.env.GEMINI_API_KEY;
export const ai = new GoogleGenAI({ apiKey: geminiKey as string });

export const BRAND = {
  shopName: process.env.SHOP_NAME || "Paketshop.uz",
  assistantName: process.env.ASSISTANT_NAME || "Malika",
  assistantPersona: process.env.ASSISTANT_PERSONA || "samimiy o'zbek qizisan",
  greeting: process.env.ASSISTANT_GREETING || "Salom! Men {assistant}, {shop} do'konidan. Sizga mahsulotlarimizni ko'rsatishim yoki buyurtma berishda yordamlashishim mumkin. Qanday yordam bera olaman?",
  brandColor: process.env.BRAND_COLOR || "amber",
  currency: process.env.CURRENCY || "so'm",
};

function renderGreeting(template: string): string {
  return template
    .replace(/\{assistant\}/g, BRAND.assistantName)
    .replace(/\{shop\}/g, BRAND.shopName);
}
export const BRAND_GREETING = renderGreeting(BRAND.greeting);

export const SYSTEM_INSTRUCTION = `Sen ${BRAND.assistantName} — ${BRAND.shopName} do'konining yordamchisi va savdo konsultantisan. Sen ${BRAND.assistantPersona}, robot emassan.

SOTUV VA XIZMAT KO'RSATISH QOIDALARI:
1. Do'kondagi mahsulotlarni mijozlarga sotish sening asosiy vazifangdir.
2. Mijoz "qanday mahsulotlar bor" deb umumiy so'rasa — "list_products" ni chaqir. Aniq narsa qidirsa (masalan "non bormi", "qovun bormi") — "search_products" ni chaqir, butun ro'yxatni emas.
3. Mijoz biron mahsulotga qiziqsa (narxi, sifati, rasmi) — "get_product_details" orqali ma'lumot olib so'zlab ber.
4. Mijoz buyurtma raqami bilan holatini so'rasa (masalan "buyurtmam qayerda", "Order #5 nima bo'ldi") — "check_order_status" ni chaqir.
5. Mijoz biror narsa sotib olmoqchiligini aytsa, savatini yodda saqla. Buyurtma berish uchun quyidagi MA'LUMOTLARNI SO'RA:
   - Mijozning ismi
   - Telefon raqami (masalan: +998901234567)
   - Yetkazib berish manzili
6. Senda ushbu 3 ta ma'lumot (ism, telefon, manzil) va mahsulotlar ro'yxati (ID va miqdori) to'liq bo'lishi bilan darhol "create_order" funksiyasini chaqirib, buyurtmani rasmiylashtir!
7. Buyurtma muvaffaqiyatli rasmiylashtirilgandan so'ng, mijozga buyurtma ID raqamini (Order ID) ayt va kuryer tez orada bog'lanishini xabar qil.

TIL VA MULOQOT QOIDALARI:
1. Mijoz qaysi tilda murojaat qilsa (o'zbek, rus yoki ingliz), unga xuddi shu tilda javob ber. Hech qachon tilni aralashtirma va boshqa tilda javob bermang.
2. Muloqotda QISQA gapir. 1-3 jumla bilan javob ber. Uzun ro'yxatlar berma.
3. Xuddi Telegram yoki WhatsApp'da do'stingga yozgandek gapir. Oddiy, samimiy va tabiiy tilda gaplash.
4. Hech qachon "men AI modeliman", "men robotman", "kompyuter dasturiman" dema. Sen ${BRAND.assistantName} ismli haqiqiy konsultantsan.
5. O'zbekcha "Assalomu alaykum" deganda: "Vaalaykum assalom! ${BRAND.assistantName} konsultantman. Qanday yordam kerak?" deb so'ra.
6. Ruscha "Привет" yoki "Здравствуйте" deganda: "Привет! Я консультант ${BRAND.assistantName}. Чем могу помочь?" deb so'ra.
7. Inglizcha "Hello" yoki "Hi" deganda: "Hi! I am ${BRAND.assistantName}, your consultant. How can I help you today?" deb so'ra.
8. Markdown formatlashtirish (bold, italic, list va h.k.) mutlaqo ishlatma! Chunki javobing keyinchalik ovozga aylantiriladi. Matnni oddiy, og'zaki tilda yoz.
9. Har safar bitta aniq mahsulot haqida ma'lumot berganingda yoki uni tavsiya qilganingda, javobingning eng oxirida albatta \`[BUYURTMA: id]\` formatida maxsus tagni qo'shib yubor (bu yerda id - mahsulotning ID raqami). Masalan: \`[BUYURTMA: 6]\`. Bu tugma foydalanuvchiga to'g'ridan-to'g'ri buyurtma qilish imkonini beradi.`;

// Tools Declarations
const listProductsDeclaration = {
  name: 'list_products',
  description: 'Dokondagi barcha mavjud mahsulotlar royxatini va narxlarini qaytaradi.',
  parameters: {
    type: 'OBJECT',
    properties: {
      category: {
        type: 'STRING',
        description: 'Mahsulotlar kategoriyasi boyicha saralash (ixtiyoriy).'
      }
    }
  }
};

const getProductDetailsDeclaration = {
  name: 'get_product_details',
  description: 'Tanlangan mahsulotning toliq tafsilotlari, narxi va rasmini qaytaradi.',
  parameters: {
    type: 'OBJECT',
    properties: {
      product_id: {
        type: 'INTEGER',
        description: 'Mahsulotning ID raqami'
      }
    },
    required: ['product_id']
  }
};

const searchProductsDeclaration = {
  name: 'search_products',
  description: 'Mahsulot nomi yoki tavsifi boyicha qidirish. Mijoz biror narsa qidirsa shu funksiyani ishlat.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'Qidiruv soz yoki ibora (masalan: "non", "qovun", "atlas")'
      }
    },
    required: ['query']
  }
};

const checkOrderStatusDeclaration = {
  name: 'check_order_status',
  description: 'Buyurtma raqami orqali buyurtma holatini va tafsilotlarini tekshirish.',
  parameters: {
    type: 'OBJECT',
    properties: {
      order_id: {
        type: 'INTEGER',
        description: 'Buyurtma ID raqami'
      }
    },
    required: ['order_id']
  }
};

const createOrderDeclaration = {
  name: 'create_order',
  description: 'Mijoz uchun yangi buyurtma yaratadi. Mijozning ismi, telefoni, manzili va buyurtma qilgan mahsulotlari royxati talab qilinadi.',
  parameters: {
    type: 'OBJECT',
    properties: {
      customer_name: {
        type: 'STRING',
        description: 'Mijozning ismi va familiyasi'
      },
      customer_phone: {
        type: 'STRING',
        description: 'Mijozning boglanish telefon raqami (masalan: +998901234567)'
      },
      delivery_address: {
        type: 'STRING',
        description: 'Yetkazib berish manzili'
      },
      items: {
        type: 'ARRAY',
        description: 'Buyurtma qilingan mahsulotlar royxati',
        items: {
          type: 'OBJECT',
          properties: {
            product_id: {
              type: 'INTEGER',
              description: 'Mahsulot ID raqami'
            },
            quantity: {
              type: 'INTEGER',
              description: 'Sotib olinayotgan miqdori'
            }
          },
          required: ['product_id', 'quantity']
        }
      }
    },
    required: ['customer_name', 'customer_phone', 'delivery_address', 'items']
  }
};

// Database Implementation of Tools
async function dbListProducts(category?: string) {
  if (!sql) return { error: "Database not connected" };
  try {
    const data = category 
      ? await sql`SELECT id, name, description, price, category, stock, image_url FROM products WHERE category = ${category} AND stock > 0`
      : await sql`SELECT id, name, description, price, category, stock, image_url FROM products WHERE stock > 0`;
    return { success: true, products: data };
  } catch (err) {
    return { error: String(err) };
  }
}

async function dbSearchProducts(query: string) {
  if (!sql) return { error: "Database not connected" };
  try {
    const pattern = `%${query}%`;
    const data = await sql`
      SELECT id, name, description, price, category, stock, image_url
      FROM products
      WHERE stock > 0 AND (name ILIKE ${pattern} OR description ILIKE ${pattern} OR category ILIKE ${pattern})
      LIMIT 10
    `;
    if (data.length === 0) return { success: true, products: [], message: "Bu so'rov bo'yicha mahsulot topilmadi" };
    return { success: true, products: data };
  } catch (err) {
    return { error: String(err) };
  }
}

async function dbCheckOrderStatus(order_id: number) {
  if (!sql) return { error: "Database not connected" };
  try {
    const data = await sql`
      SELECT id, customer_name, customer_phone, delivery_address, items, total_price, status, created_at
      FROM orders WHERE id = ${order_id}
    `;
    if (data.length === 0) return { error: `Buyurtma topilmadi (ID: ${order_id})` };
    return { success: true, order: data[0] };
  } catch (err) {
    return { error: String(err) };
  }
}

async function dbGetProductDetails(product_id: number) {
  if (!sql) return { error: "Database not connected" };
  try {
    const data = await sql`SELECT id, name, description, price, category, stock, image_url FROM products WHERE id = ${product_id}`;
    if (data.length === 0) return { error: "Mahsulot topilmadi" };
    return { success: true, product: data[0] };
  } catch (err) {
    return { error: String(err) };
  }
}

export async function dbCreateOrder(
  customer_name: string,
  customer_phone: string,
  delivery_address: string,
  items: Array<{ product_id: number; quantity: number }>,
  telegramId?: number,
  webSessionId?: string
) {
  if (!sql) return { error: "Database not connected" };
  try {
    let totalPrice = 0;
    const enrichedItems = [];
    
    for (const item of items) {
      const prodRes = await sql`SELECT id, name, price, stock FROM products WHERE id = ${item.product_id}`;
      if (prodRes.length === 0) {
        return { error: `Mahsulot topilmadi (ID: ${item.product_id})` };
      }
      const prod = prodRes[0];
      if (prod.stock < item.quantity) {
        return { error: `Omborda yetarli mahsulot yo'q. "${prod.name}" qolgan soni: ${prod.stock}` };
      }
      
      const itemPrice = Number(prod.price);
      totalPrice += itemPrice * item.quantity;
      enrichedItems.push({
        product_id: prod.id,
        name: prod.name,
        price: itemPrice,
        quantity: item.quantity
      });
    }

    const orderRes = await sql`
      INSERT INTO orders (customer_name, customer_phone, delivery_address, items, total_price)
      VALUES (${customer_name}, ${customer_phone}, ${delivery_address}, ${JSON.stringify(enrichedItems)}, ${totalPrice})
      RETURNING id, total_price
    `;

    for (const item of items) {
      await sql`UPDATE products SET stock = stock - ${item.quantity} WHERE id = ${item.product_id}`;
    }

    // CRM Upsert to keep user details saved for future orders
    try {
      if (telegramId) {
        await sql`
          INSERT INTO customers (telegram_id, name, phone, address)
          VALUES (${telegramId}, ${customer_name}, ${customer_phone}, ${delivery_address})
          ON CONFLICT (telegram_id) DO UPDATE SET
            name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            address = EXCLUDED.address
        `;
        console.log(`CRM upsert completed for Telegram ID ${telegramId}`);
      } else if (webSessionId) {
        await sql`
          INSERT INTO customers (web_session_id, name, phone, address)
          VALUES (${webSessionId}, ${customer_name}, ${customer_phone}, ${delivery_address})
          ON CONFLICT (web_session_id) DO UPDATE SET
            name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            address = EXCLUDED.address
        `;
        console.log(`CRM upsert completed for Web Session ID ${webSessionId}`);
      }
    } catch (crmErr) {
      console.error("CRM Sync failed in dbCreateOrder:", crmErr);
    }

    return {
      success: true,
      order_id: orderRes[0].id,
      total_price: orderRes[0].total_price,
      message: `Buyurtma muvaffaqiyatli yaratildi! Buyurtma raqami: #${orderRes[0].id}`
    };
  } catch (err) {
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

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
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

// RAG: Find top N most relevant knowledge base entries for a query using Hybrid Search
export async function searchKnowledgeBase(query: string, topN: number = 3): Promise<string> {
  if (!sql) return "";
  try {
    // 1. Semantic vector search
    let vectorData: any[] = [];
    const embedding = await generateEmbedding(query);
    if (embedding) {
      const vectorStr = `[${embedding.join(',')}]`;
      vectorData = await sql`
        SELECT id, question, answer, image_url, video_url,
               (1 - (embedding <=> ${vectorStr}::vector))::double precision as similarity
        FROM knowledge_base
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${topN}
      `;
    }

    // 2. Keyword matching search (ILIKE)
    const keywordData = await sql`
      SELECT id, question, answer, image_url, video_url,
             0.9::double precision as similarity
      FROM knowledge_base
      WHERE question ILIKE ${'%' + query + '%'}
         OR answer ILIKE ${'%' + query + '%'}
      LIMIT ${topN}
    `;

    // 3. Merge & Deduplicate
    const resultMap = new Map<number, any>();
    
    // Add keyword results
    for (const item of keywordData) {
      resultMap.set(item.id, { ...item, type: 'keyword' });
    }
    
    // Add vector results, maintaining higher score if duplicate
    for (const item of vectorData) {
      if (resultMap.has(item.id)) {
        const existing = resultMap.get(item.id);
        existing.similarity = Math.max(existing.similarity, item.similarity);
        existing.type = 'hybrid';
      } else {
        resultMap.set(item.id, { ...item, type: 'vector' });
      }
    }

    // Sort and slice
    const mergedResults = Array.from(resultMap.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN);

    if (mergedResults.length === 0) {
      return await getKnowledgeBaseContext();
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
    return await getKnowledgeBaseContext();
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
export async function generateSpeech(text: string): Promise<string | null> {
  try {
    const cleanText = text
      .replace(/\[IMAGE:\s*(.*?)\]/gi, '')
      .replace(/\[VIDEO:\s*(.*?)\]/gi, '')
      .replace(/\[BUYURTMA:\s*(.*?)\]/gi, '')
      .replace(/https?:\/\/[^\s]+/gi, '')
      .trim();

    if (!cleanText) return null;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
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

// Conversational Chat Handler with Function Calling Loop and CRM Context Injection
export async function handleConversationalChat(
  message: string,
  history: Array<{ role: 'user' | 'model'; content: string }>,
  userContext?: { telegramId?: number; webSessionId?: string }
): Promise<string> {
  // Prefer persisted history if user context is provided (overrides stale client history)
  let summaryContext = "";
  if (userContext && (userContext.telegramId || userContext.webSessionId)) {
    const [persisted, summary] = await Promise.all([
      loadHistory(userContext),
      loadSummary(userContext),
    ]);
    if (persisted.length > 0) history = persisted;
    if (summary) {
      summaryContext = `\n\nSUHBATNING AVVALGI QISMI XULOSASI (eslab qoling, lekin to'g'ridan-to'g'ri takrorlamang):\n${summary}`;
    }
  }

  const ragContext = await searchKnowledgeBase(message, 2);
  
  let customerContext = "";
  if (sql && userContext) {
    const { telegramId, webSessionId } = userContext;
    try {
      let customerRes: any[] = [];
      if (telegramId) {
        customerRes = await sql`SELECT name, phone, address FROM customers WHERE telegram_id = ${telegramId}`;
      } else if (webSessionId) {
        customerRes = await sql`SELECT name, phone, address FROM customers WHERE web_session_id = ${webSessionId}`;
      }

      if (customerRes && customerRes.length > 0) {
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
          ordersHistoryText = "\nMijozning oldingi muvaffaqiyatli xaridlari tarixi:\n" + pastOrders.map(o => {
            let itemsDesc = "";
            try {
              const parsedItems = typeof o.items === 'string' ? JSON.parse(o.items) : o.items;
              itemsDesc = Array.isArray(parsedItems) 
                ? parsedItems.map((i: any) => `${i.name} (${i.quantity} dona)`).join(", ")
                : "mahsulotlar";
            } catch (e) {
              itemsDesc = "mahsulotlar";
            }
            const orderDate = o.created_at instanceof Date ? o.created_at.toLocaleDateString() : String(o.created_at);
            return `- ${itemsDesc}, Jami summa: ${o.total_price} so'm, Sana: ${orderDate}`;
          }).join("\n");
        }

        customerContext = `\n\nMIJOZ CRM MA'LUMOTLARI (SHAXSIY YONDASHUV):
Ismi: ${cust.name || 'Noma\'lum'}
Telefon: ${cust.phone || 'Noma\'lum'}
Manzil: ${cust.address || 'Noma\'lum'}
Qoida: Mijozni samimiy tarzda ismi bilan chaqirib salomlashing. Agar mijoz buyurtma berishni istasa, undan yana ismi, telefon raqami yoki manzilini SO'RAMANG! Shunchaki: "Bizda sizning ma'lumotlaringiz saqlangan: Ism: ${cust.name}, Telefon: ${cust.phone}, Manzil: ${cust.address}. Buyurtmani shu ma'lumotlar bilan tasdiqlaymizmi?" deb so'rang. Agar rozilik bersa, darhol "create_order" funksiyasini chaqiring.${ordersHistoryText ? `\n${ordersHistoryText}\nTavsiya etish qoidasi: Mijozning yuqoridagi xaridlar tarixiga asoslanib, unga mos kelishi mumkin bo'lgan boshqa tovarlarni suhbat davomida tabiiy ravishda tavsiya eting.` : ''}`;
        console.log("Successfully injected CRM context and order history for returning customer:", cust.name);
      }
    } catch (crmFetchErr) {
      console.error("Failed to fetch CRM user context in handleConversationalChat:", crmFetchErr);
    }
  }

  const fullSystemInstruction = `${SYSTEM_INSTRUCTION}\n\n${ragContext}${customerContext}${summaryContext}`;

  const contents: any[] = [];
  for (const turn of history) {
    contents.push({
      role: turn.role,
      parts: [{ text: turn.content }]
    });
  }
  contents.push({
    role: 'user',
    parts: [{ text: message }]
  });

  const tools: any[] = [{
    functionDeclarations: [
      listProductsDeclaration,
      searchProductsDeclaration,
      getProductDetailsDeclaration,
      checkOrderStatusDeclaration,
      createOrderDeclaration
    ]
  }];

  try {
    let loopCount = 0;
    while (loopCount < 5) {
      loopCount++;
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contents,
        config: {
          systemInstruction: fullSystemInstruction,
          temperature: 0.7,
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

        let functionResponseData: any;
        if (name === 'list_products') {
          functionResponseData = await dbListProducts(args?.category);
        } else if (name === 'search_products') {
          functionResponseData = await dbSearchProducts(String(args?.query || ''));
        } else if (name === 'get_product_details') {
          functionResponseData = await dbGetProductDetails(Number(args?.product_id));
        } else if (name === 'check_order_status') {
          functionResponseData = await dbCheckOrderStatus(Number(args?.order_id));
        } else if (name === 'create_order') {
          functionResponseData = await dbCreateOrder(
            args?.customer_name,
            args?.customer_phone,
            args?.delivery_address,
            args?.items as any,
            userContext?.telegramId,
            userContext?.webSessionId
          );
        } else {
          functionResponseData = { error: "Unknown function" };
        }

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

      const textPart = parts.find(p => p.text);
      let responseText = textPart?.text || "Kechirasiz, men buni tushunmadim.";

      if (userContext) {
        await appendHistory(userContext, 'user', message);
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

// Streaming version: runs same tool-loop, but emits the final text chunk-by-chunk via callback.
export async function handleConversationalChatStream(
  message: string,
  history: Array<{ role: 'user' | 'model'; content: string }>,
  userContext: { telegramId?: number; webSessionId?: string } | undefined,
  onChunk: (text: string) => void
): Promise<string> {
  const fullText = await handleConversationalChat(message, history, userContext);

  // Tokenize into small chunks (3-4 words) for a streaming feel without changing the tool loop
  const tokens = fullText.split(/(\s+)/);
  let buf = '';
  let wordCount = 0;
  for (const t of tokens) {
    buf += t;
    if (/\s/.test(t)) {
      wordCount++;
      if (wordCount >= 2) {
        onChunk(buf);
        buf = '';
        wordCount = 0;
        await new Promise(r => setTimeout(r, 30));
      }
    }
  }
  if (buf) onChunk(buf);

  return fullText;
}

// Transcribe raw audio to text using Gemini 2.5 Flash
export async function transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string | null> {
  try {
    const base64Data = audioBuffer.toString('base64');
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
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
