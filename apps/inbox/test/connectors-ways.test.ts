import { createApiKey } from "@surfingdog/adapters";
import {
  type ConnectionChoice,
  type ConnectorDefinition,
  ConnectorError,
  type Db,
  field,
  schema,
  secretField,
  ulid,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakePlatform, json } from "../../../packages/adapters/test/fakes/platform";
import { createInbox } from "../src/app";
import { fakeShop, fakeShopConnector } from "./fake-shop";
import { confirmed, freshDb, futureDay, openWeekdays } from "./harness";

/**
 * The ways in the shared base adds (ADR-030 §5), end to end, each with a connector written for the
 * test against the SDK: a link the inbox makes and serves (a B&B in Oaxaca sharing its bookings), a
 * key a store hands over itself after the owner approves it there (a café in Melbourne), choosers once
 * connected (a salon in Toronto with two locations), a catalogue past the limit one connection takes,
 * an order in yen (a shop in Osaka), exact in hundredths and written into the shop, and an order in a
 * currency counted in thousandths (a shop in Kuwait City), which no shop is asked for.
 */

async function inboxWith(opts: {
  base: string;
  connectors: ConnectorDefinition[];
  fetch?: typeof fetch;
  business: Record<string, unknown>;
  website?: string;
}) {
  const db = await freshDb();
  const mail = logMailOut();
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: mail,
    secretKey: "connector-ways-test-secret-0123456789",
    baseUrl: opts.base,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    fetchImpl: opts.fetch ?? (async () => new Response("no platform here", { status: 404 })),
    connectors: opts.connectors,
  });
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const integration = { authorization: `Bearer ${(await createApiKey(db, { kind: "integration", name: "n8n" })).key}` };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    inbox.app.request(
      new Request(path.startsWith("https://") ? path : `${opts.base}${path}`, {
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
        business: opts.business,
        notifications: { ownerEmail: "owner@example.com", appUrl: opts.base },
        email: { fromAddress: `hello@${new URL(opts.base).hostname}` },
        ...(opts.website ? { directory: { url: opts.website } } : {}),
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
  return { db, inbox, call, owner, integration, drain, mail };
}

async function mails(db: Db, template: string) {
  const { rows } = await db.client.query({
    sql: "SELECT subject, body_text FROM outbound_mail WHERE template = ?",
    params: [template],
    method: "all",
  });
  return rows.map((r) => ({ subject: String(r[0]), text: String(r[1]) }));
}

/* --- a link the inbox serves --------------------------------------------------------------------- */

const linkConnector: ConnectorDefinition = {
  kind: "bookings_link",
  title: "Bookings calendar",
  group: "calendars",
  capabilities: [],
  auth: "link",
  steps: ["Paste it where the other platform imports a calendar."],
  feed: {
    extension: ".ics",
    async serve(ctx) {
      const day = 86_400_000;
      const list = await ctx.bookings({ start: ctx.now - 30 * day, end: ctx.now + 548 * day });
      return {
        status: 200,
        headers: { "content-type": "text/calendar; charset=utf-8", etag: `"${list.length}"` },
        body: list
          .map((b) => `${b.itemId} ${b.serviceName} ${new Date(b.start).toISOString()} #${b.sequence}`)
          .join("\n"),
      };
    },
  },
};

describe("a link the inbox makes and serves", () => {
  it("shows confirmed bookings by service and time only, to whoever holds it, and stops when a new one is made", async () => {
    const base = "https://reservas.casa-oaxaca.example.com";
    const s = await inboxWith({
      base,
      connectors: [linkConnector],
      business: { name: "Casa Azul", currency: "MXN", timezone: "America/Mexico_City", languages: ["es", "en"] },
    });
    const serviceId = ulid();
    const now = Date.now();
    await s.db.orm.insert(schema.services).values({
      id: serviceId,
      name: "Habitación doble",
      durationMin: 60,
      capacity: 1,
      granularityMin: 30,
      createdAt: now,
      updatedAt: now,
    });
    await openWeekdays(s.db);
    const day = futureDay(9);
    const made = await confirmed(
      (r) => s.inbox.app.request(r),
      new Request(`${base}/v1/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload: {
            reservationFor: { serviceId, name: "Habitación doble" },
            startTime: `${day}T15:00:00Z`,
            endTime: `${day}T16:00:00Z`,
          },
          contact: { name: "Guadalupe Hernández", email: "lupita@example.com", locale: "es-MX" },
        }),
      }),
    );
    expect(made.status, await made.clone().text()).toBe(201);
    const itemId = ((await made.json()) as { view: { item: { id: string } } }).view.item.id;
    expect((await s.call("POST", `/v1/owner/items/${itemId}/transitions`, { event: "confirm" }, s.owner)).status).toBe(
      200,
    );

    // A key handed to another system cannot make the link, and never sees it.
    expect((await s.call("POST", "/v1/owner/integrations", { kind: "bookings_link" }, s.integration)).status).toBe(403);
    const res = await s.call("POST", "/v1/owner/integrations", { kind: "bookings_link" }, s.owner);
    expect(res.status, await res.clone().text()).toBe(201);
    const view = (await res.json()) as { id: string; link: string | null; status: string };
    expect(view.link).toMatch(
      /^https:\/\/reservas\.casa-oaxaca\.example\.com\/v1\/feeds\/bookings_link\/[A-Za-z0-9_-]{43}\.ics$/,
    );
    const listed = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.integration)).json()) as {
      connections: { link: string | null }[];
    };
    expect(listed.connections[0]?.link).toBeNull();
    // The link's token is never in the database as it is.
    const token =
      String(view.link)
        .split("/")
        .at(-1)
        ?.replace(/\.ics$/, "") ?? "";
    const { rows } = await s.db.client.query({
      sql: "SELECT inbound_token, inbound_enc FROM connectors",
      method: "all",
    });
    expect(JSON.stringify(rows)).not.toContain(token);

    const feed = await s.call("GET", String(view.link));
    expect(feed.status).toBe(200);
    expect(feed.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(feed.headers.get("cache-control")).toBe("private, max-age=300");
    expect(feed.headers.get("set-cookie")).toBeNull();
    const body = await feed.text();
    expect(body).toContain(`${itemId} Habitación doble ${day}T15:00:00.000Z`);
    expect(body).not.toContain("Guadalupe");
    expect(body).not.toContain("lupita@");
    // Opened once: it says so.
    const after = (await (await s.call("GET", `/v1/owner/integrations/${view.id}`, undefined, s.owner)).json()) as {
      status: string;
    };
    expect(after.status).toBe("active");

    // Another extension, or another kind, is not found.
    expect((await s.call("GET", String(view.link).replace(/\.ics$/, ".json"))).status).toBe(404);
    expect((await s.call("GET", String(view.link).replace("/bookings_link/", "/kibanda/"))).status).toBe(404);

    // A new link: the old one stops at once.
    expect((await s.call("POST", `/v1/owner/integrations/${view.id}/link`, undefined, s.integration)).status).toBe(403);
    const rotated = (await (
      await s.call("POST", `/v1/owner/integrations/${view.id}/link`, undefined, s.owner)
    ).json()) as {
      link: string;
    };
    expect(rotated.link).not.toBe(view.link);
    expect((await s.call("GET", String(view.link))).status).toBe(404);
    expect((await s.call("GET", rotated.link)).status).toBe(200);
    // A second link of the same kind is the same link: one per inbox.
    expect((await s.call("POST", "/v1/owner/integrations", { kind: "bookings_link" }, s.owner)).status).toBe(409);
    // Disconnected: gone.
    expect((await s.call("DELETE", `/v1/owner/integrations/${view.id}`, undefined, s.owner)).status).toBe(200);
    expect((await s.call("GET", rotated.link)).status).toBe(404);
  });
});

/* --- a key a store hands over itself ---------------------------------------------------------------- */

function kioskConnector(): ConnectorDefinition {
  return {
    kind: "kiosk",
    title: "Kiosk Shop",
    group: "shops",
    capabilities: [],
    auth: "oauth",
    action: "Connect your shop",
    oauth: {
      delivery: "post",
      before: z.object({
        store_url: field(z.string().trim().min(8).max(2048), {
          label: "Shop address",
          input: "url",
          prefill: "website",
        }),
      }),
      authorizeUrl({ redirectUri, state, input, postUrl }) {
        const q = new URLSearchParams({
          app_name: "Inbox",
          user_id: state,
          return_url: `${redirectUri}?state=${encodeURIComponent(state)}`,
          callback_url: postUrl ?? "",
        });
        return `${String(input?.store_url ?? "").replace(/\/+$/, "")}/authorize?${q}`;
      },
      async exchange() {
        throw new ConnectorError("config", "This store sends its key itself.");
      },
      postedState(request) {
        try {
          const id = (JSON.parse(request.body) as { user_id?: unknown }).user_id;
          return typeof id === "string" ? id : null;
        } catch {
          return null;
        }
      },
      async receivePosted(ctx, request, input) {
        const posted = JSON.parse(request.body) as { consumer_key?: string; consumer_secret?: string };
        const store = String(input.store_url ?? "").replace(/\/+$/, "");
        const res = await ctx.http.request({
          method: "GET",
          url: `${store}/api/me`,
          headers: { authorization: `Bearer ${posted.consumer_key ?? ""}:${posted.consumer_secret ?? ""}` },
        });
        if (res.status !== 200) throw new ConnectorError("auth", "The shop did not take the key it sent.");
        const me = JSON.parse(res.text) as { id: string; name: string };
        return {
          account: me.name,
          externalId: me.id,
          secret: { key: posted.consumer_key ?? "", secret: posted.consumer_secret ?? "" },
          extra: { store },
          calendars: [],
          destinations: [],
          defaults: { busy: [], destination: null },
        };
      },
    },
  };
}

describe("a key a store hands over itself", () => {
  it("is taken once, from the store the owner approved on, checked, and found by the owner's browser on the way back", async () => {
    const base = "https://inbox.flat-white.example.com";
    const store = fakePlatform().on("GET", "https://flat-white.example.com/api/me", (req) =>
      req.headers.get("authorization") === "Bearer ck_au_1:cs_au_1"
        ? json({ id: "store_au_01", name: "Flat White Fitzroy" })
        : json({ error: "bad key" }, 401),
    );
    const s = await inboxWith({
      base,
      connectors: [kioskConnector()],
      fetch: store.fetch,
      business: { name: "Flat White", currency: "AUD", timezone: "Australia/Melbourne", languages: ["en"] },
      website: "https://flat-white.example.com",
    });
    // What it asks first is checked: a store address, never a format to guess.
    const empty = await s.call("POST", "/v1/owner/integrations/authorize", { kind: "kiosk", input: {} }, s.owner);
    expect(empty.status).toBe(422);
    const started = await s.call(
      "POST",
      "/v1/owner/integrations/authorize",
      { kind: "kiosk", input: { store_url: "https://flat-white.example.com" } },
      s.owner,
    );
    expect(started.status, await started.clone().text()).toBe(200);
    const url = new URL(((await started.json()) as { authorize_url: string }).authorize_url);
    expect(url.origin).toBe("https://flat-white.example.com");
    expect(url.searchParams.get("callback_url")).toBe(`${base}/v1/hooks/kiosk/authorized`);
    const state = url.searchParams.get("user_id") ?? "";
    const returnUrl = url.searchParams.get("return_url") ?? "";

    // A key posted under a state nobody started: refused.
    const stranger = await s.call("POST", `${base}/v1/hooks/kiosk/authorized`, {
      user_id: "not-a-state",
      consumer_key: "ck_au_1",
      consumer_secret: "cs_au_1",
    });
    expect(stranger.status).toBe(400);

    const posted = await s.call("POST", `${base}/v1/hooks/kiosk/authorized`, {
      key_id: 7,
      user_id: state,
      consumer_key: "ck_au_1",
      consumer_secret: "cs_au_1",
      key_permissions: "read_write",
    });
    expect(posted.status, await posted.clone().text()).toBe(200);
    // Used once: the same state again is refused.
    const twice = await s.call("POST", `${base}/v1/hooks/kiosk/authorized`, {
      user_id: state,
      consumer_key: "ck_au_1",
      consumer_secret: "cs_au_1",
    });
    expect(twice.status).toBe(400);

    const back = await s.call("GET", returnUrl.replace(base, ""));
    expect(back.status).toBe(303);
    const to = new URL(String(back.headers.get("location")), base);
    expect(to.pathname).toBe("/settings/integrations");
    const id = to.searchParams.get("connected") ?? "";
    const view = (await (await s.call("GET", `/v1/owner/integrations/${id}`, undefined, s.owner)).json()) as {
      account: string;
      kind: string;
    };
    expect(view).toMatchObject({ kind: "kiosk", account: "Flat White Fitzroy" });
    expect(JSON.stringify(view)).not.toContain("cs_au_1");
  });

  it("tells the owner's browser what went wrong when the store's key does not check out", async () => {
    const base = "https://inbox.flat-white.example.com";
    const store = fakePlatform().on("GET", "https://flat-white.example.com/api/me", () => json({ error: "bad" }, 401));
    const s = await inboxWith({
      base,
      connectors: [kioskConnector()],
      fetch: store.fetch,
      business: { name: "Flat White", currency: "AUD", timezone: "Australia/Melbourne", languages: ["en"] },
    });
    const started = await s.call(
      "POST",
      "/v1/owner/integrations/authorize",
      { kind: "kiosk", input: { store_url: "https://flat-white.example.com" } },
      s.owner,
    );
    const url = new URL(((await started.json()) as { authorize_url: string }).authorize_url);
    const state = url.searchParams.get("user_id") ?? "";
    const posted = await s.call("POST", `${base}/v1/hooks/kiosk/authorized`, {
      user_id: state,
      consumer_key: "ck_au_x",
      consumer_secret: "cs_au_x",
    });
    expect(posted.status).toBe(400);
    const back = await s.call("GET", (url.searchParams.get("return_url") ?? "").replace(base, ""));
    const to = new URL(String(back.headers.get("location")), base);
    expect(to.searchParams.get("connect_error")).toBe("The shop did not take the key it sent.");
    const { rows } = await s.db.client.query({ sql: "SELECT COUNT(*) FROM connectors", method: "all" });
    expect(Number(rows[0]?.[0])).toBe(0);
  });
});

/* --- choosers once connected ----------------------------------------------------------------------- */

describe("what the owner chooses once connected", () => {
  it("is drawn from the connector's choosers, checked against their options, given to every run, and kept across a refresh", async () => {
    const seen: (string | null | undefined)[] = [];
    let options: ConnectionChoice["options"] = [
      { id: "L1", name: "Queen West" },
      { id: "L2", name: "Plateau" },
    ];
    const agenda: ConnectorDefinition = {
      kind: "agenda",
      title: "Agenda",
      group: "calendars",
      capabilities: ["busy_times"],
      auth: "form",
      form: z.object({ token: secretField(z.string().min(4), { label: "Token" }) }),
      async connect() {
        return {
          account: "Salon Lumière",
          externalId: "agenda_ca_01",
          secret: { token: "tok" },
          calendars: [],
          destinations: [],
          defaults: { busy: [], destination: null },
          choices: [{ key: "location", label: "Location", options, value: "L1" }],
        };
      },
      async refresh() {
        return {
          account: "Salon Lumière",
          calendars: [],
          destinations: [],
          choices: [{ key: "location", label: "Location", options, value: "L1" }],
        };
      },
      async busy(ctx) {
        seen.push(ctx.choices?.location);
        return [];
      },
    };
    const s = await inboxWith({
      base: "https://inbox.salon-lumiere.example.com",
      connectors: [agenda],
      business: { name: "Salon Lumière", currency: "CAD", timezone: "America/Toronto", languages: ["fr", "en"] },
    });
    const made = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "agenda", values: { token: "tok-1" } },
      s.owner,
    );
    expect(made.status, await made.clone().text()).toBe(201);
    const view = (await made.json()) as { id: string; choices: ConnectionChoice[] };
    expect(view.choices).toEqual([{ key: "location", label: "Location", options, value: "L1" }]);
    await s.drain();
    expect(seen.at(-1)).toBe("L1");

    const bad = await s.call("PATCH", `/v1/owner/integrations/${view.id}`, { choices: { location: "L9" } }, s.owner);
    expect(bad.status).toBe(422);
    const unknown = await s.call("PATCH", `/v1/owner/integrations/${view.id}`, { choices: { team: "T1" } }, s.owner);
    expect(unknown.status).toBe(422);
    expect(
      (await s.call("PATCH", `/v1/owner/integrations/${view.id}`, { choices: { location: "L2" } }, s.integration))
        .status,
    ).toBe(403);
    const chosen = await s.call("PATCH", `/v1/owner/integrations/${view.id}`, { choices: { location: "L2" } }, s.owner);
    expect(chosen.status, await chosen.clone().text()).toBe(200);
    expect(((await chosen.json()) as { choices: ConnectionChoice[] }).choices[0]?.value).toBe("L2");
    await s.drain();
    expect(seen.at(-1)).toBe("L2");

    // Plateau closes: the next refresh has no L2, and the default comes back.
    options = [{ id: "L1", name: "Queen West" }];
    await s.inbox.caps.connectors.run(view.id, Date.now() + 7 * 3_600_000, "sync");
    expect(seen.at(-1)).toBe("L2");
    const again = (await (await s.call("GET", `/v1/owner/integrations/${view.id}`, undefined, s.owner)).json()) as {
      choices: ConnectionChoice[];
    };
    expect(again.choices).toEqual([{ key: "location", label: "Location", options, value: "L1" }]);
  });
});

/* --- the catalogue's limit --------------------------------------------------------------------------- */

describe("a catalogue past what one connection takes", () => {
  it("brings in the first 5,000, takes nothing off sale, and tells the owner once", async () => {
    const shop = fakeShop({ pageSize: 500 });
    const now = Date.now();
    for (let i = 0; i < 5_001; i++) {
      shop.products.push({
        id: String(10_000 + i),
        name: `Loaf ${i}`,
        sku: null,
        price: 15_000,
        stock: null,
        published: true,
        modifiedAt: now,
      });
    }
    const s = await inboxWith({
      base: "https://inbox.kibanda.example.com",
      connectors: [fakeShopConnector()],
      fetch: shop.platform.fetch,
      business: { name: "Kibanda Bakery", currency: "KES", timezone: "Africa/Nairobi", languages: ["en", "sw"] },
    });
    const made = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "kibanda", values: { store_url: `https://${shop.host}`, api_key: shop.key.value } },
      s.owner,
    );
    expect(made.status, await made.clone().text()).toBe(201);
    const { id } = (await made.json()) as { id: string };
    await s.drain(10_000);
    const view = (await (await s.call("GET", `/v1/owner/integrations/${id}`, undefined, s.owner)).json()) as {
      catalogue: { products: number; truncated: boolean };
    };
    expect(view.catalogue).toEqual(expect.objectContaining({ products: 5_000, truncated: true }));
    const told = await mails(s.db, "owner.catalogue_capped");
    expect(told).toHaveLength(1);
    expect(told[0]?.text).toContain("the first 5,000");
  }, 60_000);
});

/* --- money counted otherwise --------------------------------------------------------------------------- */

describe("an order in a currency with no minor unit, or one counted in thousandths", () => {
  async function accepted(
    host: string,
    currency: string,
    value: number,
    business: Record<string, unknown>,
    contact: { name: string; email: string; locale: string },
    item: string,
  ) {
    const shop = fakeShop({ host, currency, key: "oz_live_4c1d" });
    const base = `https://inbox.${host}`;
    const s = await inboxWith({ base, connectors: [fakeShopConnector()], fetch: shop.platform.fetch, business });
    const made = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "kibanda", values: { store_url: `https://${shop.host}`, api_key: shop.key.value } },
      s.owner,
    );
    expect(made.status, await made.clone().text()).toBe(201);
    const order = await confirmed(
      (r) => s.inbox.app.request(r),
      new Request(`${base}/v1/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload: {
            orderedItem: [{ name: item, quantity: 1, price: { value, currency } }],
            totalPrice: { value, currency },
          },
          contact,
        }),
      }),
    );
    expect(order.status, await order.clone().text()).toBe(201);
    const itemId = ((await order.json()) as { view: { item: { id: string } } }).view.item.id;
    expect((await s.call("POST", `/v1/owner/items/${itemId}/transitions`, { event: "accept" }, s.owner)).status).toBe(
      200,
    );
    await s.drain(60_000);
    const pays = (await (await s.call("GET", `/v1/owner/items/${itemId}/payments`, undefined, s.owner)).json()) as {
      payments: { state: string; error: string | null }[];
    };
    return { shop, pays: pays.payments };
  }

  it("writes yen into the shop, exact in hundredths: a shop takes a decimal in its own currency", async () => {
    const { shop, pays } = await accepted(
      "osaka-zakka.example.com",
      "JPY",
      280_000,
      {
        name: "Zakka Osaka",
        currency: "USD",
        timezone: "Asia/Tokyo",
        languages: ["ja", "en"],
      },
      { name: "Haruto Sato", email: "haruto@example.com", locale: "ja" },
      "Furoshiki",
    );
    expect([...shop.orders.values()].map((o) => [o.total, o.currency])).toEqual([[280_000, "JPY"]]);
    expect(pays[0]).toMatchObject({ state: "open", error: null });
  });

  it("asks no shop for a currency counted in thousandths, and says why on the order", async () => {
    const { shop, pays } = await accepted(
      "souq-mubarakiya.example.com",
      "KWD",
      1_250,
      {
        name: "Souq Mubarakiya Spices",
        currency: "USD",
        timezone: "Asia/Kuwait",
        languages: ["ar", "en"],
      },
      { name: "Fatima Al-Sabah", email: "fatima@example.com", locale: "ar" },
      "Saffron, 10 g",
    );
    expect(shop.orders.size).toBe(0);
    expect(shop.platform.requests("POST", `https://${shop.host}/api/orders`)).toHaveLength(0);
    expect(pays[0]).toMatchObject({
      state: "error",
      error: "This currency is not counted in hundredths here, so no link was made.",
    });
  });
});
