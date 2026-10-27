import type { Statement } from "@surfingdog/platform";
import { jobStatement } from "../write/common";
import { DISPOSABLE_MAIL, SHARED_MAIL_PROVIDERS } from "./data";
import { mask } from "./mask";
import { emailDomain, normalise, registrableDomain, shingles, withoutInvisible } from "./normalise";
import { hash32 } from "./prints";
import type { Filter, Signal } from "./types";

/**
 * Known spam, shared between the inboxes one host runs (ADR-041 §16). What is shared is a fingerprint,
 * never a message: MinHash bands of the text with every link, email address, phone number, bank or card
 * number and digit masked, and the sender's company mail domain. The inbox hands them to its host's port
 * and keeps none of them; the host keys each one with a secret of its own (HMAC) before it keeps or
 * compares it, so neither an inbox's file nor the host's store holds anything that reads back as words,
 * and no inbox can compute another's fingerprints. On one's own server there is no port, and nothing
 * is shared.
 */

/** At most this much of a message is fingerprinted. */
const MAX_CHARS = 4_000;
/** Fewer characters than this, masked, and a message gets no fingerprint: short questions are alike everywhere. */
export const SHARE_MIN_CHARS = 100;
/** Eight bands of four MinHash values: texts much alike share several bands, texts merely similar none. */
export const SHARE_BANDS = 8;
export const SHARE_ROWS = 4;

/** What `mask` leaves of a full link: its domain, masked here too, so a wave that moves domains still matches. */
const LINK_MASK = /\[link to [^\]]*\]/g;
/** A host written without a scheme ("visit example.com/offer"), masked as a link. */
const BARE_HOST = /(?<![\p{L}\p{N}@._-])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,24}(?:\/\S*)?(?![\p{L}\p{N}-])/gu;

/**
 * The text a fingerprint is made of: personal data masked as for the AI check, links masked whole, then
 * normalised as prints are (case, spacing, look-alike letters, invisible characters), every run of
 * digits one `#`. Never stored, never sent: only its MinHash leaves, and only to the host's port.
 */
export function sharedText(text: string): string {
  const masked = mask(withoutInvisible(text).slice(0, MAX_CHARS))
    .replace(LINK_MASK, " [link] ")
    .replace(BARE_HOST, " [link] ");
  return normalise(masked).replace(/\d+/g, "#");
}

/** A message's fingerprint, as the inbox hands it to its host: raw bands, keyed by the host before anything is kept. */
export interface SharedPrint {
  /** Eight MinHash bands of the masked text, each `band:values`. */
  readonly bands: readonly string[];
  /** The sender's company mail domain: never a provider many share, nor a throwaway one; null for none. */
  readonly domain: string | null;
}

/** The sender's mail domain when it is a company's own: a provider many people share says nothing of one sender. */
export function companyDomain(email: string | null | undefined): string | null {
  const host = emailDomain(email ?? undefined);
  if (!host) return null;
  const d = registrableDomain(host);
  return SHARED_MAIL_PROVIDERS.has(d) || SHARED_MAIL_PROVIDERS.has(host) || DISPOSABLE_MAIL.has(d) ? null : d;
}

