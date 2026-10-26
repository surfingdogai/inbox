import { createApiKey } from "@surfingdog/adapters";
import type { Db } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { hmacSha256Base64 } from "../../../packages/adapters/src/connectors/hook-sign";
import {
  type FakeWooStore,
  fakeWooStore,
  simple,
  variable,
  variation,
} from "../../../packages/adapters/test/fixtures/woocommerce/store";
import { createInbox } from "../src/app";
import { confirmed, freshDb } from "./harness";

/**
 * WooCommerce (ADR-032) end to end, through the doors an owner, a customer's agent and a store use,
 * with a made-up store that answers as WooCommerce's REST API documents it: a pizzeria in São Paulo
 * selling in reais, and a bakery in Toronto whose prices leave HST to the checkout. The owner connects
 * with one press on the store's own Approve page; the store's catalogue comes in; an order the owner
 * accepts is written into the store, pending, and the customer pays at the store's own checkout; the
 * store's signed webhook, read back with the key, marks it paid and the receipt says so; disconnecting
 * takes its webhooks away and leaves the key for the owner to remove. No real store is called.
 */
const BASE = "https://inbox.pizzaria-bixiga.example.com";
const SECRET_KEY = "woocommerce-test-secret-0123456789abcdef";

async function setup(
  opts: {
    store?: FakeWooStore;
    currency?: string;
    timezone?: string;
    base?: string;
    policy?: { hooksLive: boolean };
  } = {},
) {
  const db = await freshDb();
  const store = opts.store ?? fakeWooStore();
  store.products.push(
    simple(11, "Pizza Margherita", "49.90", { sku: "PZ-MARG", manage_stock: true, stock_quantity: 30 }),
    variable(20, "Pizza Calabresa", [variation(22, "Grande", "69.00", { sku: "PZ-CAL-G" })]),
    simple(13, "Guaraná 350ml", "6.50", { status: "draft" }),
  );
  const mail = logMailOut();
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: mail,
    secretKey: SECRET_KEY,
    baseUrl: opts.base ?? BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    ...(opts.policy ? { policy: opts.policy } : {}),
    fetchImpl: store.platform.fetch,
  });
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
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
        business: {
          name: store.settings.name,
          currency: opts.currency ?? "BRL",
          timezone: opts.timezone ?? "America/Sao_Paulo",
          languages: ["pt", "en"],
        },
        email: { fromAddress: `pedidos@${store.host}` },
        notifications: { ownerEmail: `dono@${store.host}`, appUrl: BASE },
        directory: { url: store.base },
      },
    },
    owner,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  const drain = async (aheadMs = 0) => {
    await Promise.all(pending);
    for (const ahead of aheadMs > 0 ? [0, aheadMs] : [0]) {
      let settled = false;
      for (let pass = 0; pass < 40 && !settled; pass++) {
        settled = (await inbox.runner.runDue(db, { now: Date.now() + ahead })).claimed === 0;
      }
      if (!settled) throw new Error("the outbox never settled");
    }
  };
  return { db, inbox, store, call, owner, drain };
}
type S = Awaited<ReturnType<typeof setup>>;

/** The owner presses Connect your shop, approves on the store's own page, and comes back. */
async function connectByApproving(s: S, opts: { deny?: boolean } = {}) {
  const started = await s.call(
    "POST",
    "/v1/owner/integrations/authorize",
    { kind: "woocommerce", input: { store_url: s.store.base } },
    s.owner,
  );
  expect(started.status, await started.clone().text()).toBe(200);
  const { authorize_url } = (await started.json()) as { authorize_url: string };
  const approved = await s.store.approve(authorize_url, (url, body) => s.call("POST", url, body), opts);
  const back = await s.call(
    "GET",
    (approved.location || `${BASE}/oauth/connect/woocommerce/callback?state=none`).replace(BASE, ""),
  );
  expect(back.status).toBe(303);
  return { approved, to: new URL(String(back.headers.get("location")), BASE), authorize_url };
}

