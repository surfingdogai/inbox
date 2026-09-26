import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { amountsIn, discountIn, speltAmountIn } from "../src/negotiation/amounts";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, products, services, threadEntries } from "../src/schema/tables";
import { type Caller, transitionItem, WriteError } from "../src/write/index";
import { rowToItem } from "../src/write/views";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * The owner's limits, attacked (ADR-018 §4, Q1–Q3): a haggling assistant, a confused one, the owner's
 * AI a customer's message talked round, and a key without money:write, each trying to get money agreed
 * that the owner did not agree, around the checks rather than through them. Runs on Node and in workerd.
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
const key = (scopes: string[]): Caller => ({
  actor: { kind: "integration", id: "key_1", channel: "rest" },
  actsAs: "owner",
  tier: "verified_principal",
  sandbox: false,
  now: at(T0),
  principal: { via: "api_key", id: "key_1", name: "Zap", scopes, userId: null, keyKind: "integration" },
});
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
  const booking = async () => {
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
    return { id: b.view.item.id, token: b.accessToken as string, start };
  };
  /** A booking the owner answered with another time: our open offer, at the list price. */
  const proposed = async () => {
    const b = await booking();
    const at14 = WED_14 + (hour - 9) * 2 * HOUR;
    await caps.transitionItem(owner, {
      item_id: b.id,
      event: "propose",
      input: { startTime: iso(at14), endTime: iso(at14 + 90 * 60_000) },
    });
    return { ...b, at14 };
  };
  const order = async (quantity: number) => {
    const o = await caps.createOrder(customer(""), {
      payload: {
        orderedItem: [{ productId: chain, name: "Chain", quantity, price: EUR(1_850) }],
        totalPrice: EUR(1_850 * quantity),
      },
      contact: { email: "rita@example.com" },
    });
    return { id: o.view.item.id, token: o.accessToken as string };
  };
  const itemOf = async (id: string) =>
    rowToItem((await db.orm.select().from(items).where(eq(items.id, id)))[0] as never);
  return { db, caps, svc, chain, booking, proposed, order, itemOf };
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

describe("a confused assistant's price above ours", () => {
  it("is never taken by automation: above the list price is a person's, even when the customer wrote it", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { priceCounters: true } } });
    const b = await s.proposed();
    // 450.00 instead of 45.00: the assistant mistook the units.
    await s.caps.customer.makeOffer(customer(b.token), { item_id: b.id, terms: { total_price: EUR(45_000) } });
    for (const who of [ai, rule]) {
      const e = await refusal(transitionItem(s.db, who, { itemId: b.id, event: "confirm" }));
      expect(e.code).toBe("outside_limits");
      expect(e.details).toMatchObject({ breaches: ["above_list"] });
    }
    // A person may still take it (and would ask the customer first).
    expect((await s.itemOf(b.id)).state).toBe("requested");
  });

  it("per line of an order, likewise", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { priceCounters: true } } });
    const o = await s.order(1);
    await s.caps.transitionItem(owner, {
      item_id: o.id,
      event: "propose",
      input: { orderedItem: [{ productId: s.chain, name: "Chain", quantity: 2, price: EUR(1_850) }] },
    });
    await s.caps.customer.makeOffer(customer(o.token), {
      item_id: o.id,
      terms: { lines: [{ index: 0, quantity: 2, unit_price: EUR(18_500) }] },
    });
    const e = await refusal(transitionItem(s.db, ai, { itemId: o.id, event: "accept" }));
    expect(e.details).toMatchObject({ breaches: ["above_list"] });
  });
});

