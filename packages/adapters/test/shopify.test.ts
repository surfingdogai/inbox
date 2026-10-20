import {
  type ConnectContext,
  type Connected,
  ConnectorError,
  describeForm,
  gallery,
  type InboundRequest,
  type PayLinkRequest,
  type RunContext,
  type ShopOrder,
} from "@surfingdog/core";
import { beforeEach, describe, expect, it } from "vitest";
import { forgetBuckets, MAX_WAIT_MS } from "../src/connectors/shopify/index";
import {
  builtInConnectors,
  SHOPIFY_API_VERSION,
  SHOPIFY_HOOK_FIELDS,
  SHOPIFY_SCOPES,
  SHOPIFY_TOPICS,
  shopDomainOf,
  shopifyConnector,
  shopifyForm,
} from "../src/index";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  type FakeShopify,
  fakeShopify,
  LEGACY_TOKEN,
  OPERATOR,
  orderBody,
  stockFlorist,
  toGid,
} from "./fixtures/shopify";

/**
 * Contract tests for the Shopify connector (ADR-028) against a made-up shop answering as Shopify's
 * Admin API 2026-10 documents it (`fixtures/shopify.ts`), through the inbox's own connector client:
 * what is asked of Shopify, with which token and variables, and what the inbox makes of the answer.
 * Above all: the keys go to the shop's own `.myshopify.com` address and nowhere else, a webhook is
 * believed only once its signature checks out and Shopify, asked back, says the same, and the shop's
 * total is read from Shopify, never assumed. No real shop is called.
 */

const NOW = Date.parse("2026-10-20T14:00:00Z");
const HOOK_URL = "https://inbox.xochitl.example.mx/v1/hooks/shopify/Zt3kP9wQe7RmX2vB8nYc4LsA1dF6gH0jK5uI9oTp3qE";
const INBOX = {
  id: "9c3e1f0a7b2d4e6f8a1c",
  origin: "https://inbox.xochitl.example.mx",
  host: "inbox.xochitl.example.mx",
  name: "Florería Xóchitl",
  timezone: "America/Mexico_City",
  language: "es-MX",
};
const noSleep = { sleep: async () => {} };
const slept: number[] = [];
const recordSleep = { sleep: async (ms: number) => void slept.push(ms) };

beforeEach(() => {
  forgetBuckets();
  slept.length = 0;
});

function connectCtx(s: FakeShopify, over: Partial<ConnectContext> = {}): ConnectContext {
  return { http: s.platform.http, now: NOW, inbox: INBOX, hookUrl: HOOK_URL, ...over };
}

const KEYS = { store: "xochitl-flores.myshopify.com", client_id: CLIENT_ID, client_secret: CLIENT_SECRET };

/** A run's context for what a connect made, whose saved secret the next run sees. */
function runner(s: FakeShopify, made: Connected, over: Partial<RunContext> = {}) {
  const held = { secret: { ...made.secret } as Record<string, string>, saved: 0 };
  const ctx = (more: Partial<RunContext> = {}): RunContext => ({
    http: s.platform.http,
    now: NOW,
    inbox: INBOX,
    hookUrl: HOOK_URL,
    secret: held.secret,
    extra: (made.extra ?? {}) as Record<string, unknown>,
    calendars: [],
    busyCalendars: [],
    destinations: [],
    destination: null,
    own: { ids: new Set(), spans: [] },
    marker: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    saveSecret: async (next) => {
      held.secret = { ...next };
      held.saved++;
    },
    ...over,
    ...more,
  });
  return { ctx, held };
}

async function connected(
  s: FakeShopify,
  over: Partial<ConnectContext> = {},
  opts: { readonly sleep: (ms: number) => Promise<void> } = noSleep,
) {
  const def = shopifyConnector(null, opts);
  const made = await def.connect?.(connectCtx(s, over), KEYS);
  if (!made) throw new Error("not connected");
  await made.settle?.(true);
  return { def, made, ...runner(s, made) };
}

const inbound = (d: { body: string; headers: Record<string, string> }): InboundRequest => ({
  headers: new Headers(d.headers),
  body: d.body,
  query: new URLSearchParams(),
});

