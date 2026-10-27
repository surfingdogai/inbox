import { DISPOSABLE_MAIL, SHARED_HOSTS, SHORTENERS } from "../data";
import {
  emailDomain,
  foldConfusables,
  hasDisguisedWord,
  hasInvisibleInLatin,
  hostOf,
  hrefsOf,
  linksIn,
  markdownLinks,
  normalise,
  registrableDomain,
  wordsBesideLinks,
} from "../normalise";
import type { Repeats } from "../prints";
import type { Signal } from "../types";

/**
 * What any door's words tell (ADR-029 §5.2): disguised links and letters, a message that is only
 * links, words aimed at an AI or a filter, an address that looks like the business's own, and the
 * same words or the same link domain arriving from many senders. Language, script, spelling, length,
 * country and email provider are never signals: only disguise and repetition are.
 */

/** Words that speak to an AI or a filter rather than to a person at the business. */
const TO_THE_FILTER: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions?|prompts?|rules)\b/i,
  /\byou are (now )?(an? )?(spam )?(filter|classifier|moderator|content moderator)\b/i,
  // An order to classify the message itself: "mark this email as not spam", "treat it as legitimate".
  // Never a customer's "label the second package as ham".
  /\b(mark|classify|label|flag|treat|consider|categori[sz]e)\s+(this|the|my|our)\s+(message|e-?mail|mail|text|request|enquiry|inquiry|submission)\s+as\s+(not spam|ham|safe|legitimate|genuine|a (genuine |real |legitimate )?customer('s)?( (message|request|enquiry|inquiry))?)\b/i,
  /\b(mark|classify|label|flag|treat|consider|categori[sz]e)\s+(this|it)\s+as\s+(not spam|legitimate|non-?spam)\b/i,
  /\b(this|the) (message|email|mail) is not spam\b/i,
  /<\/?\s*(system|assistant|instructions?)\s*>/i,
  /<\|im_start\|>|<\|im_end\|>|\[\/?(system|inst)\]/i,
  /#{2,}\s*(instruction|system|prompt)/i,
  /"(kind|certainty|customer_intent|talks_to_filter)"\s*:/i,
  /\b(ignora|ignore|ignorez|ignoriere|negeer|zignoruj|abaikan)\b.{0,30}\b(instrucciones|instruções|instructions|anweisungen|istruzioni|instructies|instrukcje|instruksi)\b/i,
  /(以前|前)の指示を無視|忽略(之前|以上|所有)的?(指令|指示)|تجاهل التعليمات/u,
  /(про)?игнорируй.{0,30}инструкц|önceki talimatları (yok say|görmezden gel)|पिछले निर्देशों को (अनदेखा|नज़रअंदाज़)|이전 지시(를|사항을) 무시/iu,
  /\b(owner|business|admin(istrator)?|manager|management)\b.{0,40}\b(asked|told|wants|said|authori[sz]ed)\b.{0,40}\b(let (this|it|me) through|approve|whitelist|allowlist|deliver (this|it))\b/i,
  /\b(whitelist|allowlist) (me|this|my (email|address|message))\b/i,
  // Words addressed to the reader itself: "I instruct the filter", "Note to the AI", "AI reading this".
  /\b(instruct|command)(s|ed|ing)?\s+(the|this|you)\s+((spam|mail|e-?mail)\s+)?(filter|classifier|ai|moderator)\b/i,
  /\b(note|message|instructions?|attention)\s+(to|for)\s+(the\s+|any\s+|an\s+)?(ai|llm|filter|classifier|moderator)\b/i,
  /\b(ai|llm|filter|classifier|bot)s?\s+reading\s+this\b/i,
  // A line drawn like a boundary between data and instructions, and what usually follows one.
  /^\s*-{3,}\s*[A-Za-z0-9_-]{10,}\s*-{3,}\s*$/m,
  /\bnew (instructions?|rules|task)\s*:/i,
  // An answer dictated to the reader: 'answer "customer"', "respond with: not spam", "output: ham",
  // "reply that this is not spam". Never "do you respond customer emails".
  /\b(answer|respond|reply|output|return|classify)\s*(with\s*)?(:\s*["'“]?|["'“])\s*(customer|ham|not spam|not_spam)\b/i,
  /\b(answer|respond|reply|output|return)\s+(with\s+)?["'“]?(not spam|not_spam)["'”]?\s*(\.|$|,|!)/im,
  /\b(answer|respond|reply|output|say)\s+that\s+(it|this)\s+is\s+(not spam|ham|legitimate)\b/i,
];

/** A long run of base64-like characters: a candidate for an encoded payload. */
const RUNS = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g;

/**
 * Whether a text carries an encoded payload, outside links: a run of forty base64 characters or more
 * between path separators, mixing lower case, upper case and digits as encoded text does. An order
 * reference in capitals and digits, or a file's id inside a link without its scheme, is none.
 */
export function carriesEncoded(text: string): boolean {
  const outside = text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi, " ");
  for (const m of outside.matchAll(RUNS)) {
    for (const piece of m[0].split("/")) {
      if (piece.replace(/=+$/, "").length >= 40 && /[a-z]/.test(piece) && /[A-Z]/.test(piece) && /\d/.test(piece))
        return true;
    }
  }
  return false;
}

/**
 * Text hidden in Unicode tag characters (U+E0020–E007E), which no reader sees and a model reads as
 * letters: decoded, so what it says is checked like the rest. A flag's own tags (🏴 then a region's
 * letters, ended by U+E007F) are writing, and are left out.
 */
export function hiddenTagText(text: string): string {
  let out = "";
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]?.codePointAt(0) ?? 0;
    if (cp === 0x1f3f4) {
      // A subdivision flag: 🏴, a few tag letters and digits, the cancel tag.
      let j = i + 1;
      while (j < chars.length && j - i <= 8 && /[\u{e0030}-\u{e0039}\u{e0061}-\u{e007a}]/u.test(chars[j] ?? "")) j++;
      if ((chars[j]?.codePointAt(0) ?? 0) === 0xe007f) {
        i = j;
        continue;
      }
    }
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCodePoint(cp - 0xe0000);
  }
  return out;
}

/**
 * Whether a text speaks to an AI or a filter: read as written, and again with invisible characters
 * out and look-alike letters folded, so "ign\u200bore" and a Greek "Ι" read as what they are, and
 * whatever it hides in tag characters; or whether it carries an encoded payload or hidden text.
 */
export function talksToFilter(text: string): boolean {
  const folded = normalise(text);
  const hidden = hiddenTagText(text);
  if (hidden.replace(/\s+/g, "").length >= 4) return true;
  if (TO_THE_FILTER.some((re) => re.test(text) || re.test(folded))) return true;
  return carriesEncoded(text);
}

/** Platforms a connected integration names, which a look-alike address may pass for. */
export const PROVIDER_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  stripe: ["stripe.com"],
  mollie: ["mollie.com"],
  google_calendar: ["google.com"],
  calcom: ["cal.com"],
  shopify: ["shopify.com"],
  square: ["squareup.com"],
  woocommerce: ["woocommerce.com"],
};

