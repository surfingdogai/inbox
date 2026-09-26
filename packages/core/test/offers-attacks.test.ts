import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import type { Item } from "../src/domain/types";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ensureLifecycleSweep, LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "../src/jobs/lifecycle";
import { offerRows } from "../src/negotiation/offers";
import { positiveOnlyProblem } from "../src/rules/reputation";
import type { RuleDefinition } from "../src/rules/schema";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, outboundMail, products, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Offers under attack (ADR-018 §1, §2, §4, Q2, Q5): what a haggling assistant, a careless owner, a
 * rule and the owner's AI try once offers have deadlines, rounds and answers. Each case failed
 * before its fix. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z"); // a Monday
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const clock = { now: T0 };
const at = (kind: Caller["actor"]["kind"], channel: Caller["actor"]["channel"]): Caller => ({
  actor: { kind, id: `${kind}_1`, channel },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
});
const owner = at("owner", "owner_ui");
const ai = at("owner_ai", "mcp_owner");
const rule = at("rule", "system");
const anon = (accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
});
const EUR = (value: number) => ({ value, currency: "EUR" });
const iso = (ms: number) => new Date(ms).toISOString();
const contact = { email: "rita@example.com", locale: "en" };

async function setup() {
  clock.now = T0;
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm.insert(business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en", "pt"],
    createdAt: T0,
    updatedAt: T0,
  });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  // Priced "from": the catalogue does not set the price, a person does.
  const from = ulid();
  await db.orm.insert(services).values({
    id: from,
    name: "Wheel truing",
    durationMin: 60,
    capacity: 1,
    granularityMin: 30,
    price: { model: "from", value: 2000, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const prod = ulid();
  await db.orm.insert(products).values({
    id: prod,
    sku: "CH-9",
    name: "Chain",
    price: EUR(1850),
    active: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = confirming(
    new Capabilities(db, createSecretBox(["offers-attack-secret-0123456789abcdef"]), "https://inbox.example"),
  );
  const runner = createRunner({
    mailOut: logMailOut(),
    receipts: caps.receipts,
    baseUrl: "https://inbox.example",
    secrets: caps.secrets,
  }).register(LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler());
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now: clock.now, limit: 100 })).claimed === 0) return;
  };
  /** The sweep that runs at `t`, and everything it causes. */
  const sweep = async (t: number) => {
    clock.now = t;
    await ensureLifecycleSweep(db, t);
    await drain();
  };
  return { db, caps, svc, from, prod, drain, sweep };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function fail(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

const itemOf = async (db: Db, id: string): Promise<Item> => {
  const [row] = await db.orm.select().from(items).where(eq(items.id, id));
  if (!row) throw new Error("no item");
  return rowToItem(row);
};
const mailOf = async (db: Db, id: string) =>
  (await db.orm.select().from(outboundMail).where(eq(outboundMail.itemId, id))).filter(
    (m) => m.recipient === "customer",
  );

/** A booking request for Saturday 13:00 Lisbon: its own clock runs out first, 72 hours on. */
async function booking(s: Setup, serviceId = s.svc, extra: Record<string, unknown> = {}) {
  const start = T0 + 5 * DAY + 2 * HOUR;
  const r = await s.caps.createBooking(anon(), {
    payload: {
      reservationFor: { serviceId, name: "Anything" },
      startTime: iso(start),
      endTime: iso(start + 60 * MIN),
      ...extra,
    },
    contact,
  });
  return { id: r.view.item.id, token: r.accessToken as string, start };
}

/** Wednesday 14:00 Lisbon, which the default hours offer. */
const WED_14 = Date.parse("2026-09-23T13:00:00Z");

describe("a request that lapsed, taken by automation", () => {
  it("never becomes our offer at a price the business did not set (Q5)", async () => {
    const s = await setup();
    // The customer's assistant names its own price for a service the catalogue prices "from".
    const b = await booking(s, s.from, { totalPrice: EUR(100) });
    const fresh = await fail(transitionItem(s.db, rule, { itemId: b.id, event: "confirm" }));
    expect(fresh.details).toMatchObject({ guard: "business_priced" });
    // The request's clock runs out before anybody answered; a rule says yes to it now.
    clock.now = T0 + 72 * HOUR + MIN;
    const late = await fail(transitionItem(s.db, rule, { itemId: b.id, event: "confirm" }));
    expect(late.details).toMatchObject({ guard: "business_priced" });
    const byAi = await fail(transitionItem(s.db, ai, { itemId: b.id, event: "confirm" }));
    expect(byAi.details).toMatchObject({ guard: "business_priced", draft_for_owner: true });
    const item = await itemOf(s.db, b.id);
    expect(item.state).toBe("requested");
    expect(item.payload).not.toHaveProperty("proposed");
    // A person still takes it, late, as our offer (their price is theirs to set).
    const r = await transitionItem(s.db, owner, { itemId: b.id, event: "confirm" });
    expect(r.converted).toBe("request_lapsed");
  });
});

describe("a customer's answer to a price a person set", () => {
  async function ordered(s: Setup) {
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 1, price: EUR(1850) }], totalPrice: EUR(1850) },
      contact,
    });
    return { id: r.view.item.id, token: r.accessToken as string };
  }

  it("is the owner's to accept, never the AI's or a rule's (Q2)", async () => {
    const s = await setup();
    const o = await ordered(s);
    // A person lets the last, scratched chain go for €5.
    await transitionItem(s.db, owner, {
      itemId: o.id,
      event: "propose",
      input: {
        orderedItem: [{ productId: s.prod, name: "Chain", quantity: 1, price: EUR(500) }],
        note: "The last one, scratched.",
      },
    });
    // The customer's assistant answers with forty of them, at that price.
    const c = await s.caps.customer.makeOffer(anon(o.token), {
      item_id: o.id,
      terms: { lines: [{ index: 0, quantity: 40 }] },
    });
    expect(c.view.item.state).toBe("received");
    expect(c.view.item.payload).toMatchObject({ totalPrice: EUR(20000) });
    // Under the owner's floor for this customer (the list price, no discount allowed): a person's to take.
    for (const who of [ai, rule]) {
      const e = await fail(transitionItem(s.db, who, { itemId: o.id, event: "accept" }));
      expect(e.code).toBe("outside_limits");
      expect(e.details).toEqual({ breaches: ["below_floor"], draft_for_owner: true });
    }
    expect((await itemOf(s.db, o.id)).state).toBe("received");
    // The owner in person may.
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    expect((await itemOf(s.db, o.id)).state).toBe("accepted");
  });

  it("at the catalogue's prices, automation still takes", async () => {
    const s = await setup();
    const o = await ordered(s);
    await transitionItem(s.db, ai, {
      itemId: o.id,
      event: "propose",
      input: { orderedItem: [{ productId: s.prod, name: "Chain", quantity: 2, price: EUR(1850) }] },
    });
    await s.caps.customer.makeOffer(anon(o.token), { item_id: o.id, terms: { lines: [{ index: 0, quantity: 3 }] } });
    await transitionItem(s.db, ai, { itemId: o.id, event: "accept" });
    expect((await itemOf(s.db, o.id)).payload).toMatchObject({ totalPrice: EUR(5550) });
  });
});

