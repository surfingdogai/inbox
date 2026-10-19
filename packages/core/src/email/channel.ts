import { instanceId } from "../connectors/store";
import type { Db } from "../db";
import type { Settings } from "../settings/schema";
import { listForwards } from "./forwards";
import { baseAddress, ensureItemToken, plusAddress, splitAddress } from "./tokens";

/**
 * The email channel's addresses as the mail jobs use them (ADR-026): where a customer's reply goes,
 * where the owner's answer to an alert goes, and the mark every email carries so the inbox knows its
 * own mail when it comes back.
 */

/** The inbox's own address, when it has one. */
export function inboundOf(settings: Settings): string | null {
  return settings.email.inboundAddress?.trim() || null;
}

/** The header every email the inbox sends carries, with this inbox's mark (`loopMark`). */
export const LOOP_HEADER = "X-Inbox-Loop";
/** The header a forwarding check carries, with its token. */
export const CHECK_HEADER = "X-Inbox-Check";

const marks = new WeakMap<Db, string>();

/**
 * This inbox's mark: a hash of its own id, the same on every email it sends, so an email of its own
 * that comes back — the owner's alert sent to an address that forwards here, a customer's mailbox
 * sending ours back — is known and never answered (ADR-026 §7). It names nothing.
 */
export async function loopMark(db: Db, now: number = Date.now()): Promise<string> {
  const known = marks.get(db);
  if (known) return known;
  const id = await instanceId(db, now);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sdi-loop:${id}`));
  const mark = `sdi.${[...new Uint8Array(digest)]
    .slice(0, 10)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  marks.set(db, mark);
  return mark;
}

/**
 * Where a customer's reply to an email about this item goes: the conversation's own address. When
 * the business forwards an address of its own here and a check proved its plus addresses arrive,
 * the conversation's address is that address's (`support+t…@shop.example`), so the customer only ever
 * sees the business's own domain; else the inbox's (`name+t…@domain`). Null when the inbox has no
 * address of its own: the email then says what it said before (Settings' Reply-To, or none).
 */
export async function customerReplyTo(
  db: Db,
  settings: Settings,
  itemId: string,
  o: { now: number; from?: string | undefined },
): Promise<string | null> {
  const inbound = inboundOf(settings);
  if (!inbound) return null;
  const token = await ensureItemToken(db, itemId, "thread", o.now);
  const own = await businessReplyBase(db, o.from);
  return plusAddress(own ?? inbound, token);
}

/**
 * The business's own forwarded address a conversation's address may be made from: one whose forward
 * works with plus addresses, the sender's own first, then one on the sender's domain, then the one
 * proven most recently.
 */
async function businessReplyBase(db: Db, from: string | undefined): Promise<string | null> {
  const usable = (await listForwards(db)).filter((f) => f.state === "working" && f.plusOk);
  if (usable.length === 0) return null;
  const sender = from ? baseAddress(from) : null;
  const domain = from ? splitAddress(from)?.domain : undefined;
  const exact = usable.find((f) => f.address === sender);
  if (exact) return exact.address;
  const same = usable.find((f) => splitAddress(f.address)?.domain === domain);
  if (same) return same.address;
  const latest = [...usable].sort((a, b) => (b.checkSeenAt ?? 0) - (a.checkSeenAt ?? 0))[0];
  return latest?.address ?? null;
}

/** Where the owner's answer to an alert about this item goes, or null when the inbox has no address. */
export async function ownerReplyTo(db: Db, settings: Settings, itemId: string, now: number): Promise<string | null> {
  const inbound = inboundOf(settings);
  if (!inbound) return null;
  return plusAddress(inbound, await ensureItemToken(db, itemId, "owner", now));
}

/**
 * The addresses that may answer an alert by email: the ones the business's people sign in with (each
 * proved by a sign-in link it opened) and the one alerts go to. Lower case, without a plus part.
 */
export async function ownerAddresses(db: Db, settings: Settings): Promise<Set<string>> {
  const out = new Set<string>();
  const { rows } = await db.client.query({
    sql: "SELECT email FROM users WHERE role IN ('owner', 'staff')",
    params: [],
    method: "all",
  });
  for (const r of rows) {
    const a = baseAddress(String(r[0] ?? ""));
    if (a) out.add(a);
  }
  const alerts = settings.notifications.ownerEmail ? baseAddress(settings.notifications.ownerEmail) : null;
  if (alerts) out.add(alerts);
  return out;
}

/**
 * The addresses a customer must never see (ADR-026 §6): the ones the business's people sign in with.
 * A host's Reply-To, a sender, an address in Settings: none of them may be one of these, unless the
 * owner chose it as the business's own (`fromAddress`, `replyTo` in Settings on their own server).
 */
export async function signInAddresses(db: Db): Promise<Set<string>> {
  const out = new Set<string>();
  const { rows } = await db.client.query({ sql: "SELECT email FROM users", params: [], method: "all" });
  for (const r of rows) {
    const a = baseAddress(String(r[0] ?? ""));
    if (a) out.add(a);
  }
  return out;
}
