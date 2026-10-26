import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it, vi } from "vitest";
import { fakePlatform } from "../../../packages/adapters/test/fakes/platform";
import { deliverectStatus, fakeDeliverect, fakeToast } from "../../../packages/adapters/test/fakes/pos";
import { STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { DELIVERECT_LINK, DELIVERECT_PARTNER, TOAST_PARTNER } from "../../../packages/adapters/test/fixtures/pos";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";
import { stripePlatform } from "./pay-platforms";

/**
 * The food doors (ADR-040) as an agent and the owner meet them, on both runtimes: get_menu and
 * list_order_slots over MCP, an order for a time with its options, delivery and tip confirmed at the
 * confirm step and written; its pay link on the business's own Stripe in won and in yen, whole units;
 * the owner's menu and allergen confirm, and the pause; an accepted order written into Toast and Toast's
 * refusal read back for a person; Deliverect's signed status becoming the order's progress.
 * Seoul Crunch Chicken (Busan, KRW), Hokuto Bakery (Sapporo, JPY), Pizzería Volcán (Mexico City, MXN).
 */

vi.setConfig({ testTimeout: 60_000 });

const BASE = "https://kitchen.example";
const SECRET_KEY = "food-doors-secret-key-0123456789abcdef";
const ALL_DAY = [["00:00", "24:00"]];

async function setup(o: {
  name: string;
  currency: string;
  timezone: string;
  language: string;
  kitchen?: Record<string, unknown>;
  area?: Record<string, unknown>;
}) {
  const db = await freshDb();
  const stripe = stripePlatform(STRIPE_LIVE_KEY, BASE);
  const tills = fakePlatform();
  const toast = fakeToast(tills);
  const deliverect = fakeDeliverect(tills);
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    pos: { toast: TOAST_PARTNER, deliverect: DELIVERECT_PARTNER },
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).host === "api.stripe.com"
        ? stripe.fetch(input, init)
        : tills.fetch(input, init)) as typeof fetch,
  });
  await db.client.query({
    sql: "INSERT OR REPLACE INTO business (id, name, timezone, currency, languages, created_at, updated_at) VALUES ('self', ?, ?, ?, ?, ?, ?)",
    params: [o.name, o.timezone, o.currency, JSON.stringify([o.language]), Date.now(), Date.now()],
    method: "run",
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const owner = { authorization: `Bearer ${ownerKey}` };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const saved = await call(
    "PUT",
    "/v1/owner/settings",
    {
      doc: {
        business: { name: o.name, currency: o.currency, timezone: o.timezone, languages: [o.language] },
        notifications: { ownerEmail: "kitchen@kitchen.example", appUrl: BASE },
        kitchen: { enabled: true, prepMin: 20, slotMin: 15, perSlot: 6, accept: "caps", ...(o.kitchen ?? {}) },
        ...(o.area ? { area: o.area } : {}),
      },
    },
    owner,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  const hours = await call(
    "PUT",
    "/v1/owner/availability",
    { weekly: { mon: ALL_DAY, tue: ALL_DAY, wed: ALL_DAY, thu: ALL_DAY, fri: ALL_DAY, sat: ALL_DAY, sun: ALL_DAY } },
    owner,
  );
  expect(hours.status, await hours.clone().text()).toBe(200);
  const drain = async () => {
    await Promise.all(pending);
    for (let pass = 0; pass < 20; pass++) {
      if ((await inbox.runner.runDue(db, { now: Date.now() })).claimed === 0) return;
    }
    throw new Error("the outbox never settled");
  };
  return { db, inbox, call, owner, stripe, toast, deliverect, drain };
}
type S = Awaited<ReturnType<typeof setup>>;

async function dish(s: S, name: string, price: { value: number; currency: string }, menu: Record<string, unknown>) {
  const made = await s.call("POST", "/v1/owner/products", { name, price, active: true }, s.owner);
  expect(made.status, await made.clone().text()).toBe(201);
  const p = (await made.json()) as { id: string };
  const put = await s.call(
    "PUT",
    `/v1/owner/menu/items/${p.id}`,
    { menu: { allergens: { contains: [], mayContain: [] }, ...menu } },
    s.owner,
  );
  expect(put.status, await put.clone().text()).toBe(200);
  const item = (await put.json()) as { fingerprint: string };
  const ok = await s.call(
    "POST",
    `/v1/owner/menu/items/${p.id}/allergens/confirm`,
    { fingerprint: item.fingerprint },
    s.owner,
  );
  expect(ok.status, await ok.clone().text()).toBe(200);
  return p.id;
}

async function mcp(s: S) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> =>
    s.inbox.app.request(String(input), init);
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: fetchLike }));
  return client;
}

