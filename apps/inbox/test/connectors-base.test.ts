import { createApiKey } from "@surfingdog/adapters";
import { type ConnectorDefinition, ConnectorError, type Db } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { createInbox } from "../src/app";
import { type FakeShop, fakeShop, fakeShopConnector, signed } from "./fake-shop";
import { confirmed, freshDb } from "./harness";
import { stripePlatform } from "./pay-platforms";

/**
 * The connectors' shared base (ADR-026), end to end through the doors an owner, a customer's agent and
 * a shop use, with a made-up shop (`fake-shop.ts`): a bakery in Nairobi that sells in shillings.
 * Connected with its key, its catalogue comes in by the one upsert feeds share; an order the owner
 * accepts is written into the shop and paid at the shop's own checkout, but only when the shop's total
 * is the one the customer accepted; the shop's signed webhook reaches the connection at its own
 * address, is kept as ids only, and is read back with the business's key before anything is believed;
 * disconnecting takes away what the connection made. No real platform is called.
 */
const BASE = "https://inbox.kibanda.example.com";
const SECRET_KEY = "connectors-base-test-secret-0123456789";

async function setup(
  opts: { shop?: FakeShop; connectors?: ConnectorDefinition[]; website?: string; stripe?: boolean } = {},
) {
  const db = await freshDb();
  const shop = opts.shop ?? fakeShop();
  const stripe = opts.stripe ? stripePlatform(STRIPE_LIVE_KEY, BASE) : null;
  const mail = logMailOut();
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: mail,
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      stripe && new URL(String(input)).host === "api.stripe.com"
        ? stripe.fetch(input, init)
        : shop.platform.fetch(input, init)) as typeof fetch,
    connectors: opts.connectors ?? [fakeShopConnector()],
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const integrationKey = (await createApiKey(db, { kind: "integration", name: "Zapier" })).key;
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
        business: { name: "Kibanda Bakery", currency: "KES", timezone: "Africa/Nairobi", languages: ["en", "sw"] },
        email: { fromAddress: "orders@kibanda.example.com" },
        notifications: { ownerEmail: "amina@kibanda.example.com", appUrl: BASE },
        directory: { url: opts.website ?? "https://kibanda.example.com" },
      },
    },
    owner,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  return { db, inbox, shop, call, owner, integration: { authorization: `Bearer ${integrationKey}` }, mail, pending };
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

function stock(shop: FakeShop) {
  const now = Date.now();
  shop.products.push(
    { id: "101", name: "Mandazi (6)", sku: "MDZ-6", price: 30_000, stock: 40, published: true, modifiedAt: now },
    { id: "102", name: "Chapati (4)", sku: "CHP-4", price: 20_000, stock: null, published: true, modifiedAt: now },
    { id: "103", name: "Wedding cake", sku: null, price: null, stock: null, published: true, modifiedAt: now },
    {
      id: "104",
      name: "Mkate wa sinia",
      sku: "_shop_charges",
      price: 45_000,
      stock: 5,
      published: true,
      modifiedAt: now,
    },
    { id: "105", name: "Hidden loaf", sku: "HDN-1", price: 15_000, stock: 2, published: false, modifiedAt: now },
  );
}

async function connectShop(s: S, key = s.shop.key.value) {
  const res = await s.call(
    "POST",
    "/v1/owner/integrations",
    { kind: "kibanda", values: { store_url: `https://${s.shop.host}`, api_key: key } },
    s.owner,
  );
  return res;
}

async function productsOf(db: Db) {
  const { rows } = await db.client.query({
    sql: "SELECT external_id, name, sku, price, stock, active, source FROM products ORDER BY external_id",
    method: "all",
  });
  return rows.map((r) => ({
    externalId: String(r[0]),
    name: String(r[1]),
    sku: r[2] === null ? null : String(r[2]),
    price: JSON.parse(String(r[3])) as { value: number; currency: string },
    stock: r[4] === null ? null : Number(r[4]),
    active: Number(r[5]) === 1,
    source: String(r[6]),
  }));
}

const tokens = new Map<string, string>();

