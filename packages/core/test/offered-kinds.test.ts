import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, products, services } from "../src/schema/tables";
import { type Caller, WriteError } from "../src/write/index";
import { aProduct, clientOf, confirming, makeClient, openAllWeek, resetTables } from "./harness";

/**
 * An assistant sends only the kinds of request the business takes here (ADR-048): the item types its
 * manifest and profile publish. Any other kind is refused before anything is written, naming what it does
 * take; an order is offered only while a product is on sale at a fixed price. People on the business's own
 * page, and the business itself, are never held to it; a retry of a request already written is answered as
 * it was.
 */
const T0 = Date.parse("2026-11-16T09:00:00Z");
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const EUR = (value: number) => ({ value, currency: "EUR" });

const at = (kind: Caller["actor"]["kind"], channel: Caller["actor"]["channel"], extra: Partial<Caller> = {}) =>
  ({
    actor: { kind, id: `${kind}:1`, channel },
    tier: "verified_principal",
    sandbox: false,
    now: () => T0,
    ...extra,
  }) as Caller;
const owner = at("owner", "owner_ui");
const integration = at("integration", "rest", {
  actsAs: "owner",
  principal: { via: "api_key", id: "key_1", name: "Till", scopes: ["*"], userId: null, keyKind: "integration" },
});
const agent: Caller = {
  actor: { kind: "customer_agent", id: "agent:1", channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};
/** A person on the business's own page. */
const visitor: Caller = { ...agent, actor: { kind: "customer_human", id: "anon:1", channel: "form" } };
const contact = { name: "Rita", email: "rita@example.com" };

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm
    .insert(business)
    .values({ id: "self", name: "Padaria Sol", timezone: "UTC", currency: "EUR", createdAt: T0, updatedAt: T0 });
  return { db, caps: confirming(new Capabilities(db)) };
}

