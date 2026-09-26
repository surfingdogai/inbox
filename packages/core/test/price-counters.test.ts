import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { offerRows } from "../src/negotiation/offers";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, itemEvents, items, products, services } from "../src/schema/tables";
import { type Caller, transitionItem, WriteError } from "../src/write/index";
import { rowToItem } from "../src/write/views";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * A customer's own price (ADR-018 §4, Q1): off out of the box, when it goes to a person as the
 * customer's message and is never refused; on, it is their counter, for a person to take or answer, or
 * for automation to take at or above the owner's floor — never to haggle. What the owner marks not to be
 * haggled, a quote, and a customer who asks too often all go to a person. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const EUR = (value: number) => ({ value, currency: "EUR" });
const at = (t: number) => () => t;
const iso = (t: number) => new Date(t).toISOString();
const HOUR = 3_600_000;
const WED_14 = Date.parse("2026-09-23T14:00:00Z");

const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  principal: { via: "session", id: "s1", name: "owner@example.com", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: at(T0),
};
const ai: Caller = {
  actor: { kind: "owner_ai", id: "client_1", channel: "mcp_owner" },
  actsAs: "owner",
  principal: { via: "oauth", id: "client_1", name: "Assistant", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: at(T0),
};
const rule: Caller = {
  actor: { kind: "rule", id: "rule_1", channel: "system" },
  tier: "verified_principal",
  sandbox: false,
  now: at(T0),
};
const customer = (token: string): Caller => ({
  actor: { kind: "customer_agent", id: "anon:agent", channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  accessToken: token,
  now: at(T0),
});

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm
    .insert(business)
    .values({ id: "self", name: "Oficina Maré", timezone: "UTC", currency: "EUR", createdAt: T0, updatedAt: T0 });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 2,
    granularityMin: 30,
    price: { model: "fixed", value: 4_500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const chain = ulid();
  await db.orm
    .insert(products)
    .values({ id: chain, sku: "CH-9", name: "Chain", price: EUR(1_850), createdAt: T0, updatedAt: T0 });
  const caps = confirming(new Capabilities(db));
  let hour = 8;
  /** A booking the owner answered with another time: our open offer, at the list price. */
  const proposed = async () => {
    hour++;
    const start = Date.parse(`2026-09-22T${String(hour).padStart(2, "0")}:00:00Z`);
    const b = await caps.createBooking(customer(""), {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: iso(start),
        endTime: iso(start + 90 * 60_000),
      },
      contact: { email: "rita@example.com" },
    });
    const id = b.view.item.id;
    const at14 = WED_14 + (hour - 9) * 2 * HOUR;
    await caps.transitionItem(owner, {
      item_id: id,
      event: "propose",
      input: { startTime: iso(at14), endTime: iso(at14 + 90 * 60_000) },
    });
    return { id, token: b.accessToken as string };
  };
  /** An order the owner answered with changes: two chains at the list price. */
  const changes = async () => {
    const o = await caps.createOrder(customer(""), {
      payload: {
        orderedItem: [{ productId: chain, name: "Chain", quantity: 1, price: EUR(1_850) }],
        totalPrice: EUR(1_850),
      },
      contact: { email: "rita@example.com" },
    });
    const id = o.view.item.id;
    await caps.transitionItem(owner, {
      item_id: id,
      event: "propose",
      input: { orderedItem: [{ productId: chain, name: "Chain", quantity: 2, price: EUR(1_850) }] },
    });
    return { id, token: o.accessToken as string };
  };
  const counters = (on: Record<string, unknown> = {}) =>
    caps.updateSettings(owner, { doc: { negotiation: { priceCounters: true, ...on } } });
  const itemOf = async (id: string) =>
    rowToItem((await db.orm.select().from(items).where(eq(items.id, id)))[0] as never);
  return { db, caps, svc, chain, proposed, changes, counters, itemOf };
}

async function refusal(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("a customer's own price, while the owner sets its prices (out of the box)", () => {
  it("goes to a person as their message, never refused, and what we proposed stands", async () => {
    const s = await setup();
    expect((await s.caps.getBusinessProfile()).price_negotiable).toBe(false);
    const b = await s.proposed();
    const r = await s.caps.customer.makeOffer(customer(b.token), { item_id: b.id, terms: { total_price: EUR(3_000) } });
    expect(r).toMatchObject({ waiting_on: "us", appended: true });
    expect((r as { passed_on: string }).passed_on).toMatch(/still stands/);
    expect((await s.itemOf(b.id)).state).toBe("proposed");
  });
});

describe("price counters, once the owner switches them on", () => {
  it("are the customer's answer: their price on the time we proposed, back with us", async () => {
    const s = await setup();
    await s.counters();
    expect((await s.caps.getBusinessProfile()).price_negotiable).toBe(true);
    const b = await s.proposed();
    const r = await s.caps.customer.makeOffer(customer(b.token), { item_id: b.id, terms: { total_price: EUR(4_000) } });
    expect(r.view.item.state).toBe("requested");
    const item = await s.itemOf(b.id);
    expect(item.payload).toMatchObject({ totalPrice: EUR(4_000) });
    const open = (await offerRows(s.db, b.id)).find((o) => o.status === "open");
    expect(open).toMatchObject({ by: "customer", terms: { totalPrice: EUR(4_000) } });
    // Counted against how often they may: the service it prices.
    const [counter] = await s.db.orm.select().from(itemEvents).where(eq(itemEvents.event, "counter"));
    expect((counter?.meta as { priced?: string[] } | undefined)?.priced).toEqual([`service:${s.svc}`]);
  });

  it("are the owner's to take; automation takes one only at or above the owner's floor", async () => {
    const s = await setup();
    await s.counters();
    const b = await s.proposed();
    await s.caps.customer.makeOffer(customer(b.token), { item_id: b.id, terms: { total_price: EUR(4_000) } });
    for (const who of [ai, rule]) {
      const e = await refusal(transitionItem(s.db, who, { itemId: b.id, event: "confirm" }));
      expect(e.code).toBe("outside_limits");
      expect(e.status).toBe(422);
      expect(e.details).toEqual({ breaches: ["below_floor"], draft_for_owner: true });
      expect(e.message).not.toMatch(/\d/);
    }
    // The owner lets automation give up to 15%: 40.00 is within it, and the price is theirs, with the notice.
    await s.caps.updateSettings(owner, { doc: { negotiation: { ai: { maxDiscountPct: 15 } } } });
    const taken = await transitionItem(s.db, ai, { itemId: b.id, event: "confirm" });
    expect(taken.view.item.state).toBe("confirmed");
    expect(taken.view.item.payload).toMatchObject({ totalPrice: EUR(4_000), personalised: { listPrice: EUR(4_500) } });
  });

  it("are never answered by automation with a price of its own: that is a draft for the owner", async () => {
    const s = await setup();
    // Rounds to spare, so the only limit it meets is the one on answering a price with a price.
    await s.counters({ ai: { maxDiscountPct: 20 }, maxRounds: 5 });
    const b = await s.proposed();
    await s.caps.customer.makeOffer(customer(b.token), { item_id: b.id, terms: { total_price: EUR(4_000) } });
    const r = await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14 + 24 * HOUR), endTime: iso(WED_14 + 25.5 * HOUR), totalPrice: EUR(4_250) },
    });
    expect(r.drafted?.breaches).toEqual(["counter_priced"]);
    expect((await s.itemOf(b.id)).state).toBe("requested");
    // A person may answer with a price of theirs.
    await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14 + 24 * HOUR), endTime: iso(WED_14 + 25.5 * HOUR), totalPrice: EUR(4_250) },
    });
    expect((await s.itemOf(b.id)).state).toBe("proposed");
  });

  it("on changes to an order: a unit price of their own per line, taken by a person", async () => {
    const s = await setup();
    await s.counters();
    const o = await s.changes();
    const r = await s.caps.customer.makeOffer(customer(o.token), {
      item_id: o.id,
      terms: { lines: [{ index: 0, quantity: 2, unit_price: EUR(1_500) }] },
    });
    expect(r.view.item.state).toBe("received");
    expect((await s.itemOf(o.id)).payload).toMatchObject({
      orderedItem: [{ productId: s.chain, quantity: 2, price: EUR(1_500) }],
      totalPrice: EUR(3_000),
    });
    const e = await refusal(transitionItem(s.db, ai, { itemId: o.id, event: "accept" }));
    expect(e.details).toMatchObject({ breaches: ["below_floor"] });
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    expect((await s.itemOf(o.id)).state).toBe("accepted");
  });

  it("go to a person for what the owner does not haggle, for a quote, and past how often one customer may", async () => {
    const s = await setup();
    await s.counters({ perCustomer: { priceCounters: 1 } });
    // Not haggled: the owner marked the service so.
    await s.caps.setup.updateService(owner, { service_id: s.svc, negotiable: false });
    const fixed = await s.proposed();
    const kept = await s.caps.customer.makeOffer(customer(fixed.token), {
      item_id: fixed.id,
      terms: { total_price: EUR(4_000) },
    });
    expect(kept).toMatchObject({ appended: true });
    expect((await s.itemOf(fixed.id)).state).toBe("proposed");
    await s.caps.setup.updateService(owner, { service_id: s.svc, negotiable: true });
    // Once is allowed; the same customer again, on the same service, goes to a person.
    const one = await s.proposed();
    const first = await s.caps.customer.makeOffer(customer(one.token), {
      item_id: one.id,
      terms: { total_price: EUR(4_000) },
    });
    expect(first.view.item.state).toBe("requested");
    const two = await s.proposed();
    const second = await s.caps.customer.makeOffer(customer(two.token), {
      item_id: two.id,
      terms: { total_price: EUR(3_900) },
    });
    expect(second).toMatchObject({ appended: true });
    expect((await s.itemOf(two.id)).state).toBe("proposed");
  });

  it("stay in our currency", async () => {
    const s = await setup();
    await s.counters();
    const b = await s.proposed();
    const e = await refusal(
      s.caps.customer.makeOffer(customer(b.token), {
        item_id: b.id,
        terms: { total_price: { value: 4_000, currency: "USD" } },
      }),
    );
    expect(e.code).toBe("invalid_input");
    expect((await s.itemOf(b.id)).state).toBe("proposed");
  });
});

describe("the owner's AI and price counters", () => {
  it("cannot switch them on, nor mark what may be haggled", async () => {
    const s = await setup();
    expect((await refusal(s.caps.updateSettings(ai, { doc: { negotiation: { priceCounters: true } } }))).code).toBe(
      "not_allowed",
    );
    const e = await refusal(s.caps.setup.updateService(ai, { service_id: s.svc, negotiable: false }));
    expect(e.code).toBe("not_allowed");
    expect(e.fields?.[0]?.path).toBe("negotiable");
  });
});