async function connected(s: S): Promise<string> {
  const { to } = await connectByApproving(s);
  const id = to.searchParams.get("connected") ?? "";
  expect(id, to.toString()).toMatch(/^[0-9A-Z]{26}$/);
  await s.drain();
  // The store pinged each webhook it was given; the inbox answers.
  for (const ping of s.store.pings.splice(0)) {
    const res = await s.call("POST", ping.url, ping.body, { "content-type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(200);
  }
  return id;
}

async function productsOf(db: Db) {
  const { rows } = await db.client.query({
    sql: "SELECT id, external_id, name, sku, price, stock, active, source FROM products ORDER BY external_id",
    method: "all",
  });
  return rows.map((r) => ({
    id: String(r[0]),
    externalId: String(r[1]),
    name: String(r[2]),
    sku: r[3] === null ? null : String(r[3]),
    price: JSON.parse(String(r[4])) as { value: number; currency: string },
    stock: r[5] === null ? null : Number(r[5]),
    active: Number(r[6]) === 1,
    source: String(r[7]),
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

const tokens = new Map<string, string>();

/** An order of the customer's for catalogue products, through the public door, accepted by the owner. */
async function acceptedOrder(
  s: S,
  lines: { productId: string; name: string; quantity: number; price: number }[],
  currency = "BRL",
) {
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
            price: { value: l.price, currency },
          })),
          totalPrice: { value: total, currency },
          delivery: { method: "delivery" },
          shippingAddress: {
            streetAddress: "Rua Treze de Maio, 120",
            addressLocality: "São Paulo",
            addressCountry: "BR",
          },
          notes: "Sem cebola, por favor.",
        },
        contact: { name: "Ana Beatriz Souza", email: "ana.souza@example.com", locale: "pt-BR" },
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

async function deliver(s: S, topic: string, id: number) {
  const d = await s.store.delivery(topic, id);
  return s.call("POST", d.url, d.body, d.headers);
}

describe("Settings → Integrations, WooCommerce", () => {
  it("is ready: one press on the store's own Approve page, the shop's address filled in, the keys under More options", async () => {
    const s = await setup();
    const list = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as {
      cards: {
        id: string;
        status: string;
        line: string;
        ways: {
          preset: string | null;
          status: string;
          auth: string;
          action: string;
          again?: string;
          advanced?: boolean;
          consent?: string;
          before?: { key: string; value?: string }[];
          form: { key: string; secret: boolean; value?: string; steps?: string[] }[];
        }[];
      }[];
    };
    const card = list.cards.find((c) => c.id === "woocommerce");
    expect(card).toMatchObject({ status: "ready", line: "Catalogue in, paid at your checkout" });
    const [approve, keys] = card?.ways ?? [];
    expect(approve).toMatchObject({
      preset: null,
      status: "ready",
      auth: "oauth",
      action: "Connect your shop",
      again: "Approve again",
    });
    expect(approve?.consent).toBe(
      "WooCommerce will ask you to approve this inbox. It reads your products and stock, and only writes the orders you accept.",
    );
    expect(approve?.before).toEqual([expect.objectContaining({ key: "store_url", value: s.store.base })]);
    expect(keys).toMatchObject({ preset: "keys", status: "ready", auth: "form", advanced: true, action: "Connect" });
    expect(keys?.form.map((f) => [f.key, f.secret])).toEqual([
      ["store_url", false],
      ["consumer_key", true],
      ["consumer_secret", true],
    ]);
    expect(keys?.form[1]?.steps?.[0]).toBe("In WordPress: WooCommerce → Settings → Advanced → REST API → Add key.");
    // The keys way starts from the same address, filled in from the business's website.
    expect(keys?.form[0]).toMatchObject({
      key: "store_url",
      value: s.store.base,
      help: "Where your WordPress shop is.",
    });
  });

  it("offers one press only once the store can reach this inbox; the keys meanwhile, said so, and refused to start", async () => {
    const wait =
      "Your shop can send this inbox its key once the inbox is live at its own address. Until then, paste the keys.";
    // A hosted inbox not live yet, and an inbox with no https address of its own (one at a time: the
    // Workers runtime keeps one database per file).
    for (const opts of [{ policy: { hooksLive: false } }, { base: "http://127.0.0.1:8787" }]) {
      const s = await setup(opts);
      const list = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as {
        cards: { id: string; status: string; ways: { preset: string | null; status: string; untilLive?: string }[] }[];
      };
      const card = list.cards.find((c) => c.id === "woocommerce");
      expect(card?.status).toBe("ready");
      expect(card?.ways.map((w) => [w.preset, w.status, w.untilLive ?? null])).toEqual([
        [null, "setup", wait],
        ["keys", "ready", null],
      ]);
      const started = await s.call(
        "POST",
        "/v1/owner/integrations/authorize",
        { kind: "woocommerce", input: { store_url: s.store.base } },
        s.owner,
      );
      expect(started.status).toBe(403);
      expect(((await started.json()) as { detail: string }).detail).toBe(wait);
    }
  });
});

describe("connecting by the store's own Approve page", () => {
  it("takes the key the store POSTs once, checked, found by the owner's browser on the way back, and sealed", async () => {
    const s = await setup();
    const { approved, to, authorize_url } = await connectByApproving(s);
    expect(approved.posted).toBe(200);
    expect(to.pathname).toBe("/settings/integrations");
    const id = to.searchParams.get("connected") ?? "";
    // The callback was the inbox's own https address; the state goes back the same way.
    const q = new URL(authorize_url).searchParams;
    expect(q.get("callback_url")).toBe(`${BASE}/v1/hooks/woocommerce/authorized`);
    expect(q.get("scope")).toBe("read_write");
    const key = [...s.store.keys.entries()].find(([, v]) => v.description.startsWith("Agent inbox ("));
    expect(key?.[1].description).toBe(`Agent inbox (inbox.pizzaria-bixiga.example.com) - API (now)`);
    // The same POST again is refused: a state is used once.
    const replay = await s.call(
      "POST",
      "/v1/hooks/woocommerce/authorized",
      JSON.stringify({
        user_id: q.get("user_id"),
        consumer_key: key?.[0],
        consumer_secret: key?.[1].secret,
        key_permissions: "read_write",
      }),
    );
    expect(replay.status).toBe(400);

    const view = await s.call("GET", `/v1/owner/integrations/${id}`, undefined, s.owner);
    const text = await view.text();
    expect(JSON.parse(text)).toMatchObject({
      kind: "woocommerce",
      account: "pizzaria-bixiga.example.com",
      disconnect_note: "Then remove the key named Agent inbox in WooCommerce → Settings → Advanced → REST API.",
      notes: [],
    });

    expect(text).not.toContain(key?.[1].secret ?? "-");
    const { rows } = await s.db.client.query({
      sql: "SELECT config_enc, config_public FROM connectors",
      method: "all",
    });
    expect(JSON.stringify(rows)).not.toContain(key?.[1].secret ?? "-");
    expect(JSON.stringify(rows)).not.toContain(key?.[0] ?? "-");

    // The first sync: the store's name, its catalogue, and this inbox's webhooks at the connection's own address.
    await s.drain();
    const after = (await (await s.call("GET", `/v1/owner/integrations/${id}`, undefined, s.owner)).json()) as {
      account: string;
    };
    expect(after.account).toBe("Pizzaria Bixiga");
    expect([...s.store.webhooks.values()].map((w) => w.topic)).toEqual([
      "order.updated",
      "product.updated",
      "product.deleted",
    ]);
    for (const w of s.store.webhooks.values()) {
      expect(w.delivery_url).toMatch(
        /^https:\/\/inbox\.pizzaria-bixiga\.example\.com\/v1\/hooks\/woocommerce\/[A-Za-z0-9_-]{43}$/,
      );
    }
    const products = await productsOf(s.db);
    expect(products.map((p) => [p.externalId, p.name, p.price.value, p.price.currency, p.stock, p.active])).toEqual([
      ["p:11", "Pizza Margherita", 4_990, "BRL", 30, true],
      ["p:13", "Guaraná 350ml", 650, "BRL", null, false],
      ["v:22", "Pizza Calabresa – Grande", 6_900, "BRL", null, true],
    ]);
    expect(products.every((p) => p.source === "connector:woocommerce:pizzaria-bixiga.example.com")).toBe(true);
  });

  it("says plainly what went wrong when the owner declines, or the store's key does not check out, and keeps nothing", async () => {
    const s = await setup();
    const declined = await connectByApproving(s, { deny: true });
    expect(declined.to.searchParams.get("connect_error")).toBe(
      "Nothing was connected: you didn't approve this inbox in WooCommerce.",
    );
    // Back with no key and no decline (the store could not reach this inbox): said so, with the keys as the way.
    const started0 = await s.call(
      "POST",
      "/v1/owner/integrations/authorize",
      { kind: "woocommerce", input: { store_url: s.store.base } },
      s.owner,
    );
    const state0 = new URL(((await started0.json()) as { authorize_url: string }).authorize_url).searchParams.get(
      "user_id",
    );
    const lost = await s.call(
      "GET",
      `/oauth/connect/woocommerce/callback?state=${encodeURIComponent(state0 ?? "")}&success=1`,
    );
    expect(new URL(String(lost.headers.get("location")), BASE).searchParams.get("connect_error")).toBe(
      "Nothing was connected: your shop could not send this inbox its key. Try again, or paste the keys under More options.",
    );
    // A key the store can only read: refused, and the store deletes the key it made (no 200 came back).
    const started = await s.call(
      "POST",
      "/v1/owner/integrations/authorize",
      { kind: "woocommerce", input: { store_url: s.store.base } },
      s.owner,
    );
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const before = s.store.keys.size;
    const r = await s.store.approve(authorize_url, (url, body) => s.call("POST", url, body), { permissions: "read" });
    expect(r.posted).toBe(400);
    expect(s.store.keys.size).toBe(before);
    const { rows } = await s.db.client.query({ sql: "SELECT COUNT(*) FROM connectors", method: "all" });
    expect(Number(rows[0]?.[0])).toBe(0);
  });

  it("finds on the first sync a host that drops the Authorization header, and reads the catalogue the same run", async () => {
    const store = fakeWooStore();
    store.quirks.dropsAuthHeader = true;
    const s = await setup({ store });
    const id = await connected(s);
    const view = (await (await s.call("GET", `/v1/owner/integrations/${id}`, undefined, s.owner)).json()) as {
      status: string;
      catalogue: { products: number } | null;
    };
    expect(view).toMatchObject({ status: "active", catalogue: { products: 2 } });
    expect((await productsOf(s.db)).map((p) => [p.externalId, p.active])).toEqual([
      ["p:11", true],
      ["p:13", false],
      ["v:22", true],
    ]);
  });

  it("connects the same shop again in place when it is approved again: its webhooks kept, the earlier key said", async () => {
    const s = await setup();
    const id = await connected(s);
    const hooks = [...s.store.webhooks.values()].map((w) => [w.id, w.delivery_url]);
    expect(hooks).toHaveLength(3);
    const firstKey = [...s.store.keys.entries()].find(([, v]) => v.description.startsWith("Agent inbox ("))?.[0];
    const again = await connectByApproving(s);
    expect(again.to.searchParams.get("connected")).toBe(id);
    await s.drain();
    for (const ping of s.store.pings.splice(0)) await s.call("POST", ping.url, ping.body);
    // The same webhooks, at the same address, signed now with a new secret; no second set.
    expect([...s.store.webhooks.values()].map((w) => [w.id, w.delivery_url])).toEqual(hooks);
    const view = (await (await s.call("GET", `/v1/owner/integrations/${id}`, undefined, s.owner)).json()) as {
      notes: { text: string; href?: string }[];
    };
    expect(view.notes).toEqual([
      expect.objectContaining({
        text: "Your shop made this inbox a new key. Remove the earlier Agent inbox key in WooCommerce → Settings → Advanced → REST API.",
        href: expect.stringMatching(/\/wp-admin\/admin\.php\?page=wc-settings&tab=advanced&section=keys&edit-key=\d+$/),
      }),
    ]);
    expect(firstKey && s.store.keys.has(firstKey)).toBe(true);
    // A delivery signed with the new secret is taken.
    const margherita = (await productsOf(s.db)).find((p) => p.externalId === "p:11");
    expect(margherita?.active).toBe(true);
    const d = await s.store.delivery("product.updated", 11);
    expect((await s.call("POST", d.url, d.body, d.headers)).status).toBe(200);
  });

  it("is the owner's in person: a key handed to another system cannot start it", async () => {
    const s = await setup();
    const integration = {
      authorization: `Bearer ${(await createApiKey(s.db, { kind: "integration", name: "n8n" })).key}`,
    };
    const res = await s.call(
      "POST",
      "/v1/owner/integrations/authorize",
      { kind: "woocommerce", input: { store_url: s.store.base } },
      integration,
    );
    expect(res.status).toBe(403);
  });
});

describe("an order paid at the store's own checkout", () => {
  async function ordered(s: S) {
    const id = await connected(s);
    const margherita = (await productsOf(s.db)).find((p) => p.externalId === "p:11");
    const item = await acceptedOrder(s, [
      { productId: margherita?.id ?? "", name: "Pizza Margherita", quantity: 2, price: 4_990 },
    ]);
    await s.drain(60_000);
    const [wc] = [...s.store.orders.values()];
    if (!wc) throw new Error("no order in the store");
    return { connection: id, item, wc };
  }

  it("is written into the store, pending, and the customer is sent to the store's own checkout to pay", async () => {
    const s = await setup();
    const { item, wc } = await ordered(s);
    expect(wc).toMatchObject({ status: "pending", customer_note: "Sem cebola, por favor." });
    expect(wc.billing).toMatchObject({ first_name: "Ana Beatriz Souza", email: "ana.souza@example.com" });
    expect(wc.lines.map((l) => [l.product_id, l.quantity, l.total])).toEqual([[11, 2, 99.8]]);
    const url = `${s.store.base}/checkout/order-pay/${wc.id}/?pay_for_order=true&key=${wc.order_key}`;
    expect(await itemOf(s.db, item)).toMatchObject({ state: "awaiting_payment", payload: { paymentUrl: url } });
    expect(await paymentsOf(s, item)).toMatchObject([
      {
        state: "open",
        provider: "WooCommerce",
        url,
        dashboard_url: `${s.store.base}/wp-admin/post.php?post=${wc.id}&action=edit`,
      },
    ]);
    // The customer hears it from the business, with the store's own link to pay.
    const { rows } = await s.db.client.query({
      sql: "SELECT template, body_text FROM outbound_mail WHERE recipient = 'customer' AND item_id = ?",
      params: [item],
      method: "all",
    });
    expect(rows.some((r) => String(r[1]).includes(url))).toBe(true);
    expect(rows.every((r) => !/woocommerce|surfing dog/i.test(String(r[1])))).toBe(true);
  });

  it("is marked paid once the store, asked back, says so; the body is never believed, and the receipt says what was paid", async () => {
    const s = await setup();
    const { item, wc } = await ordered(s);
    // Signed with the webhook's secret, but saying what the store does not hold: nothing is marked.
    const d = await s.store.delivery("order.updated", wc.id, { deliveryId: "aa11bb22cc33dd44ee55ff6600778899" });
    const lying = JSON.stringify({
      ...(JSON.parse(d.body) as Record<string, unknown>),
      status: "processing",
      date_paid_gmt: "2026-10-20T12:00:00",
    });
    const secret = [...s.store.webhooks.values()][0]?.secret ?? "";
    const first = await s.call("POST", d.url, lying, {
      ...d.headers,
      "x-wc-webhook-signature": await hmacSha256Base64(secret, lying),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });
    await s.drain();
    expect((await itemOf(s.db, item)).state).toBe("awaiting_payment");
    // Kept as ids only, never what the store sent about the customer.
    const kept = await events(s.db);
    expect(kept.map((e) => e.topic)).toEqual(["order.updated"]);
    expect(kept[0]?.raw).toBe(JSON.stringify({ topic: "order.updated", refs: [String(wc.id)] }));
    expect(JSON.stringify(kept)).not.toContain("ana.souza");

    // The customer pays at the store's checkout; the store's next delivery, read back, marks it paid.
    s.store.pay(wc.id, "stripe", "pi_3Qx");
    const paid = await s.store.delivery("order.updated", wc.id);
    expect((await s.call("POST", paid.url, paid.body, paid.headers)).status).toBe(200);
    await s.drain();
    expect((await itemOf(s.db, item)).state).toBe("paid");
    expect(await paymentsOf(s, item)).toMatchObject([
      { state: "paid", payment_id: `order-${wc.id}`, method: "card", paid_amount: { value: 9_980, currency: "BRL" } },
    ]);
    const { rows: receipts } = await s.db.client.query({
      sql: "SELECT kind, payload FROM receipts WHERE item_id = ?",
      params: [item],
      method: "all",
    });
    const receipt = receipts.find((r) => r[0] === "paid");
    expect(JSON.parse(String(receipt?.[1]))).toMatchObject({
      knd: "paid",
      typ: "order",
      amt: { value: 9_980, currency: "BRL" },
    });

    // The same delivery again is counted once; one byte off is refused and writes nothing.
    const again = await s.call("POST", paid.url, paid.body, paid.headers);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    const tampered = await s.store.delivery("order.updated", wc.id, { tamper: true });
    expect((await s.call("POST", tampered.url, tampered.body, tampered.headers)).status).toBe(400);
    expect(await events(s.db)).toHaveLength(2);

    // Completed in the store: fulfilled here, by the connector.
    s.store.complete(wc.id);
    expect((await deliver(s, "order.updated", wc.id)).status).toBe(200);
    await s.drain();
    expect((await itemOf(s.db, item)).state).toBe("fulfilled");
    const { rows } = await s.db.client.query({
      sql: "SELECT actor_kind FROM item_events WHERE item_id = ? AND event = 'fulfil'",
      params: [item],
      method: "all",
    });
    expect(rows.map((r) => String(r[0]))).toEqual(["connector"]);
  });

  it("is found paid without a webhook too: the store is asked on each sync", async () => {
    const s = await setup();
    const { connection, item, wc } = await ordered(s);
    s.store.webhooks.clear();
    s.store.pay(wc.id, "ppcp-gateway", "8AB12345CD678901E");
    await s.inbox.caps.connectors.run(connection, Date.now() + 5 * 60_000, "sync");
    await s.drain();
    expect((await itemOf(s.db, item)).state).toBe("paid");
    expect((await paymentsOf(s, item))[0]).toMatchObject({ method: "paypal" });
  });

  it("is left to the owner when the shop cancels it unpaid: the link closes, the customer is not told it ended", async () => {
    const s = await setup();
    const { connection, item, wc } = await ordered(s);
    s.store.setStatus(wc.id, "cancelled");
    await s.inbox.caps.connectors.run(connection, Date.now() + 5 * 60_000, "sync");
    await s.drain(6 * 60_000);
    expect((await paymentsOf(s, item))[0]).toMatchObject({ state: "closed", note: "cancelled in WooCommerce" });
    expect((await itemOf(s.db, item)).state).toBe("awaiting_payment");
  });

  it("cancels the store's order when the owner cancels it here before it is paid", async () => {
    const s = await setup();
    const { item, wc } = await ordered(s);
    const res = await s.call(
      "POST",
      `/v1/owner/items/${item}/transitions`,
      { event: "cancel", input: { reason: "Sem massa hoje." } },
      s.owner,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    await s.drain(60_000);
    expect(s.store.orders.get(wc.id)?.status).toBe("cancelled");
  });
});

describe("a store that adds tax at its checkout", () => {
  it("holds the link, never asks for more than was accepted, and lets the owner propose the store's total", async () => {
    const store = fakeWooStore({ host: "maple-crust.example.ca", name: "Maple Crust Bakery", currency: "CAD" });
    Object.assign(store.settings, { calcTaxes: true, pricesIncludeTax: false, rate: 0.13 });
    const s = await setup({ store, currency: "CAD", timezone: "America/Toronto" });
    s.store.products.splice(0, s.store.products.length, simple(80, "Butter tarts (6)", "18.00"));
    await connected(s);
    const tarts = (await productsOf(s.db)).find((p) => p.externalId === "p:80");
    const item = await acceptedOrder(
      s,
      [{ productId: tarts?.id ?? "", name: "Butter tarts (6)", quantity: 1, price: 1_800 }],
      "CAD",
    );
    await s.drain(60_000);
    expect((await itemOf(s.db, item)).payload.paymentUrl).toBeUndefined();
    expect((await paymentsOf(s, item))[0]).toMatchObject({
      state: "held",
      url: null,
      shop_total: { value: 2_034, currency: "CAD" },
      propose_shop_total: true,
    });
    const proposed = await s.call("POST", `/v1/owner/items/${item}/payments/shop-total`, undefined, s.owner);
    expect(proposed.status, await proposed.clone().text()).toBe(200);
    const q = `access_token=${tokens.get(item)}`;
    const status = (await (await s.call("GET", `/v1/items/${item}?${q}`)).json()) as {
      offer: { id: string; terms_sha: string };
    };
    const accepted = await s.call("POST", `/v1/items/${item}/accept?${q}`, {
      offer_id: status.offer.id,
      terms_sha: status.offer.terms_sha,
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    await s.drain(60_000);
    // The held order is cancelled in the store; the new one has the product lines only, and comes to the accepted total.
    const orders = [...s.store.orders.values()];
    expect(orders.map((o) => o.status)).toEqual(["cancelled", "pending"]);
    expect(orders[1]?.lines.map((l) => [l.kind, l.total])).toEqual([["line_items", 18]]);
    expect(await itemOf(s.db, item)).toMatchObject({ state: "awaiting_payment" });
    expect((await paymentsOf(s, item))[0]).toMatchObject({ state: "open", amount: { value: 2_034, currency: "CAD" } });
  });
});

describe("disconnecting", () => {
  it("takes this inbox's webhooks out of the store and its products off sale; the key is left for the owner to remove", async () => {
    const s = await setup();
    const id = await connected(s);
    expect(s.store.webhooks.size).toBe(3);
    const res = await s.call("DELETE", `/v1/owner/integrations/${id}`, undefined, s.owner);
    expect(res.status, await res.clone().text()).toBe(200);
    await s.drain();
    expect(s.store.webhooks.size).toBe(0);
    expect((await productsOf(s.db)).every((p) => !p.active)).toBe(true);
    // WooCommerce gives no way to take a key back over its API: it is still there for the owner to remove.
    expect([...s.store.keys.values()].some((k) => k.description.startsWith("Agent inbox ("))).toBe(true);
  });
});