async function refused(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

const count = async (db: Awaited<ReturnType<typeof setup>>["db"]) =>
  Number((await db.client.query({ sql: "SELECT COUNT(*) FROM items", method: "all" })).rows[0]?.[0]);

describe("orders", () => {
  it("are refused with nothing on sale, naming what the business takes; taken with a product at a fixed price", async () => {
    const s = await setup();
    const order = (productId: string) =>
      s.caps.createOrder(agent, { payload: { orderedItem: [{ productId, quantity: 1 }] }, contact } as never);
    const none = await refused(order("no-such-product"));
    expect(none).toMatchObject({
      code: "not_allowed",
      status: 403,
      details: { reason: "order_not_offered", item_type: "order", item_types: ["message"] },
    });
    expect(none.message).toBe(
      "We take no orders here. What we take here: messages (item_types in get_business_profile). Nothing was written.",
    );
    // A catalogue priced on request is asked about: no order is taken, and the refusal says what is.
    const cake = await s.caps.setup.createProduct(owner, { name: "Wedding cake", price_model: "quote", active: true });
    await s.caps.setup.createProduct(owner, {
      name: "Birthday cake",
      price: EUR(3_500),
      price_model: "from",
      active: true,
    });
    expect((await s.caps.getBusinessProfile()).item_types).toEqual(["message", "quote_request"]);
    const onRequest = await refused(order(cake.id));
    expect(onRequest.details).toEqual({
      reason: "order_not_offered",
      item_type: "order",
      item_types: ["message", "quote_request"],
    });
    expect(onRequest.message).toBe(
      "We take no orders here. What we take here: messages and requests for a price (item_types in get_business_profile). Nothing was written.",
    );
    expect(await count(s.db)).toBe(0);
    // One loaf at a fixed price, and orders are taken.
    const loaf = await aProduct(s.caps, { name: "Loaf", value: 450 });
    expect((await s.caps.getBusinessProfile()).item_types).toEqual(["message", "quote_request", "order", "refund"]);
    expect((await order(loaf)).view.item.type).toBe("order");
  });

  it("answers a retry of an order already written, even once the last product went off sale", async () => {
    const s = await setup();
    const loaf = await aProduct(s.caps, { name: "Loaf", value: 450 });
    const input = { payload: { orderedItem: [{ productId: loaf, quantity: 2 }] }, contact, idempotency_key: "o-1" };
    const first = await s.caps.createOrder(agent, input as never);
    await s.db.orm.update(products).set({ active: 0 }).where(eq(products.id, loaf));
    const fresh = await refused(s.caps.createOrder(agent, { ...input, idempotency_key: "o-2" } as never));
    expect(fresh.details).toMatchObject({ reason: "order_not_offered" });
    const again = await s.caps.createOrder(agent, input as never);
    expect(again.replayed).toBe(true);
    expect(again.view.item.id).toBe(first.view.item.id);
  });
});

describe("requests for a price", () => {
  it("are refused with nothing listed, and taken once the owner opens them", async () => {
    const s = await setup();
    const ask = () =>
      s.caps.requestQuote(agent, {
        payload: { itemOffered: { name: "A cake for forty" }, description: "Lemon, three tiers" },
        contact,
      });
    expect((await refused(ask())).details).toEqual({
      reason: "quote_request_not_offered",
      item_type: "quote_request",
      item_types: ["message"],
    });
    await s.caps.updateSettings(owner, { doc: { doors: { quoteRequest: true } } });
    expect((await ask()).view.item.type).toBe("quote_request");
  });

  it("are a person's to send on the business's own page, whatever it lists", async () => {
    const s = await setup();
    const asked = await s.caps.requestQuote(visitor, {
      payload: { itemOffered: { name: "A cake for forty" }, description: "Lemon, three tiers" },
      contact,
    });
    expect(asked.view.item.type).toBe("quote_request");
  });
});

describe("bookings", () => {
  it("are refused with no hours to book in, with the times as well, naming what the business takes", async () => {
    const s = await setup();
    const svc = ulid();
    await s.db.orm.insert(services).values({
      id: svc,
      name: "Baking class",
      durationMin: 120,
      price: { model: "fixed", value: 6_000, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    });
    const start = T0 + 3 * DAY;
    const booked = await refused(
      s.caps.createBooking(agent, {
        payload: {
          reservationFor: { serviceId: svc, name: "Baking class" },
          startTime: iso(start),
          endTime: iso(start + 2 * 3_600_000),
        },
        contact,
      } as never),
    );
    expect(booked).toMatchObject({
      code: "not_allowed",
      details: { reason: "booking_not_offered", item_type: "booking", item_types: ["message", "quote_request"] },
    });
    expect(booked.message).toBe(
      "We take no bookings here yet. What we take here: messages and requests for a price (item_types in get_business_profile). Nothing was written.",
    );
    const times = await refused(
      s.caps.checkAvailability({ service_id: svc, from: iso(start), to: iso(start + DAY) }, { now: T0, caller: agent }),
    );
    expect(times.details).toEqual(booked.details);
    // With hours, it books.
    await openAllWeek(s.db);
    const made = await s.caps.createBooking(agent, {
      payload: {
        reservationFor: { serviceId: svc, name: "Baking class" },
        startTime: iso(start),
        endTime: iso(start + 2 * 3_600_000),
      },
      contact,
    } as never);
    expect(made.view.item.type).toBe("booking");
  });
});

describe("stays", () => {
  it("are refused at a place with no room to offer yet", async () => {
    const s = await setup();
    await s.caps.stays.upsertProperty(owner, { name: "Casa Sol", kind: "guesthouse", currency: "EUR" });
    const e = await refused(
      s.caps.stays.request(agent, {
        check_in: "2026-12-04",
        check_out: "2026-12-06",
        rooms: [{ adults: 2 }],
        contact,
        consent: true,
      }),
    );
    expect(e).toMatchObject({
      code: "not_allowed",
      details: { reason: "stay_not_offered", item_type: "stay", item_types: ["message"] },
    });
    expect(e.message).toBe(
      "We take no stays here yet. What we take here: messages (item_types in get_business_profile). Nothing was written.",
    );
    expect(await count(s.db)).toBe(0);
  });
});

describe("the business", () => {
  it("writes down every kind for its customers, whatever it offers agents: the owner and its keys", async () => {
    const s = await setup();
    for (const caller of [owner, integration]) {
      const start = T0 + 3 * DAY;
      const o = await s.caps.createOrder(caller, {
        payload: { orderedItem: [{ name: "Loaf", quantity: 1, price: EUR(450) }], totalPrice: EUR(450) },
        contact: clientOf(),
      } as never);
      expect(o.view.item.type).toBe("order");
      const q = await s.caps.requestQuote(caller, {
        payload: { itemOffered: { name: "A cake for forty" }, description: "Lemon" },
      });
      expect(q.view.item.type).toBe("quote_request");
      const svc = ulid();
      await s.db.orm.insert(services).values({
        id: svc,
        name: "Baking class",
        durationMin: 60,
        createdAt: T0,
        updatedAt: T0,
      });
      const b = await s.caps.createBooking(caller, {
        payload: {
          reservationFor: { serviceId: svc, name: "Baking class" },
          startTime: iso(start),
          endTime: iso(start + 3_600_000),
        },
      } as never);
      expect(b.view.item.type).toBe("booking");
    }
  });
});
