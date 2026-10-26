import { ConnectorError, type ConnectorHttp, type OutboundOrder, type RunContext } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  cloverConnector,
  deliverectConnector,
  flipdishConnector,
  gloriafoodConnector,
  lightspeedConnector,
  minorOf,
  toastConnector,
} from "../src/index";
import { fakePlatform, json } from "./fakes/platform";
import { deliverectStatus, fakeDeliverect, fakeFlipdish, fakeGloriaFood, fakeToast } from "./fakes/pos";
import { cardDataSent } from "./fakes/work";
import {
  DELIVERECT_LINK,
  DELIVERECT_PARTNER,
  FLIPDISH_CLIENT_ID,
  FLIPDISH_SECRET,
  GLORIA_MASTER_KEY,
  GLORIA_MENU_KEY,
  GLORIA_ORDERS_KEY,
  TOAST_HOST,
  TOAST_PARTNER,
  TOAST_RESTAURANT,
} from "./fixtures/pos";

/**
 * The food connectors (ADR-036) against local fakes of their published references: GloriaFood and
 * Flipdish with what the owner makes in their own account (switched on); Toast, Lightspeed, Clover and
 * Deliverect built and switched off until the server holds their partner apps, each with a fake that
 * has a menu and takes an order, accepts it and rejects it. Prices arrive in the minor unit of their
 * currency, allergens unconfirmed, and no card data ever leaves. Runs on Node and in workerd.
 */

const T0 = Date.parse("2026-11-04T17:00:00Z");
const INBOX = {
  id: "inb_v01c",
  origin: "https://volcan.example",
  host: "volcan.example",
  name: "Pizzería Volcán",
  timezone: "America/Mexico_City",
  language: "es",
  currency: "MXN",
};

function ctx(http: ConnectorHttp, secret: Record<string, string>, over: Partial<RunContext> = {}): RunContext {
  return {
    http,
    now: T0,
    inbox: INBOX,
    secret,
    extra: {},
    calendars: [],
    busyCalendars: [],
    destinations: [],
    destination: null,
    own: { ids: new Set(), spans: [] },
    marker: "marker-only-this-inbox-makes",
    async saveSecret() {},
    ...over,
  };
}

const connectCtx = (http: ConnectorHttp) => ({ http, now: T0, inbox: INBOX });

function outbound(over: Partial<OutboundOrder> = {}): OutboundOrder {
  return {
    itemId: "01JC7Q2M4X9ZK8T3R5V6W7Y8Z0",
    reference: "W7Y8Z0",
    key: "inb_v01c:01JC7Q2M4X9ZK8T3R5V6W7Y8Z0",
    method: "pickup",
    slotStart: Date.parse("2026-11-04T18:00:00Z"),
    lines: [
      {
        externalId: "22222222-0000-4000-8000-000000000001",
        groupExternalId: "11111111-0000-4000-8000-000000000001",
        name: "Pizza diavola",
        quantity: 2,
        unitPrice: { value: 23400, currency: "MXN" },
        options: [
          {
            name: "Orilla rellena",
            externalId: "44444444-0000-4000-8000-000000000001",
            groupExternalId: "33333333-0000-4000-8000-000000000001",
            priceDelta: { value: 3500, currency: "MXN" },
            portion: "whole",
          },
        ],
        note: "bien cocida",
      },
    ],
    total: { value: 46800, currency: "MXN" },
    fee: null,
    tip: null,
    paid: false,
    customer: { firstName: "Itzel", phone: null },
    address: null,
    note: null,
    ...over,
  };
}