async function refusal(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const ORDER: ShopOrder = {
  lines: [
    {
      externalId: toGid("ProductVariant", 41_001),
      sku: "CEM-RAMO",
      name: "Ramo de cempasúchil",
      quantity: 2,
      unit: { value: 42_000, currency: "MXN" },
    },
    {
      externalId: null,
      sku: null,
      name: "Tarjeta escrita a mano",
      quantity: 1,
      unit: { value: 5_000, currency: "MXN" },
    },
  ],
  charges: null,
  total: { value: 89_000, currency: "MXN" },
  delivery: "delivery",
  when: "2026-11-01",
  customer: {
    name: "Itzel Hernández Ruiz",
    email: "itzel.hernandez@example.mx",
    phone: "+52 951 123 4567",
    language: "es-MX",
  },
  shipping: {
    streetAddress: "Calle Macedonio Alcalá 402",
    addressLocality: "Oaxaca de Juárez",
    addressRegion: "OAX",
    postalCode: "68000",
    addressCountry: "MX",
  },
  billing: null,
  note: "Para el altar de mi abuela, por favor.",
};

const REQUEST: PayLinkRequest = {
  ref: "01JC0SHOPREF00000000000001",
  itemId: "01JC0ORDER00000000000XK7Q2",
  amount: { value: 89_000, currency: "MXN" },
  title: "Ramo de cempasúchil and 1 more (XK7Q2M)",
  reference: "XK7Q2M",
  language: "es",
  thanks: "Gracias",
  inactive: "Ya no",
  hookUrl: "",
  order: ORDER,
};

describe("the form and the gallery", () => {
  it("asks for the app's two keys first, with how to make the app, then the shop; the old token is under More options", () => {
    const form = describeForm(shopifyForm);
    expect(form.map((f) => [f.key, f.secret, f.advanced, f.required])).toEqual([
      ["client_id", false, false, true],
      ["client_secret", true, false, true],
      ["store", false, false, true],
      ["access_token", true, true, false],
    ]);
    const id = form.find((f) => f.key === "client_id");
    expect(id?.help).toBe("Make a small app for your shop in Shopify's Dev Dashboard:");
    expect(id?.steps).toHaveLength(4);
    expect(id?.steps?.join(" ")).toContain("read_products, read_orders and write_draft_orders");
    // No variable names, no URL to type: the App URL Shopify suggests is kept.
    expect(JSON.stringify(form)).not.toMatch(/SHOPIFY_|default-app-home/);
    expect(form.find((f) => f.key === "access_token")?.help).toContain("API key as the Client ID");
    expect(id?.link?.href).toBe("https://dev.shopify.com/dashboard/");
    expect(SHOPIFY_SCOPES).toEqual(["read_products", "read_orders", "write_draft_orders"]);
    expect(SHOPIFY_API_VERSION).toBe("2026-10");
  });

  it("is a ready card with one way, the keys; Sign in with Shopify shows only where the server has its own app", () => {
    const card = (defs: ReturnType<typeof builtInConnectors>) =>
      gallery(new Map(defs.map((d) => [d.kind, d]))).find((c) => c.id === "shopify");
    for (const own of [card(builtInConnectors()), card(builtInConnectors({ hosted: true }))]) {
      expect(own).toMatchObject({ status: "ready", group: "shops", line: "Catalogue in, paid at your checkout" });
      // Nothing to press is not shown: no "set up", no "Soon", no variable names.
      expect(own?.ways.map((w) => [w.label, w.status, w.auth, w.action])).toEqual([
        ["Your app's keys", "ready", "form", "Connect"],
      ]);
      expect(JSON.stringify(own)).not.toContain("SHOPIFY_");
    }
    const withApp = card(builtInConnectors({ oauth: { shopify: OPERATOR } }));
    expect(withApp?.ways.map((w) => [w.label, w.status, w.auth])).toEqual([
      ["Your app's keys", "ready", "form"],
      ["Sign in with Shopify", "ready", "oauth"],
    ]);
    expect(withApp?.ways[1]?.before?.map((f) => f.key)).toEqual(["store"]);
  });

  it("takes the shop's address as people have it, and nothing that is not Shopify's own", () => {
    for (const typed of [
      "xochitl-flores.myshopify.com",
      "https://xochitl-flores.myshopify.com/",
      "https://xochitl-flores.myshopify.com/admin/orders",
      "admin.shopify.com/store/xochitl-flores",
      "https://admin.shopify.com/store/xochitl-flores/products?x=1",
      "Xochitl-Flores",
    ]) {
      expect(shopDomainOf(typed), typed).toBe("xochitl-flores.myshopify.com");
    }
    for (const typed of [
      "http://xochitl-flores.myshopify.com",
      "https://xochitl.example.mx",
      "xochitl-flores.myshopify.com.attacker.example",
      "10.0.0.7",
      "https://169.254.169.254/latest",
      "",
    ]) {
      expect(shopDomainOf(typed), typed).toBeNull();
    }
    expect(
      shopifyForm.safeParse({ ...KEYS, store: "http://xochitl-flores.myshopify.com" }).error?.issues[0]?.message,
    ).toBe("Shopify shops are reached over https.");
    expect(shopifyForm.safeParse({ ...KEYS, store: "xochitl.example.mx" }).error?.issues[0]?.message).toContain(
      ".myshopify.com",
    );
  });
});

describe("connecting with the app's keys", () => {
  it("gets a 24-hour token by the client credentials grant, reads the shop, and makes its webhooks at the connection's own address", async () => {
    const s = fakeShopify();
    const { made } = await connected(s);
    const [grant] = s.platform.requests("POST", `https://${s.shop}/admin/oauth/access_token`);
    expect(grant?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(grant?.body ?? ""))).toEqual({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    // Every request went to the shop's own address at Shopify, and nowhere else.
    expect(s.platform.seen.every((r) => r.url.host === s.shop)).toBe(true);
    expect(s.operations[0]?.name).toBe("InboxShop");
    expect(made).toMatchObject({
      account: "Florería Xóchitl · xochitl-flores.myshopify.com",
      externalId: "gid://shopify/Shop/64120557901",
      mode: "live",
      extra: {
        shop: "xochitl-flores.myshopify.com",
        storefront: "https://xochitl.example.mx",
        currency: "MXN",
        taxes_included: true,
        api_version: "2026-10",
        webhook: "added",
        hook_origin: "https://inbox.xochitl.example.mx",
      },
    });
    // The webhooks' address holds the connection's own token: never kept where it can be read.
    expect(JSON.stringify(made.extra)).not.toContain(HOOK_URL.split("/").at(-1));
    expect(made.secret).toMatchObject({ way: "keys", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    expect(Number(made.secret.expires_at)).toBe(NOW + 86_399_000);
    // Nothing secret is kept where it is shown.
    expect(JSON.stringify(made.extra)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(made.extra)).not.toContain("shpat_");
    // One webhook per topic, each at the connection's own address.
    expect([...s.hooks.values()].map((h) => h.topic).sort()).toEqual(Object.values(SHOPIFY_TOPICS).sort());
    expect([...s.hooks.values()].every((h) => h.uri === HOOK_URL)).toBe(true);
    // Each carries only ids, and for an order what tells the inbox's own: never a customer's details.
    expect(
      s.operations
        .filter((o) => o.name === "InboxHookCreate")
        .map((o) => [o.variables.topic, o.variables.webhookSubscription]),
    ).toEqual(Object.values(SHOPIFY_TOPICS).map((t) => [t, { uri: HOOK_URL, includeFields: SHOPIFY_HOOK_FIELDS[t] }]));
    expect(SHOPIFY_HOOK_FIELDS.ORDERS_UPDATED).toEqual(["id", "admin_graphql_api_id", "source_name", "tags"]);
    expect(SHOPIFY_HOOK_FIELDS.REFUNDS_CREATE).toEqual(["order_id"]);
  });

  it("takes an app whose shop lists only the write scope: a write scope includes its read", async () => {
    const s = fakeShopify();
    s.scopes = ["write_products", "write_orders", "write_draft_orders"];
    const { made } = await connected(s);
    expect(made.extra).toMatchObject({ webhook: "added" });
    const partial = fakeShopify();
    partial.scopes = ["write_products", "write_draft_orders"];
    const e = await refusal(shopifyConnector(null, noSleep).connect?.(connectCtx(partial), KEYS) as Promise<Connected>);
    expect(e.message).toBe(
      "The app is missing read_orders. Add it on the app's Versions page, release, and approve it in Shopify.",
    );
  });

  it("says what is wrong in the owner's words, on the field to fix", async () => {
    const def = shopifyConnector(null, noSleep);
    const wrongSecret = fakeShopify();
    wrongSecret.client.secret = "shpss_another";
    const e1 = await refusal(def.connect?.(connectCtx(wrongSecret), KEYS) as Promise<Connected>);
    expect([e1.code, e1.field]).toEqual(["auth", "client_secret"]);

    const elsewhere = fakeShopify();
    elsewhere.sameOrganization = false;
    const e2 = await refusal(def.connect?.(connectCtx(elsewhere), KEYS) as Promise<Connected>);
    expect([e2.code, e2.field]).toEqual(["config", "store"]);
    expect(e2.message).toBe(
      "This app can't reach xochitl-flores.myshopify.com. Check the shop address, and that you made the app with the account that owns this shop and installed it there.",
    );

    const noShop = fakeShopify();
    const e3 = await refusal(
      def.connect?.(connectCtx(noShop), { ...KEYS, store: "nadie-aqui.myshopify.com" }) as Promise<Connected>,
    );
    expect([e3.code, e3.field]).toEqual(["config", "store"]);

    const narrow = fakeShopify();
    narrow.scopes = ["read_products"];
    const e4 = await refusal(def.connect?.(connectCtx(narrow), KEYS) as Promise<Connected>);
    expect([e4.code, e4.field]).toEqual(["config", "client_id"]);
    expect(e4.message).toContain("read_orders, write_draft_orders");
    expect(narrow.hooks.size).toBe(0);
  });

  it("refuses a shop counted in whole yen: the inbox counts money in hundredths", async () => {
    const osaka = fakeShopify({
      handle: "kissa-umeda",
      name: "喫茶うめだ",
      currency: "JPY",
      primaryDomain: "https://kissa.example.jp",
    });
    const e = await refusal(
      shopifyConnector(null, noSleep).connect?.(connectCtx(osaka), {
        ...KEYS,
        store: "kissa-umeda",
      }) as Promise<Connected>,
    );
    expect([e.code, e.field]).toEqual(["config", "store"]);
    expect(e.message).toBe(
      "喫茶うめだ sells in JPY. Shops that price in whole units, like yen or won, can't connect yet.",
    );
    expect(osaka.hooks.size).toBe(0);
  });

  it("says so, and reprices nothing, when a connected shop moves to a currency it cannot count", async () => {
    const s = fakeShopify();
    const { def, ctx } = await connected(s);
    s.info.currency = "KRW";
    const e = await refusal(def.refresh?.(ctx()) as Promise<unknown>);
    expect([e.code, e.message]).toEqual([
      "config",
      "Florería Xóchitl sells in KRW. Shops that price in whole units, like yen or won, can't connect yet.",
    ]);
  });

  it("calls nothing for a custom domain, plain http or a private address, and follows no redirect", async () => {
    const s = fakeShopify();
    const def = shopifyConnector(null, noSleep);
    for (const store of [
      "https://xochitl.example.mx",
      "http://xochitl-flores.myshopify.com",
      "https://10.0.0.7",
      "127.0.0.1",
      "printer.local",
    ]) {
      const e = await refusal(def.connect?.(connectCtx(s), { ...KEYS, store }) as Promise<Connected>);
      expect([e.code, e.field], store).toEqual(["config", "store"]);
    }
    expect(s.platform.seen).toHaveLength(0);
    s.platform.fail("POST", `https://${s.shop}/admin/oauth/access_token`, { redirect: "https://192.168.1.9/steal" });
    const e = await refusal(def.connect?.(connectCtx(s), KEYS) as Promise<Connected>);
    expect([e.code, e.field]).toEqual(["config", "store"]);
    expect(s.platform.seen.every((r) => r.url.host === s.shop)).toBe(true);
  });

  it("takes an app made in the admin before 2026 by its access token, with no grant", async () => {
    const s = fakeShopify();
    const made = await shopifyConnector(null, noSleep).connect?.(connectCtx(s), {
      ...KEYS,
      access_token: LEGACY_TOKEN,
    });
    expect(made?.secret).toMatchObject({ way: "token", access_token: LEGACY_TOKEN });
    expect(s.platform.requests("POST", `https://${s.shop}/admin/oauth/access_token`)).toHaveLength(0);
    expect(s.operations.every((o) => o.token === LEGACY_TOKEN)).toBe(true);
  });

  it("makes no webhook before a hosted inbox is live, and makes them once it is", async () => {
    const s = fakeShopify();
    const { def, made, ctx } = await connected(s, { hooksLive: false });
    expect(made.extra).toMatchObject({ webhook: "pending", hooks: [] });
    expect(s.hooks.size).toBe(0);
    expect(def.stale?.(ctx({ hooksLive: false }))).toBe(false);
    expect(def.stale?.(ctx())).toBe(true);
    const fresh = await def.refresh?.(ctx());
    expect(fresh?.extra).toMatchObject({ webhook: "added", hook_origin: "https://inbox.xochitl.example.mx" });
    expect(s.hooks.size).toBe(Object.keys(SHOPIFY_TOPICS).length);
  });

  it("calls a development shop's links test ones: it takes only test orders", async () => {
    const s = fakeShopify({ partnerDevelopment: true });
    const { made } = await connected(s);
    expect(made.mode).toBe("test");
  });
});

describe("keeping the token and the webhooks right", () => {
  it("asks for a new token a minute before the old one lapses, once a run, and keeps it sealed", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    const { def, ctx, held } = await connected(s);
    const later = ctx({ now: NOW + 86_399_000 - 30_000 });
    await def.catalogue?.page(later, { cursor: null, since: null });
    await def.catalogue?.page(later, { cursor: null, since: null });
    expect(s.grants).toBe(2);
    expect(held.saved).toBe(1);
    expect(Number(held.secret.expires_at)).toBe(NOW + 86_399_000 - 30_000 + 86_399_000);
  });

  it("asks again, once, when Shopify stops taking a token early", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    const { def, ctx } = await connected(s);
    s.tokens.clear();
    const page = await def.catalogue?.page(ctx(), { cursor: null, since: null });
    expect(page?.products.length).toBeGreaterThan(0);
    expect(s.grants).toBe(2);
  });

  it("puts back a webhook Shopify removed, moves them when the inbox's address moves, and removes them on disconnect", async () => {
    const s = fakeShopify();
    const { def, ctx, made } = await connected(s);
    const paid = [...s.hooks.values()].find((h) => h.topic === "ORDERS_PAID");
    s.hooks.delete(paid?.id ?? "");
    const first = await def.refresh?.(ctx());
    expect([...s.hooks.values()].filter((h) => h.topic === "ORDERS_PAID")).toHaveLength(1);
    const kept = (first?.extra ?? made.extra) as Record<string, unknown>;

    // The inbox moved to the business's own domain: the same token, another origin.
    const moved = "https://inbox.xochitl.mx/v1/hooks/shopify/Zt3kP9wQe7RmX2vB8nYc4LsA1dF6gH0jK5uI9oTp3qE";
    expect(def.stale?.({ ...ctx({ hookUrl: moved }), extra: kept })).toBe(true);
    expect(def.stale?.({ ...ctx(), extra: kept })).toBe(false);
    const fresh = await def.refresh?.({ ...ctx({ hookUrl: moved }), extra: kept });
    expect([...s.hooks.values()].every((h) => h.uri === moved)).toBe(true);
    expect(s.hooks.size).toBe(Object.keys(SHOPIFY_TOPICS).length);

    await def.disconnect?.({
      ...ctx({ hookUrl: moved }),
      extra: (fresh?.extra ?? made.extra) as Record<string, unknown>,
    });
    expect(s.hooks.size).toBe(0);
  });

  it("connects even when Shopify will not make a webhook, makes the rest, and tries again within the hour", async () => {
    const s = fakeShopify();
    s.refuseTopics.add("ORDERS_UPDATED");
    const { def, made, ctx } = await connected(s);
    expect(made.extra).toMatchObject({
      webhook: "failed",
      hook_origin: "https://inbox.xochitl.example.mx",
      hook_retry_at: NOW + 3_600_000,
    });
    expect(s.hooks.size).toBe(Object.keys(SHOPIFY_TOPICS).length - 1);
    // Not asked again at every sync: only once the hour is up.
    expect(def.stale?.(ctx())).toBe(false);
    expect(def.stale?.(ctx({ now: NOW + 3_600_000 }))).toBe(true);
    s.refuseTopics.clear();
    const fresh = await def.refresh?.(ctx({ now: NOW + 3_600_000 }));
    expect(fresh?.extra).toMatchObject({ webhook: "added" });
    expect(fresh?.extra).not.toHaveProperty("hook_retry_at");
    expect(s.hooks.size).toBe(Object.keys(SHOPIFY_TOPICS).length);
  });

  it("makes again, carrying only its fields, a webhook at its address that carries more", async () => {
    const s = fakeShopify();
    const { def, ctx } = await connected(s);
    const paid = [...s.hooks.values()].find((h) => h.topic === "ORDERS_PAID");
    if (paid) paid.includeFields = [];
    await def.refresh?.(ctx());
    const now = [...s.hooks.values()].filter((h) => h.topic === "ORDERS_PAID");
    expect(now.map((h) => h.includeFields)).toEqual([["id", "admin_graphql_api_id", "source_name", "tags"]]);
    expect(now[0]?.id).not.toBe(paid?.id);
  });

  it("takes back what it just made when the connection is refused after all", async () => {
    const s = fakeShopify();
    const made = await shopifyConnector(null, noSleep).connect?.(connectCtx(s), KEYS);
    expect(s.hooks.size).toBe(Object.keys(SHOPIFY_TOPICS).length);
    await made?.settle?.(false);
    expect(s.hooks.size).toBe(0);
  });
});

describe("Shopify's rate limit", () => {
  it("waits as long as the bucket needs when Shopify says THROTTLED, then asks again", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    const { def, ctx } = await connected(s, {}, recordSleep);
    s.throttle = 1;
    s.bucket = { maximum: 2000, available: 100, restoreRate: 100 };
    const page = await def.catalogue?.page(ctx(), { cursor: null, since: null });
    expect(page?.products.length).toBeGreaterThan(0);
    // 302 points requested, 100 there, 100 a second: about two seconds.
    expect(slept).toEqual([2020]);
  });

  it("waits before a call the bucket would not hold, and comes back later rather than wait long", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    const { def, ctx } = await connected(s, {}, recordSleep);
    s.bucket = { maximum: 1000, available: 0, restoreRate: 50 };
    // The last answer said the bucket is empty: the next page (302 points) waits about six seconds.
    await def.catalogue?.page(ctx(), { cursor: null, since: null });
    const e = await refusal(def.catalogue?.page(ctx(), { cursor: null, since: null }) as Promise<unknown>);
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterMs).toBeGreaterThan(MAX_WAIT_MS);
    s.throttle = 2;
    s.bucket = { maximum: 1000, available: 1000, restoreRate: 50 };
    forgetBuckets();
    const twice = await refusal(def.catalogue?.page(ctx(), { cursor: null, since: null }) as Promise<unknown>);
    expect(twice.code).toBe("rate_limited");
  });
});

