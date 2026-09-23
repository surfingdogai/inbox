import type { Statement } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { type ItemFlags, itemFlagsSchema } from "../domain/types";
import { ulid } from "../ids";
import { items } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { actorMeta, type Caller, nowOf, permissionKind } from "./caller";
import { diagnoseFailure, eventStatement, hasActiveWebhook, webhookFanoutStatement } from "./common";
import { hiddenTransitions } from "./corrections";
import { WriteError } from "./errors";
import { type ItemView, rowToItem, viewFor } from "./views";

/** Changes flags (needs_human, priority) as its own event, so version and history stay honest. */
export async function setFlags(
  db: Db,
  caller: Caller,
  input: { itemId: string; flags: Partial<ItemFlags>; reason?: string; causation?: { id: string; depth: number } },
): Promise<ItemView> {
  const now = nowOf(caller);
  const [row] = await db.orm.select().from(items).where(eq(items.id, input.itemId));
  if (!row) throw new WriteError("not_found", "no such item");
  const item = rowToItem(row);
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
  if (await hasActiveWebhook(db)) {
    statements.push(webhookFanoutStatement({ id: eventId, type: `${item.type}.flags`, itemId: item.id }, now));
  }
  try {
    await db.batch(statements);
  } catch (error) {
    await diagnoseFailure(db, error, { itemId: item.id, expectedVersion: item.version });
  }
  const hidden = await hiddenTransitions(db, [{ item, legacyPromise: row.legacyPromise }], await readSettings(db), now);
  return viewFor(
    { ...item, flags, version: seq, updatedAt: new Date(now).toISOString() } as typeof item,
    permissionKind(caller),
    undefined,
    hidden.get(item.id),
  );
}
