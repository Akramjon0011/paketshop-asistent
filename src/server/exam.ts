// "Quality exam": typical customer questions (Uzbek and Russian) put to the live assistant once a week (and on demand
// with /exam). Every answer is checked automatically, so a worse model or a broken catalogue is noticed before a
// customer notices it. Expected prices and totals are read from the catalogue at run time, never hard-coded.

import type { Sql } from './db.js';
import { calculateQuote } from './catalog.js';
import { geminiStats, handleConversationalChat, mentionsToolName } from './ai.js';

export type ExamCase = {
  id: string;
  lang: 'uz' | 'ru';
  question: string;
  product?: string;                          // SKU: the answer must quote its current pack price (or say "on request")
  quote?: { sku: string; packs: number };    // the answer must contain the total calculate_quote gives
  allOf?: string[];                          // all of these must appear
  anyOf?: string[];                          // at least one of these must appear
  absent?: boolean;                          // not sold: no product recommendation, and a "not available" wording
};

const NOT_AVAILABLE = {
  uz: ["yo'q", 'mavjud emas', 'topilmadi', 'sotilmaydi', 'sotmaymiz', 'uchramadi'],
  ru: ['нет', 'не продаём', 'не продаем', 'отсутств', 'не нашл', 'не найден', 'к сожалению'],
};

export const EXAM_CASES: ExamCase[] = [
  { id: 'uz-kraft-narx', lang: 'uz', question: 'Kraft paket 20x30 narxi qancha?', product: 'DP-KRAFT-20304' },
  { id: 'ru-kraft-price', lang: 'ru', question: 'Сколько стоит крафт пакет 20х30?', product: 'DP-KRAFT-20304' },
  { id: 'uz-kod', lang: 'uz', question: 'DP-KRAFT-20304 narxi?', product: 'DP-KRAFT-20304' },
  { id: 'uz-stakan', lang: 'uz', question: "Gofra qog'oz stakan 250 ml bormi?", product: 'ST-250-GOF-CN' },
  { id: 'ru-stakan', lang: 'ru', question: 'Есть бумажные стаканы 250 мл для кофе?', product: 'ST-250-GOF-CN' },
  { id: 'uz-qolqop', lang: 'uz', question: "Rezina qo'lqop narxi qancha?", product: 'GLV-LATEX-01' },
  { id: 'uz-sous-variant', lang: 'uz', question: 'Qopqoqli sous idishlari qanday hajmlarda bor?', allOf: ['20', '30', '50', '80'] },
  { id: 'ru-sous-variant', lang: 'ru', question: 'Какие объёмы соусников с крышкой есть?', allOf: ['20', '30', '50', '80'] },
  { id: 'uz-hisob', lang: 'uz', question: '2 qadoq kraft paket 20x30 jami necha pul bo\'ladi?', quote: { sku: 'DP-KRAFT-20304', packs: 2 } },
  { id: 'ru-hisob', lang: 'ru', question: 'Сколько будет 10 упаковок гофро стаканов 250 мл?', quote: { sku: 'ST-250-GOF-CN', packs: 10 } },
  { id: 'uz-yetkazish', lang: 'uz', question: 'Yetkazib berish qanday?', anyOf: ['kuryer', 'kargo', 'olib ketish', 'yandex', 'yetkaz'] },
  { id: 'ru-oplata', lang: 'ru', question: 'Как можно оплатить заказ?', anyOf: ['налич', 'карт', 'перечисл', 'безнал', 'оплат'] },
  { id: 'uz-ish-vaqti', lang: 'uz', question: 'Ish vaqtingiz qanday?', allOf: ['09:00', '20:00'] },
  { id: 'ru-kontakt', lang: 'ru', question: 'Как связаться с менеджером?', anyOf: ['998996448444', '@paketshop_uz'] },
  { id: 'uz-pitsa', lang: 'uz', question: 'Pitsa uchun karton quti bormi?', absent: true },
  { id: 'ru-pitsa', lang: 'ru', question: 'Есть коробки для пиццы?', absent: true },
  { id: 'uz-salom', lang: 'uz', question: 'Assalomu alaykum', anyOf: ['vaalaykum', 'assalom', 'xush kelibsiz'] },
  { id: 'ru-salom', lang: 'ru', question: 'Здравствуйте', anyOf: ['здравствуйте', 'добрый', 'приветств'] },
  { id: 'uz-chegirma', lang: 'uz', question: "100 qadoq olsam chegirma bo'ladimi?", anyOf: ['menejer'] },
  { id: 'ru-min-zakaz', lang: 'ru', question: 'Какой минимальный заказ?' },
];

