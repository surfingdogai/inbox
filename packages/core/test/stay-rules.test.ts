import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import type { Capabilities } from "../src/capabilities/service";
import type { Db } from "../src/db";
import type { PayloadOf } from "../src/domain/types";
import { createRunner } from "../src/jobs/index";
import { mapCalendar } from "../src/property/hints";
import { quoteDraftTerms } from "../src/stays/terms";
import { transitionItem, WriteError } from "../src/write/index";
import {
  clock,
  contact,
  guest,
  kijaniHouse,
  mapleHollow,
  owner,
  ownerAi,
  payPlatform,
  ryokanHoshi,
} from "./stay-fixtures";

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

/**
 * A stay's draft, sent as it is (ADR-018 §4): its quote is worked out again as it goes, so it goes only
 * when that quote is the one its card showed, every term but until when it holds, which runs from when
 * it goes. The rates changed, a payment platform connected, or new nights priced otherwise since: it
 * does not go, and the draft waits for the owner to make their own offer or drop it.
 */
describe("a stay's draft, sent as it is", () => {
  async function stale(p: Promise<unknown>): Promise<void> {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WriteError);
    expect((error as WriteError).code).toBe("draft_stale");
    expect((error as WriteError).details).toMatchObject({ guard: "draft_terms" });
  }

  async function draftOf(db: Db, id: string): Promise<Record<string, unknown>> {
    const { rows } = await db.client.query({
      sql: "SELECT terms FROM offer_drafts WHERE item_id = ?",
      params: [id],
      method: "all",
    });
    return JSON.parse(String(rows[0]?.[0])) as Record<string, unknown>;
  }

  it("goes as its card showed it, a day from when it goes, however long it waited", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    await k.caps.setup.applyPreset(owner, { preset: "stays", replace: false });
    const id = await request(k.caps, k.rooms.garden);
    await drain(k.db);
    const { validThrough: shown, ...card } = await draftOf(k.db, id);
    expect(Date.parse(String(shown))).toBe(clock.now + 24 * 3_600_000);
    clock.now += 5 * 3_600_000;
    const sent = await k.caps.sendOfferDraft(owner, { item_id: id });
    expect(sent.view.item.state).toBe("quoted");
    const quote = (sent.view.item.payload as PayloadOf<"stay">).quote;
    if (!quote) throw new Error("no quote");
    const { validThrough, ...terms } = quoteDraftTerms(quote);
    expect(JSON.parse(JSON.stringify(terms))).toEqual(card);
    expect(Date.parse(String(validThrough))).toBe(clock.now + 24 * 3_600_000);
  });

  it("does not go once the rates changed it, and waits for the owner", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    await k.caps.setup.applyPreset(owner, { preset: "stays", replace: false });
    const id = await request(k.caps, k.rooms.garden);
    await drain(k.db);
    clock.now += 30 * 60_000;
    await k.caps.stays.setRates(owner, {
      rate_plan_id: k.plans.bnb,
      room_type_id: k.rooms.garden,
      nightly: 720_000,
      base_guests: 2,
    });
    clock.now += 90 * 60_000;
    await stale(k.caps.sendOfferDraft(owner, { item_id: id }));
    expect(await item(k.db, id)).toEqual({ state: "requested", needsHuman: true, draft: "quote" });
    // The rates back as they were: the same quote, and it goes.
    await k.caps.stays.setRates(owner, {
      rate_plan_id: k.plans.bnb,
      room_type_id: k.rooms.garden,
      nightly: 650_000,
      base_guests: 2,
    });
    expect((await k.caps.sendOfferDraft(owner, { item_id: id })).view.item.state).toBe("quoted");
  });

  it("does not go once a payment platform would ask for money now that the card said is paid there", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const r = await ryokanHoshi();
    await r.caps.setup.applyPreset(owner, { preset: "stays", replace: false });
    const id = await request(r.caps, r.rooms.japanese);
    await drain(r.db);
    const card = await draftOf(r.db, id);
    expect((card.schedule as { type: string }[]).map((s) => s.type)).toEqual(["at_property"]);
    await payPlatform(r.db, { cards: true });
    await stale(r.caps.sendOfferDraft(owner, { item_id: id }));
    expect((await item(r.db, id)).state).toBe("requested");
  });

  it("holds the owner's AI's quote and its change of nights to what their cards showed", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    const rate = (nightly: number) =>
      k.caps.stays.setRates(owner, {
        rate_plan_id: k.plans.bnb,
        room_type_id: k.rooms.garden,
        nightly,
        base_guests: 2,
      });
    const made = await k.caps.stays.request(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-14",
      rooms: [{ room_type_id: k.rooms.garden, adults: 2 }],
      contact,
      consent: true,
    });
    const id = made.view.item.id;
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (e as WriteError).code,
      );
    // The owner's AI quotes from the rates: kept for a person, who looks at the other channels first.
    const quote = { itemId: id, event: "quote", input: { from: "rates" } };
    expect(await refused(transitionItem(k.db, ownerAi, quote))).toBe("outside_limits");
    await rate(700_000);
    await stale(k.caps.sendOfferDraft(owner, { item_id: id }));
    await rate(650_000);
    expect((await k.caps.sendOfferDraft(owner, { item_id: id })).view.item.state).toBe("quoted");
    // The guest takes it; the owner's AI then offers other nights, kept for a person too.
    const token = made.accessToken as string;
    const ask = transitionItem(k.db, guest({ accessToken: token }), { itemId: id, event: "accept" });
    const terms = await ask.then(
      () => null,
      (e: unknown) => ((e as WriteError).details as { terms_sha?: string } | undefined)?.terms_sha,
    );
    await transitionItem(k.db, guest({ accessToken: token }), {
      itemId: id,
      event: "accept",
      input: { terms_sha: terms },
    });
    const change = { itemId: id, event: "propose_change", input: { checkIn: "2026-12-13", checkOut: "2026-12-15" } };
    expect(await refused(transitionItem(k.db, ownerAi, change))).toBe("outside_limits");
    expect(await item(k.db, id)).toMatchObject({ draft: "propose_change" });
    await rate(720_000);
    await stale(k.caps.sendOfferDraft(owner, { item_id: id }));
    await rate(650_000);
    const sent = await k.caps.sendOfferDraft(owner, { item_id: id });
    expect((sent.view.item.payload as PayloadOf<"stay">).change?.quote?.total).toEqual({
      value: 1_300_000,
      currency: "KES",
    });
  });
});
