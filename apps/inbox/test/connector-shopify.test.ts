import { createApiKey, shopifyConnector } from "@surfingdog/adapters";
import { type Db, MANIFEST_PATH } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { forgetBuckets } from "../../../packages/adapters/src/connectors/shopify/index";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  type FakeShopify,
  fakeShopify,
  orderBody,
  stockFlorist,
} from "../../../packages/adapters/test/fixtures/shopify";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * The Shopify connector (ADR-028) end to end, through the doors an owner, a customer's agent and
 * Shopify use, with a made-up shop answering as Shopify documents it (`fixtures/shopify.ts`): a florist
 * in Oaxaca who sells in pesos. Agents are sent to the shop's own checkout to buy from the cart, and
 * come to the inbox for questions and quotes; a quote the customer accepts becomes a draft order in
 * Shopify, paid at Shopify's checkout, marked paid only once Shopify, asked back, says so, with the
 * signed receipt the inbox gives. No real shop is called.
 */
const BASE = "https://inbox.xochitl.example.mx";
const SECRET_KEY = "connector-shopify-test-secret-0123456789";
const STOREFRONT = "https://xochitl.example.mx";

async function setup(opts: { shop?: FakeShopify; currency?: string } = {}) {
  forgetBuckets();
  const db = await freshDb();
  const shop = opts.shop ?? fakeShopify();
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    fetchImpl: shop.platform.fetch,
    // The release's own connector, waiting no real time for Shopify's bucket.
    connectors: [shopifyConnector(null, { sleep: async () => {} })],
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
  const currency = opts.currency ?? "MXN";
  const saved = await call(
    "PUT",
    "/v1/owner/settings",
    {
      doc: {
        business: { name: shop.info.name, currency, timezone: "America/Mexico_City", languages: ["es", "en"] },
        email: { fromAddress: "pedidos@xochitl.example.mx" },
        notifications: { ownerEmail: "guadalupe@xochitl.example.mx", appUrl: BASE },
        directory: { url: STOREFRONT },
      },
    },
    owner,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  return { db, inbox, shop, call, owner, integration: { authorization: `Bearer ${integrationKey}` }, pending };
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

const connect = (s: S, values: Record<string, string> = {}, headers = s.owner) =>
  s.call(
    "POST",
    "/v1/owner/integrations",
    {
      kind: "shopify",
      values: { store: s.shop.shop, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...values },
    },
    headers,
  );

async function connected(s: S) {
  const res = await connect(s);
  expect(res.status, await res.clone().text()).toBe(201);
  const view = (await res.json()) as { id: string };
  await drain(s);
  return view.id;
}

async function productsOf(db: Db) {
  const { rows } = await db.client.query({
    sql: "SELECT external_id, name, price, stock, active, source FROM products ORDER BY external_id",
    method: "all",
  });
  return rows.map((r) => ({
    externalId: String(r[0]),
    name: String(r[1]),
    price: JSON.parse(String(r[2])) as { value: number; currency: string },
    stock: r[3] === null ? null : Number(r[3]),
    active: Number(r[4]) === 1,
    source: String(r[5]),
  }));
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

/** A quote a customer's agent asks for, the owner prices, and the customer accepts: the order it becomes. */
async function acceptedQuote(s: S, lines: { name: string; quantity: number; price: number }[], currency = "MXN") {
  const asked = await s.call("POST", "/v1/quotes", {
    payload: {
      itemOffered: { name: "Ofrenda para Día de Muertos" },
      description: "Cempasúchil y velas, para el 1 de noviembre",
      quantity: 1,
    },
    contact: { name: "Itzel Hernández", email: "itzel.hernandez@example.mx", locale: "es-MX" },
  });
  expect(asked.status, await asked.clone().text()).toBe(201);
  const created = (await asked.json()) as { view: { item: { id: string } }; accessToken: string };
  const id = created.view.item.id;
  const q = `access_token=${created.accessToken}`;
  const total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const quoted = await s.call(
    "POST",
    `/v1/owner/items/${id}/transitions`,
    {
      event: "quote",
      input: {
        totalPrice: { value: total, currency },
        validThrough: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, price: { value: l.price, currency } })),
      },
    },
    s.owner,
  );
  expect(quoted.status, await quoted.clone().text()).toBe(200);
  const status = (await (await s.call("GET", `/v1/items/${id}?${q}`)).json()) as {
    offer: { id: string; terms_sha: string };
  };
  const accepted = await s.call("POST", `/v1/items/${id}/accept?${q}`, {
    offer_id: status.offer.id,
    terms_sha: status.offer.terms_sha,
  });
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  await drain(s, 60_000);
  const { rows } = await s.db.client.query({
    sql: "SELECT id FROM items WHERE type = 'order' AND linked_item_id = ?",
    params: [id],
    method: "all",
  });
  return String(rows[0]?.[0]);
}

