import type { Db } from "../db";
import { addDays, instantOf } from "../util/zoned";
import { readStaff } from "./store";

/**
 * One day of a salon, by member of staff (ADR-035): a column each, in the owner's order, with their
 * bookings that day in the business's zone, and a column for bookings with nobody yet. For the owner
 * app's inbox home; never shown to a customer.
 */
export interface DayBooking {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly service: string;
  /** The customer's name as the inbox knows it, unless they were erased. */
  readonly customer: string | null;
  readonly state: string;
  readonly needsHuman: boolean;
}

export interface DayColumn {
  /** Null: bookings not with anyone. */
  readonly staff: { readonly id: string; readonly name: string } | null;
  readonly bookings: readonly DayBooking[];
}

export interface StaffDay {
  readonly date: string;
  readonly zone: string;
  readonly columns: readonly DayColumn[];
}

const SHOWN = ["requested", "needs_info", "proposed", "confirmed", "completed", "no_show"];
/** Bookings read at a time, and pages at most: 10,000 bookings across three days' worth of text. */
const PAGE = 500;
const PAGES = 20;

export async function dayByStaff(db: Db, date: string, zone: string): Promise<StaffDay> {
  const from = instantOf(date, "00:00", zone);
  const to = instantOf(addDays(date, 1), "00:00", zone);
  const staff = await readStaff(db);
  // Read wide by text, then by instant in code: start times carry their own offsets. Page by page, so a
  // busy day of many chairs loses none of its bookings.
  const rows: (readonly unknown[])[] = [];
  let after: readonly [string, string] = ["", ""];
  for (let page = 0; page < PAGES; page++) {
    const { rows: got } = await db.client.query({
      sql: `SELECT i.id, i.state, i.payload, i.needs_human, p.display_name, p.erased_at, i.start_at
              FROM items i LEFT JOIN parties p ON p.id = i.party_id
             WHERE i.type = 'booking' AND i.state IN (${SHOWN.map(() => "?").join(", ")})
               AND COALESCE(i.sandbox, 0) = 0
               AND i.start_at >= ? AND i.start_at < ?
               AND (i.start_at > ? OR (i.start_at = ? AND i.id > ?))
             ORDER BY i.start_at, i.id LIMIT ${PAGE}`,
      params: [
        ...SHOWN,
        new Date(from - 86_400_000).toISOString().slice(0, 10),
        new Date(to + 86_400_000).toISOString(),
        after[0],
        after[0],
        after[1],
      ],
      method: "all",
    });
    rows.push(...got);
    const last = got[got.length - 1];
    if (got.length < PAGE || !last) break;
    after = [String(last[6]), String(last[0])];
  }
  const byStaff = new Map<string | null, DayBooking[]>();
  for (const r of rows) {
    let p: { startTime?: string; endTime?: string; resourceId?: string; reservationFor?: { name?: string } } = {};
    try {
      p = (typeof r[2] === "string" ? JSON.parse(r[2]) : r[2]) as typeof p;
    } catch {
      continue;
    }
    const start = Date.parse(p.startTime ?? "");
    if (!Number.isFinite(start) || start < from || start >= to) continue;
    const key = p.resourceId && staff.some((s) => s.id === p.resourceId) ? p.resourceId : null;
    const erased = r[5] !== null && r[5] !== undefined;
    const list = byStaff.get(key) ?? [];
    list.push({
      id: String(r[0]),
      start: p.startTime ?? "",
      end: p.endTime ?? "",
      service: p.reservationFor?.name ?? "Booking",
      customer: erased ? null : typeof r[4] === "string" && r[4].trim() ? r[4].trim().slice(0, 80) : null,
      state: String(r[1]),
      needsHuman: Number(r[3] ?? 0) === 1,
    });
    byStaff.set(key, list);
  }
  const columns: DayColumn[] = staff.map((s) => ({
    staff: { id: s.id, name: s.publicName },
    bookings: byStaff.get(s.id) ?? [],
  }));
  const nobody = byStaff.get(null);
  if (nobody?.length) columns.push({ staff: null, bookings: nobody });
  return { date, zone, columns };
}
