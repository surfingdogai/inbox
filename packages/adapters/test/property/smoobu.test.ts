import {
  type ConnectContext,
  ConnectorError,
  ConnectorHooks,
  customerWordsIn,
  describeForm,
  gallery,
  type HookHost,
  type InboundRequest,
  inboundHash,
  isPropertySystem,
  newInboundToken,
  type OutboundStay,
  type RunContext,
  writeFirst,
} from "@surfingdog/core";
import { afterEach, describe, expect, it } from "vitest";
import { builtInConnectors } from "../../src/connectors/index";
import {
  newHookKey,
  SMOOBU_DOCS,
  SMOOBU_GUARDS,
  SMOOBU_HOSTS,
  SMOOBU_RATE,
  sha256Hex,
  smoobuBudget,
  smoobuCanonical,
  smoobuConnector,
  smoobuHeaders,
  smoobuMinor,
  smoobuQuery,
  smoobuRetryAfterMs,
  smoobuTimestamp,
  smoobuWebhookUrl,
} from "../../src/connectors/property/smoobu";
import { freshDb } from "../db";
import { type SmoobuFake, smoobuFake } from "../fakes/property/smoobu";
import {
  CAP_BLANC,
  type FakeApartment,
  HAVELI_RANG,
  KIJIWE_LODGE,
  TWO_TOWNS,
} from "../fixtures/property/smoobu/apartments";
import {
  CAPBLANC_USER,
  DOC_EXAMPLE,
  HAVELI_USER,
  KIJIWE_USER,
  keyPair,
  MIXED_USER,
} from "../fixtures/property/smoobu/auth";
import {
  deliveryBody,
  newMessage,
  onlineCheckIn,
  priceElementCreated,
  updateRates,
} from "../fixtures/property/smoobu/webhooks";
import { propertyContract, runContext } from "./contract";

/**
 * Smoobu's adapter (ADR-033 §8) against its fake, built from Smoobu's own documentation (the fixtures'
 * headers keep each excerpt): the property system contract for three places, then what is Smoobu's
 * own: the HMAC signature pinned by the documentation's two examples, the nonce and the timestamp
 * (our clock corrected once from Smoobu's), never the legacy `Api-Key`; apartments grouped into
 * properties by currency, zone and town; rates as nights in each currency's own minor unit; stays
 * checked live before they are written and read back after, taken back through the inbox's own
 * write-first when another channel took the night between; no move of nights, cancellations kept as
 * cancelled; a webhook address with a second secret checked in constant time, events filtered and
 * only hints; the rate limit's Unix time; and nothing sent anywhere but Smoobu's API, never a card,
 * a payment status, a fee or a commission.
 */

const HOOK_URL = "https://inbox.haveli-rang.example/v1/hooks/smoobu/SGF2ZWxpLVJhbmctaG9vay10b2tlbi0wMDAwMDAwMDA";

type User = { readonly id: number; readonly firstName: string; readonly lastName: string; readonly email: string };

const fakes: SmoobuFake[] = [];

afterEach(() => {
  // Whatever a test did, Smoobu was never sent the legacy key, an unsigned request, a reused nonce, a
  // card, a payment status, a fee, a commission, dates in an update, or a delete of anything but a booking.
  for (const f of fakes.splice(0)) expect(f.violations).toEqual([]);
});

interface Connection {
  readonly fake: SmoobuFake;
  readonly def: ReturnType<typeof smoobuConnector>;
  readonly secret: Record<string, string>;
  readonly saved: Record<string, string>[];
  ctx(o?: Partial<RunContext>): RunContext;
}

function connection(
  apartments: readonly FakeApartment[],
  user: User = HAVELI_USER,
  o: {
    readonly n?: number;
    readonly offsetMs?: number;
    readonly language?: string;
    readonly nonce?: () => string;
  } = {},
): Connection {
  const keys = keyPair(o.n ?? 1);
  const fake = smoobuFake({ user, apiKey: keys.apiKey, apiSecret: keys.apiSecret, apartments });
  fakes.push(fake);
  const def = smoobuConnector({
    clock: () => fake.clock.now + (o.offsetMs ?? 0),
    ...(o.nonce ? { nonce: o.nonce } : {}),
  });
  const secret: Record<string, string> = { api_key: keys.apiKey, api_secret: keys.apiSecret, hook_key: newHookKey() };
  const saved: Record<string, string>[] = [];
  return {
    fake,
    def,
    secret,
    saved,
    ctx(over = {}) {
      const base = runContext(fake.platform.http, secret, fake.clock.now);
      return {
        ...base,
        hookUrl: HOOK_URL,
        inbox: { ...base.inbox, language: o.language ?? "en" },
        extra: { userId: String(user.id) },
        async saveSecret(next) {
          saved.push({ ...next });
        },
        ...over,
      };
    },
  };
}

function connectContext(c: Connection, o: Partial<ConnectContext> = {}): ConnectContext {
  const base = runContext(c.fake.platform.http, {}, c.fake.clock.now);
  return { http: base.http, now: base.now, inbox: base.inbox, hookUrl: HOOK_URL, hooksLive: true, ...o };
}

function stayOf(
  apartmentId: number,
  checkIn: string,
  checkOut: string,
  o: { key?: string; currency?: string; value?: number; adults?: number; children?: number[]; guest?: boolean } = {},
): OutboundStay {
  const key = o.key ?? `sd-01J${apartmentId}${checkIn.replace(/-/g, "")}`;
  return {
    itemId: `item-${key}`,
    reference: "HR4K2Q",
    key,
    propertyId: String(apartmentId),
    checkIn,
    checkOut,
    rooms: [
      {
        roomId: String(apartmentId),
        rateId: SMOOBU_RATE,
        adults: o.adults ?? 2,
        childrenAges: o.children ?? [],
        price: { value: o.value ?? 1_300_100, currency: o.currency ?? "INR" },
      },
    ],
    ...(o.guest
      ? {
          guest: { name: "Aarav Mehta Shah", email: "aarav@guest.example", phone: "+910000000000" },
          notes: "Arriving by the evening train.",
        }
      : {}),
  };
}

const writer = (c: Connection) => {
  const w = c.def.stayWriter;
  if (!w) throw new Error("no writer");
  return w;
};

const rowsOf = (read: Awaited<ReturnType<NonNullable<ReturnType<typeof smoobuConnector>["stays"]>["ari"]>>) =>
  Array.isArray(read) ? read : read.rows;

/* --- the contract, in three places ------------------------------------------------- */

const contract = (apartments: readonly FakeApartment[], user: User, currency: string, n: number) => () => {
  const c = connection(apartments, user, { n });
  const first = apartments[0];
  if (!first) throw new Error("no apartment");
  return {
    definition: c.def as never,
    http: c.fake.platform.http,
    secret: c.secret,
    propertyId: String(first.id),
    oneUnitRoom: String(first.id),
    rate: SMOOBU_RATE,
    currency,
    moves: false,
    exhaust: () => {
      c.fake.mode.limit = 0;
    },
  };
};

propertyContract("Smoobu, Haveli Rang in Jaipur (INR)", contract(HAVELI_RANG, HAVELI_USER, "INR", 11));
propertyContract("Smoobu, Kijiwe Lodge near Arusha (TZS)", contract(KIJIWE_LODGE, KIJIWE_USER, "TZS", 12));
propertyContract("Smoobu, Gîte du Cap-Blanc in Québec City (CAD)", contract(CAP_BLANC, CAPBLANC_USER, "CAD", 13));

/* --- connecting -------------------------------------------------------------------- */

