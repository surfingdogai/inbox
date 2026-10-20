import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { covers } from "./nights";
import type { AllotmentRow, PropertySetup } from "./store";

/**
 * Night claims (ADR-033 §4.2): one ordinal per unit per night, so two stays never hold the same room on
 * the same night through the inbox. The primary key arbitrates the last room as `slot_claims` does for
 * minutes: claims go in the write's own batch with a plain INSERT, and two writes that meet make one
 * claim and one failed batch, which is judged again. A held claim (`hold_until`) lapses on its own; the
 * sweep deletes lapsed ones, and a claim reads a lapsed one as free meanwhile.
 */

export interface WantedNights {
  /** Room type → how many rooms of it the stay takes. */
  readonly rooms: ReadonlyMap<string, number>;
  readonly nights: readonly string[];
}

/** Room type ids of a stay's rooms, counted. */
export function wantedRooms(rooms: readonly { readonly roomTypeId?: string | undefined }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rooms) if (r.roomTypeId) out.set(r.roomTypeId, (out.get(r.roomTypeId) ?? 0) + 1);
  return out;
}

interface Taken {
  readonly roomTypeId: string;
  readonly night: string;
  readonly ordinal: number;
  readonly itemId: string;
  readonly holdUntil: number | null;
}

async function takenOf(db: Db, roomTypeIds: readonly string[], nights: readonly string[]): Promise<Taken[]> {
  if (roomTypeIds.length === 0 || nights.length === 0) return [];
  const { rows } = await db.client.query({
    sql: `SELECT room_type_id, night, ordinal, item_id, hold_until FROM night_claims
           WHERE room_type_id IN (${roomTypeIds.map(() => "?").join(", ")})
             AND night IN (${nights.map(() => "?").join(", ")})`,
    params: [...roomTypeIds, ...nights],
    method: "all",
  });
  return rows.map((r) => ({
    roomTypeId: String(r[0]),
    night: String(r[1]),
    ordinal: Number(r[2]),
    itemId: String(r[3]),
    holdUntil: r[4] === null || r[4] === undefined ? null : Number(r[4]),
  }));
}

/** Whether a claim still holds its unit: for good, or held until a time still to come. */
const live = (t: Taken, now: number) => t.holdUntil === null || t.holdUntil > now;

export type ClaimPlan =
  | {
      readonly ok: true;
      readonly statements: Statement[];
      readonly claims: readonly (readonly [string, string, number])[];
    }
  | { readonly ok: false; readonly roomTypeId: string; readonly night: string };

/**
 * The claims a stay takes, as statements for the write's batch: its own claims replaced, a lapsed hold
 * on a unit it takes deleted, and one row per room per night. `holdUntil` null: the stay's for good.
 */
export async function planNightClaims(
  db: Db,
  setup: PropertySetup,
  itemId: string,
  want: WantedNights,
  holdUntil: number | null,
  now: number,
): Promise<ClaimPlan> {
  const ids = [...want.rooms.keys()];
  const taken = await takenOf(db, ids, want.nights);
  const statements: Statement[] = [
    { sql: "DELETE FROM night_claims WHERE item_id = ?", params: [itemId], method: "run" },
  ];
  const claims: [string, string, number][] = [];
  for (const [roomTypeId, count] of want.rooms) {
    const room = setup.rooms.find((r) => r.id === roomTypeId);
    const capacity = room?.units ?? 0;
    for (const night of want.nights) {
      const busy = new Set(
        taken
          .filter((t) => t.roomTypeId === roomTypeId && t.night === night && t.itemId !== itemId && live(t, now))
          .map((t) => t.ordinal),
      );
      const free: number[] = [];
      for (let o = 0; o < capacity && free.length < count; o++) if (!busy.has(o)) free.push(o);
      if (free.length < count) return { ok: false, roomTypeId, night };
      for (const o of free) {
        // A lapsed hold on the unit goes in the same batch: a live one there makes the batch fail.
        statements.push({
          sql: `DELETE FROM night_claims WHERE room_type_id = ? AND night = ? AND ordinal = ? AND item_id <> ?
                  AND hold_until IS NOT NULL AND hold_until <= ?`,
          params: [roomTypeId, night, o, itemId, now],
          method: "run",
        });
        statements.push({
          sql: "INSERT INTO night_claims (room_type_id, night, ordinal, item_id, hold_until) VALUES (?, ?, ?, ?, ?)",
          params: [roomTypeId, night, o, itemId, holdUntil],
          method: "run",
        });
        claims.push([roomTypeId, night, o]);
      }
    }
  }
  return { ok: true, statements, claims };
}

