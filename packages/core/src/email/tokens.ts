import type { Db } from "../db";

/**
 * The addresses of the email channel (ADR-026 §4). The inbox has one address of its own
 * (`settings.email.inboundAddress`, e.g. `misty-stork-z4if@in.surfingdog.ai`); every conversation is
 * one of its plus addresses, with a secret token after the `+`:
 *
 * - `t…` a conversation with a customer: their replies land on that item, whatever headers their
 *   mail program kept;
 * - `o…` the owner's alert about an item: what the owner writes back from their own address goes to
 *   the customer as the business's reply;
 * - `c…` a forwarding check: the email the inbox sends to the business's own address to see it come
 *   back through the forward.
 *
 * A token is 16 characters of lower-case base32 (80 random bits) after its kind's letter: lower case
 * because a mail system may fold a local part to lower case, never the item's id, which an agent or
 * a customer may have seen.
 */
export type MailTokenKind = "thread" | "owner" | "check";

const PREFIX: Readonly<Record<MailTokenKind, string>> = { thread: "t", owner: "o", check: "c" };
const KIND_OF: Readonly<Record<string, MailTokenKind>> = { t: "thread", o: "owner", c: "check" };

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A token as it appears after the `+`. */
export const MAIL_TOKEN = /^[toc][a-z2-7]{16}$/;

export function newMailToken(kind: MailTokenKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let bits = 0;
  let acc = 0;
  let out = PREFIX[kind];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The kind a token's first letter names, or null for what is not a token. */
export function mailTokenKind(token: string): MailTokenKind | null {
  return MAIL_TOKEN.test(token) ? (KIND_OF[token[0] ?? ""] ?? null) : null;
}

/** An address split at its last `@`, the local part lower-cased; null for what is not one. */
export function splitAddress(address: string): { local: string; domain: string } | null {
  const clean = address
    .trim()
    .replace(/^.*<([^<>]+)>.*$/, "$1")
    .trim();
  const at = clean.lastIndexOf("@");
  if (at <= 0 || at === clean.length - 1 || /\s/.test(clean)) return null;
  return { local: clean.slice(0, at).toLowerCase(), domain: clean.slice(at + 1).toLowerCase() };
}

/** `name+token@domain` for `name@domain` (a plus part it had is replaced). */
export function plusAddress(address: string, token: string): string | null {
  const a = splitAddress(address);
  if (!a) return null;
  const base = a.local.split("+")[0] ?? a.local;
  return `${base}+${token}@${a.domain}`;
}

/** The address without its plus part, lower case: `support+t…@shop.example` → `support@shop.example`. */
export function baseAddress(address: string): string | null {
  const a = splitAddress(address);
  if (!a) return null;
  return `${a.local.split("+")[0] ?? a.local}@${a.domain}`;
}

/** The tokens a list of addresses carries after a `+`, each once, in order. */
export function tokensIn(addresses: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of addresses) {
    if (!raw) continue;
    // A header may hold several addresses: each is looked at.
    for (const part of raw.split(/[,;]/)) {
      const a = splitAddress(part);
      if (!a) continue;
      const plus = a.local.lastIndexOf("+");
      if (plus < 0) continue;
      const token = a.local.slice(plus + 1);
      if (MAIL_TOKEN.test(token) && !out.includes(token)) out.push(token);
    }
  }
  return out;
}

export interface MailTokenRow {
  readonly token: string;
  readonly kind: MailTokenKind;
  readonly itemId: string | null;
  readonly forwardId: string | null;
  readonly createdAt: number;
}

/** The item's token of `kind`, made the first time it is asked for. */
export async function ensureItemToken(
  db: Db,
  itemId: string,
  kind: "thread" | "owner",
  now: number = Date.now(),
): Promise<string> {
  const found = await itemToken(db, itemId, kind);
  if (found) return found;
  await db.client.query({
    sql: "INSERT OR IGNORE INTO mail_tokens (token, kind, item_id, forward_id, created_at) VALUES (?, ?, ?, NULL, ?)",
    params: [newMailToken(kind), kind, itemId, now],
    method: "run",
  });
  // Two jobs that meet make one token: the unique index keeps the first, and both read it back.
  const made = await itemToken(db, itemId, kind);
  if (!made) throw new Error("the conversation's address was not kept");
  return made;
}

async function itemToken(db: Db, itemId: string, kind: "thread" | "owner"): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: "SELECT token FROM mail_tokens WHERE item_id = ? AND kind = ? LIMIT 1",
    params: [itemId, kind],
    method: "all",
  });
  return rows[0]?.[0] ? String(rows[0][0]) : null;
}

/** A token as stored, or null: one that is shaped right but was never made is no token. */
export async function findMailToken(db: Db, token: string): Promise<MailTokenRow | null> {
  const kind = mailTokenKind(token);
  if (!kind) return null;
  const { rows } = await db.client.query({
    sql: "SELECT token, kind, item_id, forward_id, created_at FROM mail_tokens WHERE token = ?",
    params: [token],
    method: "all",
  });
  const r = rows[0];
  // The letter and the row must agree: a check token is never read as a conversation's.
  if (!r || String(r[1]) !== kind) return null;
  return {
    token: String(r[0]),
    kind,
    itemId: r[2] === null ? null : String(r[2]),
    forwardId: r[3] === null ? null : String(r[3]),
    createdAt: Number(r[4]),
  };
}

/** Records that a token was used just now (the last time mail came to it). */
export async function touchMailToken(db: Db, token: string, now: number): Promise<void> {
  await db.client.query({
    sql: "UPDATE mail_tokens SET used_at = ? WHERE token = ?",
    params: [now, token],
    method: "run",
  });
}
