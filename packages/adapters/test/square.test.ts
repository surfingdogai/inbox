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
 * Contract tests for the Square connector (ADR-029) against a made-up seller answering as Square's API
 * documents it (`fixtures/square.ts`), through the inbox's own connector client: what is asked of
 * Square, with which token, and what the inbox makes of the answer. Above all: the token goes to
 * Square's own hosts and nowhere else; a booking's customer is the inbox's own record with the
 * business's phone, so Square never texts the customer; a webhook is believed only once its signature
 * checks out and Square, asked back, says the same; no fee is ever asked. No real Square is called.
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
      extra: { env: "production", merchantId: sq.merchantId, mainLocation: sq.location, hooks: "added" },
    });
    // Choosers, never typed ids: the open locations, and who takes bookings.
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
      },
    ]);
    // Services with their length; one with a cancellation fee is left out (Square refuses it through its API).
    expect(made.destinations.map((d) => [d.id, d.name])).toEqual([
      ["auto", "The service of the same name"],
      ["VARHAIRCUT45MIN0", "Haircut · 45 min"],
      ["VARCOLOURFULL120", "Colour · Full · 120 min"],
      ["VARCOLOURROOTS60", "Colour · Roots · 60 min"],
      ["VARBEARDTRIM30M0", "Beard trim · 30 min"],
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
  });
});

describe("busy times, from what Square would book", () => {
  it("takes off what Square would not book: closed hours, and times nobody is free", async () => {
    const { sq, def, ctx } = await connected();
    // Kwame is with a walk-in from 15:00 to 16:00, Amélie at a training: nobody takes a haircut then.
    sq.blocked.push({ team: "TM_kwame", start: H(15), end: H(16) }, { team: "TM_amelie", start: H(15), end: H(16) });
    const window = { start: D0, end: D0 + 2 * DAY };
    const read = await def.busy?.(ctx({ destination: "VARHAIRCUT45MIN0" }), window);
    const intervals = Array.isArray(read) ? read : (read?.intervals ?? []);
    // Open 14:00 to 22:00 UTC: closed before, a gap at 15:00, closed after.
    expect(intervals.slice(0, 3)).toEqual([
      { start: D0, end: H(14) },
      { start: H(15), end: H(16) },
      { start: H(22), end: H(38) },
    ]);
    // One person away is not busy: the other takes the haircut.
    sq.blocked.splice(1, 1);
    const one = await def.busy?.(ctx({ destination: "VARHAIRCUT45MIN0" }), window);
    expect((Array.isArray(one) ? one : []).slice(0, 2)).toEqual([
      { start: D0, end: H(14) },
      { start: H(22), end: H(38) },
    ]);
    // Asked of Square for that service, at the chosen location, a day at least.
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
    const full = await def.busy?.(ctx({ destination: "VARHAIRCUT45MIN0" }), { start: D0, end: D0 + 92 * DAY });
    expect(Array.isArray(full)).toBe(true);
    const ranges = body(sq, "POST", "/v2/bookings/availability/search").map((b) => {
      const r = (b as { query: { filter: { start_at_range: { start_at: string; end_at: string } } } }).query.filter
        .start_at_range;
      return (Date.parse(r.end_at) - Date.parse(r.start_at)) / DAY;
    });
    expect(ranges).toEqual([31, 31, 30]);
    const far = await def.busy?.(ctx({ destination: "VARHAIRCUT45MIN0" }), { start: D0, end: D0 + 120 * DAY });
    expect(far).toMatchObject({ until: D0 + 93 * DAY });
  });
});