describe("a customer's own price on what the catalogue does not price", () => {
  it("is never automation's to take: a line a person priced, countered", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { priceCounters: true, ai: { maxDiscountPct: 50 } } } });
    const o = await s.order(1);
    // A person adds a line of their own to what we suggest: engraving, priced by them.
    await s.caps.transitionItem(owner, {
      item_id: o.id,
      event: "propose",
      input: {
        orderedItem: [
          { productId: s.chain, name: "Chain", quantity: 1, price: EUR(1_850) },
          { name: "Engraving", quantity: 1, price: EUR(3_000) },
        ],
      },
    });
    await s.caps.customer.makeOffer(customer(o.token), {
      item_id: o.id,
      terms: { lines: [{ index: 1, quantity: 1, unit_price: EUR(100) }] },
    });
    const now = await s.itemOf(o.id);
    const lines = (now.payload as { orderedItem: { name: string; price: { value: number } }[] }).orderedItem;
    // Their price is their answer, back with us; automation does not agree to it.
    expect(lines.find((l) => l.name === "Engraving")?.price.value).toBe(100);
    for (const who of [ai, rule]) {
      const e = await refusal(transitionItem(s.db, who, { itemId: o.id, event: "accept" }));
      expect(e.details).toMatchObject({ guard: "business_priced" });
    }
    expect((await s.itemOf(o.id)).state).toBe("received");
  });

  it("is never automation's to take: a service priced from, or by quote, countered", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { priceCounters: true, ai: { maxDiscountPct: 50 } } } });
    const repair = ulid();
    await s.db.orm.insert(services).values({
      id: repair,
      name: "Repair",
      durationMin: 60,
      capacity: 1,
      granularityMin: 30,
      price: { model: "from", value: 2_000, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    });
    const b = await s.caps.createBooking(customer(""), {
      payload: {
        reservationFor: { serviceId: repair, name: "Repair" },
        startTime: "2026-09-22T09:00:00.000Z",
        endTime: "2026-09-22T10:00:00.000Z",
      },
      contact: { email: "rita@example.com" },
    });
    const id = b.view.item.id;
    // A person proposes another time, at a price of theirs.
    await s.caps.transitionItem(owner, {
      item_id: id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + HOUR), totalPrice: EUR(8_000) },
    });
    await s.caps.customer.makeOffer(customer(b.accessToken as string), {
      item_id: id,
      terms: { total_price: EUR(1_000) },
    });
    expect((await s.itemOf(id)).payload).toMatchObject({ totalPrice: EUR(1_000) });
    for (const who of [ai, rule]) {
      const e = await refusal(transitionItem(s.db, who, { itemId: id, event: "confirm" }));
      expect(e.code).toBe("outside_limits");
      expect(e.details).toMatchObject({ breaches: ["custom_line"] });
    }
    expect((await s.itemOf(id)).state).toBe("requested");
    // A time of their own, at the price the person gave, is time: automation may take it.
    const again = await s.caps.createBooking(customer(""), {
      payload: {
        reservationFor: { serviceId: repair, name: "Repair" },
        startTime: "2026-09-22T11:00:00.000Z",
        endTime: "2026-09-22T12:00:00.000Z",
      },
      contact: { email: "rita@example.com" },
    });
    await s.caps.transitionItem(owner, {
      item_id: again.view.item.id,
      event: "propose",
      input: { startTime: iso(WED_14 + 2 * HOUR), endTime: iso(WED_14 + 3 * HOUR), totalPrice: EUR(8_000) },
    });
    await s.caps.customer.makeOffer(customer(again.accessToken as string), {
      item_id: again.view.item.id,
      terms: { start_time: "2026-09-24T10:00:00.000Z" },
    });
    const taken = await transitionItem(s.db, ai, { itemId: again.view.item.id, event: "confirm" });
    expect(taken.view.item.state).toBe("confirmed");
  });
  it("never keeps a longer time a person priced: their price is for the service as the catalogue sells it", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { priceCounters: true, ai: { maxDiscountPct: 50 } } } });
    const b = await s.booking();
    // A person offers a double session, at a price of theirs.
    await s.caps.transitionItem(owner, {
      item_id: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 3 * HOUR), totalPrice: EUR(9_000) },
    });
    await s.caps.customer.makeOffer(customer(b.token), { item_id: b.id, terms: { total_price: EUR(4_500) } });
    expect((await s.itemOf(b.id)).payload).toMatchObject({
      totalPrice: EUR(4_500),
      startTime: iso(WED_14),
      endTime: iso(WED_14 + 90 * 60_000),
    });
  });
});