describe("the catalogue", () => {
  it("reads every variant in pages: priced in the shop's currency, counted when Shopify counts, on sale when it can be sold", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    const { def, ctx } = await connected(s);
    const page = await def.catalogue?.page(ctx(), { cursor: null, since: null });
    expect(page?.cursor).toBeNull();
    expect(page?.products).toEqual([
      {
        externalId: "gid://shopify/ProductVariant/41001",
        name: "Ramo de cempasúchil",
        description: "Marigolds, wrapped.",
        sku: "CEM-RAMO",
        price: { value: 45_000, currency: "MXN" },
        stock: 12,
        available: true,
      },
      {
        externalId: "gid://shopify/ProductVariant/41002",
        name: "Arreglo de mesa – Chico",
        description: null,
        sku: "MESA-S",
        price: { value: 68_000, currency: "MXN" },
        // Not tracked: not counted.
        stock: null,
        available: true,
      },
      {
        externalId: "gid://shopify/ProductVariant/41003",
        name: "Arreglo de mesa – Grande",
        description: null,
        sku: "MESA-L",
        price: { value: 125_050, currency: "MXN" },
        // Sold past none: not counted either.
        stock: null,
        available: true,
      },
      {
        externalId: "gid://shopify/ProductVariant/41004",
        name: "Corona (próximamente)",
        description: null,
        sku: null,
        price: { value: 210_000, currency: "MXN" },
        stock: 0,
        // A draft product is not on sale.
        available: false,
      },
    ]);
    const [op] = s.operations.filter((o) => o.name === "InboxVariants");
    expect(op?.variables).toEqual({ first: 100, after: null, query: null });
  });

  it("goes page by page, and reads what changed since: the variants, then the products", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    for (let i = 0; i < 150; i++) {
      s.variants.push({
        id: 50_000 + i,
        productId: 7_002,
        title: `Color ${i}`,
        sku: `MESA-${i}`,
        price: "700.00",
        availableForSale: true,
        inventoryQuantity: 1,
        tracked: true,
        policy: "DENY",
        updatedAt: Date.parse("2026-10-01T00:00:00Z"),
      });
    }
    const { def, ctx } = await connected(s);
    const first = await def.catalogue?.page(ctx(), { cursor: null, since: null });
    expect([first?.products.length, first?.cursor]).toEqual([100, "f:c100"]);
    const second = await def.catalogue?.page(ctx(), { cursor: first?.cursor ?? null, since: null });
    expect([second?.products.length, second?.cursor]).toEqual([54, null]);

    // Since yesterday afternoon: one variant repriced, one product taken off sale with none of its variants changed.
    const since = Date.parse("2026-10-19T12:00:00Z");
    const ramo = s.variants.find((v) => v.id === 41_001);
    if (ramo) Object.assign(ramo, { price: "480.00", updatedAt: NOW });
    const mesa = s.products.get(7_002);
    if (mesa) Object.assign(mesa, { status: "ARCHIVED", updatedAt: NOW });
    const changed = await def.catalogue?.page(ctx(), { cursor: null, since });
    expect(changed?.products.map((p) => [p.externalId, p.price?.value])).toEqual([
      ["gid://shopify/ProductVariant/41001", 48_000],
    ]);
    expect(changed?.cursor).toBe("p:");
    expect(s.operations.at(-1)?.variables.query).toBe("updated_at:>'2026-10-19T12:00:00.000Z'");
    const products = await def.catalogue?.page(ctx(), { cursor: "p:", since });
    expect(products?.products.every((p) => p.available === false)).toBe(true);
    expect(products?.products).toHaveLength(25);
    expect(products?.cursor).toBeNull();
  });
});

