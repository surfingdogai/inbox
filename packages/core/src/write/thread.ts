import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { ulid } from "../ids";
import { type Caller, nowOf } from "./caller";
import { hasActiveWebhook, jobStatement, threadEntryStatement, webhookFanoutStatement } from "./common";

/**
 * Adds a conversation entry without changing state; customer-facing ones queue a notification.
 * `quiet`: kept, but nobody is told — what a customer writes on a message the business put aside as
 * spam.
 */
export async function appendThreadEntry(
  db: Db,
  caller: Caller,
  item: Item,
  body: string,
  direction: "in" | "out" | "note",
  messageId?: string | undefined,
  opts: { readonly quiet?: boolean; readonly writtenBy?: "person" | "automation" | null } = {},
): Promise<void> {
  const now = nowOf(caller);
  // The entry's own id, minted here because it is also the id this message has in the developer
  // event stream: `events_v1` reads `thread_entries.id` for its inbound-message arm.
  const entryId = ulid();
  const statements: Statement[] = [
    threadEntryStatement({
      id: entryId,
      itemId: item.id,
      direction,
      channel: caller.actor.channel,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      partyId: direction === "in" ? item.partyId : null,
      body,
      messageId: messageId ?? null,
      writtenBy: opts.writtenBy ?? null,
      now,
    }),
    { sql: "UPDATE items SET updated_at = ? WHERE id = ?", params: [now, item.id], method: "run" },
  ];
  if (direction !== "note" && !opts.quiet) {
    const to = direction === "in" ? "owner" : "customer";
    statements.push(jobStatement("notify", { to, itemId: item.id, event: "message", entry: entryId }, now));
  }
  // Only an inbound entry is an event: `events_v1` carries what the customer said, never our reply.
  if (direction === "in" && (await hasActiveWebhook(db))) {
    statements.push(webhookFanoutStatement({ id: entryId, type: `${item.type}.message`, itemId: item.id }, now));
  }
  await db.batch(statements);
}
