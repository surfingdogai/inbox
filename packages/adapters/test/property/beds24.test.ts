import {
  type Caller,
  Capabilities,
  ConnectorError,
  type ConnectorHttp,
  createSecretBox,
  describeForm,
  gallery,
  type OutboundStay,
  type PropertySetup,
  type RunContext,
  syncAri,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  BEDS24_REFRESH_EVERY_MS,
  BEDS24_WAITING_FLAG,
  beds24Amount,
  beds24Budget,
  beds24Connector,
  beds24Form,
  fromBeds24Amount,
  isBeds24Url,
  nextPageUrl,
} from "../../src/connectors/property/beds24";
import { builtInConnectors } from "../../src/index";
import { freshDb } from "../db";
import { fakePlatform, json } from "../fakes/platform";
import { type FakeBeds24, fakeBeds24 } from "../fakes/property/beds24";
import { INVITE_CODE } from "../fixtures/property/beds24/auth";
import { cancelExample, NEVER_SENT, newBookingExample } from "../fixtures/property/beds24/bookings";
import {
  CASA_VENTANA,
  calendarExample,
  INTI_WASI,
  PROPERTIES,
  RYOKAN_HOSHI,
} from "../fixtures/property/beds24/properties";
import { bookingWebhook, usageLimitAnswer, wikiHeaders, yamlHeaders } from "../fixtures/property/beds24/webhook";
import { propertyContract, runContext } from "./contract";

/**
 * Beds24 (ADR-033 §8.2) against a local Beds24 built from its own documentation: the property-system
 * contract, then what is Beds24's own — its invite code, its tokens, its credits, its webhook, its
 * hosts, and a stay written once, read back as written, cancelled by status and never deleted. No
 * request ever leaves for Beds24 itself: the fake answers every one, and nothing else is reachable.
 */

const def = beds24Connector();
const writer = def.stayWriter as NonNullable<typeof def.stayWriter>;
const stays = def.stays as NonNullable<typeof def.stays>;
const HOSHI = String(RYOKAN_HOSHI.id);
const GARDEN = "512001";
const SUITE = "512002";
const DAY = 86_400_000;
/**
 * The booking fields the OpenAPI file defines (`newBooking`, `bookingActions`, `id`, and `apiReference`
 * of schema `booking`), with its own examples' fields among them.
 */
const DOCUMENTED = new Set([
  ...Object.keys(newBookingExample[0] ?? {}),
  ...Object.keys(cancelExample),
  "id",
  "masterId",
  "roomId",
  "status",
  "arrival",
  "departure",
  "numAdult",
  "numChild",
  "lastName",
  "email",
  "phone",
  "comments",
  "notes",
  "flagColor",
  "flagText",
  "price",
  "apiReference",
  "actions",
  "allowWebhooks",
  "checkAvailability",
  "makeGroup",
]);

/** A run against the fake, on its clock, holding a granted refresh token: what a connection is. */
function run(fake: FakeBeds24, secret?: Record<string, string>, extra: Record<string, unknown> = {}): RunContext {
  const s = secret ?? { refresh_token: fake.grant(), refresh_used_at: String(fake.clock.now) };
  const saved: Record<string, string>[] = [];
  return {
    ...runContext(fake.platform.http, s, fake.clock.now),
    extra,
    async saveSecret(next) {
      saved.push({ ...next });
      Object.assign(s, next);
    },
  };
}

function stayOf(o: Partial<OutboundStay> & { key: string; rooms?: OutboundStay["rooms"] }): OutboundStay {
  return {
    itemId: o.key.replace(/^sd-/, ""),
    reference: "4F2K9Q",
    propertyId: HOSHI,
    checkIn: "2027-04-10",
    checkOut: "2027-04-12",
    rooms: [
      { roomId: GARDEN, rateId: "price1", adults: 2, childrenAges: [], price: { value: 51_600, currency: "JPY" } },
    ],
    ...o,
  };
}

/** What every test of a write ends on: nothing was deleted, and no card, deposit or commission went out. */
function clean(fake: FakeBeds24): void {
  expect(fake.platform.seen.filter((r) => r.method === "DELETE" && r.url.pathname.endsWith("/bookings"))).toEqual([]);
  expect(fake.bodyKeys().filter((k) => NEVER_SENT.test(k))).toEqual([]);
  // Every field written is one Beds24 documents for a booking.
  expect(fake.bodyKeys().filter((k) => !DOCUMENTED.has(k))).toEqual([]);
  expect(fake.platform.seen.every((r) => r.url.hostname === "beds24.com")).toBe(true);
}

propertyContract("Beds24, against its local fake", () => {
  const fake = fakeBeds24({ properties: PROPERTIES });
  return {
    definition: def as never,
    http: fake.platform.http,
    secret: { refresh_token: fake.grant(), refresh_used_at: String(fake.clock.now) },
    propertyId: HOSHI,
    oneUnitRoom: GARDEN,
    rate: "price1",
    oversells: false,
    exhaust: () => {
      fake.credits.windowStart = fake.clock.now;
      fake.credits.remaining = 0;
    },
  };
});

