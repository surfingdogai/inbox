import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import type { Capabilities } from "../src/capabilities/service";
import type { Db } from "../src/db";
import { createRunner } from "../src/jobs/index";
import { mapCalendar } from "../src/property/hints";
import { clock, contact, guest, kijaniHouse, mapleHollow, owner } from "./stay-fixtures";

/**
 * The stays rules (ADR-037 §7): a quote from the rates is drafted for a person and never sent by a
 * rule (R1); one goes at once only where the rooms cannot be sold twice (R2); a request is declined
 * only when the property is full by its own word (R3), never on another calendar's hint, which asks a
 * person instead (R4).
 */
async function drain(db: Db) {
  const runner = createRunner({ mailOut: logMailOut() });
  for (let i = 0; i < 30; i++) if ((await runner.runDue(db, { now: clock.now, limit: 100 })).claimed === 0) return;
}

async function item(db: Db, id: string): Promise<{ state: string; needsHuman: boolean; draft: string | null }> {
  const { rows } = await db.client.query({
    sql: "SELECT i.state, json_extract(i.flags, '$.needsHuman'), d.event FROM items i LEFT JOIN offer_drafts d ON d.item_id = i.id WHERE i.id = ?",
    params: [id],
    method: "all",
  });
  const r = rows[0];
  return {
    state: String(r?.[0]),
    needsHuman: Number(r?.[1]) === 1,
    draft: r?.[2] === null || r?.[2] === undefined ? null : String(r[2]),
  };
}

async function request(caps: Capabilities, room: string | undefined, checkIn = "2026-12-12", checkOut = "2026-12-14") {
  const made = await caps.stays.request(guest(), {
    check_in: checkIn,
    check_out: checkOut,
    rooms: [{ ...(room ? { room_type_id: room } : {}), adults: 2 }],
    contact,
    consent: true,
  });
  return made.view.item.id;
}

describe("the stays rules", () => {
  it("R1 drafts a quote from the rates for a person, and sends nothing", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    await k.caps.setup.applyPreset(owner, { preset: "stays", replace: false });
    const id = await request(k.caps, k.rooms.garden);
    await drain(k.db);
    expect(await item(k.db, id)).toEqual({ state: "requested", needsHuman: true, draft: "quote" });
    // The owner sends the draft in one tap: the quote is the rates' own.
    const sent = await k.caps.sendOfferDraft(owner, { item_id: id });
    expect(sent.view.item.state).toBe("quoted");
  });

  it("R2 sends the quote at once where the room is kept for direct guests, and not beyond it", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    await m.caps.setup.applyPreset(owner, { preset: "stays", replace: false });
    const kept = await request(m.caps, m.rooms.harbour, "2026-12-04", "2026-12-06");
    await drain(m.db);
    expect((await item(m.db, kept)).state).toBe("quoted");
    // Outside the dates the room is kept for: drafted for a person instead.
    const beyond = await request(m.caps, m.rooms.harbour, "2027-05-04", "2027-05-06");
    await drain(m.db);
    expect(await item(m.db, beyond)).toMatchObject({ state: "requested", draft: "quote" });
  });

  it("R3 says sorry only when the property is full by its own word; R4 asks a person on a calendar's hint", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    await k.caps.setup.applyPreset(owner, { preset: "stays", replace: false });
    await k.caps.stays.closeNights(owner, {
      room_type_id: k.rooms.garden,
      from_date: "2026-12-20",
      to_date: "2026-12-21",
    });
    const closed = await request(k.caps, k.rooms.garden, "2026-12-20", "2026-12-22");
    await drain(k.db);
    expect((await item(k.db, closed)).state).toBe("declined");
    // Another calendar shows 12–13 Dec taken: never declined, a person looks.
    const conn = "cal_airbnb";
    await k.db.client.batch([
      {
        sql: `INSERT INTO connectors (id, kind, name, config_enc, config_public, status, busy_gen, created_at, updated_at)
              VALUES (?, 'ics', 'Airbnb', NULL, '{"account":"Airbnb"}', 'active', 1, ?, ?)`,
        params: [conn, clock.now, clock.now],
        method: "run",
      },
      {
        sql: "INSERT INTO connector_busy (connector_id, gen, start_ms, end_ms) VALUES (?, 1, ?, ?)",
        params: [conn, Date.parse("2026-12-11T21:00:00Z"), Date.parse("2026-12-13T21:00:00Z")],
        method: "run",
      },
    ]);
    await mapCalendar(k.db, conn, k.rooms.garden, 1, clock.now);
    const hinted = await request(k.caps, k.rooms.garden, "2026-12-12", "2026-12-14");
    await drain(k.db);
    const h = await item(k.db, hinted);
    expect(h.state).toBe("requested");
    expect(h.needsHuman).toBe(true);
    const { rows } = await k.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'note'",
      params: [hinted],
      method: "all",
    });
    expect(rows.map((r) => String(r[0]))).toContain("Another calendar shows some of these nights as taken.");
    // The hint never holds the nights: the owner can still quote and the guest confirm.
    const avail = await k.caps.stays.availability(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-14",
      adults: 2,
    });
    expect(avail.options[0]).toMatchObject({ status: "on_request", likely_taken: true });
  });

  it("R5 is off until the owner switches it on", async () => {
    const k = await kijaniHouse();
    const rules = await k.caps.setup.applyPreset(owner, { preset: "stays", replace: false });
    expect(rules.find((r) => r.name === "Accept date changes while cancellation is free")?.enabled).toBe(false);
    // An inbox whose owner confirms each stay (hosted plans start so) never quotes on its own.
    const owned = await k.caps.setup.applyPreset(owner, { preset: "stays", confirm: "owner", replace: true });
    expect(owned.map((r) => r.name)).not.toContain("Send the quote at once when the rooms are kept for direct guests");
  });
});