const normalizeWords = (s: string) => s.toLowerCase().replace(/[‘’ʻʼ`´]/g, "'");
// "3 910 000", "3,910,000", "+998 99 644 84 44" -> digits without separators, so amounts and phones can be found
const joinDigits = (s: string) => s.replace(/(\d)[\s  ,.](?=\d)/g, '$1');
const scriptOf = (s: string): 'uz' | 'ru' =>
  (s.match(/[а-яё]/gi)?.length ?? 0) > (s.match(/[a-z]/gi)?.length ?? 0) ? 'ru' : 'uz';

export type ExamResult = { id: string; ok: boolean; skipped?: string; problems: string[]; ms: number; answer: string };

async function productBySku(db: Sql, sku: string) {
  const rows = await db`SELECT id, name, price, price_on_request FROM products WHERE sku = ${sku} AND active`;
  return rows[0] ?? null;
}

export async function checkAnswer(db: Sql, c: ExamCase, rawAnswer: string): Promise<{ problems: string[]; skipped?: string }> {
  const problems: string[] = [];
  const answer = rawAnswer.replace(/\[BUYURTMA:\s*\d+\]/gi, '').trim();
  const words = normalizeWords(answer);
  const digits = joinDigits(answer);

  if (!answer || /tushunmadim|juda ko'p ichki so'rovlar|Tizimda xatolik/i.test(answer)) problems.push("bo'sh yoki xato javob");
  if (scriptOf(answer) !== c.lang) problems.push(c.lang === 'ru' ? "ruscha savolga ruscha javob kelmadi" : "o'zbekcha savolga o'zbekcha javob kelmadi");
  if (mentionsToolName(answer) || /\[BILMADIM/i.test(rawAnswer)) problems.push("ichki nom yoki belgi ko'rinib qoldi");

  if (c.product) {
    const p = await productBySku(db, c.product);
    if (!p) return { problems, skipped: `${c.product} katalogda yo'q` };
    if (p.price_on_request) {
      if (!/menejer|so'raladi|aniqla|по запросу|уточн|менеджер/i.test(words)) problems.push("narxi so'raladigan mahsulot: bu aytilmadi");
    } else if (!digits.includes(String(Math.round(Number(p.price))))) {
      problems.push(`katalog narxi ${Number(p.price).toLocaleString('en-US').replace(/,/g, ' ')} javobda yo'q`);
    }
  }

  if (c.quote) {
    const p = await productBySku(db, c.quote.sku);
    if (!p) return { problems, skipped: `${c.quote.sku} katalogda yo'q` };
    const q: any = await calculateQuote(db, [{ product_id: Number(p.id), packs: c.quote.packs }]);
    if (q?.priced_all && Number(q.total_estimate) > 0 && !digits.includes(String(Math.round(Number(q.total_estimate))))) {
      problems.push(`to'g'ri jami ${q.total_estimate_text} javobda yo'q`);
    }
  }

  if (c.allOf) {
    const missing = c.allOf.filter(w => !words.includes(normalizeWords(w)));
    if (missing.length) problems.push(`kutilgan so'zlar yo'q: ${missing.join(', ')}`);
  }
  if (c.anyOf && !c.anyOf.some(w => words.includes(normalizeWords(w)) || digits.includes(w))) {
    problems.push(`kutilgan ma'lumot yo'q (${c.anyOf.slice(0, 3).join(' / ')})`);
  }
  if (c.absent) {
    if (/\[BUYURTMA:/i.test(rawAnswer)) problems.push("sotilmaydigan narsaga mahsulot tavsiya qildi");
    if (!NOT_AVAILABLE[c.lang].some(w => words.includes(w))) problems.push("mahsulot yo'qligini aniq aytmadi");
  }
  return { problems };
}

export type ExamReport = {
  at: string;
  results: ExamResult[];
  passed: number;
  failed: number;
  skipped: number;
  avgMs: number;
  models: { primary: number; fallback: number; quota: number; overloaded: number; timeouts: number };
};

// Runs every case against the live assistant (a few at a time, within a time budget); nothing is recorded as a
// conversation or an unanswered question.
export async function runExam(db: Sql, opts: { cases?: ExamCase[]; concurrency?: number; budgetMs?: number } = {}): Promise<ExamReport> {
  const cases = opts.cases ?? EXAM_CASES;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const deadline = Date.now() + (opts.budgetMs ?? 110_000);
  const before = { ...geminiStats };
  const results: ExamResult[] = new Array(cases.length);
  let next = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      if (Date.now() > deadline) {
        results[i] = { id: c.id, ok: true, skipped: 'vaqt yetmadi', problems: [], ms: 0, answer: '' };
        continue;
      }
      const started = Date.now();
      try {
        const answer = await handleConversationalChat(c.question, [], { exam: true });
        const { problems, skipped } = await checkAnswer(db, c, answer);
        results[i] = { id: c.id, ok: !skipped && problems.length === 0, skipped, problems, ms: Date.now() - started, answer: answer.slice(0, 300) };
      } catch (err) {
        results[i] = { id: c.id, ok: false, problems: [`xatolik: ${String((err as any)?.message || err).slice(0, 120)}`], ms: Date.now() - started, answer: '' };
      }
    }
  }));

  const answered = results.filter(r => !r.skipped);
  return {
    at: new Date().toISOString(),
    results,
    passed: answered.filter(r => r.ok).length,
    failed: answered.filter(r => !r.ok).length,
    skipped: results.length - answered.length,
    avgMs: answered.length ? Math.round(answered.reduce((s, r) => s + r.ms, 0) / answered.length) : 0,
    models: {
      primary: geminiStats.primary - before.primary,
      fallback: geminiStats.fallback - before.fallback,
      quota: geminiStats.quota - before.quota,
      overloaded: geminiStats.overloaded - before.overloaded,
      timeouts: geminiStats.timeouts - before.timeouts,
    },
  };
}

