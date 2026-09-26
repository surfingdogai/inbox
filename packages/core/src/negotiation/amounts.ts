/**
 * Amounts of money in words (ADR-018 §4): an online message that holds every element of a contract is
 * a binding proposal (DL 7/2004 art. 32(1)), so what automation writes to a customer may name only the
 * amounts the item's terms or the catalogue already hold. A reply naming another — a price, a discount
 * — is a person's to send. Pure: this finds the amounts; the write path decides what they may be.
 *
 * Only a number beside a currency (€ 40, 40,00 €, EUR 40, EUR40, £12.50, 40 euros, forty euros) is an
 * amount, so a time, a date, a party size or a phone number never is; a percentage is one when the text
 * says it is taken off (40% off, 10 per cent off, 10% de desconto), and so is half a price or all of it.
 */

/** A currency beside a number, glued or spaced: never part of a longer word ("Europe", "neuro"). */
const CURRENCY = String.raw`(?:€|£|\$|R\$|(?<!\p{L})(?:EUR|GBP|USD|BRL|CHF|euros?|pounds?|quid|bucks|libras?|dollars?|d[oó]lares?|reais)(?!\p{L}))`;
const NUMBER = String.raw`(\d{1,3}(?:[.,\u0020\u00A0\u202F]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
/** However many spaces on the line, or none: "EUR30", "30  euros". */
const GAP = String.raw`[^\S\r\n]*`;
const BEFORE = new RegExp(`${CURRENCY}${GAP}${NUMBER}`, "giu");
const AFTER = new RegExp(`${NUMBER}${GAP}${CURRENCY}`, "giu");
/** Numbers as words, in English and Portuguese: an amount spelt out is an amount. */
const NUMBER_WORD = `(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dez[ae]sseis|dez[ae]ssete|dezoito|dez[ae]nove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzentos|trezentos|quatrocentos|quinhentos|seiscentos|setecentos|oitocentos|novecentos|mil)`;
const SPELT = new RegExp(
  String.raw`(?<!\p{L})${NUMBER_WORD}(?:[\s-]+(?:(?:and|e)[\s-]+)?${NUMBER_WORD})*[\s-]+(?:euros?|pounds?|quid|bucks|libras?|dollars?|d[oó]lares?|reais|EUR|GBP|USD|BRL|CHF)(?!\p{L})`,
  "iu",
);
const PERCENT = new RegExp(
  String.raw`(?:\d{1,3}(?:[.,]\d+)?|(?<!\p{L})${NUMBER_WORD})\s?(?:%|percent(?!\p{L})|per\s?cent(?!\p{L})|por\s?cento(?!\p{L}))`,
  "iu",
);
const TAKEN_OFF =
  /\b(?:off|discount(?:ed)?|reduction|reduced|cheaper|less|saving|desconto|descontos|abatimento|redu[çc][ãa]o|reduzido|mais barato)\b/iu;
/** Something off a price with no number at all: half of it, or all of it. */
const GIVEN =
  /(?<!\p{L})(?:half[\s-]?price|half\s+off|on\s+the\s+house|for\s+free|free\s+of\s+charge|at\s+no\s+(?:extra\s+|additional\s+)?(?:cost|charge)|no\s+charge|waiv(?:e|ed|ing)\s+(?:the\s+|your\s+)?(?:fee|charge|price|cost|deposit)|(?:a\s+)?meio\s+pre[çc]o|metade\s+do\s+pre[çc]o|gr[áa]tis|gratuit(?:o|a|os|as|amente)|de\s+gra[çc]a|de\s+borla|sem\s+(?:qualquer\s+)?custos?)(?!\p{L})/iu;

/**
 * The text as a customer reads it: full-width and other compatible digits and signs as plain ones,
 * and no invisible characters between a number and its currency.
 */
const readable = (text: string): string => text.normalize("NFKC").replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/gu, "");

/** A written number in minor units: "1.850,00" and "1,850.00" are both 185000; "18,5" is 1850. */
export function minorOf(written: string): number | null {
  const s = written.replace(/[   ]/gu, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const last = Math.max(lastDot, lastComma);
  let whole = s;
  let fraction = "";
  if (last !== -1) {
    const tail = s.slice(last + 1);
    // Two separators: the last is the decimal one. One: a decimal one only before one or two digits.
    if ((lastDot !== -1 && lastComma !== -1) || tail.length <= 2) {
      whole = s.slice(0, last);
      fraction = tail;
    }
  }
  const digits = whole.replace(/[.,]/gu, "");
  if (!/^\d+$/u.test(digits) || !/^\d{0,2}$/u.test(fraction)) return null;
  const value = Number(digits) * 100 + Number(fraction.padEnd(2, "0") || "0");
  return Number.isSafeInteger(value) ? value : null;
}

/** The amounts of money a text names, in minor units, at most `max` of them. */
export function amountsIn(text: string, max = 20): number[] {
  const out = new Set<number>();
  const t = readable(text);
  for (const re of [BEFORE, AFTER]) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const v = minorOf(m[1] ?? "");
      if (v !== null) out.add(v);
      if (out.size >= max) return [...out];
    }
  }
  return [...out];
}

/**
 * Whether a text offers something off a price: a percentage beside the words that take it off, or
 * half of it or all of it ("half price", "on the house", "grátis").
 */
export function discountIn(text: string): boolean {
  const t = readable(text);
  return (PERCENT.test(t) && TAKEN_OFF.test(t)) || GIVEN.test(t);
}

/** Whether a text spells an amount of money out in words ("thirty euros", "trinta euros"): never one we can match. */
export function speltAmountIn(text: string): boolean {
  return SPELT.test(readable(text));
}

/**
 * Every amount a value holds, in minor units: each `{value, currency}` in it, and each line's total
 * (its price times its quantity). What an item's payload holds is what its terms already say.
 */
export function amountsHeld(value: unknown, out: Set<number> = new Set()): Set<number> {
  if (Array.isArray(value)) {
    for (const v of value) amountsHeld(v, out);
    return out;
  }
  if (typeof value !== "object" || value === null) return out;
  const o = value as Record<string, unknown>;
  if (typeof o.value === "number" && typeof o.currency === "string" && Number.isSafeInteger(o.value)) {
    out.add(o.value);
  }
  const price = o.price as { value?: unknown } | undefined;
  if (typeof o.quantity === "number" && typeof price?.value === "number") {
    const total = price.value * o.quantity;
    if (Number.isSafeInteger(total)) out.add(total);
  }
  for (const v of Object.values(o)) if (typeof v === "object" && v !== null) amountsHeld(v, out);
  return out;
}
