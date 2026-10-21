import { describe, expect, it } from "vitest";
import { hintedNights, mapCalendar } from "../src/property/hints";
import { instantOf } from "../src/util/zoned";
import { clock, guest, kijaniHouse, owner } from "./stay-fixtures";

/**
 * Calendar links as night hints (ADR-033 §4.4): a night is noon on its date to the midnight after, in
 * the property's zone, so an all-day event from check-in to check-out covers exactly its nights and a
 * morning's cleaning covers none; a calendar not mapped to the room, or switched off, says nothing;
 * and a hint is shown to the owner and an agent, never counted as a room taken.
 */
const ZONE = "Africa/Nairobi";

async function calendar(db: Awaited<ReturnType<typeof kijaniHouse>>["db"], id: string, spans: [number, number][]) {
  await db.client.batch([
    {
      sql: `INSERT INTO connectors (id, kind, name, config_enc, config_public, status, busy_gen, created_at, updated_at)
            VALUES (?, 'ics', 'Vrbo', NULL, '{"account":"Vrbo"}', 'active', 1, ?, ?)`,
      params: [id, clock.now, clock.now],
      method: "run",
    },
    ...spans.map(([a, b]) => ({
      sql: "INSERT INTO connector_busy (connector_id, gen, start_ms, end_ms) VALUES (?, 1, ?, ?)",
      params: [id, a, b],
      method: "run" as const,
    })),
  ]);
}

describe("calendar links as night hints", () => {
  it("covers exactly the nights of an all-day stay, and none for a morning's cleaning", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    await calendar(k.db, "cal_vrbo", [
      [instantOf("2026-12-12", "00:00", ZONE), instantOf("2026-12-14", "00:00", ZONE)],
      [instantOf("2026-12-20", "09:00", ZONE), instantOf("2026-12-20", "11:00", ZONE)],
    ]);
    const nights = ["2026-12-11", "2026-12-12", "2026-12-13", "2026-12-14", "2026-12-20"];
    // Not mapped to the room yet: nothing.
    expect(await hintedNights(k.db, k.rooms.garden, nights, ZONE)).toEqual([]);
    await mapCalendar(k.db, "cal_vrbo", k.rooms.garden, 1, clock.now);
    expect((await hintedNights(k.db, k.rooms.garden, nights, ZONE)).map((h) => [h.night, h.source])).toEqual([
      ["2026-12-12", "Vrbo"],
      ["2026-12-13", "Vrbo"],
    ]);
    // The owner's grid shows it; an agent reads likely_taken; nothing is claimed.
    const grid = await k.caps.stays.nights(owner, { from: "2026-12-11", days: 4 });
    expect(grid.rooms[0]?.cells.map((c) => c.hint)).toEqual([null, "Vrbo", "Vrbo", null]);
    const avail = await k.caps.stays.availability(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-13",
      adults: 2,
    });
    expect(avail.options[0]).toMatchObject({ likely_taken: true });
    const { rows } = await k.db.client.query({ sql: "SELECT COUNT(*) FROM night_claims", params: [], method: "all" });
    expect(Number(rows[0]?.[0])).toBe(0);
    // Taken off the room, or switched off: silent again.
    await mapCalendar(k.db, "cal_vrbo", null, 1, clock.now);
    expect(await hintedNights(k.db, k.rooms.garden, nights, ZONE)).toEqual([]);
    await mapCalendar(k.db, "cal_vrbo", k.rooms.garden, 1, clock.now);
    await k.db.client.query({
      sql: "UPDATE connectors SET status = 'disabled' WHERE id = 'cal_vrbo'",
      params: [],
      method: "run",
    });
    expect(await hintedNights(k.db, k.rooms.garden, nights, ZONE)).toEqual([]);
  });
});