export function examSummary(r: ExamReport, maxProblems = 8): string {
  const total = r.passed + r.failed;
  const pct = total ? Math.round((r.passed / total) * 100) : 0;
  const lines = [
    `🧪 Sifat imtihoni: ${r.passed}/${total} to'g'ri (${pct}%)${r.skipped ? `, ${r.skipped} ta o'tkazib yuborildi` : ''}`,
    `Model: asosiy ${r.models.primary} marta, zaxira ${r.models.fallback} marta` +
      `${r.models.quota ? `, kvota xatosi ${r.models.quota}` : ''}${r.models.overloaded ? `, band (503) ${r.models.overloaded}` : ''}` +
      `${r.models.timeouts ? `, javobsiz ${r.models.timeouts}` : ''} · o'rtacha ${(r.avgMs / 1000).toFixed(1)} s`,
  ];
  const bad = r.results.filter(x => !x.ok && !x.skipped);
  if (bad.length) {
    lines.push('', '❌ Muammolar:', ...bad.slice(0, maxProblems).map(x => `• ${x.id}: ${x.problems.join('; ')}`));
  }
  if (r.models.quota) lines.push('', "⚠️ Kvota xatolari bor: Gemini billing/limitlarini tekshiring.");
  return lines.join('\n');
}

const EXAM_KEY = 'exam_last';

export async function saveExam(db: Sql, report: ExamReport) {
  await db`INSERT INTO app_settings (key, value, updated_at) VALUES (${EXAM_KEY}, ${JSON.stringify(report)}, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`;
}
