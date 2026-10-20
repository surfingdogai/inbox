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

import { ISO_4217_FUNDS, ISO_4217_MINOR_UNITS, minorUnits } from "@surfingdog/spec";

/**
 * The words and signs a currency is written with, and the ISO codes each may mean (ADR-032): `$` is
 * dollars and pesos alike, so an amount beside it is read in the item's own currency when that is one
 * it may mean (a Chilean peso has no minor unit, a dollar has cents), else in the first it names.
 */
const CURRENCY_WORDS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/^r\$$/iu, ["BRL"]],
  [/^€$|^euros?$/iu, ["EUR"]],
  [/^£$|^pounds?$|^quid$|^libras?$/iu, ["GBP"]],
  [/^\$$|^bucks$|^dollars?$|^d[oó]lares?$/iu, ["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN", "CLP", "COP", "ARS"]],
  [/^reais$/iu, ["BRL"]],
  [/^¥$|^yen$/iu, ["JPY", "CNY"]],
  [/^yuan$|^renminbi$/iu, ["CNY"]],
  [/^₹$|^rupees?$/iu, ["INR", "NPR", "LKR", "PKR"]],
  [/^₩$/iu, ["KRW"]],
  [/^₦$|^naira$/iu, ["NGN"]],
  [/^₱$/iu, ["PHP"]],
  [/^₺$|^lira$/iu, ["TRY"]],
  [/^₫$|^dong$/iu, ["VND"]],
  [/^₪$|^shekels?$/iu, ["ILS"]],
  [/^ksh$|^shillings?$/iu, ["KES", "TZS", "UGX"]],
  [/^pesos?$/iu, ["MXN", "CLP", "COP", "ARS", "PHP", "UYU"]],
  [/^dinars?$/iu, ["KWD", "BHD", "JOD", "TND", "IQD", "LYD", "RSD"]],
  [/^dirhams?$/iu, ["AED", "MAD"]],
  [/^riyals?$/iu, ["SAR", "QAR", "OMR"]],
  [/^rand$/iu, ["ZAR"]],
  [/^baht$/iu, ["THB"]],
  [/^ringgit$/iu, ["MYR"]],
  [/^francs?$/iu, ["CHF", "XOF", "XAF", "RWF"]],
  [/^cedis?$/iu, ["GHS"]],
  [/^kr(?:ona|one|onor|oner)?$/iu, ["SEK", "NOK", "DKK", "ISK"]],
];
/**
 * The ISO codes an amount may be written with (KES 4,500): any code a price may be in, but those that
 * are also words a reply carries in any case ("all 30 rooms", "try 2", "12 AWG"), which this reads
 * without regard to capitals.
 */
const WORDS = new Set([
  "ALL",
  "AWG",
  "BAM",
  "BOB",
  "CUP",
  "ERN",
  "GEL",
  "LAK",
  "MAD",
  "MOP",
  "NAD",
  "PEN",
  "SOS",
  "TOP",
  "TRY",
]);
const ISO_CODE = Object.keys(ISO_4217_MINOR_UNITS)
  .filter((c) => !WORDS.has(c) && !ISO_4217_FUNDS.has(c))
  .join("|");
/** A currency beside a number, glued or spaced: never part of a longer word ("Europe", "neuro"). */
const CURRENCY = String.raw`(?:€|£|\$|R\$|¥|₹|₩|₦|₱|₺|₫|₪|(?<!\p{L})(?:${ISO_CODE}|KSh|euros?|pounds?|quid|bucks|libras?|dollars?|d[oó]lares?|reais|yen|yuan|renminbi|rupees?|naira|lira|dong|shekels?|shillings?|pesos?|dinars?|dirhams?|riyals?|rand|baht|ringgit|francs?|cedis?|kr(?:ona|one|onor|oner)?)(?!\p{L}))`;
const NUMBER = String.raw`(\d{1,3}(?:[.,\u0020\u00A0\u202F]\d{3})+(?:[.,]\d{1,3})?|\d+(?:[.,]\d{1,3})?)`;
/** However many spaces on the line, or none: "EUR30", "30  euros". */
const GAP = String.raw`[^\S\r\n]*`;
const BEFORE = new RegExp(`(${CURRENCY})${GAP}${NUMBER}`, "giu");
const AFTER = new RegExp(`${NUMBER}${GAP}(${CURRENCY})`, "giu");

/**
 * The exponent an amount written beside `written` is counted in: its ISO code's, else the item's own
 * currency's when the sign may mean it, else the first currency the sign names.
 */
function exponentOf(written: string, currency: string | undefined): number {
  const code = written.toUpperCase();
  if (/^[A-Z]{3}$/.test(code) && minorUnits(code) !== null) return minorUnits(code) ?? 2;
  const own = currency?.toUpperCase();
  for (const [re, codes] of CURRENCY_WORDS) {
    if (!re.test(written)) continue;
    const chosen = own && codes.includes(own) ? own : codes[0];
    return (chosen ? minorUnits(chosen) : null) ?? 2;
  }
  return (own ? minorUnits(own) : null) ?? 2;
}

/** Numbers as words, in English and Portuguese: an amount spelt out is an amount. */
const NUMBER_WORD = `(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dez[ae]sseis|dez[ae]ssete|dezoito|dez[ae]nove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzentos|trezentos|quatrocentos|quinhentos|seiscentos|setecentos|oitocentos|novecentos|mil)`;
const SPELT = new RegExp(
  String.raw`(?<!\p{L})${NUMBER_WORD}(?:[\s-]+(?:(?:and|e)[\s-]+)?${NUMBER_WORD})*[\s-]+(?:euros?|pounds?|quid|bucks|libras?|dollars?|d[oó]lares?|reais|yen|rupees?|pesos?|dinars?|shillings?|francs?|EUR|GBP|USD|BRL|CHF|JPY|INR|KES|MXN|CAD|AUD|KWD)(?!\p{L})`,
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

/**
 * A written number in minor units of a currency with `exponent` (2 unless said): "1.850,00" and
 * "1,850.00" are both 185000; "18,5" is 1850; "4.500" in a currency of thousandths is 4500.
 */
export function minorOf(written: string, exponent = 2): number | null {
  const s = written.replace(/[\u0020\u00a0\u202f]/gu, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const last = Math.max(lastDot, lastComma);
  let whole = s;
  let fraction = "";
  if (last !== -1) {
    const tail = s.slice(last + 1);
    // Two separators: the last is the decimal one. One: a decimal one only before one or two digits,
    // or three in a currency counted in thousandths.
    if ((lastDot !== -1 && lastComma !== -1) || tail.length <= Math.max(2, exponent)) {
      whole = s.slice(0, last);
      fraction = tail;
    }
  }
  const digits = whole.replace(/[.,]/gu, "");
  if (!/^\d+$/u.test(digits) || !/^\d{0,3}$/u.test(fraction)) return null;
  // A part smaller than the currency's minor unit that is not zero is not an amount of it.
  if (/[1-9]/u.test(fraction.slice(exponent))) return null;
  const value = Number(digits) * 10 ** exponent + Number(fraction.padEnd(exponent, "0").slice(0, exponent) || "0");
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The amounts of money a text names, in minor units, at most `max` of them: each in its currency's own
 * exponent, a sign that may mean several read in `currency` (the item's) when it may mean that.
 */
export function amountsIn(text: string, max = 20, currency?: string): number[] {
  const out = new Set<number>();
  const t = readable(text);
  for (const [re, money, num] of [
    [BEFORE, 1, 2],
    [AFTER, 2, 1],
  ] as const) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const v = minorOf(m[num] ?? "", exponentOf(m[money] ?? "", currency));
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