describe("Beds24: the form and the gallery", () => {
  it("asks for one invite code, sealed, with Beds24's own steps, and says a scope change needs a new code", () => {
    const [field, ...rest] = describeForm(beds24Form);
    expect(rest).toEqual([]);
    expect(field).toMatchObject({ key: "invite_code", label: "Invite code", secret: true, input: "password" });
    expect(field?.steps).toEqual([
      "In Beds24, open Settings, then Marketplace, then API.",
      "Create an invite code with bookings and inventory: read inventory, read properties, all bookings and read bookings personal.",
      "Paste it here. It works for 24 hours.",
    ]);
    expect(field?.help).toMatch(/cannot be changed later.*new code/);
  });

  it("is the lodging card's Beds24 way, ready, once it is among the built-in connectors", () => {
    const defs = builtInConnectors({});
    expect(defs.map((d) => d.kind)).toContain("beds24");
    // Shown to a place to stay: the property-system card is a place to stay's own.
    const card = gallery(new Map(defs.map((d) => [d.kind, d])), { lean: "stays" }).find((c) => c.group === "lodging");
    const way = card?.ways.find((w) => w.kind === "beds24");
    expect(way).toMatchObject({ status: "ready", auth: "form" });
    expect(way?.form.map((f) => f.key)).toEqual(["invite_code"]);
    expect(def.stayWriter).toMatchObject({ writeGuard: "check_then_write", hold: "none" });
  });
});

describe("Beds24: the invite code and its tokens", () => {
  const connectCtx = (fake: FakeBeds24) => {
    const { secret: _s, saveSecret: _save, extra: _e, ...ctx } = runContext(fake.platform.http, {}, fake.clock.now);
    return ctx;
  };

  it("exchanges the code at /authentication/setup as GET, and as POST where only that is served", async () => {
    for (const style of ["get", "post"] as const) {
      const fake = fakeBeds24({ properties: PROPERTIES });
      fake.mode.setup = style;
      fake.invite(INVITE_CODE);
      const made = await def.connect?.(connectCtx(fake), { invite_code: ` ${INVITE_CODE} ` });
      expect(made).toMatchObject({ account: "Ryokan Hoshi and 2 more", externalId: "880214" });
      expect(Object.keys(made?.secret ?? {}).sort()).toEqual([
        "refresh_token",
        "refresh_used_at",
        "token",
        "token_expires_at",
      ]);
      expect(made?.extra).toMatchObject({
        property_ids: ["241501", "241502", "241503"],
        currencies: { "241501": "JPY", "241502": "MXN", "241503": "PEN" },
      });
      const setups = fake.platform.seen.filter((r) => r.url.pathname === "/api/v2/authentication/setup");
      expect(setups.map((r) => r.method)).toEqual(style === "get" ? ["GET"] : ["GET", "POST"]);
      expect(setups.at(-1)?.headers.get("code")).toBe(INVITE_CODE);
      expect(setups.at(-1)?.headers.get("deviceName")).toBe("Inbox");
      clean(fake);
    }
  });

  it("says a code is expired in Beds24's own words, and asks for one made again", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.invite(INVITE_CODE);
    fake.clock.now += DAY + 60_000;
    const error = await def.connect?.(connectCtx(fake), { invite_code: INVITE_CODE }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({
      code: "auth",
      field: "invite_code",
      message: "That code has expired. Make a new one in Beds24.",
    });
  });

  it("refuses a code without the scopes, names them, says a code cannot change, and gives its token back", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.invite(INVITE_CODE, ["read:properties", "read:bookings"]);
    const error = (await def
      .connect?.(connectCtx(fake), { invite_code: INVITE_CODE })
      .catch((e: unknown) => e)) as ConnectorError;
    expect(error.code).toBe("config");
    expect(error.field).toBe("invite_code");
    expect(error.message).toMatch(/missing read inventory, all bookings, read bookings personal/);
    expect(error.message).toMatch(/cannot be changed later/);
    expect(fake.refreshTokens.size).toBe(0);
  });

  it("makes a token from the refresh token when the one held has ended, and keeps it sealed for next time", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const secret: Record<string, string> = {
      refresh_token: fake.grant(),
      token: "tok-old",
      token_expires_at: String(fake.clock.now - 1),
    };
    const ctx = run(fake, secret);
    expect((await stays.properties(ctx)).map((p) => p.id)).toEqual(["241501", "241502", "241503"]);
    expect(secret.token).toMatch(/^tok-/);
    expect(secret.token).not.toBe("tok-old");
    expect(Number(secret.token_expires_at)).toBe(fake.clock.now + DAY);
    expect(secret.refresh_used_at).toBe(String(fake.clock.now));
    // A token Beds24 no longer takes is made again once, then the call goes through.
    secret.token = "tok-revoked";
    secret.token_expires_at = String(fake.clock.now + DAY);
    expect(await stays.properties(run(fake, secret))).toHaveLength(3);
  });

  it("uses the refresh token at least weekly, so a quiet property never reaches Beds24's 30 days unused", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const secret: Record<string, string> = { refresh_token: fake.grant(), refresh_used_at: String(fake.clock.now) };
    const minted = () => fake.platform.seen.filter((r) => r.url.pathname === "/api/v2/authentication/token").length;
    // Six days in: no need yet.
    fake.clock.now += 6 * DAY;
    await def.refresh?.(run(fake, secret));
    const before = minted();
    // Every six hours, as the inbox's connector sync asks, for 90 quiet days.
    for (let t = 0; t < 90 * 4; t++) {
      fake.clock.now += 6 * 3_600_000;
      await def.refresh?.(run(fake, secret));
    }
    expect(minted() - before).toBeGreaterThanOrEqual(12);
    expect(fake.clock.now - Number(secret.refresh_used_at)).toBeLessThanOrEqual(BEDS24_REFRESH_EVERY_MS);
    // Left alone for 31 days, Beds24 forgets it: the owner is asked for a new code.
    const quiet: Record<string, string> = { refresh_token: fake.grant(), refresh_used_at: String(fake.clock.now) };
    fake.clock.now += 31 * DAY;
    const error = await stays.properties(run(fake, quiet)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "auth", message: expect.stringMatching(/new invite code/) });
  });

  it("gives the refresh token back on disconnecting", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    expect(fake.refreshTokens.size).toBe(1);
    await def.disconnect?.(ctx);
    expect(fake.refreshTokens.size).toBe(0);
  });
});

