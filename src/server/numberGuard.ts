// Guard against a model mis-copying amounts ("3 850 000" quoted as "3 810 000"): every larger number in an answer
// must appear in something the model was actually given (function results, knowledge, the customer's own message).

// 3 910 000 | 3,910,000 | 3.910.000 | 3910000
const AMOUNT = /\d{1,3}(?:[   ,.]\d{3})+(?!\d)|\d{4,}/g;
const MIN_CHECKED = 1000;

export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const n = Number(m[0].replace(/[   ,.]/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// Adds every number found anywhere inside a value (function results are nested objects)
export function collectNumbers(value: unknown, into: Set<number>, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'number' && Number.isFinite(value)) into.add(value);
  else if (typeof value === 'string') amountsIn(value).forEach(n => into.add(n));
  else if (Array.isArray(value)) value.forEach(v => collectNumbers(v, into, depth + 1));
  else if (typeof value === 'object') Object.values(value as object).forEach(v => collectNumbers(v, into, depth + 1));
}

export function allowNumbersFromText(text: string, into: Set<number>): void {
  amountsIn(text).forEach(n => into.add(n));
}

// Uzbek phone numbers ("+998 99 644 84 44", "+998 (90) 123-45-67", "+998901234567") are contacts, not amounts:
// read as amounts, "99 644" would look like an unverified 99 644.
const PHONE = /\+?998[\s-]?\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g;

// Numbers >= 1000 in the answer that were not provided anywhere. Years (1900–2100) and phone numbers are ignored.
export function findUnverifiedNumbers(answer: string, allowed: Set<number>): number[] {
  const bad = new Set<number>();
  for (const n of amountsIn(answer.replace(PHONE, ' '))) {
    if (n < MIN_CHECKED || (n >= 1900 && n <= 2100)) continue;
    if (!allowed.has(n)) bad.add(n);
  }
  return [...bad];
}

export const formatAmount = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');