/** murmur3's finaliser: one 32-bit value mixed. */
function fmix(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The MinHash of a set of pieces, as eight bands of four values (thirty-two hash functions, made from
 * two by Kirsch and Mitzenmacher's sum): two texts share a band with odds that climb steeply with how
 * much of their pieces they share.
 */
export function minhashBands(pieces: Iterable<string>): string[] {
  const k = SHARE_BANDS * SHARE_ROWS;
  const mins = new Array<number>(k).fill(0xffffffff);
  for (const piece of pieces) {
    const a = hash32(piece, 0x2545f491);
    const b = hash32(piece, 0x68e31da4) | 1;
    for (let i = 0; i < k; i++) {
      const h = fmix(a + Math.imul(i + 1, b));
      if (h < (mins[i] ?? 0xffffffff)) mins[i] = h;
    }
  }
  return Array.from(
    { length: SHARE_BANDS },
    (_, band) =>
      `${band}:${mins
        .slice(band * SHARE_ROWS, (band + 1) * SHARE_ROWS)
        .map((m) => m.toString(16).padStart(8, "0"))
        .join("")}`,
  );
}

/**
 * A message's fingerprint; null when it is too short to tell one message from another. `email` only
 * where a mail server vouched for the address (DMARC or aligned DKIM): one typed at a form or given by an
 * assistant may be anyone's, so it names no domain to look up or report.
 */
export function sharedPrintOf(text: string, email?: string | null): SharedPrint | null {
  const normalised = sharedText(text);
  if ([...normalised].length < SHARE_MIN_CHARS) return null;
  const pieces = new Set(shingles(normalised));
  if (pieces.size < SHARE_MIN_CHARS / 2) return null;
  return { bands: minhashBands(pieces), domain: companyDomain(email) };
}

/** What the host's shared list says of a fingerprint. */
export interface SharedMatch {
  /** Other businesses know this text as spam: three owners or more in a fortnight, less those who said Not spam. */
  readonly known: boolean;
  /** How many owners that is, after the Not spam. */
  readonly owners: number;
  /** The filter most of them put it under, when they said. */
  readonly kind: Filter | null;
  /** The sender's mail domain is known for spam the same way. */
  readonly domain: boolean;
}

export const NO_MATCH: SharedMatch = { known: false, owners: 0, kind: null, domain: false };

/**
 * The host's shared list, as one inbox reaches it. Every hosted inbox reads it; only those whose marks
 * count for others (`contributes`: Pro, live at the business's own address) report known spam to it,
 * and every inbox that can be written to (`disputes`: Free too) tells it when a person says Not spam on
 * a match (ADR-041 §16.6).
 */
export interface SharedSpamPort {
  readonly contributes: boolean;
  readonly disputes: boolean;
  /** What other inboxes reported of a fingerprint like this one: a read, nothing is kept. */
  lookup(print: SharedPrint, now: number): SharedMatch | Promise<SharedMatch>;
  /**
   * This inbox's word on one item: `1`, known spam (a person's Spam, or put aside with high confidence);
   * `-1`, a person's Not spam on what a shared match had labelled. One word an item: a new one replaces it.
   */
  report(
    itemId: string,
    print: SharedPrint,
    o: { readonly vote: 1 | -1; readonly kind: Filter | null; readonly now: number },
  ): unknown;
  /** Takes back whatever this inbox said of the item. */
  withdraw(itemId: string): unknown;
}

/** A lookup that fails reads as no match: the filter never waits on, or fails for, the shared list. */
export async function lookupShared(port: SharedSpamPort, print: SharedPrint, now: number): Promise<SharedMatch> {
  try {
    return await port.lookup(print, now);
  } catch {
    return NO_MATCH;
  }
}

/** What a match on the shared list is worth: enough to label on its own, never to put aside or hold. */
export const SHARED_POINTS = 3;
/** What a sender's domain known for spam adds, from mail a server vouched for: it labels nothing alone. */
export const SHARED_DOMAIN_POINTS = 2;

/**
 * A shared match as points (ADR-041 §16.5). Known spam is worth a label ("Seen as spam at other
 * businesses"), under the filter its reporters named when that filter is on, so its learning week, Just
 * label and the AI check's customer answer apply, else under the free protection; a sender's domain known
 * for spam adds a little, and only where a mail server vouched for the address (the caller passes no
 * domain otherwise). Neither, nor both together, puts anything aside or holds it without a signal of this
 * inbox's own or the AI's beside them (`decide`), and on a booking's or an order's note they only label.
 */
export function sharedSignals(
  m: SharedMatch,
  o: { readonly on: ReadonlySet<Filter>; readonly templated: boolean; readonly domain: string | null },
): Signal[] {
  const out: Signal[] = [];
  if (m.known) {
    const named = m.kind ?? "junk";
    const f = !o.templated && o.on.has(named) ? named : "basic";
    out.push({ c: "shared_spam", w: SHARED_POINTS, f, v: m.owners });
  }
  if (m.domain && o.domain) out.push({ c: "shared_domain", w: SHARED_DOMAIN_POINTS, f: "basic", d: o.domain });
  return out;
}

/** Certain causes that make what was put aside known spam: a bot at the form, a server's mark, a wave. */
const SURE_CAUSES: ReadonlySet<string> = new Set(["trap", "no_key", "server_marked", "wave"]);

/** What says whether something put aside is known spam. */
export interface AsideFacts {
  readonly verdict: string;
  readonly cause: string | null;
  readonly certain: boolean;
  readonly learning: boolean;
  readonly answer: {
    readonly kind: string;
    readonly certainty: string;
    readonly customerIntent: boolean;
    readonly quotes: number;
  } | null;
}

/**
 * Whether something the filter put aside on its own is known spam, to report to the shared list: a
 * certain cause of a bot's or a wave's, or the AI check sure of it with a passage found word for word.
 * Never what the owner's Always put aside, a look-alike or a shared match put aside, nor a learning week's.
 */
export function sureAside(f: AsideFacts): boolean {
  if (f.verdict !== "aside" || f.learning) return false;
  if (f.certain && f.cause !== null && SURE_CAUSES.has(f.cause)) return true;
  const a = f.answer;
  return (
    a !== null &&
    a.certainty === "high" &&
    !a.customerIntent &&
    a.quotes > 0 &&
    (a.kind === "sales_pitch" || a.kind === "scam" || a.kind === "junk")
  );
}

/** The filter a report names: the AI check's kind, else the filter that caused it; null when neither says. */
export function reportedKind(cause: string | null, answerKind: string | null | undefined): Filter | null {
  if (answerKind === "sales_pitch") return "pitches";
  if (answerKind === "scam") return "scams";
  if (answerKind === "junk") return "junk";
  return cause === "pitches" || cause === "scams" || cause === "junk" ? cause : null;
}

/** The job that tells the host's shared list what this inbox now says of one item. */
export const SPAM_SHARE_KIND = "spam_share";

export function shareJobStatement(itemId: string, now: number): Statement {
  return jobStatement(SPAM_SHARE_KIND, { itemId }, now);
}