/** Tomorrow in the business's zone: a whole day of slots, whatever the hour the test runs at. */
const tomorrowIn = (zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + 86_400_000),
  );

async function slot(s: S, zone: string, query = "method=pickup"): Promise<string> {
  const r = await s.call("GET", `/v1/order-slots?date=${tomorrowIn(zone)}&${query}`);
  expect(r.status, await r.clone().text()).toBe(200);
  const body = (await r.json()) as { slots: { start: string }[] };
  return body.slots[0]?.start as string;
}

async function order(s: S, payload: Record<string, unknown>) {
  const first = await s.call("POST", "/v1/orders", {
    payload,
    contact: { name: "Minji Park", email: `m${Math.random().toString(36).slice(2, 8)}@example.com` },
  });
  expect(first.status, await first.clone().text()).toBe(409);
  const terms = ((await first.json()) as { details?: { terms_sha?: string; summary?: string } }).details;
  const made = await s.call("POST", "/v1/orders", {
    payload,
    contact: { name: "Minji Park", email: `m${Math.random().toString(36).slice(2, 8)}@example.com` },
    terms_sha: terms?.terms_sha,
  });
  expect(made.status, await made.clone().text()).toBe(201);
  return { summary: terms?.summary ?? "", item: ((await made.json()) as { view: { item: { id: string } } }).view.item };
}

const crunch = () =>
  setup({
    name: "Seoul Crunch Chicken",
    currency: "KRW",
    timezone: "Asia/Seoul",
    language: "en",
    kitchen: { methods: { pickup: true, delivery: true }, tips: { enabled: true, choices: [0, 5, 10] } },
    area: {
      mode: "anywhere",
      zones: [
        {
          name: "Haeundae",
          mode: "postal",
          postal: [{ country: "KR", prefix: "48" }],
          fee: { value: 3000, currency: "KRW" },
          etaMin: 40,
        },
      ],
    },
  });

describe("get_menu and list_order_slots over MCP, and an order for a time", () => {
  it("lists the menu with allergens' status, the slots and the zone, and takes an order with options, delivery and a tip", async () => {
    const s = await crunch();
    const id = await dish(
      s,
      "Yangnyeom chicken",
      { value: 19000, currency: "KRW" },
      {
        section: "chicken",
        allergens: { contains: ["wheat", "soy", "sesame"], mayContain: [] },
        optionGroups: [
          {
            id: "spice",
            name: "Spice",
            min: 1,
            max: 1,
            choices: [
              { id: "mild", name: "Mild", default: true },
              { id: "hot", name: "Hot", priceDelta: 1000 },
            ],
          },
        ],
      },
    );
    const client = await mcp(s);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_menu", "list_order_slots", "create_order"]));
    const menu = (await client.callTool({ name: "get_menu", arguments: {} })) as {
      structuredContent: { sections: { items: { name: string; allergens: { status: string } }[] }[] };
    };
    expect(menu.structuredContent.sections[0]?.items[0]).toMatchObject({
      name: "Yangnyeom chicken",
      allergens: { status: "confirmed" },
    });
    const slots = (await client.callTool({
      name: "list_order_slots",
      arguments: { date: tomorrowIn("Asia/Seoul"), method: "delivery", postal_code: "48058", country: "KR" },
    })) as { structuredContent: { answer: string; zone: { name: string }; slots: { start: string }[] } };
    expect(slots.structuredContent).toMatchObject({ answer: "open", zone: { name: "Haeundae" } });
    const start = slots.structuredContent.slots[0]?.start;
    const { summary, item } = await order(s, {
      orderedItem: [
        {
          productId: id,
          name: "Chicken",
          quantity: 1,
          price: { value: 19000, currency: "KRW" },
          options: [{ groupId: "spice", choiceId: "hot" }],
        },
      ],
      totalPrice: { value: 19000, currency: "KRW" },
      fulfil: { method: "delivery", slot: { start } },
      shippingAddress: {
        streetAddress: "Haeundae-ro 1",
        addressLocality: "Busan",
        postalCode: "48058",
        addressCountry: "KR",
      },
      tip: { percent: 10 },
    });
    expect(summary).toContain("1 × Yangnyeom chicken (Hot)");
    expect(summary).toContain("Delivery (Haeundae)");
    expect(summary).toContain("Tip");
    const got = await s.call("GET", `/v1/owner/items/${item.id}`, undefined, s.owner);
    const view = (await got.json()) as {
      item: { payload: { totalPrice: { value: number }; kitchen: { instant: boolean } } };
    };
    expect(view.item.payload.totalPrice.value).toBe(20000 + 3000 + 2000);
    expect(view.item.payload.kitchen.instant).toBe(true);
    await client.close();
  });
});

