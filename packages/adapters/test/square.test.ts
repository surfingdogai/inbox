import {
  type CatalogueProduct,
  type ConnectContext,
  type Connected,
  ConnectorError,
  gallery,
  type InboundRequest,
  type LinkState,
  type OutboundBooking,
  type PayLinkRequest,
  type RunContext,
  type ShopOrder,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  builtInConnectors,
  hmacSha256Base64,
  SQUARE_SCOPES,
  SQUARE_TOPICS,
  SQUARE_VERSION,
  squareConnector,
} from "../src/index";
import {
  CLIENT,
  type FakeSquare,
  type FakeSquareOptions,
  fakeSquare,
  OAUTH_CODE,
  PRODUCTION,
  SANDBOX,
  SANDBOX_TOKEN,
  TOKEN,
} from "./fixtures/square";

/**
 * Contract tests for the Square connector (ADR-034) against a made-up seller answering as Square's API
 * documents it (`fixtures/square.ts`), through the inbox's own connector client: what is asked of
 * Square, with which token, and what the inbox makes of the answer. Above all: the token goes to
 * Square's own hosts and nowhere else; bookings are written only the way Square takes them (an access
 * token as the seller on Appointments Plus or Premium, a sign-in as a customer on every plan); a
 * booking's customer record carries the business's phone, so Square never texts the customer; a
 * webhook is believed only once its signature checks out and Square, asked back, says the same; no fee
 * is ever asked. No real Square is called.
 */

const DAY = 86_400_000;
/** Midnight UTC a week from now: every booking here is in the future, whenever the tests run. */
const D0 = Math.floor((Date.now() + 7 * DAY) / DAY) * DAY;
const H = (h: number, m = 0) => D0 + h * 3_600_000 + m * 60_000;
const HOOK_URL = "https://inbox.lumiere.example.ca/v1/hooks/square/Qm3kP9wQe7RmX2vB8nYc4LsA1dF6gH0jK5uI9oTp3qE";
const INBOX = {
  id: "4b7e1f0a9c2d4e6f8a1d",
  origin: "https://inbox.lumiere.example.ca",
  host: "inbox.lumiere.example.ca",
  name: "Salon Lumière",
  timezone: "America/Toronto",
  language: "fr-CA",
};

function connectCtx(sq: FakeSquare, over: Partial<ConnectContext> = {}): ConnectContext {
  return { http: sq.platform.http, now: Date.now(), inbox: INBOX, hookUrl: HOOK_URL, ...over };
}

/** A run's context for what a connect made; the secret it saves is what the next run sees. */
function runner(sq: FakeSquare, made: Connected) {
  const held = { secret: { ...made.secret } as Record<string, string>, saved: 0 };
  const ctx = (over: Partial<RunContext> = {}): RunContext => ({
    http: sq.platform.http,
    now: Date.now(),
    inbox: INBOX,
    hookUrl: HOOK_URL,
    secret: held.secret,
    extra: (made.extra ?? {}) as Record<string, unknown>,
    calendars: [],
    busyCalendars: [],
    destinations: made.destinations,
    destination: made.defaults.destination,
    own: { ids: new Set(), spans: [] },
    marker: "7c1e2d3c4b5a69788796a5b4c3d2e1f0",
    choices: Object.fromEntries((made.choices ?? []).map((c) => [c.key, c.value])),
    saveSecret: async (next) => {
      held.secret = { ...next };
      held.saved++;
    },
    ...over,
  });
  return { ctx, held };
}

async function connected(opts: FakeSquareOptions = {}, over: Partial<ConnectContext> = {}, token = TOKEN) {
  const sq = fakeSquare(opts);
  const def = squareConnector();
  const made = await def.connect?.(connectCtx(sq, over), { access_token: token });
  if (!made) throw new Error("not connected");
  await made.settle?.(true);
  return { sq, def, made, ...runner(sq, made) };
}

/** Connected through Sign in with Square, whose token books as a customer. */
async function signedIn(opts: FakeSquareOptions = {}) {
  const sq = fakeSquare(opts);
  const def = squareConnector(CLIENT);
  const made = await def.oauth?.exchange(connectCtx(sq), { code: OAUTH_CODE, verifier: "v", redirectUri: "x" });
  if (!made) throw new Error("not signed in");
  return { sq, def, made, ...runner(sq, made) };
}

async function refusal(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error("it went through");
}

type Page = { readonly products: readonly CatalogueProduct[]; readonly cursor: string | null } | undefined;

const inbound = (d: { body: string; headers: Record<string, string> }): InboundRequest => ({
  headers: new Headers(d.headers),
  body: d.body,
  query: new URLSearchParams(),
});

function booking(over: Partial<OutboundBooking> = {}): OutboundBooking {
  const start = over.start ?? H(15);
  const durationMin = over.durationMin ?? 45;
  return {
    itemId: "01JBOOKINGLUMIERE0000000001",
    start,
    end: over.end ?? start + durationMin * 60_000,
    title: "Haircut · Oluwaseun Adeyemi",
    description: "Booked in your inbox.\nhttps://inbox.lumiere.example.ca/items/01JBOOKINGLUMIERE0000000001",
    url: "https://inbox.lumiere.example.ca/items/01JBOOKINGLUMIERE0000000001",
    serviceId: "svc_inbox_haircut",
    serviceName: "Haircut",
    customerName: "Oluwaseun Adeyemi",
    durationMin,
    ...over,
  };
}

/** What was sent to exactly this path. */
const body = (sq: FakeSquare, method: string, path: string, host = PRODUCTION) =>
  sq.platform
    .requests(method, `${host}${path}`)
    .filter((r) => r.url.pathname === path)
    .map((r) => JSON.parse(r.body || "{}") as Record<string, unknown>);

