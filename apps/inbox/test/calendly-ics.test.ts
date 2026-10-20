import { createApiKey, type OAuthClients } from "@surfingdog/adapters";
import { type ConnectionView, type Db, type HostPolicy, schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import {
  API,
  CLIENT,
  delivery,
  type FakeCalendly,
  fakeCalendly,
  OWNER_EMAIL,
  TOKEN,
} from "../../../packages/adapters/test/fixtures/calendly";
import {
  accountOf,
  bookedTwice,
  isBookingPlatform,
  lengthGaps,
  servesLink,
  tagOf,
} from "../client/src/lib/integrations";
import { createInbox, type Inbox } from "../src/app";
import { confirmed, freshDb, futureDay, nextDay, openWeekdays } from "./harness";

/**
 * Calendly and the calendar link to share (ADR-030), end to end through the doors an owner, a customer
 * and a platform use: a plumber in Cape Town connects Calendly with a personal access token, its
 * Calendly bookings take times off what agents are offered, a booking the owner confirms is made on
 * Calendly in the business's own name, and a signed webhook makes the inbox look again at once. A
 * guesthouse in Kyoto makes a calendar link of its bookings, which the inbox's own calendar link can
 * read without blocking its own times. Calendly is a fake at the fetch level; nothing is called.
 */

const DAY = futureDay(8);
const NEXT = nextDay(DAY);
const SECRET_KEY = "calendly-ics-test-secret-0123456789abcdef";

interface S {
  readonly db: Db;
  readonly inbox: Inbox;
  readonly calendly: FakeCalendly;
  readonly base: string;
  readonly serviceId: string;
  readonly owner: Record<string, string>;
  readonly integration: Record<string, string>;
  readonly pending: Promise<unknown>[];
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

async function setup(opts: {
  base: string;
  business: Record<string, unknown>;
  service: string;
  oauth?: OAuthClients;
  policy?: HostPolicy;
}): Promise<S> {
  const db = await freshDb();
  const calendly = fakeCalendly();
  const pending: Promise<unknown>[] = [];
  const host = new URL(opts.base).host;
  let inbox: Inbox | null = null;
  inbox = createInbox({
    db,
    mailOut: logMailOut(),
    secretKey: SECRET_KEY,
    baseUrl: opts.base,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    ...(opts.oauth ? { oauth: opts.oauth } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    // Calendly is the fake; the inbox's own address is the inbox itself (its calendar link, read back).
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).host === host && inbox
        ? inbox.app.request(new Request(String(input), init))
        : calendly.platform.fetch(input, init)) as typeof fetch,
  });
  const serviceId = ulid();
  const now = Date.now();
  await db.orm.insert(schema.services).values({
    id: serviceId,
    name: opts.service,
    durationMin: 60,
    capacity: 1,
    granularityMin: 30,
    createdAt: now,
    updatedAt: now,
  });
  await openWeekdays(db);
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const integration = { authorization: `Bearer ${(await createApiKey(db, { kind: "integration", name: "n8n" })).key}` };
  const app = inbox;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.app.request(
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
        notifications: { ownerEmail: OWNER_EMAIL, appUrl: opts.base },
        email: { fromAddress: `hello@${host}` },
      },
    },
    owner,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  return { db, inbox: app, calendly, base: opts.base, serviceId, owner, integration, pending, call };
}

async function drain(s: S): Promise<void> {
  await Promise.all(s.pending);
  for (let pass = 0; pass < 40; pass++) {
    if ((await s.inbox.runner.runDue(s.db)).claimed === 0) return;
  }
  throw new Error("the outbox never settled");
}

async function freeTimes(s: S): Promise<string[]> {
  const res = await s.call(
    "GET",
    `/v1/availability?service_id=${s.serviceId}&from=${DAY}T00:00:00Z&to=${NEXT}T00:00:00Z`,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { slots: { startTime: string }[] }).slots.map((x) => x.startTime.slice(11, 16));
}

