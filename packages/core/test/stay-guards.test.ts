import { describe, expect, it } from "vitest";
import type { PayloadOf } from "../src/domain/types";
import { sweepStays } from "../src/stays/jobs";
import { renderStayMail } from "../src/stays/mail";
import { staySchedules } from "../src/stays/payments";
import { termsSummary } from "../src/stays/public";
import { readSetup } from "../src/stays/store";
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

/**
 * The stays layer's guards where money and nights meet (ADR-037 §4–§5): a platform's payment in another
 * currency, or naming no amount, is never counted; a part paid before a window closes is owed back; the
 * sweep finds what is due however many stays wait months ahead; automation sends no promise on nights a
 * person must check elsewhere; a plan kept from guests is never theirs to name; a change of nights comes
 * with its own price; a guest's person reads every payment they agree to; the private arrival details go
 * in their own email only. Every property is the fixtures' own, in its own zone and currency.
 */

type StayPayload = PayloadOf<"stay">;

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

/** Ryokan Hoshi with its Stripe: a request quoted from the rates and accepted, waiting for its deposit. */
async function waitingDeposit() {
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
  await transitionItem(r.db, owner, { itemId: id, event: "quote", input: { from: "rates" } });
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
  return { r, id };
}

const stripe = { kind: "connector" as const, id: "connector:pay1", channel: "connector" as const };

async function stayOf(r: { db: Awaited<ReturnType<typeof ryokanHoshi>>["db"] }, id: string) {
  const { rows } = await r.db.client.query({
    sql: "SELECT state, payload, flags FROM items WHERE id = ?",
    params: [id],
    method: "all",
  });
  return {
    state: String(rows[0]?.[0]),
    payload: JSON.parse(String(rows[0]?.[1])) as StayPayload,
    flags: JSON.parse(String(rows[0]?.[2] ?? "{}")) as { needsHuman?: boolean },
  };
}