describe("connecting with an access token", () => {
  it("reads the seller, its open locations, services and team, and adds its webhook at the connection's address", async () => {
    const { sq, made } = await connected();
    expect(made).toMatchObject({
      account: "Salon Lumière",
      externalId: sq.merchantId,
      mode: "live",
      defaults: { busy: [], destination: "auto" },
      extra: { env: "production", via: "token", merchantId: sq.merchantId, mainLocation: sq.location, hooks: "added" },
    });
    // Choosers, never typed ids: the open locations, and who takes bookings (a choice about bookings).
    expect(made.choices).toEqual([
      {
        key: "location",
        label: "Location",
        options: [
          { id: sq.location, name: "Queen Street West" },
          { id: "L8TOR0NT0DANFRT", name: "Danforth" },
        ],
        value: sq.location,
      },
      {
        key: "team",
        label: "Bookings go to",
        options: [
          { id: "any", name: "Whoever is free" },
          { id: "TM_amelie", name: "Amélie Tremblay" },
          { id: "TM_kwame", name: "Kwame Mensah" },
        ],
        value: "any",
        bookings: true,
      },
    ]);
    // Each booking goes to the service of its own name and length: one service for all would send a
    // colour to the haircut, so there is nothing to choose.
    expect(made.destinations).toEqual([{ id: "auto", name: "Matched by name", writable: true }]);
    // The services, with their length; one with a cancellation fee is left out (Square refuses it through its API).
    const services = (made.extra as { services: { id: string; name: string; minutes: number }[] }).services;
    expect(services.map((x) => [x.id, x.name, x.minutes])).toEqual([
      ["VARHAIRCUT45MIN0", "Haircut", 45],
      ["VARCOLOURFULL120", "Colour · Full", 120],
      ["VARCOLOURROOTS60", "Colour · Roots", 60],
      ["VARBEARDTRIM30M0", "Beard trim", 30],
      ["VARSCALPMASSAGE0", "Scalp massage", 45],
    ]);
    const [sub] = [...sq.subscriptions.values()];
    expect(sub).toMatchObject({
      notification_url: HOOK_URL,
      event_types: SQUARE_TOPICS,
      api_version: SQUARE_VERSION,
      enabled: true,
    });
    expect(made.secret).toEqual({ access_token: TOKEN, signature_key: sub?.signature_key });
    // Every call carried the token to Square's own host, in Square's version, and went nowhere else.
    expect(sq.platform.seen.every((r) => r.url.origin === PRODUCTION)).toBe(true);
    expect(sq.platform.seen.every((r) => r.headers.get("square-version") === SQUARE_VERSION)).toBe(true);
    expect(sq.platform.seen.every((r) => r.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("names the token when Square takes it nowhere, production or Sandbox, and never says it back", async () => {
    const sq = fakeSquare();
    const e = await refusal(
      squareConnector().connect?.(connectCtx(sq), { access_token: "EAAAwrongwrongwrongwrongwrong" }) ??
        Promise.resolve(),
    );
    expect(e).toMatchObject({ code: "auth", field: "access_token" });
    expect(e.message).not.toContain("EAAAwrong");
    expect(sq.platform.seen.map((r) => r.url.origin)).toEqual([PRODUCTION, SANDBOX]);
  });

  it("connects a Sandbox token in test mode, as another account than the same seller's production", async () => {
    const { sq, made } = await connected({}, {}, SANDBOX_TOKEN);
    expect(made).toMatchObject({
      account: "Salon Lumière (Sandbox)",
      externalId: `sandbox:${sq.merchantId}`,
      mode: "test",
      extra: { env: "sandbox" },
    });
    expect(sq.platform.requests("POST", `${SANDBOX}/v2/webhooks/subscriptions`)).toHaveLength(1);
  });

  it("waits to add the webhook until the inbox is live, then adds it on the next read", async () => {
    const { sq, def, made, ctx, held } = await connected({}, { hooksLive: false });
    expect(sq.subscriptions.size).toBe(0);
    expect(made.extra).toMatchObject({ hooks: "pending" });
    expect(def.stale?.(ctx({ hooksLive: false }))).toBe(false);
    expect(def.stale?.(ctx())).toBe(true);
    const fresh = await def.refresh?.(ctx());
    expect(sq.subscriptions.size).toBe(1);
    expect(fresh?.extra).toMatchObject({ hooks: "added", notificationUrl: HOOK_URL });
    expect(held.secret.signature_key).toBe([...sq.subscriptions.values()][0]?.signature_key);
  });

  it("moves the webhook with the inbox's address, and puts it back when it was removed in Square", async () => {
    const { sq, def, ctx } = await connected();
    const moved = "https://inbox.salonlumiere.ca/v1/hooks/square/Qm3kP9wQe7RmX2vB8nYc4LsA1dF6gH0jK5uI9oTp3qE";
    expect(def.stale?.(ctx({ hookUrl: moved }))).toBe(true);
    const fresh = await def.refresh?.(ctx({ hookUrl: moved }));
    expect([...sq.subscriptions.values()][0]?.notification_url).toBe(moved);
    expect(fresh?.extra).toMatchObject({ notificationUrl: moved });
    sq.subscriptions.clear();
    const again = await def.refresh?.(ctx());
    expect(sq.subscriptions.size).toBe(1);
    expect(again?.extra).toMatchObject({ hooks: "added", notificationUrl: HOOK_URL });
  });

  it("keeps one webhook when connected again, and takes back the one it made when the connection is refused", async () => {
    const { sq } = await connected();
    const first = [...sq.subscriptions.keys()][0];
    const again = await squareConnector().connect?.(connectCtx(sq), { access_token: TOKEN });
    await again?.settle?.(true);
    expect([...sq.subscriptions.keys()]).toHaveLength(1);
    expect([...sq.subscriptions.keys()][0]).not.toBe(first);
    const refused = await squareConnector().connect?.(connectCtx(sq), { access_token: TOKEN });
    const kept = [...sq.subscriptions.keys()][0];
    await refused?.settle?.(false);
    expect([...sq.subscriptions.keys()]).toEqual([kept]);
  });

  it("never follows Square elsewhere: a redirect to a private host is refused and nothing reaches it", async () => {
    const sq = fakeSquare();
    sq.platform.fail("GET", `${PRODUCTION}/v2/merchants/me`, { redirect: "https://10.0.0.7/v2/merchants/me" });
    const e = await refusal(squareConnector().connect?.(connectCtx(sq), { access_token: TOKEN }) ?? Promise.resolve());
    expect(e.code).toBe("bad_response");
    expect(sq.platform.seen.some((r) => r.url.hostname === "10.0.0.7")).toBe(false);
  });

  it("says when Square is slow or down, in words the owner can act on", async () => {
    const sq = fakeSquare();
    sq.platform.fail("GET", `${PRODUCTION}/v2/merchants/me`, 429);
    const limited = await refusal(
      squareConnector().connect?.(connectCtx(sq), { access_token: TOKEN }) ?? Promise.resolve(),
    );
    expect(limited).toMatchObject({ code: "rate_limited", retryAfterMs: 7_000 });
    sq.platform.fail("GET", `${PRODUCTION}/v2/merchants/me`, 503);
    const down = await refusal(
      squareConnector().connect?.(connectCtx(sq), { access_token: TOKEN }) ?? Promise.resolve(),
    );
    expect(down.code).toBe("unreachable");
  });

  it("connects a seller without Square Appointments for its items and orders only", async () => {
    const { def, made, ctx } = await connected({ appointments: "off" });
    expect(made.destinations).toEqual([]);
    expect(made.choices?.map((c) => c.key)).toEqual(["location"]);
    expect(await def.busy?.(ctx(), { start: D0, end: D0 + 7 * DAY })).toEqual([]);
    // Nothing of bookings is offered: the row says products and links only.
    const off = "Square Appointments is off for this account.";
    expect(def.withheld?.({ extra: made.extra ?? {} })).toEqual({ busy_times: off, write_bookings: off });
  });

  it("asks a seller with one location nothing about it", async () => {
    const { made } = await connected({ locations: 1 });
    expect(made.choices?.map((c) => c.key)).toEqual(["team"]);
  });
});

describe("which way Square takes bookings", () => {
  it("keeps busy times from an access token on Appointments Free, adds no bookings, and says why", async () => {
    const { sq, def, made, ctx } = await connected();
    expect(def.withheld?.({ extra: made.extra ?? {} })).toEqual({
      write_bookings:
        "Square adds bookings from an access token on Appointments Plus or Premium only. Busy times still come from Square.",
    });
    // Where the server has a Square app, the line names the way that takes them on this plan.
    expect(squareConnector(CLIENT).withheld?.({ extra: made.extra ?? {} }).write_bookings).toContain(
      "Sign in with Square",
    );
    const read = await def.busy?.(ctx(), { start: D0, end: D0 + DAY });
    expect(Array.isArray(read) && read.length > 0).toBe(true);
    // Were it asked anyway, nothing reaches Square, which would refuse the token as the seller.
    const e = await refusal(def.bookings?.put(ctx(), booking(), null) ?? Promise.resolve());
    expect(e.message).toContain("Appointments Plus or Premium");
    expect(body(sq, "POST", "/v2/bookings")).toHaveLength(0);
    const direct = await sq.platform.http.request({
      method: "POST",
      url: `${PRODUCTION}/v2/bookings`,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k", booking: { appointment_segments: [] } }),
    });
    expect(direct.status).toBe(403);
    expect(direct.text).toContain("Merchant subscription does not support write operations.");
  });

  it("writes as the seller from an access token on Appointments Plus: its own note, which the client never sees", async () => {
    const { sq, def, made, ctx } = await connected({ appointments: "plus" });
    expect(def.withheld?.({ extra: made.extra ?? {} })).toEqual({});
    const link = await def.bookings?.put(ctx(), booking(), null);
    const written = sq.bookings.get(String(link?.externalId));
    expect(written?.sellerNote).toContain("Haircut · Oluwaseun Adeyemi");
    expect(written?.customerNote).toBeUndefined();
    const sent = body(sq, "POST", "/v2/bookings")[0] as {
      booking: { appointment_segments: Record<string, unknown>[] };
    };
    expect(sent.booking.appointment_segments[0]).toMatchObject({ duration_minutes: 45 });
  });

  it("books as a customer through Sign in with Square, on every plan: a note of the customer's, Square's own length", async () => {
    const { sq, def, made, ctx } = await signedIn();
    expect(made.extra).toMatchObject({ via: "signin", hooks: "none" });
    expect(def.withheld?.({ extra: made.extra ?? {} })).toEqual({});
    // Bookings go in here, so a location Square cannot book for says so before one is refused.
    expect(made.choices?.[0]?.options.map((o) => o.name)).toEqual([
      "Queen Street West",
      "Danforth · add a phone in Square to take bookings",
    ]);
    const link = await def.bookings?.put(ctx(), booking(), null);
    const written = sq.bookings.get(String(link?.externalId));
    expect(written?.customerNote).toContain("Haircut · Oluwaseun Adeyemi");
    expect(written?.sellerNote).toBeUndefined();
    const sent = body(sq, "POST", "/v2/bookings")[0] as {
      booking: Record<string, unknown> & { appointment_segments: Record<string, unknown>[] };
    };
    expect(sent.booking).not.toHaveProperty("seller_note");
    expect(sent.booking.appointment_segments[0]).not.toHaveProperty("duration_minutes");
  });
});

describe("busy times, from what Square would book", () => {
  it("takes off what Square would not book: closed hours, and times nobody is free", async () => {
    const { sq, def, ctx } = await connected();
    // Kwame is with a walk-in from 15:00 to 16:00, Amélie at a training: nobody takes a haircut then.
    sq.blocked.push({ team: "TM_kwame", start: H(15), end: H(16) }, { team: "TM_amelie", start: H(15), end: H(16) });
    const window = { start: D0, end: D0 + 2 * DAY };
    const read = await def.busy?.(ctx(), window);
    const intervals = Array.isArray(read) ? read : (read?.intervals ?? []);
    // Open 14:00 to 22:00 UTC: closed before, a gap at 15:00, closed after.
    expect(intervals.slice(0, 3)).toEqual([
      { start: D0, end: H(14) },
      { start: H(15), end: H(16) },
      { start: H(22), end: H(38) },
    ]);
    // One person away is not busy: the other takes the haircut.
    sq.blocked.splice(1, 1);
    const one = await def.busy?.(ctx(), window);
    expect((Array.isArray(one) ? one : []).slice(0, 2)).toEqual([
      { start: D0, end: H(14) },
      { start: H(22), end: H(38) },
    ]);
    // Asked of Square for the service most of the team take (a haircut), at the location, a day at least.
    const asked = body(sq, "POST", "/v2/bookings/availability/search").at(-1) as {
      query: { filter: { location_id: string; segment_filters: unknown[]; start_at_range: { start_at: string } } };
    };
    expect(asked.query.filter.location_id).toBe(sq.location);
    expect(asked.query.filter.segment_filters).toEqual([{ service_variation_id: "VARHAIRCUT45MIN0" }]);
  });

  it("reads for the team member the owner chose, and leaves out the inbox's own bookings", async () => {
    const { sq, def, ctx } = await connected();
    sq.blocked.push({ team: "TM_kwame", start: H(15), end: H(16) });
    const window = { start: D0, end: D0 + 2 * DAY };
    const kwame = await def.busy?.(ctx({ choices: { location: sq.location, team: "TM_kwame" } }), window);
    expect((Array.isArray(kwame) ? kwame : [])[1]).toEqual({ start: H(15), end: H(16) });
    const asked = body(sq, "POST", "/v2/bookings/availability/search").at(-1) as {
      query: { filter: { segment_filters: unknown[] } };
    };
    // The shortest service Kwame takes, for him only.
    expect(asked.query.filter.segment_filters).toEqual([
      { service_variation_id: "VARBEARDTRIM30M0", team_member_id_filter: { any: ["TM_kwame"] } },
    ]);
    // The 15:00 hour is a booking this inbox wrote: it never blocks itself.
    const own = await def.busy?.(
      ctx({
        choices: { location: sq.location, team: "TM_kwame" },
        own: { ids: new Set(), spans: [{ start: H(15), end: H(16) }] },
      }),
      window,
    );
    expect((Array.isArray(own) ? own : [])[1]).toEqual({ start: H(22), end: H(38) });
  });

  it("reads the whole way ahead 31 days at a time, and says how far it got past that", async () => {
    const { sq, def, ctx } = await connected();
    const full = await def.busy?.(ctx(), { start: D0, end: D0 + 92 * DAY });
    expect(Array.isArray(full)).toBe(true);
    const ranges = body(sq, "POST", "/v2/bookings/availability/search").map((b) => {
      const r = (b as { query: { filter: { start_at_range: { start_at: string; end_at: string } } } }).query.filter
        .start_at_range;
      return (Date.parse(r.end_at) - Date.parse(r.start_at)) / DAY;
    });
    expect(ranges).toEqual([31, 31, 30]);
    const far = await def.busy?.(ctx(), { start: D0, end: D0 + 120 * DAY });
    expect(far).toMatchObject({ until: D0 + 93 * DAY });
  });
});

describe("bookings written into Square", () => {
  it("books who Square says is free, for a record of the customer's own under the business's phone, with no email", async () => {
    const { sq, def, ctx } = await connected({ appointments: "plus" });
    const link = await def.bookings?.put(ctx(), booking(), null);
    expect(link).toMatchObject({ calendar: "VARHAIRCUT45MIN0", start: H(15), end: H(15, 45) });
    const made = sq.bookings.get(String(link?.externalId));
    expect(made).toMatchObject({ start: H(15), service: "VARHAIRCUT45MIN0", team: "TM_amelie", status: "ACCEPTED" });
    // The salon's calendar shows who is coming; Square's texts go to the salon's own number.
    const customer = sq.customers.get(String(made?.customer));
    expect(customer).toMatchObject({ given_name: "Oluwaseun Adeyemi", phone_number: "+1 416-555-0142" });
    expect(customer?.email_address).toBeUndefined();
    expect(customer?.family_name).toBeUndefined();
    expect(JSON.stringify(sq.platform.seen.map((r) => r.body))).not.toContain("@");

    // Their next booking: the same record. Another customer: one of their own.
    await def.bookings?.put(ctx(), booking({ itemId: "01JBOOKINGLUMIERE0000000002", start: H(17) }), null);
    expect(sq.customers.size).toBe(1);
    await def.bookings?.put(
      ctx(),
      booking({
        itemId: "01JBOOKINGLUMIERE0000000003",
        start: H(19),
        title: "Haircut · Chen Mei Lin",
        customerName: "Chen Mei Lin",
      }),
      null,
    );
    expect([...sq.customers.values()].map((c) => c.given_name)).toEqual(["Oluwaseun Adeyemi", "Chen Mei Lin"]);
    // A customer who was erased has no name to show: one record stands for all of them.
    await def.bookings?.put(
      ctx(),
      booking({ itemId: "01JBOOKINGLUMIERE0000000004", start: H(20), title: "Haircut", customerName: null }),
      null,
    );
    expect([...sq.customers.values()].at(-1)?.given_name).toBe("Inbox booking");
  });

  it("finds a booking a stopped run made, and a retry makes no second one", async () => {
    const { sq, def, ctx } = await connected({ appointments: "plus" });
    const first = await def.bookings?.put(ctx(), booking(), null);
    const retried = await def.bookings?.put(ctx(), booking(), null);
    expect(retried?.externalId).toBe(first?.externalId);
    expect(sq.bookings.size).toBe(1);
    const found = await def.bookings?.find?.(ctx(), booking());
    expect(found?.externalId).toBe(first?.externalId);
    expect(await def.bookings?.find?.(ctx(), booking({ start: H(19) }))).toBeNull();
    expect(await def.bookings?.find?.(ctx(), booking({ customerName: "Someone Else" }))).toBeNull();
  });

  it("moves a booking in place only when Square says its team member is free then, and otherwise books anew first", async () => {
    const { sq, def, ctx } = await connected({ appointments: "plus" });
    const puts = () => sq.platform.seen.filter((r) => r.method === "PUT" && r.url.pathname.startsWith("/v2/bookings/"));
    const link = (await def.bookings?.put(ctx(), booking(), null)) as LinkState;
    const moved = await def.bookings?.put(ctx(), booking({ start: H(16) }), link);
    expect(moved?.externalId).toBe(link.externalId);
    expect(sq.bookings.get(String(link.externalId))).toMatchObject({ start: H(16), version: 1, status: "ACCEPTED" });
    expect(puts()).toHaveLength(1);
    // Amélie is with a walk-in at 18:00, which Square would let a seller double-book: the inbox asks
    // first, books Kwame anew, and lets the old one go after.
    sq.blocked.push({ team: "TM_amelie", start: H(18), end: H(19) });
    const again = await def.bookings?.put(ctx(), booking({ start: H(18) }), moved as LinkState);
    expect(puts()).toHaveLength(1);
    expect(again?.externalId).not.toBe(link.externalId);
    expect(sq.bookings.get(String(again?.externalId))).toMatchObject({ start: H(18), team: "TM_kwame" });
    expect(sq.bookings.get(String(link.externalId))?.status).toBe("CANCELLED_BY_SELLER");
  });

  it("never leaves one booking holding two times: the new one goes again when the old one cannot", async () => {
    const { sq, def, ctx } = await signedIn();
    const link = (await def.bookings?.put(ctx(), booking(), null)) as LinkState;
    // The 15:00 haircut's cancellation window has closed for a customer, and Amélie is away at 18:00.
    sq.cancelBefore = H(16);
    sq.blocked.push({ team: "TM_amelie", start: H(18), end: H(19) });
    const said =
      "Square would not let the old time go: The cancellation period for this booking has ended. Move it in Square.";
    const e = await refusal(def.bookings?.put(ctx(), booking({ start: H(18) }), link) ?? Promise.resolve());
    expect(e).toMatchObject({ code: "refused", message: said });
    const live = () => [...sq.bookings.values()].filter((b) => b.status === "ACCEPTED").map((b) => b.id);
    expect(live()).toEqual([link.externalId]);
    // Tried again, it says the same, and nothing more is made.
    const twice = await refusal(def.bookings?.put(ctx(), booking({ start: H(18) }), link) ?? Promise.resolve());
    expect(twice.message).toBe(said);
    expect(sq.bookings.size).toBe(2);
    expect(live()).toEqual([link.externalId]);
    // Neither can go: the new one is kept and named, and the old one is the owner's to cancel in Square.
    sq.cancelBefore = H(20);
    const kept = await def.bookings?.put(ctx(), booking({ start: H(18, 30) }), link);
    expect(kept?.externalId).not.toBe(link.externalId);
    expect(sq.bookings.get(String(kept?.externalId))).toMatchObject({ start: H(18, 30), status: "ACCEPTED" });
  });

  it("cancels with the booking's version, is done when it was gone, and says when Square's own window has closed", async () => {
    const { sq, def, ctx } = await signedIn();
    const link = (await def.bookings?.put(ctx(), booking(), null)) as LinkState;
    await def.bookings?.remove(ctx(), link);
    expect(sq.bookings.get(String(link.externalId))?.status).toBe("CANCELLED_BY_CUSTOMER");
    const cancel = body(sq, "POST", `/v2/bookings/${link.externalId}/cancel`)[0];
    expect(cancel).toMatchObject({ booking_version: 0 });
    await def.bookings?.remove(ctx(), link);
    await def.bookings?.remove(ctx(), { ...link, externalId: "gone000000000" });
    // A booking that has started: Square's cancellation window for a customer has closed.
    const past = (await def.bookings?.put(ctx(), booking({ itemId: "01JPAST", start: H(20) }), null)) as LinkState;
    const b = sq.bookings.get(String(past.externalId));
    if (b) b.start = Date.now() - DAY;
    const e = await refusal(def.bookings?.remove(ctx(), past) ?? Promise.resolve());
    expect(e.code).toBe("refused");
    expect(e.message).toBe(
      "Square would not cancel it: The cancellation period for this booking has ended. Cancel it in Square.",
    );
    // As the seller, Square lets it go.
    const seller = await connected({ appointments: "plus" });
    const own = (await seller.def.bookings?.put(seller.ctx(), booking(), null)) as LinkState;
    await seller.def.bookings?.remove(seller.ctx(), own);
    expect(seller.sq.bookings.get(String(own.externalId))?.status).toBe("CANCELLED_BY_SELLER");
  });

  it("refuses in plain words what Square cannot take, before it writes anything", async () => {
    const { sq, def, ctx } = await connected({ appointments: "plus" });
    const none = await refusal(
      def.bookings?.put(ctx(), booking({ durationMin: 50, serviceName: "Fade" }), null) ?? Promise.resolve(),
    );
    expect(none.message).toBe("No Square service here is 50 minutes long. Add one in Square.");
    // A haircut and a scalp massage are both 45 minutes: a 45-minute fade is no guess.
    const two = await refusal(def.bookings?.put(ctx(), booking({ serviceName: "Fade" }), null) ?? Promise.resolve());
    expect(two.message).toBe("Several Square services are 45 minutes long. In Square, name one Fade, as it is here.");
    const closed = await refusal(def.bookings?.put(ctx(), booking({ start: H(23) }), null) ?? Promise.resolve());
    expect(closed.message).toContain("Square has nobody free for Haircut");
    expect(sq.bookings.size).toBe(0);
  });

  it("says a location needs its phone number before a booking is refused for it, and never asks for the customer's", async () => {
    const { sq, def, made, ctx } = await connected({ appointments: "plus", locationPhone: null });
    expect(made.choices?.[0]?.options.map((o) => o.name)).toEqual([
      "Queen Street West · add a phone in Square to take bookings",
      "Danforth · add a phone in Square to take bookings",
    ]);
    // One location: still drawn, to say so.
    const one = await connected({ appointments: "plus", locationPhone: null, locations: 1 });
    expect(one.made.choices?.[0]).toMatchObject({
      key: "location",
      options: [{ name: "Queen Street West · add a phone in Square to take bookings" }],
    });
    const e = await refusal(def.bookings?.put(ctx(), booking(), null) ?? Promise.resolve());
    expect(e.message).toBe(
      "Square needs a phone number for bookings. Add your business's number to this location in Square (Dashboard → Locations), then confirm again.",
    );
    expect(sq.customers.size).toBe(0);
  });
});

describe("the catalogue", () => {
  it("brings in each variation priced and counted at the location, and keeps off sale what is not sold there", async () => {
    const { def, ctx } = await connected({ seller: "melbourne" });
    const products = [];
    let cursor: string | null = null;
    do {
      const page: Page = await def.catalogue?.page(ctx(), { cursor, since: null });
      products.push(...(page?.products ?? []));
      cursor = page?.cursor ?? null;
    } while (cursor);
    expect(products.map((p) => [p.externalId, p.name, p.price?.value ?? null, p.stock, p.available])).toEqual([
      ["VARFLATWHITEREG0", "Flat white · Regular", 500, null, true],
      ["VARFLATWHITELRG0", "Flat white · Large", 580, null, true],
      ["VARBANANABREAD00", "Banana bread", 650, 12, true],
      // Priced at the till: no price, never one guessed.
      ["VARSEASONALTART0", "Seasonal tart", null, null, true],
      ["VARLAMINGTON0000", "Lamington", 450, null, false],
      ["VAROLDMUFFIN0000", "Old muffin", 400, null, false],
      ["VARFITZROYONLY00", "Fitzroy toastie", 1_200, null, false],
    ]);
    expect(products[0]).toMatchObject({
      sku: "FW-R",
      description: "Double ristretto, steamed milk.",
      price: { currency: "AUD" },
    });
  });

  it("follows the location the owner chooses: its own prices, and what is sold only there", async () => {
    const { def, ctx } = await connected({ seller: "melbourne" });
    const read = async (c: RunContext) => {
      const out = [];
      let cursor: string | null = null;
      do {
        const page: Page = await def.catalogue?.page(c, { cursor, since: null });
        out.push(...(page?.products ?? []));
        cursor = page?.cursor ?? null;
      } while (cursor);
      return out;
    };
    const fitzroy = await read(ctx({ choices: { location: "L4MELB0URNEFTZR", team: null } }));
    expect(fitzroy.find((p) => p.externalId === "VARFLATWHITELRG0")?.price?.value).toBe(620);
    expect(fitzroy.find((p) => p.externalId === "VARFITZROYONLY00")?.available).toBe(true);
  });

  it("reads what changed since: the items, then the stock counts that changed on their own", async () => {
    const { sq, def, ctx } = await connected({ seller: "melbourne" });
    const since = Date.parse("2026-10-19T00:00:00Z");
    sq.stock.set("VARBANANABREAD00", { quantity: 3, at: "2026-10-20T09:30:00Z" });
    const first = await def.catalogue?.page(ctx(), { cursor: null, since });
    expect(first?.products).toEqual([]);
    expect(first?.cursor).toBe("i:");
    const asked = body(sq, "POST", "/v2/catalog/search").at(-1);
    expect(asked).toMatchObject({
      object_types: ["ITEM", "ITEM_VARIATION"],
      begin_time: "2026-10-19T00:00:00Z",
      include_deleted_objects: true,
      include_related_objects: true,
    });
    const stock = await def.catalogue?.page(ctx(), { cursor: first?.cursor ?? null, since });
    expect(stock?.products.map((p) => [p.externalId, p.stock])).toEqual([["VARBANANABREAD00", 3]]);
    expect(stock?.cursor).toBeNull();
  });

  it("takes a variation off sale within minutes when it is taken off its item", async () => {
    const { sq, def, ctx } = await connected({ seller: "melbourne" });
    const since = Date.parse("2026-10-19T00:00:00Z");
    // The large flat white is deleted in Square: it leaves the item's list, and its item is unchanged.
    const flat = sq.items.find((i) => i.id === "ITMFLATWHITE0000") as { item_data: { variations: { id: string }[] } };
    const [large] = flat.item_data.variations.filter((v) => v.id === "VARFLATWHITELRG0");
    flat.item_data.variations = flat.item_data.variations.filter((v) => v.id !== "VARFLATWHITELRG0");
    sq.variationChanges.push({ ...large, is_deleted: true, updated_at: "2026-10-20T08:15:00.000Z" });
    const page = await def.catalogue?.page(ctx(), { cursor: null, since });
    expect(page?.products.map((p) => [p.externalId, p.name, p.available])).toEqual([
      ["VARFLATWHITELRG0", "Flat white · Large", false],
    ]);
  });

  it("prices a shop in yen exactly, in hundredths: ¥12,800 is 1280000", async () => {
    const { def, ctx } = await connected({ seller: "osaka" });
    const page = await def.catalogue?.page(ctx(), { cursor: null, since: null });
    expect(page?.products.map((p) => [p.name, p.price, p.available])).toEqual([
      ["三徳包丁 Santoku · 165 mm", { value: 1_280_000, currency: "JPY" }, true],
      ["土鍋 Donabe · 2 people", { value: 680_000, currency: "JPY" }, true],
    ]);
  });

  it("reads a page past the client's usual 2 MB: a catalogue never stops on one large page", async () => {
    const { sq, def, ctx } = await connected({ seller: "melbourne" });
    const long = "Single origin, washed, from a cooperative in the highlands. ".repeat(45_000);
    expect(long.length).toBeGreaterThan(2 * 1024 * 1024);
    sq.items.unshift({
      type: "ITEM",
      id: "ITMSINGLEORIGIN0",
      updated_at: "2026-10-01T06:00:00.000Z",
      version: 1759300000000,
      is_deleted: false,
      present_at_all_locations: true,
      item_data: {
        name: "Single origin beans",
        product_type: "REGULAR",
        description_plaintext: long,
        variations: [
          {
            type: "ITEM_VARIATION",
            id: "VARSINGLEORIG250",
            is_deleted: false,
            present_at_all_locations: true,
            item_variation_data: {
              item_id: "ITMSINGLEORIGIN0",
              name: "250 g",
              pricing_type: "FIXED_PRICING",
              price_money: { amount: 2_400, currency: "AUD" },
              sellable: true,
            },
          },
        ],
      },
    });
    const page = await def.catalogue?.page(ctx(), { cursor: null, since: null });
    const beans = page?.products.find((p) => p.externalId === "VARSINGLEORIG250");
    expect(beans).toMatchObject({ name: "Single origin beans · 250 g", price: { value: 2_400, currency: "AUD" } });
    expect(beans?.description?.length).toBe(5_000);
  });
});

function order(over: Partial<ShopOrder> = {}): ShopOrder {
  return {
    lines: [
      {
        externalId: "VARARGANSHAMP250",
        sku: "ARG-250",
        name: "Argan shampoo",
        quantity: 2,
        unit: { value: 2_800, currency: "CAD" },
      },
      { externalId: null, sku: null, name: "Gift wrapping", quantity: 1, unit: { value: 500, currency: "CAD" } },
    ],
    charges: null,
    total: { value: 6_100, currency: "CAD" },
    delivery: "pickup",
    when: null,
    customer: { name: "Sofía Ramírez", email: "sofia@example.com", phone: "+1 647 555 0199", language: "es" },
    shipping: null,
    billing: null,
    note: "Ring when it's ready, please.",
    ...over,
  };
}

function payRequest(over: Partial<PayLinkRequest> = {}): PayLinkRequest {
  return {
    ref: "01JREFLUMIERE00000000000A1",
    itemId: "01JORDERLUMIERE00000000001",
    amount: { value: 6_100, currency: "CAD" },
    title: "Argan shampoo and 1 more (7KQ2MX)",
    reference: "7KQ2MX",
    language: "en",
    thanks: "Thank you",
    inactive: "This link is closed",
    hookUrl: "",
    order: order(),
    ...over,
  };
}

describe("orders paid at the seller's own Square checkout", () => {
  it("writes the order and its link in one call: catalogue items by id, the rest by name, a pickup, and never a fee", async () => {
    const { sq, def, ctx } = await connected();
    const link = await def.payments?.createLink(ctx(), payRequest());
    const [made] = [...sq.orders.values()];
    expect(link).toEqual({
      externalId: `${[...sq.links.keys()][0]}:${made?.id}`,
      url: [...sq.links.values()][0]?.url,
      total: { value: 6_100, currency: "CAD" },
      dashboardUrl: "https://app.squareup.com/dashboard",
    });
    const sent = body(sq, "POST", "/v2/online-checkout/payment-links")[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      idempotency_key: "01JREFLUMIERE00000000000A1",
      order: {
        location_id: sq.location,
        reference_id: "01JREFLUMIERE00000000000A1",
        line_items: [
          { catalog_object_id: "VARARGANSHAMP250", quantity: "2" },
          { name: "Gift wrapping", quantity: "1", base_price_money: { amount: 500, currency: "CAD" } },
        ],
        pricing_options: { auto_apply_taxes: true, auto_apply_discounts: false },
        fulfillments: [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickup_details: {
              schedule_type: "ASAP",
              recipient: {
                display_name: "Sofía Ramírez",
                email_address: "sofia@example.com",
                phone_number: "+16475550199",
              },
              note: "From your customer: Ring when it's ready, please.",
            },
          },
        ],
      },
      pre_populated_data: { buyer_email: "sofia@example.com", buyer_phone_number: "+16475550199" },
    });
    // The catalogue line carries no price of the inbox's: Square prices its own item.
    expect((sent.order as { line_items: Record<string, unknown>[] }).line_items[0]).not.toHaveProperty(
      "base_price_money",
    );
    // The seller is the merchant: nothing asks Square for a fee.
    expect(JSON.stringify(sq.platform.seen.map((r) => r.body))).not.toMatch(/app_fee/);
  });

  it("schedules a pickup at its time, ships a delivery to its address, and names an erased customer by the order only", async () => {
    const { sq, def, ctx } = await connected();
    const at = new Date(H(17)).toISOString();
    await def.payments?.createLink(
      ctx(),
      payRequest({ ref: "01JREF000000000000000000B1", order: order({ when: at }) }),
    );
    await def.payments?.createLink(
      ctx(),
      payRequest({
        ref: "01JREF000000000000000000B2",
        order: order({
          delivery: "delivery",
          shipping: {
            streetAddress: "88 Ossington Ave",
            addressLocality: "Toronto",
            addressRegion: "ON",
            postalCode: "M6J 2Y7",
            addressCountry: "ca",
          },
        }),
      }),
    );
    await def.payments?.createLink(
      ctx(),
      payRequest({
        ref: "01JREF000000000000000000B3",
        order: order({ customer: { name: null, email: null, phone: null, language: "en" }, note: null }),
      }),
    );
    const sent = body(sq, "POST", "/v2/online-checkout/payment-links") as {
      order: { fulfillments: Record<string, Record<string, unknown>>[] };
      pre_populated_data?: unknown;
    }[];
    expect(sent[0]?.order.fulfillments[0]?.pickup_details).toMatchObject({ schedule_type: "SCHEDULED", pickup_at: at });
    expect(sent[1]?.order.fulfillments[0]).toMatchObject({
      type: "SHIPMENT",
      shipment_details: {
        recipient: {
          display_name: "Sofía Ramírez",
          address: {
            address_line_1: "88 Ossington Ave",
            locality: "Toronto",
            administrative_district_level_1: "ON",
            postal_code: "M6J 2Y7",
            country: "CA",
          },
        },
      },
    });
    expect(sent[2]?.order.fulfillments[0]?.pickup_details).toMatchObject({
      recipient: { display_name: "Order 7KQ2MX" },
    });
    expect(sent[2]).not.toHaveProperty("pre_populated_data");
  });

  it("answers Square's own total, its tax included, so a link the customer did not accept is held", async () => {
    const { sq, def, ctx } = await connected();
    sq.taxRate = 0.13;
    const link = await def.payments?.createLink(ctx(), payRequest());
    expect(link?.total).toEqual({ value: 6_893, currency: "CAD" });
  });

  it("never answers a link without Square's total: one it cannot read back is not sent unchecked", async () => {
    const { sq, def, ctx } = await connected();
    sq.relatedOrders = false;
    sq.platform.fail("GET", `${PRODUCTION}/v2/orders/*`, 404);
    const e = await refusal(def.payments?.createLink(ctx(), payRequest()) ?? Promise.resolve());
    expect(e).toMatchObject({ code: "bad_response", message: "Square did not say what the order comes to." });
  });

  it("writes an order in yen as Square counts it, whole yen, and reads it back in hundredths", async () => {
    const { sq, def, ctx } = await connected({ seller: "osaka" });
    const yen = (value: number) => ({ value, currency: "JPY" });
    const request = payRequest({
      ref: "01JREFOSAKA000000000000001",
      amount: yen(1_330_000),
      order: order({
        lines: [
          {
            externalId: "VARSANTOKU165MM0",
            sku: "SNT-165",
            name: "三徳包丁 Santoku",
            quantity: 1,
            unit: yen(1_280_000),
          },
          { externalId: null, sku: null, name: "Gift wrapping", quantity: 1, unit: yen(50_000) },
        ],
        total: yen(1_330_000),
        customer: { name: "佐藤 陽菜", email: "hina@example.jp", phone: "+81 90 5555 0147", language: "ja" },
      }),
    });
    const link = await def.payments?.createLink(ctx(), request);
    const sent = body(sq, "POST", "/v2/online-checkout/payment-links")[0] as {
      order: { line_items: Record<string, unknown>[] };
    };
    expect(sent.order.line_items[1]).toMatchObject({ base_price_money: { amount: 500, currency: "JPY" } });
    expect(link?.total).toEqual(yen(1_330_000));
    const orderId = String(link?.externalId).split(":")[1] ?? "";
    sq.pay(orderId);
    const [fact] =
      (await def.payments?.check(ctx(), { ref: request.ref, externalId: String(link?.externalId), itemId: "x" })) ?? [];
    expect(fact?.amount).toEqual(yen(1_330_000));
    // A fraction of a yen is no price Square takes: refused before Square is asked.
    const e = await refusal(
      def.payments?.createLink(
        ctx(),
        payRequest({
          ref: "01JREFOSAKA000000000000002",
          amount: yen(50_050),
          order: order({
            lines: [{ externalId: null, sku: null, name: "Furoshiki", quantity: 1, unit: yen(50_050) }],
            total: yen(50_050),
          }),
        }),
      ) ?? Promise.resolve(),
    );
    expect(e).toMatchObject({ code: "config" });
    expect(sq.orders.size).toBe(1);
  });

  it("makes the same link again for the same order, and refuses an order in another currency than the location's", async () => {
    const { sq, def, ctx } = await connected();
    const one = await def.payments?.createLink(ctx(), payRequest());
    const two = await def.payments?.createLink(ctx(), payRequest());
    expect(two?.externalId).toBe(one?.externalId);
    expect(sq.orders.size).toBe(1);
    const e = await refusal(
      def.payments?.createLink(ctx(), payRequest({ ref: "01JREFUSD", amount: { value: 6_100, currency: "USD" } })) ??
        Promise.resolve(),
    );
    expect(e).toMatchObject({ code: "config" });
    expect(e.message).toContain("sells in CAD");
  });

  it("marks paid only what Square, asked back, says went through on that very order", async () => {
    const { sq, def, ctx } = await connected();
    const link = await def.payments?.createLink(ctx(), payRequest());
    const known = { ref: "01JREFLUMIERE00000000000A1", externalId: link?.externalId ?? null, itemId: "01JORDER" };
    expect(await def.payments?.check(ctx(), known)).toEqual([]);
    const orderId = [...sq.orders.keys()][0] ?? "";
    const paymentId = sq.pay(orderId, { method: "WALLET" });
    const [fact] = (await def.payments?.check(ctx(), known)) ?? [];
    expect(fact).toMatchObject({
      status: "paid",
      ref: "01JREFLUMIERE00000000000A1",
      paymentId,
      amount: { value: 6_100, currency: "CAD" },
      method: "apple_pay",
      livemode: true,
    });
    // An order another link made: nothing of it is taken for this one.
    expect(await def.payments?.check(ctx(), { ...known, ref: "01JSOMEOTHERREF" })).toEqual([]);
  });

  it("closes a link by deleting it, which cancels its order; never one paid just before, which Square would cancel too", async () => {
    const { sq, def, ctx } = await connected();
    const link = await def.payments?.createLink(ctx(), payRequest());
    await def.payments?.closeLink(ctx(), { externalId: String(link?.externalId) });
    expect([...sq.orders.values()][0]?.state).toBe("CANCELED");
    await def.payments?.closeLink(ctx(), { externalId: String(link?.externalId) });
    // The customer pays a moment before the inbox closes the link: the order is read first, and left paid.
    const paid = await def.payments?.createLink(ctx(), payRequest({ ref: "01JREFPAID000000000000000" }));
    const [linkId, orderId] = String(paid?.externalId).split(":");
    sq.pay(orderId ?? "");
    await def.payments?.closeLink(ctx(), { externalId: String(paid?.externalId) });
    expect(sq.orders.get(orderId ?? "")?.state).toBe("OPEN");
    expect(sq.links.has(linkId ?? "")).toBe(true);
    expect(sq.platform.seen.filter((r) => r.method === "DELETE" && r.url.pathname.endsWith(linkId ?? ""))).toHaveLength(
      0,
    );
  });

  it("follows the order in Square: ready, picked up, cancelled, shipped with its tracking, refunded", async () => {
    const { sq, def, ctx } = await connected();
    const link = await def.payments?.createLink(ctx(), payRequest());
    const known = { ref: "01JREFLUMIERE00000000000A1", externalId: String(link?.externalId), itemId: "01JORDER" };
    const orderId = known.externalId.split(":")[1] ?? "";
    expect(await def.payments?.orderState?.(ctx(), known)).toBeNull();
    const paymentId = sq.pay(orderId);
    sq.fulfil(orderId, "PREPARED");
    expect(await def.payments?.orderState?.(ctx(), known)).toMatchObject({ state: "fulfilled", ref: known.ref });
    sq.fulfil(orderId, "COMPLETED");
    // Polled, one step at a time: picked up is said as ready; the webhook says the rest.
    expect(await def.payments?.orderState?.(ctx(), known)).toMatchObject({ state: "fulfilled" });
    sq.refund(orderId, 2_800);
    expect(await def.payments?.refunded?.(ctx(), { paymentId })).toMatchObject({
      amount: { value: 2_800, currency: "CAD" },
    });

    const shipped = await def.payments?.createLink(
      ctx(),
      payRequest({ ref: "01JREFSHIP0000000000000000", order: order({ delivery: "delivery" }) }),
    );
    const shippedId = String(shipped?.externalId).split(":")[1] ?? "";
    sq.pay(shippedId);
    sq.fulfil(shippedId, "COMPLETED", { carrier: "Canada Post", tracking_number: "7023 2108 4410 9853" });
    expect(
      await def.payments?.orderState?.(ctx(), {
        ref: "01JREFSHIP0000000000000000",
        externalId: String(shipped?.externalId),
        itemId: "x",
      }),
    ).toMatchObject({ state: "fulfilled", tracking: { carrier: "Canada Post", number: "7023 2108 4410 9853" } });

    const dropped = await def.payments?.createLink(ctx(), payRequest({ ref: "01JREFDROP0000000000000000" }));
    const droppedOrder = sq.orders.get(String(dropped?.externalId).split(":")[1] ?? "");
    if (droppedOrder) droppedOrder.state = "CANCELED";
    expect(
      await def.payments?.orderState?.(ctx(), {
        ref: "01JREFDROP0000000000000000",
        externalId: String(dropped?.externalId),
        itemId: "x",
      }),
    ).toMatchObject({ state: "cancelled" });
  });

  it("says a Sandbox payment is a test one", async () => {
    const { sq, def, ctx } = await connected({}, {}, SANDBOX_TOKEN);
    const link = await def.payments?.createLink(ctx(), payRequest());
    sq.pay(String(link?.externalId).split(":")[1] ?? "");
    const [fact] =
      (await def.payments?.check(ctx(), {
        ref: "01JREFLUMIERE00000000000A1",
        externalId: String(link?.externalId),
        itemId: "x",
      })) ?? [];
    expect(fact?.livemode).toBe(false);
    expect(def.payments?.dashboardUrl(ctx(), "test")).toBe("https://developer.squareup.com/apps");
  });
});

describe("webhooks at the connection's own address", () => {
  it("checks Square's own documented example: the address and the body, HMAC-SHA-256, base64", async () => {
    const { def, ctx } = await connected();
    const docs = ctx({
      secret: { access_token: TOKEN, signature_key: "asdf1234" },
      extra: { ...ctx().extra, notificationUrl: "https://example.com/webhook" },
    });
    const signature = "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=";
    expect(await hmacSha256Base64("asdf1234", 'https://example.com/webhook{"hello":"world"}')).toBe(signature);
    // Signed, but no event Square names: answered, nothing kept.
    expect(
      await def.hooks?.verify(
        docs,
        inbound({ body: '{"hello":"world"}', headers: { "x-square-hmacsha256-signature": signature } }),
      ),
    ).toBeNull();
    const off = `${signature.slice(0, 5)}${signature[5] === "A" ? "B" : "A"}${signature.slice(6)}`;
    await expect(
      def.hooks?.verify(
        docs,
        inbound({ body: '{"hello":"world"}', headers: { "x-square-hmacsha256-signature": off } }),
      ),
    ).rejects.toMatchObject({ code: "refused" });
    // Signed for another address: refused.
    await expect(
      def.hooks?.verify(
        ctx({ secret: { access_token: TOKEN, signature_key: "asdf1234" } }),
        inbound({ body: '{"hello":"world"}', headers: { "x-square-hmacsha256-signature": signature } }),
      ),
    ).rejects.toMatchObject({ code: "refused" });
  });

  it("keeps only ids, reads a payment back before believing it, and ignores another seller's event", async () => {
    const { sq, def, ctx } = await connected();
    const link = await def.payments?.createLink(ctx(), payRequest());
    const orderId = String(link?.externalId).split(":")[1] ?? "";
    // A body that says COMPLETED for an order Square still has unpaid.
    const lying = await sq.event("payment.updated", {
      type: "payment",
      id: "PAYLYING000000000000",
      object: {
        payment: {
          id: "PAYLYING000000000000",
          order_id: orderId,
          status: "COMPLETED",
          buyer_email_address: "sofia@example.com",
        },
      },
    });
    const event = await def.hooks?.verify(ctx(), inbound(lying));
    expect(event).toEqual({
      eventId: expect.any(String),
      topic: "payment.updated",
      refs: ["payment:PAYLYING000000000000", `order:${orderId}`],
    });
    expect(JSON.stringify(event)).not.toContain("sofia");
    expect(await def.hooks?.read(ctx(), event as NonNullable<typeof event>)).toEqual([]);

    const paymentId = sq.pay(orderId);
    const paid = await sq.event("payment.updated", {
      type: "payment",
      id: paymentId,
      object: { payment: { id: paymentId, order_id: orderId, status: "COMPLETED" } },
    });
    const facts = await def.hooks?.read(
      ctx(),
      (await def.hooks?.verify(ctx(), inbound(paid))) as NonNullable<typeof event>,
    );
    expect(facts).toEqual([
      {
        kind: "payment",
        fact: expect.objectContaining({ status: "paid", paymentId, ref: "01JREFLUMIERE00000000000A1", linkId: null }),
      },
    ]);

    const elsewhere = await sq.event(
      "payment.updated",
      { type: "payment", id: paymentId },
      { merchant: "MLROTHERSELLER00" },
    );
    expect(await def.hooks?.verify(ctx(), inbound(elsewhere))).toBeNull();
    const tampered = await sq.event("payment.updated", { type: "payment", id: paymentId }, { tamper: true });
    await expect(def.hooks?.verify(ctx(), inbound(tampered))).rejects.toBeInstanceOf(ConnectorError);
  });

  it("turns a picked-up order, a refund, a booking and a catalogue change into what the inbox applies", async () => {
    const { sq, def, ctx } = await connected();
    const link = await def.payments?.createLink(ctx(), payRequest());
    const orderId = String(link?.externalId).split(":")[1] ?? "";
    sq.pay(orderId);
    sq.fulfil(orderId, "COMPLETED");
    const read = async (type: string, data: Record<string, unknown>) => {
      const e = await def.hooks?.verify(ctx(), inbound(await sq.event(type, data)));
      return e ? def.hooks?.read(ctx(), e) : null;
    };
    const picked = await read("order.fulfillment.updated", {
      type: "order_fulfillment_updated",
      id: orderId,
      object: { order_fulfillment_updated: { order_id: orderId, state: "COMPLETED" } },
    });
    expect(picked?.map((f) => (f.kind === "order" ? f.fact.state : f.kind))).toEqual([
      "payment",
      "fulfilled",
      "delivered",
    ]);
    const refundId = sq.refund(orderId, 6_100);
    const refunded = await read("refund.updated", {
      type: "refund",
      id: refundId,
      object: { refund: { id: refundId, status: "COMPLETED" } },
    });
    expect(refunded).toContainEqual({
      kind: "order",
      fact: expect.objectContaining({ state: "refunded", refunded: { value: 6_100, currency: "CAD" } }),
    });
    expect(
      await read("booking.created", { type: "booking", id: "bk000123:0", object: { booking: { id: "bk000123" } } }),
    ).toEqual([{ kind: "busy" }]);
    expect(
      await read("catalog.version.updated", { object: { catalog_version: { updated_at: "2026-10-20T10:00:00Z" } } }),
    ).toEqual([{ kind: "catalogue", externalIds: "all" }]);
    expect(
      await read("inventory.count.updated", {
        type: "inventory",
        id: "x",
        object: { inventory_counts: [{ catalog_object_id: "VARARGANSHAMP250", quantity: "6" }] },
      }),
    ).toEqual([{ kind: "catalogue", externalIds: ["VARARGANSHAMP250"] }]);
  });

  it("believes access withdrawn only once Square, asked with the token, no longer takes it", async () => {
    const { sq, def, ctx } = await connected();
    const revoked = await sq.event("oauth.authorization.revoked", {
      type: "revocation",
      object: { revocation: { revoker_type: "MERCHANT" } },
    });
    const e = (await def.hooks?.verify(ctx(), inbound(revoked))) as NonNullable<
      Awaited<ReturnType<NonNullable<typeof def.hooks>["verify"]>>
    >;
    expect(await def.hooks?.read(ctx(), e)).toEqual([]);
    sq.tokens.production = "EAAAsomethingelseentirely0000";
    expect(await def.hooks?.read(ctx(), e)).toEqual([{ kind: "revoked" }]);
  });
});

describe("the webhook, kept in step", () => {
  it("tries one Square would not make again an hour on, never on every sync", async () => {
    const { sq, def, ctx } = await connected({}, { hooksLive: false });
    sq.platform.fail("POST", `${PRODUCTION}/v2/webhooks/subscriptions`, 403);
    const fresh = await def.refresh?.(ctx());
    expect(sq.subscriptions.size).toBe(0);
    const now = Date.now();
    expect(fresh?.extra).toMatchObject({ hooks: "pending", hooksTriedAt: expect.any(Number) });
    const after = (ms: number) => ctx({ extra: fresh?.extra ?? {}, now: now + ms });
    expect(def.stale?.(after(10 * 60_000))).toBe(false);
    expect(def.stale?.(after(61 * 60_000))).toBe(true);
    const again = await def.refresh?.(after(61 * 60_000));
    expect(sq.subscriptions.size).toBe(1);
    expect(again?.extra).toMatchObject({ hooks: "added" });
    expect(again?.extra).not.toHaveProperty("hooksTriedAt");
  });

  it("makes one subscription however often a lost answer is retried, and takes away the others it made", async () => {
    const { sq, def, ctx } = await connected({}, { hooksLive: false });
    // One an earlier connection of this inbox left behind, at its own address.
    sq.subscriptions.set("wbhk_leftover", {
      id: "wbhk_leftover",
      notification_url: `${INBOX.origin}/v1/hooks/square/OldTokenOldTokenOldTokenOldTokenOldToken000`,
      enabled: true,
      signature_key: "old",
    });
    await def.refresh?.(ctx());
    // The answer was lost: the run saw nothing, and tries again as it was.
    await def.refresh?.(ctx());
    expect([...sq.subscriptions.values()].map((x) => x.notification_url)).toEqual([HOOK_URL]);
    const keys = body(sq, "POST", "/v2/webhooks/subscriptions").map((b) => b.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("takes the new key when the owner makes one in the Developer Console", async () => {
    const { sq, def, ctx, held } = await connected();
    const [sub] = [...sq.subscriptions.values()];
    if (!sub) throw new Error("no subscription");
    sub.signature_key = "NewKeyMadeInTheConsole";
    await def.refresh?.(ctx());
    expect(held.secret.signature_key).toBe("NewKeyMadeInTheConsole");
    const paid = await sq.event("catalog.version.updated", { object: { catalog_version: {} } });
    expect(await def.hooks?.verify(ctx({ secret: held.secret }), inbound(paid))).toMatchObject({
      topic: "catalog.version.updated",
    });
  });
});

describe("disconnecting", () => {
  it("removes the webhook it made", async () => {
    const { sq, def, ctx } = await connected();
    expect(sq.subscriptions.size).toBe(1);
    await def.disconnect?.(ctx());
    expect(sq.subscriptions.size).toBe(0);
  });
});

describe("Sign in with Square", () => {
  it("is set up on one's own server with an app, soon on a hosted inbox until ours exists, while the token works everywhere", () => {
    const ways = (defs: ReturnType<typeof builtInConnectors>) =>
      gallery(new Map(defs.map((d) => [d.kind, d])))
        .find((c) => c.id === "square")
        ?.ways.map((w) => [w.label, w.status, w.hint ?? null]);
    // What can be pressed comes first: the owner's own token until Sign in is ready, then Sign in (one press).
    expect(ways(builtInConnectors())).toEqual([
      ["Access token", "ready", null],
      ["Sign in with Square", "setup", "Needs a Square app on the server."],
    ]);
    expect(ways(builtInConnectors({ hosted: true }))).toEqual([
      ["Access token", "ready", null],
      ["Sign in with Square", "soon", null],
    ]);
    expect(ways(builtInConnectors({ oauth: { square: CLIENT } }))).toEqual([
      ["Sign in with Square", "ready", null],
      ["Access token", "ready", null],
    ]);
    const card = gallery(new Map(builtInConnectors().map((d) => [d.kind, d]))).find((c) => c.id === "square");
    expect(card).toMatchObject({ status: "ready", group: "shops", line: "Bookings, catalogue and payments" });
    expect(card?.ways[0]?.form.map((f) => [f.key, f.secret, f.link?.href])).toEqual([
      ["access_token", true, "https://developer.squareup.com/apps"],
    ]);
  });

  it("sends the owner to Square's own page for the permissions it needs, and keeps the token fresh", async () => {
    const sq = fakeSquare();
    const def = squareConnector(CLIENT);
    const url = new URL(
      def.oauth?.authorizeUrl({
        redirectUri: "https://inbox.lumiere.example.ca/oauth/connect/square/callback",
        state: "st4te",
        challenge: "unused",
      }) ?? "",
    );
    expect(url.origin + url.pathname).toBe(`${PRODUCTION}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT.clientId,
      scope: SQUARE_SCOPES.join(" "),
      session: "false",
      state: "st4te",
      redirect_uri: "https://inbox.lumiere.example.ca/oauth/connect/square/callback",
    });
    // Never a seller-level write, never an application fee.
    expect(SQUARE_SCOPES).not.toContain("APPOINTMENTS_ALL_WRITE");
    const made = await def.oauth?.exchange(connectCtx(sq), {
      code: OAUTH_CODE,
      verifier: "v",
      redirectUri: "https://inbox.lumiere.example.ca/oauth/connect/square/callback",
    });
    expect(made).toMatchObject({
      externalId: sq.merchantId,
      extra: { hooks: "none" },
      secret: { refresh_token: "EQAA-refresh-1" },
    });
    // Square keeps webhook subscriptions for an app's own token: a sign-in hears by polling.
    expect(sq.subscriptions.size).toBe(0);
    if (!made) throw new Error("not made");
    const { ctx, held } = runner(sq, made);
    // Eight days on, the token is renewed before it is used, and the new one saved.
    held.secret.expires_at = new Date(Date.now() + 20 * DAY).toISOString();
    await def.busy?.(ctx({ destination: "VARHAIRCUT45MIN0" }), { start: D0, end: D0 + 2 * DAY });
    expect(held.saved).toBe(1);
    expect(held.secret).toMatchObject({
      access_token: "EAAA-oauth-renewed-0000000000",
      refresh_token: "EQAA-refresh-2",
    });
    const renewed = sq.platform.requests("POST", `${PRODUCTION}/oauth2/token`).at(-1);
    expect(JSON.parse(renewed?.body ?? "{}")).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "EQAA-refresh-1",
    });
    // Disconnecting gives the access back.
    await def.disconnect?.(ctx({ secret: held.secret }));
    expect(sq.platform.requests("POST", `${PRODUCTION}/oauth2/revoke`)).toHaveLength(1);
  });

  it("says plainly when the code is refused or the server lost its app", async () => {
    const sq = fakeSquare();
    const e = await refusal(
      squareConnector(CLIENT).oauth?.exchange(connectCtx(sq), { code: "wrong", verifier: "v", redirectUri: "x" }) ??
        Promise.resolve(),
    );
    expect(e.code).toBe("auth");
    const made = await squareConnector(CLIENT).oauth?.exchange(connectCtx(sq), {
      code: OAUTH_CODE,
      verifier: "v",
      redirectUri: "x",
    });
    if (!made) throw new Error("not made");
    const { ctx, held } = runner(sq, made);
    held.secret.expires_at = new Date(Date.now() + DAY).toISOString();
    const lost = await refusal(squareConnector(null).busy?.(ctx(), { start: D0, end: D0 + DAY }) ?? Promise.resolve());
    expect(lost.message).toContain("no longer has its Square app");
  });
});