/** A booking a customer asked for, confirmed by the owner. */
async function booked(s: S, service: string, at: string, contact: Record<string, string>): Promise<string> {
  const made = await confirmed(
    (r) => s.inbox.app.request(r),
    new Request(`${s.base}/v1/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          reservationFor: { serviceId: s.serviceId, name: service },
          startTime: `${DAY}T${at}:00Z`,
          endTime: `${DAY}T${String(Number(at.slice(0, 2)) + 1).padStart(2, "0")}${at.slice(2)}:00Z`,
        },
        contact,
      }),
    }),
  );
  expect(made.status, await made.clone().text()).toBe(201);
  const id = ((await made.json()) as { view: { item: { id: string } } }).view.item.id;
  const ok = await s.call("POST", `/v1/owner/items/${id}/transitions`, { event: "confirm" }, s.owner);
  expect(ok.status, await ok.clone().text()).toBe(200);
  return id;
}

async function eventsKept(db: Db) {
  const { rows } = await db.client.query({
    sql: "SELECT external_id, topic, status, raw FROM connector_events ORDER BY received_at, id",
    method: "all",
  });
  return rows.map((r) => ({ id: String(r[0]), topic: String(r[1]), status: String(r[2]), raw: String(r[3]) }));
}

const CAPE_TOWN = {
  base: "https://inbox.khanyisa.example.com",
  business: {
    name: "Khanyisa Plumbing",
    currency: "ZAR",
    timezone: "Africa/Johannesburg",
    languages: ["en", "xh", "af"],
  },
  service: "Workshop visit",
};

interface Cards {
  cards: {
    id: string;
    title: string;
    line: string;
    status: string;
    ways: {
      kind: string;
      preset: string | null;
      label: string;
      status: string;
      auth: string;
      action: string;
      advanced?: boolean;
      note?: string;
      steps?: string[];
      needs?: { text: string; href: string };
      form: Record<string, unknown>[];
    }[];
  }[];
}

describe("Settings → Integrations", () => {
  it("offers Calendly with a token to paste, and a calendar link to make, both ready", async () => {
    const s = await setup(CAPE_TOWN);
    const body = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as Cards;
    const calendly = body.cards.find((c) => c.id === "calendly");
    // The token is the way in until the server has a Calendly app; signing in says what it needs.
    expect(calendly).toMatchObject({
      status: "ready",
      ways: [
        { kind: "calendly", preset: "oauth", label: "Sign in with Calendly", status: "setup", auth: "oauth" },
        {
          kind: "calendly",
          preset: null,
          label: "Personal access token",
          status: "ready",
          auth: "form",
          advanced: true,
        },
      ],
    });
    expect(calendly?.ways[1]?.note).toBe(
      "Busy times work on every Calendly plan. Adding your bookings to Calendly needs its Standard plan or above.",
    );
    expect(calendly?.ways[1]?.form).toEqual([
      expect.objectContaining({
        key: "token",
        secret: true,
        input: "password",
        link: { href: "https://calendly.com/integrations/api_webhooks", text: expect.any(String) },
        steps: expect.arrayContaining([expect.stringContaining("scheduled_events:write")]),
      }),
    ]);
    const link = body.cards.find((c) => c.id === "ics_feed");
    expect(link).toMatchObject({
      title: "Share your bookings",
      line: "A private calendar link for other sites",
      status: "ready",
      ways: [{ kind: "ics_feed", status: "ready", auth: "link", action: "Make a link", form: [] }],
    });
    expect(link?.ways[0]?.needs).toBeUndefined();
  });

  it("signs in with Calendly first once the server has its Calendly app, the token under More options", async () => {
    const s = await setup({ ...CAPE_TOWN, oauth: { calendly: CLIENT } });
    const body = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as Cards;
    const calendly = body.cards.find((c) => c.id === "calendly");
    expect(calendly?.ways.map((w) => [w.preset, w.status, w.action, w.advanced ?? false])).toEqual([
      ["oauth", "ready", "Continue with Calendly", false],
      [null, "ready", "Connect", true],
    ]);
    const res = await s.call(
      "POST",
      "/v1/owner/integrations/authorize",
      { kind: "calendly", preset: "oauth" },
      s.owner,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const url = new URL(((await res.json()) as { authorize_url: string }).authorize_url);
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.calendly.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT.clientId);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(`${CAPE_TOWN.base}/oauth/connect/calendly/callback`);
  });

  it("never makes a link where other sites cannot fetch it: no https address, or a hosted inbox not live yet", async () => {
    for (const [opts, text] of [
      [
        { ...CAPE_TOWN, base: "http://inbox.khanyisa.example.com" },
        "Booking sites fetch this link from your inbox's own https address. Add it first: Settings → General, Inbox address.",
      ],
      [
        { ...CAPE_TOWN, policy: { hooksLive: false } },
        "Booking sites fetch this link from your inbox's own address. It can be made once your inbox is live there.",
      ],
    ] as const) {
      const s = await setup(opts);
      const body = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as Cards;
      const link = body.cards.find((c) => c.id === "ics_feed");
      expect(link?.line).toBe("Needs this inbox's address first");
      expect(link?.ways[0]?.needs).toEqual({ text, href: "/settings#s-app-url" });
      const made = await s.call("POST", "/v1/owner/integrations", { kind: "ics_feed" }, s.owner);
      expect(made.status).toBe(403);
      expect(((await made.json()) as { detail: string }).detail).toMatch(/fetch this link/);
    }
  });
});

describe("Calendly, end to end", () => {
  it("connects with a token, blocks what is booked on Calendly, and books there in the business's own name", async () => {
    const s = await setup(CAPE_TOWN);
    s.calendly.busy.push({
      type: "calendly",
      start_time: `${DAY}T10:00:00.000000Z`,
      end_time: `${DAY}T11:00:00.000000Z`,
      event: { uri: `${API}/scheduled_events/EVONCALENDLY01` },
    });
    expect(await freeTimes(s)).toContain("10:00");

    // The owner's AI cannot connect it; the owner can.
    const refused = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "calendly", values: { token: TOKEN } },
      s.integration,
    );
    expect(refused.status).toBe(403);
    const res = await s.call("POST", "/v1/owner/integrations", { kind: "calendly", values: { token: TOKEN } }, s.owner);
    expect(res.status, await res.clone().text()).toBe(201);
    const view = (await res.json()) as { id: string; account: string; destination: string; disconnect_note: string };
    expect(view.account).toBe(`Khanyisa Plumbing (${OWNER_EMAIL})`);
    expect(view.disconnect_note).toContain("API & webhooks");
    // Its webhook is at the connection's own address, and the token is in no answer and no row in the clear.
    const [hook] = [...s.calendly.webhooks.values()];
    expect(hook?.url).toMatch(/^https:\/\/inbox\.khanyisa\.example\.com\/v1\/hooks\/calendly\/[A-Za-z0-9_-]{43}$/);
    const listing = await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).text();
    expect(listing).not.toContain(TOKEN);
    expect(listing).not.toContain(String(hook?.signingKey));
    const { rows } = await s.db.client.query({
      sql: "SELECT config_enc, config_public FROM connectors",
      method: "all",
    });
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(rows)).not.toContain(String(hook?.signingKey));

    await s.call("POST", `/v1/owner/integrations/${view.id}/sync`, {}, s.owner);
    await drain(s);
    expect(await freeTimes(s)).not.toContain("10:00");

    // A customer books 14:00; the owner confirms; Calendly holds it under the customer's name, for the business.
    const itemId = await booked(s, "Workshop visit", "14:00", {
      name: "Thandiwe Nkosi",
      email: "thandiwe@example.com",
      locale: "xh-ZA",
    });
    await drain(s);
    const [made] = [...s.calendly.events.entries()];
    expect(made?.[1].body).toMatchObject({
      event_type: `${API}/event_types/ETWORKSHOP60`,
      start_time: `${DAY}T14:00:00Z`,
      invitee: { name: "Thandiwe Nkosi", email: OWNER_EMAIL, timezone: "Africa/Johannesburg" },
    });
    // Calendly is never given the customer's address: it emails whoever it is given.
    for (const r of s.calendly.platform.seen) expect(r.body).not.toContain("thandiwe@");
    const after = (await (await s.call("GET", `/v1/owner/integrations/${view.id}`, undefined, s.owner)).json()) as {
      bookings_written: number;
      status: string;
    };
    expect(after).toMatchObject({ bookings_written: 1, status: "active" });

    // Cancelled in the inbox: cancelled on Calendly.
    const cancelled = await s.call(
      "POST",
      `/v1/owner/items/${itemId}/transitions`,
      { event: "cancel_by_business" },
      s.owner,
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    await drain(s);
    expect(made?.[1].status).toBe("canceled");

    // Disconnected: its webhook goes from Calendly.
    expect((await s.call("DELETE", `/v1/owner/integrations/${view.id}`, undefined, s.owner)).status).toBe(200);
    await drain(s);
    expect(s.calendly.webhooks.size).toBe(0);
  });

  it("takes a signed webhook at once, keeps only ids, reads busy times again, and refuses one byte off", async () => {
    const s = await setup(CAPE_TOWN);
    const res = await s.call("POST", "/v1/owner/integrations", { kind: "calendly", values: { token: TOKEN } }, s.owner);
    expect(res.status, await res.clone().text()).toBe(201);
    await drain(s);
    const [hook] = [...s.calendly.webhooks.values()];
    if (!hook) throw new Error("no webhook");
    const reads = () => s.calendly.platform.requests("GET", `${API}/user_busy_times`).length;
    const before = reads();
    expect(await freeTimes(s)).toContain("15:00");

    // Booked on Calendly just now: the inbox hears it and looks again.
    s.calendly.busy.push({
      type: "calendly",
      start_time: `${DAY}T15:00:00.000000Z`,
      end_time: `${DAY}T16:00:00.000000Z`,
      event: { uri: `${API}/scheduled_events/EVBOOKEDONCAL01` },
    });
    const d = await delivery(hook.signingKey);
    const answer = await s.call("POST", hook.url, d.body, d.headers);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true, duplicate: false });
    await drain(s);
    expect(reads()).toBeGreaterThan(before);
    expect(await freeTimes(s)).not.toContain("15:00");
    const kept = await eventsKept(s.db);
    expect(kept).toEqual([
      { id: "invitee.created:INPIETER000001", topic: "invitee.created", status: "handled", raw: expect.any(String) },
    ]);
    // Ids only: never the name or address in the body.
    expect(kept[0]?.raw).not.toContain("Pieter");
    expect(kept[0]?.raw).not.toContain("@");

    // Sent again (Calendly retries): counted once.
    const again = await s.call("POST", hook.url, d.body, d.headers);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    // One byte off: 400, nothing kept.
    const bad = await delivery(hook.signingKey, { inviteeId: "INOTHER0000001", tamper: true });
    expect((await s.call("POST", hook.url, bad.body, bad.headers)).status).toBe(400);
    // Too old to be fresh.
    const stale = await delivery(hook.signingKey, { inviteeId: "INOTHER0000002", at: Date.now() - 10 * 60_000 });
    expect((await s.call("POST", hook.url, stale.body, stale.headers)).status).toBe(400);
    expect(await eventsKept(s.db)).toHaveLength(1);
  });
});

describe("Calendly on its Free plan, end to end", () => {
  it("connects with busy times on, bookings off, and its line says why, before any booking fails", async () => {
    const s = await setup(CAPE_TOWN);
    s.calendly.stage = "free";
    s.calendly.paid = false;
    const res = await s.call("POST", "/v1/owner/integrations", { kind: "calendly", values: { token: TOKEN } }, s.owner);
    expect(res.status, await res.clone().text()).toBe(201);
    const view = (await res.json()) as ConnectionView;
    expect(view).toMatchObject({ busy_on: true, bookings_on: false, note: "Calendly Free: busy times only" });
    // A booking confirmed now is not sent to Calendly, so nothing fails and nothing is promised.
    await booked(s, "Workshop visit", "09:00", { name: "Lindiwe Dlamini", email: "lindiwe@example.com" });
    await drain(s);
    expect(s.calendly.platform.requests("POST", `${API}/invitees`)).toHaveLength(0);
    const after = (await (
      await s.call("GET", `/v1/owner/integrations/${view.id}`, undefined, s.owner)
    ).json()) as ConnectionView;
    expect(after).toMatchObject({ bookings_failing: 0, note: "Calendly Free: busy times only" });
  });
});

describe("the owner app's words for a connection", () => {
  const conn = (over: Partial<ConnectionView>): ConnectionView =>
    ({
      id: "c1",
      kind: "calendly",
      preset: null,
      title: "Calendly",
      name: "Calendly",
      account: "Khanyisa Plumbing (bookings@khanyisa.example.com)",
      status: "active",
      capabilities: ["busy_times", "write_bookings"],
      busy_on: true,
      bookings_on: true,
      calendars: [],
      busy_calendars: [],
      destinations: [
        { id: "auto", name: "Same length as the booking", writable: true },
        { id: "ETWORKSHOP60", name: "Workshop visit · 60 min", writable: true, lengths: [60] },
        { id: "ETVIDEO30", name: "Video quote · 30 min", writable: true, lengths: [30] },
      ],
      destination: "auto",
      services: null,
      note: null,
      link: null,
      payments: null,
      ...over,
    }) as ConnectionView;
  const services = [
    { name: "Workshop visit", durationMin: 60, active: 1 },
    { name: "Geyser check", durationMin: 45, active: 1 },
    { name: "Leak trace", durationMin: 45, active: 1 },
    { name: "Drain survey", durationMin: 90, active: 1 },
    { name: "Old service", durationMin: 20, active: 0 },
  ];

  it("names the services a length Calendly has no event type for, before a booking fails", () => {
    expect(lengthGaps(conn({}), services)).toEqual([
      "No 45-min event type on Calendly: Geyser check and Leak trace bookings won't be added there.",
      "No 90-min event type on Calendly: Drain survey bookings won't be added there.",
    ]);
    // One event type chosen: what is not its length.
    expect(lengthGaps(conn({ destination: "ETVIDEO30" }), services.slice(0, 2))).toEqual([
      "Video quote · 30 min is not 45 min: Geyser check bookings won't be added there.",
      "Video quote · 30 min is not 60 min: Workshop visit bookings won't be added there.",
    ]);
    // Nothing when bookings are off, or the line says why already (the Free plan, no event type at all).
    expect(lengthGaps(conn({ bookings_on: false }), services)).toEqual([]);
    expect(lengthGaps(conn({ note: "Calendly Free: busy times only" }), services)).toEqual([]);
    expect(lengthGaps(conn({ kind: "calcom", title: "Cal.com" }), services)).toEqual([]);
  });

  it("warns of each booking twice for Calendly as for Cal.com, and names the event type as such", () => {
    const google = conn({ id: "g1", kind: "google_calendar", title: "Google Calendar", account: "x@example.com" });
    for (const kind of ["calendly", "calcom"]) {
      const platform = conn({ kind, title: kind === "calcom" ? "Cal.com" : "Calendly" });
      expect(isBookingPlatform(platform)).toBe(true);
      expect(bookedTwice([platform, google])).toEqual({ platform, calendar: google });
      expect(bookedTwice([{ ...platform, bookings_on: false }, google])).toBeNull();
    }
    expect(isBookingPlatform(google)).toBe(false);
  });

  it("says Made for a link, and no account beside a title that says it all", () => {
    const link = conn({
      kind: "ics_feed",
      title: "Share your bookings",
      account: "",
      capabilities: [],
      status: "configured",
    });
    expect(servesLink(link)).toBe(true);
    expect(tagOf([link])).toEqual({ text: "Made", tone: "on" });
    expect(tagOf([conn({})])).toEqual({ text: "Connected", tone: "on" });
    expect(accountOf(link)).toBeNull();
    expect(accountOf({ title: "Share your bookings", account: "Share your bookings" })).toBeNull();
    expect(accountOf(conn({}))).toBe("Khanyisa Plumbing (bookings@khanyisa.example.com)");
  });
});

describe("the calendar link to share, end to end", () => {
  const KYOTO = {
    base: "https://yoyaku.ryokan-hana.example.com",
    business: { name: "Ryokan Hana", currency: "JPY", timezone: "Asia/Tokyo", languages: ["ja", "en"] },
    service: "Tea ceremony",
  };

  it("serves confirmed bookings to whoever holds the link, which the inbox's own calendar link reads without blocking itself", async () => {
    const s = await setup(KYOTO);
    const itemId = await booked(s, "Tea ceremony", "05:00", {
      name: "Aiko Tanaka",
      email: "aiko@example.com",
      locale: "ja-JP",
    });
    const res = await s.call("POST", "/v1/owner/integrations", { kind: "ics_feed" }, s.owner);
    expect(res.status, await res.clone().text()).toBe(201);
    const view = (await res.json()) as { id: string; link: string; title: string; account: string };
    expect(view.link).toMatch(
      /^https:\/\/yoyaku\.ryokan-hana\.example\.com\/v1\/feeds\/ics_feed\/[A-Za-z0-9_-]{43}\.ics$/,
    );
    // Its line names it once: nothing to sign in to, so no account beside it.
    expect(view).toMatchObject({ title: "Share your bookings", account: "" });
    // Made already: said plainly, and the link stays the one made.
    const twice = await s.call("POST", "/v1/owner/integrations", { kind: "ics_feed" }, s.owner);
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as { detail: string }).detail).toBe(
      "Your link is made already. Copy it from its line, or make a new one there.",
    );

    const feed = await s.call("GET", view.link);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(feed.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(feed.headers.get("cache-control")).toBe("private, max-age=300");
    const text = await feed.text();
    const { rows } = await s.db.client.query({
      sql: "SELECT value FROM instance_meta WHERE key = 'instance_id'",
      method: "all",
    });
    expect(text).toContain(`UID:sdi-${itemId}@${String(rows[0]?.[0])}.inbox`);
    expect(text).toContain(`DTSTART:${DAY.replaceAll("-", "")}T050000Z`);
    expect(text).toContain("SUMMARY:Tea ceremony");
    expect(text).toContain("X-WR-CALNAME:Ryokan Hana");
    expect(text).not.toContain("Aiko");
    expect(text).not.toContain("aiko@");
    // Asked again with what it has: nothing changed.
    const etag = String(feed.headers.get("etag"));
    const cached = await s.call("GET", view.link, undefined, { "if-none-match": etag });
    expect(cached.status).toBe(304);

    // The inbox's own calendar link, given the link it shares (as a platform that copies it would): no
    // booking blocks its own time.
    const ics = await s.call("POST", "/v1/owner/integrations", { kind: "ics", values: { url: view.link } }, s.owner);
    expect(ics.status, await ics.clone().text()).toBe(201);
    const icsView = (await ics.json()) as { id: string };
    await s.call("POST", `/v1/owner/integrations/${icsView.id}/sync`, {}, s.owner);
    await drain(s);
    const read = (await (await s.call("GET", `/v1/owner/integrations/${icsView.id}`, undefined, s.owner)).json()) as {
      status: string;
      busy_times: number;
    };
    expect(read).toMatchObject({ status: "active", busy_times: 0 });

    // Cancelled: it leaves the link, and the ETag changes.
    const cancelled = await s.call(
      "POST",
      `/v1/owner/items/${itemId}/transitions`,
      { event: "cancel_by_business" },
      s.owner,
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const now = await s.call("GET", view.link, undefined, { "if-none-match": etag });
    expect(now.status).toBe(200);
    expect(await now.text()).not.toContain(itemId);

    // A new link: the old one stops at once.
    const rotated = (await (
      await s.call("POST", `/v1/owner/integrations/${view.id}/link`, undefined, s.owner)
    ).json()) as {
      link: string;
    };
    expect((await s.call("GET", view.link)).status).toBe(404);
    expect((await s.call("GET", rotated.link)).status).toBe(200);
  });
});