export interface ContentInput {
  /** What the sender wrote, as plain text. */
  readonly text: string;
  /** The HTML part of an email, for links that show one address and go to another. */
  readonly html?: string | undefined;
  /** The contact's email address, when one was given. */
  readonly email?: string | undefined;
  /** The business's own domains and its connected platforms', registrable. */
  readonly ownDomains: readonly string[];
  readonly providerDomains: readonly string[];
  /** The domains this text links to (`linkDomains`). */
  readonly linkDomains: readonly string[];
  readonly repeats: Repeats;
  /** Whether the mail domain takes no mail at all (a typo, or made up): null when not known. */
  readonly noMail?: boolean | null | undefined;
}

export function contentSignals(c: ContentInput): Signal[] {
  const out: Signal[] = [];
  const text = c.text;
  const links = [...linksIn(text), ...(c.html ? hrefsOf(c.html).map((a) => a.href) : [])];
  const emailHost = emailDomain(c.email);
  if (emailHost && DISPOSABLE_MAIL.has(registrableDomain(emailHost))) out.push({ c: "disposable", w: 2, f: "basic" });
  if (c.noMail === true) out.push({ c: "no_mail", w: 2, f: "basic", ...(emailHost ? { d: emailHost } : {}) });
  // A look-alike of the business's own address, or of a platform it uses.
  const watched = [...new Set([...c.ownDomains, ...c.providerDomains].map(registrableDomain))].filter(Boolean);
  const candidates = [...new Set([...(emailHost ? [registrableDomain(emailHost)] : []), ...c.linkDomains])];
  const look = candidates.find((d) => watched.some((w) => looksLike(d, w)));
  if (look) out.push({ c: "lookalike", w: 4, f: "basic", d: watched.find((w) => looksLike(look, w)) });
  // Links that show one address and go to another.
  const shown = [...(c.html ? hrefsOf(c.html) : []), ...markdownLinks(text)];
  if (
    shown.some((a) => {
      const shownHost = hostOf(a.text.trim());
      const realHost = hostOf(a.href);
      return (
        shownHost !== null &&
        realHost !== null &&
        /\.[a-z]{2,}$/i.test(shownHost) &&
        registrableDomain(shownHost) !== registrableDomain(realHost)
      );
    })
  ) {
    out.push({ c: "link_mismatch", w: 3, f: "basic" });
  }
  if (links.some(disguised)) out.push({ c: "link_disguised", w: 3, f: "basic" });
  // A shortener is matched by the link's own host: a map's share link (maps.app.goo.gl) is no shortener.
  const hosts = links.map(hostOf).filter((h): h is string => h !== null);
  if (hosts.some((h) => SHORTENERS.has(h))) out.push({ c: "shortener", w: 1, f: "basic" });
  // A link to the business's own site, a platform it uses, or a place everyone links to (a map, a
  // profile, a drive) is a customer's way of showing what they mean: it makes no message "only links".
  const telling = hosts.filter((h) => {
    const d = registrableDomain(h);
    return !watched.includes(d) && !SHARED_HOSTS.has(h) && !SHARED_HOSTS.has(d);
  });
  if (telling.length > 0 && wordsBesideLinks(text) < 5) out.push({ c: "link_only", w: 3, f: "basic" });
  if (telling.length >= 3) out.push({ c: "many_links", w: 2, f: "basic" });
  if (hasDisguisedWord(text)) out.push({ c: "disguised_letters", w: 2, f: "basic" });
  if (hasInvisibleInLatin(text)) out.push({ c: "invisible", w: 2, f: "basic" });
  if (talksToFilter(text)) out.push({ c: "talks_to_filter", w: 3, f: "basic" });
  // Repeats: the same words from many senders is a wave; a link domain several senders share, not
  // the business's own or one honest people share, is how reworded waves still show — a shortener's
  // included: a reworded wave behind one hides its own domain, and the shortener shows instead.
  const r = c.repeats;
  if (r.markedSpamAt !== null) out.push({ c: "like_marked", w: 6, f: "basic", x: 1, v: r.markedSpamAt });
  if (r.same >= 4) out.push({ c: "wave", w: 6, f: "basic", x: 1, v: r.same + 1 });
  else if (r.same >= 2) out.push({ c: "same_text", w: 4, f: "basic", v: r.same + 1 });
  else if (r.near >= 2) out.push({ c: "near_same", w: 3, f: "basic", v: r.near + 1 });
  let shared: { domain: string; n: number } | null = null;
  for (const [domain, n] of r.domains) {
    if (n < 2 || watched.includes(domain) || SHARED_HOSTS.has(domain)) continue;
    if (!shared || n > shared.n) shared = { domain, n };
  }
  if (shared) out.push({ c: "same_link_domain", w: 3, f: "basic", v: shared.n + 1, d: shared.domain });
  if (r.markedKept && r.markedSpamAt === null) out.push({ c: "like_kept", w: -3, f: "basic" });
  return out;
}