describe("an accepted order, as a draft order paid at the shop's checkout", () => {
  it("writes the shop's variants at the accepted prices, the rest as custom lines, and what fulfilling needs", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    const { def, ctx } = await connected(s, {}, recordSleep);
    const link = await def.payments?.createLink(ctx(), REQUEST);
    const [draft] = [...s.drafts.values()];
    expect(draft?.input).toEqual({
      lineItems: [
        {
          variantId: "gid://shopify/ProductVariant/41001",
          quantity: 2,
          priceOverride: { amount: "420.00", currencyCode: "MXN" },
        },
        {
          title: "Tarjeta escrita a mano",
          quantity: 1,
          originalUnitPriceWithCurrency: { amount: "50.00", currencyCode: "MXN" },
          requiresShipping: true,
          taxable: true,
        },
      ],
      presentmentCurrencyCode: "MXN",
      tags: ["inbox", "inbox-01JC0SHOPREF00000000000001"],
      note: "Inbox order XK7Q2M.\nTo deliver.\nWanted: 2026-11-01.\nThe customer wrote: “Para el altar de mi abuela, por favor.”",
      acceptAutomaticDiscounts: false,
      allowDiscountCodesInCheckout: false,
      email: "itzel.hernandez@example.mx",
      phone: "+529511234567",
      shippingAddress: {
        address1: "Calle Macedonio Alcalá 402",
        city: "Oaxaca de Juárez",
        provinceCode: "OAX",
        zip: "68000",
        countryCode: "MX",
        firstName: "Itzel Hernández",
        lastName: "Ruiz",
        phone: "+529511234567",
      },
      // Nothing more for delivery than the customer accepted: a fee is one of the order's own lines.
      shippingLine: { title: "Envío", priceWithCurrency: { amount: "0.00", currencyCode: "MXN" } },
    });
    // The draft's own checkout is the link; Shopify is never asked to email the customer.
    expect(link).toEqual({
      externalId: `gid://shopify/DraftOrder/${draft?.id}`,
      url: `https://${s.shop}/64120557901/invoices/inv${draft?.id}fake`,
      total: { value: 89_000, currency: "MXN" },
      dashboardUrl: `https://admin.shopify.com/store/xochitl-flores/draft_orders/${draft?.id}`,
    });
    expect(s.operations.map((o) => o.name)).not.toContain("InboxDraftInvoiceSend");
    // Its total is read once Shopify has worked it out.
    expect(s.operations.filter((o) => o.name === "InboxDraft")).toHaveLength(1);
    expect(slept).toEqual([500]);
  });

  it("answers the shop's own total, tax added, for the inbox to hold the link", async () => {
    const s = fakeShopify({
      handle: "northern-bloom",
      name: "Northern Bloom",
      currency: "CAD",
      taxesIncluded: false,
      primaryDomain: "https://northernbloom.example.ca",
    });
    s.taxRate = 0.13;
    s.variants.push({
      id: 61_001,
      productId: 9_001,
      title: "Default Title",
      sku: "PEONY-12",
      price: "64.00",
      availableForSale: true,
      inventoryQuantity: 8,
      tracked: true,
      policy: "DENY",
      updatedAt: NOW,
    });
    s.products.set(9_001, { id: 9_001, title: "Peonies (12)", status: "ACTIVE", description: "", updatedAt: NOW });
    const def = shopifyConnector(null, noSleep);
    const made = await def.connect?.(connectCtx(s), { ...KEYS, store: "northern-bloom" });
    if (!made) throw new Error("not connected");
    const order: ShopOrder = {
      ...ORDER,
      lines: [
        {
          externalId: toGid("ProductVariant", 61_001),
          sku: "PEONY-12",
          name: "Peonies (12)",
          quantity: 1,
          unit: { value: 6_400, currency: "CAD" },
        },
      ],
      total: { value: 6_400, currency: "CAD" },
      delivery: "pickup",
      customer: { name: "Siobhán Tremblay", email: "siobhan@example.ca", phone: "514-555-0199", language: "fr-CA" },
      shipping: null,
      note: null,
    };
    const link = await def.payments?.createLink(runner(s, made).ctx(), {
      ...REQUEST,
      amount: order.total,
      order,
    });
    expect(link?.total).toEqual({ value: 7_232, currency: "CAD" });
    const [draft] = [...s.drafts.values()];
    // A number that is not E.164 is left out, not guessed at; collecting adds no rate.
    expect(draft?.input).not.toHaveProperty("phone");
    expect(draft?.input.shippingLine).toEqual({
      title: "Retrait",
      priceWithCurrency: { amount: "0.00", currencyCode: "CAD" },
    });
  });

  it("is safe to ask again: the draft it made is found by its tag, never made twice", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    const { def, ctx } = await connected(s);
    const first = await def.payments?.createLink(ctx(), REQUEST);
    const again = await def.payments?.createLink(ctx(), REQUEST);
    expect(again?.externalId).toBe(first?.externalId);
    expect(s.drafts.size).toBe(1);
  });

  it("says Shopify's own words when it will not make the draft, and refuses mixed currencies before asking", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    const { def, ctx } = await connected(s);
    const gone = await refusal(
      def.payments?.createLink(ctx(), {
        ...REQUEST,
        order: {
          ...ORDER,
          lines: [{ ...ORDER.lines[0], externalId: toGid("ProductVariant", 99_999) } as ShopOrder["lines"][number]],
        },
      }) as Promise<unknown>,
    );
    expect([gone.code, gone.message]).toEqual([
      "refused",
      "Shopify did not make the draft order: Product with ID was not found",
    ]);
    const mixed = await refusal(
      def.payments?.createLink(ctx(), {
        ...REQUEST,
        order: {
          ...ORDER,
          lines: [
            ...ORDER.lines,
            { externalId: null, sku: null, name: "Vase", quantity: 1, unit: { value: 900, currency: "USD" } },
          ],
        },
      }) as Promise<unknown>,
    );
    expect(mixed.code).toBe("refused");
    expect(s.drafts.size).toBe(0);
  });
});

