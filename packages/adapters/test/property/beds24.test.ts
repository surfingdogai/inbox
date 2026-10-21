import {
  ariCells,
  type Caller,
  Capabilities,
  ConnectorError,
  type ConnectorHttp,
  cachedNights,
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
  BEDS24_CHOICES,
  BEDS24_INFO_CODE,
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
  BEIT_AMMAN,
  CASA_VENTANA,
  calendarExample,
  HOSTEL_TBILISI,
  INTI_WASI,
  PROPERTIES,
  propertyAnswer,
  RIAD_ZITOUN,
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
  // Schema `newBooking`'s `infoItems` (code, text), changed by `id` (its examples newInfoItem, modifyInfoItem).
  "infoItems",
  "code",
  "text",
]);
const ALL_IDS = ["241501", "241502", "241503", "241504", "241505"];

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
    currency: "JPY",
    oversells: false,
    exhaust: () => {
      fake.credits.windowStart = fake.clock.now;
      fake.credits.remaining = 0;
    },
  };
});

describe("Beds24: the form and the gallery", () => {
  it("asks for one invite code, sealed yet shown as typed, in steps that name Beds24's choices one a line", () => {
    const [field, ...rest] = describeForm(beds24Form);
    expect(rest).toEqual([]);
    // A code works once, for 24 hours: sealed like a secret, shown so the owner sees it was pasted whole,
    // and emptied after Beds24 refuses it.
    expect(field).toMatchObject({ key: "invite_code", label: "Invite code", secret: true, input: "text", once: true });
    expect(field?.steps).toEqual([
      "In Beds24, open Settings → Marketplace → API and press Generate invite code.",
      {
        text: "Choose these, as Beds24 names them:",
        items: [
          "Bookings: Read and Write",
          "Bookings personal: Read and Write",
          "Bookings financial: Read and Write",
          "Inventory: Read",
          "Properties: Read",
        ],
      },
      "Leave the IP address empty. If your properties are linked, tick Allow linked properties.",
      "Paste the code here. It works for 24 hours.",
    ]);
    expect(field?.help).toBeUndefined();
    // Never "all", which would also let a leaked token delete the owner's bookings.
    expect(BEDS24_CHOICES.join(" ")).not.toMatch(/All/);
  });

  it("is the lodging card's Beds24 way, ready, once it is among the built-in connectors", () => {
    const defs = builtInConnectors({});
    expect(defs.map((d) => d.kind)).toContain("beds24");
    // Shown to a place to stay: the property-system card is a place to stay's own.
    const card = gallery(new Map(defs.map((d) => [d.kind, d])), { lean: "stays" }).find((c) => c.group === "lodging");
    const way = card?.ways.find((w) => w.kind === "beds24");
    // New until a first real account confirms what the documentation leaves open, and said so.
    expect(way).toMatchObject({ status: "ready", auth: "form", fresh: true });
    expect(way?.note).toBe(
      "New: built from Beds24's documentation. Your first stays are checked against Beds24 as they are written.",
    );
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
      // Several properties: counted, never named after whichever Beds24 lists first.
      expect(made).toMatchObject({ account: "5 properties", externalId: "880214" });
      expect(Object.keys(made?.secret ?? {}).sort()).toEqual([
        "refresh_token",
        "refresh_used_at",
        "token",
        "token_expires_at",
      ]);
      expect(made?.extra).toMatchObject({
        property_ids: ALL_IDS,
        currencies: { "241501": "JPY", "241502": "MXN", "241503": "PEN", "241504": "MAD", "241505": "JOD" },
      });
      const setups = fake.platform.seen.filter((r) => r.url.pathname === "/api/v2/authentication/setup");
      expect(setups.map((r) => r.method)).toEqual(style === "get" ? ["GET"] : ["GET", "POST"]);
      expect(setups.at(-1)?.headers.get("code")).toBe(INVITE_CODE);
      expect(setups.at(-1)?.headers.get("deviceName")).toBe("Inbox");
      clean(fake);
    }
  });

  it("says plainly when Beds24 did not take a code: copy it again, or make a new one", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.invite(INVITE_CODE);
    fake.clock.now += DAY + 60_000;
    const error = await def.connect?.(connectCtx(fake), { invite_code: INVITE_CODE }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({
      code: "auth",
      field: "invite_code",
      message: "Beds24 didn't take that code. Copy it again, or make a new one: a code lasts 24 hours.",
    });
  });

  it("refuses a code without the scopes, names them as Beds24 does, and gives its token back", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.invite(INVITE_CODE, ["read:properties", "read:bookings"]);
    const error = (await def
      .connect?.(connectCtx(fake), { invite_code: INVITE_CODE })
      .catch((e: unknown) => e)) as ConnectorError;
    expect(error.code).toBe("config");
    expect(error.field).toBe("invite_code");
    expect(error.message).toBe(
      "That code is missing Bookings: Write · Bookings personal: Read and Write · Bookings financial: Read and Write · Inventory: Read. Make a new code with those too.",
    );
    expect(fake.refreshTokens.size).toBe(0);
  });

  it("refuses a code without Bookings financial: without it, Beds24 would keep no price on a stay", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.invite(INVITE_CODE, [
      "read:bookings",
      "write:bookings",
      "read:bookings-personal",
      "write:bookings-personal",
      "read:inventory",
      "read:properties",
    ]);
    const error = await def.connect?.(connectCtx(fake), { invite_code: INVITE_CODE }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "config",
      field: "invite_code",
      message: "That code is missing Bookings financial: Read and Write. Make a new code with those too.",
    });
    // What such a token would do: a stay written with its price, kept at none, read back without one.
    const ctx = run(fake, {
      refresh_token: fake.grant(["read:bookings", "write:bookings", "read:inventory", "read:properties"]),
      refresh_used_at: String(fake.clock.now),
    });
    const stay = stayOf({ key: "sd-01JAHOSHI000000000000NOFIN" });
    const link = await writer.put(ctx, stay, null, "confirmed");
    expect(fake.bookings.get(Number(link.externalId))?.price).toBe(0);
    await expect(writer.oversold?.(ctx, stay, link)).rejects.toThrow(/as written/);
  });

  it("refuses a code that only reads Bookings personal: without it, Beds24 would keep no guest's name", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const readOnly = [
      "read:bookings",
      "write:bookings",
      "read:bookings-personal",
      "read:bookings-financial",
      "write:bookings-financial",
      "read:inventory",
      "read:properties",
    ];
    fake.invite(INVITE_CODE, readOnly);
    const error = await def.connect?.(connectCtx(fake), { invite_code: INVITE_CODE }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "config",
      field: "invite_code",
      message: "That code is missing Bookings personal: Write. Make a new code with that too.",
    });
    expect(fake.refreshTokens.size).toBe(0);
    // What such a token would do: a confirmed stay written with no guest's name for the front desk.
    const ctx = run(fake, { refresh_token: fake.grant(readOnly), refresh_used_at: String(fake.clock.now) });
    const stay = stayOf({
      key: "sd-01JAHOSHI000000000000NOPER",
      guest: { name: "Aiko Tanaka", email: "aiko@example.jp" },
    });
    const link = await writer.put(ctx, stay, null, "confirmed");
    const kept = fake.bookings.get(Number(link.externalId));
    expect([kept?.lastName, kept?.email]).toEqual([undefined, undefined]);
  });

  it("connects with read and write on bookings, and with a code made with All before", async () => {
    for (const scopes of [
      undefined,
      ["all:bookings", "all:bookings-personal", "all:bookings-financial", "read:inventory", "read:properties"],
    ]) {
      const fake = fakeBeds24({ properties: PROPERTIES });
      fake.invite(INVITE_CODE, scopes);
      expect(await def.connect?.(connectCtx(fake), { invite_code: INVITE_CODE })).toMatchObject({
        externalId: "880214",
      });
    }
  });

  it("makes a token from the refresh token when the one held has ended, and keeps it sealed for next time", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const secret: Record<string, string> = {
      refresh_token: fake.grant(),
      token: "tok-old",
      token_expires_at: String(fake.clock.now - 1),
    };
    const ctx = run(fake, secret);
    expect((await stays.properties(ctx)).map((p) => p.id)).toEqual(ALL_IDS);
    expect(secret.token).toMatch(/^tok-/);
    expect(secret.token).not.toBe("tok-old");
    expect(Number(secret.token_expires_at)).toBe(fake.clock.now + DAY);
    expect(secret.refresh_used_at).toBe(String(fake.clock.now));
    // A token Beds24 no longer takes is made again once, then the call goes through.
    secret.token = "tok-revoked";
    secret.token_expires_at = String(fake.clock.now + DAY);
    expect(await stays.properties(run(fake, secret))).toHaveLength(5);
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
    const p = fakePlatform()
      .on("GET", "https://beds24.com/api/v2/properties", () =>
        json({
          success: true,
          type: "property",
          count: 1,
          pages: { nextPageExists: false, nextPageLink: null },
          data: [propertyAnswer(CASA_VENTANA, { rooms: true, offers: true, rules: true })],
        }),
      )
      .on("GET", "https://beds24.com/api/v2/inventory/rooms/calendar", () => json(calendarExample));
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
    // Each price's rule is read with the calendar, and a price linked to another room's asked for.
    expect(p.seen[0]?.url.searchParams.get("includePriceRules")).toBe("true");
    const asked = p.seen.find((r) => r.url.pathname.endsWith("/calendar"))?.url.searchParams;
    expect(asked?.get("startDate")).toBe("2027-03-01");
    expect(asked?.get("endDate")).toBe("2027-03-07");
    expect(asked?.get("includeNumAvail")).toBe("true");
    expect(asked?.get("includeLinkedPrices")).toBe("true");
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

describe("Beds24: which daily prices are quoted", () => {
  const HOSTEL = String(HOSTEL_TBILISI.id);
  const DORM = "512051";
  const TWIN = "512052";
  const STUDIO = "512053";

  it("quotes from the cache only a price that is the whole room's for a night, whatever the party or stay", async () => {
    const fake = fakeBeds24({ properties: [HOSTEL_TBILISI] });
    const ctx = run(fake);
    const rows = (await stays.ari(ctx, HOSTEL, { from: "2027-06-01", to: "2027-06-03" })) as {
      roomId: string;
      prices?: Record<string, number>;
    }[];
    const pricesOf = (room: string) => rows.filter((r) => r.roomId === room).map((r) => r.prices);
    // Per person, a bed in the dormitory: never the room's price for any party.
    expect(pricesOf(DORM)).toEqual([undefined, undefined]);
    // The twin's price for two, with 30 for a third, is left out; its whole-room price is kept.
    expect(pricesOf(TWIN)).toEqual([{ price2: 14_000 }, { price2: 14_000 }]);
    // A price for a week or more is never a night's price on its own.
    expect(pricesOf(STUDIO)).toEqual([undefined, undefined]);
    // The rooms are still free or not as Beds24 says: only the price is left out.
    expect(rows.filter((r) => r.roomId === DORM).map((r) => (r as { units?: number }).units)).toEqual([1, 1]);
    expect(await stays.ratePlans(run(fake), HOSTEL)).toEqual([
      { id: "price2", name: "Daily price 2", roomIds: [TWIN] },
    ]);
  });

  it("never quotes three guests the price of one, nor the price for two, through the inbox's own cache", async () => {
    const fake = fakeBeds24({ properties: [HOSTEL_TBILISI] });
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
      property: { connectorId: view.id, externalId: HOSTEL, timezone: "Asia/Tbilisi" },
    } as unknown as PropertySetup;
    await syncAri(db, caps.connectors, setup, fake.clock.now, { days: 30 });
    const today = new Date(fake.clock.now).toISOString().slice(0, 10);
    const nights = [1, 2].map((d) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + (d + 7) * DAY).toISOString().slice(0, 10),
    );
    const cells = await ariCells(db, view.id, [DORM, TWIN, STUDIO], nights);
    expect(cells.filter((c) => c.roomExtId === DORM)).toHaveLength(2);
    // Three in the dormitory: no price from the cache at all, so never 38 a night for the three of them.
    expect(cachedNights(cells, DORM, null, nights)).toBeNull();
    expect(cachedNights(cells, DORM, "price1", nights)).toBeNull();
    // Three in the twin: the whole room's 140, never the price for two (110).
    expect(cachedNights(cells, TWIN, null, nights)).toEqual(nights.map((night) => ({ night, amount: 14_000 })));
    expect(cachedNights(cells, TWIN, "price1", nights)).toBeNull();
    expect(cachedNights(cells, STUDIO, null, nights)).toBeNull();
  });

  it("tells the owner which rooms have prices it cannot quote, and which have none", async () => {
    const fake = fakeBeds24({ properties: [HOSTEL_TBILISI, INTI_WASI] });
    const ctx = run(fake);
    const hostel = await stays.rooms(ctx, HOSTEL);
    expect(hostel.map((r) => [r.name, r.unpriced])).toEqual([
      ["Six-bed dormitory", "rules"],
      ["Twin room", undefined],
      ["Studio, weekly", "rules"],
    ]);
    const inti = await stays.rooms(ctx, String(INTI_WASI.id));
    expect(inti.find((r) => r.id === "512023")?.unpriced).toBe(true);
    expect(def.stays?.pricesAt).toBe("Prices → Daily Price Rules");
  });

  it("reads every property's rooms for the matching sheet in one go, and nothing of prices at the reserve", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    for (const p of PROPERTIES) await stays.rooms(ctx, String(p.id));
    await stays.ratePlans(ctx, HOSHI);
    const calls = (path: string) => fake.platform.seen.filter((r) => r.url.pathname === `/api/v2${path}`).length;
    // Five properties, one read of them and one calendar for all, however many are shown.
    expect([calls("/properties"), calls("/inventory/rooms/calendar")]).toEqual([1, 1]);
    const asked = fake.platform.seen.find((r) => r.url.pathname.endsWith("/calendar"))?.url.searchParams;
    expect(asked?.getAll("propertyId")).toEqual(ALL_IDS);

    // The account close to the credits kept for guests booking: the calendar is not read at all, and
    // no room is said to have no price on a read that did not happen.
    const low = fakeBeds24({ properties: PROPERTIES });
    const lowCtx = run(low);
    // A token, then the properties: 30 left, which a calendar read would take below the reserve.
    low.credits.remaining = 32;
    const rooms = await stays.rooms(lowCtx, String(INTI_WASI.id));
    expect(rooms.every((r) => r.unpriced === undefined)).toBe(true);
    expect(low.platform.seen.some((r) => r.url.pathname.endsWith("/calendar"))).toBe(false);
    expect(low.credits.remaining).toBe(30);
  });

  it("refuses a stay in another currency than Beds24 keeps the property in, before anything is written", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    // Beds24's property moved to another currency since the rooms were matched.
    const ctx = run(fake, undefined, { currencies: { "241501": "USD" } });
    await expect(
      writer.put(ctx, stayOf({ key: "sd-01JAHOSHI000000000000CUR1" }), null, "confirmed"),
    ).rejects.toMatchObject({
      code: "refused",
      message: "Beds24 keeps this property in USD, and this stay is in JPY: make them the same first.",
    });
    expect(fake.platform.seen.some((r) => r.method === "POST")).toBe(false);
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
      expect(error.message).toBe("Beds24 is busy right now. Your inbox tries again in a few minutes.");
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
    // The property and its price rules are read first, then the calendar's first page, and no more.
    fake.credits.remaining = 32;
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
    expect(await writer.find(ctx, stayOf({ key: "sd-01JAHOSHI000000000000NONE", reference: "7HN2XW" }))).toBeNull();
    clean(fake);
  });

  it("finds a write whose answer was lost even where Beds24 kept no key, by its room, dates and note", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.mode.apiReference = "dropped";
    const ctx = run(fake);
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000000LOST", reference: "LQ7M2P" });
    fake.mode.lostAnswer = true;
    await expect(writer.put(ctx, stay, null, "confirmed")).rejects.toMatchObject({ code: "unreachable" });
    fake.mode.lostAnswer = false;
    const [landed] = [...fake.bookings.values()];
    expect(landed?.apiReference).toBeUndefined();
    // Found, so the inbox takes it back instead of leaving a booking nobody was told of.
    const found = await writer.find(ctx, stay);
    expect(found?.externalId).toBe(String(landed?.id));
    const lookup = fake.platform.seen.filter((r) => r.method === "GET" && r.url.pathname.endsWith("/bookings")).at(-1);
    expect(lookup?.url.searchParams.get("arrival")).toBe(stay.checkIn);
    expect(lookup?.url.searchParams.get("departure")).toBe(stay.checkOut);
    expect(lookup?.url.searchParams.getAll("roomId")).toEqual([GARDEN]);
    // Another stay on the same room and dates, with another reference, is never taken for it.
    expect(await writer.find(ctx, { ...stay, key: "sd-01JAHOSHI0000000000000OTHR", reference: "Z9K4TA" })).toBeNull();
    // A change is never found that way: its booking is the link it already has.
    expect(await writer.find(ctx, { ...stay, key: "sd-01JAHOSHI-change-1" })).toBeNull();
    await writer.cancel(ctx, found as NonNullable<typeof found>);
    expect(landed?.status).toBe("cancelled");
    clean(fake);
  });

  it("promises nothing on a booking that does not read back as written: no key, another price, gone", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.mode.apiReference = "dropped";
    const ctx = run(fake);
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000000006" });
    const link = await writer.put(ctx, stay, null, "confirmed");
    // Beds24 kept no key: the write is never trusted, and is found by its note to be taken back.
    await expect(writer.oversold?.(ctx, stay, link)).rejects.toThrow(/key/);
    expect((await writer.find(ctx, stay))?.externalId).toBe(link.externalId);
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

  it("writes a stay waiting for its deposit as confirmed, flagged, and says what was paid once it is", async () => {
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
    expect(b?.notes).toBe("Written by your inbox · 4F2K9Q");
    expect(b?.infoItems).toEqual([
      {
        id: expect.any(Number),
        code: BEDS24_INFO_CODE,
        text: "Deposit due: your inbox cancels this stay if it is not paid in time.",
      },
    ]);
    expect(b?.lastName).toBeUndefined();
    // Paid: confirmed again with its guest, the flag taken off, the same info item now saying what was
    // paid and what is left at the desk; the owner's own notes left as they are.
    if (b) b.notes = "Late check-in agreed by phone";
    const item = b?.infoItems?.[0]?.id;
    await writer.put(
      ctx,
      {
        ...stay,
        key: "sd-01JACASAVENTANA00000000001-confirm-e1",
        guest: { name: "  Mariana Sánchez Ruiz ", email: "mariana@example.mx" },
        amounts: { paid: { value: 174_030, currency: "MXN" }, atProperty: { value: 406_070, currency: "MXN" } },
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
      infoItems: [
        {
          id: item,
          code: BEDS24_INFO_CODE,
          text: "Paid in your inbox: MXN 1740.30. Due at the property: MXN 4060.70.",
        },
      ],
    });
    clean(fake);
  });

  it("takes no stay in a currency of three decimals, nor a total above what Beds24 holds, before writing", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    // The money itself goes both ways in JOD; Beds24's two-decimal maximum is what keeps it out.
    expect(fromBeds24Amount(45.125, "JOD")).toBe(45_125);
    expect(beds24Amount({ value: 45_125, currency: "JOD" })).toBe(45.125);
    expect(fromBeds24Amount(1_640.5, "MAD")).toBe(164_050);
    const amman = stayOf({
      key: "sd-01JABEITAMMAN000000000001",
      propertyId: String(BEIT_AMMAN.id),
      rooms: [{ roomId: "512041", adults: 2, childrenAges: [], price: { value: 90_250, currency: "JOD" } }],
    });
    await expect(writer.put(ctx, amman, null, "confirmed")).rejects.toMatchObject({
      code: "refused",
      message: "Stays in JOD are not written to Beds24 yet: confirm this one there yourself.",
    });
    const huge = stayOf({
      key: "sd-01JAHOSHI00000000000HUGE",
      rooms: [{ roomId: GARDEN, adults: 2, childrenAges: [], price: { value: 100_000_000, currency: "JPY" } }],
    });
    await expect(writer.put(ctx, huge, null, "confirmed")).rejects.toMatchObject({
      code: "refused",
      message: "That total is more than Beds24 takes for one booking.",
    });
    expect(fake.platform.seen.some((r) => r.method === "POST")).toBe(false);
  });

  it("does not take a booking back over the guest's name: Beds24 may trim or escape it", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    // Written composed and cut to 100 UTF-16 units, by character: an emoji at the edge is never split.
    const name = `Zoë O'Brien-${"🌊".repeat(120)}`;
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000000NAME", guest: { name } });
    const link = await writer.put(ctx, stay, null, "confirmed");
    const written = fake.bookings.get(Number(link.externalId)) as { lastName: string };
    expect(written.lastName).toHaveLength(100);
    expect([...written.lastName]).toHaveLength(56);
    expect(written.lastName.endsWith("🌊")).toBe(true);
    written.lastName = "Zo&euml; O&#39;Brien";
    expect(await writer.oversold?.(ctx, stay, link)).toBe(false);
  });

  it("writes a name of 100 characters whole, and leaves out an email or phone too long rather than cut it", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const name = "山".repeat(100);
    const email = `${"k".repeat(95)}@example.jp`;
    const stay = stayOf({
      key: "sd-01JAHOSHI000000000000CJK1",
      guest: { name, email, phone: "+81 75 123 4567" },
    });
    const link = await writer.put(ctx, stay, null, "confirmed");
    const kept = fake.bookings.get(Number(link.externalId));
    expect([kept?.lastName, kept?.email, kept?.phone]).toEqual([name, undefined, "+81 75 123 4567"]);
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
      message: "Beds24 shows no availability for that room on those nights.",
    });
    expect(fake.platform.seen.some((r) => r.method === "POST")).toBe(false);
  });
});