describe("stays: money and nights", () => {
  it("never counts a payment in another currency as the deposit: it goes to a person", async () => {
    const { r, id } = await waitingDeposit();
    const out = await staySchedules.paid(r.db, {
      itemId: id,
      scheduleId: "deposit",
      purpose: "deposit",
      amount: { value: 25_800, currency: "USD" },
      paymentId: "pi_usd_1",
      connectorId: "pay1",
      now: clock.now,
    });
    expect(out.applied).toBe(false);
    const after = await stayOf(r, id);
    expect(after.state).toBe("awaiting_payment");
    expect(after.payload.payments?.schedules.find((s) => s.id === "deposit")?.status).toBe("due");
    expect(after.flags.needsHuman).toBe(true);
    // A platform's payment that names no amount is refused too; a person may record "paid in full".
    await expectCode(
      transitionItem(
        r.db,
        { ...system, actor: stripe },
        {
          itemId: id,
          event: "record_payment",
          input: { paymentRef: "pi_none" },
        },
      ),
      "invalid_input",
    );
    const byOwner = await transitionItem(r.db, owner, {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: "bank transfer 7781" },
    });
    expect(byOwner.view.item.state).toBe("confirmed");
  });

  it("owes back a part paid when the pay window closes on it", async () => {
    const { r, id } = await waitingDeposit();
    const part = await transitionItem(
      r.db,
      { ...system, actor: stripe },
      {
        itemId: id,
        event: "record_payment",
        input: { paymentRef: "pi_part", amount: { value: 10_000, currency: "JPY" } },
      },
    );
    expect(part.view.item.state).toBe("awaiting_payment");
    clock.now += 25 * 3_600_000;
    const lapsed = await transitionItem(r.db, system, { itemId: id, event: "expire" });
    expect(lapsed.view.item.state).toBe("expired");
    expect((lapsed.view.item.payload as StayPayload).cancellation?.refundOwed).toEqual({
      value: 10_000,
      currency: "JPY",
    });
    const { rows } = await r.db.client.query({
      sql: "SELECT json_extract(payload, '$.amount.value') FROM items WHERE type = 'refund' AND linked_item_id = ?",
      params: [id],
      method: "all",
    });
    expect(rows.map((x) => Number(x[0]))).toEqual([10_000]);
  });

  it("finds a lapsed hold behind six hundred stays confirmed months ahead", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    const first = await m.caps.stays.hold(guest(), {
      check_in: "2027-02-04",
      check_out: "2027-02-06",
      rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
      contact,
      consent: true,
    });
    await m.caps.stays.book(guest({ accessToken: first.accessToken as string }), {
      item_id: first.view.item.id,
      terms_sha: first.terms_sha,
    });
    // Six hundred more, confirmed and untouched for longer than anything else.
    const { rows: cols } = await m.db.client.query({ sql: "PRAGMA table_info(items)", params: [], method: "all" });
    const names = cols.map((c) => String(c[1]));
    const select = names.map((n) => (n === "id" ? "i.id || '-' || n.k" : n === "updated_at" ? "1" : `i.${n}`));
    await m.db.client.query({
      sql: `WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < 600)
            INSERT INTO items (${names.join(", ")}) SELECT ${select.join(", ")} FROM items i, n WHERE i.id = ?`,
      params: [first.view.item.id],
      method: "run",
    });
    const held = await m.caps.stays.hold(guest(), {
      check_in: "2026-12-04",
      check_out: "2026-12-06",
      rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
      contact: { ...contact, email: "lena@example.org" },
      consent: true,
    });
    expect(held.view.item.state).toBe("held");
    clock.now += 25 * 60_000;
    const swept = await sweepStays(m.db, clock.now);
    expect(swept.moved).toBe(1);
    expect((await stayOf(m, held.view.item.id)).state).toBe("expired");
  });

  it("keeps automation's quote for a person where the nights may be sold elsewhere, and sends it where they cannot", async () => {
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
    const refused = await expectCode(
      transitionItem(k.db, ownerAi, { itemId: id, event: "quote", input: { from: "rates" } }),
      "outside_limits",
    );
    expect(refused.details).toMatchObject({ guard: "instant_safe", draft_for_owner: true });
    const { rows } = await k.db.client.query({
      sql: "SELECT event, json_extract(input, '$.from') FROM offer_drafts WHERE item_id = ?",
      params: [id],
      method: "all",
    });
    expect(rows.map((x) => [x[0], x[1]])).toEqual([["quote", "rates"]]);
    const after = await stayOf(k, id);
    expect(after.state).toBe("requested");
    expect(after.flags.needsHuman).toBe(true);
    // A person sends it.
    expect(
      (await transitionItem(k.db, owner, { itemId: id, event: "quote", input: { from: "rates" } })).view.item.state,
    ).toBe("quoted");
    // Maple Hollow's room kept for direct guests: nothing can sell it twice, so the owner's AI may quote.
    const m = await mapleHollow();
    const maple = await m.caps.stays.request(guest(), {
      check_in: "2026-12-04",
      check_out: "2026-12-06",
      rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
      contact,
      consent: true,
    });
    const quoted = await transitionItem(m.db, ownerAi, {
      itemId: maple.view.item.id,
      event: "quote",
      input: { from: "rates" },
    });
    expect(quoted.view.item.state).toBe("quoted");
  });

  it("lets a person quote a price of their own where the rates do not cover the nights; never automation", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    // A cottage set up a moment ago, with no price yet.
    const { id: cottage } = await k.caps.stays.upsertRoomType(owner, {
      name: "Garden cottage",
      units: 1,
      capacity: { adults: 2, children: 0, total: 2 },
    });
    const made = await k.caps.stays.request(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-15",
      rooms: [{ room_type_id: cottage, adults: 2 }],
      contact: { ...contact, locale: "fr" },
      consent: true,
    });
    const id = made.view.item.id;
    const none = await k.caps.stays.draftQuote(owner, { item_id: id });
    expect(none.quote).toBeNull();
    const price = { value: 2_400_000, currency: "KES" };
    const drafted = await k.caps.stays.draftQuote(owner, { item_id: id, price });
    expect(drafted).toMatchObject({ lang: "fr", quote: { total: price, source: "person" } });
    await expectCode(transitionItem(k.db, ownerAi, { itemId: id, event: "quote", input: { price } }), "not_allowed");
    const quoted = await transitionItem(k.db, owner, { itemId: id, event: "quote", input: { price } });
    const q = (quoted.view.item.payload as StayPayload).quote;
    expect(q?.total).toEqual(price);
    expect(q?.lines[0]?.nights?.reduce((a, n) => a + n.amount, 0)).toBe(2_400_000);
  });

  it("never lets a guest name a rate plan the property keeps for its own use", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    const { id: friends } = await m.caps.stays.upsertRatePlan(owner, {
      name: "Friends and family",
      offered: false,
      policy: { preset: "free_until", days: 1, after: "first_night", no_show: "first_night" },
      deposit: { kind: "none" },
    });
    await m.caps.stays.setRates(owner, { rate_plan_id: friends, room_type_id: m.rooms.harbour, nightly: 9_000 });
    for (const door of ["hold", "quote", "request"] as const) {
      await expectCode(
        m.caps.stays[door](guest(), {
          check_in: "2026-12-04",
          check_out: "2026-12-06",
          rooms: [{ room_type_id: m.rooms.harbour, rate_plan_id: friends, adults: 2 }],
          contact,
          consent: true,
        }),
        "invalid_input",
      );
    }
  });

  it("asks a price for a change of nights the rates cannot price, and never keeps the old total for it", async () => {
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
    const id = held.view.item.id;
    await m.caps.stays.book(guest({ accessToken: token }), { item_id: id, terms_sha: held.terms_sha });
    // The plan now takes three nights at least: the rates cannot price two other nights.
    const setup = await readSetup(m.db, (await stayOf(m, id)).payload.propertyId);
    const plan = setup?.plans[0];
    if (!plan) throw new Error("no plan");
    await m.caps.stays.upsertRatePlan(owner, {
      id: plan.id,
      name: plan.name,
      min_nights: 3,
      policy: { preset: "free_until", days: 7, after: "first_night", no_show: "full" },
      deposit: { kind: "none" },
    });
    await m.caps.stays.change(guest({ accessToken: token }), {
      item_id: id,
      check_in: "2026-12-05",
      check_out: "2026-12-07",
    });
    expect((await stayOf(m, id)).payload.change?.quote).toBeUndefined();
    const refused = await expectCode(
      transitionItem(m.db, owner, { itemId: id, event: "accept_change" }),
      "guard_failed",
    );
    expect(refused.details).toMatchObject({ guard: "stay_change_priced" });
    // The property's own change of nights must say what it costs.
    await transitionItem(m.db, owner, { itemId: id, event: "decline_change" });
    await expectCode(
      transitionItem(m.db, owner, {
        itemId: id,
        event: "propose_change",
        input: { checkIn: "2026-12-05", checkOut: "2026-12-07" },
      }),
      "invalid_input",
    );
  });

  it("tells the guest's person of a balance paid later, by its date, before they agree", async () => {
    clock.now = Date.parse("2026-11-02T01:00:00Z");
    const r = await ryokanHoshi();
    await payPlatform(r.db);
    const setup = await readSetup(r.db, r.property);
    const plan = setup?.plans[0];
    if (!setup || !plan) throw new Error("no plan");
    await r.caps.stays.upsertRatePlan(owner, {
      id: plan.id,
      name: plan.name,
      policy: { preset: "free_until", days: 3, after: "first_night", no_show: "full" },
      deposit: { kind: "percent", value: 20 },
      balance: { when: "days_before", days: 14 },
    });
    const made = await r.caps.stays.request(guest(), {
      check_in: "2027-01-20",
      check_out: "2027-01-23",
      rooms: [{ room_type_id: r.rooms.japanese, adults: 2 }],
      contact,
      consent: true,
    });
    const quoted = await transitionItem(r.db, owner, {
      itemId: made.view.item.id,
      event: "quote",
      input: { from: "rates" },
    });
    const p = quoted.view.item.payload as StayPayload;
    const q = p.quote;
    if (!q) throw new Error("no quote");
    const fresh = await readSetup(r.db, r.property);
    if (!fresh) throw new Error("no setup");
    const { summary } = await termsSummary(fresh, p, q, "en");
    expect(summary).toMatch(/Pay now: .+\. Then .+ by 6 Jan|Then .+ by Jan 6/);
  });

  it("sends no stay email that would say only its policy", async () => {
    const { r, id } = await waitingDeposit();
    const [row] = (
      await r.db.client.query({
        sql: "SELECT id, type, state, version, party_id, payload, flags, created_at, updated_at FROM items WHERE id = ?",
        params: [id],
        method: "all",
      })
    ).rows;
    if (!row) throw new Error("no stay");
    const item = {
      id,
      type: "stay",
      state: "awaiting_payment",
      version: Number(row[3]),
      partyId: String(row[4]),
      payload: JSON.parse(String(row[5])),
      flags: {},
    } as never;
    // No link to pay with, no card: nothing worth an email.
    const mail = await renderStayMail(r.db, {
      item,
      event: "record_part_payment",
      lang: "fr",
      words: null,
      automated: true,
      replies: true,
      links: null,
      pay: [],
      fromState: "awaiting_payment",
      now: clock.now,
    });
    expect(mail).toBeNull();
  });

  it("writes the private arrival details only into their own email, whatever a reply asks for", async () => {
    const { r, id } = await waitingDeposit();
    const [row] = (
      await r.db.client.query({
        sql: "SELECT version, party_id, payload FROM items WHERE id = ?",
        params: [id],
        method: "all",
      })
    ).rows;
    const base = {
      id,
      type: "stay",
      version: Number(row?.[0]),
      partyId: String(row?.[1]),
      payload: JSON.parse(String(row?.[2])),
      flags: {},
    };
    // A reply asking for the codes by their placeholder: the placeholder is taken out.
    const reply = await renderStayMail(r.db, {
      item: { ...base, state: "awaiting_payment" } as never,
      event: "message",
      lang: "en",
      words: "To confirm: {{arrival-details}} {{arrival-details:AAAAAAAAAAAAAAAA}}",
      automated: true,
      replies: true,
      links: null,
      pay: [],
      fromState: null,
      now: clock.now,
    });
    expect(reply?.text).not.toMatch(/arrival-details/);
    // The arrival email carries a marker of its own, and only for a confirmed stay.
    const arrival = await renderStayMail(r.db, {
      item: { ...base, state: "confirmed" } as never,
      event: "stay_arrival",
      lang: "en",
      words: null,
      automated: true,
      replies: true,
      links: null,
      pay: [],
      fromState: null,
      now: clock.now,
    });
    expect(arrival?.template).toBe("stay.arrival_details");
    expect(arrival?.text).toMatch(/\{\{arrival-details:[A-Za-z0-9_-]{16}\}\}/);
    const cancelled = await renderStayMail(r.db, {
      item: { ...base, state: "cancelled_by_guest" } as never,
      event: "stay_arrival",
      lang: "en",
      words: null,
      automated: true,
      replies: true,
      links: null,
      pay: [],
      fromState: null,
      now: clock.now,
    });
    expect(cancelled).toBeNull();
  });
});