describe("Beds24: rooms, prices and what is free", () => {
  it("reads rooms from the properties call, units and sleeps, and marks a room with no price", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const rooms = await stays.rooms(ctx, String(INTI_WASI.id));
    expect(rooms).toEqual([
      { id: "512021", name: "Matrimonial", units: 2, capacity: { adults: 2, children: 0, total: 2 } },
      { id: "512022", name: "Familiar", units: 1, capacity: { adults: 2, children: 2, total: 4 } },
      {
        id: "512023",
        name: "Dormitorio compartido",
        units: 6,
        capacity: { adults: 1, children: 0, total: 1 },
        unpriced: true,
      },
    ]);
    // Never the "Coming soon" rooms endpoint.
    expect(fake.platform.seen.some((r) => r.url.pathname === "/api/v2/properties/rooms")).toBe(false);
    expect(await stays.ratePlans(ctx, HOSHI)).toEqual([
      { id: "price1", name: "Daily price 1", roomIds: [GARDEN, SUITE] },
      { id: "price2", name: "Daily price 2", roomIds: [GARDEN] },
    ]);
  });

  it("fills the cache from the calendar, in each currency's own minor units", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake, undefined, { currencies: { "241501": "JPY", "241502": "MXN", "241503": "PEN" } });
    const yen = (await stays.ari(ctx, HOSHI, { from: "2027-03-01", to: "2027-03-03" })) as {
      roomId: string;
      prices?: unknown;
    }[];
    expect(yen.find((r) => r.roomId === GARDEN)?.prices).toEqual({ price1: 25_800, price2: 23_200 });
    const pesos = (await stays.ari(ctx, String(CASA_VENTANA.id), { from: "2027-03-01", to: "2027-03-02" })) as {
      roomId: string;
      prices?: unknown;
    }[];
    expect(pesos.find((r) => r.roomId === "512012")?.prices).toEqual({ price1: 290_050 });
    const soles = (await stays.ari(ctx, String(INTI_WASI.id), { from: "2027-03-01", to: "2027-03-02" })) as {
      roomId: string;
      prices?: unknown;
    }[];
    expect(soles.find((r) => r.roomId === "512022")?.prices).toEqual({ price1: 26_590 });
    // The room with no price answers nothing: no row, so nothing is offered on it.
    expect(soles.some((r) => r.roomId === "512023")).toBe(false);
    expect([
      beds24Amount({ value: 25_800, currency: "JPY" }),
      beds24Amount({ value: 290_050, currency: "MXN" }),
    ]).toEqual([25_800, 2_900.5]);
    expect([fromBeds24Amount(265.9, "PEN"), fromBeds24Amount(25_800, "JPY"), fromBeds24Amount(1.005, "PEN")]).toEqual([
      26_590,
      25_800,
      null,
    ]);
  });

  it("reads a calendar as Beds24 writes one: ranges, closures, no-arrival nights, multipliers and overbooking", async () => {
    const p = fakePlatform().on("GET", "https://beds24.com/api/v2/inventory/rooms/calendar", () =>
      json(calendarExample),
    );
    const ctx = {
      ...runContext(p.http, { refresh_token: "r", token: "t", token_expires_at: String(Date.now() + DAY) }),
      extra: { currencies: { "241502": "MXN" } },
    };
    const rows = (await stays.ari(ctx, "241502", { from: "2027-03-01", to: "2027-03-08" })) as unknown as Record<
      string,
      unknown
    >[];
    const by = (night: string) => rows.find((r) => r.night === night);
    expect(rows.map((r) => r.night)).toEqual([
      "2027-03-01",
      "2027-03-02",
      "2027-03-03",
      "2027-03-04",
      "2027-03-05",
      "2027-03-07",
    ]);
    expect(by("2027-03-01")).toEqual({
      roomId: "512012",
      night: "2027-03-01",
      units: 1,
      minStay: 2,
      prices: { price1: 290_050 },
    });
    expect(by("2027-03-03")).toMatchObject({ units: 0, closed: true });
    expect(by("2027-03-04")).toMatchObject({ noArrival: true, prices: { price1: 310_000 } });
    // A multiplier changes what the night sells for: no price rather than one worked out here.
    expect(by("2027-03-05")?.prices).toBeUndefined();
    // Overbooked: Beds24's own count, below none.
    expect(by("2027-03-07")?.units).toBe(-1);
    const asked = p.seen[0]?.url.searchParams;
    expect(asked?.get("startDate")).toBe("2027-03-01");
    expect(asked?.get("endDate")).toBe("2027-03-07");
    expect(asked?.get("includeNumAvail")).toBe("true");
  });

  it("gives Beds24's own total only where one offer is free, never one worked out here", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake, undefined, { currencies: { "241501": "JPY", "241502": "MXN" } });
    const q = {
      propertyId: String(CASA_VENTANA.id),
      roomId: "512011",
      checkIn: "2027-05-01",
      checkOut: "2027-05-04",
      adults: 2,
      childrenAges: [],
    };
    expect(await stays.price?.(ctx, q)).toEqual({ subtotal: { value: 555_000, currency: "MXN" } });
    // Two offers free, and no documented way to tell which is which: none.
    expect(await stays.price?.(ctx, { ...q, propertyId: HOSHI, roomId: GARDEN })).toBeNull();
  });
});

