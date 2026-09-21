import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { ulid } from "../ids";
import { type Caller, nowOf } from "./caller";
import { jobStatement, threadEntryStatement } from "./common";

/** Adds a conversation entry without changing state; customer-facing ones queue a notification. */
export async function appendThreadEntry(
  db: Db,
  caller: Caller,
  item: Item,
  body: string,
  direction: "in" | "out" | "note",
): Promise<void> {
  const now = nowOf(caller);
  const statements: Statement[] = [
    threadEntryStatement({
      itemId: item.id,
      direction,
      channel: caller.actor.channel,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      partyId: direction === "in" ? item.partyId : null,
      body,
      now,
    }),
    { sql: "UPDATE items SET updated_at = ? WHERE id = ?", params: [now, item.id], method: "run" },
  ];
  if (direction !== "note") {
    const to = direction === "in" ? "owner" : "customer";
    statements.push(jobStatement("notify", { to, itemId: item.id, event: "message", entry: ulid() }, now));
  }
  await db.batch(statements);
}