/** Whether every night of the stay has the units it takes free, counting every other stay's live claims. */
export async function nightsFree(
  db: Db,
  setup: PropertySetup,
  itemId: string,
  want: WantedNights,
  now: number,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly roomTypeId: string; readonly night: string }> {
  const plan = await planNightClaims(db, setup, itemId, want, null, now);
  return plan.ok ? { ok: true } : { ok: false, roomTypeId: plan.roomTypeId, night: plan.night };
}

/** The claims' hold made the stay's for good (`promote_claims`). */
export function promoteStatement(itemId: string): Statement {
  return { sql: "UPDATE night_claims SET hold_until = NULL WHERE item_id = ?", params: [itemId], method: "run" };
}

/** Every claim of the stay let go (`release_nights`). */
export function releaseStatement(itemId: string): Statement {
  return { sql: "DELETE FROM night_claims WHERE item_id = ?", params: [itemId], method: "run" };
}

/** The claims of nights after a no-show's first: the rooms are free for the rest (`release_nights` on a no-show). */
export function releaseAfterStatement(itemId: string, firstNight: string): Statement {
  return {
    sql: "DELETE FROM night_claims WHERE item_id = ? AND night > ?",
    params: [itemId, firstNight],
    method: "run",
  };
}

/** A hold's claims kept until a new time (a deposit's window, a write in flight). */
export function holdUntilStatement(itemId: string, until: number): Statement {
  return {
    sql: "UPDATE night_claims SET hold_until = ? WHERE item_id = ? AND hold_until IS NOT NULL",
    params: [until, itemId],
    method: "run",
  };
}

/** The allotment rows that cover a night of a room type, the latest set first. */
export function allotmentsFor(allotments: readonly AllotmentRow[], roomTypeId: string, night: string): AllotmentRow[] {
  return allotments
    .filter(
      (a) =>
        a.roomTypeId === roomTypeId && covers({ fromDate: a.fromDate, toDate: a.toDate, weekdays: a.weekdays }, night),
    )
    .sort((a, b) => b.closedElsewhereAt - a.closedElsewhereAt);
}

/**
 * Whether the stay fits inside the rooms the owner keeps for direct guests, closed on every other
 * channel, on every night: each night's allotment, less every live claim on it, holds the rooms it
 * takes. Counting every claim against it is the safe side: fewer stays confirm at once, never more.
 */
export async function insideAllotment(
  db: Db,
  setup: PropertySetup,
  itemId: string,
  want: WantedNights,
  now: number,
): Promise<boolean> {
  const taken = await takenOf(db, [...want.rooms.keys()], want.nights);
  for (const [roomTypeId, count] of want.rooms) {
    for (const night of want.nights) {
      const units = allotmentsFor(setup.allotments, roomTypeId, night)[0]?.units ?? 0;
      const used = taken.filter(
        (t) => t.roomTypeId === roomTypeId && t.night === night && t.itemId !== itemId && live(t, now),
      ).length;
      if (units - used < count) return false;
    }
  }
  return true;
}

/** Nights the owner closed for a room type or the whole property, among these. */
export function closedNights(setup: PropertySetup, roomTypeId: string, nights: readonly string[]): string[] {
  return nights.filter((n) =>
    setup.closures.some(
      (c) => (c.roomTypeId === "" || c.roomTypeId === roomTypeId) && c.fromDate <= n && n <= (c.toDate || c.fromDate),
    ),
  );
}