describe("what became of a draft, asked of Shopify", () => {
  async function paidSetup(opts: { test?: boolean } = {}) {
    const s = fakeShopify();
    stockFlorist(s);
    const c = await connected(s);
    const link = await c.def.payments?.createLink(c.ctx(), REQUEST);
    const draftId = Number(link?.externalId.split("/").at(-1));
    const known = { ref: REQUEST.ref, externalId: link?.externalId ?? null, itemId: REQUEST.itemId };
    return { s, ...c, draftId, known, link, pay: () => s.pay(draftId, opts) };
  }

  it("is nothing while open, and paid once the customer paid at the checkout", async () => {
    const t = await paidSetup();
    expect(await t.def.payments?.check(t.ctx(), t.known)).toEqual([]);
    expect(await t.def.payments?.orderState?.(t.ctx(), t.known)).toBeNull();
    const order = t.pay();
    expect(await t.def.payments?.check(t.ctx(), t.known)).toEqual([
      {
        status: "paid",
        linkId: t.link?.externalId,
        ref: REQUEST.ref,
        paymentId: `gid://shopify/Order/${order.id}`,
        amount: { value: 89_000, currency: "MXN" },
        method: "card",
        paidAt: Date.parse("2026-10-20T14:05:00Z"),
        dashboardUrl: `https://admin.shopify.com/store/xochitl-flores/orders/${order.id}`,
        livemode: true,
      },
    ]);
  });

  it("says a test order is a test, and an authorised payment not yet captured is not paid", async () => {
    const t = await paidSetup({ test: true });
    t.pay();
    expect((await t.def.payments?.check(t.ctx(), t.known))?.[0]?.livemode).toBe(false);
    const u = await paidSetup();
    const order = u.pay();
    order.financial = "AUTHORIZED";
    expect(await u.def.payments?.check(u.ctx(), u.known)).toEqual([]);
  });

  it("calls a draft deleted in Shopify before anyone paid cancelled, and closes a draft by deleting it", async () => {
    const t = await paidSetup();
    await t.def.payments?.closeLink(t.ctx(), { externalId: t.link?.externalId ?? "" });
    expect(t.s.drafts.size).toBe(0);
    expect(await t.def.payments?.orderState?.(t.ctx(), t.known)).toEqual({
      linkId: t.link?.externalId,
      ref: REQUEST.ref,
      state: "cancelled",
      at: NOW,
    });
    // Closing one already gone is done, not an error.
    await t.def.payments?.closeLink(t.ctx(), { externalId: t.link?.externalId ?? "" });
    // A completed draft is the shop's order now: it is not deleted.
    const u = await paidSetup();
    u.pay();
    await u.def.payments?.closeLink(u.ctx(), { externalId: u.link?.externalId ?? "" });
    expect(u.s.drafts.size).toBe(1);
  });

  it("says plainly when Shopify keeps the order from the app as protected customer data, never 'not paid'", async () => {
    const t = await paidSetup();
    t.pay();
    t.s.withheld = true;
    const e = await refusal(t.def.payments?.check(t.ctx(), t.known) as Promise<unknown>);
    expect(e.code).toBe("config");
    expect(e.message).toContain("protected customer data");
  });

  it("asks no more 60 days after it was paid: Shopify shows an app no older order", async () => {
    const t = await paidSetup();
    t.pay();
    const before = t.s.operations.length;
    const old = { ...t.known, paidAt: NOW - 61 * 86_400_000 };
    expect(await t.def.payments?.orderState?.(t.ctx(), old)).toBeNull();
    expect(t.s.operations.length).toBe(before);
    // A refund on an order Shopify no longer shows is read as nothing, not as an error.
    const order = [...t.s.orders.values()][0];
    t.s.ordersShownSince = Date.parse(order?.processedAt ?? "") + 1;
    expect(
      await t.def.hooks?.read(t.ctx(), {
        eventId: "w9",
        topic: "refunds/create",
        refs: [`gid://shopify/Order/${order?.id}`],
      }),
    ).toEqual([]);
  });

  it("follows the order: fulfilled with its tracking, delivered, refunded, each in turn an hour apart", async () => {
    const t = await paidSetup();
    const order = t.pay();
    order.fulfillment = "FULFILLED";
    order.fulfillments.push({
      status: "SUCCESS",
      displayStatus: "IN_TRANSIT",
      deliveredAt: null,
      createdAt: "2026-10-21T10:00:00Z",
      tracking: { company: "Estafeta", number: "EST 7781 2290", url: "https://rastreo.example.mx/EST77812290" },
    });
    expect(await t.def.payments?.orderState?.(t.ctx(), t.known)).toEqual({
      linkId: t.link?.externalId,
      ref: REQUEST.ref,
      state: "fulfilled",
      at: Date.parse("2026-10-21T10:00:00Z"),
      tracking: { url: "https://rastreo.example.mx/EST77812290", number: "EST 7781 2290", carrier: "Estafeta" },
    });
    Object.assign(order.fulfillments[0] ?? {}, { displayStatus: "DELIVERED", deliveredAt: "2026-10-22T16:30:00Z" });
    order.refunded = 5_000;
    order.financial = "PARTIALLY_REFUNDED";
    const states = [];
    for (let h = 0; h < 3; h++) {
      states.push((await t.def.payments?.orderState?.(t.ctx({ now: NOW + h * 3_600_000 }), t.known))?.state);
    }
    expect(new Set(states)).toEqual(new Set(["fulfilled", "delivered", "refunded"]));
  });
});