/** An order of the customer's for catalogue products, through the public door, accepted by the owner. */
async function acceptedOrder(s: S, lines: { productId: string; name: string; quantity: number; price: number }[]) {
  const total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const made = await confirmed(
    (r) => s.inbox.app.request(r),
    new Request(`${BASE}/v1/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          orderedItem: lines.map((l) => ({
            productId: l.productId,
            name: l.name,
            quantity: l.quantity,
            price: { value: l.price, currency: "KES" },
          })),
          totalPrice: { value: total, currency: "KES" },
          delivery: { method: "delivery" },
          shippingAddress: { streetAddress: "Moi Avenue 12", addressLocality: "Nairobi", addressCountry: "KE" },
          notes: "Ring the bell twice, please.",
        },
        contact: { name: "Wanjiru Kamau", email: "wanjiru@example.com", locale: "en-KE" },
      }),
    }),
  );
  expect(made.status, await made.clone().text()).toBe(201);
  const body = (await made.json()) as { view: { item: { id: string } }; accessToken: string };
  const id = body.view.item.id;
  tokens.set(id, body.accessToken);
  const accepted = await s.call("POST", `/v1/owner/items/${id}/transitions`, { event: "accept" }, s.owner);
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  return id;
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

async function events(db: Db) {
  const { rows } = await db.client.query({
    sql: "SELECT external_id, topic, status, raw FROM connector_events ORDER BY received_at, id",
    method: "all",
  });
  return rows.map((r) => ({ id: String(r[0]), topic: String(r[1]), status: String(r[2]), raw: String(r[3]) }));
}

/** The shop's catalogue in the inbox, connected and read once. */
async function stocked(s: S) {
  stock(s.shop);
  const res = await connectShop(s);
  expect(res.status, await res.clone().text()).toBe(201);
  const view = (await res.json()) as { id: string };
  await drain(s);
  const products = await productsOf(s.db);
  const mandazi = products.find((p) => p.externalId === "p:101");
  const { rows } = await s.db.client.query({
    sql: "SELECT id FROM products WHERE external_id = 'p:101'",
    method: "all",
  });
  return { connection: view.id, mandaziId: String(rows[0]?.[0]), mandazi };
}

describe("a shop, connected with its key", () => {
  it("is checked against the shop, sealed, given its own webhook address, and never shows its key", async () => {
    const s = await setup();
    const bad = await connectShop(s, "kb_live_wrong_key");
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { fields: { path: string }[] }).fields[0]?.path).toBe("values.api_key");
    const res = await connectShop(s);
    expect(res.status, await res.clone().text()).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(s.shop.key.value);
    expect(text).not.toContain("whsec_");
    const view = JSON.parse(text) as { card: string | null; disconnect_note: string | null; account: string };
    expect(view).toMatchObject({
      account: "Kibanda Bakery",
      disconnect_note: "Remove the key in your shop: Settings → API.",
    });
    // The webhook names the connection's own address: a token, not the kind's address every inbox shares.
    const hook = [...s.shop.webhooks.values()][0];
    expect(hook?.url).toMatch(/^https:\/\/inbox\.kibanda\.example\.com\/v1\/hooks\/kibanda\/[A-Za-z0-9_-]{43}$/);
    // The database keeps the token's hash, never the token, and the key sealed.
    const { rows } = await s.db.client.query({
      sql: "SELECT inbound_token, inbound_enc, config_enc, config_public FROM connectors",
      method: "all",
    });
    const token = hook?.url.split("/").at(-1) ?? "";
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(s.shop.key.value);
    expect(String(rows[0]?.[0])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a shop at a plain http address, a private one, or one that sends it to a private host", async () => {
    const s = await setup();
    for (const store_url of ["http://kibanda.example.com", "https://10.0.0.7", "https://localhost"]) {
      const res = await s.call(
        "POST",
        "/v1/owner/integrations",
        { kind: "kibanda", values: { store_url, api_key: s.shop.key.value } },
        s.owner,
      );
      expect(res.status, store_url).toBe(422);
      expect(((await res.json()) as { fields?: { path: string }[] }).fields?.[0]?.path).toBe("values.store_url");
    }
    s.shop.platform.fail("GET", `https://${s.shop.host}/api/me`, { redirect: "https://192.168.1.9/api/me" });
    const redirected = await connectShop(s);
    // The connector does not follow redirects, so the shop's 302 is no shop at all; nothing reached the private host.
    expect(redirected.status).toBe(422);
    expect(s.shop.platform.seen.some((r) => r.url.hostname === "192.168.1.9")).toBe(false);
    // Nor did the key travel anywhere but the shop.
    expect(s.shop.platform.seen.every((r) => r.url.hostname === s.shop.host)).toBe(true);
  });

  it("is connected in person only: a key handed to another system is refused", async () => {
    const s = await setup();
    const res = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "kibanda", values: { store_url: `https://${s.shop.host}`, api_key: s.shop.key.value } },
      s.integration,
    );
    expect(res.status).toBe(403);
    expect(s.shop.platform.seen).toHaveLength(0);
  });
});

