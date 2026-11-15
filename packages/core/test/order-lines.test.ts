import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { menuFieldsSchema } from "../src/menu/schema";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, products, services } from "../src/schema/tables";
import { type Caller, rowToItem, WriteError } from "../src/write/index";
import { aProduct, makeClient, openAllWeek, resetTables, withClient } from "./harness";

/**
 * An assistant's order is for what the business sells, at its prices, in its currency (ADR-048): each line
 * names one of its products, on sale at a fixed price; a price or a total it sends is the business's, unless
 * the business takes a price of the customer's own (price counters), and is never in another currency. Each
 * line may leave its name and price, and the order its total, to the catalogue. The business itself, its
 * keys and its AI still write down any order.
 */
const T0 = Date.parse("2026-11-16T09:00:00Z");
const EUR = (value: number) => ({ value, currency: "EUR" });
const AUD = (value: number) => ({ value, currency: "AUD" });

const at = (kind: Caller["actor"]["kind"], channel: Caller["actor"]["channel"], extra: Partial<Caller> = {}) =>
  ({
    actor: { kind, id: `${kind}:1`, channel },
    tier: "verified_principal",
    sandbox: false,
    now: () => T0,
    ...extra,
  }) as Caller;
const owner = at("owner", "owner_ui", {
  principal: { via: "session", id: "s1", name: "owner", scopes: ["*"], userId: "u1" },
});
const ownerAi = at("owner_ai", "mcp_owner", {
  actsAs: "owner",
  principal: { via: "oauth", id: "client_1", name: "Assistant", scopes: ["*"], userId: "u1" },
});
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