describe("webhooks from Shopify", () => {
  async function hooked() {
    const s = fakeShopify();
    stockFlorist(s);
    const c = await connected(s);
    const link = await c.def.payments?.createLink(c.ctx(), REQUEST);
    const draftId = Number(link?.externalId.split("/").at(-1));
    return { s, ...c, link, draftId };
  }
  it("checks the signature over the exact bytes, and keeps ids only", async () => {
    const t = await hooked();
    const order = t.s.pay(t.draftId);
    const d = await t.s.delivery("orders/paid", orderBody(order), {
      webhookId: "b54557e4-bdd9-4b37-8a5f-000000000001",
    });
    // Shopify sent only the fields asked for: no customer's details reach the inbox at all.
    expect(Object.keys(JSON.parse(d.body))).toEqual(["id", "admin_graphql_api_id", "source_name", "tags"]);
    expect(d.body).not.toContain("itzel");
    const event = await t.def.hooks?.verify(t.ctx(), inbound(d));
    expect(event).toEqual({
      eventId: "b54557e4-bdd9-4b37-8a5f-000000000001",
      topic: "orders/paid",
      refs: [`gid://shopify/Order/${order.id}`],
    });
    const tampered = await t.s.delivery("orders/paid", orderBody(order), { tamper: true });
    expect((await refusal(t.def.hooks?.verify(t.ctx(), inbound(tampered)) as Promise<unknown>)).code).toBe("refused");
    const byAnother = await t.s.delivery("orders/paid", orderBody(order), { secret: "shpss_someone_else" });
    expect((await refusal(t.def.hooks?.verify(t.ctx(), inbound(byAnother)) as Promise<unknown>)).code).toBe("refused");
    // The same bytes with one more space are other bytes.
    expect(
      (await refusal(t.def.hooks?.verify(t.ctx(), inbound({ ...d, body: `${d.body} ` })) as Promise<unknown>)).code,
    ).toBe("refused");
    const noId = { ...d, headers: { ...d.headers, "x-shopify-webhook-id": "" } };
    expect((await refusal(t.def.hooks?.verify(t.ctx(), inbound(noId)) as Promise<unknown>)).code).toBe("refused");
  });

  it("leaves alone what is not the inbox's: another shop, an order not from a draft, a topic not asked for", async () => {
    const t = await hooked();
    const order = t.s.pay(t.draftId);
    const other = await t.s.delivery("orders/paid", orderBody(order), { shop: "otra-tienda.myshopify.com" });
    expect(await t.def.hooks?.verify(t.ctx(), inbound(other))).toBeNull();
    const web = await t.s.delivery("orders/paid", { ...orderBody(order), source_name: "web" });
    expect(await t.def.hooks?.verify(t.ctx(), inbound(web))).toBeNull();
    // From a draft, but one the owner made in Shopify: no inbox tag, nothing read.
    const staff = await t.s.delivery("orders/updated", { ...orderBody(order), tags: "wholesale, vip" });
    expect(await t.def.hooks?.verify(t.ctx(), inbound(staff))).toBeNull();
    const customers = await t.s.delivery("customers/create", { id: 1 });
    expect(await t.def.hooks?.verify(t.ctx(), inbound(customers))).toBeNull();
    const odd = await t.s.delivery("constructor", { id: 1 });
    expect(await t.def.hooks?.verify(t.ctx(), inbound(odd))).toBeNull();
  });

  it("reads back the order with the key: a body that says paid is not believed until Shopify says so", async () => {
    const t = await hooked();
    // Signed, but early: the order exists and is not paid yet.
    const order = t.s.pay(t.draftId);
    order.financial = "PENDING";
    const event = { eventId: "w1", topic: "orders/paid", refs: [`gid://shopify/Order/${order.id}`] };
    expect(await t.def.hooks?.read(t.ctx(), event)).toEqual([]);
    order.financial = "PAID";
    const facts = await t.def.hooks?.read(t.ctx(), event);
    expect(facts?.map((f) => f.kind)).toEqual(["payment"]);
    expect(facts?.[0]).toMatchObject({
      kind: "payment",
      fact: { status: "paid", ref: REQUEST.ref, linkId: t.link?.externalId },
    });
  });

  it("reads no further an order without its tag, and finds a tagged one among the latest while search lags", async () => {
    const t = await hooked();
    const order = t.s.pay(t.draftId);
    const event = { eventId: "w2", topic: "refunds/create", refs: [`gid://shopify/Order/${order.id}`] };
    // Shopify has not indexed the draft just completed yet: found among the inbox's latest completed.
    t.s.searchLags = true;
    expect((await t.def.hooks?.read(t.ctx(), event))?.[0]).toMatchObject({
      kind: "payment",
      fact: { linkId: t.link?.externalId },
    });
    expect(t.s.operations.map((o) => o.name)).toContain("InboxDraftsCompleted");
    // An order the inbox did not make (a refund elsewhere in the shop): one read, nothing more.
    const tags = order.tags;
    order.tags = ["wholesale"];
    const asked = t.s.operations.length;
    expect(await t.def.hooks?.read(t.ctx(), event)).toEqual([]);
    expect(t.s.operations.slice(asked).map((o) => o.name)).toEqual(["InboxOrder"]);
    order.tags = tags;
  });

  it("turns products changed into a catalogue read, and a draft deleted into a cancel only when it is gone", async () => {
    const t = await hooked();
    expect(
      await t.def.hooks?.read(t.ctx(), {
        eventId: "w3",
        topic: "products/update",
        refs: ["gid://shopify/Product/7001"],
      }),
    ).toEqual([{ kind: "catalogue", externalIds: "all" }]);
    const deleted = { eventId: "w4", topic: "draft_orders/delete", refs: [t.link?.externalId ?? ""] };
    expect(await t.def.hooks?.read(t.ctx(), deleted)).toEqual([]);
    t.s.drafts.clear();
    expect(await t.def.hooks?.read(t.ctx(), deleted)).toEqual([
      { kind: "order", fact: { linkId: t.link?.externalId, ref: null, state: "cancelled", at: NOW } },
    ]);
  });

  it("calls the access withdrawn only when Shopify no longer takes it", async () => {
    const t = await hooked();
    const uninstalled = { eventId: "w5", topic: "app/uninstalled", refs: [] };
    expect(await t.def.hooks?.read(t.ctx(), uninstalled)).toEqual([]);
    t.s.tokens.clear();
    t.s.sameOrganization = false;
    expect(await t.def.hooks?.read(t.ctx(), uninstalled)).toEqual([{ kind: "revoked" }]);
  });
});

