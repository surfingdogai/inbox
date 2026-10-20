import {
  type CatalogueProduct,
  type ConnectContext,
  type Connected,
  ConnectorError,
  type InboundRequest,
  type PayLinkRequest,
  type RunContext,
  type ShopOrder,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { hundredths, normalizeStore, plain, routeUrl } from "../src/connectors/woocommerce/api";
import { hmacSha256Base64, woocommerceConnector } from "../src/index";
import { type FakeWooStore, fakeWooStore, simple, variable, variation } from "./fixtures/woocommerce/store";

/**
 * Contract tests for the WooCommerce connector (ADR-027) against a made-up store that answers as
 * WooCommerce's REST API v3 documents it (fixtures/woocommerce/store.ts), through the inbox's own
 * connector client: https only, public hosts only, no redirect followed. Its businesses: a pizzeria in
 * São Paulo (BRL), a hardware shop in Pune whose prices include GST (INR), a bakery in Toronto whose
 * prices leave HST to the checkout (CAD), a homeware shop in Osaka selling in yen (JPY), a spice shop in
 * Kuwait City counting in fils (KWD), and a ceramics studio in Nairobi (KES). No real store is ever called.
 */

const woo = woocommerceConnector();
const HOOK =
  "https://inbox.pizzaria-bixiga.example.com/v1/hooks/woocommerce/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh2";
const INBOX = {
  id: "7c1d0de2a9b84e7d3c61",
  origin: "https://inbox.pizzaria-bixiga.example.com",
  host: "inbox.pizzaria-bixiga.example.com",
  name: "Pizzaria Bixiga",
  timezone: "America/Sao_Paulo",
  language: "pt-BR",
};

function connectCtx(store: FakeWooStore, over: Partial<ConnectContext> = {}): ConnectContext {
  return { http: store.platform.http, now: Date.now(), inbox: INBOX, hookUrl: HOOK, hooksLive: true, ...over };
}

/** A connection as the inbox opens it for a run: what `connect` kept, sealed secrets opened. */
function runCtx(
  store: FakeWooStore,
  c: Connected,
  over: Partial<RunContext> = {},
): RunContext & { saved: Record<string, string>[] } {
  const saved: Record<string, string>[] = [];
  let secret = { ...c.secret };
  const ctx = {
    ...connectCtx(store),
    secret,
    extra: { ...(c.extra ?? {}) },
    calendars: [],
    busyCalendars: [],
    destinations: [],
    destination: null,
    own: { ids: new Set<string>(), spans: [] },
    marker: "marker-of-this-inbox-0123456789abcdef",
    async saveSecret(next: Readonly<Record<string, string>>) {
      secret = { ...next };
      saved.push(secret);
      (ctx as { secret: Record<string, string> }).secret = secret;
    },
    saved,
    ...over,
  };
  return ctx as RunContext & { saved: Record<string, string>[] };
}

async function connected(store: FakeWooStore): Promise<Connected> {
  return (woo.connect as NonNullable<typeof woo.connect>)(connectCtx(store), {
    store_url: store.base,
    consumer_key: store.manual.key,
    consumer_secret: store.manual.secret,
  });
}

function shopOrder(lines: ShopOrder["lines"], over: Partial<ShopOrder> = {}): ShopOrder {
  const total = lines.reduce((s, l) => s + l.unit.value * l.quantity, 0);
  return {
    lines,
    charges: null,
    total: { value: total, currency: lines[0]?.unit.currency ?? "BRL" },
    delivery: "delivery",
    when: "2026-10-24T19:30:00-03:00",
    customer: {
      name: "Ana Beatriz Souza",
      email: "ana.souza@example.com",
      phone: "+55 11 90000-0000",
      language: "pt-BR",
    },
    shipping: {
      streetAddress: "Rua Treze de Maio, 120",
      addressLocality: "São Paulo",
      addressRegion: "SP",
      postalCode: "01327-000",
      addressCountry: "BR",
    },
    billing: null,
    note: "Sem cebola, por favor.",
    ...over,
  };
}

function payRequest(order: ShopOrder, ref = "01JB7Z8K3M4N5P6Q7R8S9T0V1W"): PayLinkRequest {
  return {
    ref,
    itemId: "itm_01",
    amount: order.total,
    title: "Order 4F2K9Q",
    reference: "4F2K9Q",
    language: "pt",
    thanks: "Obrigado.",
    inactive: "Closed.",
    hookUrl: HOOK,
    order,
  };
}

const posted = (body: string, headers: Record<string, string> = {}): InboundRequest => ({
  headers: new Headers(headers),
  body,
  query: new URLSearchParams(),
});

/* --- the store's address and the money it writes ------------------------------------------------ */

describe("a store's address and amounts", () => {
  it("takes the shop's own https address, with or without the scheme, and WordPress's own paths taken off", () => {
    expect(normalizeStore("pizzaria-bixiga.example.com")).toBe("https://pizzaria-bixiga.example.com");
    expect(normalizeStore("https://Loja.Example.com/shop/wp-admin/edit.php?x=1")).toBe("https://loja.example.com/shop");
    expect(normalizeStore(" https://loja.example.com/wp-json/wc/v3 ")).toBe("https://loja.example.com");
    for (const bad of [
      "http://loja.example.com",
      "ftp://loja.example.com",
      "https://user:pw@loja.example.com",
      "localhost",
      "",
    ]) {
      expect(() => normalizeStore(bad), bad).toThrow(ConnectorError);
    }
  });

  it("turns a store's entities back into text once: an escaped tag stays text", () => {
    expect(plain("P&atilde;o &amp;lt;script&amp;gt; &amp; queijo &#8211; 1&nbsp;kg")).toBe(
      "Pão &lt;script&gt; & queijo – 1 kg",
    );
    expect(plain("&Aacute;gua, &Ccedil;a&ntilde;a &hellip; &unknown;")).toBe("Água, Çaña … &unknown;");
    expect(plain("<p>Caf&#233; &#x2615;</p>")).toBe("Café ☕");
  });

  it("reads the store's decimals in hundredths, rounding at the third, and never guesses", () => {
    expect([
      hundredths("12.50"),
      hundredths("1200"),
      hundredths("4.5833"),
      hundredths("0.005"),
      hundredths("-5.00"),
    ]).toEqual([1250, 120_000, 458, 1, -500]);
    expect([hundredths(""), hundredths("12,50"), hundredths(null), hundredths("1e3")]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("puts the pair in the query only for a store that needs it so, and reaches plain permalinks by rest_route", () => {
    const keys = { key: "ck_x", secret: "cs_y" };
    expect(
      routeUrl({ base: "https://a.example.com", api: "path", auth: "header" }, keys, "/wc/v3/orders", { page: 2 }),
    ).toBe("https://a.example.com/wp-json/wc/v3/orders?page=2");
    expect(routeUrl({ base: "https://a.example.com", api: "query", auth: "query" }, keys, "/wc/v3/orders")).toBe(
      "https://a.example.com/?rest_route=%2Fwc%2Fv3%2Forders&consumer_key=ck_x&consumer_secret=cs_y",
    );
  });
});

/* --- connecting ------------------------------------------------------------------------------------ */

describe("connecting with the keys made by hand", () => {
  it("checks the pair against the store, keeps its address and currency, and seals the pair", async () => {
    const store = fakeWooStore();
    const c = await connected(store);
    expect(c).toMatchObject({
      account: "Pizzaria Bixiga",
      externalId: "pizzaria-bixiga.example.com",
      extra: { store: store.base, api: "path", auth: "header", currency: "BRL", via: "keys", webhook: "pending" },
      secret: { consumer_key: store.manual.key, consumer_secret: store.manual.secret },
    });
    // The pair went as HTTP Basic, never in an address; nothing but the fields read was asked for.
    const settings = store.platform.seen.find((r) => r.url.pathname === "/wp-json/wc/v3/settings/general");
    expect(settings?.headers.get("authorization")).toMatch(/^Basic /);
    expect(settings?.url.searchParams.get("_fields")).toBe("id,value");
    expect(store.platform.seen.every((r) => !r.url.search.includes("consumer_secret"))).toBe(true);
    // Only the sealed part holds the pair.
    expect(JSON.stringify(c.extra)).not.toContain(store.manual.secret);
    // No webhook yet: made on the first sync, once the inbox answers.
    expect(store.webhooks.size).toBe(0);
  });

  it("says a key the store does not take on the key's field, and a site without WooCommerce on the address's", async () => {
    const store = fakeWooStore();
    const connect = woo.connect as NonNullable<typeof woo.connect>;
    await expect(
      connect(connectCtx(store), {
        store_url: store.base,
        consumer_key: `ck_${"0".repeat(40)}`,
        consumer_secret: store.manual.secret,
      }),
    ).rejects.toMatchObject({ code: "auth", field: "consumer_key" });
    await expect(
      connect(connectCtx(store), {
        store_url: store.base,
        consumer_key: store.manual.key,
        consumer_secret: `cs_${"0".repeat(40)}`,
      }),
    ).rejects.toMatchObject({ code: "auth", field: "consumer_key" });
    store.quirks.noWooCommerce = true;
    await expect(
      connect(connectCtx(store), {
        store_url: store.base,
        consumer_key: store.manual.key,
        consumer_secret: store.manual.secret,
      }),
    ).rejects.toMatchObject({
      code: "config",
      field: "store_url",
      message: expect.stringContaining("WooCommerce is not active"),
    });
    store.quirks.noWooCommerce = false;
    store.quirks.firewallPage = true;
    await expect(
      connect(connectCtx(store), {
        store_url: store.base,
        consumer_key: store.manual.key,
        consumer_secret: store.manual.secret,
      }),
    ).rejects.toMatchObject({ code: "config", field: "store_url" });
  });

  it("refuses plain http, a private address, and a redirect to another host; the pair reaches only the shop", async () => {
    const store = fakeWooStore();
    const connect = woo.connect as NonNullable<typeof woo.connect>;
    for (const store_url of ["http://pizzaria-bixiga.example.com", "https://10.0.0.7", "https://192.168.1.20/shop"]) {
      await expect(
        connect(connectCtx(store), { store_url, consumer_key: store.manual.key, consumer_secret: store.manual.secret }),
        store_url,
      ).rejects.toMatchObject({ code: "config", field: "store_url" });
    }
    store.platform.fail("GET", `https://${store.host}/*`, {
      redirect: "https://169.254.169.254/latest/meta-data",
      status: 301,
    });
    await expect(
      connect(connectCtx(store), {
        store_url: store.base,
        consumer_key: store.manual.key,
        consumer_secret: store.manual.secret,
      }),
    ).rejects.toMatchObject({ code: "config" });
    expect(store.platform.seen.every((r) => r.url.hostname === store.host)).toBe(true);
  });

  it("follows its own site to www., finds plain permalinks, and puts the pair in the query where the header is dropped", async () => {
    const www = fakeWooStore({
      host: "ferragens-pune.example.in",
      www: true,
      name: "Deshpande Hardware",
      currency: "INR",
    });
    const a = await (woo.connect as NonNullable<typeof woo.connect>)(connectCtx(www), {
      store_url: "ferragens-pune.example.in",
      consumer_key: www.manual.key,
      consumer_secret: www.manual.secret,
    });
    expect(a.extra).toMatchObject({ store: "https://www.ferragens-pune.example.in", currency: "INR" });
    expect(a.externalId).toBe("ferragens-pune.example.in");

    const plain = fakeWooStore();
    plain.quirks.plainPermalinks = true;
    const b = await connected(plain);
    expect(b.extra).toMatchObject({ api: "query", auth: "header" });

    const stripped = fakeWooStore();
    stripped.quirks.dropsAuthHeader = true;
    const c = await connected(stripped);
    expect(c.extra).toMatchObject({ api: "path", auth: "query" });
    // Such a store is asked with the pair in the query, and never followed anywhere.
    const ctx = runCtx(stripped, c);
    await woo.catalogue?.page(ctx, { cursor: null, since: null });
    expect(stripped.platform.seen.at(-1)?.url.searchParams.get("consumer_key")).toBe(stripped.manual.key);
  });
});

describe("connecting by WooCommerce's own Approve page", () => {
  it("sends the owner to the store's authorize endpoint for read and write, with this inbox's state and an https callback", () => {
    const url = new URL(
      woo.oauth?.authorizeUrl({
        redirectUri: "https://inbox.pizzaria-bixiga.example.com/oauth/connect/woocommerce/callback",
        state: "st4te-of-this-sign-in",
        challenge: "unused",
        input: { store_url: "pizzaria-bixiga.example.com/" },
        postUrl: "https://inbox.pizzaria-bixiga.example.com/v1/hooks/woocommerce/authorized",
      }) ?? "",
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://pizzaria-bixiga.example.com/wc-auth/v1/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_name: "Agent inbox (inbox.pizzaria-bixiga.example.com)",
      scope: "read_write",
      user_id: "st4te-of-this-sign-in",
      return_url:
        "https://inbox.pizzaria-bixiga.example.com/oauth/connect/woocommerce/callback?state=st4te-of-this-sign-in",
      callback_url: "https://inbox.pizzaria-bixiga.example.com/v1/hooks/woocommerce/authorized",
    });
    // What it asks first is a shop's address, filled in from the business's website.
    expect(woo.oauth?.before?.safeParse({ store_url: "http://loja.example.com" }).success).toBe(false);
    expect(woo.oauth?.before?.safeParse({ store_url: "loja.example.com" }).success).toBe(true);
  });

  it("takes the pair the store POSTs, checked against the store the owner named, read and write only", async () => {
    const store = fakeWooStore();
    store.addKey(`ck_${"9".repeat(40)}`, `cs_${"8".repeat(40)}`);
    const flow = woo.oauth;
    const body = JSON.stringify({
      key_id: 42,
      user_id: "st4te",
      consumer_key: `ck_${"9".repeat(40)}`,
      consumer_secret: `cs_${"8".repeat(40)}`,
      key_permissions: "read_write",
    });
    expect(flow?.postedState?.(posted(body))).toBe("st4te");
    expect(flow?.postedState?.(posted("not json"))).toBeNull();
    // While the store waits for this answer it is asked nothing: a small host may have no worker free.
    const asked = store.platform.seen.length;
    const c = await flow?.receivePosted?.(connectCtx(store), posted(body), { store_url: store.base });
    expect(store.platform.seen.length).toBe(asked);
    expect(c).toMatchObject({
      externalId: "pizzaria-bixiga.example.com",
      extra: { via: "authorize", key_id: 42, store: store.base, api: "path", auth: "header", currency: null },
    });
    expect((c?.extra as { checked_at?: unknown } | undefined)?.checked_at).toBeUndefined();
    // Checked on the first sync instead: the store found, its currency read.
    const first = runCtx(store, c as Connected);
    expect(woo.stale?.(first)).toBe(true);
    const checked = await woo.refresh?.(first);
    expect(checked?.extra).toMatchObject({ currency: "BRL", checked_at: expect.any(Number) });
    expect(woo.stale?.(runCtx(store, { ...(c as Connected), extra: checked?.extra }))).toBe(false);
    // The same store approved again is known by its address: connecting it again in place.
    expect(flow?.accountOf?.({ store_url: "https://WWW.pizzaria-bixiga.example.com/wp-admin/" })).toBe(
      "pizzaria-bixiga.example.com",
    );
    expect(flow?.accountOf?.({ store_url: "http://pizzaria-bixiga.example.com" })).toBeNull();
    // Read only is not enough to write the orders the owner accepts.
    await expect(
      flow?.receivePosted?.(connectCtx(store), posted(body.replace('"read_write"', '"read"')), {
        store_url: store.base,
      }),
    ).rejects.toMatchObject({ code: "config" });
    await expect(
      flow?.receivePosted?.(connectCtx(store), posted('{"user_id":"st4te"}'), { store_url: store.base }),
    ).rejects.toMatchObject({ code: "bad_response" });
    // A pair the store did not make for this inbox: taken as the POST says, and refused by the store on
    // the first sync, which the connection says.
    const stranger = body.replace("9".repeat(40), "7".repeat(40));
    const taken = await flow?.receivePosted?.(connectCtx(store), posted(stranger), { store_url: store.base });
    const hooksBefore = store.webhooks.size;
    await expect(woo.refresh?.(runCtx(store, taken as Connected))).rejects.toMatchObject({ code: "auth" });
    expect(store.webhooks.size).toBe(hooksBefore);
  });

  it("finds on the first sync a store the POST could not say: plain permalinks, a dropped header", async () => {
    const store = fakeWooStore({ host: "ufinyanzi-studio.example.co.ke", name: "Ufinyanzi Studio", currency: "KES" });
    store.quirks.plainPermalinks = true;
    store.quirks.dropsAuthHeader = true;
    store.addKey(`ck_${"5".repeat(40)}`, `cs_${"6".repeat(40)}`);
    store.products.push(simple(5, "Mug, terracotta", "1450.00"));
    const body = JSON.stringify({
      key_id: 7,
      user_id: "st4te",
      consumer_key: `ck_${"5".repeat(40)}`,
      consumer_secret: `cs_${"6".repeat(40)}`,
      key_permissions: "read_write",
    });
    const c = (await woo.oauth?.receivePosted?.(connectCtx(store), posted(body), {
      store_url: store.base,
    })) as Connected;
    const r = await woo.refresh?.(runCtx(store, c));
    expect(r?.extra).toMatchObject({ api: "query", auth: "query", currency: "KES" });
    const products = await readAll(runCtx(store, { ...c, extra: r?.extra }));
    expect(products.map((p) => [p.externalId, p.price])).toEqual([["p:5", { value: 145_000, currency: "KES" }]]);
  });

  it("says the owner declined, rather than a fault, when WooCommerce sends them back with success=0", async () => {
    const store = fakeWooStore();
    const started = woo.oauth?.authorizeUrl({
      redirectUri: "https://inbox.pizzaria-bixiga.example.com/oauth/connect/woocommerce/callback",
      state: "st4te",
      challenge: "unused",
      input: { store_url: store.base },
      postUrl: "https://inbox.pizzaria-bixiga.example.com/v1/hooks/woocommerce/authorized",
    });
    const back = await store.approve(started ?? "", () => new Response("{}"), { deny: true });
    expect(new URL(back.location).searchParams.get("success")).toBe("0");
    expect(back.posted).toBeNull();
  });
});

/* --- the catalogue --------------------------------------------------------------------------------- */

async function readAll(ctx: RunContext, since: number | null = null): Promise<CatalogueProduct[]> {
  const reader = woo.catalogue;
  if (!reader) throw new Error("no catalogue");
  const out: CatalogueProduct[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: { products: readonly CatalogueProduct[]; cursor: string | null } = await reader.page(ctx, {
      cursor,
      since,
    });
    out.push(...page.products);
    cursor = page.cursor;
    if (cursor === null) return out;
  }
  throw new Error("the catalogue never ended");
}

describe("the store's catalogue", () => {
  it("brings in simple products and each variation, priced and stocked as the store counts, and nothing it does not sell", async () => {
    const store = fakeWooStore();
    store.products.push(
      simple(11, "Pizza Margherita", "49.90", {
        sku: "PZ-MARG",
        short_description: "<p>Molho de tomate, mussarela &amp; manjericão.</p>",
      }),
      simple(12, "Calzone", "", { purchasable: false }),
      simple(13, "Guaraná 350ml", "6.5000", { manage_stock: true, stock_quantity: 48 }),
      simple(14, "Esfiha", "8.00", { stock_status: "outofstock" }),
      simple(15, "Pizza secreta", "59.00", { status: "private" }),
      variable(20, "Pizza Calabresa", [
        variation(21, "Média", "54.00", { sku: "PZ-CAL-M", manage_stock: "parent", stock_quantity: 9 }),
        variation(22, "Grande", "69.00", { sku: "PZ-CAL-G" }),
      ]),
      variable(30, "Rascunho", [variation(31, "Única", "10.00")], { status: "draft" }),
      { ...simple(40, "Combo família", "120.00"), type: "grouped" },
      { ...simple(41, "Livro de receitas", "80.00"), type: "external" },
    );
    const ctx = runCtx(store, await connected(store));
    const products = await readAll(ctx);
    expect(products.map((p) => [p.externalId, p.name, p.sku, p.price?.value ?? null, p.stock, p.available])).toEqual([
      ["p:11", "Pizza Margherita", "PZ-MARG", 4_990, null, true],
      ["p:12", "Calzone", null, null, null, false],
      ["p:13", "Guaraná 350ml", null, 650, 48, true],
      ["p:14", "Esfiha", null, 800, 0, true],
      ["p:15", "Pizza secreta", null, 5_900, null, false],
      ["v:21", "Pizza Calabresa – Média", "PZ-CAL-M", 5_400, 9, true],
      ["v:22", "Pizza Calabresa – Grande", "PZ-CAL-G", 6_900, null, true],
      // A variation of a draft is never on sale.
      ["v:31", "Rascunho – Única", null, 1_000, null, false],
    ]);
    expect(products[0]).toMatchObject({
      description: "Molho de tomate, mussarela & manjericão.",
      price: { currency: "BRL" },
    });
    // Asked only for the fields it reads, 25 at a time, in a stable order.
    const listed = store.platform.seen.find((r) => r.url.pathname === "/wp-json/wc/v3/products");
    expect(Object.fromEntries(listed?.url.searchParams ?? [])).toMatchObject({
      per_page: "25",
      status: "any",
      orderby: "id",
      order: "asc",
    });
  });

  it("reads a page per call however many variations a product has, and only what changed since, the bin included", async () => {
    const store = fakeWooStore();
    store.products.push(
      variable(
        50,
        "Pizza por pedaço",
        Array.from({ length: 130 }, (_, i) => variation(1_000 + i, `Sabor ${i + 1}`, "12.00")),
      ),
      simple(60, "Mussarela", "45.00", { modified: Date.now() - 86_400_000 }),
    );
    const ctx = runCtx(store, await connected(store));
    const before = store.platform.seen.length;
    const all = await readAll(ctx);
    expect(all).toHaveLength(131);
    // One products page, then two pages of variations: one request each.
    expect(store.platform.seen.length - before).toBe(3);

    const since = Date.now() - 3_600_000;
    store.products.push(
      simple(61, "Portuguesa", "52.00"),
      simple(62, "Fora do cardápio", "40.00", { status: "trash" }),
      variable(63, "Pizza doce", [variation(64, "Média", "39.00"), variation(65, "Grande", "49.00")], {
        status: "trash",
      }),
    );
    const changed = await readAll(ctx, since);
    expect(changed.map((p) => [p.externalId, p.available])).toEqual([
      ["p:61", true],
      // The variable product changed: all its variations, read after the page that listed it.
      ...Array.from({ length: 130 }, (_, i) => [`v:${1_000 + i}`, true]),
      // Moved to the bin since: off sale now, not at the next full pass; a variable one with all its variations.
      ["p:62", false],
      ["v:64", false],
      ["v:65", false],
    ]);
    const asked = store.platform.seen.filter((r) => r.url.pathname === "/wp-json/wc/v3/products").slice(-2);
    expect(asked.map((r) => [r.url.searchParams.get("status"), r.url.searchParams.get("dates_are_gmt")])).toEqual([
      ["any", "true"],
      ["trash", "true"],
    ]);
    expect(asked[0]?.url.searchParams.get("modified_after")).toBe(new Date(since).toISOString().slice(0, 19));
  });

  it("reads a store whose page builder writes long descriptions: small pages, each read whole", async () => {
    const store = fakeWooStore({ host: "chai-and-co.example.in", name: "Chai & Co", currency: "INR" });
    // A page builder's markup: 150 KB a product, a hundred of which pass what one answer may be.
    const long = `<div class="elementor-section">${"<p>Assam, first flush, hand-rolled.</p>".repeat(3_900)}</div>`;
    expect(long.length).toBeGreaterThan(150_000);
    for (let i = 0; i < 40; i++) store.products.push(simple(100 + i, `Tea ${i + 1}`, "349.00", { description: long }));
    const ctx = runCtx(store, await connected(store));
    const all = await readAll(ctx);
    expect(all).toHaveLength(40);
    expect(all[0]?.description?.length).toBe(1_000);
    expect(store.platform.seen.filter((r) => r.url.pathname === "/wp-json/wc/v3/products")).toHaveLength(2);
  });

  it("prices a store in yen in hundredths, exactly, and refuses a store counted in thousandths", async () => {
    const osaka = fakeWooStore({ host: "zakka-osaka.example.jp", name: "Zakka Osaka", currency: "JPY" });
    osaka.settings.decimals = 0;
    osaka.products.push(simple(1, "Furoshiki, indigo", "1200"));
    const c = await connected(osaka);
    expect(c.extra).toMatchObject({ currency: "JPY" });
    const [furoshiki] = await readAll(runCtx(osaka, c));
    // ¥1,200 is 120000 hundredths, as every amount here is kept; never 1200.
    expect(furoshiki?.price).toEqual({ value: 120_000, currency: "JPY" });
    const order = shopOrder(
      [
        {
          externalId: "p:1",
          sku: null,
          name: "Furoshiki, indigo",
          quantity: 2,
          unit: { value: 120_000, currency: "JPY" },
        },
      ],
      {
        customer: { name: "Haruto Sato", email: "haruto@example.jp", phone: null, language: "ja" },
        shipping: {
          streetAddress: "1-2-3 Namba",
          addressLocality: "Osaka",
          addressRegion: "大阪府",
          addressCountry: "JP",
        },
        note: null,
      },
    );
    const link = await woo.payments?.createLink(runCtx(osaka, c), payRequest(order));
    expect(link?.total).toEqual({ value: 240_000, currency: "JPY" });
    expect([...osaka.orders.values()][0]?.lines[0]?.total).toBe(2_400);

    const kuwait = fakeWooStore({ host: "souq-spices.example.com.kw", name: "Souq Spices", currency: "KWD" });
    await expect(connected(kuwait)).rejects.toMatchObject({
      code: "config",
      field: "store_url",
      message: expect.stringContaining("KWD"),
    });
  });
});

/* --- orders ----------------------------------------------------------------------------------------- */

const margherita = (quantity = 1) => ({
  externalId: "p:11",
  sku: "PZ-MARG",
  name: "Pizza Margherita",
  quantity,
  unit: { value: 4_990, currency: "BRL" },
});

async function pizzaria() {
  const store = fakeWooStore();
  store.products.push(
    simple(11, "Pizza Margherita", "49.90"),
    variable(20, "Pizza Calabresa", [variation(22, "Grande", "69.00")]),
  );
  const c = await connected(store);
  return { store, ctx: runCtx(store, c) };
}

describe("an order the inbox accepts, written into the store", () => {
  it("is pending, at the inbox's prices, with what fulfilling needs and the inbox's marks; paid at the store's checkout", async () => {
    const { store, ctx } = await pizzaria();
    const order = shopOrder([
      margherita(2),
      {
        externalId: "v:22",
        sku: "PZ-CAL-G",
        name: "Pizza Calabresa – Grande",
        quantity: 1,
        unit: { value: 6_500, currency: "BRL" },
      },
      { externalId: null, sku: null, name: "Taxa de entrega", quantity: 1, unit: { value: 800, currency: "BRL" } },
    ]);
    const link = await woo.payments?.createLink(ctx, payRequest(order));
    const [wc] = [...store.orders.values()];
    if (!wc || !link) throw new Error("no order");
    expect(link).toEqual({
      externalId: String(wc.id),
      url: `https://${store.host}/checkout/order-pay/${wc.id}/?pay_for_order=true&key=${wc.order_key}`,
      total: { value: 17_280, currency: "BRL" },
      dashboardUrl: `https://${store.host}/wp-admin/post.php?post=${wc.id}&action=edit`,
    });
    expect(wc.status).toBe("pending");
    // Lines at the prices the customer accepted (the variation for less than the shop's own price).
    expect(wc.lines.map((l) => [l.kind, l.product_id, l.variation_id, l.quantity, l.total, l.name])).toEqual([
      ["line_items", 11, 0, 2, 99.8, "Pizza Margherita"],
      ["line_items", 20, 22, 1, 65, "Pizza Calabresa"],
      // A line the store has no product for is a fee line, named as the order names it.
      ["fee_lines", 0, 0, 1, 8, "Taxa de entrega"],
    ]);
    // The customer in one name field (never split), their note as theirs, the address to deliver to.
    expect(wc.billing).toMatchObject({
      first_name: "Ana Beatriz Souza",
      last_name: "",
      email: "ana.souza@example.com",
      city: "São Paulo",
      country: "BR",
    });
    expect(wc.shipping).toMatchObject({
      first_name: "Ana Beatriz Souza",
      address_1: "Rua Treze de Maio, 120",
      postcode: "01327-000",
    });
    expect(wc.customer_note).toBe("Sem cebola, por favor.");
    expect(wc.meta.map((m) => m.key)).toEqual(["_sdi_ref", "_sdi_mark", "_sdi_reference"]);
    expect(wc.meta[0]?.value).toBe("01JB7Z8K3M4N5P6Q7R8S9T0V1W");
    // A private note for the business, never one the customer is emailed.
    expect(wc.notes).toEqual([
      { note: "Order 4F2K9Q from your agent inbox. Delivery, 2026-10-24T19:30:00-03:00.", customer_note: false },
    ]);
    // What the inbox reads back of an order never includes the customer's details.
    const read = store.platform.seen.filter((r) => r.url.pathname.startsWith("/wp-json/wc/v3/orders"));
    expect(read.every((r) => !/billing|shipping\b/.test(r.url.searchParams.get("_fields") ?? ""))).toBe(true);
  });

  it("is made once: asked again after an answer that never came back, it finds the order it made", async () => {
    const { store, ctx } = await pizzaria();
    const order = shopOrder([margherita()]);
    const first = await woo.payments?.createLink(ctx, payRequest(order));
    const again = await woo.payments?.createLink(ctx, payRequest(order));
    expect(store.orders.size).toBe(1);
    expect(again?.externalId).toBe(first?.externalId);
    // Another link is another order.
    await woo.payments?.createLink(ctx, payRequest(order, "01JB7Z8K3M4N5P6Q7R8S9T0V2X"));
    expect(store.orders.size).toBe(2);
  });

  it("writes a store's tax-inclusive prices without tax, at the store's own rate, so it comes to what was accepted", async () => {
    const store = fakeWooStore({ host: "deshpande-hardware.example.in", name: "Deshpande Hardware", currency: "INR" });
    Object.assign(store.settings, { calcTaxes: true, pricesIncludeTax: true, rate: 0.18 });
    store.products.push(simple(70, "Hammer 500 g", "1180.00"), simple(71, "Wall plugs (100)", "9.99"));
    const ctx = runCtx(store, await connected(store));
    const lines = [
      { externalId: "p:70", sku: null, name: "Hammer 500 g", quantity: 1, unit: { value: 118_000, currency: "INR" } },
      { externalId: "p:71", sku: null, name: "Wall plugs (100)", quantity: 3, unit: { value: 999, currency: "INR" } },
    ];
    const order = shopOrder(lines, {
      customer: { name: "Rahul Deshpande", email: "rahul@example.in", phone: null, language: "mr-IN" },
      shipping: { streetAddress: "FC Road 14", addressLocality: "Pune", addressRegion: "MH", addressCountry: "IN" },
      note: null,
    });
    const link = await woo.payments?.createLink(ctx, payRequest(order));
    expect(link?.total).toEqual({ value: 120_997, currency: "INR" });
    const [wc] = [...store.orders.values()];
    // Each line without the 18% the store adds back: 1,000.00 and 25.398305 before tax.
    expect(wc?.lines.map((l) => l.total.toFixed(6))).toEqual(["1000.000000", "25.398305"]);
  });

  it("leaves a store that adds tax on top to say its own total, which the inbox holds", async () => {
    const store = fakeWooStore({ host: "maple-crust.example.ca", name: "Maple Crust Bakery", currency: "CAD" });
    Object.assign(store.settings, { calcTaxes: true, pricesIncludeTax: false, rate: 0.13 });
    store.products.push(simple(80, "Butter tarts (6)", "18.00"));
    const ctx = runCtx(store, await connected(store));
    const order = shopOrder(
      [
        {
          externalId: "p:80",
          sku: null,
          name: "Butter tarts (6)",
          quantity: 1,
          unit: { value: 1_800, currency: "CAD" },
        },
      ],
      {
        customer: { name: "Émilie Tremblay", email: "emilie@example.ca", phone: null, language: "fr-CA" },
      },
    );
    const link = await woo.payments?.createLink(ctx, payRequest(order));
    expect(link?.total).toEqual({ value: 2_034, currency: "CAD" });
    expect(store.orders.size).toBe(1);
    expect([...store.orders.values()][0]?.lines[0]?.total).toBe(18);
  });

  it("writes the customer's region as the store's own code, so the store's tax rates apply", async () => {
    const store = fakeWooStore({ host: "maple-crust-on.example.ca", name: "Maple Crust Bakery", currency: "CAD" });
    store.products.push(simple(80, "Butter tarts (6)", "18.00"));
    const ctx = runCtx(store, await connected(store));
    const tarts = {
      externalId: "p:80",
      sku: null,
      name: "Butter tarts (6)",
      quantity: 1,
      unit: { value: 1_800, currency: "CAD" },
    };
    const place = async (addressRegion: string, addressCountry: string, ref: string) => {
      await woo.payments?.createLink(
        ctx,
        payRequest(
          shopOrder([tarts], {
            customer: { name: "Émilie Tremblay", email: "emilie@example.ca", phone: null, language: "fr-CA" },
            shipping: { streetAddress: "120 Queen St W", addressLocality: "Toronto", addressRegion, addressCountry },
          }),
          ref,
        ),
      );
      const wc = [...store.orders.values()].at(-1);
      return [wc?.shipping.state ?? null, wc?.billing.state ?? null];
    };
    expect(await place("Ontario", "CA", "01JB7Z8K3M4N5P6Q7R8S9T0A01")).toEqual(["ON", "ON"]);
    expect(await place("québec", "CA", "01JB7Z8K3M4N5P6Q7R8S9T0A02")).toEqual(["QC", "QC"]);
    expect(await place("on", "CA", "01JB7Z8K3M4N5P6Q7R8S9T0A03")).toEqual(["ON", "ON"]);
    expect(await place("IN-MH", "IN", "01JB7Z8K3M4N5P6Q7R8S9T0A04")).toEqual(["MH", "MH"]);
    // A region the store does not list for the country: left out, as WooCommerce does for a place it does not know.
    expect(await place("Atlantis", "CA", "01JB7Z8K3M4N5P6Q7R8S9T0A05")).toEqual([null, null]);
    // A country the store lists no states for: as written.
    expect(await place("Nairobi County", "KE", "01JB7Z8K3M4N5P6Q7R8S9T0A06")).toEqual([
      "Nairobi County",
      "Nairobi County",
    ]);
    // Each country's list asked for once.
    expect(store.countriesAsked).toEqual(["CA", "IN", "KE"]);
  });

  it("says when a store adds tax at checkout: each order's total goes to the owner first", async () => {
    const toronto = fakeWooStore({ host: "maple-crust-tax.example.ca", name: "Maple Crust Bakery", currency: "CAD" });
    Object.assign(toronto.settings, { calcTaxes: true, pricesIncludeTax: false, rate: 0.13 });
    const t = await connected(toronto);
    expect(t.extra).toMatchObject({ taxes: true, prices_include_tax: false });
    expect(woo.notes?.({ extra: t.extra ?? {}, now: Date.now() })).toEqual([
      { text: "Your shop adds tax at checkout, so each order's total goes to you first." },
    ]);
    const pune = fakeWooStore({ host: "deshpande-tax.example.in", name: "Deshpande Hardware", currency: "INR" });
    Object.assign(pune.settings, { calcTaxes: true, pricesIncludeTax: true, rate: 0.18 });
    const p = await connected(pune);
    expect(p.extra).toMatchObject({ prices_include_tax: true });
    expect(woo.notes?.({ extra: p.extra ?? {}, now: Date.now() })).toEqual([]);
  });

  it("writes nothing for an order in another currency than the store's", async () => {
    const { store, ctx } = await pizzaria();
    const order = shopOrder([{ ...margherita(), unit: { value: 1_000, currency: "USD" } }]);
    await expect(woo.payments?.createLink(ctx, payRequest(order))).rejects.toMatchObject({ code: "refused" });
    expect(store.orders.size).toBe(0);
  });
});

describe("what the store says became of an order", () => {
  async function made() {
    const { store, ctx } = await pizzaria();
    const req = payRequest(shopOrder([margherita()]));
    const link = await woo.payments?.createLink(ctx, req);
    const id = Number(link?.externalId);
    return { store, ctx, id, known: { ref: req.ref, externalId: String(id), itemId: req.itemId } };
  }

  it("is paid once the store says processing with a date paid, read with the key, in the receipt's words", async () => {
    const { store, ctx, id, known } = await made();
    expect(await woo.payments?.check(ctx, known)).toEqual([]);
    store.pay(id, "stripe", "pi_br_123");
    const [fact] = (await woo.payments?.check(ctx, known)) ?? [];
    expect(fact).toMatchObject({
      status: "paid",
      linkId: String(id),
      ref: known.ref,
      paymentId: `order-${id}`,
      amount: { value: 4_990, currency: "BRL" },
      method: "card",
      livemode: true,
      dashboardUrl: `https://${store.host}/wp-admin/post.php?post=${id}&action=edit`,
    });
    expect(typeof fact?.paidAt).toBe("number");
  });

  it("is not paid by cash on delivery until the order is completed", async () => {
    const { store, ctx, id, known } = await made();
    store.pay(id, "cod");
    expect(await woo.payments?.check(ctx, known)).toEqual([]);
    store.complete(id);
    expect(await woo.payments?.check(ctx, known)).toMatchObject([{ status: "paid", method: "cash" }]);
  });

  it("is fulfilled when completed (with its tracking, when recorded), cancelled when cancelled, binned or gone", async () => {
    const { store, ctx, id, known } = await made();
    expect(await woo.payments?.orderState?.(ctx, known)).toBeNull();
    store.pay(id);
    store.complete(id, { tracking_provider: "Correios", tracking_number: "BR123456789BR", custom_tracking_link: "" });
    expect(await woo.payments?.orderState?.(ctx, known)).toMatchObject({
      state: "fulfilled",
      tracking: { carrier: "Correios", number: "BR123456789BR" },
    });
    for (const status of ["cancelled", "trash"]) {
      store.setStatus(id, status);
      expect(await woo.payments?.orderState?.(ctx, known), status).toMatchObject({
        state: "cancelled",
        linkId: String(id),
      });
    }
    store.orders.delete(id);
    expect(await woo.payments?.orderState?.(ctx, known)).toMatchObject({ state: "cancelled" });
    expect(await woo.payments?.check(ctx, known)).toEqual([]);
  });

  it("says what was refunded of it, in all, newest refund first", async () => {
    const { store, ctx, id } = await made();
    store.pay(id);
    expect(await woo.payments?.refunded?.(ctx, { paymentId: `order-${id}` })).toBeNull();
    store.refund(id, 10);
    store.refund(id, 5.5);
    const r = await woo.payments?.refunded?.(ctx, { paymentId: `order-${id}` });
    expect(r?.amount).toEqual({ value: 1_550, currency: "BRL" });
    expect(Number(r?.refundIds[0])).toBeGreaterThan(Number(r?.refundIds[1]));
    expect(await woo.payments?.refunded?.(ctx, { paymentId: "pi_not_an_order" })).toBeNull();
  });

  it("says a refund in full, which leaves the order refunded and no longer paid", async () => {
    const { store, ctx, id } = await made();
    store.pay(id);
    store.refund(id, 49.9);
    expect(store.orders.get(id)?.status).toBe("refunded");
    const facts = await woo.hooks?.read(ctx, { eventId: "x", topic: "order.updated", refs: [String(id)] });
    expect(facts).toEqual([
      {
        kind: "order",
        fact: expect.objectContaining({ state: "refunded", refunded: { value: 4_990, currency: "BRL" } }),
      },
    ]);
  });

  it("believes no order that is not this inbox's: another inbox's mark, or none, is nothing", async () => {
    const { store, ctx, id, known } = await made();
    store.pay(id);
    // Asked about under another link of this inbox's: not that link's order.
    expect(await woo.payments?.check(ctx, { ...known, ref: "01JB7Z8K3M4N5P6Q7R8S9T0ZZZ" })).toEqual([]);
    expect(await woo.payments?.check(ctx, known)).toHaveLength(1);
    // Another inbox's mark (a second inbox on the same store), or anyone's who writes `_sdi_ref`.
    const mark = store.orders.get(id)?.meta.find((m) => m.key === "_sdi_mark");
    if (mark) mark.value = "0".repeat(32);
    expect(await woo.payments?.check(ctx, known)).toEqual([]);
    expect(await woo.payments?.orderState?.(ctx, known)).toBeNull();
    await woo.payments?.closeLink(ctx, { externalId: String(id) });
    expect(store.orders.get(id)?.status).toBe("processing");
  });

  it("closes a link by cancelling the store's order while it is still unpaid, and leaves one paid meanwhile", async () => {
    const { store, ctx, id } = await made();
    await woo.payments?.closeLink(ctx, { externalId: String(id) });
    expect(store.orders.get(id)?.status).toBe("cancelled");
    const second = await made();
    second.store.pay(second.id);
    await woo.payments?.closeLink(second.ctx, { externalId: String(second.id) });
    expect(second.store.orders.get(second.id)?.status).toBe("processing");
    // Gone already: done.
    second.store.orders.delete(second.id);
    await expect(woo.payments?.closeLink(second.ctx, { externalId: String(second.id) })).resolves.toBeUndefined();
  });
});

/* --- webhooks ------------------------------------------------------------------------------------- */

describe("the store's webhooks", () => {
  async function hooked() {
    const { store, ctx } = await pizzaria();
    const kept = await woo.refresh?.(ctx);
    const live = runCtx(store, {
      account: "",
      externalId: "",
      secret: ctx.secret,
      extra: kept?.extra ?? {},
      calendars: [],
      destinations: [],
      defaults: { busy: [], destination: null },
    });
    return { store, ctx: live };
  }

  it("are made once the inbox answers, signed with a secret kept before the store is told it, and pinged", async () => {
    const { store, ctx } = await pizzaria();
    expect(woo.stale?.(ctx)).toBe(true);
    const fresh = await woo.refresh?.(ctx);
    expect(ctx.saved).toHaveLength(1);
    const secret = ctx.saved[0]?.hook_secret ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...store.webhooks.values()].map((w) => [w.topic, w.delivery_url, w.secret, w.status])).toEqual([
      ["order.updated", HOOK, secret, "active"],
      ["product.updated", HOOK, secret, "active"],
      ["product.deleted", HOOK, secret, "active"],
    ]);
    expect([...store.webhooks.values()][0]?.name).toBe(
      "Agent inbox (inbox.pizzaria-bixiga.example.com) · order.updated",
    );
    expect(fresh).toMatchObject({ account: "Pizzaria Bixiga", extra: { webhook: "added", hook_url: HOOK } });
    expect(store.pings).toHaveLength(3);
    // A ping is answered, and names nothing.
    expect(
      await woo.hooks?.verify(
        ctx,
        posted(store.pings[0]?.body ?? "", { "content-type": "application/x-www-form-urlencoded" }),
      ),
    ).toBeNull();
  });

  it("are not made while a hosted inbox is not live yet, and are once it is", async () => {
    const { store, ctx } = await pizzaria();
    const early = runCtx(
      store,
      {
        account: "",
        externalId: "",
        secret: ctx.secret,
        extra: ctx.extra,
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
      },
      { hooksLive: false },
    );
    expect(woo.stale?.(early)).toBe(false);
    const r = await woo.refresh?.(early);
    expect(store.webhooks.size).toBe(0);
    expect(r?.extra).toMatchObject({ webhook: "pending" });
  });

  it("check the signature over the exact bytes: one byte off, or none, is refused; a delivery names only ids", async () => {
    const { store, ctx } = await hooked();
    const req = payRequest(shopOrder([margherita()]));
    const link = await woo.payments?.createLink(ctx, req);
    const id = Number(link?.externalId);
    const good = await store.delivery("order.updated", id, { deliveryId: "5f2b9c0d1e3a4b6c7d8e9f0a1b2c3d4e" });
    const event = await woo.hooks?.verify(ctx, posted(good.body, good.headers));
    const hookId = good.headers["x-wc-webhook-id"];
    expect(event).toEqual({
      eventId: expect.stringMatching(new RegExp(`^${hookId}:[0-9a-f]{40}$`)),
      topic: "order.updated",
      refs: [String(id)],
    });
    // The same delivery again is the same event: the base counts it once.
    expect((await woo.hooks?.verify(ctx, posted(good.body, good.headers)))?.eventId).toBe(event?.eventId);
    const tampered = await store.delivery("order.updated", id, { tamper: true });
    await expect(woo.hooks?.verify(ctx, posted(tampered.body, tampered.headers))).rejects.toBeInstanceOf(
      ConnectorError,
    );
    await expect(woo.hooks?.verify(ctx, posted(`${good.body} `, good.headers))).rejects.toBeInstanceOf(ConnectorError);
    const unsigned = Object.fromEntries(Object.entries(good.headers).filter(([k]) => k !== "x-wc-webhook-signature"));
    await expect(woo.hooks?.verify(ctx, posted(good.body, unsigned))).rejects.toBeInstanceOf(ConnectorError);
  });

  it("tell two orders in one second apart, though WooCommerce gives both the same delivery id", async () => {
    const { store, ctx } = await hooked();
    const a = Number((await woo.payments?.createLink(ctx, payRequest(shopOrder([margherita()]))))?.externalId);
    const b = Number(
      (await woo.payments?.createLink(ctx, payRequest(shopOrder([margherita(3)]), "01JB7Z8K3M4N5P6Q7R8S9T0V2X")))
        ?.externalId,
    );
    // wp_hash( $webhook_id . strtotime( 'now' ) ): one second, one delivery id for every delivery of the webhook.
    const same = { deliveryId: "901f2b9c0d1e3a4b6c7d8e9f0a1b2c3d" };
    const da = await store.delivery("order.updated", a, same);
    const db = await store.delivery("order.updated", b, same);
    expect(da.headers["x-wc-webhook-delivery-id"]).toBe(db.headers["x-wc-webhook-delivery-id"]);
    const first = await woo.hooks?.verify(ctx, posted(da.body, da.headers));
    const second = await woo.hooks?.verify(ctx, posted(db.body, db.headers));
    expect(first?.refs).toEqual([String(a)]);
    expect(second?.refs).toEqual([String(b)]);
    expect(first?.eventId).not.toBe(second?.eventId);
    // The same order changed again in that second is another event too; the same delivery again is not.
    store.pay(a);
    const changed = await store.delivery("order.updated", a, same);
    expect((await woo.hooks?.verify(ctx, posted(changed.body, changed.headers)))?.eventId).not.toBe(first?.eventId);
  });

  it("let go, unkept, an order the shop took itself at its own checkout", async () => {
    const { store, ctx } = await hooked();
    store.orders.set(5_001, {
      id: 5_001,
      status: "processing",
      currency: "BRL",
      created: Date.now(),
      paid: Date.now(),
      completed: null,
      payment_method: "stripe",
      transaction_id: "pi_checkout",
      billing: { first_name: "Kenji Watanabe", email: "kenji@example.jp" },
      shipping: {},
      customer_note: "",
      lines: [],
      shipping_lines: [],
      refunds: [],
      meta: [{ id: 1, key: "_wc_order_attribution_source_type", value: "typein" }],
      notes: [],
      order_key: "wc_order_checkout",
    });
    const d = await store.delivery("order.updated", 5_001);
    expect(await woo.hooks?.verify(ctx, posted(d.body, d.headers))).toBeNull();
  });

  it("are read back with the key, never believed: a body that says completed, for an order still pending, is nothing", async () => {
    const { store, ctx } = await hooked();
    const link = await woo.payments?.createLink(ctx, payRequest(shopOrder([margherita()])));
    const id = Number(link?.externalId);
    const d = await store.delivery("order.updated", id);
    // Signed with the webhook's own secret, so it checks out: but what it says is not what the store holds.
    const lying = JSON.parse(d.body) as Record<string, unknown>;
    lying.status = "completed";
    lying.date_paid_gmt = "2026-10-20T12:00:00";
    const body = JSON.stringify(lying);
    const secret = [...store.webhooks.values()][0]?.secret ?? "";
    const headers = { ...d.headers, "x-wc-webhook-signature": await hmacSha256Base64(secret, body) };
    const event = await woo.hooks?.verify(ctx, posted(body, headers));
    if (!event) throw new Error("no event");
    expect(await woo.hooks?.read(ctx, event)).toEqual([]);
    store.pay(id);
    store.refund(id, 4.99);
    expect(
      (await woo.hooks?.read(ctx, event))?.map((f) => [
        f.kind,
        f.kind === "order" ? f.fact.state : f.kind === "payment" ? f.fact.status : null,
      ]),
    ).toEqual([
      ["payment", "paid"],
      ["order", "refunded"],
    ]);
  });

  it("say products changed, a variation by its own id and its parent's", async () => {
    const { store, ctx } = await hooked();
    const d = await store.delivery("product.updated", 22);
    const event = await woo.hooks?.verify(ctx, posted(d.body, d.headers));
    expect(event?.refs).toEqual(["v:22", "p:20"]);
    expect(await woo.hooks?.read(ctx, event as NonNullable<typeof event>)).toEqual([
      { kind: "catalogue", externalIds: ["v:22", "p:20"] },
    ]);
  });

  it("are kept as they should be: moved with the inbox, switched back on, made again when removed in the store", async () => {
    const { store, ctx } = await hooked();
    const [order, product, deleted] = [...store.webhooks.values()];
    if (!order || !product || !deleted) throw new Error("no webhooks");
    order.status = "disabled";
    store.webhooks.delete(deleted.id);
    const moved =
      "https://inbox.pizzariabixiga.example.com.br/v1/hooks/woocommerce/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh2";
    const there = runCtx(
      store,
      {
        account: "",
        externalId: "",
        secret: ctx.secret,
        extra: ctx.extra,
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
      },
      { hookUrl: moved },
    );
    expect(woo.stale?.(there)).toBe(true);
    const r = await woo.refresh?.(there);
    expect([...store.webhooks.values()].map((w) => [w.topic, w.delivery_url, w.status])).toEqual([
      ["order.updated", moved, "active"],
      ["product.updated", moved, "active"],
      ["product.deleted", moved, "active"],
    ]);
    expect(r?.extra).toMatchObject({ hook_url: moved, webhook: "added" });
  });

  it("are taken over, not made again, when the store is approved again; a second one of a topic goes", async () => {
    const { store } = await hooked();
    expect(store.webhooks.size).toBe(3);
    // A stray second one of this inbox's own, as a store approved twice would have.
    const stray = { ...([...store.webhooks.values()][0] as NonNullable<ReturnType<typeof store.webhooks.get>>) };
    store.webhooks.set(9_999, { ...stray, id: 9_999, delivery_url: `${HOOK.slice(0, -43)}${"Q".repeat(43)}` });
    // Approved again: a new key, a connection that knows no webhook by id, at a new address of this inbox.
    store.addKey(`ck_${"3".repeat(40)}`, `cs_${"4".repeat(40)}`);
    const again = (await woo.oauth?.receivePosted?.(
      connectCtx(store),
      posted(
        JSON.stringify({
          key_id: 77,
          user_id: "st4te",
          consumer_key: `ck_${"3".repeat(40)}`,
          consumer_secret: `cs_${"4".repeat(40)}`,
          key_permissions: "read_write",
        }),
      ),
      { store_url: store.base },
    )) as Connected;
    const fresh = `${HOOK.slice(0, -43)}${"Z".repeat(43)}`;
    const r = await woo.refresh?.(runCtx(store, again, { hookUrl: fresh }));
    expect([...store.webhooks.values()].map((w) => [w.topic, w.delivery_url, w.status])).toEqual([
      ["order.updated", fresh, "active"],
      ["product.updated", fresh, "active"],
      ["product.deleted", fresh, "active"],
    ]);
    expect(r?.extra).toMatchObject({ webhook: "added", hook_url: fresh });
    // Another inbox's webhook on the same store is never touched.
    store.webhooks.set(8_888, {
      id: 8_888,
      name: "Agent inbox (inbox.another-business.example.org) · order.updated",
      topic: "order.updated",
      delivery_url: "https://inbox.another-business.example.org/v1/hooks/woocommerce/abc",
      secret: "theirs",
      status: "active",
    });
    await woo.refresh?.(runCtx(store, { ...again, extra: r?.extra }, { hookUrl: fresh }));
    expect(store.webhooks.get(8_888)?.secret).toBe("theirs");
  });

  it("say, connected again in place by a new approval, to remove the earlier key, and where", async () => {
    const { store, ctx } = await hooked();
    store.addKey(`ck_${"3".repeat(40)}`, `cs_${"4".repeat(40)}`);
    const before: Record<string, unknown> = { ...ctx.extra, via: "authorize", key_id: 41 };
    const again = (await woo.oauth?.receivePosted?.(
      { ...connectCtx(store), previous: { externalId: "pizzaria-bixiga.example.com", extra: before } },
      posted(
        JSON.stringify({
          key_id: 77,
          user_id: "st4te",
          consumer_key: `ck_${"3".repeat(40)}`,
          consumer_secret: `cs_${"4".repeat(40)}`,
          key_permissions: "read_write",
        }),
      ),
      { store_url: store.base },
    )) as Connected;
    // What was found of the store before is kept, and its webhooks by id.
    expect(again.extra).toMatchObject({ currency: "BRL", key_id: 77, hooks: before.hooks, earlier_key: { id: 41 } });
    const notes = woo.notes?.({ extra: again.extra ?? {}, now: Date.now() }) ?? [];
    expect(notes).toEqual([
      {
        text: "Your shop made this inbox a new key. Remove the earlier Agent inbox key in WooCommerce → Settings → Advanced → REST API.",
        href: `${store.base}/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys&edit-key=41`,
        link: "Remove it",
      },
    ]);
    // Two weeks on, it is not said again.
    expect(woo.notes?.({ extra: again.extra ?? {}, now: Date.now() + 15 * 86_400_000 })).toEqual([]);
  });

  it("are taken out of the store on disconnect; the key is the owner's to remove", async () => {
    const { store, ctx } = await hooked();
    expect(store.webhooks.size).toBe(3);
    await woo.disconnect?.(ctx);
    expect(store.webhooks.size).toBe(0);
    expect(
      store.platform.seen.filter((r) => r.method === "DELETE").every((r) => r.url.searchParams.get("force") === "true"),
    ).toBe(true);
    expect(woo.disconnectNote).toBe(
      "Then remove the key named Agent inbox in WooCommerce → Settings → Advanced → REST API.",
    );
    // Gone already is gone.
    await expect(woo.disconnect?.(ctx)).resolves.toBeUndefined();
  });
});

describe("what never leaves", () => {
  it("never says the key or its secret, in an error or in what the connection keeps", async () => {
    const store = fakeWooStore();
    store.quirks.dropsAuthHeader = true;
    const c = await connected(store);
    const ctx = runCtx(store, c);
    store.keys.clear();
    let message = "";
    try {
      await woo.catalogue?.page(ctx, { cursor: null, since: null });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("did not take");
    expect(message).not.toContain(store.manual.key);
    expect(message).not.toContain(store.manual.secret);
    expect(JSON.stringify(c.extra)).not.toContain(store.manual.key);
  });
});