describe("Beds24: credits", () => {
  it("reads the credit headers in both documented spellings", () => {
    for (const h of [wikiHeaders, yamlHeaders]) {
      expect(beds24Budget(new Headers(h))).toEqual({ remaining: 71, resetsInMs: 188_000, cost: 2 });
    }
    expect(beds24Budget(new Headers())).toBeNull();
  });

  it("waits as Beds24 asks, on 429 and on 'Usage limit exceeded' under any status", async () => {
    for (const limit of ["429", "body"] as const) {
      const fake = fakeBeds24({ properties: PROPERTIES });
      fake.mode.limit = limit;
      const ctx = run(fake);
      await stays.properties(ctx);
      fake.credits.remaining = 0;
      fake.clock.now += 12_000;
      const error = (await stays.properties(run(fake, { ...ctx.secret })).catch((e: unknown) => e)) as ConnectorError;
      expect(error.code).toBe("rate_limited");
      expect(error.message).toBe("Beds24 is busy right now. We'll try again in a few minutes.");
      expect(error.retryAfterMs).toBe(288_000);
    }
    const p = fakePlatform().on("GET", "https://beds24.com/api/v2/properties", () => json(usageLimitAnswer, 200));
    const limited = await stays
      .properties(runContext(p.http, { refresh_token: "r", token: "t", token_expires_at: String(Date.now() + DAY) }))
      .catch((e: unknown) => e);
    expect(limited).toMatchObject({ code: "rate_limited", retryAfterMs: 300_000 });
  });

  it("stops reading pages before the account falls below the reserve kept for holds and bookings", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.mode.pageSize = 1;
    const ctx = run(fake, undefined, { currencies: { "241501": "JPY" } });
    await stays.properties(ctx);
    fake.credits.remaining = 31;
    const read = await stays.ari(ctx, HOSHI, { from: "2027-03-01", to: "2027-03-05" });
    expect(Array.isArray(read)).toBe(false);
    expect(read).toMatchObject({ until: "2027-03-01" });
    expect(fake.platform.seen.filter((r) => r.url.pathname.endsWith("/calendar"))).toHaveLength(1);
  });

  it("is never polled below 30 credits by the inbox's own sync, and again once Beds24's window resets", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const { db } = await freshDb();
    const caps = new Capabilities(
      db,
      createSecretBox(["beds24-test-key-0123456789abcdef0123"]),
      "https://inbox.example.com",
      0,
    );
    caps.connectors.attach({ definitions: [def], http: fake.platform.http });
    fake.invite(INVITE_CODE);
    const owner: Caller = {
      actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
      tier: "verified_principal",
      sandbox: false,
      now: () => fake.clock.now,
    };
    const view = await caps.connectors.connect(owner, { kind: "beds24", values: { invite_code: INVITE_CODE } });
    const setup = {
      property: { connectorId: view.id, externalId: HOSHI, timezone: "Asia/Tokyo" },
    } as unknown as PropertySetup;
    const calendarCalls = () => fake.platform.seen.filter((r) => r.url.pathname.endsWith("/calendar")).length;
    expect(await syncAri(db, caps.connectors, setup, fake.clock.now, { days: 3 })).toBe(6);
    fake.credits.remaining = 30;
    expect(await syncAri(db, caps.connectors, setup, fake.clock.now, { days: 3 })).toBe(6);
    // That answer said 29 left: no poll until the window resets, or the reserve would go.
    const calls = calendarCalls();
    expect(await syncAri(db, caps.connectors, setup, fake.clock.now + 1_000, { days: 3 })).toBe(0);
    expect(calendarCalls()).toBe(calls);
    fake.clock.now += 5 * 60_000 + 1_000;
    expect(await syncAri(db, caps.connectors, setup, fake.clock.now, { days: 3 })).toBe(6);
  });
});