describe("a restaurant that takes its orders on its own site (doors elsewhere)", () => {
  it("still shows its menu to agents, and sends them to its site to order, with no slot offered here", async () => {
    const s = await crunch();
    await s.db.client.query({ sql: "UPDATE business SET domain = 'seoulcrunch.kr'", params: [], method: "run" });
    await dish(s, "Yangnyeom chicken", { value: 19000, currency: "KRW" }, { section: "chicken" });
    const saved = await s.call(
      "PUT",
      "/v1/owner/settings",
      { doc: { doorsElsewhere: [{ itemType: "order", url: "https://seoulcrunch.kr/order" }] } },
      s.owner,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    const client = await mcp(s);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_menu");
    expect(names).not.toContain("list_order_slots");
    const said = client.getInstructions() ?? "";
    expect(said).toContain("get_menu");
    expect(said).toContain("https://seoulcrunch.kr/order");
    expect(said).not.toContain("list_order_slots");
    expect(said).not.toContain("payload.fulfil");
    await client.close();
    // REST answers the same: no slot for an order the business takes elsewhere.
    const r = await s.call("GET", `/v1/order-slots?date=${tomorrowIn("Asia/Seoul")}&method=pickup`);
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as { answer: string; slots: unknown[]; words: string };
    expect(body).toMatchObject({ answer: "closed", slots: [] });
    expect(body.words).toContain("https://seoulcrunch.kr/order");
  });
});

describe("pay links in won and in yen", () => {
  for (const c of [
    { name: "Seoul Crunch Chicken", currency: "KRW", zone: "Asia/Seoul", dish: "Fried chicken", price: 18000, qty: 1 },
    { name: "Hokuto Bakery", currency: "JPY", zone: "Asia/Tokyo", dish: "Melon pan", price: 280, qty: 2 },
  ]) {
    it(`asks Stripe for ${c.currency} in whole units, on the business's own account`, async () => {
      const s = await setup({ name: c.name, currency: c.currency, timezone: c.zone, language: "en" });
      const connected = await s.call(
        "POST",
        "/v1/owner/integrations",
        { kind: "stripe", values: { api_key: STRIPE_LIVE_KEY } },
        s.owner,
      );
      expect(connected.status, await connected.clone().text()).toBe(201);
      const id = await dish(s, c.dish, { value: c.price, currency: c.currency }, { section: "menu" });
      const start = await slot(s, c.zone);
      const { item } = await order(s, {
        orderedItem: [
          { productId: id, name: c.dish, quantity: c.qty, price: { value: c.price, currency: c.currency } },
        ],
        totalPrice: { value: c.price * c.qty, currency: c.currency },
        fulfil: { method: "pickup", slot: { start } },
      });
      const accepted = await s.call("POST", `/v1/owner/items/${item.id}/transitions`, { event: "accept" }, s.owner);
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      await s.drain();
      const links = [...s.stripe.links.values()];
      expect(links).toHaveLength(1);
      expect([links[0]?.amount, links[0]?.currency]).toEqual([c.price * c.qty, c.currency.toLowerCase()]);
    });
  }
});

describe("the owner's menu, allergens and pause through REST", () => {
  it("confirms allergens only with a person's key, and pauses orders for agents to read", async () => {
    const s = await crunch();
    const made = await s.call(
      "POST",
      "/v1/owner/products",
      { name: "Garlic chicken", price: { value: 20000, currency: "KRW" }, active: true },
      s.owner,
    );
    const p = (await made.json()) as { id: string };
    const put = await s.call(
      "PUT",
      `/v1/owner/menu/items/${p.id}`,
      { menu: { section: "chicken", allergens: { contains: ["wheat"], mayContain: ["peanuts"] } } },
      s.owner,
    );
    const item = (await put.json()) as { fingerprint: string; menu: { allergens: { status: string } } };
    expect(item.menu.allergens.status).toBe("unconfirmed");
    const tool = (await createApiKey(s.db, { kind: "integration", name: "A till", scopes: ["*"] })).key;
    const refused = await s.call(
      "POST",
      `/v1/owner/menu/items/${p.id}/allergens/confirm`,
      { fingerprint: item.fingerprint },
      { authorization: `Bearer ${tool}` },
    );
    expect(refused.status).toBe(403);
    const ok = await s.call(
      "POST",
      `/v1/owner/menu/items/${p.id}/allergens/confirm`,
      { fingerprint: item.fingerprint },
      s.owner,
    );
    expect(((await ok.json()) as { menu: { allergens: { status: string } } }).menu.allergens.status).toBe("confirmed");
    const paused = await s.call("POST", "/v1/owner/kitchen/pause", { rest_of_day: true }, s.owner);
    expect(paused.status, await paused.clone().text()).toBe(200);
    const profile = (await (await s.call("GET", "/v1/business")).json()) as { kitchen?: { paused_until?: string } };
    expect(profile.kitchen?.paused_until).toBeDefined();
    await s.call("POST", "/v1/owner/kitchen/pause", { resume: true }, s.owner);
    expect(
      ((await (await s.call("GET", "/v1/owner/kitchen", undefined, s.owner)).json()) as { paused_until: string | null })
        .paused_until,
    ).toBeNull();
  });
});

describe("the kitchen's own tills", () => {
  it("brings in Toast's menu, writes an accepted order into Toast, and puts Toast's refusal before a person", async () => {
    const s = await setup({
      name: "Pizzería Volcán",
      currency: "MXN",
      timezone: "America/Mexico_City",
      language: "es",
    });
    const c = await s.call("POST", "/v1/owner/integrations", { kind: "toast", values: {} }, s.owner);
    expect(c.status, await c.clone().text()).toBe(201);
    const conn = (await c.json()) as { id: string };
    const imported = await s.call(
      "POST",
      "/v1/owner/menu/import",
      { connection_id: conn.id, items: ["22222222-0000-4000-8000-000000000001"] },
      s.owner,
    );
    expect(await imported.json()).toEqual({ kept: 1, updated: 0 });
    const menu = (await (await s.call("GET", "/v1/owner/menu", undefined, s.owner)).json()) as {
      items: {
        product: { id: string; source: string };
        menu: { allergens: { status: string; source?: string } };
        fingerprint: string;
      }[];
    };
    const pizza = menu.items.find((i) => i.product.source === "toast");
    expect(pizza?.menu.allergens).toMatchObject({ status: "unconfirmed", source: "toast" });
    await s.call(
      "POST",
      `/v1/owner/menu/items/${pizza?.product.id}/allergens/confirm`,
      { fingerprint: pizza?.fingerprint },
      s.owner,
    );
    const start = await slot(s, "America/Mexico_City");
    const { item } = await order(s, {
      orderedItem: [
        {
          productId: pizza?.product.id,
          name: "Pizza",
          quantity: 1,
          price: { value: 19900, currency: "MXN" },
          options: [{ groupId: "g1", choiceId: "c1" }],
        },
      ],
      totalPrice: { value: 23400, currency: "MXN" },
      fulfil: { method: "pickup", slot: { start } },
    });
    await s.call("POST", `/v1/owner/items/${item.id}/transitions`, { event: "accept" }, s.owner);
    await s.drain();
    const sent = s.toast.orders.get("ord-1")?.sent as
      | { checks: { selections: { item: { guid: string }; itemGroup: { guid: string }; modifiers: unknown[] }[] }[] }
      | undefined;
    expect(sent?.checks[0]?.selections[0]?.item.guid).toBe("22222222-0000-4000-8000-000000000001");
    // The menu group and the option group came in with the menu, and go out with the order.
    expect(sent?.checks[0]?.selections[0]?.itemGroup.guid).toBe("11111111-0000-4000-8000-000000000001");
    expect(sent?.checks[0]?.selections[0]?.modifiers).toEqual([
      {
        item: { guid: "44444444-0000-4000-8000-000000000001", entityType: "MenuItem" },
        optionGroup: { guid: "33333333-0000-4000-8000-000000000001", entityType: "MenuOptionGroup" },
        quantity: 1,
      },
    ]);
    s.toast.approve("ord-1", "NOT_APPROVED");
    await s.inbox.caps.connectors.run(conn.id, Date.now(), "sync");
    const got = (await (await s.call("GET", `/v1/owner/items/${item.id}`, undefined, s.owner)).json()) as {
      item: { flags: { needsHuman: boolean } };
      thread: { body_text?: string; body?: string }[];
    };
    expect(got.item.flags.needsHuman).toBe(true);
    expect(JSON.stringify(got.thread)).toContain("Toast did not take this order");
  });

  it("takes Deliverect's signed word on an order it was given: ready becomes the order's progress", async () => {
    const s = await setup({ name: "Seoul Crunch Chicken", currency: "KRW", timezone: "Asia/Seoul", language: "en" });
    const c = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "deliverect", values: { channelLinkId: DELIVERECT_LINK } },
      s.owner,
    );
    expect(c.status, await c.clone().text()).toBe(201);
    const conn = (await c.json()) as { id: string };
    const id = await dish(s, "Fried chicken", { value: 18000, currency: "KRW" }, { section: "chicken" });
    await s.db.client.query({
      sql: "UPDATE products SET source = 'deliverect', external_id = 'PLU-CHK-1' WHERE id = ?",
      params: [id],
      method: "run",
    });
    const start = await slot(s, "Asia/Seoul");
    const { item } = await order(s, {
      orderedItem: [{ productId: id, name: "Chicken", quantity: 1, price: { value: 18000, currency: "KRW" } }],
      totalPrice: { value: 18000, currency: "KRW" },
      fulfil: { method: "pickup", slot: { start } },
    });
    await s.call("POST", `/v1/owner/items/${item.id}/transitions`, { event: "accept" }, s.owner);
    await s.drain();
    const [channelOrderId] = [...s.deliverect.orders.keys()];
    expect(channelOrderId).toBeDefined();
    const { rows } = await s.db.client.query({
      sql: "SELECT config_public FROM connectors WHERE id = ?",
      params: [conn.id],
      method: "all",
    });
    const hook = (JSON.parse(String(rows[0]?.[0])) as { extra: { hook_url: string } }).extra.hook_url;
    const signed = await deliverectStatus(channelOrderId as string, 70, DELIVERECT_LINK);
    const res = await s.inbox.app.request(
      new Request(hook, { method: "POST", headers: signed.headers, body: signed.body }),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    await s.drain();
    const got = (await (await s.call("GET", `/v1/owner/items/${item.id}`, undefined, s.owner)).json()) as {
      item: { state: string; payload: { progress?: { stage: string } } };
    };
    expect([got.item.state, got.item.payload.progress?.stage]).toEqual(["fulfilling", "ready"]);
  });
});