describe("Sign in with Shopify, with the server's own app", () => {
  it("sends the owner to their shop's own consent page, and takes a lapsing offline token it refreshes", async () => {
    const s = fakeShopify();
    stockFlorist(s);
    const def = shopifyConnector(OPERATOR, noSleep);
    const url = new URL(
      def.oauth?.authorizeUrl({
        redirectUri: "https://inbox.xochitl.example.mx/oauth/connect/shopify/callback",
        state: "st4te",
        challenge: "unused",
        input: { store: "admin.shopify.com/store/xochitl-flores" },
      }) ?? "",
    );
    expect(`${url.origin}${url.pathname}`).toBe(`https://${s.shop}/admin/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: OPERATOR.clientId,
      scope: "read_products,read_orders,write_draft_orders",
      redirect_uri: "https://inbox.xochitl.example.mx/oauth/connect/shopify/callback",
      state: "st4te",
    });
    const made = await def.oauth?.exchange(connectCtx(s), {
      code: "code-from-shopify",
      verifier: "unused",
      redirectUri: "https://inbox.xochitl.example.mx/oauth/connect/shopify/callback",
      input: { store: "xochitl-flores" },
    });
    if (!made) throw new Error("not connected");
    expect(made.secret).toMatchObject({ way: "oauth" });
    expect(made.secret.refresh_token).toMatch(/^shprt_/);
    // The server's app secret is the server's: it is never kept on the connection.
    expect(JSON.stringify(made.secret)).not.toContain(OPERATOR.clientSecret);
    const { ctx, held } = runner(s, made);
    await def.catalogue?.page(ctx({ now: NOW + 3_600_000 }), { cursor: null, since: null });
    expect(held.saved).toBe(1);
    // Webhooks of the server's app are signed with its secret.
    const d = await s.delivery(
      "products/update",
      { id: 7001, admin_graphql_api_id: "gid://shopify/Product/7001" },
      { secret: OPERATOR.clientSecret },
    );
    expect(await def.hooks?.verify(ctx(), inbound(d))).toMatchObject({ topic: "products/update" });
  });
});
