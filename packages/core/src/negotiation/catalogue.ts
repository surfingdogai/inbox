import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";

/**
 * The owner's floors (ADR-018 §4): the lowest price automation may go to for a product or a service,
 * on the same basis as its price (a product's per unit; a service's per booking, or per person when it
 * is priced per person). The owner's alone: read by the limits and by the owner in person, never by a
 * public door, the owner's AI or another system's key, and kept out of every catalogue row.
 */
export type FloorKind = "product" | "service";

/** At most this many values in one `IN (…)`: D1 binds at most 100 parameters to a statement. */
const CHUNK = 90;

/** The floors of these products or services, by id; one without a floor is absent. */
export async function floorsFor(db: Db, kind: FloorKind, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const { rows } = await db.client.query({
      sql: `SELECT ref_id, floor_minor FROM price_floors WHERE kind = ? AND ref_id IN (${chunk.map(() => "?").join(", ")})`,
      params: [kind, ...chunk],
      method: "all",
    });
    for (const r of rows) out.set(String(r[0]), Number(r[1]));
  }
  return out;
}

export interface FloorView {
  readonly kind: FloorKind;
  readonly ref_id: string;
  readonly floor_minor: number;
  readonly updated_at: string;
}

/** Every floor the owner set. */
export async function allFloors(db: Db): Promise<FloorView[]> {
  const { rows } = await db.client.query({
    sql: "SELECT kind, ref_id, floor_minor, updated_at FROM price_floors ORDER BY kind, ref_id",
    params: [],
    method: "all",
  });
  return rows.map((r) => ({
    kind: String(r[0]) as FloorKind,
    ref_id: String(r[1]),
    floor_minor: Number(r[2]),
    updated_at: new Date(Number(r[3])).toISOString(),
  }));
}

/** Sets a floor, or clears it with null. */
export function floorStatement(kind: FloorKind, refId: string, floorMinor: number | null, now: number): Statement {
  return floorMinor === null
    ? { sql: "DELETE FROM price_floors WHERE kind = ? AND ref_id = ?", params: [kind, refId], method: "run" }
    : {
        sql: `INSERT INTO price_floors (kind, ref_id, floor_minor, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (kind, ref_id) DO UPDATE SET floor_minor = excluded.floor_minor, updated_at = excluded.updated_at`,
        params: [kind, refId, floorMinor, now],
        method: "run",
      };
}