describe("Beds24: a write that goes through only in part", () => {
  const room = (roomId: string, value: number) => ({
    roomId,
    adults: 2,
    childrenAges: [],
    price: { value, currency: "PEN" },
  });
  const twoRooms = (key: string) =>
    stayOf({
      key,
      propertyId: String(INTI_WASI.id),
      checkIn: "2027-07-28",
      checkOut: "2027-07-31",
      rooms: [room("512021", 54_000), room("512022", 79_770)],
    });
  const where = (fake: FakeBeds24, ids: readonly number[]) =>
    ids.map((id) => {
      const b = fake.bookings.get(id);
      return `${b?.status} ${b?.arrival}..${b?.departure}`;
    });

  it("adds a room before it moves any, and a room another channel takes then moves nothing", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const stay = twoRooms("sd-01JAINTIWASI0000000000011");
    const link = await writer.put(ctx, stay, null, "confirmed");
    const ids = [...(fake.bookings.get(Number(link.externalId))?.group ?? [])];
    const before = where(fake, ids);
    // The change: other dates, and a third room. Another channel takes the last Matrimonial meanwhile.
    fake.beforeWrite = () => {
      fake.beforeWrite = null;
      fake.book({ roomId: 512_021, arrival: "2027-08-10", departure: "2027-08-12", channel: "airbnb" });
      fake.book({ roomId: 512_021, arrival: "2027-08-10", departure: "2027-08-12", channel: "booking" });
    };
    const changed = {
      ...stay,
      key: `${stay.key}-change-e1`,
      checkIn: "2027-08-10",
      checkOut: "2027-08-12",
      rooms: [room("512021", 36_000), room("512022", 53_180), room("512021", 36_000)],
    };
    await expect(writer.put(ctx, changed, link, "confirmed")).rejects.toMatchObject({ code: "refused" });
    // Beds24 still has the stay on its own nights, and the nights it held are still taken.
    expect(where(fake, ids)).toEqual(before);
    expect(fake.numAvail(512_021, "2027-07-28")).toBe(1);
    expect(fake.numAvail(512_022, "2027-07-28")).toBe(0);
    expect([...fake.bookings.values()].filter((b) => b.apiReference === `${stay.key}~3`)).toEqual([]);
    clean(fake);
  });

  it("puts every room back when Beds24 refuses one of them mid-change, and cancels the room it made", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const stay = twoRooms("sd-01JAINTIWASI0000000000012");
    const link = await writer.put(ctx, stay, null, "confirmed");
    const ids = [...(fake.bookings.get(Number(link.externalId))?.group ?? [])];
    const before = where(fake, ids);
    // Beds24 will not change the second room (locked): the first moves, the third is made, then both undone.
    fake.mode.refuseModify.add(ids[1] as number);
    const changed = {
      ...stay,
      key: `${stay.key}-change-e2`,
      checkIn: "2027-08-10",
      checkOut: "2027-08-12",
      rooms: [room("512021", 36_000), room("512022", 53_180), room("512021", 36_000)],
    };
    await expect(writer.put(ctx, changed, link, "confirmed")).rejects.toMatchObject({
      code: "refused",
      message: "Booking is locked",
    });
    expect(where(fake, ids)).toEqual(before);
    expect(fake.bookings.get(ids[0] as number)?.price).toBe(540);
    const third = [...fake.bookings.values()].filter((b) => b.apiReference === `${stay.key}~3`);
    expect(third.map((b) => b.status)).toEqual(["cancelled"]);
    expect(fake.numAvail(512_021, "2027-08-10")).toBe(2);
    clean(fake);
  });

  it("never calls a change refused when putting it back did not go through: it may stand there", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const stay = twoRooms("sd-01JAINTIWASI0000000000013");
    const link = await writer.put(ctx, stay, null, "confirmed");
    const ids = [...(fake.bookings.get(Number(link.externalId))?.group ?? [])];
    fake.mode.refuseModify.add(ids[1] as number);
    // The change's write spends the last credits: putting it back is answered "Usage limit exceeded".
    fake.beforeWrite = () => {
      fake.credits.remaining = 0;
    };
    const changed = { ...stay, key: `${stay.key}-change-e3`, checkIn: "2027-08-10", checkOut: "2027-08-13" };
    await expect(writer.put(ctx, changed, link, "confirmed")).rejects.toMatchObject({
      code: "bad_response",
      message: `Beds24 took part of this and did not take all of it back: check booking ${ids[0]} there.`,
    });
    clean(fake);
  });

  it("restores a stay whose change oversold to the nights it held, even with one of them taken since", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    fake.mode.checkAvailability = "ignore";
    const ctx = run(fake);
    const stay = twoRooms("sd-01JAINTIWASI0000000000014");
    const link = await writer.put(ctx, stay, null, "confirmed");
    const ids = [...(fake.bookings.get(Number(link.externalId))?.group ?? [])];
    fake.beforeWrite = () => {
      fake.beforeWrite = null;
      fake.book({ roomId: 512_022, arrival: "2027-08-10", departure: "2027-08-12", channel: "expedia" });
    };
    const changed = {
      ...stay,
      key: `${stay.key}-change-e4`,
      checkIn: "2027-08-10",
      checkOut: "2027-08-12",
      rooms: [...stay.rooms, room("512021", 54_000)],
    };
    await writer.put(ctx, changed, link, "confirmed");
    expect(await writer.oversold?.(ctx, changed, link)).toBe(true);
    // Meanwhile another channel takes the Familiar's old last night, freed by the move.
    fake.book({ roomId: 512_022, arrival: "2027-07-30", departure: "2027-07-31", channel: "booking" });
    // A plain move back is refused: the night is not free. The restore puts it back all the same, and says so.
    await expect(writer.put(ctx, { ...stay, key: changed.key }, link, "confirmed")).rejects.toMatchObject({
      code: "refused",
    });
    await writer.restore?.(ctx, { ...stay, key: changed.key }, link);
    expect(where(fake, ids)).toEqual(["confirmed 2027-07-28..2027-07-31", "confirmed 2027-07-28..2027-07-31"]);
    const third = [...fake.bookings.values()].filter((b) => b.apiReference === `${stay.key}~3`);
    expect(third.map((b) => b.status)).toEqual(["cancelled"]);
    expect(await writer.oversold?.(ctx, { ...stay, key: changed.key }, link)).toBe(true);
    clean(fake);
  });

  it("never calls a group refused when cancelling what it made did not go through, and still finds it", async () => {
    for (const lost of ["last", "first"] as const) {
      const fake = fakeBeds24({ properties: PROPERTIES });
      const ctx = run(fake);
      const key = `sd-01JAINTIWASI00000000002${lost === "first" ? "1" : "2"}`;
      // Three rooms; the Familiar (one unit) is taken in the moment, and the credits run out with it.
      const rooms =
        lost === "last"
          ? [room("512021", 54_000), room("512021", 54_000), room("512022", 79_770)]
          : [room("512022", 79_770), room("512021", 54_000), room("512021", 54_000)];
      fake.beforeWrite = () => {
        fake.beforeWrite = null;
        fake.book({ roomId: 512_022, arrival: "2027-07-28", departure: "2027-07-31", channel: "booking" });
        fake.credits.remaining = 0;
      };
      const stay = stayOf({
        key,
        propertyId: String(INTI_WASI.id),
        checkIn: "2027-07-28",
        checkOut: "2027-07-31",
        rooms,
      });
      const error = (await writer.put(ctx, stay, null, "confirmed").catch((e: unknown) => e)) as ConnectorError;
      const made = [...fake.bookings.values()].filter((b) => (b.apiReference ?? "").startsWith(key));
      expect(made.map((b) => b.status)).toEqual(["confirmed", "confirmed"]);
      expect(error).toMatchObject({ code: "bad_response" });
      expect(error.message).toBe(
        `Beds24 took part of this and did not take all of it back: check bookings ${made.map((b) => b.id).join(", ")} there.`,
      );
      // Once Beds24 answers again, the stay is found by its key even with its first room missing, and
      // taken back whole.
      fake.clock.now += 5 * 60_000 + 1_000;
      const found = await writer.find(ctx, stay);
      expect(found?.externalId).toBe(String(made[0]?.id));
      await writer.cancel(ctx, found as NonNullable<typeof found>);
      expect(made.map((b) => fake.bookings.get(b.id)?.status)).toEqual(["cancelled", "cancelled"]);
      clean(fake);
    }
  });
});

