import { createApiKey } from "@surfingdog/adapters";
import { type Db, schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import {
  type FakeSquare,
  type FakeSquareOptions,
  fakeSquare,
  TOKEN,
} from "../../../packages/adapters/test/fixtures/square";
import { createInbox } from "../src/app";
import { confirmed, freshDb, futureDay, nextDay, openWeekdays } from "./harness";

/**
 * Square (ADR-034) end to end, through the doors an owner, a customer's agent and Square use, with a
 * made-up salon in Toronto that charges in Canadian dollars and a kitchen shop in Osaka that sells in
 * yen (`fixtures/square.ts`). Connected with the owner's own access token: Square's closed hours and
 * busy team come off the free times; on Appointments Plus a booking the owner confirms is written into
 * Square under the customer's name and the salon's own number, so Square never texts the customer; on
 * the free plan none is, and the owner is told why; the shelf comes in as the catalogue; an order the
 * owner accepts is paid at the shop's own Square checkout, and marked paid only once Square, asked
 * back, says so. No real Square is called.
 */
const BASE = "https://inbox.lumiere.example.ca";
const SECRET_KEY = "connector-square-test-secret-0123456789";
const DAY = futureDay(7);
const NEXT = nextDay(DAY);

async function setup(opts: FakeSquareOptions & { taxRate?: number } = {}) {
  const db = await freshDb();
  const now = Date.now();
  const serviceId = ulid();
  await db.orm.insert(schema.services).values({
    id: serviceId,
    name: "Haircut",
    durationMin: 45,
    capacity: 1,
    granularityMin: 30,
    createdAt: now,
    updatedAt: now,
  });
  await openWeekdays(db);
  const sq = fakeSquare(opts);
  const osaka = opts.seller === "osaka";
  if (opts.taxRate) sq.taxRate = opts.taxRate;
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    fetchImpl: sq.platform.fetch,
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const integrationKey = (await createApiKey(db, { kind: "integration", name: "Make" })).key;
  const owner = { authorization: `Bearer ${ownerKey}` };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    inbox.app.request(
      new Request(path.startsWith("https://") ? path : `${BASE}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
  const saved = await call(
    "PUT",
    "/v1/owner/settings",
    {
      doc: {
        business: osaka
          ? { name: "Osaka Kitchenware", currency: "USD", timezone: "UTC", languages: ["ja", "en"] }
          : { name: "Salon Lumière", currency: "CAD", timezone: "UTC", languages: ["fr", "en"] },
        email: { fromAddress: "bonjour@lumiere.example.ca" },
        notifications: { ownerEmail: "amelie@lumiere.example.ca", appUrl: BASE },
        directory: { url: "https://lumiere.example.ca" },
      },
    },
    owner,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  return { db, inbox, sq, call, owner, integration: { authorization: `Bearer ${integrationKey}` }, pending, serviceId };
}
type S = Awaited<ReturnType<typeof setup>>;

async function drain(s: S, aheadMs = 0): Promise<void> {
  await Promise.all(s.pending);
  for (const ahead of aheadMs > 0 ? [0, aheadMs] : [0]) {
    let settled = false;
    for (let pass = 0; pass < 30 && !settled; pass++) {
      settled = (await s.inbox.runner.runDue(s.db, { now: Date.now() + ahead })).claimed === 0;
    }
    if (!settled) throw new Error("the outbox never settled");
  }
}

async function connect(s: S, headers = s.owner) {
  return s.call("POST", "/v1/owner/integrations", { kind: "square", values: { access_token: TOKEN } }, headers);
}

async function connected(s: S): Promise<string> {
  const res = await connect(s);
  expect(res.status, await res.clone().text()).toBe(201);
  const view = (await res.json()) as { id: string };
  await drain(s);
  return view.id;
}

async function freeTimes(s: S): Promise<string[]> {
  const res = await s.call(
    "GET",
    `/v1/availability?service_id=${s.serviceId}&from=${DAY}T00:00:00Z&to=${NEXT}T00:00:00Z`,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { slots: { startTime: string }[] }).slots.map((x) => x.startTime.slice(11, 16));
}

async function itemOf(db: Db, id: string) {
  const { rows } = await db.client.query({
    sql: "SELECT state, payload FROM items WHERE id = ?",
    params: [id],
    method: "all",
  });
  return { state: String(rows[0]?.[0]), payload: JSON.parse(String(rows[0]?.[1])) as Record<string, unknown> };
}

async function paymentsOf(s: S, id: string) {
  const res = await s.call("GET", `/v1/owner/items/${id}/payments`, undefined, s.owner);
  expect(res.status).toBe(200);
  return ((await res.json()) as { payments: Record<string, unknown>[] }).payments;
}

/** An order of the customer's for the shampoo, through the public door, accepted by the owner. */
async function acceptedOrder(s: S): Promise<string> {
  const { rows } = await s.db.client.query({
    sql: "SELECT id FROM products WHERE external_id = 'VARARGANSHAMP250'",
    method: "all",
  });
  const productId = String(rows[0]?.[0]);
  const made = await confirmed(
    (r) => s.inbox.app.request(r),
    new Request(`${BASE}/v1/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          orderedItem: [{ productId, name: "Argan shampoo", quantity: 1, price: { value: 2_800, currency: "CAD" } }],
          totalPrice: { value: 2_800, currency: "CAD" },
          delivery: { method: "pickup" },
          notes: "Je passe vers midi.",
        },
        contact: { name: "Amélie Gagnon", email: "amelie.gagnon@example.com", locale: "fr-CA" },
      }),
    }),
  );
  expect(made.status, await made.clone().text()).toBe(201);
  const id = ((await made.json()) as { view: { item: { id: string } } }).view.item.id;
  const accepted = await s.call("POST", `/v1/owner/items/${id}/transitions`, { event: "accept" }, s.owner);
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  return id;
}