describe("what we proposed, binding", () => {
  it("is not withdrawn by the owner's AI or a rule before its date, by any verb", async () => {
    const s = await setup();
    const b = await booking(s);
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN) },
    });
    for (const [who, event] of [
      [ai, "request_info"],
      [ai, "decline"],
      [rule, "decline"],
      [rule, "expire"],
    ] as const) {
      const e = await fail(transitionItem(s.db, who, { itemId: b.id, event, input: { note: "No." } }));
      expect(e.code).toBe("guard_failed");
      expect((e.details as { guard?: string }).guard).toMatch(/^offer_(binding|lapsed)$/);
    }
    expect((await itemOf(s.db, b.id)).state).toBe("proposed");
    // A person may still ask a question instead (ADR-018 Amendment 1).
    await transitionItem(s.db, owner, { itemId: b.id, event: "request_info", input: { note: "Which bike?" } });
    expect((await itemOf(s.db, b.id)).state).toBe("needs_info");
  });

  it("changes to an order: not declined or cancelled by automation while they bind us", async () => {
    const s = await setup();
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 3, price: EUR(1850) }], totalPrice: EUR(5550) },
      contact,
    });
    const id = r.view.item.id;
    await transitionItem(s.db, ai, {
      itemId: id,
      event: "propose",
      input: { orderedItem: [{ productId: s.prod, name: "Chain", quantity: 2, price: EUR(1850) }] },
    });
    for (const event of ["decline", "cancel", "request_info"]) {
      const e = await fail(transitionItem(s.db, ai, { itemId: id, event, input: { note: "No." } }));
      expect(e.code).toBe("guard_failed");
      expect(e.details).toMatchObject({ guard: "offer_binding", draft_for_owner: true });
    }
    // Recording the customer's own no is theirs, whoever types it.
    await transitionItem(s.db, ai, {
      itemId: id,
      event: "record_cancel",
      input: { note: "She rang: she no longer needs it." },
    });
    expect((await itemOf(s.db, id)).state).toBe("cancelled");
    expect((await offerRows(s.db, id)).at(-1)?.status).toBe("declined");
  });

  it("let go by a rule once lapsed: expired, and the customer is told until when it held", async () => {
    const s = await setup();
    const b = await booking(s);
    await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN) },
    });
    await s.drain(); // the customer hears of the time as it is proposed
    clock.now = T0 + 48 * HOUR + 1;
    await transitionItem(s.db, rule, { itemId: b.id, event: "expire" });
    expect((await offerRows(s.db, b.id)).at(-1)?.status).toBe("expired");
    await s.drain();
    const mail = (await mailOf(s.db, b.id)).find((m) => m.template === "booking.expired");
    expect(mail?.bodyText).toMatch(/could be accepted until Wednesday, 23 September 2026/);
  });

  it("a quote: a rule does not close it before its date, nor tell the customer it expired on a day to come", async () => {
    const s = await setup();
    const q = await s.caps.requestQuote(anon(), {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
      contact,
    });
    const id = q.view.item.id;
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "quote",
      input: { totalPrice: EUR(31000), validThrough: iso(T0 + 5 * DAY), lines: [] },
    });
    clock.now = T0 + HOUR;
    const e = await fail(transitionItem(s.db, rule, { itemId: id, event: "expire" }));
    expect(e.code).toBe("guard_failed");
    expect((await itemOf(s.db, id)).state).toBe("quoted");
  });
});