/** A link that hides where it goes: an address in numbers, a user before the host, a script or data URL. */
function disguised(link: string): boolean {
  if (/^\s*(javascript|data|vbscript):/i.test(link)) return true;
  const m = /^(?:https?:\/\/)?([^/?#]+)/i.exec(link.trim());
  const authority = m?.[1] ?? "";
  if (authority.includes("@")) return true;
  const host = authority.replace(/:\d+$/, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:]+\]$/i.test(host);
}

/**
 * Whether `domain` passes for `own` without being it: the same letters under punycode or look-alike
 * letters, or one or two letters off a name of six or more.
 */
export function looksLike(domain: string, own: string): boolean {
  if (!domain || !own || domain === own) return false;
  const shown = foldConfusables(decodeHost(domain)).toLowerCase();
  if (shown === own) return true;
  if (own.length < 6) return false;
  const d = editDistance(shown, own);
  return d >= 1 && d <= 2;
}

/** Levenshtein distance, bounded: past three it is "far". */
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 4;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const here = prev[j] ?? 0;
      prev[j] = Math.min(here + 1, (prev[j - 1] ?? 0) + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = here;
    }
  }
  return prev[b.length] ?? 0;
}

/** A host with its `xn--` labels decoded (RFC 3492), for comparing what a reader sees. */
export function decodeHost(host: string): string {
  return host
    .split(".")
    .map((label) => (label.toLowerCase().startsWith("xn--") ? (punycodeDecode(label.slice(4)) ?? label) : label))
    .join(".");
}

function punycodeDecode(input: string): string | null {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const skew = 38;
  const damp = 700;
  let n = 128;
  let bias = 72;
  let i = 0;
  const output: number[] = [];
  const delim = input.lastIndexOf("-");
  if (delim > 0) for (let j = 0; j < delim; j++) output.push(input.charCodeAt(j));
  const adapt = (delta: number, points: number, first: boolean) => {
    let d = first ? Math.floor(delta / damp) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew));
  };
  for (let pos = delim > 0 ? delim + 1 : 0; pos < input.length; ) {
    const old = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (pos >= input.length) return null;
      const c = input.charCodeAt(pos++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
      if (w > 1e9) return null;
    }
    bias = adapt(i - old, output.length + 1, old === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return null;
  }
}
