/**
 * A phone's name for itself, as the inbox may show it to the owner (ADR-028 Amendment 4). Whoever holds
 * a phone types its name, so a stranger's phone could call itself "Not you? Stop it here: …" or "Call
 * 0800 …", or something that passes any rule ("Reset at getback dot io"). So no email, and no page an
 * email's link opens, ever quotes it: they say the kind of phone only (`aPhoneOfKind`). The owner's own
 * screens, signed in (the confirm sheet, Settings → Phone, an item's history), show it beside the kind,
 * and only when it reads like a phone's ("Pixel 8", "Galaxy S24", "Ana's iPhone").
 *
 * No imports, so the phone app applies it too, to what an inbox of an older version sends.
 */

/** Longest name shown, in characters. */
export const PHONE_NAME_MAX = 24;

/**
 * What a shown name never carries, however it is written: us, a way to reach someone, a way in, or
 * someone who speaks with authority. Read from the name's letters alone (`reading`), so "Sup-port",
 * "S u p p o r t", "Supp0rt", "Suppört" and "CaII" read as the words they show.
 */
const NAME_DENY = [
  "surfing",
  "surfdog",
  "inbox",
  "support",
  "help",
  "service",
  "assist",
  "customer",
  "call",
  "dial",
  "text",
  "sms",
  "msg",
  "whatsapp",
  "telegram",
  "mail",
  "contact",
  "reply",
  "click",
  "visit",
  "link",
  "http",
  "www",
  "security",
  "secure",
  "bank",
  "paypal",
  "fraud",
  "scam",
  "team",
  "staff",
  "admin",
  "official",
  "verif",
  "account",
  "password",
  "passcode",
  "login",
  "signin",
  "code",
  "police",
  "refund",
  "urgent",
  "warning",
  "alert",
  "notyou",
  "stop",
  "danger",
] as const;

/** Words of an address, which a shown name never has: "evil-site com". */
const NAME_DENY_WORDS = ["com", "net", "org"] as const;

/** Latin-1's letters with their accents taken off, for reading a name's words. */
const FOLD_FROM = "ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝàáâãäåçèéêëìíîïðñòóôõöøùúûüýÿ";
const FOLD_TO = "AAAAAACEEEEIIIIDNOOOOOOUUUUYaaaaaaceeeeiiiidnoooooouuuuyy";
const FOLD_TWO: Readonly<Record<string, string>> = { Æ: "AE", æ: "ae", Þ: "TH", þ: "th", ß: "ss" };

/** Digits read as the letters they look like: "Supp0rt", "He1p", "8ank". */
const DIGIT_LETTERS: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
};

/** Letters that stand in for digits beside digits ("O8OO"), and in a word of nothing else ("OlOO", "SOlOO"). */
const DIGIT_LOOKS = "OoIl";
const DIGIT_LOOKS_ALONE = "OoIlSZB";

const isAsciiLetter = (ch: string) => (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
const isDigit = (ch: string) => ch >= "0" && ch <= "9";
const isLatin1Letter = (ch: string) => FOLD_FROM.includes(ch) || ch in FOLD_TWO;
const isSpace = (ch: string) => " \t\n\r\v\f ".includes(ch);
const isMark = (ch: string) => ch === "-" || ch === "'" || ch === "’";

/**
 * The letters a name shows, as one reads them: accents off, lower case, digits as the letters they look
 * like, and i, I, l and 1 as one stroke ("l"), everything else dropped.
 */
export function nameReading(s: string): string {
  let out = "";
  for (const ch of s) {
    const at = FOLD_FROM.indexOf(ch);
    const plain = at >= 0 ? (FOLD_TO[at] ?? "") : (FOLD_TWO[ch] ?? ch);
    for (const c of plain.toLowerCase()) {
      const l = DIGIT_LETTERS[c] ?? c;
      const one = l === "i" ? "l" : l;
      if (one >= "a" && one <= "z") out += one;
    }
  }
  return out;
}

const DENY_READ = NAME_DENY.map(nameReading);

/** Digits in a name's words, letters that stand in for them counted; null when a run of them is too long. */
function digitsIn(words: readonly string[]): number | null {
  let all = 0;
  for (const w of words) {
    const chars = [...w];
    const hasDigit = chars.some(isDigit);
    const looksAll = !hasDigit && chars.length >= 2 && chars.every((ch) => DIGIT_LOOKS_ALONE.includes(ch));
    if (!hasDigit && !looksAll) continue;
    let run = 0;
    for (const ch of chars) {
      if (isDigit(ch) || DIGIT_LOOKS.includes(ch) || looksAll) {
        all++;
        run++;
        if (run > 4) return null;
      } else run = 0;
    }
  }
  return all;
}

/**
 * A phone's name when the owner may be shown it: one short line of letters (Latin ones, accents
 * included), digits, spaces, hyphens and apostrophes, at most 24 characters, with a letter in it, no run
 * of more than four digits and six digits in all (letters that stand in for digits count), and no word
 * of us, of a way to reach someone, or of an authority. Null for anything else: say the kind of phone
 * instead (`phoneKind`).
 */
export function quotablePhoneName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let name = "";
  let space = false;
  for (const ch of value) {
    if (isSpace(ch)) {
      space = true;
      continue;
    }
    if (!(isAsciiLetter(ch) || isDigit(ch) || isLatin1Letter(ch) || isMark(ch))) return null;
    if (space && name) name += " ";
    space = false;
    name += ch;
  }
  if (!name || [...name].length > PHONE_NAME_MAX) return null;
  if (![...name].some((ch) => isAsciiLetter(ch) || isLatin1Letter(ch))) return null;
  const words = name.split(/[ '’-]+/).filter(Boolean);
  const digits = digitsIn(words);
  if (digits === null || digits > 6) return null;
  const read = nameReading(name);
  if (DENY_READ.some((w) => read.includes(w))) return null;
  if (words.some((w) => (NAME_DENY_WORDS as readonly string[]).includes(w.toLowerCase()))) return null;
  return name;
}

/** The kind of phone, as the owner reads it: "Android phone", "iPhone". */
export function phoneKind(platform: string | null | undefined): string {
  return platform === "ios" ? "iPhone" : "Android phone";
}

/** A phone's name as the owner is shown it on their own screens: its own, when it may be shown, else its kind. */
export function shownPhoneName(name: unknown, platform: string | null | undefined): string {
  return quotablePhoneName(name) ?? phoneKind(platform);
}

/**
 * A phone's own name, for the owner's screens to show beside its kind ("Galaxy A15 · Android phone"):
 * null when it is not one to show, or is only its kind. Never in an email.
 */
export function ownPhoneName(name: unknown, platform: string | null | undefined): string | null {
  const own = quotablePhoneName(name);
  return own && own !== phoneKind(platform) ? own : null;
}

/**
 * A phone as an email, or a page an email's link opens, says it: its kind alone, "an Android phone",
 * "an iPhone". Never its own name, which whoever holds it typed.
 */
export function aPhoneOfKind(platform: string | null | undefined): string {
  return `an ${phoneKind(platform)}`;
}