describe("a Shopify shop, connected with its own app's keys", () => {
  it("is connected in person, checked against the shop, and never shows its keys", async () => {
    const s = await setup();
    expect((await connect(s, {}, s.integration)).status).toBe(403);
    expect(s.shop.platform.seen).toHaveLength(0);
    const bad = await connect(s, { client_secret: "shpss_not_the_one" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { fields: { path: string }[] }).fields[0]?.path).toBe("values.client_secret");
    const custom = await connect(s, { store: STOREFRONT });
    expect(custom.status).toBe(422);
    expect(((await custom.json()) as { fields: { path: string }[] }).fields[0]?.path).toBe("values.store");

    const res = await connect(s);
    expect(res.status, await res.clone().text()).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain("shpat_");
    expect(JSON.parse(text)).toMatchObject({
      account: "Florería Xóchitl · xochitl-flores.myshopify.com",
      disconnect_note: "To end its access too, uninstall the app in Shopify: Settings → Apps.",
    });
    // Each webhook names the connection's own address.
    const uris = new Set([...s.shop.hooks.values()].map((h) => h.uri));
    expect(uris.size).toBe(1);
    expect([...uris][0]).toMatch(/^https:\/\/inbox\.xochitl\.example\.mx\/v1\/hooks\/shopify\/[A-Za-z0-9_-]{43}$/);
    const { rows } = await s.db.client.query({
      sql: "SELECT config_enc, config_public, inbound_token FROM connectors",
      method: "all",
    });
    expect(JSON.stringify(rows)).not.toContain(CLIENT_SECRET);
    // The address's token is kept only sealed, and as its hash.
    expect(JSON.stringify(rows)).not.toContain(
      String([...uris][0])
        .split("/")
        .at(-1),
    );
    expect(JSON.stringify(rows)).not.toContain("shpat_");
    // The card now connects: the gallery says so.
    const list = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as {
      cards: { id: string; status: string }[];
      connections: { kind: string; pay_on: boolean }[];
    };
    expect(list.cards.find((c) => c.id === "shopify")?.status).toBe("ready");
    expect(list.connections.map((c) => [c.kind, c.pay_on])).toEqual([["shopify", true]]);
  });

  it("brings the shop's products in, priced in its currency, and takes them off sale when disconnected", async () => {
    const s = await setup();
    stockFlorist(s.shop);
    const id = await connected(s);
    const products = await productsOf(s.db);
    expect(products.map((p) => [p.name, p.price.value, p.price.currency, p.stock, p.active])).toEqual([
      ["Ramo de cempasúchil", 45_000, "MXN", 12, true],
      ["Arreglo de mesa – Chico", 68_000, "MXN", null, true],
      ["Arreglo de mesa – Grande", 125_050, "MXN", null, true],
      ["Corona (próximamente)", 210_000, "MXN", 0, false],
    ]);
    expect(new Set(products.map((p) => p.source))).toEqual(
      new Set(["connector:shopify:gid://shopify/Shop/64120557901"]),
    );
    const res = await s.call("DELETE", `/v1/owner/integrations/${id}`, undefined, s.owner);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(s.shop.hooks.size).toBe(0);
    expect((await productsOf(s.db)).every((p) => !p.active)).toBe(true);
  });
});