describe("a suggestion passed on to a person", () => {
  it("never says what we proposed still stands once it has lapsed", async () => {
    const s = await setup();
    const b = await booking(s);
    await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN) },
    });
    const live = await s.caps.customer.makeOffer(anon(b.token), { item_id: b.id, terms: { total_price: EUR(3000) } });
    expect("passed_on" in live && live.passed_on).toMatch(/What we proposed still stands until/);
    clock.now = T0 + 48 * HOUR + 1; // lapsed; the sweep has not come by
    const late = await s.caps.customer.makeOffer(anon(b.token), { item_id: b.id, terms: { total_price: EUR(2900) } });
    expect("passed_on" in late && late.passed_on).toMatch(/^We have passed this on to a person on our team/);
    expect("passed_on" in late && late.passed_on).not.toMatch(/still stands/);
  });
});

describe("what the customer's side reads", () => {
  it("never carries the round of the negotiation", async () => {
    const s = await setup();
    const b = await booking(s);
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN) },
    });
    const status = await s.caps.getItemStatus(anon(b.token), { item_id: b.id });
    const pointer = (status.item.payload as { offer?: Record<string, unknown> }).offer;
    expect(pointer).toMatchObject({ by: "business", status: "open" });
    expect(pointer).not.toHaveProperty("round");
  });
});

describe("what a rule sends, as the customer reads it", () => {
  it("a quote says the date it really holds until: never later than automation may keep it open", async () => {
    const s = await setup();
    const q = await s.caps.requestQuote(anon(), {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
      contact,
    });
    const id = q.view.item.id;
    // The owner lets automation price what the catalogue does not (ADR-018 §4, off out of the box)…
    await s.caps.updateSettings(owner, { doc: { negotiation: { ai: { mayPriceCustom: true } } } });
    // …and their rule quotes a fixed price, "valid until the end of the year".
    await transitionItem(s.db, rule, {
      itemId: id,
      event: "quote",
      input: { totalPrice: EUR(31000), validThrough: iso(T0 + 100 * DAY), lines: [] },
    });
    const [offer] = (await offerRows(s.db, id)).filter((o) => o.by === "business");
    const quote = (await itemOf(s.db, id)).payload as { quote?: { validThrough: string } };
    // What the customer is shown, and what the email and the links say, is what holds.
    expect(offer?.validThrough).toBe(T0 + 48 * HOUR);
    expect(quote.quote?.validThrough).toBe(iso(T0 + 48 * HOUR));
    const status = await s.caps.getItemStatus(anon(q.accessToken as string), { item_id: id });
    expect((status as { offer?: { deadline: string } }).offer?.deadline).toBe(iso(T0 + 48 * HOUR));
  });
});