describe("a customer's price automation takes by proposing another time at it", () => {
  it("carries the personalised-price notice, as any price automation chose for them", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, {
      doc: { negotiation: { priceCounters: true, maxRounds: 5, ai: { maxDiscountPct: 15 } } },
    });
    const b = await s.proposed();
    await s.caps.customer.makeOffer(customer(b.token), { item_id: b.id, terms: { total_price: EUR(4_000) } });
    // The AI answers with another time, naming no price: the price that goes is the customer's own.
    const r = await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(b.at14 + 24 * HOUR), endTime: iso(b.at14 + 25.5 * HOUR) },
    });
    expect(r.drafted).toBeUndefined();
    const item = await s.itemOf(b.id);
    expect(item.state).toBe("proposed");
    expect(item.payload).toMatchObject({
      totalPrice: EUR(4_000),
      proposed: { personalised: { listPrice: EUR(4_500) } },
    });
    const status = await s.caps.getItemStatus(customer(b.token), { item_id: b.id });
    expect(status.offer?.disclosures).toContain("personalised_price");
  });
});

describe("a time automation offers", () => {
  it("is one we would offer: outside the opening hours, or on a day we are closed, it is a person's", async () => {
    const s = await setup();
    const b = await s.booking();
    // 03:00 on a Wednesday, and 10:00 on a Sunday: out of the opening hours (Monday to Friday, 9 to 18).
    for (const start of ["2026-09-23T03:00:00.000Z", "2026-09-27T10:00:00.000Z"]) {
      const r = await transitionItem(s.db, ai, {
        itemId: b.id,
        event: "propose",
        input: { startTime: start, endTime: iso(Date.parse(start) + 90 * 60_000) },
      });
      expect(r.drafted?.breaches, start).toEqual(["time_moved"]);
    }
    expect((await s.itemOf(b.id)).state).toBe("requested");
    // Within them it goes to the customer.
    const ok = await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(WED_14), endTime: iso(WED_14 + 90 * 60_000) },
    });
    expect(ok.drafted).toBeUndefined();
    // A person may offer any time they like.
    const late = await transitionItem(s.db, owner, {
      itemId: b.id,
      event: "propose",
      input: { startTime: "2026-09-23T19:00:00.000Z", endTime: "2026-09-23T20:30:00.000Z" },
    });
    expect(late.view.item.state).toBe("proposed");
  });
});

describe("the owner's AI and the value it may accept alone", () => {
  it("cannot lift the owner's approval value, then accept above it", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { orders: { maxValueWithoutApprovalMinor: 3_000 } } });
    for (const value of [0, 100_000]) {
      const e = await refusal(s.caps.updateSettings(ai, { doc: { orders: { maxValueWithoutApprovalMinor: value } } }));
      expect(e.code).toBe("not_allowed");
    }
    // Tightening it is fine.
    await s.caps.updateSettings(ai, { doc: { orders: { maxValueWithoutApprovalMinor: 2_000 } } });
    const o = await s.order(2);
    const e = await refusal(transitionItem(s.db, ai, { itemId: o.id, event: "accept" }));
    expect(e.details).toMatchObject({ breaches: ["over_approval_value"] });
    // Nor can a key without money:write lift it.
    const k = await refusal(
      s.caps.updateSettings(key(["settings:write", "inbox:write"]), {
        doc: { orders: { maxValueWithoutApprovalMinor: 0 } },
      }),
    );
    expect(k.code).toBe("not_allowed");
  });
});

