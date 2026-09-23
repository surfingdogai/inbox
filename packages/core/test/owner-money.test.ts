import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, products, services } from "../src/schema/tables";
import { type Caller, WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * The owner's AI is held like a rule where money is concerned (Tiago, 23 September 2026, "time yes,
 * money no"): it confirms and proposes times, and never makes a promise on a price the customer set,
 * sends a quote, proposes a price of its own, changes a catalogue price or the currency, publishes a
 * priced product or service, or connects a feed. Each refusal tells it to draft for the owner. The
 * owner's AI is an AI app the owner connected (`owner_ai`), or anything on the owner's MCP, even with
 * a full owner key. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const EUR = (value: number) => ({ value, currency: "EUR" });

const person: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
/** An AI app the owner connected by OAuth, on the owner's REST API. */
const ai: Caller = {
  actor: { kind: "owner_ai", id: "client_1", channel: "rest" },
  actsAs: "owner",
  principal: { via: "oauth", id: "client_1", name: "Assistant", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
/** A full owner key, through the owner's MCP: still an assistant. */
const mcp: Caller = {
  actor: { kind: "owner", id: "u1", channel: "mcp_owner" },
  principal: { via: "api_key", id: "k1", name: "cli", scopes: ["*"], userId: null, keyKind: "owner" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const customer: Caller = {
  actor: { kind: "customer_agent", id: "anon:agent", channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm
    .insert(business)
    .values({ id: "self", name: "Oficina Maré", timezone: "UTC", currency: "EUR", createdAt: T0, updatedAt: T0 });
  const svc = { fixed: ulid(), from: ulid() };
  const service = (id: string, price: typeof services.$inferInsert.price) => ({
    id,
    name: "Full service",
    durationMin: 60,
    capacity: 2,
    granularityMin: 30,
    price,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm
    .insert(services)
    .values([
      service(svc.fixed, { model: "fixed", value: 10_000, currency: "EUR" }),
      service(svc.from, { model: "from", value: 2_000, currency: "EUR" }),
    ]);
  const product = ulid();
  await db.orm
    .insert(products)
    .values({ id: product, sku: "SD-1", name: "Saddle", price: EUR(15_000), createdAt: T0, updatedAt: T0 });
  const caps = new Capabilities(db);
  let slot = 0;
  const book = (serviceId: string, extra: Record<string, unknown> = {}) => {
    const hour = 8 + ++slot;
    return caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId, name: "Full service" },
        startTime: `2026-09-22T${String(hour).padStart(2, "0")}:00:00Z`,
        endTime: `2026-09-22T${String(hour + 1).padStart(2, "0")}:00:00Z`,
        ...extra,
      },
    });
  };
  return { db, caps, svc, product, book };
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

const stateOf = async (db: Awaited<ReturnType<typeof setup>>["db"], id: string) =>
  (await db.orm.select({ state: items.state }).from(items).where(eq(items.id, id)))[0]?.state;

describe("the owner's AI and the customer's price", () => {
  it("confirms a booking at the business's price, never one whose price the customer set; the owner can", async () => {
    const s = await setup();
    // Time yes: a fixed-price booking, priced by the catalogue.
    const ours = await s.book(s.svc.fixed);
    await s.caps.transitionItem(ai, { item_id: ours.view.item.id, event: "confirm" });
    expect(await stateOf(s.db, ours.view.item.id)).toBe("confirmed");
    // Money no: a service priced "from", with the customer's figure in it.
    const theirs = await s.book(s.svc.from, { totalPrice: EUR(100) });
    for (const caller of [ai, mcp]) {
      const e = await refusal(s.caps.transitionItem(caller, { item_id: theirs.view.item.id, event: "confirm" }));
      expect(e.code).toBe("guard_failed");
      expect(e.details).toEqual({ guard: "business_priced", draft_for_owner: true });
      expect(e.message).toContain("only the owner can confirm or accept it");
      expect(e.message).toContain("internal: true");
    }
    expect(await stateOf(s.db, theirs.view.item.id)).toBe("requested");
    await s.caps.transitionItem(person, { item_id: theirs.view.item.id, event: "confirm" });
    expect(await stateOf(s.db, theirs.view.item.id)).toBe("confirmed");
  });

  it("never accepts an order with a line the customer priced; the owner can", async () => {
    const s = await setup();
    const order = await s.caps.createOrder(customer, {
      payload: { orderedItem: [{ name: "Child seat", quantity: 1, price: EUR(100) }], totalPrice: EUR(100) },
    });
    const e = await refusal(s.caps.transitionItem(ai, { item_id: order.view.item.id, event: "accept" }));
    expect(e.details).toMatchObject({ guard: "business_priced", draft_for_owner: true });
    await s.caps.transitionItem(person, { item_id: order.view.item.id, event: "accept" });
    expect(await stateOf(s.db, order.view.item.id)).not.toBe("received");
  });

  it("sends no quote, and proposes a time only at the catalogue's price", async () => {
    const s = await setup();
    const q = await s.caps.requestQuote(customer, {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
      contact: { email: "rita@example.com" },
    });
    const quote = { totalPrice: EUR(31_000), validThrough: "2026-09-28T18:00:00Z" };
    const e = await refusal(s.caps.transitionItem(ai, { item_id: q.view.item.id, event: "quote", input: quote }));
    expect(e.code).toBe("not_allowed");
    expect(e.details).toMatchObject({ reason: "owner_money", draft_for_owner: true });
    await s.caps.transitionItem(person, { item_id: q.view.item.id, event: "quote", input: quote });
    expect(await stateOf(s.db, q.view.item.id)).toBe("quoted");

    const b = await s.book(s.svc.fixed);
    const later = { startTime: "2026-09-23T10:00:00Z", endTime: "2026-09-23T11:00:00Z" };
    const cheaper = await refusal(
      s.caps.transitionItem(ai, {
        item_id: b.view.item.id,
        event: "propose",
        input: { ...later, totalPrice: EUR(5_000) },
      }),
    );
    expect(cheaper.code).toBe("not_allowed");
    expect(cheaper.fields?.[0]?.path).toBe("input.totalPrice");
    // The catalogue's own price, or none at all, is only a time.
    await s.caps.transitionItem(ai, {
      item_id: b.view.item.id,
      event: "propose",
      input: { ...later, totalPrice: EUR(10_000) },
    });
    expect(await stateOf(s.db, b.view.item.id)).toBe("proposed");
    const c = await s.book(s.svc.fixed);
    await s.caps.transitionItem(ai, { item_id: c.view.item.id, event: "propose", input: later });
    expect(await stateOf(s.db, c.view.item.id)).toBe("proposed");
  });
});

describe("the owner's AI and the catalogue", () => {
  it("changes no price, and a price sent back as it is changes nothing", async () => {
    const s = await setup();
    for (const caller of [ai, mcp]) {
      const e = await refusal(
        s.caps.setup.updateService(caller, {
          service_id: s.svc.fixed,
          price: { model: "fixed", value: 9_000, currency: "EUR" },
        }),
      );
      expect(e.code).toBe("not_allowed");
      expect(e.details).toEqual({ reason: "owner_money", draft_for_owner: true });
      expect(e.fields?.[0]?.path).toBe("price");
      const p = await refusal(s.caps.setup.updateProduct(caller, { product_id: s.product, price: EUR(1) }));
      expect(p.code).toBe("not_allowed");
      // Per person is a price too.
      const per = await refusal(
        s.caps.setup.updateService(caller, {
          service_id: s.svc.fixed,
          price: { model: "fixed", value: 10_000, currency: "EUR", per: "person" },
        }),
      );
      expect(per.code).toBe("not_allowed");
    }
    // Time and words are the AI's: the same price back beside them is no change.
    const renamed = await s.caps.setup.updateService(ai, {
      service_id: s.svc.fixed,
      name: "Full service (90 point check)",
      duration_min: 90,
      price: { model: "fixed", value: 10_000, currency: "EUR" },
    });
    expect(renamed).toMatchObject({ durationMin: 90, price: { value: 10_000 } });
    // The owner changes it.
    const cheaper = await s.caps.setup.updateProduct(person, { product_id: s.product, price: EUR(14_000) });
    expect(cheaper.price).toEqual(EUR(14_000));
  });

  it("saves what it adds with a price unpublished, and only the owner publishes it", async () => {
    const s = await setup();
    const product = await s.caps.setup.createProduct(ai, { name: "Bell", price: EUR(900), active: true });
    expect(product.active).toBe(0);
    const service = await s.caps.setup.createService(ai, {
      name: "Fitting",
      duration_min: 30,
      buffer_before_min: 0,
      buffer_after_min: 0,
      capacity: 1,
      granularity_min: 15,
      price: { model: "fixed", value: 3_000, currency: "EUR" },
      active: true,
      sort: 0,
    });
    expect(service.active).toBe(0);
    // Without a price there is nothing to check: it is bookable at once.
    const chat = await s.caps.setup.createService(ai, {
      name: "Chat",
      duration_min: 15,
      buffer_before_min: 0,
      buffer_after_min: 0,
      capacity: 1,
      granularity_min: 15,
      active: true,
      sort: 0,
    });
    expect(chat.active).toBe(1);
    const e = await refusal(s.caps.setup.updateProduct(ai, { product_id: product.id, active: true }));
    expect(e.fields?.[0]?.path).toBe("active");
    await refusal(s.caps.setup.updateService(mcp, { service_id: service.id, active: true }));
    // Archiving is not money.
    await s.caps.setup.archiveService(ai, { service_id: chat.id });
    // The owner publishes.
    expect((await s.caps.setup.updateProduct(person, { product_id: product.id, active: true })).active).toBe(1);
    expect((await s.caps.setup.createProduct(person, { name: "Horn", price: EUR(900), active: true })).active).toBe(1);
  });

  it("neither changes the currency nor connects or disconnects a feed", async () => {
    const s = await setup();
    const e = await refusal(s.caps.setup.updateProfile(ai, { currency: "USD" }));
    expect(e.fields?.[0]?.path).toBe("currency");
    // The same currency, beside a new name, is no change.
    expect(await s.caps.setup.updateProfile(ai, { name: "Oficina Maré Lda", currency: "eur" })).toMatchObject({
      currency: "EUR",
    });
    const feed = await refusal(s.caps.feeds.add(mcp, { url: "https://shop.example.com/feed.xml" }));
    expect(feed.details).toMatchObject({ reason: "owner_money", draft_for_owner: true });
    const added = await s.caps.feeds.add(person, { url: "https://shop.example.com/feed.xml" });
    await refusal(s.caps.feeds.remove(ai, added.id));
    await s.caps.feeds.importNow(ai, added.id);
    expect((await s.caps.setup.updateProfile(person, { currency: "USD" })).currency).toBe("USD");
  });
});
