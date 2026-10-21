import type { Statement } from "@surfingdog/platform";
import { and, eq, gte, lte } from "drizzle-orm";
import { busyOverlapping } from "../connectors/store";
import type { Db } from "../db";
import { slotClaims } from "../schema/tables";
import { WriteError } from "./errors";

/**
 * A booking occupies time buckets of the service's granularity, including its buffers. Capacity N
 * means ordinals 0..N-1 per bucket; the primary key (resource_key, bucket_start, ordinal) is what
 * arbitrates a race, so two writers can never both get the last place (ADR-007).
 */
export interface SlotSpec {
  readonly resourceKey: string;
  readonly capacity: number;
  readonly granularityMin: number;
  readonly bufferBeforeMin: number;
  readonly bufferAfterMin: number;
  /**
   * The service booked (ADR-035). Its places are held under two keys over time: its own
   * (`service:<id>`) before anyone gave it, and each member of staff's (`resource:<id>`) since. With
   * it, each read sees the other: a member of staff is busy wherever the service's own key holds a
   * booking (nobody knows with whom), and the service's own places count every booking of it a member
   * of staff holds. A business calendar chosen for this service applies to its staff too.
   */
  readonly serviceId?: string | undefined;
}

export const MAX_BUCKETS = 96;

/**
 * Every bucket a span touches, with no cap on how many.
 *
 * Reading is not booking. `readClaims` uses only the first and last bucket, as a range, so a
 * long span costs nothing to query — and the availability search needs exactly that: one read
 * across its whole window. Putting the booking cap on this made a perfectly ordinary question,
 * "what is free on Monday", fail with "a booking may span at most 96 slots" for any service on
 * 15-minute granularity, because a day is 96 buckets and the search asks for slightly more.
 * The endpoint's own documented 14-day window could never have worked at all.
 */
export function bucketRange(spec: SlotSpec, startTime: string, endTime: string): number[] {
  const g = spec.granularityMin * 60_000;
  const start = Date.parse(startTime) - spec.bufferBeforeMin * 60_000;
  const end = Date.parse(endTime) + spec.bufferAfterMin * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new WriteError("invalid_input", "endTime must be after startTime", {
      fields: [{ path: "endTime", problem: "invalid", message: "must be after startTime" }],
    });
  }
  const first = Math.floor(start / g) * g;
  const last = Math.ceil(end / g) * g;
  const buckets: number[] = [];
  for (let b = first; b < last; b += g) buckets.push(b);
  return buckets;
}

/** The buckets ONE booking occupies, which is capped: a booking is not a search window. */
export function bucketsFor(spec: SlotSpec, startTime: string, endTime: string): number[] {
  const buckets = bucketRange(spec, startTime, endTime);
  if (buckets.length > MAX_BUCKETS) {
    throw new WriteError(
      "invalid_input",
      `a booking may span at most ${MAX_BUCKETS} slots of ${spec.granularityMin} minutes`,
      {
        fields: [{ path: "endTime", problem: "invalid", message: "booking too long" }],
      },
    );
  }
  return buckets;
}

/**
 * Existing claims per bucket, ignoring the item's own (so a re-confirm is not its own competitor),
 * and every bucket a connected calendar says is busy taken whole (ADR-022): busy times only ever
 * remove places. Every door that offers, proposes, books or moves a time reads through here, so a
 * busy time is honoured by all of them or by none.
 */
export async function readClaims(
  db: Db,
  spec: SlotSpec,
  buckets: readonly number[],
  exceptItemId: string,
): Promise<Map<number, Set<number>>> {
  const resourceKey = spec.resourceKey;
  const taken = new Map<number, Set<number>>();
  if (buckets.length === 0) return taken;
  const rows = await db.orm
    .select({ bucketStart: slotClaims.bucketStart, ordinal: slotClaims.ordinal, itemId: slotClaims.itemId })
    .from(slotClaims)
    .where(
      and(
        eq(slotClaims.resourceKey, resourceKey),
        gte(slotClaims.bucketStart, buckets[0] ?? 0),
        lte(slotClaims.bucketStart, buckets[buckets.length - 1] ?? 0),
      ),
    );
  for (const r of rows) {
    if (r.itemId === exceptItemId) continue;
    let set = taken.get(r.bucketStart);
    if (!set) {
      set = new Set();
      taken.set(r.bucketStart, set);
    }
    set.add(r.ordinal);
  }
  await otherKeys(db, spec, buckets, exceptItemId, taken);
  const g = spec.granularityMin * 60_000;
  const first = buckets[0] ?? 0;
  const last = (buckets[buckets.length - 1] ?? 0) + g;
  const busy = await busyOverlapping(db, first, last, resourceKey, spec.serviceId);
  if (busy.length > 0) {
    for (const b of buckets) {
      if (!busy.some((i) => i.start < b + g && i.end > b)) continue;
      const full = new Set<number>();
      for (let o = 0; o < Math.max(spec.capacity, 1); o++) full.add(o);
      taken.set(b, full);
    }
  }
  return taken;
}

