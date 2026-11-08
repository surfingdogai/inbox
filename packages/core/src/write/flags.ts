import type { Statement } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { ownerClock } from "../customer/audience";
import type { Db } from "../db";
import { type Item, type ItemFlags, itemFlagsSchema } from "../domain/types";
import { ulid } from "../ids";
import { items } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { actorMeta, type Caller, isPerson, nowOf, permissionKind } from "./caller";
import { diagnoseFailure, eventStatement, hasEventListeners, webhookFanoutStatement } from "./common";
import { hiddenTransitions } from "./corrections";
import { WriteError } from "./errors";
import { type ItemView, rowToItem, viewFor } from "./views";

/**
 * Whether the item is mail for an account the business holds (`flags.account`): a code, a sign-in
 * link, a password reset. It goes to the owner only, never to a rule, a webhook or a shared list.
 */
export async function isAccountItem(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM items WHERE id = ? AND json_extract(flags, '$.account') = 1",
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * Mail only a person at the business reads: an account's (`flags.account`) or a notice
 * (`flags.notice`). No rule acts on it, no webhook or event stream carries it, no key or AI reads its
 * words, and nothing of it goes to a shared list.
 */
export function isOwnerOnly(flags: Pick<ItemFlags, "account" | "notice">): boolean {
  return flags.account === true || flags.notice === true;
}

/** The same test in SQL, of the `flags` column named (`items.flags`, say). */
export function ownerOnlySql(column = "flags"): string {
  return `(COALESCE(json_extract(${column}, '$.account'), 0) = 1 OR COALESCE(json_extract(${column}, '$.notice'), 0) = 1)`;
}

/** A notice that waits under Notices, one the owner has not moved to the inbox, in SQL. */
export function noticeListedSql(column = "flags"): string {
  return `(COALESCE(json_extract(${column}, '$.notice'), 0) = 1 AND COALESCE(json_extract(${column}, '$.inInbox'), 0) <> 1)`;
}

/** Whether the item is the owner's alone (`isOwnerOnly`), read from the database. */
export async function isOwnerOnlyItem(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM items WHERE id = ? AND ${ownerOnlySql()}`,
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * Whether the caller reads what owner-only mail says (an account's, a notice): a person at the
 * business only. Not the owner's AI, which a customer's words can steer, and not a key handed to
 * another system.
 */
export function readsAccountMail(caller: Caller): boolean {
  return isPerson(caller);
}

/** What anyone else reads in place of each of its words: that it came, never its code or its link. */
export const ACCOUNT_WITHHELD =
  "A code or a sign-in link for an account the business holds: only a person at the business reads it, in the inbox.";

/** The same for a notice: that an email from a system came, never what it says. */
export const NOTICE_WITHHELD =
  "An email from a system (a receipt, an account's or a newsletter's mail): only a person at the business reads it, in the inbox.";

/** What anyone but a person at the business reads in place of an owner-only item's words. */
export function withheldText(flags: Pick<ItemFlags, "account" | "notice">): string {
  return flags.account ? ACCOUNT_WITHHELD : NOTICE_WITHHELD;
}

/** The item as anyone but a person at the business reads it: its subject and its words withheld. */
export function withheldItem(item: Item): Item {
  if (item.type !== "message" || !isOwnerOnly(item.flags)) return item;
  return { ...item, subject: null, payload: { text: withheldText(item.flags) } };
}

/**
 * Changes flags (needs_human, priority) as its own event, so version and history stay honest.
 * `onlyChanges`: flags the item has already change nothing, and write no event (a press repeated, or
 * racing another, moves a notice to the inbox once); the item is returned as it is.
 */
export async function setFlags(
  db: Db,
  caller: Caller,
  input: {
    itemId: string;
    flags: Partial<ItemFlags>;
    reason?: string;
    causation?: { id: string; depth: number };
    onlyChanges?: true;
  },
): Promise<ItemView> {
  const now = nowOf(caller);
  const [row] = await db.orm.select().from(items).where(eq(items.id, input.itemId));
  if (!row) throw new WriteError("not_found", "no such item");
  const item = rowToItem(row);
  if (input.onlyChanges && Object.entries(input.flags).every(([k, v]) => item.flags[k as keyof ItemFlags] === v)) {
    const settings = await readSettings(db);
    const hidden = await hiddenTransitions(db, [{ item, legacyPromise: row.legacyPromise }], settings, now);
    return viewFor(item, permissionKind(caller), undefined, hidden.get(item.id), await ownerClock(db, settings));
  }
  const flags = itemFlagsSchema.parse({ ...item.flags, ...input.flags });
  const seq = item.version + 1;
  const eventId = ulid();
  const statements: Statement[] = [
    eventStatement({
      id: eventId,
      itemId: item.id,
      seq,
      event: "flags",
      fromState: item.state,
      toState: item.state,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      reason: input.reason ?? null,
      diff: { flags: [item.flags, flags] },
      meta: { channel: caller.actor.channel, ...actorMeta(caller) },
      causationId: input.causation?.id ?? null,
      depth: input.causation?.depth ?? 0,
      now,
    }),
    {
      sql: "UPDATE items SET flags = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
      params: [JSON.stringify(flags), seq, now, item.id, item.version],
      method: "run",
    },
  ];
  // `events_v1` shows this as `<type>.flags` whether or not anyone subscribed, so a poller of the
  // cursor sees it. An endpoint has to see the same event, or the two halves of ADR-015 disagree
  // about what an event is — and "needs a human" being raised is exactly what an integration is
  // for.
  if (await hasEventListeners(db)) {
    statements.push(webhookFanoutStatement({ id: eventId, type: `${item.type}.flags`, itemId: item.id }, now));
  }
  try {
    await db.batch(statements);
  } catch (error) {
    await diagnoseFailure(db, error, { itemId: item.id, expectedVersion: item.version });
  }
  const settings = await readSettings(db);
  const hidden = await hiddenTransitions(db, [{ item, legacyPromise: row.legacyPromise }], settings, now);
  return viewFor(
    { ...item, flags, version: seq, updatedAt: new Date(now).toISOString() } as typeof item,
    permissionKind(caller),
    undefined,
    hidden.get(item.id),
    await ownerClock(db, settings),
  );
}