describe("words a rule sends, written by the owner's AI", () => {
  it("may not name an amount or something off a price: a rule's words are taken as the owner's", async () => {
    const s = await setup();
    const definitions = [
      { on: ["thread.inbound"], if: { all: [] }, actions: [{ action: "reply", template: "We can do it for €30." }] },
      { on: ["thread.inbound"], if: { all: [] }, actions: [{ action: "reply", template: "For you, 20% off." }] },
      {
        on: ["item.created"],
        if: { all: [] },
        actions: [{ action: "transition", event: "confirm", input: { note: "Confirmed at €30." } }],
      },
    ];
    for (const definition of definitions) {
      const e = await refusal(
        s.caps.setup.createRule(ai, { name: "Kind words", priority: 0, enabled: true, definition } as never),
      );
      expect(e.code).toBe("not_allowed");
    }
    // Nor a key handed to another system without money:write, and not by rewriting one.
    const k = await refusal(
      s.caps.setup.createRule(key(["setup:run"]), {
        name: "Kind words",
        priority: 0,
        enabled: true,
        definition: definitions[0],
      } as never),
    );
    expect(k.code).toBe("not_allowed");
    const plain = await s.caps.setup.createRule(ai, {
      name: "Thanks",
      priority: 0,
      enabled: true,
      definition: {
        on: ["thread.inbound"],
        if: { all: [] },
        actions: [{ action: "reply", template: "Thanks, we'll be in touch." }],
      },
    } as never);
    const r = await refusal(
      s.caps.setup.updateRule(ai, {
        rule_id: plain.id,
        definition: definitions[0],
      } as never),
    );
    expect(r.code).toBe("not_allowed");
    // A key handed to another system without money:write writes no quoting rule either.
    const q = await refusal(
      s.caps.setup.createRule(key(["setup:run"]), {
        name: "Quote",
        priority: 0,
        enabled: true,
        definition: {
          on: ["item.created"],
          if: { all: [] },
          actions: [{ action: "transition", event: "quote", input: { totalPrice: EUR(100) } }],
        },
      } as never),
    );
    expect(q.code).toBe("not_allowed");
    // The owner writes what they like.
    await s.caps.setup.createRule(owner, {
      name: "Kind words",
      priority: 0,
      enabled: true,
      definition: definitions[0],
    } as never);
  });
});

describe("the owner's limits, rewards and secrets, read through a rule", () => {
  it("are not in what a rule reads: a test of one is no oracle, a reply of one no recital", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, {
      doc: {
        email: { inboundSecret: "s3cret-inbound-0123456789abcdef" },
        negotiation: {
          ai: { maxDiscountPct: 12 },
          rewards: { regulars: { if: { path: "customer.completed", op: "gte", value: 3 }, pct: 5 } },
        },
      },
    });
    const b = await s.booking();
    const probe = (path: string, op: string, value: unknown) =>
      s.caps.setup.testRule(ai, {
        item_id: b.id,
        definition: { on: ["item.created"], if: { path, op, value }, actions: [{ action: "stop" }] },
      } as never);
    // Each of these would hold if the rule could read the value: none may.
    for (const [path, op, value] of [
      ["settings.negotiation.ai.maxDiscountPct", "gte", 10],
      ["settings.negotiation.ai.maxDiscountPct", "exists", undefined],
      ["settings.negotiation.rewards.regulars.pct", "eq", 5],
      ["settings.email.inboundSecret", "startsWith", "s3"],
      ["settings.email.inboundSecret", "exists", undefined],
    ] as const) {
      expect((await probe(path, op, value)).matched, path).toBe(false);
    }
    // What a rule may read of the settings, it still reads.
    expect((await probe("settings.negotiation.priceCounters", "eq", false)).matched).toBe(true);
  });
});

describe("a reward that goes to everyone but those with a bad record", () => {
  it("is refused when saved: a customer with no record pays the list price, so a reward only ever lifts", async () => {
    const s = await setup();
    for (const cond of [
      { path: "customer.no_shows", op: "eq", value: 0 },
      { path: "customer.charged_back", op: "lt", value: 1 },
      { path: "person.present", op: "eq", value: false },
      { path: "person.tier", op: "neq", value: "trusted" },
      {
        any: [
          { path: "customer.completed", op: "gte", value: 3 },
          { path: "customer.no_shows", op: "eq", value: 0 },
        ],
      },
      { path: "customer.match", op: "eq", value: "strong" },
      { path: "customer.open_bookings", op: "gte", value: 2 },
      { path: "person.present", op: "eq", value: true },
    ]) {
      const e = await refusal(
        s.caps.updateSettings(owner, { doc: { negotiation: { rewards: { all: { if: cond, pct: 10 } } } } }),
      );
      expect(e.code).toBe("invalid_input");
      expect(e.fields?.[0]?.path).toBe("doc.negotiation.rewards.all.if");
    }
    // One a record earns is fine, even when it also asks for nothing against it.
    await s.caps.updateSettings(owner, {
      doc: {
        negotiation: {
          rewards: {
            regulars: {
              if: {
                all: [
                  { path: "customer.completed", op: "gte", value: 3 },
                  { path: "customer.no_shows", op: "eq", value: 0 },
                ],
              },
              pct: 5,
            },
          },
        },
      },
    });
  });
});

