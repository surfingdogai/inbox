import { OWNER_ID } from "../../fixtures/property/beds24/auth";
import { type FixtureProperty, propertyAnswer } from "../../fixtures/property/beds24/properties";
import { type FakePlatform, type FakeRequest, fakePlatform } from "../platform";

/**
 * A local Beds24, as a fake (ADR-033 §8): Beds24 is never called. It speaks the paths, fields and
 * headers of Beds24's API V2 as its own documentation gives them (https://beds24.com/api/v2/apiV2.yaml,
 * https://wiki.beds24.com/index.php/API_V2.0), over the inbox's own connector client, so every request
 * the adapter makes passes the same https, host and size checks as in production.
 *
 * What the documentation does not settle, the fake makes switchable, so the adapter is proved either way:
 * - the setup call served as GET (the OpenAPI file) or POST only (the wiki's FAQ);
 * - credit headers spelled as the wiki or as the OpenAPI file, and spent credits answered 429 or with
 *   "Usage limit exceeded" under another status;
 * - `checkAvailability` honoured or not, and updates that take a full night and go below none (the
 *   OpenAPI file: `numAvail` "may be negative … if a room is overbooked");
 * - `apiReference` kept or dropped on a new booking;
 * - next-page links on Beds24, without a scheme, or to another host;
 * - a write that lands but whose answer is lost;
 * - whether "only upcoming bookings" (the OpenAPI file's default for GET /bookings) holds for a lookup
 *   by id or by `apiReference` too, unless a date is named;
 * - whether `arrivalTo` ("arrival date before this") and `departureFrom` ("departure date after this")
 *   count the day itself;
 * - whether the calendar's `numAvail` goes below none on an overbooked night, or stops at none.
 *
 * Scopes are held as the wiki gives them: a `read:` or `write:` method on each, `all:` for every
 * method; `bookings-financial` is what shows and takes a booking's price, deposit and tax.
 *
 * Its own rules, which are not Beds24's documented behaviour and are said here so no test leans on
 * them as such: an offer's total is the sum of the room's daily price with the offer's number; a
 * booking in `refuseModify` is one Beds24 will not change (a locked booking).
 */

export const API = "https://beds24.com/api/v2";
const WINDOW_MS = 5 * 60_000;
const DAY = 86_400_000;
const DEFAULT_STATUSES = ["confirmed", "request", "new", "black", "inquiry"];
const TAKES_ROOM = new Set(["confirmed", "request", "new", "black"]);
const FULL = [
  "read:bookings",
  "write:bookings",
  "read:bookings-personal",
  "read:bookings-financial",
  "write:bookings-financial",
  "read:inventory",
  "read:properties",
];

export interface FakeBooking {
  id: number;
  propertyId: number;
  roomId: number;
  roomQty: number;
  status: string;
  arrival: string;
  departure: string;
  numAdult: number;
  numChild: number;
  price: number;
  apiReference?: string;
  masterId?: number | null;
  group?: number[];
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  comments?: string;
  flagText?: string;
  flagColor?: string;
  infoItems?: { id: number; code: string; text: string }[];
  channel?: string;
  modifiedTime: string;
}