describe("Beds24: stays written first", () => {
  it("writes a stay once under our key, at the inbox's price, confirmed, and asks Beds24 to check availability", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000000001", notes: "We arrive late, after 22:00." });
    const a = await writer.put(ctx, stay, null, "confirmed");
    const b = await writer.put(ctx, stay, null, "confirmed");
    expect(b.externalId).toBe(a.externalId);
    expect([...fake.bookings.values()].filter((x) => x.apiReference === stay.key)).toHaveLength(1);
    const post = fake.platform.seen.find((r) => r.method === "POST" && r.url.pathname === "/api/v2/bookings");
    expect(JSON.parse(post?.body ?? "[]")).toEqual([
      {
        roomId: 512_001,
        status: "confirmed",
        arrival: "2027-04-10",
        departure: "2027-04-12",
        numAdult: 2,
        numChild: 0,
        price: 51_600,
        apiReference: stay.key,
        notes: "Written by your inbox · 4F2K9Q",
        comments: "We arrive late, after 22:00.",
        actions: { allowWebhooks: true, checkAvailability: true },
      },
    ]);
    // Read back as written: found by its key, its dates, room and price, and not oversold.
    expect(await writer.oversold?.(ctx, stay, a)).toBe(false);
    expect((await writer.find(ctx, stay))?.externalId).toBe(a.externalId);
    clean(fake);
  });

  it("refuses a night Beds24 has no room for, checked live before the write", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.book({ roomId: 512_001, arrival: "2027-04-11", departure: "2027-04-13", channel: "airbnb" });
    const ctx = run(fake);
    await expect(
      writer.put(ctx, stayOf({ key: "sd-01JAHOSHI0000000000000002" }), null, "confirmed"),
    ).rejects.toMatchObject({
      code: "refused",
      message: "Those nights are no longer free in Beds24.",
    });
    expect(fake.platform.seen.some((r) => r.method === "POST")).toBe(false);
    clean(fake);
  });

  it("catches another channel's booking between its check and its write: Beds24's own count says oversold", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.mode.checkAvailability = "ignore";
    const ctx = run(fake);
    fake.beforeWrite = () => {
      fake.beforeWrite = null;
      fake.book({ roomId: 512_001, arrival: "2027-04-10", departure: "2027-04-11", channel: "booking" });
    };
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000000003" });
    const link = await writer.put(ctx, stay, null, "confirmed");
    expect(fake.numAvail(512_001, "2027-04-10")).toBe(-1);
    expect(await writer.oversold?.(ctx, stay, link)).toBe(true);
    // The inbox takes its own write back: cancelled by status, the other channel's booking untouched.
    await writer.cancel(ctx, link);
    expect(fake.bookings.get(Number(link.externalId))?.status).toBe("cancelled");
    expect(fake.numAvail(512_001, "2027-04-10")).toBe(0);
    // With checkAvailability honoured, Beds24 itself refuses it.
    fake.mode.checkAvailability = "honour";
    fake.beforeWrite = () => {
      fake.beforeWrite = null;
      fake.book({ roomId: 512_002, arrival: "2027-04-10", departure: "2027-04-12" });
      fake.book({ roomId: 512_002, arrival: "2027-04-10", departure: "2027-04-12" });
      fake.book({ roomId: 512_002, arrival: "2027-04-10", departure: "2027-04-12" });
    };
    const suite = stayOf({
      key: "sd-01JAHOSHI0000000000000004",
      rooms: [{ roomId: SUITE, adults: 2, childrenAges: [5], price: { value: 76_000, currency: "JPY" } }],
    });
    await expect(writer.put(ctx, suite, null, "confirmed")).rejects.toMatchObject({ code: "refused" });
    clean(fake);
  });

  it("finds a write whose answer was lost by its key, and never makes it twice", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000000005" });
    fake.mode.lostAnswer = true;
    await expect(writer.put(ctx, stay, null, "confirmed")).rejects.toMatchObject({ code: "unreachable" });
    fake.mode.lostAnswer = false;
    const found = await writer.find(ctx, stay);
    expect(found?.externalId).toBeTruthy();
    expect((await writer.put(ctx, stay, null, "confirmed")).externalId).toBe(found?.externalId);
    expect([...fake.bookings.values()].filter((b) => b.apiReference === stay.key)).toHaveLength(1);
    expect(await writer.find(ctx, stayOf({ key: "sd-01JAHOSHI000000000000NONE" }))).toBeNull();
    clean(fake);
  });

  it("promises nothing on a booking that does not read back as written: no key, another price, gone", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.mode.apiReference = "dropped";
    const ctx = run(fake);
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000000006" });
    const link = await writer.put(ctx, stay, null, "confirmed");
    // Beds24 kept no key: the write could not be found again after a timeout, so it is never trusted.
    await expect(writer.oversold?.(ctx, stay, link)).rejects.toThrow(/key/);
    expect(await writer.find(ctx, stay)).toBeNull();
    fake.mode.apiReference = "kept";
    const other = stayOf({ key: "sd-01JAHOSHI0000000000000007", checkIn: "2027-04-20", checkOut: "2027-04-21" });
    const written = await writer.put(ctx, other, null, "confirmed");
    (fake.bookings.get(Number(written.externalId)) as { price: number }).price = 9_999;
    await expect(
      writer.oversold?.(
        ctx,
        {
          ...other,
          rooms: [{ ...other.rooms[0], price: { value: 25_800, currency: "JPY" } } as OutboundStay["rooms"][number]],
        },
        written,
      ),
    ).rejects.toThrow(/as written/);
    fake.bookings.delete(Number(written.externalId));
    await expect(writer.oversold?.(ctx, other, written)).rejects.toThrow(/as written/);
  });

  it("writes a stay waiting for its deposit as confirmed, flagged, and clears the flag once it is paid", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const stay = stayOf({
      key: "sd-01JACASAVENTANA00000000001",
      propertyId: String(CASA_VENTANA.id),
      rooms: [{ roomId: "512012", adults: 2, childrenAges: [], price: { value: 580_100, currency: "MXN" } }],
    });
    const link = await writer.put(ctx, stay, null, "provisional");
    const b = fake.bookings.get(Number(link.externalId));
    expect(b).toMatchObject({ status: "confirmed", flagText: BEDS24_WAITING_FLAG, price: 5_801 });
    expect(b?.notes).toMatch(/deposit due: cancelled from your inbox if it is not paid/);
    expect(b?.lastName).toBeUndefined();
    // Paid: confirmed again with its guest, the flag taken off, the owner's own notes left as they are.
    if (b) b.notes = "Late check-in agreed by phone";
    await writer.put(
      ctx,
      {
        ...stay,
        key: "sd-01JACASAVENTANA00000000001-confirm-e1",
        guest: { name: "Mariana Sánchez Ruiz", email: "mariana@example.mx" },
      },
      link,
      "confirmed",
    );
    expect(fake.bookings.get(Number(link.externalId))).toMatchObject({
      status: "confirmed",
      flagText: "",
      lastName: "Mariana Sánchez Ruiz",
      email: "mariana@example.mx",
      notes: "Late check-in agreed by phone",
    });
    clean(fake);
  });

  it("holds nothing in Beds24: no status there is known to keep a room off sale", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    await expect(
      writer.put(run(fake), stayOf({ key: "sd-01JAHOSHI0000000000000008" }), null, "hold"),
    ).rejects.toMatchObject({ code: "refused" });
    expect(fake.platform.seen).toEqual([]);
  });

  it("moves a stay it wrote, counting its own nights as its own, and refuses a move onto a full night", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000000009", checkIn: "2027-06-01", checkOut: "2027-06-03" });
    const link = await writer.put(ctx, stay, null, "confirmed");
    // One night longer, over its own nights in a room with one unit: only the new night must be free.
    const longer = { ...stay, key: "sd-01JAHOSHI0000000000000009-change-e1", checkOut: "2027-06-04" };
    await writer.put(ctx, longer, link, "confirmed");
    expect(fake.bookings.get(Number(link.externalId))).toMatchObject({
      arrival: "2027-06-01",
      departure: "2027-06-04",
    });
    expect(await writer.oversold?.(ctx, longer, link)).toBe(false);
    fake.book({ roomId: 512_001, arrival: "2027-06-04", departure: "2027-06-06" });
    await expect(writer.put(ctx, { ...longer, checkOut: "2027-06-05" }, link, "confirmed")).rejects.toMatchObject({
      code: "refused",
    });
    expect(fake.bookings.get(Number(link.externalId))?.departure).toBe("2027-06-04");
    clean(fake);
  });

  it("writes a stay of several rooms as one Beds24 group, moves it whole and cancels it whole, by status", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const room = (roomId: string, value: number) => ({
      roomId,
      adults: 2,
      childrenAges: [],
      price: { value, currency: "PEN" },
    });
    const stay = stayOf({
      key: "sd-01JAINTIWASI0000000000001",
      propertyId: String(INTI_WASI.id),
      checkIn: "2027-07-28",
      checkOut: "2027-07-31",
      rooms: [room("512021", 54_000), room("512022", 79_770)],
    });
    const link = await writer.put(ctx, stay, null, "confirmed");
    const group = fake.bookings.get(Number(link.externalId))?.group ?? [];
    expect(group).toHaveLength(2);
    expect(group.map((id) => fake.bookings.get(id)?.apiReference)).toEqual([stay.key, `${stay.key}~2`]);
    expect(group.map((id) => fake.bookings.get(id)?.price)).toEqual([540, 797.7]);
    expect(await writer.oversold?.(ctx, stay, link)).toBe(false);
    const moved = { ...stay, key: `${stay.key}-change-e2`, checkIn: "2027-08-01", checkOut: "2027-08-03" };
    await writer.put(ctx, moved, link, "confirmed");
    expect(group.map((id) => fake.bookings.get(id)?.arrival)).toEqual(["2027-08-01", "2027-08-01"]);
    await writer.cancel(ctx, link);
    expect(group.map((id) => fake.bookings.get(id)?.status)).toEqual(["cancelled", "cancelled"]);
    // Cancelled, not gone: still found by its key, and cancelling again is done.
    expect((await writer.find(ctx, stay))?.externalId).toBe(link.externalId);
    await writer.cancel(ctx, link);
    clean(fake);
  });

  it("never writes to a room Beds24 says nothing of", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const dorm = stayOf({
      key: "sd-01JAINTIWASI0000000000002",
      propertyId: String(INTI_WASI.id),
      rooms: [{ roomId: "512023", adults: 1, childrenAges: [], price: { value: 4_500, currency: "PEN" } }],
    });
    await expect(writer.put(run(fake), dorm, null, "confirmed")).rejects.toMatchObject({
      code: "refused",
      message: expect.stringMatching(/give it a price in Beds24/),
    });
    expect(fake.platform.seen.some((r) => r.method === "POST")).toBe(false);
  });
});

