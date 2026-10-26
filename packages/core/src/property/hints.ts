import type { Db } from "../db";
import { addDays, instantOf } from "../util/zoned";

/**
 * Calendar links as night hints (ADR-037 §4.4): an iCal link mapped to a room type (one per listing,
 * from Airbnb, Booking.com or Vrbo) says which nights another channel took. They lag hours to a day, so
 * they never confirm, never decline and never count in claims: a hint shows the owner a hatched night,
 * tells an agent `likely_taken`, and asks a person (rule R4). The mapping is the connection's own
 * `config_public` (`stayRoomTypeId`, `units`), set by the owner; the calendar connector is unchanged.
 */

export interface NightHint {
  readonly night: string;
  /** The calendar's name, as the owner connected it ("Airbnb"). */
  readonly source: string;
  readonly connectorId: string;
}

/** The calendars mapped to a room type, with their current busy times' generation. */
async function mapped(db: Db, roomTypeId: string): Promise<{ id: string; name: string; gen: number | null }[]> {
  const { rows } = await db.client.query({
    sql: `SELECT id, COALESCE(json_extract(config_public, '$.account'), name), busy_gen FROM connectors
           WHERE kind = 'ics' AND status <> 'disabled' AND json_extract(config_public, '$.stayRoomTypeId') = ?`,
    params: [roomTypeId],
    method: "all",
  });
  return rows.map((r) => ({
    id: String(r[0]),
    name: String(r[1] ?? "Calendar"),
    gen: r[2] === null ? null : Number(r[2]),
  }));
}

/**
 * The nights among these that a mapped calendar shows as taken. A night is the stretch from noon on its
 * date to midnight after, in the property's zone: an all-day event from check-in to check-out covers
 * exactly its nights.
 */
export async function hintedNights(
  db: Db,
  roomTypeId: string,
  nights: readonly string[],
  zone: string,
): Promise<NightHint[]> {
  if (nights.length === 0) return [];
  const calendars = (await mapped(db, roomTypeId)).filter((c) => c.gen !== null);
  if (calendars.length === 0) return [];
  const first = nights[0] as string;
  const last = nights[nights.length - 1] as string;
  const from = instantOf(first, "12:00", zone);
  const to = instantOf(addDays(last, 1), "00:00", zone);
  const out: NightHint[] = [];
  for (const cal of calendars) {
    const { rows } = await db.client.query({
      sql: "SELECT start_ms, end_ms FROM connector_busy WHERE connector_id = ? AND gen = ? AND end_ms > ? AND start_ms < ?",
      params: [cal.id, cal.gen, from, to],
      method: "all",
    });
    const spans = rows.map((r) => ({ start: Number(r[0]), end: Number(r[1]) }));
    for (const night of nights) {
      const a = instantOf(night, "12:00", zone);
      const b = instantOf(addDays(night, 1), "00:00", zone);
      if (spans.some((s) => s.start < b && s.end > a)) out.push({ night, source: cal.name, connectorId: cal.id });
    }
  }
  return out;
}

/** Maps a calendar link to a room type, or takes the mapping off (`roomTypeId` null). */
export async function mapCalendar(
  db: Db,
  connectorId: string,
  roomTypeId: string | null,
  units: number,
  now: number,
): Promise<boolean> {
  const r = await db.client.query({
    sql: roomTypeId
      ? `UPDATE connectors SET config_public = json_set(config_public, '$.stayRoomTypeId', ?, '$.units', ?), updated_at = ?
          WHERE id = ? AND kind = 'ics'`
      : `UPDATE connectors SET config_public = json_remove(config_public, '$.stayRoomTypeId', '$.units'), updated_at = ?
          WHERE id = ? AND kind = 'ics'`,
    params: roomTypeId ? [roomTypeId, units, now, connectorId] : [now, connectorId],
    method: "run",
  });
  return r.changes === 1;
}
