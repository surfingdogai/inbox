import type { Statement } from "@surfingdog/platform";
import { and, eq, gte, lte } from "drizzle-orm";
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

/** Existing claims per bucket, ignoring the item's own (so a re-confirm is not its own competitor). */
export async function readClaims(
  db: Db,
  resourceKey: string,
  buckets: readonly number[],
  exceptItemId: string,
): Promise<Map<number, Set<number>>> {
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
  return taken;
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

/** INSERT statements for the claims, 25 rows each to stay under D1's 100 bound parameters. */
export function claimStatements(resourceKey: string, itemId: string, claims: readonly [number, number][]): Statement[] {
  const out: Statement[] = [];
  for (let i = 0; i < claims.length; i += 25) {
    const chunk = claims.slice(i, i + 25);
    out.push({
      sql: `INSERT INTO slot_claims (resource_key, bucket_start, ordinal, item_id) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`,
      params: chunk.flatMap(([bucket, ordinal]) => [resourceKey, bucket, ordinal, itemId]),
      method: "run",
    });
  }
  return out;
}

export function releaseStatement(itemId: string): Statement {
  return { sql: "DELETE FROM slot_claims WHERE item_id = ?", params: [itemId], method: "run" };
}