describe("a rule answering a request priced by the customer (Q5)", () => {
  it("does not offer a time at the price the customer's assistant wrote", async () => {
    const s = await setup();
    // A service the catalogue prices "from": the customer's figure is theirs, for a person to price.
    const b = await booking(s, s.from, { totalPrice: EUR(100) });
    const keep = { startTime: iso(WED_14), endTime: iso(WED_14 + 60 * MIN) };
    const kept = await transitionItem(s.db, rule, { itemId: b.id, event: "propose", input: keep });
    expect(kept.drafted?.breaches).toEqual(["custom_line"]);
    expect((await itemOf(s.db, b.id)).state).toBe("requested");
    // A price the rule names for what the catalogue does not price is the owner's to allow (off out of
    // the box, a draft); allowed, it goes. Keeping the customer's own figure never does.
    const named = { ...keep, totalPrice: EUR(2500) };
    const held = await transitionItem(s.db, rule, { itemId: b.id, event: "propose", input: named });
    expect(held.drafted?.breaches).toEqual(["custom_line"]);
    await s.caps.updateSettings(owner, { doc: { negotiation: { ai: { mayPriceCustom: true } } } });
    const still = await transitionItem(s.db, rule, { itemId: b.id, event: "propose", input: keep });
    expect(still.drafted?.breaches).toEqual(["custom_line"]);
    await transitionItem(s.db, rule, { itemId: b.id, event: "propose", input: named });
    expect((await itemOf(s.db, b.id)).state).toBe("proposed");
  });
});

describe("an answer named for one offer, racing our next one", () => {
  /** Between the door's check of the offer the customer named and its write, we propose again. */
  async function racing(s: Setup, id: string, next: number) {
    const doors = s.caps.customer as unknown as { assertOfferPinned: (...a: unknown[]) => Promise<void> };
    const original = doors.assertOfferPinned;
    const spy = vi.spyOn(doors, "assertOfferPinned").mockImplementation(async function (this: unknown, ...a) {
      await original.apply(this, a);
      await transitionItem(s.db, owner, {
        itemId: id,
        event: "propose",
        input: { startTime: iso(next), endTime: iso(next + 90 * MIN) },
      });
    });
    return () => spy.mockRestore();
  }
  const THU_10 = Date.parse("2026-09-24T09:00:00Z");

  it("a no to the time they saw never closes the time we proposed next", async () => {
    const s = await setup();
    const b = await booking(s);
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN) },
    });
    const seen = (await offerRows(s.db, b.id)).at(-1)?.id as string;
    const done = await racing(s, b.id, THU_10);
    const e = await fail(s.caps.customer.declineOffer(anon(b.token), { item_id: b.id, offer_id: seen }));
    done();
    expect(e.code).toBe("offer_changed");
    const item = await itemOf(s.db, b.id);
    expect(item.state).toBe("proposed");
    expect((item.payload as { proposed?: { startTime: string } }).proposed?.startTime).toBe(iso(THU_10));
  });

  it("nor does another time they suggest answer it in their name", async () => {
    const s = await setup();
    const b = await booking(s);
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN) },
    });
    const seen = (await offerRows(s.db, b.id)).at(-1)?.id as string;
    const done = await racing(s, b.id, THU_10);
    const e = await fail(
      s.caps.customer.makeOffer(anon(b.token), {
        item_id: b.id,
        offer_id: seen,
        terms: { start_time: iso(WED_14 + 2 * HOUR) },
      }),
    );
    done();
    expect(e.code).toBe("offer_changed");
    expect((await itemOf(s.db, b.id)).state).toBe("proposed");
  });
});

