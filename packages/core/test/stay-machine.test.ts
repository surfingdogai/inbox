import { describe, expect, it } from "vitest";
import type { PayloadOf } from "../src/domain/types";
import { stayMachine } from "../src/machine/stay";
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
  system,
} from "./stay-fixtures";

type StayPayload = PayloadOf<"stay">;

const DAY = 86_400_000;

async function expectCode(p: Promise<unknown>, code: string): Promise<WriteError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(WriteError);
    expect((error as WriteError).code, (error as Error).message).toBe(code);
    return error as WriteError;
  }
  throw new Error(`expected ${code}`);
}

describe("the stay machine (ADR-037)", () => {
  it("is data: fourteen states, six terminal, every event from somewhere", () => {
    expect(stayMachine.states).toHaveLength(14);
    expect(stayMachine.terminal).toEqual([
      "completed",
      "no_show",
      "cancelled_by_guest",
      "cancelled_by_property",
      "declined",
      "expired",
    ]);
    // Out of a terminal state: only a late payment (reopens) and the corrections (amends).
    for (const t of stayMachine.transitions) {
      const fromTerminal = t.from.some((s) => stayMachine.terminal.includes(s));
      if (fromTerminal) expect(t.reopens === true || t.amends === true, t.event).toBe(true);
    }
    // `booking` never lapses on a clock: only the system's answer (or its absence, found) moves it.
    const outOfBooking = stayMachine.transitions.filter((t) => t.from.includes("booking")).map((t) => t.event);
    expect(outOfBooking.sort()).toEqual(["write_refused", "written", "written_pay"]);
  });

  it("Kijani House: request, quote from the rates, accept on the terms seen, confirmed; nothing due now", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    const made = await k.caps.stays.request(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-15",
      rooms: [{ room_type_id: k.rooms.garden, adults: 2 }],
      contact,
      consent: true,
    });
    const id = made.view.item.id;
    expect(made.view.item.state).toBe("requested");
    const p0 = made.view.item.payload as StayPayload;
    expect(p0.startTime).toBe("2026-12-12T14:00:00+03:00");
    expect(p0.endTime).toBe("2026-12-15T11:00:00+03:00");
    expect(p0.estimate?.total).toEqual({ value: 1_950_000, currency: "KES" });

    const quoted = await transitionItem(k.db, owner, { itemId: id, event: "quote", input: { from: "rates" } });
    expect(quoted.view.item.state).toBe("quoted");
    const q = (quoted.view.item.payload as StayPayload).quote;
    expect(q?.total).toEqual({ value: 1_950_000, currency: "KES" });
    expect(q?.schedule.map((s) => s.type)).toEqual(["at_property"]);

    const token = made.accessToken as string;
    // Without the fingerprint of the terms: the terms, nothing booked.
    const ask = await expectCode(
      transitionItem(k.db, guest({ accessToken: token }), { itemId: id, event: "accept" }),
      "confirm_terms",
    );
    const sha = (ask.details as { terms_sha: string }).terms_sha;
    expect(sha).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const done = await transitionItem(k.db, guest({ accessToken: token }), {
      itemId: id,
      event: "accept",
      input: { terms_sha: sha },
    });
    expect(done.view.item.state).toBe("confirmed");
    const p = done.view.item.payload as StayPayload;
    expect(p.payments?.schedules[0]?.status).toBe("at_property");
    const { rows } = await k.db.client.query({
      sql: "SELECT night, hold_until FROM night_claims WHERE item_id = ? ORDER BY night",
      params: [id],
      method: "all",
    });
    expect(rows.map((r) => [r[0], r[1]])).toEqual([
      ["2026-12-12", null],
      ["2026-12-13", null],
      ["2026-12-14", null],
    ]);
    // Completed by the sweep after check-out.
    clock.now = Date.parse("2026-12-16T12:00:00Z");
    const completed = await transitionItem(k.db, system, { itemId: id, event: "complete" });
    expect(completed.view.item.state).toBe("completed");
  });

  it("Ryokan Hoshi with no payment platform: nothing is asked now, everything at the property, the owner told", async () => {
    clock.now = Date.parse("2026-11-02T01:00:00Z");
    const r = await ryokanHoshi();
    const made = await r.caps.stays.request(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-15",
      rooms: [{ room_type_id: r.rooms.japanese, adults: 2 }],
      contact,
      consent: true,
    });
    const id = made.view.item.id;
    const quoted = await transitionItem(r.db, owner, { itemId: id, event: "quote", input: { from: "rates" } });
    const q = (quoted.view.item.payload as StayPayload).quote;
    expect(q?.schedule.map((s) => [s.type, s.amount.value])).toEqual([["at_property", 77_400 + 7_740 + 2_400]]);
    const { rows: notes } = await r.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'note'",
      params: [id],
      method: "all",
    });
    expect(notes.map((n) => String(n[0]))).toContain(
      "No payment account is connected, so nothing was asked now: the guest pays everything at the property. To take a deposit, connect Stripe or Mollie in Payments.",
    );
    const token = made.accessToken as string;
    const ask = await expectCode(
      transitionItem(r.db, guest({ accessToken: token }), { itemId: id, event: "accept" }),
      "confirm_terms",
    );
    const done = await transitionItem(r.db, guest({ accessToken: token }), {
      itemId: id,
      event: "accept",
      input: { terms_sha: (ask.details as { terms_sha: string }).terms_sha },
    });
    // Never waiting on a payment nobody can make.
    expect(done.view.item.state).toBe("confirmed");
  });

  it("Ryokan Hoshi: the deposit is due now, so the stay waits for it; the pay window lapses it", async () => {
    clock.now = Date.parse("2026-11-02T01:00:00Z");
    const r = await ryokanHoshi();
    await payPlatform(r.db);
    const made = await r.caps.stays.request(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-15",
      rooms: [{ room_type_id: r.rooms.japanese, adults: 2 }],
      contact,
      consent: true,
    });
    const id = made.view.item.id;
    const quoted = await transitionItem(r.db, owner, { itemId: id, event: "quote", input: { from: "rates" } });
    const q = (quoted.view.item.payload as StayPayload).quote;
    // 3 × 25,800 + 10% service + ¥400 × 2 guests × 3 nights at the property.
    expect(q?.total.value).toBe(77_400 + 7_740 + 2_400);
    expect(q?.schedule.find((s) => s.id === "deposit")?.amount.value).toBe(25_800);
    const token = made.accessToken as string;
    const ask = await expectCode(
      transitionItem(r.db, guest({ accessToken: token }), { itemId: id, event: "accept" }),
      "confirm_terms",
    );
    const waiting = await transitionItem(r.db, guest({ accessToken: token }), {
      itemId: id,
      event: "accept",
      input: { terms_sha: (ask.details as { terms_sha: string }).terms_sha },
    });
    expect(waiting.view.item.state).toBe("awaiting_payment");
    const p = waiting.view.item.payload as StayPayload;
    expect(p.payments?.dueBy).toBe(new Date(clock.now + 24 * 3_600_000).toISOString());
    // Not paid in time: lapsed, the nights let go.
    clock.now += 25 * 3_600_000;
    const lapsed = await transitionItem(r.db, system, { itemId: id, event: "expire" });
    expect(lapsed.view.item.state).toBe("expired");
    const { rows } = await r.db.client.query({
      sql: "SELECT COUNT(*) FROM night_claims WHERE item_id = ?",
      params: [id],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(0);
  });

  it("instant only where a room cannot be sold twice: never in request mode; an allotment holds and books", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const k = await kijaniHouse();
    await expectCode(
      k.caps.stays.hold(guest(), {
        check_in: "2026-12-12",
        check_out: "2026-12-14",
        rooms: [{ room_type_id: k.rooms.garden, adults: 2 }],
        contact,
        consent: true,
      }),
      "guard_failed",
    );
    const m = await mapleHollow();
    const held = await m.caps.stays.hold(guest(), {
      check_in: "2026-12-04",
      check_out: "2026-12-06",
      rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
      contact,
      consent: true,
    });
    expect(held.view.item.state).toBe("held");
    expect(held.terms_sha).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The one room kept is held: a second guest is on request for those nights.
    const second = await m.caps.stays.availability(guest(), {
      check_in: "2026-12-04",
      check_out: "2026-12-06",
      adults: 2,
    });
    expect(second.options.every((o) => o.status !== "instant")).toBe(true);
    const booked = await m.caps.stays.book(guest({ accessToken: held.accessToken as string }), {
      item_id: held.view.item.id,
      terms_sha: held.terms_sha,
    });
    expect(booked.view.item.state).toBe("confirmed");
  });

  it("the owner's AI may not keep rooms for direct guests, nor change a policy or a deposit", async () => {
    const m = await mapleHollow();
    await expectCode(
      m.caps.stays.setAllotment(ownerAi, {
        room_type_id: m.rooms.harbour,
        from_date: "2026-12-01",
        to_date: "2026-12-31",
        units: 1,
        closed_elsewhere: true,
      }),
      "not_allowed",
    );
    await expectCode(
      m.caps.stays.upsertRatePlan(ownerAi, {
        id: m.plans.flexible,
        name: "Flexible",
        policy: { preset: "non_refundable" },
      }),
      "not_allowed",
    );
    await expectCode(m.caps.stays.upsertProperty(ownerAi, { id: m.property, mode: "request" }), "not_allowed");
  });

  it("a confirmed stay's cancellation shows its fee first; inside the free window it is free and what was paid is owed back", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    const held = await m.caps.stays.hold(guest(), {
      check_in: "2026-12-04",
      check_out: "2026-12-06",
      rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
      contact,
      consent: true,
    });
    const token = held.accessToken as string;
    await m.caps.stays.book(guest({ accessToken: token }), { item_id: held.view.item.id, terms_sha: held.terms_sha });
    const ask = await expectCode(
      transitionItem(m.db, guest({ accessToken: token }), { itemId: held.view.item.id, event: "cancel" }),
      "confirm_terms",
    );
    const d = ask.details as { fee: { value: number }; fee_sha: string };
    expect(d.fee.value).toBe(0);
    const done = await transitionItem(m.db, guest({ accessToken: token }), {
      itemId: held.view.item.id,
      event: "cancel",
      input: { fee_sha: d.fee_sha },
    });
    expect(done.view.item.state).toBe("cancelled_by_guest");
    // Past the free window (7 days before), the first night is the fee.
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const again = await m.caps.stays.hold(guest(), {
      check_in: "2026-11-06",
      check_out: "2026-11-08",
      rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
      contact,
      consent: true,
    });
    await m.caps.stays.book(guest({ accessToken: again.accessToken as string }), {
      item_id: again.view.item.id,
      terms_sha: again.terms_sha,
    });
    const late = await expectCode(
      transitionItem(m.db, guest({ accessToken: again.accessToken as string }), {
        itemId: again.view.item.id,
        event: "cancel",
      }),
      "confirm_terms",
    );
    expect((late.details as { fee: { value: number } }).fee.value).toBe(18_900);
    void DAY;
  });
});