describe("Smoobu: connecting with the owner's own HMAC key, behind one switch", () => {
  it("is registered as a property system, ready, in the lodging group, guarded as check-then-write with no hold", () => {
    const def = builtInConnectors().find((d) => d.kind === "smoobu");
    expect(def).toBeDefined();
    expect(isPropertySystem(def)).toBe(true);
    expect(def?.group).toBe("lodging");
    expect(def?.capabilities).toEqual(["stay_inventory", "write_stays", "stay_events"]);
    expect(def?.ready?.()).toBe(true);
    expect(def?.stayWriter?.oversold).toBeDefined();
    expect(SMOOBU_GUARDS).toEqual({ writeGuard: "check_then_write", hold: "none" });
    const fields = describeForm(def?.form as never);
    expect(fields.map((f) => [f.key, f.secret, f.required])).toEqual([
      ["api_key", true, true],
      ["api_secret", true, true],
    ]);
    expect(fields[0]?.steps?.[0]).toContain("Settings → Advanced → API Keys");
  });

  it("shows as ready in the gallery with its form, and as Needs setup with nothing to press when the switch is off", () => {
    const card = (on: boolean) =>
      gallery(new Map([["smoobu", smoobuConnector({ ready: on })]]), { lean: "stays" })
        .flatMap((c) => c.ways)
        .find((w) => w.kind === "smoobu");
    const on = card(true);
    expect(on?.status).toBe("ready");
    expect(on?.form.map((f) => f.key)).toEqual(["api_key", "api_secret"]);
    const off = card(false);
    expect(off?.status).toBe("setup");
    expect(off?.form).toEqual([]);
    expect(off?.hint).toMatch(/Smoobu/);
    expect(off?.href).toBe(SMOOBU_DOCS);
  });

  it("refuses to connect while switched off, and calls nothing", async () => {
    const c = connection(HAVELI_RANG);
    const off = smoobuConnector({ ready: false, clock: () => c.fake.clock.now });
    expect(typeof off.ready?.()).toBe("string");
    await expect(
      off.connect?.(connectContext(c), { api_key: c.secret.api_key ?? "", api_secret: c.secret.api_secret ?? "" }),
    ).rejects.toMatchObject({
      code: "config",
    });
    expect(c.fake.platform.seen).toEqual([]);
  });

  it("checks the key with Smoobu, seals it with a second secret for the webhook, and registers its own address", async () => {
    const c = connection(HAVELI_RANG);
    const connected = await c.def.connect?.(connectContext(c), {
      api_key: ` ${c.secret.api_key} `,
      api_secret: c.secret.api_secret ?? "",
    });
    if (!connected) throw new Error("not connected");
    expect(connected.account).toBe(HAVELI_USER.email);
    expect(connected.externalId).toBe(String(HAVELI_USER.id));
    expect(Object.keys(connected.secret).sort()).toEqual(["api_key", "api_secret", "hook_key"]);
    expect(connected.secret.api_key).toBe(c.secret.api_key);
    expect(connected.secret.hook_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(connected.extra).toMatchObject({ userId: String(HAVELI_USER.id), webhookId: "901", hookUrl: HOOK_URL });
    // Nothing secret is kept where it is not sealed.
    expect(JSON.stringify(connected.extra)).not.toContain(connected.secret.hook_key);
    expect([...c.fake.webhooks.values()].map((w) => w.webhookUrl)).toEqual([
      smoobuWebhookUrl(HOOK_URL, connected.secret.hook_key ?? ""),
    ]);
    expect(c.fake.platform.seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "GET /api/me",
      "GET /api/apartments",
      "POST /api/users/webhooks",
    ]);
  });

  it("says on the secret's own field that Smoobu did not take the key, and keeps nothing", async () => {
    const c = connection(HAVELI_RANG);
    const error = await c.def
      .connect?.(connectContext(c), {
        api_key: c.secret.api_key ?? "",
        api_secret: "fake-secret-wrong-0123456789abcdef",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: "auth", field: "api_secret" });
    expect(c.fake.webhooks.size).toBe(0);
    expect(c.fake.refusals).toEqual(["invalid signature"]);
  });

  it("refuses a key typed with spaces inside before asking Smoobu anything", async () => {
    const c = connection(HAVELI_RANG);
    await expect(
      c.def.connect?.(connectContext(c), { api_key: "usr live 123", api_secret: c.secret.api_secret ?? "" }),
    ).rejects.toMatchObject({
      code: "config",
      field: "api_key",
    });
    expect(c.fake.platform.seen).toEqual([]);
  });

  it("makes no webhook while the inbox cannot be reached, and makes it on a later refresh", async () => {
    const c = connection(HAVELI_RANG);
    const connected = await c.def.connect?.(connectContext(c, { hooksLive: false }), {
      api_key: c.secret.api_key ?? "",
      api_secret: c.secret.api_secret ?? "",
    });
    expect(connected?.extra).toMatchObject({ webhookId: null, webhookFailed: true });
    expect(c.fake.webhooks.size).toBe(0);
    const later = c.ctx({ extra: connected?.extra ?? {}, now: c.fake.clock.now + 7 * 3_600_000 });
    expect(c.def.stale?.(later)).toBe(true);
    const refreshed = await c.def.refresh?.(later);
    expect(refreshed?.extra).toMatchObject({ webhookFailed: false, hookUrl: HOOK_URL });
    expect([...c.fake.webhooks.values()].map((w) => w.webhookUrl)).toEqual([
      smoobuWebhookUrl(HOOK_URL, c.secret.hook_key ?? ""),
    ]);
  });

  it("moves its webhook to a new address in place, and finds one registered already by its address", async () => {
    const c = connection(HAVELI_RANG);
    const first = await c.def.refresh?.(c.ctx({ extra: { userId: String(HAVELI_USER.id) } }));
    const id = first?.extra?.webhookId;
    const moved = "https://haveli-rang.example/v1/hooks/smoobu/TW92ZWQtdG8tdGhlLWJ1c2luZXNzLW93bi1kb21haW4wMDA";
    const ctx = c.ctx({ extra: first?.extra ?? {}, hookUrl: moved });
    expect(c.def.stale?.(ctx)).toBe(true);
    const after = await c.def.refresh?.(ctx);
    expect(after?.extra).toMatchObject({ webhookId: id, hookUrl: moved, webhookFailed: false });
    expect([...c.fake.webhooks.values()].map((w) => w.webhookUrl)).toEqual([
      smoobuWebhookUrl(moved, c.secret.hook_key ?? ""),
    ]);
    // Lost track of its id: registering again answers 422, and the one there is found by its address.
    const again = await c.def.refresh?.(c.ctx({ extra: { userId: String(HAVELI_USER.id) }, hookUrl: moved }));
    expect(again?.extra).toMatchObject({ webhookId: id, webhookFailed: false });
    expect(c.fake.webhooks.size).toBe(1);
  });

  it("takes away a webhook Smoobu kept without its second secret, and one another caller holds is left alone", async () => {
    const c = connection(HAVELI_RANG);
    c.fake.mode.dropQuery = true;
    const dropped = await c.def.refresh?.(c.ctx());
    expect(dropped?.extra).toMatchObject({ webhookId: null, webhookFailed: true });
    expect(c.fake.webhooks.size).toBe(0);
    c.fake.mode.dropQuery = false;
    c.fake.mode.register = "conflict";
    const conflict = await c.def.refresh?.(c.ctx());
    expect(conflict?.extra).toMatchObject({ webhookFailed: true });
    expect(c.fake.webhooks.size).toBe(0);
  });

  it("takes back the webhook of a connection that was refused, the old one of one made again, and its own when disconnected", async () => {
    const c = connection(HAVELI_RANG);
    const one = await c.def.connect?.(connectContext(c), {
      api_key: c.secret.api_key ?? "",
      api_secret: c.secret.api_secret ?? "",
    });
    await one?.settle?.(true);
    const two = await c.def.connect?.(
      connectContext(c, { previous: { externalId: String(HAVELI_USER.id), extra: one?.extra ?? {} } }),
      {
        api_key: c.secret.api_key ?? "",
        api_secret: c.secret.api_secret ?? "",
      },
    );
    await two?.settle?.(true);
    expect([...c.fake.webhooks.keys()]).toEqual([Number(two?.extra?.webhookId)]);
    const three = await c.def.connect?.(connectContext(c), {
      api_key: c.secret.api_key ?? "",
      api_secret: c.secret.api_secret ?? "",
    });
    await three?.settle?.(false);
    expect(c.fake.webhooks.size).toBe(1);
    await c.def.disconnect?.(c.ctx({ extra: two?.extra ?? {} }));
    expect(c.fake.webhooks.size).toBe(0);
  });
});