describe("one connection makes an order's links", () => {
  it("is the shop once it is connected: Stripe's links switch off, and those already sent keep working", async () => {
    const s = await setup({ stripe: true });
    const stripe = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "stripe", values: { api_key: STRIPE_LIVE_KEY } },
      s.owner,
    );
    expect(stripe.status, await stripe.clone().text()).toBe(201);
    const res = await connectShop(s);
    expect(res.status, await res.clone().text()).toBe(201);
    const list = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as {
      connections: { kind: string; pay_on: boolean; mode: string | null }[];
    };
    expect(list.connections.map((c) => [c.kind, c.pay_on, c.mode])).toEqual([
      ["stripe", false, "live"],
      ["kibanda", true, "live"],
    ]);
  });
});

describe("the catalogue a shop sends in", () => {
  it("comes in page by page by the shared upsert: priced, stocked, reserved and missing prices handled, nothing guessed", async () => {
    const s = await setup();
    const { connection } = await stocked(s);
    const products = await productsOf(s.db);
    expect(products.map((p) => [p.externalId, p.active, p.sku, p.price.value, p.price.currency, p.stock])).toEqual([
      ["p:101", true, "MDZ-6", 30_000, "KES", 40],
      ["p:102", true, "CHP-4", 20_000, "KES", null],
      // No price, ever: kept off sale, in the business's own currency, never one guessed.
      ["p:103", false, null, 0, "KES", null],
      // A SKU the inbox keeps for itself is never written.
      ["p:104", true, null, 45_000, "KES", 5],
      // Not published in the shop: not on sale here.
      ["p:105", false, "HDN-1", 15_000, "KES", 2],
    ]);
    expect(new Set(products.map((p) => p.source))).toEqual(new Set(["connector:kibanda:store_kibanda.example.com"]));
    // Three pages of two, in one sync.
    expect(s.shop.platform.requests("GET", `https://${s.shop.host}/api/products`)).toHaveLength(3);
    const view = (await (await s.call("GET", `/v1/owner/integrations/${connection}`, undefined, s.owner)).json()) as {
      catalogue: { products: number; truncated: boolean };
    };
    expect(view.catalogue).toMatchObject({ products: 3, truncated: false });
  });

  it("keeps the last price when the shop leaves it out, and takes off sale what a full pass no longer sees", async () => {
    const s = await setup();
    const { connection } = await stocked(s);
    const mandazi = s.shop.products.find((p) => p.id === "101");
    if (mandazi) mandazi.price = null;
    s.shop.products.splice(
      s.shop.products.findIndex((p) => p.id === "102"),
      1,
    );
    // The next full pass, six hours on.
    await s.inbox.caps.connectors.run(connection, Date.now() + 6 * 3_600_000 + 60_000, "sync");
    const products = await productsOf(s.db);
    expect(products.find((p) => p.externalId === "p:101")).toMatchObject({ active: true, price: { value: 30_000 } });
    // Gone from the shop: off sale, never deleted (an order may name it).
    expect(products.find((p) => p.externalId === "p:102")).toMatchObject({ active: false });
  });

  it("takes the products off sale when the shop is disconnected, and its webhook away", async () => {
    const s = await setup();
    const { connection } = await stocked(s);
    expect(s.shop.webhooks.size).toBe(1);
    const res = await s.call("DELETE", `/v1/owner/integrations/${connection}`, undefined, s.owner);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(s.shop.webhooks.size).toBe(0);
    expect((await productsOf(s.db)).every((p) => !p.active)).toBe(true);
    const { rows } = await s.db.client.query({ sql: "SELECT COUNT(*) FROM connectors", method: "all" });
    expect(Number(rows[0]?.[0])).toBe(0);
  });
});