export interface FakeBeds24 {
  readonly platform: FakePlatform;
  readonly clock: { now: number };
  readonly bookings: Map<number, FakeBooking>;
  readonly mode: {
    setup: "get" | "post";
    headers: "wiki" | "yaml";
    limit: "429" | "body";
    checkAvailability: "honour" | "ignore";
    apiReference: "kept" | "dropped";
    pageSize: number;
    nextPage: "beds24" | "schemeless" | "foreign";
    /** A POST /bookings that lands and whose answer never comes back (502). */
    lostAnswer: boolean;
    /** Whether "only upcoming bookings" applies to lookups by id or key too, unless a date is named. */
    upcoming: "unless-id" | "always";
    /** Whether `arrivalTo` and `departureFrom` count the day itself. */
    bounds: "inclusive" | "exclusive";
    /** Whether the calendar's `numAvail` stops at none instead of going below. */
    clampAvail: boolean;
    /** Bookings Beds24 will not change: each change to one is answered as an error. */
    refuseModify: Set<number>;
  };
  credits: { limit: number; remaining: number; windowStart: number };
  /** What each call costs, by method and path. */
  cost: (method: string, path: string) => number;
  /** Called as a POST /bookings arrives, before Beds24 looks at it: another channel can book then. */
  beforeWrite: (() => void) | null;
  /** Makes an invite code with these scopes, good for 24 hours. */
  invite(code: string, scopes?: readonly string[]): void;
  /** A refresh token as if a code had been exchanged just now: what a connection holds. */
  grant(scopes?: readonly string[]): string;
  /** Nights another channel took, as a booking Beds24 holds. */
  book(b: Partial<FakeBooking> & { roomId: number; arrival: string; departure: string }): FakeBooking;
  /** Closes a night in the calendar (`override`). */
  close(roomId: number, night: string, override?: string): void;
  /** The calendar's multiplier on a night. */
  multiply(roomId: number, night: string, by: number): void;
  /** Units free on a night, as Beds24's calendar counts them (below none when overbooked). */
  numAvail(roomId: number, night: string): number;
  readonly refreshTokens: Map<string, { lastUsed: number; scopes: readonly string[] }>;
  /** Every JSON key in every request body the fake received. */
  bodyKeys(): string[];
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

function nights(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

function keysOf(value: unknown, out: string[]): void {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
}

export function fakeBeds24(opts: {
  readonly properties: readonly FixtureProperty[];
  readonly now?: number;
}): FakeBeds24 {
  const platform = fakePlatform();
  const clock = { now: opts.now ?? Date.now() };
  const bookings = new Map<number, FakeBooking>();
  const closures = new Map<string, string>();
  const multipliers = new Map<string, number>();
  const codes = new Map<string, { scopes: readonly string[]; issuedAt: number; used: boolean }>();
  const refreshTokens = new Map<string, { lastUsed: number; scopes: readonly string[] }>();
  const tokens = new Map<string, { expiresAt: number; scopes: readonly string[] }>();
  let nextId = 90_001_000;
  let nextToken = 0;
  const mode: FakeBeds24["mode"] = {
    setup: "get",
    headers: "wiki",
    limit: "429",
    checkAvailability: "honour",
    apiReference: "kept",
    pageSize: 100,
    nextPage: "beds24",
    lostAnswer: false,
    upcoming: "unless-id",
    bounds: "inclusive",
    clampAvail: false,
    refuseModify: new Set(),
  };
  let nextInfo = 70_000;

  const roomOf = (roomId: number) => {
    for (const p of opts.properties) {
      const r = p.rooms.find((x) => x.id === roomId);
      if (r) return { property: p, room: r };
    }
    return null;
  };
  const taken = (roomId: number, night: string, except?: number) => {
    let n = 0;
    for (const b of bookings.values()) {
      if (b.roomId !== roomId || b.id === except || !TAKES_ROOM.has(b.status)) continue;
      if (night >= b.arrival && night < b.departure) n += b.roomQty;
    }
    return n;
  };
  const numAvail = (roomId: number, night: string) => {
    const r = roomOf(roomId);
    if (!r) return 0;
    if (closures.get(`${roomId}|${night}`) === "blackout") return 0;
    return r.room.qty - taken(roomId, night);
  };

  const fake: FakeBeds24 = {
    platform,
    clock,
    bookings,
    mode,
    credits: { limit: 100, remaining: 100, windowStart: clock.now },
    cost: (method, path) => (method === "POST" && path.endsWith("/bookings") ? 2 : 1),
    beforeWrite: null,
    refreshTokens,
    invite(code, scopes = FULL) {
      codes.set(code, { scopes, issuedAt: clock.now, used: false });
    },
    grant(scopes = FULL) {
      const rt = `rft-granted-${refreshTokens.size + 1}`;
      refreshTokens.set(rt, { lastUsed: clock.now, scopes });
      return rt;
    },
    book(b) {
      const r = roomOf(b.roomId);
      const id = ++nextId;
      const booking: FakeBooking = {
        id,
        propertyId: r?.property.id ?? 0,
        roomQty: 1,
        status: "confirmed",
        numAdult: 2,
        numChild: 0,
        price: 0,
        channel: "booking",
        modifiedTime: new Date(clock.now).toISOString(),
        ...b,
      };
      bookings.set(id, booking);
      return booking;
    },
    close(roomId, night, override = "blackout") {
      closures.set(`${roomId}|${night}`, override);
    },
    multiply(roomId, night, by) {
      multipliers.set(`${roomId}|${night}`, by);
    },
    numAvail,
    bodyKeys() {
      const out: string[] = [];
      for (const r of platform.seen) {
        if (!r.body) continue;
        try {
          keysOf(JSON.parse(r.body), out);
        } catch {
          // not JSON: nothing to look at
        }
      }
      return out;
    },
  };

  /* --- answers ------------------------------------------------------------------ */

  const creditHeaders = (cost: number): Record<string, string> => {
    const resetsIn = String(Math.max(0, Math.ceil((fake.credits.windowStart + WINDOW_MS - clock.now) / 1000)));
    return mode.headers === "wiki"
      ? {
          "x-five-min-limit-remaining": String(fake.credits.remaining),
          "x-five-min-limit-resets-in": resetsIn,
          "x-request-cost": String(cost),
        }
      : {
          "X-FiveMinCreditLimit": String(fake.credits.limit),
          "X-FiveMinCreditLimit-Remaining": String(fake.credits.remaining),
          "X-FiveMinCreditLimit-ResetsIn": resetsIn,
          "X-RequestCost": String(cost),
        };
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const failure = (code: number, error: string) => ({ success: false, type: "error", code, error });

  /** Spends the call's credits, or answers that they are spent. */
  const spend = (req: FakeRequest): { headers: Record<string, string> } | Response => {
    if (clock.now - fake.credits.windowStart >= WINDOW_MS) {
      fake.credits.windowStart = clock.now;
      fake.credits.remaining = fake.credits.limit;
    }
    const cost = fake.cost(req.method, req.url.pathname);
    if (fake.credits.remaining < cost) {
      const body = failure(429, "Usage limit exceeded in last 5 minutes");
      return json(mode.limit === "429" ? 429 : 400, body, creditHeaders(0));
    }
    fake.credits.remaining -= cost;
    return { headers: creditHeaders(cost) };
  };

  /** Whether scopes grant one: the scope itself, or `all:` on the same thing. */
  const holds = (scopes: readonly string[], need: string) => {
    const [, what] = need.split(":");
    return scopes.includes(need) || scopes.includes(`all:${what}`);
  };

  /** The token's scopes, or the answer that it was not taken. */
  const authorise = (req: FakeRequest, need: string): readonly string[] | Response => {
    const t = req.headers.get("token");
    if (!t) return json(401, failure(401, "Token is missing"));
    const held = tokens.get(t);
    if (!held || held.expiresAt <= clock.now) return json(401, failure(401, "Token is invalid"));
    if (!holds(held.scopes, need)) return json(403, failure(403, "Token does not have the required scope"));
    return held.scopes;
  };

  const issue = (scopes: readonly string[]) => {
    const token = `tok-${++nextToken}`;
    tokens.set(token, { expiresAt: clock.now + DAY, scopes });
    return token;
  };

  const route = (
    method: string,
    path: string,
    need: string | null,
    handle: (
      req: FakeRequest,
      headers: Record<string, string>,
      scopes: readonly string[],
    ) => Response | Promise<Response>,
  ) => {
    platform.on(method, `${API}${path}`, async (req) => {
      const spent = spend(req);
      if (spent instanceof Response) return spent;
      let scopes: readonly string[] = [];
      if (need) {
        const ok = authorise(req, need);
        if (ok instanceof Response) return ok;
        scopes = ok;
      }
      return handle(req, spent.headers, scopes);
    });
  };

  /** A page of a list, with Beds24's `pages` and a next-page link in the chosen style. */
  const paged = (req: FakeRequest, type: string, items: unknown[], headers: Record<string, string>) => {
    const page = Math.max(1, Number(req.url.searchParams.get("page") ?? 1));
    const size = Math.max(1, mode.pageSize);
    const shown = items.slice((page - 1) * size, page * size);
    const more = page * size < items.length;
    const next = new URL(req.url.toString());
    next.searchParams.set("page", String(page + 1));
    const link =
      mode.nextPage === "foreign"
        ? `https://beds24.example.net${next.pathname}${next.search}`
        : mode.nextPage === "schemeless"
          ? `${next.host}${next.pathname}${next.search}`
          : next.toString();
    return json(
      200,
      {
        success: true,
        type,
        count: shown.length,
        pages: { nextPageExists: more, nextPageLink: more ? link : null },
        data: shown,
      },
      headers,
    );
  };

  const list = (req: FakeRequest, name: string) => req.url.searchParams.getAll(name);
  const flag = (req: FakeRequest, name: string) => req.url.searchParams.get(name) === "true";

  /* --- authentication ------------------------------------------------------------ */

  const setup = (req: FakeRequest, headers: Record<string, string>) => {
    const code = req.headers.get("code") ?? "";
    const c = codes.get(code);
    if (!c || c.used || clock.now - c.issuedAt > DAY) return json(400, failure(400, "Invalid code"), headers);
    c.used = true;
    const refreshToken = `rft-${code}-${refreshTokens.size + 1}`;
    refreshTokens.set(refreshToken, { lastUsed: clock.now, scopes: c.scopes });
    return json(200, { token: issue(c.scopes), expiresIn: 86_400, refreshToken }, headers);
  };
  for (const method of ["GET", "POST"] as const) {
    platform.on(method, `${API}/authentication/setup`, (req) => {
      if ((method === "GET") !== (mode.setup === "get")) return json(405, failure(405, "Method not allowed"));
      const spent = spend(req);
      if (spent instanceof Response) return spent;
      return setup(req, spent.headers);
    });
  }
  route("GET", "/authentication/token", null, (req, headers) => {
    const rt = refreshTokens.get(req.headers.get("refreshToken") ?? "");
    // Unused refresh tokens expire after 30 days (the wiki).
    if (!rt || clock.now - rt.lastUsed > 30 * DAY) return json(400, failure(400, "Invalid refresh token"), headers);
    rt.lastUsed = clock.now;
    return json(200, { token: issue(rt.scopes), expiresIn: 86_400 }, headers);
  });
  route("DELETE", "/authentication/token", null, (req, headers) => {
    refreshTokens.delete(req.headers.get("refreshToken") ?? "");
    return json(200, { success: true }, headers);
  });
  route("GET", "/authentication/details", null, (req, headers) => {
    const held = tokens.get(req.headers.get("token") ?? "");
    if (!held || held.expiresAt <= clock.now) return json(200, { validToken: false }, headers);
    return json(
      200,
      {
        validToken: true,
        token: {
          ownerId: OWNER_ID,
          expiresIn: Math.round((held.expiresAt - clock.now) / 1000),
          scopes: held.scopes,
          deviceName: "Inbox",
          onlyPropertyId: null,
        },
        diagnostics: { requestIp: "203.0.113.24" },
      },
      headers,
    );
  });

  /* --- properties and inventory ----------------------------------------------------- */

  route("GET", "/properties", "read:properties", (req, headers) => {
    const ids = list(req, "id").map(Number);
    const props = opts.properties.filter((p) => ids.length === 0 || ids.includes(p.id));
    return paged(
      req,
      "property",
      props.map((p) =>
        propertyAnswer(p, {
          rooms: flag(req, "includeAllRooms"),
          offers: flag(req, "includeOffers"),
          upsells: flag(req, "includeUpsellItems"),
        }),
      ),
      headers,
    );
  });

  route("GET", "/inventory/rooms/calendar", "read:inventory", (req, headers) => {
    const start = req.url.searchParams.get("startDate") ?? "";
    const end = req.url.searchParams.get("endDate") ?? "";
    if (!start || !end) return json(400, failure(400, "startDate and endDate are required"), headers);
    const roomIds = list(req, "roomId").map(Number);
    const propIds = list(req, "propertyId").map(Number);
    const rooms = opts.properties
      .filter((p) => propIds.length === 0 || propIds.includes(p.id))
      .flatMap((p) => p.rooms.map((r) => ({ p, r })))
      .filter(({ r }) => roomIds.length === 0 || roomIds.includes(r.id));
    const out = rooms.map(({ p, r }) => {
      // "These endpoints will only work if a price is set for the property or room" (the wiki).
      if (Object.keys(r.prices).length === 0) return { roomId: r.id, propertyId: p.id, calendar: [] };
      const days = nights(start, addDays(end, 1)).map((night) => {
        const override = closures.get(`${r.id}|${night}`);
        const m = multipliers.get(`${r.id}|${night}`);
        return {
          from: night,
          to: night,
          ...(flag(req, "includeNumAvail")
            ? { numAvail: mode.clampAvail ? Math.max(0, numAvail(r.id, night)) : numAvail(r.id, night) }
            : {}),
          ...(flag(req, "includeMinStay") ? { minStay: 1 } : {}),
          ...(flag(req, "includeOverride") && override ? { override } : {}),
          ...(flag(req, "includeMultiplier") && m !== undefined ? { multiplier: m } : {}),
          ...(flag(req, "includePrices") ? r.prices : {}),
        };
      });
      // Consecutive nights alike are one range, as Beds24 writes them.
      const merged: Record<string, unknown>[] = [];
      for (const d of days) {
        const last = merged[merged.length - 1];
        const { from: _f, to: _t, ...rest } = d;
        if (last) {
          const { from: _lf, to: _lt, ...lastRest } = last;
          if (JSON.stringify(rest) === JSON.stringify(lastRest) && addDays(String(last.to), 1) === d.from) {
            last.to = d.to;
            continue;
          }
        }
        merged.push({ ...d });
      }
      return { roomId: r.id, propertyId: p.id, calendar: merged };
    });
    return paged(req, "calendar", out, headers);
  });

  route("GET", "/inventory/rooms/offers", "read:inventory", (req, headers) => {
    const arrival = req.url.searchParams.get("arrival") ?? "";
    const departure = req.url.searchParams.get("departure") ?? "";
    if (!req.url.searchParams.get("numAdults")) return json(400, failure(2002, "Occupancy not defined"), headers);
    const roomIds = list(req, "roomId").map(Number);
    const data = roomIds.map((roomId) => {
      const r = roomOf(roomId);
      const ns = nights(arrival, departure);
      const free = Math.min(...ns.map((n) => numAvail(roomId, n)));
      const offers = (r?.room.offers ?? [])
        .map((o) => {
          const nightly = r?.room.prices[`price${o.offerId}`];
          return nightly === undefined
            ? null
            : {
                offerId: o.offerId,
                offerName: o.name,
                price: Math.round(nightly * ns.length * 100) / 100,
                unitsAvailable: Math.max(0, free),
              };
        })
        .filter(Boolean);
      return { roomId, propertyId: r?.property.id, offers };
    });
    return json(200, { success: true, type: "offer", data }, headers);
  });

  /* --- bookings ---------------------------------------------------------------- */

  const view = (b: FakeBooking, o: { group: boolean; info: boolean; financial: boolean }) => ({
    id: b.id,
    propertyId: b.propertyId,
    roomId: b.roomId,
    roomQty: b.roomQty,
    status: b.status,
    arrival: b.arrival,
    departure: b.departure,
    numAdult: b.numAdult,
    numChild: b.numChild,
    // Money only to a token with the financial scope (the wiki: it "provides access to financial information").
    ...(o.financial ? { price: b.price, deposit: 0, tax: 0 } : {}),
    ...(b.apiReference !== undefined ? { apiReference: b.apiReference } : {}),
    masterId: b.masterId ?? null,
    ...(o.group ? { bookingGroup: b.group ? { master: b.group[0], ids: b.group } : null } : {}),
    ...(o.info ? { infoItems: (b.infoItems ?? []).map((x) => ({ ...x, bookingId: b.id })) } : {}),
    ...(b.lastName !== undefined ? { lastName: b.lastName } : {}),
    ...(b.firstName !== undefined ? { firstName: b.firstName } : {}),
    flagText: b.flagText ?? "",
    flagColor: b.flagColor ?? "",
    notes: b.notes ?? "",
    comments: b.comments ?? "",
    channel: b.channel ?? "direct",
    modifiedTime: b.modifiedTime,
  });

  route("GET", "/bookings", "read:bookings", (req, headers, scopes) => {
    const ids = list(req, "id").map(Number);
    const refs = list(req, "apiReference");
    const rooms = list(req, "roomId").map(Number);
    const statuses = list(req, "status");
    const wanted = statuses.length ? statuses : DEFAULT_STATUSES;
    const arrivalFrom = req.url.searchParams.get("arrivalFrom");
    const arrivalTo = req.url.searchParams.get("arrivalTo");
    const departureFrom = req.url.searchParams.get("departureFrom");
    const today = new Date(clock.now).toISOString().slice(0, 10);
    const exclusive = mode.bounds === "exclusive";
    const dated = Boolean(arrivalFrom || arrivalTo || departureFrom);
    const byIdOrKey = ids.length > 0 || refs.length > 0;
    const found = [...bookings.values()].filter((b) => {
      if (ids.length && !ids.includes(b.id)) return false;
      if (refs.length && !refs.includes(b.apiReference ?? "\u0000")) return false;
      if (rooms.length && !rooms.includes(b.roomId)) return false;
      if (!wanted.includes(b.status)) return false;
      if (arrivalFrom && (exclusive ? b.arrival <= arrivalFrom : b.arrival < arrivalFrom)) return false;
      if (arrivalTo && (exclusive ? b.arrival >= arrivalTo : b.arrival > arrivalTo)) return false;
      if (departureFrom && (exclusive ? b.departure <= departureFrom : b.departure < departureFrom)) return false;
      // "By default only upcoming bookings will be returned."
      if (!dated && (!byIdOrKey || mode.upcoming === "always") && b.departure < today) return false;
      return true;
    });
    const o = {
      group: flag(req, "includeBookingGroup"),
      info: flag(req, "includeInfoItems"),
      financial: holds(scopes, "read:bookings-financial"),
    };
    return paged(
      req,
      "booking",
      found.sort((a, b) => a.id - b.id).map((b) => view(b, o)),
      headers,
    );
  });

  /** Info items written with a booking: added without an id, changed by id with text, taken off by id alone. */
  const applyInfo = (b: FakeBooking, raw: unknown) => {
    if (!Array.isArray(raw)) return;
    const items = [...(b.infoItems ?? [])];
    for (const x of raw as { id?: unknown; code?: unknown; text?: unknown }[]) {
      if (typeof x.id === "number") {
        const at = items.findIndex((i) => i.id === x.id);
        if (at < 0) continue;
        if (typeof x.text === "string")
          items[at] = { ...(items[at] as { id: number; code: string; text: string }), text: x.text };
        else items.splice(at, 1);
      } else if (typeof x.text === "string") {
        items.push({ id: ++nextInfo, code: typeof x.code === "string" ? x.code : "", text: x.text });
      }
    }
    b.infoItems = items;
  };

  route("POST", "/bookings", "write:bookings", (req, headers, scopes) => {
    fake.beforeWrite?.();
    // A price, deposit or tax is taken only from a token with the financial scope; otherwise left out.
    const money = holds(scopes, "write:bookings-financial");
    let items: Record<string, unknown>[];
    try {
      items = JSON.parse(req.body) as Record<string, unknown>[];
    } catch {
      return json(400, failure(400, "Body is not JSON"), headers);
    }
    if (!Array.isArray(items)) return json(400, failure(400, "Body must be an array"), headers);
    const group: number[] = [];
    const answers = items.map((it) => {
      const actions = (it.actions ?? {}) as Record<string, unknown>;
      if (typeof it.id === "number") {
        const b = bookings.get(it.id);
        if (!b) return { success: false, errors: [{ action: "modify", field: "id", message: "Booking not found" }] };
        if (mode.refuseModify.has(b.id)) {
          return { success: false, errors: [{ action: "modify", field: "id", message: "Booking is locked" }] };
        }
        // An update is not checked against availability: it can take the room below none.
        for (const k of [
          "status",
          "arrival",
          "departure",
          "roomId",
          "numAdult",
          "numChild",
          "price",
          "lastName",
          "email",
          "phone",
          "flagText",
          "flagColor",
        ] as const) {
          if (k === "price" && !money) continue;
          if (it[k] !== undefined) (b as unknown as Record<string, unknown>)[k] = it[k];
        }
        applyInfo(b, it.infoItems);
        b.modifiedTime = new Date(clock.now).toISOString();
        return { success: true, modified: { id: b.id } };
      }
      const roomId = Number(it.roomId);
      const r = roomOf(roomId);
      if (!r || typeof it.arrival !== "string" || typeof it.departure !== "string") {
        return {
          success: false,
          errors: [{ action: "new", field: "roomId", message: "roomId, arrival and departure are required" }],
        };
      }
      if (actions.checkAvailability === true && mode.checkAvailability === "honour") {
        if (nights(it.arrival, it.departure).some((n) => numAvail(roomId, n) < 1)) {
          return {
            success: false,
            errors: [{ action: "new", field: "roomId", message: "No availability for these dates" }],
          };
        }
      }
      const b = fake.book({
        roomId,
        arrival: it.arrival,
        departure: it.departure,
        status: typeof it.status === "string" ? it.status : "new",
        numAdult: Number(it.numAdult ?? 1),
        numChild: Number(it.numChild ?? 0),
        price: money ? Number(it.price ?? 0) : 0,
        channel: "direct",
        ...(mode.apiReference === "kept" && typeof it.apiReference === "string"
          ? { apiReference: it.apiReference }
          : {}),
        ...(typeof it.masterId === "number" ? { masterId: it.masterId } : {}),
        ...(typeof it.lastName === "string" ? { lastName: it.lastName } : {}),
        ...(typeof it.email === "string" ? { email: it.email } : {}),
        ...(typeof it.phone === "string" ? { phone: it.phone } : {}),
        ...(typeof it.notes === "string" ? { notes: it.notes } : {}),
        ...(typeof it.comments === "string" ? { comments: it.comments } : {}),
        ...(typeof it.flagText === "string" ? { flagText: it.flagText } : {}),
        ...(typeof it.flagColor === "string" ? { flagColor: it.flagColor } : {}),
      });
      applyInfo(b, it.infoItems);
      if (actions.makeGroup === true) group.push(b.id);
      if (typeof it.masterId === "number") {
        const master = bookings.get(it.masterId);
        const ids = master?.group ?? [it.masterId];
        if (!ids.includes(b.id)) ids.push(b.id);
        for (const id of ids) {
          const m = bookings.get(id);
          if (m) m.group = ids;
        }
      }
      return { success: true, new: { id: b.id } };
    });
    if (group.length > 1) for (const id of group) (bookings.get(id) as FakeBooking).group = [...group];
    if (mode.lostAnswer) return new Response("bad gateway", { status: 502 });
    return json(201, answers, headers);
  });

  route("DELETE", "/bookings", "write:bookings", (req, headers) => {
    for (const id of list(req, "id").map(Number)) bookings.delete(id);
    return json(201, [{ success: true }], headers);
  });

  return fake;
}