describe("Beds24: its booking webhook", () => {
  async function connected() {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const { db } = await freshDb();
    const caps = new Capabilities(
      db,
      createSecretBox(["beds24-test-key-0123456789abcdef0123"]),
      "https://inbox.example.com",
      0,
    );
    caps.connectors.attach({ definitions: [def], http: fake.platform.http });
    fake.invite(INVITE_CODE);
    const owner: Caller = {
      actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
      tier: "verified_principal",
      sandbox: false,
      now: () => fake.clock.now,
    };
    const view = await caps.connectors.connect(owner, { kind: "beds24", values: { invite_code: INVITE_CODE } });
    const conn = await caps.connectors.contextFor(view.id, fake.clock.now);
    const token = String(conn?.ctx.hookUrl).split("/").pop() ?? "";
    const events = async () =>
      (await db.client.query({ sql: "SELECT external_id, raw FROM connector_events", params: [], method: "all" })).rows;
    const receive = (t: string, body: unknown) =>
      caps.connectors.receiveHook(
        "beds24",
        t,
        {
          headers: new Headers({ "content-type": "application/json" }),
          body: JSON.stringify(body),
          query: new URLSearchParams(),
        },
        fake.clock.now,
      );
    return { fake, db, caps, view, conn, token, events, receive };
  }

  it("takes a booking webhook at the connection's own address, keeping its ids and nothing of the guest", async () => {
    const { fake, token, events, receive } = await connected();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const before = fake.platform.seen.length;
    const body = bookingWebhook({
      id: 90_001_777,
      propertyId: RYOKAN_HOSHI.id,
      roomId: 512_001,
      arrival: "2027-04-10",
      departure: "2027-04-12",
    });
    expect(await receive(token, body)).toMatchObject({ status: 200, body: { ok: true, duplicate: false } });
    // The same delivery twice is one.
    expect(await receive(token, body)).toMatchObject({ status: 200, body: { duplicate: true } });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.[1]))).toEqual({
      topic: "booking",
      refs: ["booking:90001777", "nights:512001:2027-04-10:2027-04-12"],
    });
    // Answered at once: Beds24 was not asked anything while the webhook was taken.
    expect(fake.platform.seen.length).toBe(before);
  });

  it("answers a forged address 404 and a body that is not Beds24's for this account 400, with nothing read", async () => {
    const { fake, token, events, receive } = await connected();
    const before = fake.platform.seen.length;
    const body = bookingWebhook({
      id: 90_001_778,
      propertyId: RYOKAN_HOSHI.id,
      roomId: 512_001,
      arrival: "2027-04-10",
      departure: "2027-04-12",
    });
    const forged = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect((await receive(forged, body)).status).toBe(404);
    expect((await receive("short", body)).status).toBe(404);
    const elsewhere = bookingWebhook({
      id: 90_001_779,
      propertyId: 999_999,
      roomId: 1,
      arrival: "2027-04-10",
      departure: "2027-04-12",
    });
    expect(await receive(token, elsewhere)).toMatchObject({ status: 400 });
    expect(await receive(token, { booking: { id: "90001779" } })).toMatchObject({ status: 400 });
    expect(await receive(token, { hello: "world" })).toMatchObject({ status: 400 });
    expect(await events()).toEqual([]);
    expect(fake.platform.seen.length).toBe(before);
  });

  it("reads the booking back with the key: its nights as Beds24 has them, and the body's only to look at again", async () => {
    const { fake, conn } = await connected();
    const b = fake.book({ roomId: 512_002, arrival: "2027-09-01", departure: "2027-09-04", channel: "expedia" });
    if (!conn || !def.hooks) throw new Error("not connected");
    // The body says other dates than Beds24 holds: both are read again, and only Beds24's are its own.
    const event = await def.hooks.verify(conn.ctx, {
      headers: new Headers(),
      body: JSON.stringify(
        bookingWebhook({
          id: b.id,
          propertyId: RYOKAN_HOSHI.id,
          roomId: 512_002,
          arrival: "2027-12-24",
          departure: "2027-12-26",
        }),
      ),
      query: new URLSearchParams(),
    });
    expect(event?.eventId).toBe(`booking:${b.id}:2026-10-20T09:14:03Z`);
    const facts = await def.hooks.read(conn.ctx, event as NonNullable<typeof event>);
    expect(facts).toEqual([
      { kind: "stay_nights", roomIds: ["512002"], from: "2027-09-01", to: "2027-09-04" },
      { kind: "stay_nights", roomIds: ["512002"], from: "2027-12-24", to: "2027-12-26" },
    ]);
    const asked = fake.platform.seen.filter((r) => r.url.pathname === "/api/v2/bookings" && r.method === "GET").at(-1);
    expect(asked?.url.searchParams.getAll("id")).toEqual([String(b.id)]);
    expect(asked?.headers.get("token")).toBeTruthy();
  });
});

