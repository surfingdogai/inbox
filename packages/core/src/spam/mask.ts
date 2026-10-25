import { hostOf, registrableDomain, withoutInvisible } from "./normalise";

/**
 * What the AI check is sent of a message (ADR-029 §7.3): the words, with every email address, phone
 * number, bank account, card number and full link taken out. The check still reads "send the payment
 * to [bank account]", and none of the data. Masking runs before anything leaves the inbox.
 */

/** Letters with their marks (Devanagari's vowel signs, Thai's, an accent typed apart from its letter). */
const EMAIL = /[\p{L}\p{M}\p{N}._%+-]+@[\p{L}\p{M}\p{N}.-]+\.[\p{L}\p{M}]{2,}/gu;
/** A payment address with no top-level domain, as instant-payment systems write them (name@bank). */
const PAY_ADDRESS = /[\p{L}\p{M}\p{N}._-]{2,}@[\p{L}\p{M}]{2,}(?![\p{L}\p{M}\p{N}@-]|\.[\p{L}\p{M}\p{N}])/gu;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+/giu;
/** An IBAN as people write it: a country, two check digits, then groups of letters and digits. */
const IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,4})?\b/gi;
/** Thirteen to nineteen digits, spaced or dashed as cards are printed. */
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
/** Seventeen digits or more in one run: an account number (a card's would have passed the Luhn check). */
const ACCOUNT = /\b\d(?:[ -]?\d){16,33}\b/g;
/** A run that holds seven digits or more, as phone numbers are written anywhere, with any dash between. */
const PHONE = /(?:\+|00)?\(?\d[\d\s().\-/\u2010-\u2015\u2212\u30fc\u3000]{5,}\d/g;
/** Dates and times are not phone numbers. */
const DATE_LIKE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})(?:[ T]\d{1,2}[:.]\d{2})?$/;

/** The Luhn check every card number passes. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

/** The value of a decimal digit in any script: Unicode writes each script's ten in a run from zero. */
function digitValue(cp: number): number {
  let k = 0;
  while (k < 60 && /\p{Nd}/u.test(String.fromCodePoint(cp - k - 1))) k++;
  return k % 10;
}

/**
 * Digits in any script as ASCII digits, and the full-width forms of ASCII as ASCII ("０９０－１２３４",
 * "ｍａｒｉａ＠ｇｍａｉｌ．ｃｏｍ", "۰۹۱۲"), so what is masked is found however it was typed. Nothing
 * else in the text changes.
 */
export function foldForMask(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCodePoint(cp - 0xfee0);
    else if (cp > 0x7f && /\p{Nd}/u.test(ch)) out += String(digitValue(cp));
    else out += ch;
  }
  return out;
}

/** The text with its personal data taken out. */
export function mask(text: string): string {
  return foldForMask(text)
    .replace(URL, (url) => {
      const host = hostOf(url.replace(/[.,;:!?]+$/, ""));
      return host ? `[link to ${registrableDomain(host)}]` : "[link]";
    })
    .replace(EMAIL, "[email]")
    .replace(PAY_ADDRESS, "[payment address]")
    .replace(IBAN, (m) => (/\d.*\d.*\d.*\d/.test(m.slice(4)) ? "[bank account]" : m))
    .replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number]" : m))
    .replace(ACCOUNT, "[bank account]")
    .replace(PHONE, phoneOf);
}

/**
 * Where two numbers written one after the other part, from the surest: a slash, a line, a spaced
 * dash, two spaces; then any one space (an ideographic one too); then a dot between digits.
 */
const BETWEEN_NUMBERS = [/(\s*[/\n]\s*|\s+[-\u2010-\u2015\u2212]\s+|\s{2,})/, /(\s+)/, /((?<=\d)\.(?=\d))/];

/**
 * A run of digits as a phone number, or as it is; a run too long for one number, each part on its
 * own. Never a run of seven digits or more left as written: what no split parts cleanly is one number.
 */
function phoneOf(m: string): string {
  const digits = m.replace(/\D/g, "");
  if (digits.length < 7) return m;
  if (DATE_LIKE.test(m.trim())) return m;
  if (digits.length <= 16) return "[phone]";
  for (const between of BETWEEN_NUMBERS) {
    const parts = m.split(between);
    if (parts.length === 1) continue;
    const out = parts.map((p, i) => (i % 2 === 1 ? p : phoneOf(p))).join("");
    if (![...out.matchAll(new RegExp(PHONE))].some((r) => r[0].replace(/\D/g, "").length >= 7)) return out;
  }
  return "[phone]";
}

/**
 * The text the AI check reads: quoted history cut, at most 2,000 characters (the first 1,500 and the
 * last 500, with `[…]` between), control characters out, then masked.
 */
export function judgeText(text: string): string {
  const cut = withoutInvisible(cutQuoted(text))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, "")
    .trim();
  const short = cut.length > 2_000 ? `${cut.slice(0, 1_500)}\n[…]\n${cut.slice(-500)}` : cut;
  return mask(short);
}

/** Quoted history (`> …` lines, "On … wrote:" and what follows) cut from a text. */
function cutQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (
      /^\s*(on|el|le|am|il|em|op|w dniu)\b.{0,200}\b(wrote|escribió|a écrit|schrieb|ha scritto|escreveu|schreef|napisał)\s*:\s*$/i.test(
        line,
      )
    )
      break;
    if (/^-{2,}\s*(original message|mensaje original|message d'origine|ursprüngliche nachricht)/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}