async function refusal(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("prices in each currency's minor unit", () => {
  it("reads a till's decimals as its currency's unit, never a float times a hundred", () => {
    expect(minorOf(4.37, "EUR")).toBe(437);
    expect(minorOf(0.7, "USD")).toBe(70);
    expect(minorOf(189, "MXN")).toBe(18900);
    expect(minorOf(18000, "KRW")).toBe(18000);
    expect(minorOf(4800, "JPY")).toBe(4800);
    expect(minorOf(1.25, "KWD")).toBe(1250);
    expect(minorOf(-1, "EUR")).toBeNull();
    expect(minorOf("x", "EUR")).toBeNull();
  });
});

describe("GloriaFood (on): the Fetch Menu key, the accepted orders the owner chose to see", () => {
  it("connects with the menu key, and reads the menu with sizes, the category's groups, tags and allergens unconfirmed", async () => {
    const p = fakePlatform();
    fakeGloriaFood(p);
    const def = gloriafoodConnector();
    const c = await def.connect?.(connectCtx(p.http), { menuKey: GLORIA_MENU_KEY });
    expect(c?.externalId).toBe("4172");
    expect(c?.choices?.[0]).toMatchObject({ key: "orders_view", value: "off" });
    const snap = await def.setup?.read(ctx(p.http, { menuKey: GLORIA_MENU_KEY }));
    expect(snap?.source).toMatchObject({ kind: "gloriafood", account: "4172" });
    const pizza = snap?.menu?.[0]?.items[0];
    expect(pizza).toMatchObject({
      externalId: "58424",
      name: "Pizza Margherita",
      price: { value: 700, currency: "USD" },
      dietary: ["vegetarian"],
    });
    expect(pizza?.optionGroups?.map((g) => [g.name, g.min, g.max])).toEqual([
      ["Size", 1, 1],
      ["Extra Toppings (Small)", 0, 1],
      ["Crust", 1, 1],
    ]);
    expect(pizza?.optionGroups?.[0]?.choices.map((x) => [x.name, x.priceDelta])).toEqual([
      ["Small", 0],
      ["Large", 200],
    ]);
    expect(pizza?.optionGroups?.[1]?.choices.map((x) => x.priceDelta)).toEqual([70, 120]);
    const pasta = snap?.menu?.[1]?.items[0];
    expect(pasta?.allergens).toEqual({
      contains: ["milk", "eggs", "crustaceans", "soy", "peanuts"],
      status: "unconfirmed",
    });
    const glf = p.seen.find((r) => r.url.pathname === "/pos/menu");
    expect(glf?.headers.get("glf-api-version")).toBe("2");
  });

  it("a key GloriaFood does not take is the key's to fix; a 429 says slow down", async () => {
    const p = fakePlatform();
    fakeGloriaFood(p);
    const e = await refusal(
      gloriafoodConnector().connect?.(connectCtx(p.http), { menuKey: "wrong-key-0000" }) as Promise<unknown>,
    );
    expect([e.code, e.field]).toEqual(["auth", "menuKey"]);
    p.fail("GET", "https://pos.globalfoodsoft.com/pos/menu", 429);
    const slow = await refusal(
      gloriafoodConnector().setup?.read(ctx(p.http, { menuKey: GLORIA_MENU_KEY })) as Promise<unknown>,
    );
    expect([slow.code, slow.retryAfterMs]).toEqual(["rate_limited", 7000]);
  });

  it("hands over each accepted order once, and keeps nothing of who ordered or where they live", async () => {
    const p = fakePlatform();
    fakeGloriaFood(p);
    const def = gloriafoodConnector();
    const first = await def.elsewhere?.poll(ctx(p.http, { menuKey: GLORIA_MENU_KEY, ordersKey: GLORIA_ORDERS_KEY }));
    expect(first).toEqual([
      {
        externalId: "6819",
        acceptedAt: Date.parse("2019-05-29T14:51:52.000Z"),
        method: "delivery",
        fulfilAt: Date.parse("2019-05-29T15:46:52.000Z"),
        total: { value: 4114, currency: "EUR" },
        lines: [{ name: "Pizza Margherita", quantity: 1, options: ["Large"] }],
      },
    ]);
    expect(JSON.stringify(first)).not.toMatch(/John|Doe|gmail|\+1212|Main street|127\.0\.0\.1|53\.32/);
    expect(await def.elsewhere?.poll(ctx(p.http, { menuKey: GLORIA_MENU_KEY, ordersKey: GLORIA_ORDERS_KEY }))).toEqual(
      [],
    );
    // Without the orders key, nothing is asked at all.
    const before = p.seen.length;
    expect(await def.elsewhere?.poll(ctx(p.http, { menuKey: GLORIA_MENU_KEY }))).toEqual([]);
    expect(p.seen.length).toBe(before);
  });

  it("takes a push only with GloriaFood's master key, in constant time, and keeps only the orders' ids", async () => {
    const def = gloriafoodConnector();
    const body = JSON.stringify({ count: 1, orders: [{ id: 6819, client_email: "john.doe@gmail.com" }] });
    const push = (auth: string) => ({
      headers: new Headers({ authorization: auth }),
      body,
      query: new URLSearchParams(),
    });
    const c = ctx(fakePlatform().http, { menuKey: GLORIA_MENU_KEY, masterKey: GLORIA_MASTER_KEY });
    expect(await def.hooks?.verify(c, push(GLORIA_MASTER_KEY))).toEqual({
      eventId: "orders:6819",
      topic: "orders",
      refs: ["6819"],
    });
    for (const wrong of ["", `${GLORIA_MASTER_KEY}x`, GLORIA_MASTER_KEY.slice(0, -1)]) {
      expect((await refusal(def.hooks?.verify(c, push(wrong)) as Promise<unknown>)).code).toBe("refused");
    }
    expect(
      (
        await refusal(
          def.hooks?.verify(
            ctx(fakePlatform().http, { menuKey: GLORIA_MENU_KEY }),
            push(GLORIA_MASTER_KEY),
          ) as Promise<unknown>,
        )
      ).code,
    ).toBe("refused");
    expect(await def.hooks?.read(c, { eventId: "orders:6819", topic: "orders", refs: ["6819"] })).toEqual([
      { kind: "sync" },
    ]);
  });
});

describe("Flipdish (on): an app the owner makes in their own account", () => {
  it("asks for a token with the app's own client, lists the stores to choose from, and reads the menu and the collection hours", async () => {
    const p = fakePlatform();
    fakeFlipdish(p);
    const def = flipdishConnector();
    const c = await def.connect?.(connectCtx(p.http), { clientId: FLIPDISH_CLIENT_ID, clientSecret: FLIPDISH_SECRET });
    expect(c).toMatchObject({ account: "Pizzería Volcán Roma Norte", externalId: `app:${FLIPDISH_CLIENT_ID}` });
    expect(c?.choices?.[0]).toMatchObject({ key: "store", value: "18452" });
    const token = p.seen.find((r) => r.url.pathname === "/identity/connect/token");
    expect(Object.fromEntries(new URLSearchParams(token?.body ?? ""))).toEqual({
      grant_type: "client_credentials",
      client_id: FLIPDISH_CLIENT_ID,
      client_secret: FLIPDISH_SECRET,
      scope: "api",
    });
    const snap = await def.setup?.read(
      ctx(p.http, { clientId: FLIPDISH_CLIENT_ID, clientSecret: FLIPDISH_SECRET }, { choices: { store: "18452" } }),
    );
    expect(snap?.source).toMatchObject({ kind: "flipdish", account: "18452", zone: "America/Mexico_City" });
    expect(snap?.hours).toEqual({ mon: [["12:00", "22:00"]], fri: [["12:00", "24:00"]], sat: [["13:00", "24:00"]] });
    expect(snap?.menu).toHaveLength(1);
    expect(snap?.menu?.[0]?.items[0]).toMatchObject({
      externalId: "501",
      price: { value: 18900, currency: "MXN" },
      optionGroups: [
        {
          name: "Tamaño",
          min: 1,
          max: 1,
          choices: [
            { name: "Chica", priceDelta: 0 },
            { name: "Grande", priceDelta: 6000 },
          ],
        },
      ],
    });
    expect(snap?.menu?.[0]?.items[0]?.allergens).toBeUndefined();
  });

  it("closes the store for collection and delivery while paused, and opens only the closures it made", async () => {
    const p = fakePlatform();
    const fd = fakeFlipdish(p);
    const def = flipdishConnector();
    let secret: Record<string, string> = { clientId: FLIPDISH_CLIENT_ID, clientSecret: FLIPDISH_SECRET };
    const run = () =>
      ctx(p.http, secret, {
        choices: { store: "18452" },
        async saveSecret(next) {
          secret = { ...next };
        },
      });
    fd.overrides.push(
      {
        BusinessHoursOverrideId: 1,
        DeliveryType: "Pickup",
        StartTime: "2026-12-24T06:00:00Z",
        EndTime: "2026-12-26T06:00:00Z",
        Type: "Closed",
      },
      // The owner's own closure for this evening, set in Flipdish: it holds now, and it stays.
      {
        BusinessHoursOverrideId: 2,
        DeliveryType: "Delivery",
        StartTime: new Date(T0 - 60 * 60_000).toISOString(),
        EndTime: new Date(T0 + 4 * 60 * 60_000).toISOString(),
        Type: "Closed",
      },
    );
    await def.pause?.pause(run(), T0 + 30 * 60_000);
    expect(
      fd.overrides
        .filter((o) => o.StartTime === new Date(T0).toISOString())
        .map((o) => [o.DeliveryType, o.Type, o.EndTime]),
    ).toEqual([
      ["Pickup", "Closed", new Date(T0 + 30 * 60_000).toISOString()],
      ["Delivery", "Closed", new Date(T0 + 30 * 60_000).toISOString()],
    ]);
    expect(secret.pauseOverrides).toBe("700,701");
    await def.pause?.resume(run());
    expect(fd.overrides.map((o) => o.BusinessHoursOverrideId)).toEqual([1, 2]);
    expect(secret.pauseOverrides).toBeUndefined();
    expect(secret.clientSecret).toBe(FLIPDISH_SECRET);
  });

  it("never pauses another store than the one chosen: one gone from the app is said so", async () => {
    const p = fakePlatform();
    const fd = fakeFlipdish(p);
    const c = ctx(
      p.http,
      { clientId: FLIPDISH_CLIENT_ID, clientSecret: FLIPDISH_SECRET },
      { choices: { store: "99999" } },
    );
    const e = await refusal(flipdishConnector().pause?.pause(c, T0 + 30 * 60_000) as Promise<unknown>);
    expect(e.code).toBe("not_found");
    expect(fd.overrides).toEqual([]);
  });

  it("a client Flipdish does not take is the secret's to fix", async () => {
    const p = fakePlatform();
    fakeFlipdish(p);
    const e = await refusal(
      flipdishConnector().connect?.(connectCtx(p.http), {
        clientId: FLIPDISH_CLIENT_ID,
        clientSecret: "not-the-secret",
      }) as Promise<unknown>,
    );
    expect([e.code, e.field]).toEqual(["auth", "clientSecret"]);
  });
});

describe("tills built and switched off until the server holds their partner apps", () => {
  it("say Needs setup, and connect nothing", async () => {
    for (const def of [
      toastConnector(null),
      lightspeedConnector(null),
      cloverConnector(null),
      deliverectConnector(null),
    ]) {
      expect(def.ready?.(), def.kind).toMatch(/^Needs setup: /);
      expect(def.whenNotReady?.status).toBe("setup");
    }
    expect(toastConnector({ ...TOAST_PARTNER, apiHost: "https://toast.example.com" }).ready?.()).toMatch(
      /^Needs setup/,
    );
  });
});

describe("Toast (off): menus in, accepted orders out, its approval back", () => {
  const def = toastConnector(TOAST_PARTNER);
  const run = (http: ConnectorHttp) =>
    ctx(http, {}, { extra: { restaurant: TOAST_RESTAURANT }, choices: { restaurant: TOAST_RESTAURANT } });

  it("lists the restaurants that gave access, and reads the menu with its modifier groups", async () => {
    const p = fakePlatform();
    fakeToast(p);
    expect(def.ready?.()).toBe(true);
    const c = await def.connect?.(connectCtx(p.http), {});
    expect(c).toMatchObject({ externalId: TOAST_RESTAURANT, account: "Pizzería Volcán, Roma Norte" });
    const snap = await def.setup?.read(run(p.http));
    expect(snap?.menu?.[0]?.items[0]).toMatchObject({
      externalId: "22222222-0000-4000-8000-000000000001",
      groupExternalId: "11111111-0000-4000-8000-000000000001",
      price: { value: 19900, currency: "MXN" },
      optionGroups: [
        {
          externalId: "33333333-0000-4000-8000-000000000001",
          name: "Orilla",
          min: 0,
          max: 1,
          choices: [{ name: "Orilla rellena", priceDelta: 3500 }],
        },
      ],
    });
  });

  it("posts an order on its dining option with Toast's own guids, then reads its approval: accepted, or refused", async () => {
    const p = fakePlatform();
    const toast = fakeToast(p);
    const ref = await def.orders?.put(run(p.http), outbound());
    expect(ref).toEqual({ externalId: "ord-1", status: "pending" });
    const sent = toast.orders.get("ord-1")?.sent as Record<string, unknown>;
    expect(sent.diningOption).toEqual({ guid: "d0000000-0000-4000-8000-00000000take", entityType: "DiningOption" });
    expect(String(sent.externalId)).toMatch(/^SURFINGDOG:[0-9a-f-]{36}$/);
    // As the Orders OpenAPI asks of a POST: the item's menu group, each modifier's option group; and no
    // customer, since Toast takes one only with a last name, an email and a phone the inbox never hands on.
    expect((sent.checks as { selections: unknown[] }[])[0]?.selections).toEqual([
      {
        item: { guid: "22222222-0000-4000-8000-000000000001", entityType: "MenuItem" },
        itemGroup: { guid: "11111111-0000-4000-8000-000000000001", entityType: "MenuGroup" },
        quantity: 2,
        modifiers: [
          {
            item: { guid: "44444444-0000-4000-8000-000000000001", entityType: "MenuItem" },
            optionGroup: { guid: "33333333-0000-4000-8000-000000000001", entityType: "MenuOptionGroup" },
            quantity: 1,
          },
        ],
        specialRequest: "bien cocida",
      },
    ]);
    expect((sent.checks as Record<string, unknown>[])[0]?.customer).toBeUndefined();
    // One login for the whole run, its token kept sealed for the next: Toast limits logins.
    expect(p.requests("POST", `${TOAST_HOST}/authentication/v1/authentication/login`).length).toBeLessThanOrEqual(1);
    expect(await def.orders?.status(run(p.http), { externalId: "ord-1" })).toEqual({ status: "pending" });
    toast.approve("ord-1", "APPROVED");
    expect(await def.orders?.status(run(p.http), { externalId: "ord-1" })).toEqual({ status: "accepted" });
    toast.approve("ord-1", "NOT_APPROVED");
    expect(await def.orders?.status(run(p.http), { externalId: "ord-1" })).toEqual({ status: "rejected" });
    // Found again by the inbox's own externalId, after an answer that never came.
    expect(await def.orders?.find(run(p.http), outbound())).toMatchObject({ externalId: "ord-1" });
    expect(cardDataSent(p)).toBe(false);
  });

  it("a delivery carries its address as Toast asks, a choice with no Toast id is refused, and a repeat is the same order", async () => {
    const p = fakePlatform();
    const toast = fakeToast(p);
    const delivery = outbound({
      method: "delivery",
      address: {
        streetAddress: "Calle Colima 160",
        addressLocality: "Ciudad de México",
        addressRegion: "MX-CMX",
        postalCode: "06700",
        addressCountry: "MX",
      },
    });
    const ref = await def.orders?.put(run(p.http), delivery);
    const sent = toast.orders.get(String(ref?.externalId))?.sent as Record<string, unknown>;
    expect(sent.deliveryInfo).toEqual({
      address1: "Calle Colima 160",
      city: "Ciudad de México",
      state: "CMX",
      zipCode: "06700",
    });
    const noRegion = await refusal(
      def.orders?.put(
        run(p.http),
        outbound({ method: "delivery", address: { streetAddress: "Calle 1", postalCode: "06700" } }),
      ) as Promise<unknown>,
    );
    expect(noRegion.message).toMatch(/state/);
    const line = outbound().lines[0] as OutboundOrder["lines"][number];
    const unknown = await refusal(
      def.orders?.put(
        run(p.http),
        outbound({
          lines: [{ ...line, options: [{ ...(line.options[0] as (typeof line.options)[number]), externalId: null }] }],
        }),
      ) as Promise<unknown>,
    );
    expect([unknown.code, unknown.message]).toEqual([
      "refused",
      "Orilla rellena has no id in your Toast menu: bring the menu in again.",
    ]);
    // Toast refuses an externalId it has seen: that answer is the order already there, never a refusal.
    expect(await def.orders?.put(run(p.http), delivery)).toMatchObject({ externalId: ref?.externalId });
    expect(toast.orders.size).toBe(1);
    expect(def.orders?.idempotent).toBe(true);
  });

  it("logs in again once when Toast stops taking the token it gave", async () => {
    const p = fakePlatform();
    const toast = fakeToast(p);
    const saved: Record<string, string>[] = [];
    const c = ctx(
      p.http,
      { accessToken: "toast-jwt-old", expiresAt: String(T0 + 3_600_000) },
      {
        extra: { restaurant: TOAST_RESTAURANT },
        choices: { restaurant: TOAST_RESTAURANT },
        async saveSecret(next) {
          saved.push({ ...next });
        },
      },
    );
    toast.token = "toast-jwt-2";
    const fresh = toastConnector({ ...TOAST_PARTNER, clientId: `${TOAST_PARTNER.clientId}` });
    const snap = await fresh.setup?.read(c);
    expect(snap?.menu?.length).toBeGreaterThan(0);
    expect(saved.at(-1)?.accessToken).toBe("toast-jwt-2");
  });

  it("refuses a line that is not from the Toast menu, before anything is posted", async () => {
    const p = fakePlatform();
    fakeToast(p);
    const e = await refusal(
      def.orders?.put(
        run(p.http),
        outbound({ lines: [{ ...outbound().lines[0], externalId: null } as OutboundOrder["lines"][number]] }),
      ) as Promise<unknown>,
    );
    expect(e.code).toBe("refused");
    expect(p.requests("POST", `${TOAST_HOST}/orders/v2/orders`)).toEqual([]);
  });
});

describe("Lightspeed K-Series (off): a partner's sign-in, menu in, to-go orders by SKU", () => {
  const client = { clientId: "lsk-client", clientSecret: "lsk-secret" };
  const def = lightspeedConnector(client);
  const API = "https://api.lsk.lightspeed.app";
  const AUTH = "https://auth.lsk-prod.app/realms/k-series/protocol/openid-connect";

  function fakeLightspeed() {
    const p = fakePlatform();
    const orders = new Map<string, unknown>();
    p.on("POST", `${AUTH}/token`, (r) => {
      const f = new URLSearchParams(r.body);
      return f.get("client_id") === client.clientId && f.get("client_secret") === client.clientSecret
        ? json({ access_token: "lsk-access", refresh_token: "lsk-refresh", expires_in: 300 })
        : json({ error: "invalid_client" }, 401);
    });
    p.on("GET", `${API}/o/op/data/businesses`, () =>
      json([{ id: 7001, name: "Taverna Kyma", businessLocations: [{ id: 45454565682155, name: "Ladadika" }] }]),
    );
    p.on("GET", `${API}/o/op/1/menu/list`, () => json([{ menuName: "Κατάλογος", ikentooMenuId: 99 }]));
    p.on("GET", `${API}/o/op/2/menu/load/:id`, () =>
      json({
        menuName: "Κατάλογος",
        menuEntryGroups: [
          {
            "@type": "group",
            id: "141948669133028",
            name: "Κυρίως",
            menuEntry: [
              {
                "@type": "menuItem",
                productName: "Μουσακάς",
                productPrice: 14.5,
                sku: "MOUS-01",
                productionInstructionList: [
                  {
                    multiSelectionPermitted: false,
                    productionInstructionGroupName: "Ψήσιμο",
                    productionIntructionGroupId: 236025632784487,
                    productionInstructionList: [{ instruction: "Καλοψημένο", ikentooModifierId: 236025632784488 }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    p.on("POST", `${API}/o/op/1/order/toGo`, (r) => {
      const b = JSON.parse(r.body) as { thirdPartyReference: string };
      if (orders.has(b.thirdPartyReference)) return json({ status: "CONFLICT" }, 409);
      orders.set(b.thirdPartyReference, b);
      return json({ status: "OK" });
    });
    return { p, orders };
  }

  it("signs in with PKCE, chooses the business location, and reads the menu by SKU", async () => {
    const { p } = fakeLightspeed();
    const url = new URL(
      def.oauth?.authorizeUrl({
        redirectUri: "https://kyma.example/oauth/connect/lightspeed/callback",
        state: "st",
        challenge: "ch",
      }) ?? "",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      scope: "orders-api offline-access",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
    const c = await def.oauth?.exchange(connectCtx(p.http), {
      code: "abc",
      verifier: "ver",
      redirectUri: "https://kyma.example/cb",
    });
    expect(c?.choices?.[0]).toMatchObject({ key: "location", value: "45454565682155" });
    const snap = await def.setup?.read(
      ctx(p.http, c?.secret ?? {}, { extra: { location: "45454565682155" }, inbox: { ...INBOX, currency: "EUR" } }),
    );
    expect(snap?.menu?.[0]?.items[0]).toMatchObject({ externalId: "MOUS-01", price: { value: 1450, currency: "EUR" } });
  });

  it("writes a to-go order once under the inbox's own reference: the same reference again is written", async () => {
    const { p, orders } = fakeLightspeed();
    const secret = { accessToken: "lsk-access", refreshToken: "lsk-refresh", expiresAt: String(T0 + 60 * 60_000) };
    const run = ctx(p.http, secret, { extra: { location: "45454565682155" } });
    const order = outbound({
      lines: [{ ...outbound().lines[0], externalId: "MOUS-01", options: [] } as OutboundOrder["lines"][number]],
    });
    const first = await def.orders?.put(run, order);
    const again = await def.orders?.put(run, order);
    expect(first?.externalId).toBe(again?.externalId);
    expect(orders.size).toBe(1);
    // So one whose answer never came is written once more, never left unsaid.
    expect(def.orders?.idempotent).toBe(true);
    expect([...orders.values()][0]).toMatchObject({
      businessLocationId: 45454565682155,
      items: [{ quantity: 2, sku: "MOUS-01", modifiers: [] }],
    });
    expect(cardDataSent(p)).toBe(false);
  });
});

describe("Clover (off): a region's sign-in, inventory in, atomic orders out", () => {
  const client = { clientId: "clover-app", clientSecret: "clover-secret" };
  const def = cloverConnector(client);
  const API = "https://api.eu.clover.com";

  function fakeClover() {
    const p = fakePlatform();
    const orders = new Map<string, { state: string; body: unknown }>();
    p.on("POST", `${API}/oauth/v2/token`, (r) => {
      const b = JSON.parse(r.body) as { client_id?: string; client_secret?: string; code?: string };
      return b.client_id === client.clientId && b.client_secret === client.clientSecret && b.code
        ? json({
            access_token: "cl-access",
            access_token_expiration: Math.floor(T0 / 1000) + 1800,
            refresh_token: "cl-refresh",
            refresh_token_expiration: Math.floor(T0 / 1000) + 86400,
          })
        : json({ message: "bad code" }, 401);
    });
    p.on("GET", `${API}/v3/merchants/:m`, (r) =>
      r.params.m === "MRCH0KYMA0001" ? json({ id: "MRCH0KYMA0001", name: "Taverna Kyma" }) : json({}, 404),
    );
    p.on("GET", `${API}/v3/merchants/:m/items`, () =>
      json({
        elements: [
          {
            id: "N2WWSQBTAADZC",
            hidden: false,
            name: "Greek Salad",
            price: 1200,
            categories: { elements: [{ id: "AN7WTGHSKE9XG", name: "Salads" }] },
            modifierGroups: { elements: [{ id: "QZ587JT76N80Y" }] },
          },
          { id: "HIDDEN0000001", hidden: true, name: "Staff meal", price: 0 },
        ],
      }),
    );
    p.on("GET", `${API}/v3/merchants/:m/modifier_groups`, () =>
      json({
        elements: [
          {
            id: "QZ587JT76N80Y",
            name: "Salad Add-in",
            minRequired: 0,
            maxAllowed: 2,
            modifiers: { elements: [{ id: "S47VGYX913K4T", name: "Tofu", price: 100 }] },
          },
        ],
      }),
    );
    p.on("POST", `${API}/v3/merchants/:m/atomic_order/orders`, (r) => {
      const id = `ORD${orders.size + 1}`;
      orders.set(id, { state: "open", body: JSON.parse(r.body) });
      return json({ id, orderCart: {}, createdTime: T0 });
    });
    p.on("GET", `${API}/v3/merchants/:m/orders/:id`, (r) => {
      const o = orders.get(r.params.id ?? "");
      return o ? json({ id: r.params.id, state: o.state }) : json({ message: "Not found" }, 404);
    });
    return { p, orders };
  }

  it("signs in in Europe, names the merchant Clover sent back, and reads the inventory in the minor unit", async () => {
    const { p } = fakeClover();
    expect(def.presets?.map((x) => x.id)).toEqual(["eu", "la"]);
    const url = def.oauth?.authorizeUrl({
      redirectUri: "https://kyma.example/cb",
      state: "st",
      challenge: "ch",
      input: { region: "eu" },
    });
    expect(url?.startsWith("https://www.eu.clover.com/oauth/v2/authorize?")).toBe(true);
    const noMerchant = await refusal(
      def.oauth?.exchange(connectCtx(p.http), {
        code: "c",
        verifier: "v",
        redirectUri: "x",
        input: { region: "eu" },
      }) as Promise<unknown>,
    );
    expect(noMerchant.code).toBe("bad_response");
    const c = await def.oauth?.exchange(connectCtx(p.http), {
      code: "c",
      verifier: "v",
      redirectUri: "x",
      input: { region: "eu" },
      returned: { merchant_id: "MRCH0KYMA0001" },
    });
    expect(c).toMatchObject({
      account: "Taverna Kyma",
      externalId: "eu:MRCH0KYMA0001",
      extra: { region: "eu", merchant: "MRCH0KYMA0001" },
    });
    const snap = await def.setup?.read(
      ctx(p.http, c?.secret ?? {}, { extra: c?.extra ?? {}, inbox: { ...INBOX, currency: "EUR" } }),
    );
    expect(snap?.menu).toEqual([
      {
        name: "Salads",
        items: [
          {
            externalId: "N2WWSQBTAADZC",
            name: "Greek Salad",
            price: { value: 1200, currency: "EUR" },
            optionGroups: [
              {
                externalId: "QZ587JT76N80Y",
                name: "Salad Add-in",
                min: 0,
                max: 2,
                choices: [{ externalId: "S47VGYX913K4T", name: "Tofu", priceDelta: 100 }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("makes one line per unit, and reads an order deleted in Clover as cancelled", async () => {
    const { p, orders } = fakeClover();
    const run = ctx(
      p.http,
      { accessToken: "cl-access", refreshToken: "cl-refresh", expiresAt: String(T0 + 600_000) },
      { extra: { region: "eu", merchant: "MRCH0KYMA0001" } },
    );
    const order = outbound({
      lines: [
        {
          ...outbound().lines[0],
          externalId: "N2WWSQBTAADZC",
          options: [
            {
              name: "Tofu",
              externalId: "S47VGYX913K4T",
              groupExternalId: "QZ587JT76N80Y",
              priceDelta: null,
              portion: "whole",
            },
          ],
        } as OutboundOrder["lines"][number],
      ],
    });
    const ref = await def.orders?.put(run, order);
    expect(ref).toEqual({ externalId: "ORD1", status: "accepted" });
    // Never cut: an order of more than Clover takes here is refused whole, for a person to put in by hand.
    const catering = outbound({ lines: [{ ...(order.lines[0] as OutboundOrder["lines"][number]), quantity: 201 }] });
    const big = await refusal(def.orders?.put(run, catering) as Promise<unknown>);
    expect([big.code, big.message]).toEqual([
      "refused",
      "This order has 201 items; Clover takes up to 200 in one order made here. Put it into Clover by hand.",
    ]);
    const sixty = await def.orders?.put(
      run,
      outbound({ lines: [{ ...(order.lines[0] as OutboundOrder["lines"][number]), quantity: 60 }] }),
    );
    expect(
      (orders.get(String(sixty?.externalId))?.body as { orderCart: { lineItems: unknown[] } } | undefined)?.orderCart
        .lineItems,
    ).toHaveLength(60);
    // A choice the till does not know is refused, never left off while the price still holds it.
    const unknown = await refusal(
      def.orders?.put(
        run,
        outbound({
          lines: [
            {
              ...(order.lines[0] as OutboundOrder["lines"][number]),
              options: [
                { name: "Extra feta", externalId: null, groupExternalId: null, priceDelta: null, portion: "whole" },
              ],
            },
          ],
        }),
      ) as Promise<unknown>,
    );
    expect(unknown.message).toBe("Extra feta has no id in your Clover menu: bring the menu in again.");
    expect(def.orders?.idempotent).toBeUndefined();
    const body = orders.get("ORD1")?.body as { orderCart: { lineItems: unknown[] } };
    expect(body.orderCart.lineItems).toHaveLength(2);
    expect(body.orderCart.lineItems[0]).toEqual({
      item: { id: "N2WWSQBTAADZC" },
      note: "bien cocida",
      modifications: [{ modifier: { id: "S47VGYX913K4T" } }],
    });
    const lockedOrder = orders.get("ORD1");
    if (lockedOrder) lockedOrder.state = "locked";
    expect(await def.orders?.status(run, { externalId: "ORD1" })).toEqual({ status: "completed" });
    orders.delete("ORD1");
    expect(await def.orders?.status(run, { externalId: "ORD1" })).toEqual({
      status: "cancelled",
      reason: "deleted in Clover",
    });
    expect(cardDataSent(p)).toBe(false);
  });
});

describe("Deliverect (off): one channel to many tills, its signed word back", () => {
  const def = deliverectConnector(DELIVERECT_PARTNER);

  it("creates an order with prices in the minor unit and the decimal digits of its currency, once per channelOrderId", async () => {
    const p = fakePlatform();
    const dlv = fakeDeliverect(p);
    const run = ctx(p.http, {}, { extra: { channelLinkId: DELIVERECT_LINK } });
    const won = outbound({
      method: "delivery",
      total: { value: 39800, currency: "KRW" },
      fee: { value: 3000, currency: "KRW" },
      tip: { value: 1800, currency: "KRW" },
      lines: [
        {
          externalId: "PLU-CHK-1",
          groupExternalId: null,
          name: "후라이드 치킨",
          quantity: 2,
          unitPrice: { value: 17500, currency: "KRW" },
          options: [],
          note: null,
        },
      ],
      address: { streetAddress: "Haeundae-ro 1", addressLocality: "Busan", postalCode: "48058", addressCountry: "KR" },
      customer: { firstName: "Minji", phone: "+82-10-0000-0000" },
    });
    const ref = await def.orders?.put(run, won);
    const sent = dlv.orders.get(ref?.externalId ?? "") as Record<string, unknown>;
    expect(sent).toMatchObject({
      channelOrderDisplayId: "W7Y8Z0",
      orderType: 2,
      decimalDigits: 0,
      courier: "restaurant",
      orderIsAlreadyPaid: false,
      deliveryCost: 3000,
      tip: 1800,
      items: [{ plu: "PLU-CHK-1", price: 17500, quantity: 2, subItems: [] }],
    });
    // The same order again is the one Deliverect has.
    expect(await def.orders?.put(run, won)).toEqual(ref);
    expect(dlv.orders.size).toBe(1);
    expect(cardDataSent(p)).toBe(false);
    expect(def.orders?.idempotent).toBe(true);
  });

  it("counts each option once: the item at its price without them, every option at its own; collection names no courier", async () => {
    const p = fakePlatform();
    const dlv = fakeDeliverect(p);
    const run = ctx(p.http, {}, { extra: { channelLinkId: DELIVERECT_LINK } });
    const pie = outbound({
      lines: [
        {
          ...(outbound().lines[0] as OutboundOrder["lines"][number]),
          externalId: "PLU-DIAV",
          options: [
            {
              name: "Orilla rellena",
              externalId: "PLU-ORI",
              groupExternalId: null,
              priceDelta: { value: 3500, currency: "MXN" },
              portion: "whole",
            },
          ],
        },
      ],
    });
    const ref = await def.orders?.put(run, pie);
    const sent = dlv.orders.get(ref?.externalId ?? "") as {
      items: { price: number; quantity: number; subItems: { price: number }[] }[];
      payment: { amount: number };
      courier?: unknown;
    };
    expect(sent.items[0]).toMatchObject({
      plu: "PLU-DIAV",
      price: 19900,
      subItems: [{ plu: "PLU-ORI", price: 3500, quantity: 1 }],
    });
    // What the till adds up is what the customer is asked: (19,900 + 3,500) × 2.
    const counted = sent.items.reduce(
      (n, i) => n + (i.price + i.subItems.reduce((m, x) => m + x.price, 0)) * i.quantity,
      0,
    );
    expect(counted).toBe(sent.payment.amount);
    expect(sent.courier).toBeUndefined();
    const unknown = await refusal(
      def.orders?.put(
        run,
        outbound({
          lines: [
            {
              ...(pie.lines[0] as OutboundOrder["lines"][number]),
              options: [
                { name: "Jalapeño", externalId: null, groupExternalId: null, priceDelta: null, portion: "whole" },
              ],
            },
          ],
        }),
      ) as Promise<unknown>,
    );
    expect(unknown.code).toBe("refused");
  });

  it("in production takes no word without the webhook secret: a channel link id is not one", async () => {
    const live = deliverectConnector({ ...DELIVERECT_PARTNER, staging: false });
    const p = fakePlatform();
    fakeDeliverect(p, "https://api.deliverect.com");
    const missing = await refusal(
      live.connect?.({ ...connectCtx(p.http), hookUrl: null }, { channelLinkId: DELIVERECT_LINK }) as Promise<unknown>,
    );
    expect([missing.code, missing.field]).toEqual(["config", "hmacSecret"]);
    const forged = await deliverectStatus("ch-order-3", 110, DELIVERECT_LINK);
    const run = ctx(p.http, {}, { extra: { channelLinkId: DELIVERECT_LINK } });
    expect(
      (
        await refusal(
          live.hooks?.verify(run, {
            headers: forged.headers,
            body: forged.body,
            query: new URLSearchParams(),
          }) as Promise<unknown>,
        )
      ).code,
    ).toBe("refused");
    const done = await deliverectStatus("ch-order-3", 95, "dlv-hmac-secret");
    const ok = ctx(p.http, { hmacSecret: "dlv-hmac-secret" }, { extra: { channelLinkId: DELIVERECT_LINK } });
    const e = await live.hooks?.verify(ok, { headers: done.headers, body: done.body, query: new URLSearchParams() });
    expect(await live.hooks?.read(ok, e as never)).toEqual([
      { kind: "pos_order", externalId: "ch-order-3", state: { status: "completed" } },
    ]);
  });

  it("believes a status only with Deliverect's signature over the exact bytes; denied, preparing and ready read as such", async () => {
    const run = ctx(
      fakePlatform().http,
      { hmacSecret: "dlv-hmac-secret" },
      { extra: { channelLinkId: DELIVERECT_LINK } },
    );
    const ok = await deliverectStatus("ch-order-1", 50, "dlv-hmac-secret");
    const event = await def.hooks?.verify(run, { headers: ok.headers, body: ok.body, query: new URLSearchParams() });
    expect(event && "refs" in event ? event.refs : null).toEqual(["ch-order-1", "status:50"]);
    expect(await def.hooks?.read(run, event as never)).toEqual([
      { kind: "pos_order", externalId: "ch-order-1", state: { status: "preparing" } },
    ]);
    const tampered = {
      headers: ok.headers,
      body: ok.body.replace('"status":50', '"status":90'),
      query: new URLSearchParams(),
    };
    expect((await refusal(def.hooks?.verify(run, tampered) as Promise<unknown>)).code).toBe("refused");
    const denied = await deliverectStatus("ch-order-1", 35, "dlv-hmac-secret", "Out of stock");
    const d = await def.hooks?.verify(run, {
      headers: denied.headers,
      body: denied.body,
      query: new URLSearchParams(),
    });
    expect(await def.hooks?.read(run, d as never)).toEqual([
      { kind: "pos_order", externalId: "ch-order-1", state: { status: "rejected", reason: "Out of stock" } },
    ]);
    // Before certification Deliverect signs with the channel link itself.
    const staging = await deliverectStatus("ch-order-2", 70, DELIVERECT_LINK);
    const s = await def.hooks?.verify(ctx(fakePlatform().http, {}, { extra: { channelLinkId: DELIVERECT_LINK } }), {
      headers: staging.headers,
      body: staging.body,
      query: new URLSearchParams(),
    });
    expect(await def.hooks?.read(run, s as never)).toEqual([
      { kind: "pos_order", externalId: "ch-order-2", state: { status: "ready" } },
    ]);
  });
});
