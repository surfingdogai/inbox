import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { buildRuleContext } from "../src/rules/engine";
import { PRESETS } from "../src/rules/presets";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { availabilityRules, business, itemEvents, items, products, rules, services } from "../src/schema/tables";
import type { Caller } from "../src/write/index";
import { createItem } from "../src/write/index";
import { rowToItem } from "../src/write/views";
import { makeClient, resetTables } from "./harness";

/**
 * The business sets its prices (ADR-018 §3.1–3.2, Tiago 23 September 2026: "Always the business"). An
 * assistant that books a €100 appointment at €1, or orders a €150 product at €1, gets the business's
 * price; what it wrote is kept for the owner to read and no rule reads it. Catalogue lines and
 * fixed-price services only: a custom line or a service priced `from` stays as written.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const EUR = (value: number) => ({ value, currency: "EUR" });
const agent: Caller = {
  actor: { kind: "customer_agent", id: "anon:agent", channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup(vertical?: keyof typeof PRESETS) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm
    .insert(business)
    .values({ id: "self", name: "Oficina Maré", timezone: "UTC", currency: "EUR", createdAt: T0, updatedAt: T0 });
  const svc = { big: ulid(), small: ulid(), from: ulid(), bare: ulid() };
  const service = (id: string, name: string, price: typeof services.$inferInsert.price) => ({
    id,
    name,
    durationMin: 60,
    capacity: 1,
    granularityMin: 30,
    price,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm
    .insert(services)
    .values([
      service(svc.big, "Full service", { model: "fixed", value: 10_000, currency: "EUR" }),
      service(svc.small, "Puncture repair", { model: "fixed", value: 3_000 }),
      service(svc.from, "Wheel truing", { model: "from", value: 2_000, currency: "EUR" }),
      service(svc.bare, "Chat", null),
    ]);
  const prod = { saddle: ulid(), chain: ulid() };
  await db.orm.insert(products).values([
    { id: prod.saddle, sku: "SD-1", name: "Saddle", price: EUR(15_000), createdAt: T0, updatedAt: T0 },
    {
      id: prod.chain,
      sku: "CH-9",
      name: "Chain",
      price: { value: 1_850, currency: "eur" },
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await db.orm
    .insert(availabilityRules)
    .values({ id: ulid(), kind: "open", weekly: { tue: [["09:00", "18:00"]] }, createdAt: T0 });
  if (vertical) {
    await db.orm.insert(rules).values(
      (PRESETS[vertical] ?? []).map((p) => ({
        id: ulid(),
        name: p.name,
        priority: p.priority,
        enabled: 1,
        definition: p.definition,
        createdAt: T0,
        updatedAt: T0,
      })),
    );
  }
  const mail = logMailOut();
  const runner = createRunner({ mailOut: mail });
  const drain = async () => {
    for (let i = 0; i < 5; i++) if ((await runner.runDue(db, { now: T0 + i })).claimed === 0) break;
  };
  return { db, svc, prod, caps: new Capabilities(db), mail, drain };
}

const tuesday = (hour: number) => ({
  startTime: `2026-09-22T${String(hour).padStart(2, "0")}:00:00Z`,
  endTime: `2026-09-22T${String(hour + 1).padStart(2, "0")}:00:00Z`,
});

async function row(db: Awaited<ReturnType<typeof setup>>["db"], id: string) {
  const [r] = await db.orm.select().from(items).where(eq(items.id, id));
  if (!r) throw new Error("no item");
  return { ...r, item: rowToItem(r) };
}

describe("the business sets its prices", () => {
  it("books a €100 service at €100 when the assistant says €1, and the €50 preset leaves it to a person", async () => {
    const { db, svc, caps, drain } = await setup("appointments");
    const r = await caps.createBooking(agent, {
      payload: { reservationFor: { serviceId: svc.big, name: "Full service" }, ...tuesday(9), totalPrice: EUR(100) },
    });
    // The answer already carries the business's price, and says it in the business's words.
    expect(r.view.item.payload).toMatchObject({ totalPrice: EUR(10_000), customerStatedPrice: EUR(100) });
    expect(r.view.human).toContain("Our price is €100.00.");
    await drain();
    const booked = await row(db, r.view.item.id);
    expect(booked.state).toBe("requested");
    expect(booked.item.flags.needsHuman).toBe(true);
    expect(booked.item.payload).toMatchObject({ totalPrice: EUR(10_000), customerStatedPrice: EUR(100) });
    const events = await db.orm
      .select({ event: itemEvents.event })
      .from(itemEvents)
      .where(eq(itemEvents.itemId, r.view.item.id));
    expect(events.map((e) => e.event)).not.toContain("confirm");

    // Without a price at all, the booking gets the business's, and still no automatic yes at €100.
    const bare = await caps.createBooking(agent, {
      payload: { reservationFor: { serviceId: svc.big, name: "Full service" }, ...tuesday(11) },
    });
    expect(bare.view.item.payload).toMatchObject({ totalPrice: EUR(10_000) });
    expect(bare.view.item.payload).not.toHaveProperty("customerStatedPrice");
    await drain();
    expect((await row(db, bare.view.item.id)).state).toBe("requested");
  });

  it("confirms a €30 service at €30 under the €50 preset, whatever the assistant said", async () => {
    const { db, svc, caps, drain } = await setup("appointments");
    const r = await caps.createBooking(agent, {
      payload: {
        reservationFor: { serviceId: svc.small, name: "Puncture repair" },
        ...tuesday(9),
        totalPrice: { value: 100, currency: "usd" },
      },
    });
    await drain();
    const booked = await row(db, r.view.item.id);
    expect(booked.state).toBe("confirmed");
    // A fixed price with no currency is in the business's currency.
    expect(booked.item.payload).toMatchObject({
      totalPrice: EUR(3_000),
      customerStatedPrice: { value: 100, currency: "USD" },
    });
  });

  it("orders a €150 product at €150 when the assistant says €1, and asks a person when the real total is large", async () => {
    const { db, prod, caps, drain } = await setup("shop");
    const one = await caps.createOrder(agent, {
      payload: {
        orderedItem: [{ productId: prod.saddle, name: "Saddle", quantity: 1, price: EUR(100) }],
        totalPrice: EUR(100),
      },
    });
    expect(one.view.item.payload).toMatchObject({
      orderedItem: [{ productId: prod.saddle, price: EUR(15_000), customerStatedPrice: EUR(100) }],
      totalPrice: EUR(15_000),
      customerStatedPrice: EUR(100),
    });
    // By sku, two of them: the business's total is €300, over the shop's €200 for an automatic yes.
    const two = await caps.createOrder(agent, {
      payload: { orderedItem: [{ sku: "SD-1", name: "Saddle", quantity: 2, price: EUR(100) }], totalPrice: EUR(200) },
    });
    expect(two.view.item.payload).toMatchObject({ totalPrice: EUR(30_000), customerStatedPrice: EUR(200) });
    await drain();
    // €150 is within the shop's limit, so the order is accepted — at €150.
    const accepted = await row(db, one.view.item.id);
    expect(accepted.state).toBe("awaiting_payment");
    expect(accepted.item.payload).toMatchObject({ totalPrice: EUR(15_000) });
    const large = await row(db, two.view.item.id);
    expect(large.state).toBe("received");
    expect(large.item.flags).toMatchObject({ needsHuman: true, priority: 2 });
  });

  it("shows the owner the price the assistant stated, beside the business's own", async () => {
    const { svc, caps, mail, drain } = await setup();
    await caps.updateSettings(owner, { doc: { notifications: { ownerEmail: "hello@oficinamare.pt" } } });
    const r = await caps.createBooking(agent, {
      payload: { reservationFor: { serviceId: svc.big, name: "Full service" }, ...tuesday(9), totalPrice: EUR(100) },
    });
    const detail = await caps.getItem(owner, { item_id: r.view.item.id });
    expect(detail.item.payload).toMatchObject({ totalPrice: EUR(10_000), customerStatedPrice: EUR(100) });
    expect(detail.human).toContain("The customer's assistant suggested €1.00; your price is €100.00.");
    await drain();
    expect(mail.sent.find((m) => m.to[0] === "hello@oficinamare.pt")?.text).toContain(
      "The customer's assistant suggested €1.00; your price is €100.00.",
    );
    // A matching price is nothing to point out.
    const same = await caps.createBooking(agent, {
      payload: {
        reservationFor: { serviceId: svc.big, name: "Full service" },
        ...tuesday(11),
        totalPrice: EUR(10_000),
      },
    });
    expect(same.view.item.payload).not.toHaveProperty("customerStatedPrice");
    expect((await caps.getItem(owner, { item_id: same.view.item.id })).human).not.toContain("suggested");
    expect(same.view.human).not.toContain("Our price");
  });

  it("never lets a rule read the price the assistant stated", async () => {
    const { db, prod, caps, drain } = await setup();
    await db.orm.insert(rules).values({
      id: ulid(),
      name: "Anything the customer priced",
      priority: 100,
      enabled: 1,
      definition: {
        on: ["item.created"],
        if: { path: "item.payload.customerStatedPrice", op: "exists" },
        actions: [{ action: "transition", event: "accept" }],
      },
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await caps.createOrder(agent, {
      payload: {
        orderedItem: [{ productId: prod.chain, name: "Chain", quantity: 1, price: EUR(1) }],
        totalPrice: EUR(1),
      },
    });
    await drain();
    const placed = await row(db, r.view.item.id);
    expect(placed.state).toBe("received");
    expect(placed.item.payload).toMatchObject({ customerStatedPrice: EUR(1) });
    const [create] = await db.orm.select().from(itemEvents).where(eq(itemEvents.itemId, r.view.item.id));
    if (!create) throw new Error("no create event");
    const ctx = await buildRuleContext(db, placed.item, create, T0);
    expect(JSON.stringify(ctx.item)).not.toContain("customerStatedPrice");
    expect(ctx.item).toMatchObject({ payload: { totalPrice: EUR(1_850) } });
  });

  it("keeps custom lines, services priced `from`, and a request's own business fields as today", async () => {
    const { db, svc, prod, caps } = await setup();
    // A line naming no product the business has keeps its price, for a person to price.
    const custom = await caps.createOrder(agent, {
      payload: { orderedItem: [{ name: "Child seat", quantity: 1, price: EUR(100) }], totalPrice: EUR(100) },
    });
    expect(custom.view.item.payload).toEqual({
      orderedItem: [{ name: "Child seat", quantity: 1, price: EUR(100) }],
      totalPrice: EUR(100),
    });
    // With a catalogue line beside it, the catalogue line is the business's and the total follows.
    const mixed = await caps.createOrder(agent, {
      payload: {
        orderedItem: [
          { sku: "CH-9", name: "Chain", quantity: 2, price: EUR(1) },
          { productId: "no-such-product", name: "Child seat", quantity: 1, price: EUR(100) },
        ],
        totalPrice: EUR(102),
      },
    });
    expect(mixed.view.item.payload).toMatchObject({
      orderedItem: [
        { sku: "CH-9", price: EUR(1_850), customerStatedPrice: EUR(1) },
        { name: "Child seat", price: EUR(100) },
      ],
      totalPrice: EUR(3_800),
      customerStatedPrice: EUR(102),
    });
    expect((mixed.view.item.payload as { orderedItem: object[] }).orderedItem[1]).not.toHaveProperty(
      "customerStatedPrice",
    );
    // A service priced `from`, or with no price, is the business's to price with the customer.
    for (const serviceId of [svc.from, svc.bare]) {
      const b = await caps.createBooking(agent, {
        payload: { reservationFor: { serviceId, name: "Something" }, ...tuesday(9), totalPrice: EUR(100) },
      });
      expect(b.view.item.payload).toMatchObject({ totalPrice: EUR(100) });
      expect(b.view.item.payload).not.toHaveProperty("customerStatedPrice");
    }
    // The stated price is the inbox's to write: one sent in by a customer is not kept.
    const sent = await createItem(db, agent, {
      type: "order",
      payload: {
        orderedItem: [
          { productId: prod.chain, name: "Chain", quantity: 1, price: EUR(1_850), customerStatedPrice: EUR(1) },
        ],
        totalPrice: EUR(1_850),
        customerStatedPrice: EUR(1),
      },
    });
    expect(JSON.stringify(sent.view.item.payload)).not.toContain("customerStatedPrice");
    // Lines in two currencies have no one total: the refusal names the line to fix.
    await expect(
      caps.createOrder(agent, {
        payload: {
          orderedItem: [
            { sku: "CH-9", name: "Chain", quantity: 1, price: EUR(1_850) },
            { name: "Child seat", quantity: 1, price: { value: 100, currency: "USD" } },
          ],
          totalPrice: EUR(1_950),
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      fields: [{ path: "payload.orderedItem.1.price.currency", problem: "invalid" }],
    });
  });

  it("prices only the customer's doors, answers a retry as the first time, and leaves stored items alone", async () => {
    const { db, svc, caps } = await setup();
    const body = {
      payload: { reservationFor: { serviceId: svc.big, name: "Full service" }, ...tuesday(9), totalPrice: EUR(100) },
      idempotency_key: "k-1",
    };
    const first = await caps.createBooking(agent, body);
    const again = await caps.createBooking(agent, body);
    expect(again.replayed).toBe(true);
    expect(again.view.item.payload).toEqual(first.view.item.payload);
    // The business's own writes are the business's price already.
    const own = await createItem(db, owner, { type: "booking", payload: { ...body.payload, ...tuesday(13) } });
    expect(own.view.item.payload).toMatchObject({ totalPrice: EUR(100) });
    expect(own.view.item.payload).not.toHaveProperty("customerStatedPrice");
    // An item stored before this reads back exactly as it was written.
    const id = ulid();
    const payload = {
      reservationFor: { serviceId: svc.big, name: "Full service" },
      ...tuesday(15),
      totalPrice: EUR(100),
    };
    await db.client.batch([
      { sql: "INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('p-old', 'agent', 0, 0)", method: "run" },
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES (?, 'booking', 'requested', 1, 'p-old', 'rest', ?, ?, ?, ?)",
        params: [
          id,
          JSON.stringify(payload),
          JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 }),
          T0,
          T0,
        ],
        method: "run",
      },
    ]);
    const old = await caps.getItem(owner, { item_id: id });
    expect(old.item.payload).toEqual(payload);
    expect(old.human).not.toContain("suggested");
  });

  it("leaves a price the business did not set to a person: no rule confirms or accepts it", async () => {
    const shop = await setup("shop");
    // No productId, a sku the catalogue does not have: the €1 is the customer's, not the business's.
    for (const line of [
      { name: "Saddle", quantity: 1, price: EUR(100) },
      { sku: "sd-1", name: "Saddle", quantity: 1, price: EUR(100) },
    ]) {
      const r = await shop.caps.createOrder(agent, { payload: { orderedItem: [line], totalPrice: EUR(100) } });
      await shop.drain();
      const placed = await row(shop.db, r.view.item.id);
      expect(placed.state).toBe("received");
      expect(placed.item.flags.needsHuman).toBe(true);
      const events = await shop.db.orm
        .select({ event: itemEvents.event, reason: itemEvents.reason })
        .from(itemEvents)
        .where(eq(itemEvents.itemId, r.view.item.id));
      expect(events.map((e) => e.event)).toEqual(["create", "flags"]);
      expect(events[1]?.reason).toContain("a person prices this first");
      // "Try it" says what the run does: a person, not the promise.
      const tried = await shop.caps.setup.testRule(owner, {
        definition: PRESETS.shop?.[0]?.definition as never,
        item_id: r.view.item.id,
      });
      expect(tried.would).toEqual(["flag it for a person"]);
      expect(tried.skipped?.[0]).toContain("so it asks a person to price it first");
      // The owner prices it by accepting it: a person may.
      const accepted = await shop.caps.transitionItem(owner, { item_id: r.view.item.id, event: "accept" });
      expect(accepted.view.item.state).toBe("accepted");
    }
    // The business's own order is the business's price, whatever its lines say.
    const own = await createItem(shop.db, owner, {
      type: "order",
      payload: { orderedItem: [{ name: "Saddle", quantity: 1, price: EUR(100) }], totalPrice: EUR(100) },
    });
    await shop.drain();
    expect((await row(shop.db, own.view.item.id)).state).toBe("awaiting_payment");

    const { db, svc, caps, drain } = await setup("appointments");
    // A service priced `from` with the customer's price in it waits; with no price, it is confirmed as before.
    const priced = await caps.createBooking(agent, {
      payload: { reservationFor: { serviceId: svc.from, name: "Wheel truing" }, ...tuesday(9), totalPrice: EUR(1) },
    });
    const bare = await caps.createBooking(agent, {
      payload: { reservationFor: { serviceId: svc.from, name: "Wheel truing" }, ...tuesday(11) },
    });
    // The list price is for the service as long as it lasts: eight hours of a one-hour €30 service is a person's.
    const long = await caps.createBooking(agent, {
      payload: {
        reservationFor: { serviceId: svc.small, name: "Puncture repair" },
        startTime: "2026-09-22T13:00:00Z",
        endTime: "2026-09-22T18:00:00Z",
      },
    });
    await drain();
    const waiting = await row(db, priced.view.item.id);
    expect(waiting.state).toBe("requested");
    expect(waiting.item.flags.needsHuman).toBe(true);
    expect((await row(db, bare.view.item.id)).state).toBe("confirmed");
    const longRow = await row(db, long.view.item.id);
    expect(longRow.state).toBe("requested");
    expect(longRow.item.flags.needsHuman).toBe(true);
    expect(longRow.item.payload).toMatchObject({ totalPrice: EUR(3_000) });
  });

  it("names what it prices: a cheap id under a dear name is the cheap thing", async () => {
    const { svc, prod, caps } = await setup();
    const order = await caps.createOrder(agent, {
      payload: {
        orderedItem: [{ productId: prod.chain, name: "Saddle", quantity: 1, price: EUR(15_000) }],
        totalPrice: EUR(15_000),
      },
    });
    expect(order.view.item.payload).toMatchObject({
      orderedItem: [{ productId: prod.chain, sku: "CH-9", name: "Chain", price: EUR(1_850) }],
      totalPrice: EUR(1_850),
    });
    expect(order.view.item.subject).toBe("1 × Chain");
    // By sku alone, the line gains the product's id; a productId and a sku naming two products is refused.
    const bySku = await caps.createOrder(agent, {
      payload: {
        orderedItem: [{ sku: "SD-1", name: "Seat", quantity: 1, price: EUR(15_000) }],
        totalPrice: EUR(15_000),
      },
    });
    expect(bySku.view.item.payload).toMatchObject({ orderedItem: [{ productId: prod.saddle, name: "Saddle" }] });
    await expect(
      caps.createOrder(agent, {
        payload: {
          orderedItem: [{ productId: prod.chain, sku: "SD-1", name: "Saddle", quantity: 1, price: EUR(15_000) }],
          totalPrice: EUR(15_000),
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input", fields: [{ path: "payload.orderedItem.0.sku" }] });
    const booking = await caps.createBooking(agent, {
      payload: { reservationFor: { serviceId: svc.small, name: "Full service" }, ...tuesday(9) },
    });
    expect(booking.view.item.payload).toMatchObject({
      reservationFor: { serviceId: svc.small, name: "Puncture repair" },
      totalPrice: EUR(3_000),
    });
    expect(booking.view.item.subject).toBe("Puncture repair");
  });

  it("refuses a total too large to write down, and stores nothing every later read would fail on", async () => {
    const { db, prod, caps } = await setup();
    await expect(
      caps.createOrder(agent, {
        payload: {
          orderedItem: [
            { productId: prod.chain, name: "Chain", quantity: 1, price: EUR(1_850) },
            { productId: prod.saddle, name: "Saddle", quantity: Number.MAX_SAFE_INTEGER, price: EUR(1) },
          ],
          totalPrice: EUR(1),
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input", fields: [{ path: "payload.orderedItem.1.quantity" }] });
    expect(await db.orm.select({ id: items.id }).from(items)).toEqual([]);
  });
});

describe("a price per person (Tiago, 23 September 2026)", () => {
  const lesson = async (db: Awaited<ReturnType<typeof setup>>["db"], per?: "booking" | "person") => {
    const id = ulid();
    await db.orm.insert(services).values({
      id,
      name: "Surf lesson",
      durationMin: 60,
      capacity: 10,
      granularityMin: 30,
      price: { model: "fixed", value: 2_000, currency: "EUR", ...(per ? { per } : {}) },
      createdAt: T0,
      updatedAt: T0,
    });
    return id;
  };

  it("multiplies a per-person price by the party, and keeps a stated price beside it", async () => {
    const { db, caps } = await setup();
    const each = await lesson(db, "person");
    const four = await caps.createBooking(agent, {
      payload: { reservationFor: { serviceId: each, name: "Surf lesson" }, ...tuesday(9), partySize: 4 },
    });
    expect(four.view.item.payload).toMatchObject({ partySize: 4, totalPrice: EUR(8_000) });
    // No party given is one person.
    const one = await caps.createBooking(agent, {
      payload: { reservationFor: { serviceId: each, name: "Surf lesson" }, ...tuesday(11) },
    });
    expect(one.view.item.payload).toMatchObject({ totalPrice: EUR(2_000) });
    // What the assistant said is kept beside the business's total, never as it.
    const stated = await caps.createBooking(agent, {
      payload: {
        reservationFor: { serviceId: each, name: "Surf lesson" },
        ...tuesday(13),
        partySize: 3,
        totalPrice: EUR(2_000),
      },
    });
    expect(stated.view.item.payload).toMatchObject({ totalPrice: EUR(6_000), customerStatedPrice: EUR(2_000) });
  });

  it("leaves a price per booking as it was, whatever the party", async () => {
    const { db, caps } = await setup();
    for (const per of [undefined, "booking"] as const) {
      const whole = await lesson(db, per);
      const r = await caps.createBooking(agent, {
        payload: {
          reservationFor: { serviceId: whole, name: "Surf lesson" },
          ...tuesday(per ? 14 : 9),
          partySize: 4,
        },
      });
      expect(r.view.item.payload).toMatchObject({ partySize: 4, totalPrice: EUR(2_000) });
    }
  });

  it("is set on the service, per booking unless it says per person", async () => {
    const { caps } = await setup();
    const input = {
      name: "Group class",
      duration_min: 60,
      buffer_before_min: 0,
      buffer_after_min: 0,
      capacity: 12,
      granularity_min: 30,
      active: true,
      sort: 0,
    };
    const each = await caps.setup.createService(owner, {
      ...input,
      price: { model: "fixed", value: 1_500, currency: "EUR", per: "person" },
    });
    expect(each.price).toEqual({ model: "fixed", value: 1_500, currency: "EUR", per: "person" });
    const r = await caps.createBooking(agent, {
      payload: { reservationFor: { serviceId: each.id, name: "Group class" }, ...tuesday(10), partySize: 8 },
    });
    expect(r.view.item.payload).toMatchObject({ totalPrice: EUR(12_000) });
    const whole = await caps.setup.createService(owner, {
      ...input,
      name: "Private class",
      price: { model: "fixed", value: 6_000, currency: "EUR" },
    });
    expect(whole.price).not.toHaveProperty("per");
  });
});
