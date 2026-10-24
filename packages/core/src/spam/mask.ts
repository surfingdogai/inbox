import { hostOf, registrableDomain } from "./normalise";

/**
 * What the AI check is sent of a message (ADR-029 §7.3): the words, with every email address, phone
 * number, bank account, card number and full link taken out. The check still reads "send the payment
 * to [bank account]", and none of the data. Masking runs before anything leaves the inbox.
 */

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+/giu;
/** An IBAN as people write it: a country, two check digits, then groups of letters and digits. */
const IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,4})?\b/gi;
/** Thirteen to nineteen digits, spaced or dashed as cards are printed. */
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
/** A run that holds seven digits or more, as phone numbers are written anywhere. */
const PHONE = /(?:\+|00)?\(?\d[\d\s().\-/]{5,}\d/g;
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

/** The text with its personal data taken out. */
export function mask(text: string): string {
  return text
    .replace(URL, (url) => {
      const host = hostOf(url.replace(/[.,;:!?]+$/, ""));
      return host ? `[link to ${registrableDomain(host)}]` : "[link]";
    })
    .replace(EMAIL, "[email]")
    .replace(IBAN, (m) => (/\d.*\d.*\d.*\d/.test(m.slice(4)) ? "[bank account]" : m))
    .replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number]" : m))
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 16) return m;
      if (DATE_LIKE.test(m.trim())) return m;
      return "[phone]";
    });
}

/**
 * The text the AI check reads: quoted history cut, at most 2,000 characters (the first 1,500 and the
 * last 500, with `[…]` between), control characters out, then masked.
 */
export function judgeText(text: string): string {
  const cut = cutQuoted(text)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
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