/** Every place of a bucket, taken. */
function fill(taken: Map<number, Set<number>>, bucket: number, capacity: number, count = capacity): void {
  const set = taken.get(bucket) ?? new Set<number>();
  for (let o = 0, added = 0; o < Math.max(capacity, 1) && added < count; o++) {
    if (set.has(o)) continue;
    set.add(o);
    added++;
  }
  taken.set(bucket, set);
}

/** The service's places held under its other key (`SlotSpec.serviceId`), added to what is taken. */
async function otherKeys(
  db: Db,
  spec: SlotSpec,
  buckets: readonly number[],
  exceptItemId: string,
  taken: Map<number, Set<number>>,
): Promise<void> {
  const serviceId = spec.serviceId;
  if (!serviceId) return;
  const lo = buckets[0] ?? 0;
  const hi = buckets[buckets.length - 1] ?? 0;
  if (spec.resourceKey.startsWith("resource:")) {
    // Booked before anyone gave it: whoever it is with, nobody here is free then.
    const { rows } = await db.client.query({
      sql: `SELECT DISTINCT bucket_start FROM slot_claims
             WHERE resource_key = ? AND bucket_start >= ? AND bucket_start <= ? AND item_id <> ?`,
      params: [`service:${serviceId}`, lo, hi, exceptItemId],
      method: "all",
    });
    for (const r of rows) fill(taken, Number(r[0]), spec.capacity);
    return;
  }
  if (spec.resourceKey !== `service:${serviceId}`) return;
  // With nobody giving it now: each of its bookings a member of staff still holds takes a place.
  const { rows } = await db.client.query({
    sql: `SELECT c.bucket_start, COUNT(DISTINCT c.item_id) FROM slot_claims c JOIN items i ON i.id = c.item_id
           WHERE c.resource_key LIKE 'resource:%' AND c.bucket_start >= ? AND c.bucket_start <= ? AND c.item_id <> ?
             AND json_extract(i.payload, '$.reservationFor.serviceId') = ?
           GROUP BY c.bucket_start`,
    params: [lo, hi, exceptItemId, serviceId],
    method: "all",
  });
  for (const r of rows) fill(taken, Number(r[0]), spec.capacity, Number(r[1]));
}

/** Picks the lowest free ordinal per bucket, or reports the first full bucket. */
export function planClaims(
  spec: SlotSpec,
  buckets: readonly number[],
  taken: Map<number, Set<number>>,
): { ok: true; claims: [number, number][] } | { ok: false; fullBucket: number } {
  const claims: [number, number][] = [];
  for (const b of buckets) {
    const used = taken.get(b) ?? new Set<number>();
    let ordinal = -1;
    for (let o = 0; o < spec.capacity; o++) {
      if (!used.has(o)) {
        ordinal = o;
        break;
      }
    }
    if (ordinal < 0) return { ok: false, fullBucket: b };
    claims.push([b, ordinal]);
  }
  return { ok: true, claims };
}

/**
 * INSERT statements for the claims, 20 rows each to stay under D1's 100 bound parameters. A claim
 * with `offerId` is a hold: a time we proposed, kept for the customer until they answer.
 */
export function claimStatements(
  resourceKey: string,
  itemId: string,
  claims: readonly [number, number][],
  offerId = "",
): Statement[] {
  const out: Statement[] = [];
  for (let i = 0; i < claims.length; i += 20) {
    const chunk = claims.slice(i, i + 20);
    out.push({
      sql: `INSERT INTO slot_claims (resource_key, bucket_start, ordinal, item_id, offer_id) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      params: chunk.flatMap(([bucket, ordinal]) => [resourceKey, bucket, ordinal, itemId, offerId]),
      method: "run",
    });
  }
  return out;
}

export function releaseStatement(itemId: string): Statement {
  return { sql: "DELETE FROM slot_claims WHERE item_id = ?", params: [itemId], method: "run" };
}

/** Lets go of a time held for the customer; an agreed booking's own claim is never touched. */
export function releaseHoldStatement(itemId: string): Statement {
  return { sql: "DELETE FROM slot_claims WHERE item_id = ? AND offer_id <> ''", params: [itemId], method: "run" };
}

/**
 * How many other items of this customer hold a time right now (ADR-018 §3.1): their party's, or the
 * assistant's that made the request (its key's thumbprint), so no one parks places by asking.
 */
export async function holdsOf(
  db: Db,
  who: { readonly itemId: string; readonly partyId: string; readonly agent: string | null },
): Promise<number> {
  const { rows } = await db.client.query({
    sql: `SELECT COUNT(DISTINCT c.item_id) FROM slot_claims c JOIN items i ON i.id = c.item_id
           WHERE c.offer_id <> '' AND c.item_id <> ? AND (i.party_id = ? OR (? IS NOT NULL AND i.agent_thumbprint = ?))`,
    params: [who.itemId, who.partyId, who.agent, who.agent],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}