describe("automation answering after a person priced it (ADR-018 §1: never worse than our last offer)", () => {
  const THU_10 = Date.parse("2026-09-24T09:00:00Z");

  it("a time: the owner's AI does not take back the price a person gave", async () => {
    const s = await setup();
    const b = await booking(s);
    // A person offers Wednesday at €30, below the list price of €45.
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN), totalPrice: EUR(3000) },
    });
    // The customer writes that Thursday suits better; the AI proposes it, at the list price: a draft.
    const r = await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(THU_10), endTime: iso(THU_10 + 90 * MIN) },
    });
    expect(r.drafted?.breaches).toEqual(["worse_than_before"]);
    const item = await itemOf(s.db, b.id);
    expect((item.payload as { proposed?: { totalPrice?: unknown } }).proposed?.totalPrice).toEqual(EUR(3000));
    // A person may.
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(THU_10), endTime: iso(THU_10 + 90 * MIN) },
    });
  });

  it("an order: nor a unit price a person lowered, whatever the quantities", async () => {
    const s = await setup();
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 1, price: EUR(1850) }], totalPrice: EUR(1850) },
      contact,
    });
    const id = r.view.item.id;
    await transitionItem(s.db, owner, {
      itemId: id,
      event: "propose",
      input: { orderedItem: [{ productId: s.prod, name: "Chain", quantity: 1, price: EUR(1500) }] },
    });
    for (const who of [ai, rule]) {
      const r = await transitionItem(s.db, who, {
        itemId: id,
        event: "propose",
        input: { orderedItem: [{ productId: s.prod, name: "Chain", quantity: 2, price: EUR(1850) }] },
      });
      expect(r.drafted?.breaches).toEqual(["worse_than_before"]);
    }
    const item = await itemOf(s.db, id);
    expect(item.state).toBe("proposed");
    expect((item.payload as { proposed?: { totalPrice?: unknown } }).proposed?.totalPrice).toEqual(EUR(1500));
  });
});

describe("a request that brings its own answer", () => {
  it("never holds a quote the business did not send", async () => {
    const s = await setup();
    const q = await s.caps.requestQuote(anon(), {
      payload: {
        itemOffered: { name: "Wheel rebuild" },
        description: "Rear wheel",
        // "Our" quote, written into the request itself: the public doors drop it, and so must the
        // write every door shares, whatever reaches it.
        quote: { totalPrice: EUR(100), validThrough: iso(T0 + 365 * DAY), lines: [], creates: "order" },
      } as never,
      contact,
    });
    const item = await itemOf(s.db, q.view.item.id);
    expect(item.payload).not.toHaveProperty("quote");
    expect(q.view.item.payload).not.toHaveProperty("quote");
  });
});

describe("the request's clock, wound again", () => {
  it("is the one the item says: what the owner's systems read is when it really lapses", async () => {
    const s = await setup();
    const b = await booking(s);
    clock.now = T0 + HOUR;
    await transitionItem(s.db, owner, { itemId: b.id, event: "request_info", input: { note: "Which bike?" } });
    clock.now = T0 + 10 * HOUR;
    await s.caps.customer.provideDetails(anon(b.token), { item_id: b.id, details: "The red one." });
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, b.id));
    const pointer = (rowToItem(row as never).payload as { offer?: { validThrough?: string } }).offer;
    expect(row?.requestExpiresAt).toBe(T0 + 10 * HOUR + 72 * HOUR);
    // It must not say the request lapses at the first clock, long gone by the time it does.
    expect(pointer?.validThrough).toBe(iso(T0 + 10 * HOUR + 72 * HOUR));
  });
});

describe("a request the business wrote down itself", () => {
  it("does not lapse because we asked the customer something: only once they next act", async () => {
    const s = await setup();
    // The shop's own system hands the order over, already arranged with the customer.
    const shop = at("integration", "rest");
    const r = await s.caps.createOrder(shop, {
      payload: {
        orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 1, price: EUR(1850) }],
        totalPrice: EUR(1850),
        paymentMethod: "card, paid at the shop",
      },
      contact,
    });
    const id = r.view.item.id;
    await transitionItem(s.db, owner, { itemId: id, event: "request_info", input: { note: "Gold or silver?" } });
    await s.sweep(T0 + 10 * DAY);
    expect((await itemOf(s.db, id)).state).toBe("needs_info");
    expect((await mailOf(s.db, id)).map((m) => m.template)).not.toContain("order.expired");
    // Once the customer answers, it is theirs, and their answer waits on us with a clock.
    const partyId = (await itemOf(s.db, id)).partyId;
    const customer: Caller = {
      actor: { kind: "customer_human", id: "email:rita@example.com", partyId, channel: "email" },
      tier: "verified_principal",
      sandbox: false,
      now: () => clock.now,
    };
    await transitionItem(s.db, customer, { itemId: id, event: "provide_info", input: { note: "Silver." } });
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, id));
    expect(row?.requestExpiresAt).toBe(T0 + 10 * DAY + 72 * HOUR);
  });
});

