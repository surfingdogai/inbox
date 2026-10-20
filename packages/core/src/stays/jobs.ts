import { eq } from "drizzle-orm";
import type { Db } from "../db";
import type { PayloadOf } from "../domain/types";
import type { JobHandler } from "../jobs/runner";
import { ensureJob } from "../jobs/schedule";
import { items } from "../schema/tables";
import { readSettings } from "../settings/schema";
import type { Caller } from "../write/caller";
import { jobStatement } from "../write/common";
import { WriteError } from "../write/errors";
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";
import { STAY_SWEEP_PERIOD_MS, staySweepKey } from "./create";
import { stayTimes } from "./nights";
import { readProperty } from "./store";
import { STAY_CORRECTION_MS, STAY_SWEEP_KIND, type StayMessageJob } from "./transition";

/**
 * The stays sweep (ADR-033 §4.2, §4.3), every minute while any stay is open: holds, quotes, requests
 * and pay windows that lapsed are closed, changes nobody answered lapse, stays whose check-out passed
 * are completed, and claims whose hold lapsed are let go. Each is a transition like any other, judged by
 * its guard, so a sweep that runs late or twice changes nothing it should not.
 */

type StayPayload = PayloadOf<"stay">;

const BATCH = 50;
const OPEN_STATES = [
  "requested",
  "needs_info",
  "quoted",
  "held",
  "booking",
  "awaiting_payment",
  "confirmed",
  "checked_in",
];

function system(now: number): Caller {
  return {
    actor: { kind: "system", id: STAY_SWEEP_KIND, channel: "system" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
  };
}

/** Whether a stay is due a sweep transition now, and which. */
function dueEvent(
  state: string,
  p: StayPayload,
  updatedAt: number,
  now: number,
  hours: { request: number; complete: number },
  zoneTimes: () => { endAt: number },
): string | null {
  switch (state) {
    case "held":
      return p.hold && Date.parse(p.hold.until) <= now ? "expire" : null;
    case "quoted":
      return p.quote && Date.parse(p.quote.validThrough) <= now ? "expire" : null;
    case "requested":
    case "needs_info":
      return updatedAt + hours.request * 3_600_000 <= now ? "expire" : null;
    case "awaiting_payment":
      return p.payments?.dueBy && Date.parse(p.payments.dueBy) <= now ? "expire" : null;
    case "confirmed":
      if (p.change?.validThrough && Date.parse(p.change.validThrough) <= now) return "expire_change";
      return zoneTimes().endAt + hours.complete * 3_600_000 <= now ? "complete" : null;
    case "checked_in":
      return zoneTimes().endAt + hours.complete * 3_600_000 <= now ? "check_out" : null;
    default:
      return null;
  }
}

/** One run of the sweep. Answers what it did. */
export async function sweepStays(db: Db, now: number): Promise<{ moved: number; released: number; open: number }> {
  const settings = await readSettings(db);
  const { rows } = await db.client.query({
    sql: `SELECT id, state, payload, updated_at FROM items WHERE type = 'stay' AND state IN (${OPEN_STATES.map(() => "?").join(", ")})
           ORDER BY updated_at LIMIT ?`,
    params: [...OPEN_STATES, 500],
    method: "all",
  });
  let moved = 0;
  const zones = new Map<string, { checkInFrom: string; checkOutUntil: string; timezone: string } | null>();
  for (const r of rows) {
    if (moved >= BATCH) break;
    const p = JSON.parse(String(r[2])) as StayPayload;
    if (!zones.has(p.propertyId)) zones.set(p.propertyId, await readProperty(db, p.propertyId));
    const property = zones.get(p.propertyId);
    const event = dueEvent(
      String(r[1]),
      p,
      Number(r[3]),
      now,
      { request: settings.stays.requestExpiresHours, complete: settings.stays.autoCompleteHours },
      () => (property ? stayTimes(property, p.checkIn, p.checkOut) : { endAt: Number.POSITIVE_INFINITY }),
    );
    if (!event) continue;
    try {
      await transitionItem(db, system(now), { itemId: String(r[0]), event });
      moved++;
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
      // Moved meanwhile, or not due after all: the next run judges it again.
    }
  }
  // Holds that lapsed are free already (a claim reads them so); the rows go, except a write's in flight.
  const released = await db.client.query({
    sql: `DELETE FROM night_claims WHERE hold_until IS NOT NULL AND hold_until <= ?
            AND item_id NOT IN (SELECT id FROM items WHERE type = 'stay' AND state = 'booking')`,
    params: [now],
    method: "run",
  });
  return { moved, released: released.changes, open: rows.length };
}

/** The sweep job: runs, and queues the next minute's while any stay is open. */
export function staySweepHandler(): JobHandler {
  return async (_job, { db, now }) => {
    const r = await sweepStays(db, now);
    if (r.open > 0) {
      const next = (Math.floor(now / STAY_SWEEP_PERIOD_MS) + 1) * STAY_SWEEP_PERIOD_MS;
      await ensureJob(db, STAY_SWEEP_KIND, staySweepKey(next), { now, runAt: next });
    }
    return { note: `${r.moved} moved, ${r.released} lapsed holds let go, ${r.open} open` };
  };
}

/** The states a scheduled message still goes in: a stay cancelled or moved since gets none. */
const MESSAGE_STATES: Readonly<Record<StayMessageJob["kind"], readonly string[]>> = {
  before: ["confirmed"],
  arrival: ["confirmed"],
  thanks: ["completed"],
  reminder: ["awaiting_payment"],
};

/**
 * A scheduled message (§10): sent through the notify job, as every email to a guest is, only while
 * the stay is still in the state it was for and on the dates it was queued for.
 */
export function stayMessageHandler(): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as StayMessageJob;
    const [row] = await db.orm.select().from(items).where(eq(items.id, p.itemId));
    if (row?.type !== "stay") return { note: "stay gone" };
    const item = rowToItem(row);
    const payload = item.payload as StayPayload;
    if (!MESSAGE_STATES[p.kind].includes(item.state)) return { note: `not sent: the stay is ${item.state}` };
    if (payload.checkIn !== p.checkIn) return { note: "not sent: the stay moved; its new dates have their own" };
    if (p.kind === "thanks") {
      const property = await readProperty(db, payload.propertyId);
      if (property && now > stayTimes(property, payload.checkIn, payload.checkOut).endAt + STAY_CORRECTION_MS) {
        return { note: "not sent: too long after the stay" };
      }
    }
    await db.client.query(
      jobStatement("notify", { to: "customer", itemId: item.id, event: `stay_${p.kind}` }, now, {
        dedupeKey: `notify:stay_${p.kind}:${item.id}:${p.checkIn}`,
      }),
    );
    return { note: `queued: ${p.kind}` };
  };
}