describe("Beds24: what is undocumented, either way", () => {
  it("counts bookings by unit at the stay's edges, reading no other channel's guest", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    // The calendar stops at none: Beds24's count of bookings against units is what tells.
    fake.mode.clampAvail = true;
    fake.mode.checkAvailability = "ignore";
    const ctx = run(fake);
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000UNIT1" });
    const link = await writer.put(ctx, stay, null, "confirmed");
    expect(await writer.oversold?.(ctx, stay, link)).toBe(false);
    // Another channel's guest arriving on the stay's last night: one unit, two bookings.
    fake.book({
      roomId: 512_001,
      arrival: "2027-04-11",
      departure: "2027-04-14",
      channel: "airbnb",
      lastName: "Okafor",
    });
    expect(await writer.oversold?.(ctx, stay, link)).toBe(true);
    const counted = fake.platform.seen.filter((r) => r.url.pathname.endsWith("/inventory/rooms/unitBookings")).at(-1);
    // "The last night to be booked (i.e. the day before check-out)".
    expect([counted?.url.searchParams.get("startDate"), counted?.url.searchParams.get("endDate")]).toEqual([
      "2027-04-10",
      "2027-04-11",
    ]);
    // Counted with the inventory scope: no list of every booking on those nights, with their guests, is asked for.
    expect(
      fake.platform.seen.some((r) => r.url.pathname.endsWith("/bookings") && r.url.searchParams.has("arrivalTo")),
    ).toBe(false);
  });

  it("counts bookings at the stay's edges where that count is not served, whether date bounds count the day or not", async () => {
    for (const bounds of ["inclusive", "exclusive"] as const) {
      const fake = fakeBeds24({ properties: PROPERTIES });
      fake.mode.clampAvail = true;
      fake.mode.bounds = bounds;
      fake.mode.checkAvailability = "ignore";
      fake.mode.unitBookings = "missing";
      const ctx = run(fake);
      const stay = stayOf({ key: `sd-01JAHOSHI0000000000EDGE${bounds === "inclusive" ? "1" : "2"}` });
      const link = await writer.put(ctx, stay, null, "confirmed");
      expect(await writer.oversold?.(ctx, stay, link)).toBe(false);
      fake.book({ roomId: 512_001, arrival: "2027-04-11", departure: "2027-04-14", channel: "airbnb" });
      expect(fake.numAvail(512_001, "2027-04-11")).toBe(-1);
      expect(await writer.oversold?.(ctx, stay, link)).toBe(true);
      const asked = fake.platform.seen.filter((r) => r.url.searchParams.has("arrivalTo")).at(-1)?.url.searchParams;
      // From any arrival date: a guest already in the house is counted, not only upcoming arrivals.
      expect([asked?.get("arrivalFrom"), asked?.get("arrivalTo"), asked?.get("departureFrom")]).toEqual([
        "2000-01-01",
        "2027-04-12",
        "2027-04-10",
      ]);
    }
  });

  it("finds a stay already past, whether or not Beds24 keeps a lookup by id to upcoming stays", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES, now: Date.parse("2026-10-20T08:00:00Z") });
    fake.mode.upcoming = "always";
    const ctx = run(fake);
    const stay = stayOf({ key: "sd-01JAHOSHI0000000000000PAST", checkIn: "2026-10-25", checkOut: "2026-10-28" });
    const link = await writer.put(ctx, stay, null, "confirmed");
    fake.clock.now = Date.parse("2026-11-06T00:00:00Z");
    const later = run(fake, { ...ctx.secret });
    expect((await writer.find(later, stay))?.externalId).toBe(link.externalId);
    // A no-show's nights after the first go: the booking is found and moved.
    await writer.put(later, { ...stay, key: `${stay.key}-release-e1`, checkOut: "2026-10-26" }, link, "confirmed");
    expect(fake.bookings.get(Number(link.externalId))?.departure).toBe("2026-10-26");
    await writer.cancel(later, link);
    expect(fake.bookings.get(Number(link.externalId))?.status).toBe("cancelled");
  });

  it("never calls a booking Beds24 does not have cancelled: the owner is asked to look", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const ctx = run(fake);
    const gone = { externalId: "90009999", etag: null, calendar: null };
    await expect(writer.cancel(ctx, gone)).rejects.toMatchObject({
      code: "refused",
      message: "That booking was not found in Beds24: check it there.",
    });
    await expect(
      writer.put(ctx, stayOf({ key: "sd-01JAHOSHI0000000000000GONE-confirm-e1" }), gone, "confirmed"),
    ).rejects.toMatchObject({ code: "refused", message: "That booking was not found in Beds24: check it there." });
  });

  it("tells of the charges Beds24 adds to a room besides its price: its fees, taxes and obligatory extras", async () => {
    const fake = fakeBeds24({ properties: PROPERTIES });
    const rooms = await stays.rooms(run(fake), String(RIAD_ZITOUN.id));
    expect(rooms.map((r) => [r.name, r.charges])).toEqual([
      ["Chambre patio", ["cleaning", "tax"]],
      ["Suite terrasse", ["tax"]],
    ]);
    const asked = fake.platform.seen.find((r) => r.url.pathname === "/api/v2/properties")?.url.searchParams;
    expect(asked?.get("includeUpsellItems")).toBe("true");
    // A property with none says none.
    expect((await stays.rooms(run(fake), HOSHI)).every((r) => r.charges === undefined)).toBe(true);
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

  it("reads again the nights a webhook names without spending a credit, and asks Beds24 only when it names none", async () => {
    const { fake, conn } = await connected();
    const b = fake.book({ roomId: 512_002, arrival: "2027-09-01", departure: "2027-09-04", channel: "expedia" });
    if (!conn || !def.hooks) throw new Error("not connected");
    const body = (x: unknown) => ({ headers: new Headers(), body: JSON.stringify(x), query: new URLSearchParams() });
    const event = await def.hooks.verify(
      conn.ctx,
      body(
        bookingWebhook({
          id: b.id,
          propertyId: RYOKAN_HOSHI.id,
          roomId: 512_002,
          arrival: "2027-12-24",
          departure: "2027-12-26",
        }),
      ),
    );
    expect(event?.eventId).toBe(`booking:${b.id}:2026-10-20T09:14:03Z`);
    const before = fake.platform.seen.length;
    // The nights named are only read again, never believed: nothing is asked of Beds24 for them.
    expect(await def.hooks.read(conn.ctx, event as NonNullable<typeof event>)).toEqual([
      { kind: "stay_nights", roomIds: ["512002"], from: "2027-12-24", to: "2027-12-26" },
    ]);
    expect(fake.platform.seen.length).toBe(before);
    // A webhook naming no nights: the booking is read back with the token, for the nights Beds24 holds.
    const bare = await def.hooks.verify(conn.ctx, body({ timeStamp: "2026-10-20T10:00:00Z", booking: { id: b.id } }));
    expect(await def.hooks.read(conn.ctx, bare as NonNullable<typeof bare>)).toEqual([
      { kind: "stay_nights", roomIds: ["512002"], from: "2027-09-01", to: "2027-09-04" },
    ]);
    const asked = fake.platform.seen.filter((r) => r.url.pathname === "/api/v2/bookings" && r.method === "GET").at(-1);
    expect(asked?.url.searchParams.getAll("id")).toEqual([String(b.id)]);
    expect(asked?.headers.get("token")).toBeTruthy();
  });

  it("refuses a webhook that carries card details, keeping nothing of it", async () => {
    const { token, events, receive } = await connected();
    const base = bookingWebhook({
      id: 90_001_780,
      propertyId: RYOKAN_HOSHI.id,
      roomId: 512_001,
      arrival: "2027-04-10",
      departure: "2027-04-12",
    });
    // Every documented body names the token fields, empty: taken. One holding a card's token or CVC is not.
    expect(base.booking).toMatchObject({ stripeToken: null, pcibookingToken: null });
    for (const extra of [
      { cvc: "123" },
      { cardToken: "tok_x" },
      { stripeToken: "tok_1Q2w3E" },
      { pcibookingToken: 4242 },
    ]) {
      expect(await receive(token, { ...base, booking: { ...base.booking, ...extra } })).toMatchObject({
        status: 400,
      });
    }
    expect(await events()).toEqual([]);
    expect(await receive(token, { ...base, booking: { ...base.booking, stripeToken: "" } })).toMatchObject({
      status: 200,
    });
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
      expect(await stays.properties(run(fake))).toHaveLength(5);
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