describe("Beds24: only Beds24's own address", () => {
  it("knows its own address, and no other dressed as it", () => {
    expect(isBeds24Url("https://beds24.com/api/v2/bookings?page=2")).toBe(true);
    for (const url of [
      "http://beds24.com/api/v2/bookings",
      "https://beds24.com.example.net/api/v2/bookings",
      "https://api.beds24.com/api/v2/bookings",
      "https://beds24.com@169.254.169.254/api/v2/bookings",
      "https://beds24.com:8443/api/v2/bookings",
      "https://beds24.com/control3.php",
      "https://10.0.0.7/api/v2/bookings",
    ]) {
      expect(isBeds24Url(url)).toBe(false);
    }
  });

  it("follows a next-page link only on Beds24, with or without its scheme", () => {
    const current = "https://beds24.com/api/v2/bookings?status=confirmed";
    expect(nextPageUrl("https://beds24.com/api/v2/bookings?status=confirmed&page=2", current, 2)).toBe(
      "https://beds24.com/api/v2/bookings?status=confirmed&page=2",
    );
    expect(nextPageUrl("beds24.com/api/v2/bookings?page=2", current, 2)).toBe(
      "https://beds24.com/api/v2/bookings?page=2",
    );
    expect(nextPageUrl(null, current, 3)).toBe("https://beds24.com/api/v2/bookings?status=confirmed&page=3");
    for (const link of [
      "https://beds24.example.net/api/v2/bookings?page=2",
      "example.com/api/example?page=2",
      "https://127.0.0.1/api/v2/x",
    ]) {
      expect(() => nextPageUrl(link, current, 2)).toThrow(ConnectorError);
    }
  });

  it("reads every page Beds24 serves, and asks nothing of a page named on another host", async () => {
    for (const style of ["beds24", "schemeless"] as const) {
      const fake = fakeBeds24({ properties: PROPERTIES });
      fake.mode.pageSize = 1;
      fake.mode.nextPage = style;
      expect(await stays.properties(run(fake))).toHaveLength(3);
    }
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.mode.pageSize = 1;
    fake.mode.nextPage = "foreign";
    await expect(stays.properties(run(fake))).rejects.toMatchObject({ code: "bad_response" });
    expect(fake.platform.seen.every((r) => r.url.hostname === "beds24.com")).toBe(true);
    expect(fake.platform.seen.filter((r) => r.url.pathname === "/api/v2/properties")).toHaveLength(1);
  });

  it("goes through the inbox's own client: a private address is refused even if it were asked", async () => {
    const http: ConnectorHttp = fakeBeds24({ properties: PROPERTIES }).platform.http;
    await expect(
      http.request({ method: "GET", url: "https://169.254.169.254/latest/meta-data" }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });
});