describe("bookings written into Square", () => {
  it("books who Square says is free, for the inbox's own customer record, with the business's phone and no email", async () => {
    const { sq, def, ctx } = await connected();
    const link = await def.bookings?.put(ctx(), booking(), null);
    expect(link).toMatchObject({ calendar: "VARHAIRCUT45MIN0", start: H(15), end: H(15, 45) });
    const made = sq.bookings.get(String(link?.externalId));
    expect(made).toMatchObject({ start: H(15), service: "VARHAIRCUT45MIN0", team: "TM_amelie", status: "ACCEPTED" });
    // Booked as a customer would (Square Appointments Free): the note names who it is for.
    expect(made?.customerNote).toContain("Haircut · Oluwaseun Adeyemi");
    const [holder] = [...sq.customers.values()];
    expect(holder).toMatchObject({ given_name: "Inbox", family_name: "bookings", phone_number: "+1 416-555-0142" });
    expect(holder?.email_address).toBeUndefined();
    expect(made?.customer).toBe(holder?.id);
    // The length is the service's own: never sent by an app that books as a customer.
    const sent = body(sq, "POST", "/v2/bookings")[0] as {
      booking: { appointment_segments: Record<string, unknown>[] };
    };
    expect(sent.booking.appointment_segments[0]).not.toHaveProperty("duration_minutes");
    expect(JSON.stringify(sq.platform.seen.map((r) => r.body))).not.toContain("@");

    // A second booking, the same record: the customer directory is not filled with the inbox.
    await def.bookings?.put(ctx(), booking({ itemId: "01JBOOKINGLUMIERE0000000002", start: H(17) }), null);
    expect(sq.customers.size).toBe(1);
  });

  it("finds a booking a stopped run made, and a retry makes no second one", async () => {
    const { sq, def, ctx } = await connected();
    const first = await def.bookings?.put(ctx(), booking(), null);
    const retried = await def.bookings?.put(ctx(), booking(), null);
    expect(retried?.externalId).toBe(first?.externalId);
    expect(sq.bookings.size).toBe(1);
    const found = await def.bookings?.find?.(ctx(), booking());
    expect(found?.externalId).toBe(first?.externalId);
    expect(await def.bookings?.find?.(ctx(), booking({ start: H(19) }))).toBeNull();
  });

  it("moves a booking in place when its team member is free then, and otherwise books anew before letting the old one go", async () => {
    const { sq, def, ctx } = await connected();
    const link = (await def.bookings?.put(ctx(), booking(), null)) as LinkState;
    const moved = await def.bookings?.put(ctx(), booking({ start: H(16) }), link);
    expect(moved?.externalId).toBe(link.externalId);
    expect(sq.bookings.get(String(link.externalId))).toMatchObject({ start: H(16), version: 1, status: "ACCEPTED" });
    // Amélie is away at 18:00; Kwame is free: a new booking with him, and the old one cancelled after.
    sq.blocked.push({ team: "TM_amelie", start: H(18), end: H(19) });
    const again = await def.bookings?.put(ctx(), booking({ start: H(18) }), moved as LinkState);
    expect(again?.externalId).not.toBe(link.externalId);
    expect(sq.bookings.get(String(again?.externalId))).toMatchObject({ start: H(18), team: "TM_kwame" });
    expect(sq.bookings.get(String(link.externalId))?.status).toBe("CANCELLED_BY_CUSTOMER");
  });

  it("cancels with the booking's version, is done when it was gone, and says when Square's own window has closed", async () => {
    const { sq, def, ctx } = await connected();
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
  });

  it("refuses in plain words what Square cannot take, before it writes anything", async () => {
    const { sq, def, ctx } = await connected();
    const nothing = await refusal(
      def.bookings?.put(ctx(), booking({ durationMin: 50, serviceName: "Fade" }), null) ?? Promise.resolve(),
    );
    expect(nothing.message).toContain("No Square service here is 50 minutes long");
    const chosen = await refusal(
      def.bookings?.put(ctx({ destination: "VARBEARDTRIM30M0" }), booking(), null) ?? Promise.resolve(),
    );
    expect(chosen.message).toContain("Beard trim is 30 minutes in Square");
    const closed = await refusal(def.bookings?.put(ctx(), booking({ start: H(23) }), null) ?? Promise.resolve());
    expect(closed.message).toContain("Square has nobody free for Haircut");
    expect(sq.bookings.size).toBe(0);
  });

  it("asks for the location's phone number when it has none, rather than a customer's", async () => {
    const { sq, def, ctx } = await connected({ locationPhone: null });
    const e = await refusal(def.bookings?.put(ctx(), booking(), null) ?? Promise.resolve());
    expect(e.message).toContain("Add your phone number to this location in Square");
    expect(sq.customers.size).toBe(0);
  });

  it("writes as the seller on Appointments Plus: its own note, which the client never sees", async () => {
    const { sq, def, ctx } = await connected({ appointments: "plus" });
    const link = await def.bookings?.put(ctx(), booking(), null);
    const made = sq.bookings.get(String(link?.externalId));
    expect(made?.sellerNote).toContain("Haircut · Oluwaseun Adeyemi");
    expect(made?.customerNote).toBeUndefined();
    const sent = body(sq, "POST", "/v2/bookings")[0] as {
      booking: { appointment_segments: Record<string, unknown>[] };
    };
    expect(sent.booking.appointment_segments[0]).toMatchObject({ duration_minutes: 45 });
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
    expect(asked).toMatchObject({ begin_time: "2026-10-19T00:00:00Z", include_deleted_objects: true });
    const stock = await def.catalogue?.page(ctx(), { cursor: first?.cursor ?? null, since });
    expect(stock?.products.map((p) => [p.externalId, p.stock])).toEqual([["VARBANANABREAD00", 3]]);
    expect(stock?.cursor).toBeNull();
  });

  it("never prices in a currency not counted in hundredths: a shop in yen comes in off sale", async () => {
    const { def, ctx } = await connected({ seller: "osaka" });
    const page = await def.catalogue?.page(ctx(), { cursor: null, since: null });
    expect(page?.products.map((p) => [p.name, p.price])).toEqual([
      ["三徳包丁 Santoku · 165 mm", null],
      ["土鍋 Donabe · 2 people", null],
    ]);
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

  it("closes a link by deleting it, which cancels its order; one gone or paid is closed already", async () => {
    const { sq, def, ctx } = await connected();
    const link = await def.payments?.createLink(ctx(), payRequest());
    await def.payments?.closeLink(ctx(), { externalId: String(link?.externalId) });
    expect([...sq.orders.values()][0]?.state).toBe("CANCELED");
    await def.payments?.closeLink(ctx(), { externalId: String(link?.externalId) });
    const paid = await def.payments?.createLink(ctx(), payRequest({ ref: "01JREFPAID000000000000000" }));
    sq.pay(String(paid?.externalId).split(":")[1] ?? "");
    await def.payments?.closeLink(ctx(), { externalId: String(paid?.externalId) });
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
    expect(ways(builtInConnectors())).toEqual([
      ["Access token", "ready", null],
      ["Sign in with Square", "setup", "Needs a Square app on the server."],
    ]);
    expect(ways(builtInConnectors({ hosted: true }))).toEqual([
      ["Access token", "ready", null],
      ["Sign in with Square", "soon", null],
    ]);
    expect(ways(builtInConnectors({ oauth: { square: CLIENT } }))).toEqual([
      ["Access token", "ready", null],
      ["Sign in with Square", "ready", null],
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
