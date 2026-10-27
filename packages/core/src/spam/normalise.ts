import { ACCOUNT_PATHS, SECOND_LEVEL, SHARED_BRAND_DOMAINS, SHARED_HOSTS } from "./data";

/**
 * Text as the spam filter compares it (ADR-041 §5): the same message twice is the same text, whatever
 * its spacing, its case, a zero-width character or a look-alike letter slipped into it. Normalised
 * text is for comparing and counting only; nobody reads it, and it is never stored.
 */

/**
 * Characters drawn as nothing: zero-width ones, bidirectional controls, the combining grapheme joiner,
 * variation selectors, invisible operators, Hangul fillers, tag characters — every one Unicode calls
 * default-ignorable. They change nothing a reader sees, so they change nothing compared either.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const INVISIBLE_ONE = /\p{Default_Ignorable_Code_Point}/u;

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

/**
 * Whether a host is one many honest people link to: listed, or one of a big site's own country
 * domains (`google.es`, `amazon.co.jp`; never `amazon.example.net`, nor `airbnb.info.pl`).
 */
export function isSharedHost(host: string): boolean {
  const d = registrableDomain(host);
  return SHARED_HOSTS.has(host) || SHARED_HOSTS.has(d) || SHARED_BRAND_DOMAINS.has(d);
}

/**
 * What a link on a shared host points at, when its path names one account, file or form there
 * (`wa.me/6281…`, `t.me/channel`, `sites.google.com/view/x`, `docs.google.com/forms/d/e/…`): the host
 * and that part, lower case; null for any other link.
 */
export function sharedAccountOf(link: string): string | null {
  const host = hostOf(link);
  const take = host ? ACCOUNT_PATHS[host] : undefined;
  if (!host || !take) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `http://${link}`);
    if (typeof take !== "number") {
      const named = take.exec(`${url.pathname}${url.search}`)?.slice(1).find(Boolean);
      return named ? `${host}/${named.toLowerCase()}` : null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < take) return null;
    return `${host}/${parts.slice(0, take).join("/").toLowerCase()}`;
  } catch {
    return null;
  }
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

/** An invisible character that counts inside a Latin word: any but the soft hyphen, which hyphenation leaves. */
const hides = (ch: string) => ch !== "\u00ad" && INVISIBLE_ONE.test(ch);

/**
 * Whether a character drawn as nothing sits between two Latin letters: inside a word, where it only
 * hides the word. Between letters of other scripts (a zero-width non-joiner in Persian, a joiner in an
 * emoji) it is writing, and never counts.
 */
export function hasInvisibleInLatin(text: string): boolean {
  const chars = [...text];
  for (let i = 1; i < chars.length - 1; i++) {
    if (!hides(chars[i] ?? "")) continue;
    let j = i + 1;
    while (j < chars.length && hides(chars[j] ?? "")) j++;
    if (LATIN.test(chars[i - 1] ?? "") && LATIN.test(chars[j] ?? "")) return true;
  }
  return false;
}

/**
 * Text as a model is sent it: every character drawn as nothing taken out, but the joiners some
 * scripts and emoji are written with (U+200C, U+200D), unless they sit against a Latin letter.
 */
export function withoutInvisible(text: string): string {
  return text
    .replace(/(?![\u200c\u200d])\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/(?<=\p{Script=Latin})[\u200c\u200d]+|[\u200c\u200d]+(?=\p{Script=Latin})/gu, "");
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