describe("money in words, written as people and assistants write it", () => {
  it("is found however it is spaced, glued or spelt", () => {
    for (const text of [
      "We can do EUR30.",
      "We can do 30EUR.",
      "We can do 30euros.",
      "We can do 30  euros.",
      "We can do €​30.",
      "We can do thirty euros.",
      "Podemos fazer por trinta euros.",
      "Twenty-five pounds and it's yours.",
    ]) {
      expect(amountsIn(text).length > 0 || speltAmountIn(text), text).toBe(true);
    }
    for (const text of [
      "10 percent off for you.",
      "Half price for you.",
      "It's on the house.",
      "We'll do it for free.",
      "Free of charge.",
      "Dez por cento de desconto.",
      "Fica a metade do preço.",
      "É grátis.",
    ]) {
      expect(discountIn(text), text).toBe(true);
    }
    for (const text of [
      "We have a free slot at 10:00.",
      "Feel free to ask.",
      "A table for 2 at 20:30.",
      "Call us on 912 345 678.",
      "Temos uma vaga livre às 10h.",
    ]) {
      expect(amountsIn(text), text).toEqual([]);
      expect(discountIn(text) || speltAmountIn(text), text).toBe(false);
    }
  });

  it("from the owner's AI, is kept for a person", async () => {
    const s = await setup();
    const b = await s.booking();
    for (const [i, body] of ["We can do it for 30EUR.", "Half price for you today.", "It's on the house."].entries()) {
      const r = await s.caps.reply(ai, { item_id: b.id, internal: false, body, idempotency_key: `w-${i}` });
      expect(r, body).toMatchObject({ held: { breaches: ["amount_named"] } });
    }
    const out = (await s.db.orm.select().from(threadEntries).where(eq(threadEntries.itemId, b.id))).filter(
      (e) => e.direction === "out",
    );
    expect(out).toEqual([]);
  });

  it("names a catalogue price only beside what it prices, never as a price for this", async () => {
    const s = await setup();
    const b = await s.booking();
    // The chain's price, offered for the service: kept for a person.
    const r = await s.caps.reply(ai, { item_id: b.id, internal: false, body: "Sure, €18.50 it is." });
    expect(r).toMatchObject({ held: { breaches: ["amount_named"] } });
    // The chain's price, as the chain's: said.
    const ok = await s.caps.reply(ai, {
      item_id: b.id,
      internal: false,
      body: "Our chain is €18.50, if you need one.",
    });
    expect("held" in ok && ok.held).toBeFalsy();
  });

  it("in the name of a line automation offers, makes the offer a draft", async () => {
    const s = await setup();
    const o = await s.order(1);
    const r = await transitionItem(s.db, ai, {
      itemId: o.id,
      event: "propose",
      input: {
        orderedItem: [{ productId: s.chain, name: "Chain (€10 for you next time)", quantity: 1, price: EUR(1_850) }],
      },
    });
    expect(r.drafted?.breaches).toContain("amount_named");
  });
});

describe("a draft kept for the owner", () => {
  it("is the owner's to drop, not the AI's nor a key's: it is how the owner hears of it", async () => {
    const s = await setup();
    const b = await s.booking();
    const r = await transitionItem(s.db, ai, {
      itemId: b.id,
      event: "propose",
      input: { startTime: iso(b.start + 2 * HOUR), endTime: iso(b.start + 3.5 * HOUR), totalPrice: EUR(3_000) },
    });
    expect(r.drafted).toBeDefined();
    for (const who of [ai, key(["inbox:write"])]) {
      const e = await refusal(s.caps.dropOfferDraft(who, { item_id: b.id }));
      expect(e.code).toBe("not_allowed");
    }
    expect((await s.caps.listOffers(owner, { item_id: b.id })).draft).not.toBeNull();
    expect(await s.caps.dropOfferDraft(owner, { item_id: b.id })).toEqual({ dropped: true });
  });
});