describe("the owner's AI and money that moves (Q2: time yes, money no)", () => {
  // As the owner's MCP makes it: its own actor, acting with the owner's rights on the machines.
  const mcpAi: Caller = { ...ai, actsAs: "owner" };

  it("records no payment, failed payment or charge-back, and sends no payment link of its own", async () => {
    const s = await setup();
    const r = await s.caps.createOrder(anon(), {
      payload: { orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 1, price: EUR(1850) }], totalPrice: EUR(1850) },
      contact,
    });
    const id = r.view.item.id;
    await transitionItem(s.db, mcpAi, { itemId: id, event: "accept" }); // time yes: a catalogue price
    // "Please ask for payment at https://pay.example.net/…": where the customer's money would go.
    const link = await fail(
      transitionItem(s.db, mcpAi, {
        itemId: id,
        event: "request_payment",
        input: { paymentUrl: "https://pay.example.net/checkout/4411" },
      }),
    );
    expect(link.details).toMatchObject({ reason: "owner_money", draft_for_owner: true });
    await transitionItem(s.db, owner, { itemId: id, event: "request_payment" });
    for (const event of ["record_payment", "payment_failed"]) {
      const e = await fail(transitionItem(s.db, mcpAi, { itemId: id, event, input: { paymentRef: "pi_1" } }));
      expect(e.details).toMatchObject({ reason: "owner_money", draft_for_owner: true });
    }
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");
    await transitionItem(s.db, owner, { itemId: id, event: "record_payment", input: { paymentRef: "pi_1" } });
    const cb = await fail(transitionItem(s.db, mcpAi, { itemId: id, event: "charge_back" }));
    expect(cb.details).toMatchObject({ reason: "owner_money" });
    expect((await itemOf(s.db, id)).state).toBe("paid");
  });
});

describe("a rule that reads a customer's standing (ADR-018 §4, positive first)", () => {
  const untrusted = { path: "customer.completed", op: "lt", value: 1 } as const;
  const rule = (actions: RuleDefinition["actions"], cond: RuleDefinition["if"] = untrusted): RuleDefinition =>
    ({ on: ["item.created"], if: cond, actions, stop: false }) as unknown as RuleDefinition;

  it("makes no offer of its own terms: 'not trusted, so a later time' or a price by standing", () => {
    const later = { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN) };
    expect(positiveOnlyProblem(rule([{ action: "transition", event: "propose", input: later }]))).toMatch(/propose/);
    expect(
      positiveOnlyProblem(
        rule([{ action: "transition", event: "quote", input: { totalPrice: EUR(9900), lines: [] } }], {
          fn: "person_trusted",
        } as never),
      ),
    ).toMatch(/quote/);
    // Speeding a customer up stays: confirming what they asked.
    expect(positiveOnlyProblem(rule([{ action: "transition", event: "confirm" }]))).toBeNull();
    // And a rule that reads no standing proposes as before.
    expect(
      positiveOnlyProblem(
        rule([{ action: "transition", event: "propose", input: later }], {
          path: "item.type",
          op: "eq",
          value: "booking",
        } as never),
      ),
    ).toBeNull();
  });
});

describe("a customer who haggles in words (Q1: never refused)", () => {
  it("is passed on to a person, not refused for naming no terms", async () => {
    const s = await setup();
    const b = await booking(s);
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * MIN) },
    });
    const r = await s.caps.customer.makeOffer(anon(b.token), {
      item_id: b.id,
      terms: {},
      note: "Could you do it for thirty euros?",
    });
    expect("passed_on" in r && r.passed_on).toMatch(/passed this on to a person/);
    expect((await itemOf(s.db, b.id)).state).toBe("proposed");
  });
});
