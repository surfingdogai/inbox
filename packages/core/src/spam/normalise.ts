import { SECOND_LEVEL } from "./data";

/**
 * Text as the spam filter compares it (ADR-029 §5): the same message twice is the same text, whatever
 * its spacing, its case, a zero-width character or a look-alike letter slipped into it. Normalised
 * text is for comparing and counting only; nobody reads it, and it is never stored.
 */

/** Zero-width characters and bidirectional controls. */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u00ad]/g;

/**
 * Cyrillic and Greek letters drawn like Latin ones (a subset of Unicode's confusables, UTS #39), folded
 * to the Latin letter for comparing only, and what makes a word "disguised" when it mixes them in.
 */
const CONFUSABLE: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  с: "c",
  е: "e",
  ё: "e",
  һ: "h",
  і: "i",
  ї: "i",
  ј: "j",
  к: "k",
  м: "m",
  о: "o",
  р: "p",
  ԛ: "q",
  ѕ: "s",
  т: "t",
  у: "y",
  х: "x",
  ԝ: "w",
  ү: "y",
  А: "A",
  В: "B",
  С: "C",
  Е: "E",
  Н: "H",
  І: "I",
  Ј: "J",
  К: "K",
  М: "M",
  О: "O",
  Р: "P",
  Ѕ: "S",
  Т: "T",
  Х: "X",
  У: "Y",
  α: "a",
  ο: "o",
  ρ: "p",
  ν: "v",
  τ: "t",
  ι: "i",
  κ: "k",
  χ: "x",
  υ: "u",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
};

/** The confusable letters only, for one quick test. */
const CONFUSABLE_CHARS = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "u");

/** HTML as plain text: tags out, entities read, blocks on lines of their own. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_m, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Look-alike letters as the Latin ones they pass for: for comparing a name, never for showing. */
export function foldConfusables(text: string): string {
  let out = "";
  for (const ch of text) out += CONFUSABLE[ch] ?? ch;
  return out;
}

/**
 * The form texts are compared in: NFKC, invisible characters out, look-alikes folded, lower case,
 * links reduced to their registrable domain, every run of spaces one space.
 */
export function normalise(text: string): string {
  const plain = text.normalize("NFKC").replace(INVISIBLE, "");
  const linked = plain.replace(URL_IN_TEXT, (url) => ` ${hostOf(url) ?? ""} `);
  return foldConfusables(linked).toLowerCase().replace(/\s+/g, " ").trim();
}

/** A link in text: `https://…`, `http://…` or `www.…`. */
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+/giu;

/** The links a text holds, as written (at most fifty). */
export function linksIn(text: string): string[] {
  return [...text.normalize("NFKC").replace(INVISIBLE, "").matchAll(URL_IN_TEXT)]
    .map((m) => m[0].replace(/[.,;:!?]+$/, ""))
    .slice(0, 50);
}

/** A link's host, lower case, without `www.`; null when it has none that reads as a host. */
export function hostOf(link: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `http://${link}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host) return null;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * The part of a host one company registers: two labels, or three under a country's generic
 * second level (`shop.example.co.uk` → `example.co.uk`). An IP address is itself.
 */
export function registrableDomain(host: string): string {
  const h = host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return h;
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1] ?? "";
  const second = labels[labels.length - 2] ?? "";
  const take = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** The registrable domains a text links to, each once (at most ten). */
export function linkDomains(text: string, html?: string): string[] {
  const hosts = [...linksIn(text), ...(html ? hrefsOf(html).map((h) => h.href) : [])]
    .map(hostOf)
    .filter((h): h is string => h !== null);
  return [...new Set(hosts.map(registrableDomain))].slice(0, 10);
}

/** An email address's domain, lower case. */
export function emailDomain(address: string | undefined | null): string | null {
  const at = address?.lastIndexOf("@") ?? -1;
  if (!address || at < 1) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(domain) || /^xn--/.test(domain) ? domain : null;
}

/** An address folded the way one mailbox is one handle: lower case, `+tag` dropped. */
export function foldAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 1) return lower;
  const local = (lower.slice(0, at).split("+")[0] ?? "").trim();
  return `${local}@${lower.slice(at + 1)}`;
}

/** The anchors of an HTML part: what each shows, and where it goes. */
export function hrefsOf(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: (m[1] ?? "").trim(), text: htmlText(m[2] ?? "") });
    if (out.length >= 50) break;
  }
  return out;
}

/** Markdown links, `[shown](target)`, in plain text. */
export function markdownLinks(text: string): { href: string; text: string }[] {
  return [...text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/gi)].slice(0, 50).map((m) => ({
    text: m[1] ?? "",
    href: m[2] ?? "",
  }));
}

const LATIN = /\p{Script=Latin}/u;

/**
 * Whether one word mixes Latin letters with Cyrillic or Greek look-alikes (`pаypal` with a Cyrillic
 * а): a disguise. A word wholly in one script is never one, nor is any other mix of scripts.
 */
export function hasDisguisedWord(text: string): boolean {
  for (const word of text.normalize("NFC").split(/[^\p{L}\p{M}]+/u)) {
    if (word.length < 3) continue;
    if (!LATIN.test(word) || !CONFUSABLE_CHARS.test(word)) continue;
    return true;
  }
  return false;
}

/**
 * Whether a zero-width or bidirectional control sits between two Latin letters: inside a word, where
 * it only hides the word. Between letters of other scripts (a zero-width non-joiner in Persian, a joiner
 * in an emoji) it is writing, and never counts.
 */
export function hasInvisibleInLatin(text: string): boolean {
  const chars = [...text];
  for (let i = 1; i < chars.length - 1; i++) {
    if (!/[\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(chars[i] ?? "")) continue;
    let j = i + 1;
    while (j < chars.length && /[\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(chars[j] ?? ""))
      j++;
    if (LATIN.test(chars[i - 1] ?? "") && LATIN.test(chars[j] ?? "")) return true;
  }
  return false;
}

/** Scripts written without spaces between words, compared by runs of characters instead. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * The pieces a text's print is made of: runs of four characters, spaces included, in every script.
 * Short texts have few words, and a print of word runs moves too much when one word changes; runs
 * of characters give even a short message enough pieces for a reworded copy to land near it.
 */
export function shingles(normalised: string): string[] {
  const chars = [...normalised];
  if (chars.length < 4) return chars.length ? [chars.join("")] : [];
  const out: string[] = [];
  for (let i = 0; i + 4 <= chars.length; i++) out.push(chars.slice(i, i + 4).join(""));
  return out;
}

/** How many words a text holds besides its links. */
export function wordsBesideLinks(text: string): number {
  const without = text.replace(URL_IN_TEXT, " ");
  const chars = [...without.replace(/\s+/g, "")];
  if (chars.length > 0 && chars.filter((c) => UNSPACED.test(c)).length / chars.length > 0.3) {
    // Roughly two characters a word in a script written without spaces.
    return Math.floor(chars.length / 2);
  }
  return without.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}