describe("the shop's checkout for the cart, the inbox for quotes", () => {
  it("sends agents to the shop to buy, and turns an accepted quote into a draft order paid at Shopify's checkout", async () => {
    const s = await setup();
    stockFlorist(s.shop);
    await connected(s);
    // Orders at the shop's own checkout (where Shopify's own agent checkout serves the cart): the
    // manifest names it, and lists messages and quotes as the inbox's.
    const set = await s.call(
      "PUT",
      "/v1/owner/settings",
      { doc: { doorsElsewhere: [{ itemType: "order", url: STOREFRONT }] } },
      s.owner,
    );
    expect(set.status, await set.clone().text()).toBe(200);
    const manifest = (await (await s.call("GET", MANIFEST_PATH)).json()) as {
      item_types: string[];
      doors_elsewhere?: { item_type: string; url: string }[];
    };
    expect(manifest.doors_elsewhere).toEqual([{ item_type: "order", url: STOREFRONT }]);
    expect(manifest.item_types).toContain("quote_request");
    expect(manifest.item_types).not.toContain("order");

    const order = await acceptedQuote(s, [
      { name: "Ofrenda grande con cempasúchil", quantity: 1, price: 180_000 },
      { name: "Velas de cera (6)", quantity: 2, price: 12_000 },
    ]);
    const [draft] = [...s.shop.drafts.values()];
    expect(draft?.input).toMatchObject({
      lineItems: [
        {
          title: "Ofrenda grande con cempasúchil",
          quantity: 1,
          originalUnitPriceWithCurrency: { amount: "1800.00", currencyCode: "MXN" },
        },
        {
          title: "Velas de cera (6)",
          quantity: 2,
          originalUnitPriceWithCurrency: { amount: "120.00", currencyCode: "MXN" },
        },
      ],
      presentmentCurrencyCode: "MXN",
      email: "itzel.hernandez@example.mx",
      tags: ["sdi", expect.stringMatching(/^sdi-[0-9A-Z]{26}$/)],
    });
    const invoice = `https://${s.shop.shop}/64120557901/invoices/inv${draft?.id}fake`;
    expect(await itemOf(s.db, order)).toMatchObject({ state: "awaiting_payment", payload: { paymentUrl: invoice } });
    const [link] = await paymentsOf(s, order);
    expect(link).toMatchObject({
      state: "open",
      provider: "Shopify",
      url: invoice,
      dashboard_url: `https://admin.shopify.com/store/xochitl-flores/draft_orders/${draft?.id}`,
    });
  });

  it("marks it paid once Shopify, asked back, says so; a signature one byte off is refused; a delivery twice counts once", async () => {
    const s = await setup();
    stockFlorist(s.shop);
    await connected(s);
    const order = await acceptedQuote(s, [{ name: "Ramo para la ofrenda", quantity: 1, price: 95_000 }]);
    const [draft] = [...s.shop.drafts.values()];
    if (!draft) throw new Error("no draft");
    const paid = s.shop.pay(draft.id);

    const tampered = await s.shop.delivery("orders/paid", orderBody(paid), { tamper: true });
    expect((await s.call("POST", tampered.url, tampered.body, tampered.headers)).status).toBe(400);
    const { rows: none } = await s.db.client.query({ sql: "SELECT COUNT(*) FROM connector_events", method: "all" });
    expect(Number(none[0]?.[0])).toBe(0);

    const hook = await s.shop.delivery("orders/paid", orderBody(paid), {
      webhookId: "b54557e4-bdd9-4b37-8a5f-00000000beef",
    });
    const first = await s.call("POST", hook.url, hook.body, hook.headers);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });
    await drain(s);
    expect((await itemOf(s.db, order)).state).toBe("paid");
    // Kept as ids only: none of what the body said of the customer.
    const { rows: kept } = await s.db.client.query({
      sql: "SELECT external_id, topic, raw FROM connector_events",
      method: "all",
    });
    expect(kept.map((r) => [String(r[0]), String(r[1])])).toEqual([
      ["b54557e4-bdd9-4b37-8a5f-00000000beef", "orders/paid"],
    ]);
    expect(String(kept[0]?.[2])).not.toContain("itzel");
    expect(String(kept[0]?.[2])).not.toContain("+52");
    const again = await s.call("POST", hook.url, hook.body, hook.headers);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });

    // The receipt attests what Shopify says was paid.
    const { rows: receipts } = await s.db.client.query({
      sql: "SELECT kind, payload FROM receipts WHERE item_id = ?",
      params: [order],
      method: "all",
    });
    expect(JSON.parse(String(receipts.find((r) => r[0] === "paid")?.[1]))).toMatchObject({
      knd: "paid",
      typ: "order",
      amt: { value: 95_000, currency: "MXN" },
    });
    expect(await paymentsOf(s, order)).toMatchObject([
      {
        state: "paid",
        payment_id: `gid://shopify/Order/${paid.id}`,
        dashboard_url: `https://admin.shopify.com/store/xochitl-flores/orders/${paid.id}`,
      },
    ]);

    // Shopify fulfils it: the order moves on, by the connector.
    paid.fulfillment = "FULFILLED";
    paid.fulfillments.push({
      status: "SUCCESS",
      displayStatus: "IN_TRANSIT",
      deliveredAt: null,
      createdAt: new Date().toISOString(),
      tracking: { company: "Estafeta", number: "EST 7781 2290", url: "https://rastreo.example.mx/EST77812290" },
    });
    const sent = await s.shop.delivery("orders/fulfilled", orderBody(paid));
    expect((await s.call("POST", sent.url, sent.body, sent.headers)).status).toBe(200);
    await drain(s);
    expect((await itemOf(s.db, order)).state).toBe("fulfilled");
    const { rows: events } = await s.db.client.query({
      sql: "SELECT event, actor_kind FROM item_events WHERE item_id = ? AND event IN ('record_payment', 'fulfil') ORDER BY seq",
      params: [order],
      method: "all",
    });
    expect(events.map((e) => `${e[0]}:${e[1]}`)).toEqual(["record_payment:connector", "fulfil:connector"]);
  });

  it("closes the link and leaves the order to the owner when the draft is deleted in Shopify unpaid", async () => {
    const s = await setup();
    stockFlorist(s.shop);
    await connected(s);
    const order = await acceptedQuote(s, [{ name: "Arreglo para la mesa", quantity: 1, price: 70_000 }]);
    const [draft] = [...s.shop.drafts.values()];
    if (!draft) throw new Error("no draft");
    s.shop.drafts.delete(draft.id);
    const hook = await s.shop.delivery("draft_orders/delete", { id: draft.id });
    expect((await s.call("POST", hook.url, hook.body, hook.headers)).status).toBe(200);
    await drain(s);
    const [link] = await paymentsOf(s, order);
    expect(link).toMatchObject({ state: "closed", note: "cancelled in Shopify" });
    const item = await itemOf(s.db, order);
    expect(item.state).toBe("awaiting_payment");
    expect(item.payload.paymentUrl).toBeUndefined();
  });
});