function orderOf(sq: FakeSquare) {
  const [order] = [...sq.orders.values()];
  if (!order) throw new Error("no order in Square");
  return order;
}

describe("Square, connected with the owner's own access token", () => {
  it("is checked against Square, sealed, given its own webhook address, and drawn with choosers", async () => {
    const s = await setup();
    const res = await connect(s);
    expect(res.status, await res.clone().text()).toBe(201);
    const text = await res.text();
    const sub = [...s.sq.subscriptions.values()][0];
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(String(sub?.signature_key));
    const view = JSON.parse(text) as {
      account: string;
      mode: string;
      disconnect_note: string | null;
      choices: { key: string; options: { name: string }[] }[];
    };
    expect(view).toMatchObject({ account: "Salon Lumière", mode: "live" });
    expect(view.disconnect_note).toContain("Square Developer Console");
    expect(view.choices.map((c) => [c.key, c.options.map((o) => o.name)])).toEqual([
      ["location", ["Queen Street West", "Danforth"]],
      ["team", ["Whoever is free", "Amélie Tremblay", "Kwame Mensah"]],
    ]);
    expect(String(sub?.notification_url)).toMatch(
      /^https:\/\/inbox\.lumiere\.example\.ca\/v1\/hooks\/square\/[A-Za-z0-9_-]{43}$/,
    );
    const { rows } = await s.db.client.query({
      sql: "SELECT config_enc, config_public FROM connectors",
      method: "all",
    });
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(rows)).not.toContain(String(sub?.signature_key));

    const listed = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as {
      cards: { id: string; status: string; ways: { label: string; status: string }[] }[];
    };
    expect(listed.cards.find((c) => c.id === "square")).toMatchObject({
      status: "ready",
      ways: [
        { label: "Access token", status: "ready" },
        { label: "Sign in with Square", status: "setup" },
      ],
    });
  });

  it("is connected in person only: a key handed to another system is refused before Square is asked", async () => {
    const s = await setup();
    expect((await connect(s, s.integration)).status).toBe(403);
    expect(s.sq.platform.seen).toHaveLength(0);
  });
});

