import type { Statement } from "@surfingdog/platform";
import type { AriRow } from "../connectors/sdk";
import type { Db } from "../db";
import type { WantedNights } from "../stays/claims";
import type { PropertySetup } from "../stays/store";

/**
 * What a property's own system says is free (ADR-037 §4.5), kept as the `stay_ari` cache: agents are
 * answered from it, never from the system on every question. A row is believed only while it is fresh
 * (the property's `fresh_minutes`, 15 by default) and not marked stale by a hint; a webhook body is
 * never believed, it only marks a range to read again.
 */

export interface AriCell {
  readonly roomExtId: string;
  readonly night: string;
  readonly units: number;
  readonly closed: boolean;
  readonly minStay: number | null;
  readonly maxStay: number | null;
  readonly noArrival: boolean;
  readonly noDeparture: boolean;
  readonly prices: Readonly<Record<string, number>>;
  readonly fetchedAt: number;
  readonly stale: boolean;
  readonly source: string;
}

/** The statements that write what a system said, replacing what was there for those nights. */
export function ariStatements(
  connectorId: string,
  rows: readonly AriRow[],
  source: "poll" | "live",
  now: number,
): Statement[] {
  return rows.map((r) => ({
    sql: `INSERT INTO stay_ari (connector_id, room_ext_id, night, units, closed, min_stay, max_stay, no_arrival, no_departure,
                                prices, source, fetched_at, stale)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT (connector_id, room_ext_id, night) DO UPDATE SET units = excluded.units, closed = excluded.closed,
            min_stay = excluded.min_stay, max_stay = excluded.max_stay, no_arrival = excluded.no_arrival,
            no_departure = excluded.no_departure, prices = excluded.prices, source = excluded.source,
            fetched_at = excluded.fetched_at, stale = 0`,
    params: [
      connectorId,
      r.roomId,
      r.night,
      Math.max(0, Math.trunc(r.units)),
      r.closed ? 1 : 0,
      r.minStay ?? null,
      r.maxStay ?? null,
      r.noArrival ? 1 : 0,
      r.noDeparture ? 1 : 0,
      r.prices ? JSON.stringify(r.prices) : null,
      source,
      now,
    ],
    method: "run" as const,
  }));
}

/** A hint (a webhook, a calendar change): the nights are read again before they are believed. */
export function staleStatement(connectorId: string, from: string, to: string, roomExtId?: string): Statement {
  return {
    sql: `UPDATE stay_ari SET stale = 1 WHERE connector_id = ? AND night >= ? AND night < ?${roomExtId ? " AND room_ext_id = ?" : ""}`,
    params: roomExtId ? [connectorId, from, to, roomExtId] : [connectorId, from, to],
    method: "run",
  };
}

/** The cache for some rooms and nights, as it is (fresh or not). */
export async function ariCells(
  db: Db,
  connectorId: string,
  roomExtIds: readonly string[],
  nights: readonly string[],
): Promise<AriCell[]> {
  if (roomExtIds.length === 0 || nights.length === 0) return [];
  const { rows } = await db.client.query({
    sql: `SELECT room_ext_id, night, units, closed, min_stay, max_stay, no_arrival, no_departure, prices, fetched_at, stale, source
            FROM stay_ari WHERE connector_id = ? AND room_ext_id IN (${roomExtIds.map(() => "?").join(", ")})
             AND night IN (${nights.map(() => "?").join(", ")})`,
    params: [connectorId, ...roomExtIds, ...nights],
    method: "all",
  });
  return rows.map((r) => ({
    roomExtId: String(r[0]),
    night: String(r[1]),
    units: Number(r[2]),
    closed: Number(r[3]) === 1,
    minStay: r[4] === null ? null : Number(r[4]),
    maxStay: r[5] === null ? null : Number(r[5]),
    noArrival: Number(r[6]) === 1,
    noDeparture: Number(r[7]) === 1,
    prices: typeof r[8] === "string" ? (JSON.parse(r[8]) as Record<string, number>) : {},
    fetchedAt: Number(r[9]),
    stale: Number(r[10]) === 1,
    source: String(r[11]),
  }));
}

export type NightVerdict = "free" | "full" | "unknown";

/**
 * What the cache says of a stay, room type by room type: `free` only when every night has a fresh row
 * with the units the stay takes, the stay's length within its limits, arrival and departure allowed;
 * `full` when a fresh row says no; `unknown` when any night is missing, stale or older than allowed.
 */
export async function ariVerdict(
  db: Db,
  setup: PropertySetup,
  want: WantedNights,
  now: number,
): Promise<Map<string, NightVerdict>> {
  const out = new Map<string, NightVerdict>();
  const connectorId = setup.property.connectorId;
  if (!connectorId) {
    for (const id of want.rooms.keys()) out.set(id, "unknown");
    return out;
  }
  const extOf = new Map(setup.rooms.filter((r) => r.externalId).map((r) => [r.id, r.externalId as string]));
  const cells = await ariCells(db, connectorId, [...extOf.values()], want.nights);
  const freshAfter = now - setup.property.freshMinutes * 60_000;
  const length = want.nights.length;
  for (const [roomTypeId, count] of want.rooms) {
    const ext = extOf.get(roomTypeId);
    if (!ext) {
      out.set(roomTypeId, "unknown");
      continue;
    }
    let verdict: NightVerdict = "free";
    want.nights.forEach((night, i) => {
      const c = cells.find((x) => x.roomExtId === ext && x.night === night);
      if (!c || c.stale || c.fetchedAt < freshAfter) {
        if (verdict === "free") verdict = "unknown";
        return;
      }
      const restricted =
        (i === 0 &&
          (c.noArrival || (c.minStay !== null && length < c.minStay) || (c.maxStay !== null && length > c.maxStay))) ||
        c.closed ||
        c.units < count;
      if (restricted) verdict = "full";
    });
    out.set(roomTypeId, verdict);
  }
  return out;
}

/** Whether the cache is fresh and says every room of the stay is free on every night: `instant_safe`. */
export async function ariCovers(db: Db, setup: PropertySetup, want: WantedNights, now: number): Promise<boolean> {
  if (want.rooms.size === 0) return false;
  const verdict = await ariVerdict(db, setup, want, now);
  return [...verdict.values()].every((v) => v === "free");
}

/** The prices the cache holds for a room night by night on one rate, when every night has one. */
export function cachedNights(
  cells: readonly AriCell[],
  roomExtId: string,
  rateExtId: string | null,
  nights: readonly string[],
): { night: string; amount: number }[] | null {
  const out: { night: string; amount: number }[] = [];
  for (const night of nights) {
    const c = cells.find((x) => x.roomExtId === roomExtId && x.night === night);
    const values = c ? Object.entries(c.prices) : [];
    const price = rateExtId ? c?.prices[rateExtId] : values[0]?.[1];
    if (price === undefined) return null;
    out.push({ night, amount: price });
  }
  return out;
}