describe("a shop that adds tax at its checkout", () => {
  it("holds the link, so nobody pays more than they accepted, and the owner can propose the shop's total", async () => {
    const shop = fakeShopify({
      handle: "northern-bloom",
      name: "Northern Bloom",
      currency: "CAD",
      taxesIncluded: false,
      primaryDomain: "https://northernbloom.example.ca",
    });
    shop.taxRate = 0.13;
    const s = await setup({ shop, currency: "CAD" });
    await connected(s);
    const order = await acceptedQuote(s, [{ name: "Wedding peonies, 40 stems", quantity: 1, price: 32_000 }], "CAD");
    expect((await itemOf(s.db, order)).state).toBe("accepted");
    const [held] = await paymentsOf(s, order);
    expect(held).toMatchObject({
      state: "held",
      url: null,
      amount: { value: 32_000, currency: "CAD" },
      shop_total: { value: 36_160, currency: "CAD" },
      propose_shop_total: true,
    });
    const proposed = await s.call("POST", `/v1/owner/items/${order}/payments/shop-total`, undefined, s.owner);
    expect(proposed.status, await proposed.clone().text()).toBe(200);
    expect(((await itemOf(s.db, order)).payload.change as { totalPrice: { value: number } }).totalPrice.value).toBe(
      36_160,
    );
  });
});