describe("bookings, kept in step with Square", () => {
  it("takes Square's closed hours off the free times, and writes a confirmed booking without a word to the customer", async () => {
    const s = await setup({ appointments: "plus" });
    expect(await freeTimes(s)).toContain("09:00");
    const id = await connected(s);
    await s.call("POST", `/v1/owner/integrations/${id}/sync`, {}, s.owner);
    await drain(s);
    // Square opens at 14:00 (UTC) here: the morning is off, the afternoon stays.
    const free = await freeTimes(s);
    expect(free).not.toContain("09:00");
    expect(free).toContain("14:00");
    expect(free).toContain("15:00");

    const created = await s.call("POST", "/v1/bookings", {
      payload: {
        reservationFor: { serviceId: s.serviceId, name: "Haircut" },
        startTime: `${DAY}T15:00:00Z`,
        endTime: `${DAY}T15:45:00Z`,
      },
      contact: { name: "Nguyễn Thị Lan", email: "lan.nguyen@example.com" },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const itemId = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
    const ok = await s.call("POST", `/v1/owner/items/${itemId}/transitions`, { event: "confirm" }, s.owner);
    expect(ok.status, await ok.clone().text()).toBe(200);
    await drain(s);

    const [made] = [...s.sq.bookings.values()];
    expect(made).toMatchObject({
      start: Date.parse(`${DAY}T15:00:00Z`),
      service: "VARHAIRCUT45MIN0",
      status: "ACCEPTED",
    });
    expect(made?.sellerNote).toContain("Haircut · Nguyễn Thị Lan");
    // The customer of the booking is a record under their name and the salon's own number: the salon's
    // calendar shows who is coming, and Square's texts reach the salon. Their address never went to Square.
    const customer = s.sq.customers.get(String(made?.customer));
    expect(customer).toMatchObject({ given_name: "Nguyễn Thị Lan", phone_number: "+1 416-555-0142" });
    expect(JSON.stringify(s.sq.platform.seen.map((r) => r.body))).not.toContain("lan.nguyen@example.com");
    const view = (await (await s.call("GET", `/v1/owner/integrations/${id}`, undefined, s.owner)).json()) as {
      bookings_written: number;
    };
    expect(view.bookings_written).toBe(1);

    const cancelled = await s.call(
      "POST",
      `/v1/owner/items/${itemId}/transitions`,
      { event: "cancel_by_business" },
      s.owner,
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    await drain(s);
    expect(made?.status).toBe("CANCELLED_BY_SELLER");
  });

  it("on Appointments Free keeps busy times, adds no booking, and tells the owner why in one line", async () => {
    const s = await setup();
    const id = await connected(s);
    const view = (await (await s.call("GET", `/v1/owner/integrations/${id}`, undefined, s.owner)).json()) as {
      capabilities: string[];
      withheld: Record<string, string>;
    };
    expect(view.capabilities).not.toContain("write_bookings");
    expect(view.capabilities).toContain("busy_times");
    expect(view.withheld.write_bookings).toBe(
      "Square adds bookings from an access token on Appointments Plus or Premium only. Busy times still come from Square.",
    );
    expect(await freeTimes(s)).not.toContain("09:00");
    const created = await s.call("POST", "/v1/bookings", {
      payload: {
        reservationFor: { serviceId: s.serviceId, name: "Haircut" },
        startTime: `${DAY}T15:00:00Z`,
        endTime: `${DAY}T15:45:00Z`,
      },
      contact: { name: "Thabo Nkosi", email: "thabo@example.com" },
    });
    const itemId = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
    await s.call("POST", `/v1/owner/items/${itemId}/transitions`, { event: "confirm" }, s.owner);
    await drain(s);
    expect(s.sq.bookings.size).toBe(0);
    expect(s.sq.platform.requests("POST", "https://connect.squareup.com/v2/customers")).toHaveLength(0);
  });
});

describe("an order paid at the salon's own Square checkout", () => {
  it("brings the shelf in, writes the accepted order into Square, and sends Square's own link to pay", async () => {
    const s = await setup();
    await connected(s);
    const { rows } = await s.db.client.query({
      sql: "SELECT external_id, name, price, stock, active FROM products ORDER BY external_id",
      method: "all",
    });
    expect(rows.map((r) => [String(r[0]), String(r[1]), JSON.parse(String(r[2])).value, r[3], Number(r[4])])).toEqual([
      ["VARARGANSHAMP250", "Argan shampoo · 250 ml", 2_800, 7, 1],
      ["VARBEARDOIL30ML0", "Beard oil", 2_200, null, 1],
    ]);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const order = orderOf(s.sq);
    const link = [...s.sq.links.values()][0];
    expect(order.sent).toMatchObject({
      order: {
        location_id: s.sq.location,
        line_items: [{ catalog_object_id: "VARARGANSHAMP250", quantity: "1" }],
        fulfillments: [
          {
            type: "PICKUP",
            pickup_details: {
              recipient: { display_name: "Amélie Gagnon", email_address: "amelie.gagnon@example.com" },
              note: "From your customer: Je passe vers midi.",
            },
          },
        ],
      },
    });
    expect(order.reference).toMatch(/^[0-9A-Z]{26}$/);
    expect(JSON.stringify(order.sent)).not.toMatch(/app_fee/);
    expect(await itemOf(s.db, id)).toMatchObject({ state: "awaiting_payment", payload: { paymentUrl: link?.url } });
    const [pay] = await paymentsOf(s, id);
    expect(pay).toMatchObject({ state: "open", provider: "Square", url: link?.url });
  });

  it("marks it paid only once Square, asked back, says so; keeps ids only; counts a delivery once", async () => {
    const s = await setup();
    await connected(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const order = orderOf(s.sq);

    // A delivery that says COMPLETED for an order Square has unpaid: nothing is marked.
    const lying = await s.sq.event("payment.updated", {
      type: "payment",
      id: "PAYLYING000000000000",
      object: {
        payment: { order_id: order.id, status: "COMPLETED", buyer_email_address: "amelie.gagnon@example.com" },
      },
    });
    const first = await s.call("POST", lying.url, lying.body, lying.headers);
    expect(first.status).toBe(200);
    await drain(s);
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");
    const { rows } = await s.db.client.query({ sql: "SELECT raw FROM connector_events", method: "all" });
    expect(JSON.stringify(rows)).not.toContain("amelie.gagnon");

    const paymentId = s.sq.pay(order.id);
    const paid = await s.sq.event(
      "payment.updated",
      {
        type: "payment",
        id: paymentId,
        object: { payment: { id: paymentId, order_id: order.id, status: "COMPLETED" } },
      },
      { eventId: "evt-paid-1" },
    );
    expect((await s.call("POST", paid.url, paid.body, paid.headers)).status).toBe(200);
    await drain(s);
    expect((await itemOf(s.db, id)).state).toBe("paid");
    const [link] = await paymentsOf(s, id);
    expect(link).toMatchObject({
      state: "paid",
      payment_id: paymentId,
      paid_amount: { value: 2_800, currency: "CAD" },
    });
    const again = await s.call("POST", paid.url, paid.body, paid.headers);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });

    // A signature one character off is refused, and nothing is kept of it.
    const tampered = await s.sq.event(
      "payment.updated",
      { type: "payment", id: paymentId },
      { tamper: true, eventId: "evt-x" },
    );
    expect((await s.call("POST", tampered.url, tampered.body, tampered.headers)).status).toBe(400);
    const { rows: kept } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM connector_events WHERE external_id = 'evt-x'",
      method: "all",
    });
    expect(Number(kept[0]?.[0])).toBe(0);

    // Picked up at the salon: ready, then delivered, both by the connector.
    s.sq.fulfil(order.id, "COMPLETED");
    const picked = await s.sq.event("order.fulfillment.updated", {
      type: "order_fulfillment_updated",
      id: order.id,
      object: { order_fulfillment_updated: { order_id: order.id, state: "COMPLETED" } },
    });
    expect((await s.call("POST", picked.url, picked.body, picked.headers)).status).toBe(200);
    await drain(s);
    const { rows: moved } = await s.db.client.query({
      sql: "SELECT event, actor_kind FROM item_events WHERE item_id = ? AND event IN ('fulfil', 'record_delivery') ORDER BY seq",
      params: [id],
      method: "all",
    });
    expect(moved.map((r) => [String(r[0]), String(r[1])])).toEqual([
      ["fulfil", "connector"],
      ["record_delivery", "connector"],
    ]);
  });

  it("holds the link when Square adds tax the customer did not accept", async () => {
    const s = await setup({ taxRate: 0.13 });
    await connected(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const [held] = await paymentsOf(s, id);
    expect(held).toMatchObject({
      state: "held",
      url: null,
      amount: { value: 2_800, currency: "CAD" },
      shop_total: { value: 3_164, currency: "CAD" },
    });
    expect((await itemOf(s.db, id)).payload.paymentUrl).toBeUndefined();
  });

  it("sells in yen at a shop in Osaka: priced exactly, and Square's link made in whole yen", async () => {
    const s = await setup({ seller: "osaka" });
    await connected(s);
    const { rows } = await s.db.client.query({
      sql: "SELECT external_id, price, active FROM products ORDER BY external_id",
      method: "all",
    });
    expect(rows.map((r) => [String(r[0]), JSON.parse(String(r[1])), Number(r[2])])).toEqual([
      ["VARDONABE2PERS00", { value: 680_000, currency: "JPY" }, 1],
      ["VARSANTOKU165MM0", { value: 1_280_000, currency: "JPY" }, 1],
    ]);
    const productId = String(
      (
        await s.db.client.query({
          sql: "SELECT id FROM products WHERE external_id = 'VARDONABE2PERS00'",
          method: "all",
        })
      ).rows[0]?.[0],
    );
    const made = await confirmed(
      (r) => s.inbox.app.request(r),
      new Request(`${BASE}/v1/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload: {
            orderedItem: [{ productId, name: "土鍋 Donabe", quantity: 1, price: { value: 680_000, currency: "JPY" } }],
            totalPrice: { value: 680_000, currency: "JPY" },
            delivery: { method: "pickup" },
          },
          contact: { name: "Tanaka Yui", email: "yui.tanaka@example.jp", locale: "ja" },
        }),
      }),
    );
    expect(made.status, await made.clone().text()).toBe(201);
    const id = ((await made.json()) as { view: { item: { id: string } } }).view.item.id;
    expect((await s.call("POST", `/v1/owner/items/${id}/transitions`, { event: "accept" }, s.owner)).status).toBe(200);
    await drain(s, 60_000);
    const order = orderOf(s.sq);
    expect([order.total, order.currency]).toEqual([6_800, "JPY"]);
    const [pay] = await paymentsOf(s, id);
    expect(pay).toMatchObject({ state: "open", amount: { value: 680_000, currency: "JPY" } });
  });

  it("takes the webhook away when disconnected, and the shelf off sale", async () => {
    const s = await setup();
    const id = await connected(s);
    expect(s.sq.subscriptions.size).toBe(1);
    const res = await s.call("DELETE", `/v1/owner/integrations/${id}`, undefined, s.owner);
    expect(res.status, await res.clone().text()).toBe(200);
    await drain(s);
    expect(s.sq.subscriptions.size).toBe(0);
    const { rows } = await s.db.client.query({ sql: "SELECT COUNT(*) FROM products WHERE active = 1", method: "all" });
    expect(Number(rows[0]?.[0])).toBe(0);
  });
});