async function setup(doc: Record<string, unknown> = {}) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm
    .insert(business)
    .values({ id: "self", name: "Oficina Maré", timezone: "UTC", currency: "EUR", createdAt: T0, updatedAt: T0 });
  // Without the confirm step answered: an assistant's order is refused before any summary is shown.
  const caps = withClient(new Capabilities(db));
  await caps.updateSettings(owner, {
    doc: { business: { name: "Oficina Maré" }, commerce: { legal: { legalName: "Oficina Maré Lda" } }, ...doc },
  });
  const saddle = await aProduct(caps, { name: "Saddle", value: 15_000, sku: "SD-1" });
  const chain = await aProduct(caps, { name: "Chain", value: 1_850, sku: "CH-9" });
  const count = async () => (await db.orm.select({ id: items.id }).from(items)).length;
  return { db, caps, saddle, chain, count };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function refused(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

const order = (s: Setup, payload: Record<string, unknown>, extra: Record<string, unknown> = {}, caller = agent) =>
  s.caps.createOrder(caller, { payload, ...extra } as never);

describe("an assistant's order line", () => {
  it("names one of our products: none named, or one we do not have, is refused naming each line", async () => {
    const s = await setup();
    const missing = await refused(
      order(s, {
        orderedItem: [
          { productId: s.chain, quantity: 1 },
          { name: "Child seat", quantity: 1 },
        ],
      }),
    );
    expect(missing).toMatchObject({ code: "invalid_input", status: 422, details: { reason: "product_missing" } });
    expect(missing.message).toBe(
      "Each line of an order names one of our products, by its productId from list_products (or its sku). Nothing was written.",
    );
    expect(missing.fields).toEqual([
      {
        path: "payload.orderedItem.1.productId",
        problem: "missing",
        message: "one of our products, by its id from list_products",
      },
    ]);
    const byId = await refused(order(s, { orderedItem: [{ productId: "no-such-product", quantity: 1 }] }));
    expect(byId.details).toEqual({ reason: "unknown_product" });
    expect(byId.message).toBe(
      "We sell no product by that id or sku: name one of ours on each line, by its productId from list_products. Nothing was written.",
    );
    expect(byId.fields).toEqual([
      { path: "payload.orderedItem.0.productId", problem: "invalid", message: "no such product here" },
    ]);
    // By sku, with a line naming nothing beside it: both named, in the order they came.
    const bySku = await refused(
      order(s, {
        orderedItem: [
          { name: "Bell", quantity: 1 },
          { sku: "NOPE-1", quantity: 1 },
        ],
      }),
    );
    expect(bySku.details).toEqual({ reason: "unknown_product" });
    expect(bySku.fields).toEqual([
      {
        path: "payload.orderedItem.0.productId",
        problem: "missing",
        message: "one of our products, by its id from list_products",
      },
      { path: "payload.orderedItem.1.sku", problem: "invalid", message: "no such product here" },
    ]);
    expect(await s.count()).toBe(0);
  });

  it("is for a product on sale: one archived, or past its last day to order, is refused", async () => {
    const s = await setup();
    await s.db.orm.update(products).set({ active: 0 }).where(eq(products.id, s.saddle));
    await s.db.orm
      .update(products)
      .set({ availableUntil: T0 - 1 })
      .where(eq(products.id, s.chain));
    // Something else is on sale, so orders are still taken.
    await aProduct(s.caps, { name: "Bell", value: 900 });
    for (const productId of [s.saddle, s.chain]) {
      const e = await refused(order(s, { orderedItem: [{ productId, quantity: 1 }] }));
      expect(e.details).toEqual({ reason: "not_on_sale" });
      expect(e.message).toBe(
        "A line is for a product we no longer sell, so it cannot be ordered. Nothing was written.",
      );
      expect(e.fields).toEqual([{ path: "payload.orderedItem.0", problem: "invalid", message: "not on sale" }]);
    }
  });

  it("is for a product at a fixed price: one priced from, as a range or on request is asked about instead", async () => {
    const s = await setup();
    const cake = await s.caps.setup.createProduct(owner, { name: "Wedding cake", price_model: "quote", active: true });
    const frame = await s.caps.setup.createProduct(owner, {
      name: "Custom frame",
      price: EUR(9_000),
      price_model: "from",
      active: true,
    });
    const wheel = await s.caps.setup.createProduct(owner, {
      name: "Wheel build",
      price: EUR(20_000),
      price_model: "range",
      price_max: EUR(40_000),
      active: true,
    } as never);
    const one = await refused(order(s, { orderedItem: [{ productId: cake.id, quantity: 1 }] }));
    expect(one.details).toEqual({ reason: "not_priced" });
    expect(one.message).toBe(
      "We price Wedding cake on request, so it is not ordered here: ask for a price with request_quote (itemOffered.productId). Nothing was written.",
    );
    const three = await refused(
      order(s, {
        orderedItem: [
          { productId: s.chain, quantity: 1 },
          { productId: frame.id, quantity: 1 },
          { productId: wheel.id, quantity: 1 },
          { productId: cake.id, quantity: 1 },
        ],
      }),
    );
    expect(three.message).toBe(
      "We price Custom frame, Wheel build and Wedding cake on request, so they are not ordered here: ask for a price with request_quote (itemOffered.productId). Nothing was written.",
    );
    expect(three.fields?.map((f) => f.path)).toEqual([
      "payload.orderedItem.1.productId",
      "payload.orderedItem.2.productId",
      "payload.orderedItem.3.productId",
    ]);
    expect(three.fields?.[0]).toMatchObject({
      problem: "invalid",
      message: "priced on request: ask with request_quote",
    });
  });
});

describe("a price an assistant's order carries", () => {
  it("is in our currency, a line's or the total, whether or not the business takes a price of the customer's own", async () => {
    for (const counters of [false, true]) {
      const s = await setup({ negotiation: { priceCounters: counters } });
      const line = await refused(order(s, { orderedItem: [{ productId: s.saddle, quantity: 1, price: AUD(15_000) }] }));
      expect(line.details).toEqual({ reason: "currency_not_ours", currency: "EUR" });
      expect(line.message).toBe(
        "Our prices are in EUR: send each price and the total in EUR, or leave them out and we price the order. Nothing was written.",
      );
      expect(line.fields).toEqual([
        {
          path: "payload.orderedItem.0.price.currency",
          problem: "invalid",
          message: "must be EUR, the currency of our prices",
        },
      ]);
      const total = await refused(
        order(s, { orderedItem: [{ productId: s.saddle, quantity: 1 }], totalPrice: AUD(15_000) }),
      );
      expect(total.fields).toEqual([
        { path: "payload.totalPrice.currency", problem: "invalid", message: "must be EUR, the currency of our prices" },
      ]);
      expect(await s.count()).toBe(0);
    }
  });

  it("is ours: another is refused, naming ours, while the business takes no price of the customer's own", async () => {
    const s = await setup();
    const e = await refused(order(s, { orderedItem: [{ productId: s.saddle, quantity: 1, price: EUR(100) }] }));
    expect(e).toMatchObject({ code: "invalid_input", status: 422 });
    expect(e.details).toEqual({
      reason: "price_not_ours",
      prices: [{ line: 0, product_id: s.saddle, price: EUR(15_000) }],
    });
    expect(e.message).toBe(
      "A price on this order is not ours: Saddle is €150.00 each. Send our prices, or leave price out and we price each line. Nothing was written.",
    );
    expect(e.fields).toEqual([{ path: "payload.orderedItem.0.price", problem: "invalid", message: "ours is €150.00" }]);
    // The lines at our prices and a total that is not ours.
    const total = await refused(
      order(s, {
        orderedItem: [
          { productId: s.saddle, quantity: 1, price: EUR(15_000) },
          { sku: "CH-9", quantity: 2 },
        ],
        totalPrice: EUR(15_000),
      }),
    );
    expect(total.details).toEqual({ reason: "total_not_ours", total: EUR(18_700) });
    expect(total.message).toBe(
      "This order comes to €187.00: send that as totalPrice, or leave totalPrice out and we work it out. Nothing was written.",
    );
    expect(total.fields).toEqual([{ path: "payload.totalPrice", problem: "invalid", message: "ours is €187.00" }]);
    expect(await s.count()).toBe(0);
  });

  it("is the customer's offer where the business takes one: kept beside ours, in our currency", async () => {
    const s = await setup({ negotiation: { priceCounters: true } });
    const asked = await refused(
      order(s, { orderedItem: [{ productId: s.saddle, quantity: 1, price: EUR(12_000) }], totalPrice: EUR(12_000) }),
    );
    expect(asked.code).toBe("confirm_terms");
    const made = await order(
      s,
      { orderedItem: [{ productId: s.saddle, quantity: 1, price: EUR(12_000) }], totalPrice: EUR(12_000) },
      { terms_sha: (asked.details as { terms_sha: string }).terms_sha },
    );
    expect(made.view.item.payload).toMatchObject({
      orderedItem: [{ productId: s.saddle, price: EUR(15_000), customerStatedPrice: EUR(12_000) }],
      totalPrice: EUR(15_000),
      customerStatedPrice: EUR(12_000),
    });
  });

  it("is refused the same where the business sells only to businesses, with no confirm step", async () => {
    const s = await setup({ commerce: { customers: "businesses" } });
    const e = await refused(order(s, { orderedItem: [{ productId: s.saddle, quantity: 1, price: EUR(100) }] }));
    expect(e.details).toMatchObject({ reason: "price_not_ours" });
    const made = await order(s, { orderedItem: [{ productId: s.saddle, quantity: 1 }] });
    expect(made.view.item.payload).toMatchObject({ totalPrice: EUR(15_000) });
  });
});

describe("prices left out", () => {
  it("are the catalogue's: the summary to confirm says them, and the order written has its names, prices and total", async () => {
    const s = await setup();
    const asked = await refused(
      order(s, {
        orderedItem: [
          { productId: s.saddle, quantity: 1 },
          { sku: "CH-9", quantity: 2 },
        ],
      }),
    );
    expect(asked.code).toBe("confirm_terms");
    const d = asked.details as { summary: string; terms_sha: string };
    expect(d.summary).toContain("1 × Saddle — €150.00; 2 × Chain — €37.00. Total €187.00.");
    const made = await order(
      s,
      {
        orderedItem: [
          { productId: s.saddle, quantity: 1 },
          { sku: "CH-9", quantity: 2 },
        ],
      },
      { terms_sha: d.terms_sha },
    );
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, made.view.item.id));
    const written = rowToItem(row as typeof items.$inferSelect).payload;
    expect(written).toMatchObject({
      orderedItem: [
        { productId: s.saddle, sku: "SD-1", name: "Saddle", quantity: 1, price: EUR(15_000) },
        { productId: s.chain, sku: "CH-9", name: "Chain", quantity: 2, price: EUR(1_850) },
      ],
      totalPrice: EUR(18_700),
    });
    expect(written).not.toHaveProperty("customerStatedPrice");
  });

  it("are a menu item's with its options, from the menu", async () => {
    const s = await setup({ commerce: { customers: "businesses" } });
    const pizza = await aProduct(s.caps, { name: "Pizza", value: 1_000 });
    await s.caps.food.setMenuItem(owner, {
      product_id: pizza,
      menu: menuFieldsSchema.parse({
        section: "pizzas",
        optionGroups: [
          {
            id: "size",
            name: "Size",
            min: 1,
            max: 1,
            choices: [
              { id: "small", name: "Small", default: true },
              { id: "large", name: "Large", priceDelta: 400 },
            ],
          },
        ],
      }),
    });
    const made = await order(s, {
      orderedItem: [{ productId: pizza, quantity: 2, options: [{ groupId: "size", choiceId: "large" }] }],
    });
    expect(made.view.item.payload).toMatchObject({
      orderedItem: [{ name: "Pizza", price: EUR(1_400), options: [{ name: "Large" }] }],
      totalPrice: EUR(2_800),
    });
  });

  it("are the rewarded customer's own: the list price sent is not a price of theirs", async () => {
    const s = await setup();
    const svc = ulid();
    await s.db.orm.insert(services).values({
      id: svc,
      name: "Full service",
      durationMin: 60,
      price: { model: "fixed", value: 5_000, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    });
    await openAllWeek(s.db);
    await s.caps.updateSettings(owner, {
      doc: { negotiation: { rewards: { chains: { if: { fn: "customer_known" }, pct: 10, only: [s.chain] } } } },
    });
    // A customer the business knows: one booking here, done.
    const booking = {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-11-18T10:00:00Z",
        endTime: "2026-11-18T11:00:00Z",
      },
      contact: { name: "Rita", email: "rita@example.com" },
    };
    const confirm = await refused(s.caps.createBooking(agent, booking as never));
    const first = await s.caps.createBooking(agent, {
      ...booking,
      terms_sha: (confirm.details as { terms_sha: string }).terms_sha,
    } as never);
    await s.caps.transitionItem(owner, { item_id: first.view.item.id, event: "confirm" });
    await s.caps.transitionItem(owner, { item_id: first.view.item.id, event: "complete" });
    const known: Caller = { ...agent, actor: { ...agent.actor, partyId: first.view.item.partyId } };
    const lines = { orderedItem: [{ productId: s.chain, quantity: 2, price: EUR(1_850) }], totalPrice: EUR(3_700) };
    const asked = await refused(order(s, lines, {}, known));
    expect(asked.code).toBe("confirm_terms");
    const made = await order(s, lines, { terms_sha: (asked.details as { terms_sha: string }).terms_sha }, known);
    expect(made.view.item.payload).toMatchObject({
      orderedItem: [{ productId: s.chain, price: EUR(1_665), listPrice: EUR(1_850) }],
      totalPrice: EUR(3_330),
      personalised: { listPrice: EUR(3_700) },
    });
    expect(made.view.item.payload).not.toHaveProperty("customerStatedPrice");
  });
});

