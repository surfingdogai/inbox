import type { Statement } from "@surfingdog/platform";
import type { OrderProgress } from "@surfingdog/spec";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { ulid } from "../ids";
import { items } from "../schema/tables";
import { actorMeta, type Caller, isCustomer, nowOf } from "../write/caller";
import {
  eventStatement,
  hasEventListeners,
  jobStatement,
  threadEntryStatement,
  webhookFanoutStatement,
} from "../write/common";
import { WriteError } from "../write/errors";
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";

/**
 * A kitchen's progress inside fulfilling (ADR-036): preparing, ready, out for delivery, and when it
 * expects it. Fields on the order (`payload.progress`), never states: the order machine is unchanged.
 * An accepted or paid order starts fulfilment first, as `start_fulfilment` does, then takes the
 * progress, which the customer's agent reads on `get_item_status` and a webhook carries as
 * `order.progress`.
 */

export const PROGRESS_STAGES = ["preparing", "ready", "out_for_delivery"] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

async function load(db: Db, itemId: string): Promise<Item> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, itemId));
  if (!row) throw new WriteError("not_found", "no such item");
  return rowToItem(row);
}

export async function setOrderProgress(
  db: Db,
  caller: Caller,
  input: { readonly itemId: string; readonly stage: ProgressStage; readonly etaAt?: string | undefined },
): Promise<Item> {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "only the business says how far an order is");
  const now = nowOf(caller);
  let item = await load(db, input.itemId);
  if (item.type !== "order") throw new WriteError("invalid_input", "progress is for orders");
  if (input.stage === "out_for_delivery" && item.payload.fulfil && item.payload.fulfil.method !== "delivery") {
    throw new WriteError("invalid_input", "only an order for delivery goes out for delivery", {
      fields: [{ path: "stage", problem: "invalid", message: "not a delivery" }],
    });
  }
  if (input.etaAt !== undefined && !Number.isFinite(Date.parse(input.etaAt))) {
    throw new WriteError("invalid_input", "etaAt is a timestamp", {
      fields: [{ path: "etaAt", problem: "invalid", message: "an ISO 8601 timestamp" }],
    });
  }
  if (item.state === "accepted" || item.state === "paid") {
    await transitionItem(db, caller, { itemId: item.id, event: "start_fulfilment" });
    item = await load(db, item.id);
  }
  if (item.type !== "order") throw new WriteError("invalid_input", "progress is for orders");
  if (item.state !== "fulfilling") {
    throw new WriteError("wrong_state", `progress is for an order being fulfilled; this one is ${item.state}`, {
      details: { state: item.state },
    });
  }
  const progress: OrderProgress = {
    stage: input.stage,
    at: new Date(now).toISOString(),
    ...(input.etaAt ? { etaAt: new Date(Date.parse(input.etaAt)).toISOString() } : {}),
  };
  const was = item.payload.progress;
  if (was?.stage === progress.stage && was.etaAt === progress.etaAt) return item;
  const payload = { ...item.payload, progress };
  const seq = item.version + 1;
  const eventId = ulid();
  const statements: Statement[] = [
    eventStatement({
      id: eventId,
      itemId: item.id,
      seq,
      event: "progress",
      fromState: item.state,
      toState: item.state,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      reason: `Order ${progress.stage.replaceAll("_", " ")}`,
      diff: { progress: [was ?? null, progress] },
      meta: { channel: caller.actor.channel, ...actorMeta(caller) },
      now,
    }),
    {
      sql: "UPDATE items SET version = ?, payload = ?, updated_at = ? WHERE id = ? AND version = ?",
      params: [seq, JSON.stringify(payload), now, item.id, item.version],
      method: "run",
    },
  ];
  if (await hasEventListeners(db)) {
    statements.push(webhookFanoutStatement({ id: eventId, type: "order.progress", itemId: item.id }, now));
  }
  // Another write took this version first: the event's own (item, seq) key refuses the whole batch.
  try {
    await db.batch(statements);
  } catch {
    throw new WriteError("version_conflict", "the order changed while you were writing; read it again and retry");
  }
  return load(db, item.id);
}

/**
 * An order a person must look at again (ADR-036): a till refused or cancelled what the inbox wrote to
 * it. A note in the order's thread, in the till's words, and the order marked for a person. One batch.
 */
export async function markForPerson(db: Db, itemId: string, note: string, now: number): Promise<void> {
  const item = await load(db, itemId);
  const flags = { ...item.flags, needsHuman: true };
  const seq = item.version + 1;
  const eventId = ulid();
  await db.batch([
    threadEntryStatement({
      id: ulid(),
      itemId: item.id,
      direction: "note",
      channel: "connector",
      actorKind: "connector",
      actorId: "pos",
      partyId: null,
      body: note,
      now,
    }),
    eventStatement({
      id: eventId,
      itemId: item.id,
      seq,
      event: "flags",
      fromState: item.state,
      toState: item.state,
      actorKind: "connector",
      actorId: "pos",
      reason: note.slice(0, 200),
      diff: { flags: [item.flags, flags] },
      meta: { channel: "connector" },
      now,
    }),
    {
      sql: "UPDATE items SET version = ?, flags = ?, updated_at = ? WHERE id = ? AND version = ?",
      params: [seq, JSON.stringify(flags), now, item.id, item.version],
      method: "run",
    },
    jobStatement("notify", { to: "owner", itemId: item.id, event: "flags", eventId }, now, {
      dedupeKey: `notify:pos:${item.id}:${Math.floor(now / 3_600_000)}`,
    }),
  ]);
}
