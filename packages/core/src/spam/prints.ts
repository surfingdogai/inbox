import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { shingles } from "./normalise";

/**
 * Prints of what strangers sent (ADR-029 §8): a SHA-256 of the normalised text and a 64-bit SimHash
 * of its pieces, kept as eight 8-bit bands, with the domains it linked to and a keyed hash of who
 * sent it. Hashes and domains only, never words: enough to see the same message arriving from many
 * senders, or one like a message the owner marked, and nothing to read.
 */

export interface Print {
  readonly sha: string;
  /** Sixteen hex characters. */
  readonly sim: string;
  readonly bands: Bands;
  /** Whether the text is long enough for repeats to mean anything (short questions repeat honestly). */
  readonly substantial: boolean;
}

/** How long prints are compared: a week for repeats, half a year for what a person marked. */
export const REPEAT_WINDOW_MS = 7 * 86_400_000;
export const MARK_WINDOW_MS = 180 * 86_400_000;
/** Prints nobody marked are kept a month, marked ones half a year. */
export const PRINT_KEEP_MS = 30 * 86_400_000;

/** At most this many bits apart, two prints are the same message reworded. */
export const NEAR_BITS = 6;

/** A SimHash's eight bytes: prints up to seven bits apart always share one. */
export type Bands = readonly [number, number, number, number, number, number, number, number];

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text) as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A 32-bit hash with a seed (murmur3's finaliser over FNV-1a), for SimHash's pieces. */
function hash32(text: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The 64-bit SimHash of a normalised text, as sixteen hex characters. */
export function simhash(normalised: string): string {
  const pieces = shingles(normalised);
  const counts = new Array<number>(64).fill(0);
  for (const piece of pieces) {
    const hi = hash32(piece, 0x9e3779b9);
    const lo = hash32(piece, 0x7f4a7c15);
    for (let bit = 0; bit < 32; bit++) {
      counts[bit] = (counts[bit] ?? 0) + ((hi >>> bit) & 1 ? 1 : -1);
      counts[32 + bit] = (counts[32 + bit] ?? 0) + ((lo >>> bit) & 1 ? 1 : -1);
    }
  }
  let hi = 0;
  let lo = 0;
  for (let bit = 0; bit < 32; bit++) {
    if ((counts[bit] ?? 0) > 0) hi |= 1 << bit;
    if ((counts[32 + bit] ?? 0) > 0) lo |= 1 << bit;
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

/** The eight 8-bit bands of a SimHash. */
export function bandsOf(sim: string): Bands {
  return [0, 2, 4, 6, 8, 10, 12, 14].map((i) => Number.parseInt(sim.slice(i, i + 2), 16)) as unknown as Bands;
}

/** How many bits two SimHashes differ by. */
export function hamming(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < 16; i += 4) {
    let x = Number.parseInt(a.slice(i, i + 4), 16) ^ Number.parseInt(b.slice(i, i + 4), 16);
    while (x) {
      n += x & 1;
      x >>>= 1;
    }
  }
  return n;
}

export async function printOf(normalised: string): Promise<Print> {
  const sim = simhash(normalised);
  return {
    sha: await sha256Hex(normalised),
    sim,
    bands: bandsOf(sim),
    substantial: normalised.length >= 60 && shingles(normalised).length >= 8,
  };
}

/** What earlier prints say about this one: how many other senders sent it or one like it, and the owner's marks. */
export interface Repeats {
  /** Other senders who sent exactly this text in the week. */
  readonly same: number;
  /** Other senders who sent text within three bits of it in the week (`same` included). */
  readonly near: number;
  /** Per linked domain, other senders who linked to it in the week. */
  readonly domains: ReadonlyMap<string, number>;
  /** When the owner marked one like it as spam in the half year; null when never. */
  readonly markedSpamAt: number | null;
  /** Whether the owner marked one like it Not spam. */
  readonly markedKept: boolean;
}

export const NO_REPEATS: Repeats = { same: 0, near: 0, domains: new Map(), markedSpamAt: null, markedKept: false };

export async function repeatsOf(
  db: Db,
  input: { readonly print: Print; readonly sender: string; readonly domains: readonly string[]; readonly now: number },
): Promise<Repeats> {
  const since = input.now - REPEAT_WINDOW_MS;
  const marked = input.now - MARK_WINDOW_MS;
  const { print, sender } = input;
  const domains = new Map<string, number>();
  for (const domain of input.domains.slice(0, 10)) {
    const { rows } = await db.client.query({
      sql: `SELECT COUNT(DISTINCT p.sender) FROM spam_prints p, json_each(p.link_domains) d
             WHERE d.value = ? AND p.at >= ? AND p.sender <> ?`,
      params: [domain, since, sender],
      method: "all",
    });
    domains.set(domain, Number(rows[0]?.[0] ?? 0));
  }
  if (!print.substantial) {
    return { same: 0, near: 0, domains, markedSpamAt: null, markedKept: false };
  }
  // Candidates share at least one band: two prints six bits apart always do (eight bands).
  const { rows } = await db.client.query({
    sql: `SELECT sender, sha, sim, mark, at FROM spam_prints
           WHERE at >= ? AND (b0 = ? OR b1 = ? OR b2 = ? OR b3 = ? OR b4 = ? OR b5 = ? OR b6 = ? OR b7 = ? OR sha = ?)
           ORDER BY at DESC LIMIT 500`,
    params: [marked, ...print.bands, print.sha],
    method: "all",
  });
  const same = new Set<string>();
  const near = new Set<string>();
  let markedSpamAt: number | null = null;
  let markedKept = false;
  for (const r of rows) {
    const [s, sha, sim, mark, at] = [String(r[0]), String(r[1]), String(r[2]), Number(r[3]), Number(r[4])];
    const close = sha === print.sha || hamming(sim, print.sim) <= NEAR_BITS;
    if (!close) continue;
    if (mark === 1 && (markedSpamAt === null || at > markedSpamAt)) markedSpamAt = at;
    if (mark === -1) markedKept = true;
    if (s === sender || at < since) continue;
    near.add(s);
    if (sha === print.sha) same.add(s);
  }
  return { same: same.size, near: near.size, domains, markedSpamAt, markedKept };
}

export function printStatement(input: {
  readonly itemId: string;
  readonly sender: string;
  readonly print: Print;
  readonly domains: readonly string[];
  readonly now: number;
}): Statement {
  const { print } = input;
  return {
    sql: `INSERT OR IGNORE INTO spam_prints (item_id, sender, sha, sim, b0, b1, b2, b3, b4, b5, b6, b7, link_domains, mark, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    params: [
      input.itemId,
      input.sender,
      print.sha,
      print.sim,
      ...print.bands,
      JSON.stringify(input.domains.slice(0, 10)),
      input.now,
    ],
    method: "run",
  };
}

/** A person's mark on an item's print: 1 spam, -1 not spam, 0 neither. */
export function markPrintStatement(itemId: string, mark: -1 | 0 | 1): Statement {
  return { sql: "UPDATE spam_prints SET mark = ? WHERE item_id = ?", params: [mark, itemId], method: "run" };
}

/** Drops prints past their time: a month, or half a year for a marked one. */
export function prunePrintsStatement(now: number): Statement {
  return {
    sql: "DELETE FROM spam_prints WHERE (mark = 0 AND at < ?) OR at < ?",
    params: [now - PRINT_KEEP_MS, now - MARK_WINDOW_MS],
    method: "run",
  };
}