/* --- the signature ------------------------------------------------------------------- */

describe("Smoobu: every request signed as the documentation's own example signs it", () => {
  it("signs the documented POST example to the documented signature", async () => {
    const p = DOC_EXAMPLE.post;
    expect(await sha256Hex(p.body)).toBe(p.bodyHash);
    expect(
      smoobuCanonical({
        method: p.method,
        path: p.path,
        query: p.query,
        timestamp: DOC_EXAMPLE.timestamp,
        nonce: p.nonce,
        bodyHash: p.bodyHash,
        apiKey: DOC_EXAMPLE.apiKey,
      }),
    ).toBe(`POST\n/api/reservations\n\n${DOC_EXAMPLE.timestamp}\n${p.nonce}\n${p.bodyHash}\n${DOC_EXAMPLE.apiKey}`);
    const headers = await smoobuHeaders({
      apiKey: DOC_EXAMPLE.apiKey,
      apiSecret: DOC_EXAMPLE.apiSecret,
      method: p.method,
      path: p.path,
      query: p.query,
      body: p.body,
      timestamp: DOC_EXAMPLE.timestamp,
      nonce: p.nonce,
    });
    expect(headers).toEqual({
      "X-API-Key": DOC_EXAMPLE.apiKey,
      "X-Timestamp": DOC_EXAMPLE.timestamp,
      "X-Nonce": p.nonce,
      "X-Signature": p.signature,
    });
  });

  it("signs the documented GET example, its query sorted, over the hash of an empty body", async () => {
    const g = DOC_EXAMPLE.get;
    expect(await sha256Hex("")).toBe(g.bodyHash);
    expect(smoobuQuery(g.params)).toBe(g.query);
    const headers = await smoobuHeaders({
      apiKey: DOC_EXAMPLE.apiKey,
      apiSecret: DOC_EXAMPLE.apiSecret,
      method: g.method,
      path: g.path,
      query: smoobuQuery(g.params),
      body: g.body,
      timestamp: DOC_EXAMPLE.timestamp,
      nonce: g.nonce,
    });
    expect(headers["X-Signature"]).toBe(g.signature);
  });

  it("encodes every key and value per RFC 3986 and sorts them: a space is %20, never +, and [] is %5B%5D", () => {
    expect(
      smoobuQuery([
        ["start_date", "2027-01-15"],
        ["apartments[]", "398"],
        ["note", "a b+c!'()*"],
      ]),
    ).toBe("apartments%5B%5D=398&note=a%20b%2Bc%21%27%28%29%2A&start_date=2027-01-15");
    expect(smoobuTimestamp(Date.parse("2026-04-01T12:00:00.987Z"))).toBe("2026-04-01T12:00:00Z");
  });

  it("sends the four headers on every request, a new UUID v4 each time, the query as signed, and never the legacy key", async () => {
    const c = connection(HAVELI_RANG);
    const stays = c.def.stays;
    if (!stays) throw new Error("no stays");
    const ctx = c.ctx();
    await stays.ari(ctx, "52011", { from: "2026-12-01", to: "2026-12-04" });
    const link = await writer(c).put(ctx, stayOf(52011, "2026-12-10", "2026-12-12"), null, "confirmed");
    await writer(c).cancel(ctx, link);
    const seen = c.fake.platform.seen;
    expect(seen.length).toBeGreaterThan(8);
    for (const r of seen) {
      expect(r.headers.get("x-api-key")).toBe(c.secret.api_key);
      expect(r.headers.get("x-timestamp")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(r.headers.get("x-signature")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(r.headers.has("api-key")).toBe(false);
      // What was sent is what was signed: sorted, the same whichever way a server sorts letters.
      const q = r.url.search.slice(1);
      const pairs = q ? q.split("&") : [];
      expect(pairs).toEqual([...pairs].sort());
      expect(pairs).toEqual([...pairs].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    }
    expect(new Set(c.fake.nonces).size).toBe(c.fake.nonces.length);
    expect(c.fake.refusals).toEqual([]);
  });

  it("signs again once on Smoobu's time when our clock is out, with a new nonce, and keeps the correction for the run", async () => {
    const c = connection(HAVELI_RANG, HAVELI_USER, { offsetMs: -7 * 60_000 });
    const stays = c.def.stays;
    if (!stays) throw new Error("no stays");
    const ctx = c.ctx();
    expect((await stays.properties(ctx)).map((p) => p.id)).toEqual(["52011"]);
    expect(c.fake.refusals).toEqual(["expired timestamp"]);
    const [first, second] = c.fake.platform.seen;
    expect(first?.url.pathname).toBe(second?.url.pathname);
    expect(first?.headers.get("x-nonce")).not.toBe(second?.headers.get("x-nonce"));
    expect(second?.headers.get("x-timestamp")).toBe(smoobuTimestamp(c.fake.clock.now));
    await stays.rooms(ctx, "52011");
    expect(c.fake.refusals).toEqual(["expired timestamp"]);
  });

  it("says the key no longer works on a 401 that is not the clock, after one request", async () => {
    const c = connection(HAVELI_RANG);
    const stays = c.def.stays;
    if (!stays) throw new Error("no stays");
    const error = await stays
      .properties(c.ctx({ secret: { ...c.secret, api_secret: "fake-secret-revoked-0123456789" } }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "auth", field: "api_secret" });
    expect(c.fake.platform.seen).toHaveLength(1);
  });

  it("is refused by Smoobu when a nonce is used twice, as the documentation says it is", async () => {
    const c = connection(HAVELI_RANG, HAVELI_USER, { nonce: () => "0d9b8f2e-6a4c-4b1d-9e7f-3c2a1b0d9e8f" });
    const stays = c.def.stays;
    if (!stays) throw new Error("no stays");
    await expect(stays.properties(c.ctx())).rejects.toMatchObject({ code: "auth" });
    expect(c.fake.refusals).toContain("replayed nonce");
    // The fake's own record of it, made on purpose here.
    expect(c.fake.violations.splice(0)).toEqual(["nonce used twice: 0d9b8f2e-6a4c-4b1d-9e7f-3c2a1b0d9e8f"]);
  });
});

/* --- reading -------------------------------------------------------------------------- */

describe("Smoobu: apartments as rooms of one, nights as its rates have them, money in its own unit", () => {
  it("makes one property per currency, zone and town, under its first apartment, and leaves out one with no currency", async () => {
    const c = connection(TWO_TOWNS, MIXED_USER);
    const props = await c.def.stays?.properties(c.ctx());
    expect(props).toEqual([
      { id: "80003", name: "Arusha · 2 apartments", currency: "TZS", timezone: "Africa/Dar_es_Salaam" },
      { id: "80030", name: "Kilimanjaro View", currency: "TZS" },
      { id: "80010", name: "Moshi Loft", currency: "TZS", timezone: "Africa/Dar_es_Salaam" },
    ]);
    expect((await c.def.stays?.rooms(c.ctx(), "80003"))?.map((r) => r.id)).toEqual(["80003", "80004"]);
    await expect(c.def.stays?.rooms(c.ctx(), "80020")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reads each apartment as one unit, sleeping who it sleeps, with its beds", async () => {
    const c = connection(HAVELI_RANG);
    const rooms = await c.def.stays?.rooms(c.ctx(), "52011");
    expect(rooms).toEqual([
      {
        id: "52011",
        name: "Jharokha Room",
        units: 1,
        capacity: { adults: 2, children: 1, total: 2 },
        beds: [{ type: "double", count: 1 }],
      },
      {
        id: "52012",
        name: "Zenana Suite",
        units: 1,
        capacity: { adults: 3, children: 2, total: 3 },
        beds: [
          { type: "single", count: 1 },
          { type: "king", count: 1 },
        ],
      },
      {
        id: "52013",
        name: "Courtyard Twin",
        units: 1,
        capacity: { adults: 2, children: 1, total: 2 },
        beds: [{ type: "single", count: 2 }],
      },
    ]);
    expect(await c.def.stays?.ratePlans(c.ctx(), "52011")).toEqual([
      { id: SMOOBU_RATE, name: "Smoobu's nightly price" },
    ]);
  });

  it("reads each night: free, taken by another channel, its minimum stay, its price in paise", async () => {
    const c = connection(HAVELI_RANG);
    c.fake.otaBooking(52013, "2026-12-02", "2026-12-03");
    c.fake.nightPrice.set("52011|2026-12-03", null);
    c.fake.nightPrice.set("52013|2026-12-01", 5200.555);
    const rows = rowsOf((await c.def.stays?.ari(c.ctx(), "52011", { from: "2026-12-01", to: "2026-12-04" })) ?? []);
    const at = (room: number, night: string) => rows.find((r) => r.roomId === String(room) && r.night === night);
    expect(at(52011, "2026-12-01")).toEqual({
      roomId: "52011",
      night: "2026-12-01",
      units: 1,
      prices: { nightly: 650_050 },
    });
    expect(at(52011, "2026-12-03")).toEqual({ roomId: "52011", night: "2026-12-03", units: 1 });
    expect(at(52012, "2026-12-01")).toMatchObject({ units: 1, minStay: 2, prices: { nightly: 1_180_000 } });
    expect(at(52013, "2026-12-02")).toMatchObject({ units: 0 });
    // A price with a part below the paisa is no price at all.
    expect(at(52013, "2026-12-01")?.prices).toBeUndefined();
    expect(rows.filter((r) => r.night === "2026-12-04")).toEqual([]);
    // The last night asked for is the last wanted: end_date is answered too.
    const asked = c.fake.platform.requests("GET", "https://login.smoobu.com/api/rates")[0];
    expect(asked?.url.searchParams.get("end_date")).toBe("2026-12-03");
  });

  it("counts shillings and Canadian cents, and sells an apartment Smoobu counts more than once as one", async () => {
    const lodge = connection(KIJIWE_LODGE, KIJIWE_USER);
    const tz = rowsOf(
      (await lodge.def.stays?.ari(lodge.ctx(), "61001", { from: "2027-01-05", to: "2027-01-06" })) ?? [],
    );
    expect(tz.map((r) => [r.roomId, r.prices?.nightly])).toEqual([
      ["61001", 18_500_000],
      ["61002", 42_000_000],
    ]);
    const gite = connection([{ ...(CAP_BLANC[1] as FakeApartment), available: 3 }], CAPBLANC_USER, { n: 2 });
    const ca = rowsOf((await gite.def.stays?.ari(gite.ctx(), "70502", { from: "2027-01-05", to: "2027-01-06" })) ?? []);
    expect(ca).toEqual([{ roomId: "70502", night: "2027-01-05", units: 1, prices: { nightly: 21_450 } }]);
    expect(smoobuMinor(214.5, "CAD")).toBe(21_450);
    expect(smoobuMinor(185000, "TZS")).toBe(18_500_000);
    expect(smoobuMinor(-1, "CAD")).toBeNull();
  });

  it("counts a grouped apartment's booking on the apartments it blocks", async () => {
    const grouped = [{ ...(KIJIWE_LODGE[1] as FakeApartment), group: [61001] }, KIJIWE_LODGE[0] as FakeApartment];
    const c = connection(grouped, KIJIWE_USER);
    c.fake.otaBooking(61002, "2027-02-01", "2027-02-03");
    const rows = rowsOf((await c.def.stays?.ari(c.ctx(), "61001", { from: "2027-02-01", to: "2027-02-02" })) ?? []);
    expect(rows.map((r) => [r.roomId, r.units])).toEqual([
      ["61002", 0],
      ["61001", 0],
    ]);
  });

  it("reads a long window in pieces of 92 nights, one apartment at a time, and says how far it got when asked to wait", async () => {
    const c = connection(KIJIWE_LODGE, KIJIWE_USER);
    const full = rowsOf((await c.def.stays?.ari(c.ctx(), "61001", { from: "2027-03-01", to: "2027-09-17" })) ?? []);
    expect(full).toHaveLength(2 * 200);
    const rates = c.fake.platform.requests("GET", "https://login.smoobu.com/api/rates");
    expect(rates.map((r) => r.url.searchParams.getAll("apartments[]"))).toEqual([
      ["61001"],
      ["61002"],
      ["61001"],
      ["61002"],
      ["61001"],
      ["61002"],
    ]);
    expect(rates.map((r) => r.url.searchParams.get("start_date"))).toEqual([
      "2027-03-01",
      "2027-03-01",
      "2027-06-01",
      "2027-06-01",
      "2027-09-01",
      "2027-09-01",
    ]);
    const cut = connection(KIJIWE_LODGE, KIJIWE_USER, { n: 3 });
    // One list, two apartments, then a piece and a half before the window is spent.
    cut.fake.mode.limit = 6;
    const partial = await cut.def.stays?.ari(cut.ctx(), "61001", { from: "2027-03-01", to: "2027-09-17" });
    expect(Array.isArray(partial)).toBe(false);
    expect(partial).toMatchObject({ until: "2027-06-01" });
    expect(rowsOf(partial ?? [])).toHaveLength(2 * 92);
  });

  it("gives a stay's own nightly prices, and none when a night has no price", async () => {
    const c = connection(HAVELI_RANG);
    const q = {
      propertyId: "52011",
      roomId: "52011",
      checkIn: "2026-12-01",
      checkOut: "2026-12-03",
      adults: 2,
      childrenAges: [],
    };
    expect(await c.def.stays?.price?.(c.ctx(), q)).toEqual({
      subtotal: { value: 1_300_100, currency: "INR" },
      nights: [
        { night: "2026-12-01", amount: 650_050 },
        { night: "2026-12-02", amount: 650_050 },
      ],
    });
    c.fake.nightPrice.set("52011|2026-12-02", null);
    expect(await c.def.stays?.price?.(c.ctx(), q)).toBeNull();
  });
});

/* --- writing ---------------------------------------------------------------------------- */

describe("Smoobu: stays checked live first, written, read back after, taken back on a conflict", () => {
  it("writes the documented fields, our key in the notice in the owner's language, the guest only once confirmed", async () => {
    const c = connection(CAP_BLANC, CAPBLANC_USER, { language: "fr-CA" });
    const ctx = c.ctx();
    const stay = stayOf(70501, "2027-01-15", "2027-01-17", {
      currency: "CAD",
      value: 37_800,
      adults: 1,
      children: [7],
    });
    const link = await writer(c).put(ctx, stay, null, "provisional");
    const [create] = c.fake.writes;
    expect(create?.body).toEqual({
      arrivalDate: "2027-01-15",
      departureDate: "2027-01-17",
      apartmentId: 70501,
      adults: 1,
      children: 1,
      price: 378,
      notice: `Réservation directe, acompte dû · ref HR4K2Q [${stay.key}]`,
    });
    const confirmed = {
      ...stay,
      guest: { name: "Aarav Mehta Shah", email: "aarav@guest.example" },
      notes: "Arrivée tardive.",
    };
    await writer(c).put(ctx, confirmed, link, "confirmed");
    const update = c.fake.writes[1];
    expect(update?.method).toBe("PUT");
    expect(update?.body).toEqual({
      adults: 1,
      children: 1,
      price: 378,
      notice: `Réservation directe · ref HR4K2Q [${stay.key}]\nArrivée tardive.`,
      guestName: "Aarav Mehta Shah",
      guestEmail: "aarav@guest.example",
    });
  });

  it("writes its notice in each of the six languages, holding none of the words a guest never reads", async () => {
    for (const [i, lang] of ["en", "es", "fr", "de", "it", "pt"].entries()) {
      const c = connection(KIJIWE_LODGE, KIJIWE_USER, { n: 40 + i, language: lang });
      const stay = stayOf(61001, "2027-01-10", "2027-01-12", { currency: "TZS", value: 37_000_000 });
      await writer(c).put(c.ctx(), stay, null, "provisional");
      const notice = String(c.fake.writes[0]?.body.notice ?? "");
      expect(notice).toContain(`ref HR4K2Q [${stay.key}]`);
      // Smoobu may show a booking's notes to its guest: in the business's words, never the software's.
      expect(customerWordsIn(notice.replace(/\[sd-[^\]]+\]/, ""), lang)).toEqual([]);
    }
  });

  it("asks Smoobu live whether the nights are free just before every create, for its own user", async () => {
    const c = connection(HAVELI_RANG);
    await writer(c).put(c.ctx(), stayOf(52011, "2026-12-10", "2026-12-12", { guest: true }), null, "confirmed");
    const order = c.fake.platform.seen.map((r) => `${r.method} ${r.url.pathname}`);
    const check = order.indexOf("POST /booking/checkApartmentAvailability");
    expect(check).toBeGreaterThan(-1);
    expect(order[check + 1]).toBe("POST /api/reservations");
    const asked = JSON.parse(
      c.fake.platform.requests("POST", "https://login.smoobu.com/booking/checkApartmentAvailability")[0]?.body ?? "{}",
    );
    expect(asked).toEqual({
      arrivalDate: "2026-12-10",
      departureDate: "2026-12-12",
      apartments: [52011],
      customerId: HAVELI_USER.id,
      guests: 2,
    });
    expect(c.fake.writes[0]?.body).toMatchObject({
      firstName: "Aarav Mehta",
      lastName: "Shah",
      email: "aarav@guest.example",
    });
  });

  it("never writes onto a night another channel took, nor a stay Smoobu's own rules refuse, in Smoobu's words", async () => {
    const c = connection(HAVELI_RANG);
    c.fake.otaBooking(52011, "2026-12-11", "2026-12-13");
    await expect(
      writer(c).put(c.ctx(), stayOf(52011, "2026-12-10", "2026-12-12"), null, "confirmed"),
    ).rejects.toMatchObject({
      code: "refused",
      message: "10 Dec 2026 to 12 Dec 2026 isn't free in Smoobu any more.",
    });
    await expect(
      writer(c).put(c.ctx(), stayOf(52012, "2026-12-20", "2026-12-21", { value: 1_180_000 }), null, "confirmed"),
    ).rejects.toMatchObject({
      code: "refused",
      message: "Smoobu said: The duration of the booking is too short.",
    });
    await expect(
      writer(c).put(c.ctx(), stayOf(52013, "2026-12-20", "2026-12-21", { adults: 3 }), null, "confirmed"),
    ).rejects.toMatchObject({
      code: "refused",
      message: "Smoobu said: The number of guests exceeds the limit of the apartment.",
    });
    expect(c.fake.writes).toEqual([]);
  });

  it("refuses a stay in another currency, of several rooms, or as a hold, before anything is written", async () => {
    const c = connection(HAVELI_RANG);
    await expect(
      writer(c).put(
        c.ctx(),
        stayOf(52011, "2026-12-10", "2026-12-12", { currency: "USD", value: 15_600 }),
        null,
        "confirmed",
      ),
    ).rejects.toMatchObject({
      code: "refused",
      message: "Smoobu keeps this apartment's prices in INR, and the stay is in USD.",
    });
    const two = stayOf(52011, "2026-12-10", "2026-12-12");
    const both = {
      ...two,
      rooms: [...two.rooms, { ...(two.rooms[0] as OutboundStay["rooms"][number]), roomId: "52013" }],
    };
    await expect(writer(c).put(c.ctx(), both, null, "confirmed")).rejects.toMatchObject({ code: "refused" });
    await expect(writer(c).put(c.ctx(), two, null, "hold")).rejects.toMatchObject({ code: "refused" });
    expect(c.fake.writes).toEqual([]);
  });

  it("says Smoobu's own refusal when its booking tool needs names a deposit-due stay does not have yet", async () => {
    const c = connection(HAVELI_RANG);
    c.fake.mode.requireNames = true;
    await expect(
      writer(c).put(c.ctx(), stayOf(52011, "2026-12-10", "2026-12-12"), null, "provisional"),
    ).rejects.toMatchObject({
      code: "refused",
      message: "Smoobu said: Value is required and can't be empty",
    });
  });

  it("takes its own write back through write-first when another channel's booking landed between the check and the write", async () => {
    const c = connection(KIJIWE_LODGE, KIJIWE_USER);
    c.fake.mode.protection = "off";
    let ota = 0;
    c.fake.mode.afterCheck = () => {
      ota = c.fake.otaBooking(61001, "2027-02-10", "2027-02-11").id;
    };
    const { db } = await freshDb();
    const now = c.fake.clock.now;
    await db.client.query({
      sql: "INSERT INTO connectors (id, kind, name, config_enc, status, created_at, updated_at) VALUES ('conn1', 'smoobu', 'Smoobu', '', 'active', ?, ?)",
      params: [now, now],
      method: "run",
    });
    const ctx = c.ctx();
    const w = writer(c);
    const stay = stayOf(61001, "2027-02-09", "2027-02-11", { currency: "TZS", value: 37_000_000 });
    const result = await writeFirst(db, {
      connectorId: "conn1",
      itemId: "stay-kijiwe-1",
      op: "reserve",
      owner: "stays",
      key: stay.key,
      request: { key: stay.key },
      now,
      async write() {
        const written = await w.put(ctx, stay, null, "provisional");
        return { externalId: written.externalId ?? "" };
      },
      async find() {
        const found = await w.find(ctx, stay);
        return found?.externalId ? { externalId: found.externalId } : null;
      },
      async readBack(ref) {
        return (await w.oversold?.(ctx, stay, { externalId: ref.externalId, etag: null, calendar: null }))
          ? "conflict"
          : "ok";
      },
      async rollback(ref) {
        await w.cancel(ctx, { externalId: ref.externalId, etag: null, calendar: null });
      },
    });
    expect(result.status).toBe("conflict");
    const ours = [...c.fake.reservations.values()].find((r) => r.notice.includes(stay.key));
    expect(ours?.type).toBe("cancellation");
    // The other channel's guest keeps the night; ours is gone from it, kept as cancelled.
    expect(c.fake.reservations.get(ota)?.type).toBe("reservation");
    expect(c.fake.free(61001, "2027-02-10")).toBe(0);
    expect(c.fake.free(61001, "2027-02-09")).toBe(1);
  });

  it("reads back a write alone on its nights as sound, and counts blocked periods and grouped apartments against it", async () => {
    const c = connection(KIJIWE_LODGE, KIJIWE_USER);
    const ctx = c.ctx();
    const stay = stayOf(61001, "2027-03-01", "2027-03-03", { currency: "TZS", value: 37_000_000 });
    const link = await writer(c).put(ctx, stay, null, "confirmed");
    expect(await writer(c).oversold?.(ctx, stay, link)).toBe(false);
    // A person closed a night in Smoobu since: a blocked period holds it as a booking does.
    const blocked = c.fake.otaBooking(61001, "2027-03-02", "2027-03-04", {
      channel: { id: 11, name: "Blocked channel" },
      blocked: true,
    });
    expect(await writer(c).oversold?.(ctx, stay, link)).toBe(true);
    c.fake.reservations.delete(blocked.id);
    // A grouped apartment's booking blocks this one too.
    c.fake.apartments[1] = { ...(c.fake.apartments[1] as FakeApartment), group: [61001] };
    c.fake.otaBooking(61002, "2027-03-02", "2027-03-03");
    expect(await writer(c).oversold?.(ctx, stay, link)).toBe(true);
  });

  it("cannot tell before Smoobu's bookings show the write, and never takes one cancelled already as sound", async () => {
    const c = connection(KIJIWE_LODGE, KIJIWE_USER);
    const ctx = c.ctx();
    const stay = stayOf(61001, "2027-03-10", "2027-03-12", { currency: "TZS", value: 37_000_000 });
    const link = await writer(c).put(ctx, stay, null, "confirmed");
    c.fake.hidden.add(Number(link.externalId));
    await expect(writer(c).oversold?.(ctx, stay, link)).rejects.toMatchObject({ code: "bad_response" });
    c.fake.hidden.clear();
    const r = c.fake.reservations.get(Number(link.externalId));
    if (r) r.type = "cancellation";
    expect(await writer(c).oversold?.(ctx, stay, link)).toBe(true);
  });

  it("finds a write whose answer never came by its key, through write-first, and never writes it twice", async () => {
    const c = connection(HAVELI_RANG);
    c.fake.mode.write = "lands_then_times_out";
    const { db } = await freshDb();
    const now = c.fake.clock.now;
    await db.client.query({
      sql: "INSERT INTO connectors (id, kind, name, config_enc, status, created_at, updated_at) VALUES ('conn1', 'smoobu', 'Smoobu', '', 'active', ?, ?)",
      params: [now, now],
      method: "run",
    });
    const ctx = c.ctx();
    const w = writer(c);
    const stay = stayOf(52011, "2027-01-05", "2027-01-07");
    const result = await writeFirst(db, {
      connectorId: "conn1",
      itemId: "stay-haveli-1",
      op: "reserve",
      owner: "stays",
      key: stay.key,
      request: { key: stay.key },
      now,
      async write() {
        const written = await w.put(ctx, stay, null, "confirmed");
        return { externalId: written.externalId ?? "" };
      },
      async find() {
        const found = await w.find(ctx, stay);
        return found?.externalId ? { externalId: found.externalId } : null;
      },
    });
    expect(result.status).toBe("written");
    c.fake.mode.write = "ok";
    const again = await w.put(ctx, stay, null, "confirmed");
    expect(result.status === "written" ? result.ref.externalId : null).toBe(again.externalId);
    expect([...c.fake.reservations.values()].filter((r) => r.notice.includes(stay.key))).toHaveLength(1);
  });

  it("updates a stay on its own nights, leaves a notice the owner rewrote as it is, and never sends dates", async () => {
    const c = connection(HAVELI_RANG);
    const ctx = c.ctx();
    const stay = stayOf(52012, "2027-01-20", "2027-01-23", { value: 3_540_000 });
    const link = await writer(c).put(ctx, stay, null, "confirmed");
    const r = c.fake.reservations.get(Number(link.externalId));
    if (r) r.notice = "Late check-in agreed by phone.";
    await writer(c).put(
      ctx,
      { ...stay, rooms: [{ ...(stay.rooms[0] as OutboundStay["rooms"][number]), adults: 3 }] },
      link,
      "confirmed",
    );
    expect(c.fake.writes.at(-1)?.body).toEqual({ adults: 3, children: 0, price: 35_400 });
    expect(r?.notice).toBe("Late check-in agreed by phone.");
    expect(r?.adults).toBe(3);
  });

  it("refuses to move a stay to other nights or another apartment, and changes nothing there", async () => {
    const c = connection(HAVELI_RANG);
    const ctx = c.ctx();
    const stay = stayOf(52011, "2027-02-01", "2027-02-03");
    const link = await writer(c).put(ctx, stay, null, "confirmed");
    const writes = c.fake.writes.length;
    await expect(writer(c).put(ctx, { ...stay, checkOut: "2027-02-04" }, link, "confirmed")).rejects.toMatchObject({
      code: "refused",
      message:
        "Smoobu does not let another system move a booking to other nights or another apartment: change it in Smoobu.",
    });
    const elsewhere = { ...stay, rooms: [{ ...(stay.rooms[0] as OutboundStay["rooms"][number]), roomId: "52013" }] };
    await expect(writer(c).put(ctx, elsewhere, link, "confirmed")).rejects.toMatchObject({ code: "refused" });
    expect(c.fake.writes).toHaveLength(writes);
    expect(c.fake.reservations.get(Number(link.externalId))).toMatchObject({
      arrival: "2027-02-01",
      departure: "2027-02-03",
    });
  });

  it("never brings back a stay cancelled in Smoobu, by an update or by writing it again", async () => {
    const c = connection(HAVELI_RANG);
    const ctx = c.ctx();
    const stay = stayOf(52011, "2027-02-10", "2027-02-12");
    const link = await writer(c).put(ctx, stay, null, "provisional");
    const r = c.fake.reservations.get(Number(link.externalId));
    if (r) r.type = "cancellation";
    await expect(writer(c).put(ctx, stay, link, "confirmed")).rejects.toMatchObject({
      message: "It was cancelled in Smoobu.",
    });
    await expect(writer(c).put(ctx, stay, null, "confirmed")).rejects.toMatchObject({
      message: "It was cancelled in Smoobu.",
    });
    expect(c.fake.reservations.size).toBe(1);
  });

  it("cancels with Smoobu's cancellation, which keeps the booking as cancelled, once, and takes a booking gone as done", async () => {
    const c = connection(HAVELI_RANG);
    const ctx = c.ctx();
    const stay = stayOf(52011, "2027-02-20", "2027-02-22");
    const link = await writer(c).put(ctx, stay, null, "confirmed");
    await writer(c).cancel(ctx, link);
    await writer(c).cancel(ctx, link);
    expect(c.fake.platform.requests("DELETE", "https://login.smoobu.com/api/reservations")).toHaveLength(1);
    expect(c.fake.reservations.get(Number(link.externalId))?.type).toBe("cancellation");
    expect((await writer(c).find(ctx, stay))?.externalId).toBe(link.externalId);
    await writer(c).cancel(ctx, { externalId: "777777", etag: null, calendar: null });
    expect(c.fake.platform.requests("DELETE", "https://login.smoobu.com/api/reservations")).toHaveLength(1);
    const other = await writer(c).put(ctx, stayOf(52013, "2027-02-20", "2027-02-22"), null, "confirmed");
    c.fake.mode.cancel = "refuse";
    await expect(writer(c).cancel(ctx, other)).rejects.toMatchObject({
      code: "refused",
      message: "Smoobu said: Bookings from this channel are cancelled on the channel.",
    });
  });
});

/* --- limits ------------------------------------------------------------------------------- */

describe("Smoobu: X-RateLimit-Retry-After is the window's end as a Unix time, not a delay", () => {
  const at = Date.parse("2026-11-02T09:00:20Z");
  const h = (o: Record<string, string>) => new Headers(o);

  it("reads the time against the answer's own Date, in seconds or milliseconds", () => {
    const end = Date.parse("2026-11-02T09:01:00Z");
    expect(
      smoobuRetryAfterMs(h({ "x-ratelimit-retry-after": String(end / 1000), date: new Date(at).toUTCString() }), 0),
    ).toBe(40_000);
    expect(smoobuRetryAfterMs(h({ "x-ratelimit-retry-after": String(end) }), at)).toBe(40_000);
    // Our clock five minutes off: the answer's Date is what counts.
    expect(
      smoobuRetryAfterMs(
        h({ "x-ratelimit-retry-after": String(end / 1000), date: new Date(at).toUTCString() }),
        at + 300_000,
      ),
    ).toBe(40_000);
  });

  it("never reads a Unix time as a delay of decades, nor a time long past as no wait at all", () => {
    expect(smoobuRetryAfterMs(h({ "x-ratelimit-retry-after": "30" }), at)).toBe(30_000);
    expect(smoobuRetryAfterMs(h({}), at)).toBe(60_000);
    expect(smoobuRetryAfterMs(h({ "x-ratelimit-retry-after": "1700000000" }), at)).toBe(1_000);
    expect(smoobuRetryAfterMs(h({ "x-ratelimit-retry-after": String(at / 1000 + 86_400) }), at)).toBe(3_600_000);
    expect(smoobuRetryAfterMs(h({ "x-ratelimit-retry-after": "soon" }), at)).toBe(60_000);
  });

  it("reads what the minute has left from every answer, and nothing from one without the headers", () => {
    const end = Date.parse("2026-11-02T09:01:00Z");
    expect(
      smoobuBudget(
        h({
          "X-RateLimit-Limit": "700",
          "X-RateLimit-Remaining": "512",
          "X-RateLimit-Retry-After": String(end / 1000),
        }),
        at,
      ),
    ).toEqual({ limit: 700, remaining: 512, resetsInMs: 40_000 });
    expect(smoobuBudget(h({}), at)).toBeNull();
    expect(smoobuBudget(h({ "X-RateLimit-Remaining": "-3" }), at)).toBeNull();
  });

  it("asks the inbox to wait until the window ends, and counts down what is left as it goes", async () => {
    const c = connection(HAVELI_RANG);
    const stays = c.def.stays;
    if (!stays) throw new Error("no stays");
    const seen: number[] = [];
    const counted = {
      async request(r: Parameters<typeof c.fake.platform.http.request>[0]) {
        const res = await c.fake.platform.http.request(r);
        const b = stays.credits?.(res);
        if (b) seen.push(b.remaining);
        return res;
      },
    };
    await stays.properties(c.ctx({ http: counted }));
    expect(seen).toEqual([699, 698, 697, 696]);
    c.fake.mode.limit = 4;
    const waited = await stays.rooms(c.ctx(), "52011").catch((e: unknown) => e);
    expect(waited).toMatchObject({ code: "rate_limited", retryAfterMs: 60_000 });
  });
});

/* --- webhooks -------------------------------------------------------------------------------- */

describe("Smoobu: one address for every event, a second secret in constant time, the body only a hint", () => {
  function hooked(apartments: readonly FakeApartment[] = KIJIWE_LODGE, user: User = KIJIWE_USER) {
    const c = connection(apartments, user);
    c.fake.webhooks.set(901, {
      id: 901,
      webhookUrl: smoobuWebhookUrl(HOOK_URL, c.secret.hook_key ?? ""),
      createdAt: "2026-11-01T08:00:00Z",
    });
    const hooks = c.def.hooks;
    if (!hooks) throw new Error("no hooks");
    const deliver = (body: string): InboundRequest => {
      const [d] = c.fake.deliveries(body);
      if (!d) throw new Error("no delivery");
      return { headers: d.headers, body: d.body, query: d.query };
    };
    return { c, hooks, deliver };
  }

  const reservationData = (id: number, apartmentId: number, arrival: string, departure: string) => ({
    id,
    "reference-id": "KRZUZ2XY",
    type: "reservation",
    arrival,
    departure,
    apartment: { id: apartmentId, name: "Banda Moja" },
    channel: { id: 14, name: "Booking.com" },
    "guest-name": "Wanjiru Kamau",
    firstname: "Wanjiru",
    lastname: "Kamau",
    email: "wanjiru@guest.example",
    "commission-included": 22.0,
  });

  it("takes a delivery to the address with its second secret, and refuses one without it or with another", async () => {
    const { c, hooks, deliver } = hooked();
    const body = deliveryBody(
      "newReservation",
      KIJIWE_USER.id,
      reservationData(292, 61001, "2027-04-01", "2027-04-04"),
    );
    const event = await hooks.verify(c.ctx(), deliver(body));
    expect(event?.topic).toBe("newReservation");
    expect(event?.refs).toEqual(["reservation:292", "nights:61001:2027-04-01:2027-04-04"]);
    const bare = { headers: new Headers(), body, query: new URLSearchParams() };
    await expect(hooks.verify(c.ctx(), bare)).rejects.toMatchObject({ code: "refused" });
    const other = { ...bare, query: new URLSearchParams({ k: newHookKey() }) };
    await expect(hooks.verify(c.ctx(), other)).rejects.toMatchObject({ code: "refused" });
    // A connection with no second secret takes nothing, whatever the address says.
    await expect(
      hooks.verify(c.ctx({ secret: { ...c.secret, hook_key: "" } }), {
        ...bare,
        query: new URLSearchParams({ k: "" }),
      }),
    ).rejects.toMatchObject({
      code: "refused",
    });
    expect(c.fake.platform.seen).toEqual([]);
  });

  it("answers the events it does not use, another user's, and a body it cannot read, and reads nothing", async () => {
    const { c, hooks, deliver } = hooked();
    for (const body of [
      newMessage(KIJIWE_USER.id, 292),
      onlineCheckIn(KIJIWE_USER.id, 292),
      priceElementCreated(KIJIWE_USER.id, 292),
      deliveryBody("newReservation", 7, reservationData(292, 61001, "2027-04-01", "2027-04-04")),
      deliveryBody("newReservation", KIJIWE_USER.id, { arrival: "2027-04-01" }),
      "not json",
    ]) {
      expect(await hooks.verify(c.ctx(), deliver(body))).toBeNull();
    }
    expect(c.fake.platform.seen).toEqual([]);
  });

  it("names rates changed as nights to read again, and counts a delivery sent twice in ten minutes once", async () => {
    const { c, hooks, deliver } = hooked();
    const body = updateRates(KIJIWE_USER.id, 61002, ["2027-05-03", "2027-05-01", "2027-05-02"], 400000);
    const a = await hooks.verify(c.ctx(), deliver(body));
    expect(a?.refs).toEqual(["nights:61002:2027-05-01:2027-05-04"]);
    const b = await hooks.verify(c.ctx(), deliver(body));
    expect(b?.eventId).toBe(a?.eventId);
    const later = await hooks.verify(c.ctx({ now: c.fake.clock.now + 11 * 60_000 }), deliver(body));
    expect(later?.eventId).not.toBe(a?.eventId);
    expect(await hooks.read(c.ctx(), a as never)).toEqual([
      { kind: "stay_nights", roomIds: ["61002"], from: "2027-05-01", to: "2027-05-04" },
    ]);
    expect(c.fake.platform.seen).toEqual([]);
  });

  it("reads back what a delivery names, believing none of its body, and the body's nights only as nights to read again", async () => {
    const { c, hooks, deliver } = hooked();
    // Smoobu holds the booking on the family banda now; the delivery said the other banda, other nights.
    const r = c.fake.otaBooking(61002, "2027-06-10", "2027-06-13");
    const body = deliveryBody(
      "updateReservation",
      KIJIWE_USER.id,
      reservationData(r.id, 61001, "2027-06-01", "2027-06-02"),
    );
    const event = await hooks.verify(c.ctx(), deliver(body));
    expect(await hooks.read(c.ctx(), event as never)).toEqual([
      { kind: "stay_nights", roomIds: ["61002"], from: "2027-06-10", to: "2027-06-13" },
      { kind: "stay_nights", roomIds: ["61001"], from: "2027-06-01", to: "2027-06-02" },
    ]);
    // Deleted in Smoobu: what the delivery named is read again, nothing else.
    const gone = deliveryBody(
      "deleteReservation",
      KIJIWE_USER.id,
      reservationData(5555, 61001, "2027-07-01", "2027-07-03"),
    );
    const ev = await hooks.verify(c.ctx(), deliver(gone));
    expect(await hooks.read(c.ctx(), ev as never)).toEqual([
      { kind: "stay_nights", roomIds: ["61001"], from: "2027-07-01", to: "2027-07-03" },
    ]);
  });

  it("through the inbox's own intake: a forged address finds nothing, a wrong second secret is answered 400 and nothing is kept", async () => {
    const { c, deliver } = hooked();
    const { db } = await freshDb();
    const now = c.fake.clock.now;
    await db.client.query({
      sql: "INSERT INTO connectors (id, kind, name, config_enc, status, created_at, updated_at) VALUES ('conn1', 'smoobu', 'Smoobu', '', 'active', ?, ?)",
      params: [now, now],
      method: "run",
    });
    const token = newInboundToken();
    const hash = await inboundHash(token);
    const host: HookHost = {
      db,
      payments: {} as never,
      definition: (kind) => (kind === "smoobu" ? c.def : undefined),
      connectionByToken: async (kind, h) => (kind === "smoobu" && h === hash ? { id: "conn1", kind: "smoobu" } : null),
      context: async () => c.ctx(),
      payConnection: async () => null,
      failed: async () => {},
      syncNow: async () => {},
    };
    const intake = new ConnectorHooks(host);
    const body = deliveryBody(
      "cancelReservation",
      KIJIWE_USER.id,
      reservationData(292, 61001, "2027-04-01", "2027-04-04"),
    );
    const good = deliver(body);
    expect((await intake.receive("smoobu", newInboundToken(), good, now)).status).toBe(404);
    const wrong = { ...good, query: new URLSearchParams({ k: newHookKey() }) };
    expect(await intake.receive("smoobu", token, wrong, now)).toMatchObject({ status: 400 });
    const kept = async () =>
      (await db.client.query({ sql: "SELECT external_id, topic, raw FROM connector_events", method: "all" })).rows;
    expect(await kept()).toEqual([]);
    expect(await intake.receive("smoobu", token, good, now)).toMatchObject({
      status: 200,
      body: { ok: true, duplicate: false },
    });
    expect(await intake.receive("smoobu", token, good, now)).toMatchObject({ status: 200, body: { duplicate: true } });
    const rows = await kept();
    expect(rows).toHaveLength(1);
    // Ids and the topic only: never the guest's name, email or the channel's commission.
    expect(String(rows[0]?.[2])).not.toMatch(/Wanjiru|guest\.example|commission/);
    expect(c.fake.platform.seen).toEqual([]);
  });
});

/* --- hosts, cards, commissions ---------------------------------------------------------------- */

describe("Smoobu: only Smoobu's API, and never a card, a payment status, a fee or a commission", () => {
  it("calls nothing but login.smoobu.com, never a link an answer gives, and never follows a redirect elsewhere", async () => {
    const c = connection(HAVELI_RANG);
    const ctx = c.ctx();
    const stay = stayOf(52011, "2027-03-01", "2027-03-03", { guest: true });
    const link = await writer(c).put(ctx, stay, null, "confirmed");
    await writer(c).find(ctx, stay);
    await writer(c).oversold?.(ctx, stay, link);
    await writer(c).cancel(ctx, link);
    expect(new Set(c.fake.platform.seen.map((r) => r.url.host))).toEqual(new Set(SMOOBU_HOSTS));
    c.fake.platform.fail("GET", "https://login.smoobu.com/api/apartments", {
      redirect: "https://smoobu.example.net/api/apartments",
    });
    await expect(c.def.stays?.properties(ctx)).rejects.toMatchObject({ code: "bad_response" });
    c.fake.platform.fail("GET", "https://login.smoobu.com/api/apartments", {
      redirect: "https://10.0.0.7/api/apartments",
    });
    await expect(c.def.stays?.properties(ctx)).rejects.toMatchObject({ code: "bad_response" });
    expect(c.fake.platform.seen.every((r) => r.url.host === "login.smoobu.com")).toBe(true);
  });

  it("refuses an address that is not Smoobu's own, wherever it would come from", async () => {
    // The adapter builds every address from its constant; a webhook address is registered, never called.
    const c = connection(HAVELI_RANG);
    await c.def.refresh?.(c.ctx({ hookUrl: "https://127.0.0.1/v1/hooks/smoobu/x" }));
    expect(c.fake.platform.seen.every((r) => r.url.host === "login.smoobu.com")).toBe(true);
    expect(SMOOBU_HOSTS).toEqual(["login.smoobu.com"]);
  });

  it("sends a guest's stay through every write without a card field, a payment status, a fee or a commission", async () => {
    const c = connection(CAP_BLANC, CAPBLANC_USER, { language: "fr" });
    const ctx = c.ctx();
    const stay = stayOf(70502, "2027-04-01", "2027-04-03", { currency: "CAD", value: 42_900, guest: true });
    const link = await writer(c).put(ctx, { ...stay, guest: undefined, notes: undefined }, null, "provisional");
    await writer(c).put(ctx, stay, link, "confirmed");
    await writer(c).cancel(ctx, link);
    const sent = c.fake.platform.seen.map((r) => r.body).join("\n");
    expect(sent).not.toMatch(
      /card|cvc|cvv|iban|commission|markup|priceStatus|deposit|prepayment|priceElements|channelId/i,
    );
    for (const r of c.fake.platform.seen) expect(r.headers.has("api-key")).toBe(false);
  });
});