describe("orders paid at the shop's own checkout", () => {
  it("writes the accepted order into the shop with what fulfilling needs, and asks the customer to pay there", async () => {
    const s = await setup();
    const { mandaziId } = await stocked(s);
    const id = await acceptedOrder(s, [{ productId: mandaziId, name: "Mandazi (6)", quantity: 2, price: 30_000 }]);
    await drain(s, 60_000);
    const [order] = [...s.shop.orders.values()];
    expect(order?.sent).toMatchObject({
      lines: [
        {
          externalId: "p:101",
          sku: "MDZ-6",
          name: "Mandazi (6)",
          quantity: 2,
          unit: { value: 30_000, currency: "KES" },
        },
      ],
      charges: null,
      total: { value: 60_000, currency: "KES" },
      delivery: "delivery",
      customer: { name: "Wanjiru Kamau", email: "wanjiru@example.com", language: "en-KE" },
      shipping: { streetAddress: "Moi Avenue 12", addressLocality: "Nairobi", addressCountry: "KE" },
      note: "Ring the bell twice, please.",
    });
    // The idempotency key is the inbox's own id for the link: a retry makes no second order.
    expect(order?.ref).toMatch(/^[0-9A-Z]{26}$/);
    expect(await itemOf(s.db, id)).toMatchObject({
      state: "awaiting_payment",
      payload: { paymentUrl: `https://${s.shop.host}/checkout/${order?.id}` },
    });
    const [link] = await paymentsOf(s, id);
    expect(link).toMatchObject({
      state: "open",
      provider: "Kibanda Shop",
      url: `https://${s.shop.host}/checkout/${order?.id}`,
      dashboard_url: `https://${s.shop.host}/admin/orders/${order?.id}`,
      shop_total: null,
    });
  });

  it("marks it paid only once the shop, asked back, says so: a webhook is a nudge, its body never believed", async () => {
    const s = await setup();
    const { mandaziId } = await stocked(s);
    const id = await acceptedOrder(s, [{ productId: mandaziId, name: "Mandazi (6)", quantity: 1, price: 30_000 }]);
    await drain(s, 60_000);
    const [order] = [...s.shop.orders.values()];
    if (!order) throw new Error("no order");

    // A body that says paid, for an order the shop still has as pending: nothing is marked.
    const lying = await signed(s.shop, {
      id: "evt_1",
      topic: "order.updated",
      order: order.id,
      extra: { status: "paid" },
    });
    const first = await s.call("POST", lying.url, lying.body, lying.headers);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });
    await drain(s);
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");

    // Kept as ids only: none of what the body said of the customer.
    const kept = await events(s.db);
    expect(kept.map((e) => [e.id, e.topic])).toEqual([["evt_1", "order.updated"]]);
    expect(kept[0]?.raw).toBe(JSON.stringify({ topic: "order.updated", refs: [order.id] }));
    expect(JSON.stringify(kept)).not.toContain("wanjiru");
    expect(JSON.stringify(kept)).not.toContain("+254");

    // Now the shop has it paid: the next delivery, read back, marks the order paid.
    order.status = "paid";
    order.paymentId = "pay_ke_778";
    const paid = await signed(s.shop, { id: "evt_2", topic: "order.updated", order: order.id });
    expect((await s.call("POST", paid.url, paid.body, paid.headers)).status).toBe(200);
    await drain(s);
    expect((await itemOf(s.db, id)).state).toBe("paid");
    const [link] = await paymentsOf(s, id);
    expect(link).toMatchObject({
      state: "paid",
      payment_id: "pay_ke_778",
      paid_amount: { value: 30_000, currency: "KES" },
    });

    // The same delivery again: counted once.
    const again = await s.call("POST", paid.url, paid.body, paid.headers);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    await drain(s);
    expect((await events(s.db)).filter((e) => e.id === "evt_2")).toHaveLength(1);
  });

  it("answers 400 to a signature one byte off and writes nothing; a ping is answered; an unknown address is not found", async () => {
    const s = await setup();
    await stocked(s);
    const tampered = await signed(s.shop, { id: "evt_9", topic: "order.updated", order: "ord_1" }, true);
    const res = await s.call("POST", tampered.url, tampered.body, tampered.headers);
    expect(res.status).toBe(400);
    expect(await events(s.db)).toEqual([]);
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = 'connector_hook'",
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(0);

    const ping = await signed(s.shop, { id: "evt_ping", topic: "ping" });
    const pinged = await s.call("POST", ping.url, ping.body, ping.headers);
    expect(pinged.status).toBe(200);
    expect(await pinged.json()).toEqual({ ok: true, ping: true });

    const elsewhere = ping.url.replace(/[A-Za-z0-9_-]{43}$/, "A".repeat(43));
    expect((await s.call("POST", elsewhere, ping.body, ping.headers)).status).toBe(404);
    expect((await s.call("POST", `${BASE}/v1/hooks/kibanda/short`, ping.body, ping.headers)).status).toBe(404);
  });

  it("takes a platform's one app address for the account it names, and answers a challenge as it came", async () => {
    // A platform that sends every account's events to the app's one address (Jobber's), and proves a
    // connection's own address with a challenge before it sends to it (ServiceM8's sign-in).
    const shopDef = fakeShopConnector();
    const shopHooks = shopDef.hooks as NonNullable<ConnectorDefinition["hooks"]>;
    const def: ConnectorDefinition = {
      ...shopDef,
      hooks: {
        ...shopHooks,
        async account(request) {
          if (request.headers.get("x-app-signature") !== "signed-by-the-app") {
            throw new ConnectorError("refused", "The signature does not check out.");
          }
          const named = (JSON.parse(request.body) as { account?: unknown }).account;
          return typeof named === "string" ? named : null;
        },
        async verify(ctx, request) {
          const form = new URLSearchParams(request.body);
          if (form.get("mode") === "subscribe") return { challenge: form.get("challenge") ?? "" };
          return shopHooks.verify(ctx, request);
        },
      },
    };
    const s = await setup({ connectors: [def] });
    await stocked(s);
    const app = `${BASE}/v1/hooks/kibanda/app`;
    const event = await signed(s.shop, {
      id: "evt_app_1",
      topic: "order.updated",
      order: "ord_1",
      extra: { account: "store_kibanda.example.com" },
    });
    const taken = await s.call("POST", app, event.body, { ...event.headers, "x-app-signature": "signed-by-the-app" });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toEqual({ ok: true, duplicate: false });
    expect((await events(s.db)).map((e) => e.id)).toEqual(["evt_app_1"]);
    // Not signed by the app: refused, nothing kept. An account not connected here: nothing to keep.
    const forged = await s.call("POST", app, event.body, { ...event.headers, "x-app-signature": "made-up" });
    expect(forged.status).toBe(400);
    const elsewhere = await signed(s.shop, { id: "evt_app_2", topic: "order.updated", extra: { account: "store_x" } });
    const other = await s.call("POST", app, elsewhere.body, {
      ...elsewhere.headers,
      "x-app-signature": "signed-by-the-app",
    });
    expect(await other.json()).toEqual({ ok: true, ignored: true });
    expect(await events(s.db)).toHaveLength(1);
    // The connection's own address, proved: the challenge as plain text, and nothing kept.
    const own = [...s.shop.webhooks.values()][0]?.url ?? "";
    const proved = await s.call("POST", own, "mode=subscribe&challenge=c0ffee-1234", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(proved.status).toBe(200);
    expect(await proved.text()).toBe("c0ffee-1234");
    expect(await events(s.db)).toHaveLength(1);
  });

  it("holds the link when the shop adds tax the customer did not accept, and lets the owner propose the shop's total", async () => {
    const s = await setup();
    const { mandaziId } = await stocked(s);
    s.shop.taxRate = 0.16;
    const id = await acceptedOrder(s, [{ productId: mandaziId, name: "Mandazi (6)", quantity: 1, price: 30_000 }]);
    await drain(s, 60_000);
    // Made in the shop, never sent: the customer is not asked to pay more than they accepted.
    expect(await itemOf(s.db, id)).toMatchObject({ state: "accepted" });
    expect((await itemOf(s.db, id)).payload.paymentUrl).toBeUndefined();
    const [held] = await paymentsOf(s, id);
    expect(held).toMatchObject({
      state: "held",
      url: null,
      amount: { value: 30_000, currency: "KES" },
      shop_total: { value: 34_800, currency: "KES" },
      propose_shop_total: true,
    });
    // The owner is told, once, what the shop counts and what to do.
    const { rows: told } = await s.db.client.query({
      sql: "SELECT subject, body_text FROM outbound_mail WHERE template = 'owner.payment_shop_total'",
      method: "all",
    });
    expect(told).toHaveLength(1);
    expect(String(told[0]?.[1])).toContain("Propose the shop's total");

    // Money is the owner's in person: a key handed to another system may not propose it.
    const keyed = await s.call("POST", `/v1/owner/items/${id}/payments/shop-total`, undefined, s.integration);
    expect(keyed.status).toBe(403);
    const proposed = await s.call("POST", `/v1/owner/items/${id}/payments/shop-total`, undefined, s.owner);
    expect(proposed.status, await proposed.clone().text()).toBe(200);
    const change = (await itemOf(s.db, id)).payload.change as {
      orderedItem: { sku?: string; name: string; price: { value: number } }[];
      totalPrice: { value: number };
    };
    expect(change.totalPrice.value).toBe(34_800);
    expect(change.orderedItem.at(-1)).toMatchObject({
      sku: "_shop_charges",
      name: "Tax and charges",
      price: { value: 4_800 },
    });

    // The customer accepts the shop's total; the held order goes, and the one at the new total is sent.
    const q = `access_token=${tokens.get(id)}`;
    const status = (await (await s.call("GET", `/v1/items/${id}?${q}`)).json()) as {
      offer: { id: string; terms_sha: string };
    };
    const accepted = await s.call("POST", `/v1/items/${id}/accept?${q}`, {
      offer_id: status.offer.id,
      terms_sha: status.offer.terms_sha,
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    await drain(s, 60_000);
    const orders = [...s.shop.orders.values()];
    expect(orders.map((o) => o.status)).toEqual(["cancelled", "pending"]);
    // The shop is told the product lines only, and the charges it adds itself.
    expect(orders[1]?.sent).toMatchObject({
      lines: [{ externalId: "p:101", unit: { value: 30_000 } }],
      charges: { value: 4_800, currency: "KES" },
      total: { value: 34_800, currency: "KES" },
    });
    expect(await itemOf(s.db, id)).toMatchObject({
      state: "awaiting_payment",
      payload: { paymentUrl: `https://${s.shop.host}/checkout/${orders[1]?.id}` },
    });
  });

  it("closes the link and leaves the order to the owner when the shop cancels it unpaid", async () => {
    const s = await setup();
    const { mandaziId, connection } = await stocked(s);
    const id = await acceptedOrder(s, [{ productId: mandaziId, name: "Mandazi (6)", quantity: 1, price: 30_000 }]);
    await drain(s, 60_000);
    const [order] = [...s.shop.orders.values()];
    if (!order) throw new Error("no order");
    order.status = "cancelled";
    await s.inbox.caps.connectors.run(connection, Date.now() + 5 * 60_000, "sync");
    await drain(s, 6 * 60_000);
    const [link] = await paymentsOf(s, id);
    expect(link).toMatchObject({ state: "closed", note: "cancelled in Kibanda Shop" });
    // Not cancelled here: the customer is not told their order ended because a shop let it go.
    const item = await itemOf(s.db, id);
    expect(item.state).toBe("awaiting_payment");
    expect(item.payload.paymentUrl).toBeUndefined();
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM outbound_mail WHERE template = 'owner.payment_shop_cancelled'",
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(1);
  });

  it("moves a paid order on when the shop fulfils it, by the connector", async () => {
    const s = await setup();
    const { mandaziId, connection } = await stocked(s);
    const id = await acceptedOrder(s, [{ productId: mandaziId, name: "Mandazi (6)", quantity: 1, price: 30_000 }]);
    await drain(s, 60_000);
    const [order] = [...s.shop.orders.values()];
    if (!order) throw new Error("no order");
    order.status = "paid";
    await s.inbox.caps.connectors.run(connection, Date.now() + 5 * 60_000, "sync");
    await drain(s);
    expect((await itemOf(s.db, id)).state).toBe("paid");
    order.status = "fulfilled";
    await s.inbox.caps.connectors.run(connection, Date.now() + 2 * 3_600_000, "sync");
    await drain(s);
    expect((await itemOf(s.db, id)).state).toBe("fulfilled");
    const { rows } = await s.db.client.query({
      sql: "SELECT actor_kind FROM item_events WHERE item_id = ? AND event = 'fulfil'",
      params: [id],
      method: "all",
    });
    expect(rows.map((r) => String(r[0]))).toEqual(["connector"]);
  });
});