describe("the order that came with a made-up line", () => {
  it("is refused as an order the business does not take, and with a product on sale as a line naming none", async () => {
    const line = { name: "audit-fixturex", quantity: 1, price: AUD(1) };
    const empty = await setup();
    await empty.db.orm.delete(products);
    const none = await refused(order(empty, { orderedItem: [line], totalPrice: AUD(1) }));
    expect(none.details).toEqual({ reason: "order_not_offered", item_type: "order", item_types: ["message"] });
    const s = await setup();
    const named = await refused(order(s, { orderedItem: [line], totalPrice: AUD(1) }));
    expect(named.details).toEqual({ reason: "product_missing" });
  });
});

describe("the business's own orders", () => {
  it("are written as they are: the owner's AI's line naming no product waits for a person; a key's is kept as sent", async () => {
    const s = await setup();
    const line = { name: "Child seat", quantity: 1, price: EUR(100) };
    const ai = await order(s, { orderedItem: [line], totalPrice: EUR(100) }, {}, ownerAi);
    expect(ai.view.item.payload).toMatchObject({ orderedItem: [line], totalPrice: EUR(100) });
    const [event] = await s.db.client
      .query({
        sql: "SELECT json_extract(meta, '$.unpriced') FROM item_events WHERE item_id = ? AND seq = 1",
        params: [ai.view.item.id],
        method: "all",
      })
      .then((r) => r.rows);
    expect(Number(event?.[0])).toBe(1);
    const key = await order(s, { orderedItem: [line], totalPrice: EUR(100) }, {}, integration);
    expect(key.view.item.payload).toMatchObject({ orderedItem: [line], totalPrice: EUR(100) });
  });
});
