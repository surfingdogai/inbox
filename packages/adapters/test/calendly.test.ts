import {
  type ConnectContext,
  ConnectorError,
  describeForm,
  type OutboundBooking,
  type RunContext,
  readiness,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  CALENDLY_AUTH,
  CALENDLY_AUTO,
  CALENDLY_FREE_NOTE,
  CALENDLY_NO_TYPES_NOTE,
  CALENDLY_SCOPES,
  calendlyConnector,
  calendlyForm,
  hmacSha256Hex,
} from "../src/index";
import {
  API,
  AUTH,
  CLIENT,
  delivery,
  type FakeCalendly,
  fakeCalendly,
  ORG,
  OWNER_EMAIL,
  SCHEDULING_URL,
  TOKEN,
  USER,
} from "./fixtures/calendly";
import { eventOf } from "./hook-event";

/**
 * The Calendly connector (ADR-033) against a fake Calendly answering as its API v2 documents
 * (fixtures/calendly.ts), through the inbox's own connector client: https only, public hosts only. A
 * plumber in Cape Town; no test calls Calendly.
 */

const INBOX = {
  id: "9c41d0e2b7a85f3e6d10",
  origin: "https://inbox.khanyisa.example.com",
  host: "inbox.khanyisa.example.com",
  name: "Khanyisa Plumbing",
  timezone: "Africa/Johannesburg",
  language: "en",
};
const NOW = Date.parse("2026-11-02T08:00:00Z");
const HOOK = "https://inbox.khanyisa.example.com/v1/hooks/calendly/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const cal = calendlyConnector();

function connectCtx(c: FakeCalendly, over: Partial<ConnectContext> = {}): ConnectContext {
  return { http: c.platform.http, now: NOW, inbox: INBOX, hookUrl: HOOK, hooksLive: true, ...over };
}

async function connected(c: FakeCalendly, over: Partial<ConnectContext> = {}) {
  const made = await cal.connect?.(connectCtx(c, over), { token: TOKEN });
  if (!made) throw new Error("not connected");
  return made;
}

function runCtx(c: FakeCalendly, made: Awaited<ReturnType<typeof connected>>, over: Partial<RunContext> = {}) {
  const saved: Record<string, string>[] = [];
  const ctx: RunContext = {
    http: c.platform.http,
    now: NOW,
    inbox: INBOX,
    hookUrl: HOOK,
    hooksLive: true,
    secret: made.secret,
    extra: made.extra ?? {},
    calendars: [],
    busyCalendars: [],
    destinations: made.destinations,
    destination: CALENDLY_AUTO,
    own: { ids: new Set(), spans: [] },
    marker: "4b5a69788796a5b4c3d2e1f00f1e2d3c",
    saveSecret: async (next) => void saved.push({ ...next }),
    ...over,
  };
  return { ctx, saved };
}

const booking: OutboundBooking = {
  itemId: "01JBCPT8R5XK2N4M6P8T0V2W4",
  start: Date.parse("2026-11-04T09:00:00Z"),
  end: Date.parse("2026-11-04T10:00:00Z"),
  title: "Workshop visit · Thandiwe Nkosi",
  description: "Booked in the inbox",
  url: "https://inbox.khanyisa.example.com/items/01JBCPT8R5XK2N4M6P8T0V2W4",
  serviceId: "svc_1",
  serviceName: "Workshop visit",
  customerName: "Thandiwe Nkosi",
  durationMin: 60,
};

describe("Calendly: connecting", () => {
  it("reads whose token it is and the event types bookings can go to, and makes its signed webhook", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    expect(made).toMatchObject({
      account: `Khanyisa Plumbing (${OWNER_EMAIL})`,
      externalId: "KHANYISA0000001",
      calendars: [],
      defaults: { busy: [], destination: CALENDLY_AUTO },
      extra: {
        userUri: USER,
        orgUri: ORG,
        email: OWNER_EMAIL,
        schedulingUrl: SCHEDULING_URL,
        plan: "paid",
        webhook: "added",
        hook_url: HOOK,
      },
      note: null,
    });
    // Bookings start on: the plan takes them.
    expect(made.defaults.bookings).toBeUndefined();
    expect(c.platform.requests("GET", `${API}/organizations/ORGCAPETOWN0001`)).toHaveLength(1);
    // One-on-one, booked at once, a place the business sets, nothing the customer must answer.
    expect(made.destinations.map((d) => [d.id, d.name, d.lengths])).toEqual([
      [CALENDLY_AUTO, "Same length as the booking", undefined],
      ["ETWORKSHOP60", "Workshop visit · 60 min", [60]],
      ["ETVIDEO30", "Video quote · 30 min", [30]],
      ["ETCALL15", "Phone advice · 15 min", [15]],
    ]);
    // The token goes to Calendly's API alone, as a bearer.
    expect(c.platform.seen.every((r) => r.url.origin === API)).toBe(true);
    expect(c.platform.seen.every((r) => r.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
    // Its own webhook, for the user, signed with a key made for it and kept sealed.
    const [hook] = [...c.webhooks.values()];
    expect(hook).toMatchObject({ url: HOOK, events: ["invitee.created", "invitee.canceled"] });
    const sent = JSON.parse(c.platform.requests("POST", `${API}/webhook_subscriptions`)[0]?.body ?? "{}");
    expect(sent).toMatchObject({ scope: "user", user: USER, organization: ORG });
    expect(made.secret).toEqual({ token: TOKEN, signing_key: hook?.signingKey });
    expect(hook?.signingKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(made.extra)).not.toContain(TOKEN);
    expect(JSON.stringify(made.extra)).not.toContain(String(hook?.signingKey));
  });

  it("says a token Calendly does not take is wrong, on the token field, and never repeats it", async () => {
    const c = fakeCalendly();
    c.token.value = "another";
    const error = await cal.connect?.(connectCtx(c), { token: TOKEN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: "auth", field: "token" });
    expect(String((error as Error).message)).not.toContain(TOKEN);
    // A token made without users:read.
    const d = fakeCalendly();
    d.platform.fail("GET", `${API}/users/me`, 403);
    await expect(cal.connect?.(connectCtx(d), { token: TOKEN })).rejects.toMatchObject({
      code: "config",
      field: "token",
    });
  });

  it("asks for a token, sealed, in three steps an owner can follow, with the scopes to tick", () => {
    expect(calendlyForm.safeParse({ token: TOKEN }).success).toBe(true);
    expect(calendlyForm.safeParse({ token: "short" }).success).toBe(false);
    expect(calendlyForm.safeParse({ token: `${TOKEN} ${TOKEN}` }).success).toBe(false);
    expect(CALENDLY_SCOPES).toEqual([
      "users:read",
      "organizations:read",
      "event_types:read",
      "availability:read",
      "scheduled_events:write",
      "webhooks:write",
    ]);
    const [field] = describeForm(calendlyForm);
    expect(field).toMatchObject({
      key: "token",
      secret: true,
      placeholder: "Paste the token",
      link: { href: "https://calendly.com/integrations/api_webhooks", text: "Open Calendly" },
      steps: [
        "In Calendly: Integrations & apps → API & webhooks → Generate new token.",
        "Name it Inbox. Under scopes, tick: users:read · organizations:read · event_types:read · availability:read · scheduled_events:write · webhooks:write",
        "Create it and copy it: Calendly shows it once.",
      ],
    });
    expect(field?.help).toBeUndefined();
    // Said before the owner relies on it: the plan bookings need.
    expect(cal.note).toBe(
      "Busy times work on every Calendly plan. Adding your bookings to Calendly needs its Standard plan or above.",
    );
  });

  it("makes no webhook before the inbox can be reached, and adds it once it can", async () => {
    const c = fakeCalendly();
    const made = await connected(c, { hooksLive: false });
    expect(made.extra).toMatchObject({ webhook: "pending", hook_url: null });
    expect(made.secret).toEqual({ token: TOKEN });
    expect(c.webhooks.size).toBe(0);
    const { ctx, saved } = runCtx(c, made, { hooksLive: false });
    expect(cal.stale?.(ctx)).toBe(false);
    // Live now, half an hour on.
    const live = { ...ctx, hooksLive: true, now: NOW + 31 * 60_000 };
    expect(cal.stale?.(live)).toBe(true);
    const fresh = await cal.refresh?.(live);
    expect(fresh?.extra).toMatchObject({ webhook: "added", hook_url: HOOK });
    expect(saved[0]).toEqual({ token: TOKEN, signing_key: [...c.webhooks.values()][0]?.signingKey });
  });

  it("connects on the Free plan with busy times only, bookings off, and says so on its line", async () => {
    const c = fakeCalendly();
    c.stage = "free";
    c.paid = false;
    const made = await connected(c);
    expect(made.extra).toMatchObject({ webhook: "plan", plan: "free" });
    expect(made.defaults).toMatchObject({ bookings: false });
    expect(made.note).toBe(CALENDLY_FREE_NOTE);
    expect(made.note).toBe("Calendly Free: busy times only");
    expect(made.secret).toEqual({ token: TOKEN });
    // Calendly sends no webhooks on Free: none is asked for.
    expect(c.platform.requests("POST", `${API}/webhook_subscriptions`)).toHaveLength(0);
    // Tried again on the six-hourly read only, never every sync.
    expect(cal.stale?.(runCtx(c, made, { now: NOW + 3_600_000 }).ctx)).toBe(false);
    // Upgraded: the six-hourly read clears the line and adds the webhook. Bookings stay the owner's choice.
    c.stage = "paid";
    c.paid = true;
    const fresh = await cal.refresh?.(runCtx(c, made).ctx);
    expect(fresh?.note).toBeNull();
    expect(fresh?.extra).toMatchObject({ plan: "paid", webhook: "added" });
  });

  it("connects a token that cannot read the plan as before: bookings on, nothing said", async () => {
    const c = fakeCalendly();
    c.stage = null;
    const made = await connected(c);
    expect(made.extra).toMatchObject({ plan: null, webhook: "added" });
    expect(made.defaults.bookings).toBeUndefined();
    expect(made.note).toBeNull();
  });

  it("says on its line when none of the event types can take bookings from here", async () => {
    const c = fakeCalendly();
    c.eventTypes = c.eventTypes.filter((t) => t.kind === "group" || t.booking_method === "poll");
    const made = await connected(c);
    expect(made.destinations.map((d) => d.id)).toEqual([CALENDLY_AUTO]);
    expect(made.note).toBe(CALENDLY_NO_TYPES_NOTE);
    expect(made.note).toBe(
      "None of your Calendly event types can take bookings from here (one-on-one, no required questions, a place you set). Busy times still work.",
    );
  });

  it("connecting again in place makes its webhook again at the same address and drops the old one", async () => {
    const c = fakeCalendly();
    const first = await connected(c);
    await first.settle?.(true);
    const [oldId] = [...c.webhooks.keys()];
    // Calendly answers 409 for a second subscription to one address: the old one goes, a new one is made.
    const again = await connected(c, { previous: { externalId: first.externalId, extra: first.extra ?? {} } });
    await again.settle?.(true);
    expect(c.webhooks.size).toBe(1);
    expect([...c.webhooks.keys()][0]).not.toBe(oldId);
    expect(again.secret.signing_key).not.toBe(first.secret.signing_key);
    // Refused after all: what was just made goes.
    const refused = await connected(fakeCalendlyWith(c));
    await refused.settle?.(false);
    expect(c.webhooks.size).toBe(0);
  });

  it("disconnecting removes its webhook", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    await cal.disconnect?.(runCtx(c, made).ctx);
    expect(c.webhooks.size).toBe(0);
  });
});

/** The same fake, its subscriptions cleared first: a fresh connection to the same account. */
function fakeCalendlyWith(c: FakeCalendly): FakeCalendly {
  c.webhooks.clear();
  return c;
}

describe("Calendly: busy times", () => {
  it("reads a week a call from the next minute, takes buffers, and leaves out the inbox's own events", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    c.busy.push(
      // Booked on Calendly, with fifteen minutes either side.
      {
        type: "calendly",
        start_time: "2026-11-03T10:00:00.000000Z",
        end_time: "2026-11-03T11:00:00.000000Z",
        buffered_start_time: "2026-11-03T09:45:00.000000Z",
        buffered_end_time: "2026-11-03T11:15:00.000000Z",
        event: { uri: `${API}/scheduled_events/EVTHEIRS000001` },
      },
      // This inbox's own booking, and its copy in the calendar Calendly checks.
      {
        type: "calendly",
        start_time: "2026-11-04T09:00:00.000000Z",
        end_time: "2026-11-04T10:00:00.000000Z",
        event: { uri: `${API}/scheduled_events/EVOURS00000001` },
      },
      { type: "external", start_time: "2026-11-04T09:00:00.000000Z", end_time: "2026-11-04T10:00:00.000000Z" },
      // The owner's dentist, in their own calendar, and a time Calendly holds.
      { type: "external", start_time: "2026-11-20T13:00:00.000000Z", end_time: "2026-11-20T14:00:00.000000Z" },
      { type: "reserved", start_time: "2027-01-28T07:00:00.000000Z", end_time: "2027-01-28T07:30:00.000000Z" },
    );
    const own = {
      ids: new Set(["EVOURS00000001"]),
      spans: [{ start: Date.parse("2026-11-04T09:00:00Z"), end: Date.parse("2026-11-04T10:00:00Z") }],
    };
    const window = { start: NOW - 3_600_000, end: NOW + 92 * 86_400_000 };
    const read = await cal.busy?.(runCtx(c, made, { own }).ctx, window);
    expect(read).toEqual([
      { start: Date.parse("2026-11-03T09:45:00Z"), end: Date.parse("2026-11-03T11:15:00Z") },
      { start: Date.parse("2026-11-20T13:00:00Z"), end: Date.parse("2026-11-20T14:00:00Z") },
      { start: Date.parse("2027-01-28T07:00:00Z"), end: Date.parse("2027-01-28T07:30:00Z") },
    ]);
    const calls = c.platform.requests("GET", `${API}/user_busy_times`);
    // 92 days, seven at a time; never a start in the past; always this user.
    expect(calls).toHaveLength(14);
    expect(calls[0]?.url.searchParams.get("start_time")).toBe("2026-11-02T08:01:00Z");
    expect(calls.every((r) => r.url.searchParams.get("user") === USER)).toBe(true);
    for (const r of calls) {
      const span =
        Date.parse(r.url.searchParams.get("end_time") ?? "") - Date.parse(r.url.searchParams.get("start_time") ?? "");
      expect(span).toBeLessThanOrEqual(7 * 86_400_000);
    }
  });

  it("says how far it read when the way ahead is longer than one sync reads", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const window = { start: NOW, end: NOW + 200 * 86_400_000 };
    const read = await cal.busy?.(runCtx(c, made).ctx, window);
    expect(read).toEqual({ intervals: [], until: Math.ceil((NOW + 60_000) / 60_000) * 60_000 + 14 * 7 * 86_400_000 });
  });

  it("keeps the last busy times when Calendly cannot read a calendar it checks, or the token cannot read them", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const window = { start: NOW, end: NOW + 86_400_000 };
    c.busyStatus = 424;
    await expect(cal.busy?.(runCtx(c, made).ctx, window)).rejects.toMatchObject({ code: "unreachable" });
    const d = fakeCalendly();
    d.platform.fail("GET", `${API}/user_busy_times`, 403);
    await expect(cal.busy?.(runCtx(d, made).ctx, window)).rejects.toMatchObject({ code: "config", field: "token" });
    d.platform.fail("GET", `${API}/user_busy_times`, 429);
    await expect(cal.busy?.(runCtx(d, made).ctx, window)).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 7000,
    });
    d.platform.fail("GET", `${API}/user_busy_times`, 503);
    await expect(cal.busy?.(runCtx(d, made).ctx, window)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("never follows Calendly elsewhere with the token", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    c.platform.fail("GET", `${API}/user_busy_times`, { redirect: "https://10.0.0.7/steal" });
    await expect(cal.busy?.(runCtx(c, made).ctx, { start: NOW, end: NOW + 86_400_000 })).rejects.toBeInstanceOf(
      ConnectorError,
    );
    expect(c.platform.seen.some((r) => r.url.host !== "api.calendly.com")).toBe(false);
  });
});

describe("Calendly: bookings", () => {
  it("books the business itself under the customer's name, on the event type as long as the booking", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const { ctx } = runCtx(c, made);
    const link = await cal.bookings?.put(ctx, booking, null);
    expect(link).toEqual({
      externalId: "EV00000000000002",
      etag: null,
      calendar: "ETWORKSHOP60",
      start: booking.start,
      end: booking.end,
    });
    const sent = [...c.events.values()][0]?.body;
    expect(sent).toEqual({
      event_type: `${API}/event_types/ETWORKSHOP60`,
      start_time: "2026-11-04T09:00:00Z",
      // Calendly emails its invitee: the business, whose inbox has told the customer already.
      invitee: { name: "Thandiwe Nkosi", email: OWNER_EMAIL, timezone: "Africa/Johannesburg" },
      location: { kind: "physical", location: "14 Bree Street, Cape Town" },
      // A mark only this inbox can make: anyone booking on the public page can set tracking.
      tracking: { utm_source: "inbox", utm_content: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
    // A conference is made by Calendly; a call the customer makes takes the business's own number.
    const at = (h: number) => booking.start + h * 3_600_000;
    await cal.bookings?.put(ctx, { ...booking, itemId: "b2", durationMin: 30, start: at(2), end: at(2.5) }, null);
    expect([...c.events.values()][1]?.body.location).toEqual({ kind: "google_conference" });
    await cal.bookings?.put(ctx, { ...booking, itemId: "b3", durationMin: 15, start: at(3), end: at(3.25) }, null);
    expect([...c.events.values()][2]?.body.location).toEqual({ kind: "inbound_call" });
  });

  it("refuses a length no event type has, or the one chosen does not have, in the owner's words", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    await expect(
      cal.bookings?.put(runCtx(c, made).ctx, { ...booking, durationMin: 50, end: booking.start + 3_000_000 }, null),
    ).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("No Calendly event type is 50") });
    await expect(
      cal.bookings?.put(runCtx(c, made, { destination: "ETVIDEO30" }).ctx, booking, null),
    ).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("Video quote · 30 min cannot") });
    expect(c.events.size).toBe(0);
  });

  it("moves by making the new event first, then cancelling the old one", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const { ctx } = runCtx(c, made);
    const first = await cal.bookings?.put(ctx, booking, null);
    const later = { ...booking, start: booking.start + 86_400_000, end: booking.end + 86_400_000 };
    const moved = await cal.bookings?.put(ctx, later, first ?? null);
    expect(moved?.externalId).not.toBe(first?.externalId);
    expect(c.events.get(String(first?.externalId))?.status).toBe("canceled");
    expect(c.events.get(String(moved?.externalId))).toMatchObject({ status: "active", start: "2026-11-05T09:00:00Z" });
    // The same times again write nothing.
    const calls = c.platform.seen.length;
    expect(await cal.bookings?.put(ctx, later, moved ?? null)).toEqual(moved);
    expect(c.platform.seen.length).toBe(calls);
  });

  it("moving onto time the old event still holds cancels it first, and says so when Calendly still refuses", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const { ctx } = runCtx(c, made);
    const first = await cal.bookings?.put(ctx, booking, null);
    const half = { ...booking, start: booking.start + 1_800_000, end: booking.end + 1_800_000 };
    // Calendly refuses the new time, the old event holding half of it, and again once that is gone.
    c.refuse = "slot";
    const route = c.platform.seen.length;
    await expect(cal.bookings?.put(ctx, half, first ?? null)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("The selected time is no longer available."),
    });
    // The old one went before the second try; the booking stays in the inbox and says why.
    expect(c.events.get(String(first?.externalId))?.status).toBe("canceled");
    expect(c.platform.seen.slice(route).map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      // A move first looks for the event it may have made already at the new time.
      "GET /scheduled_events",
      "GET /event_types/ETWORKSHOP60",
      "POST /invitees",
      `POST /scheduled_events/${first?.externalId}/cancellation`,
      "GET /event_types/ETWORKSHOP60",
      "POST /invitees",
    ]);
    // Accepted on the next try: the old one is cancelled already, which is done.
    c.refuse = null;
    const again = await cal.bookings?.put(ctx, half, first ?? null);
    expect(c.events.get(String(again?.externalId))?.status).toBe("active");
  });

  it("moves onto half its own time by itself: Calendly refuses a time an event holds, the old one goes first", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const { ctx } = runCtx(c, made);
    const first = await cal.bookings?.put(ctx, booking, null);
    const half = { ...booking, start: booking.start + 1_800_000, end: booking.end + 1_800_000 };
    const moved = await cal.bookings?.put(ctx, half, first ?? null);
    expect(c.events.get(String(first?.externalId))?.status).toBe("canceled");
    expect(c.events.get(String(moved?.externalId))).toMatchObject({ status: "active", start: "2026-11-04T09:30:00Z" });
  });

  it("a move that stopped after making the new event is finished on the next try, never made twice", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const { ctx } = runCtx(c, made);
    const first = await cal.bookings?.put(ctx, booking, null);
    const later = { ...booking, start: booking.start + 86_400_000, end: booking.end + 86_400_000 };
    // The new event is made; cancelling the old one fails once, so the inbox keeps the old link.
    c.platform.fail("POST", `${API}/scheduled_events/:id/cancellation`, 503);
    await expect(cal.bookings?.put(ctx, later, first ?? null)).rejects.toMatchObject({ code: "unreachable" });
    const active = () => [...c.events.entries()].filter(([, e]) => e.status === "active");
    expect(active().map(([, e]) => e.start)).toEqual(["2026-11-04T09:00:00Z", "2026-11-05T09:00:00Z"]);
    // Tried again with the old link: the event already at the new time is the one kept, the old one goes.
    const again = await cal.bookings?.put(ctx, later, first ?? null);
    expect(active().map(([id, e]) => [id, e.start])).toEqual([[again?.externalId, "2026-11-05T09:00:00Z"]]);
    expect(c.events.get(String(first?.externalId))?.status).toBe("canceled");
    expect(again).toMatchObject({ calendar: "ETWORKSHOP60", start: later.start, end: later.end });
    expect(c.platform.requests("POST", `${API}/invitees`)).toHaveLength(2);
    // A third try with the link it keeps writes nothing.
    const calls = c.platform.seen.length;
    expect(await cal.bookings?.put(ctx, later, again ?? null)).toEqual(again);
    expect(c.platform.seen.length).toBe(calls);
  });

  it("keeps the old event when Calendly refuses something else than the time", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const { ctx } = runCtx(c, made);
    const first = await cal.bookings?.put(ctx, booking, null);
    c.refuse = "field";
    const half = { ...booking, start: booking.start + 1_800_000, end: booking.end + 1_800_000 };
    await expect(cal.bookings?.put(ctx, half, first ?? null)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("does not match"),
    });
    expect(c.events.get(String(first?.externalId))?.status).toBe("active");
    expect(c.platform.requests("POST", `${API}/scheduled_events/`)).toHaveLength(0);
  });

  it("on the Free plan says the time is not blocked on Calendly and what to do, told apart from a missing scope", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    c.refuse = "plan";
    const error = (await cal.bookings?.put(runCtx(c, made).ctx, booking, null).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ code: "refused" });
    expect(error.message).toBe(
      "Calendly's Free plan doesn't let other apps add bookings, so 4 Nov, 11:00 is not blocked on Calendly. Block it there yourself, or switch off Add confirmed bookings.",
    );
    c.refuse = "scope";
    const scope = (await cal.bookings?.put(runCtx(c, made).ctx, booking, null).catch((e: unknown) => e)) as Error;
    expect(scope).toMatchObject({ code: "refused" });
    expect(scope.message).toContain("scheduled_events:write");
    expect(scope.message).not.toContain("Free plan");
    expect(made.extra?.schedulingUrl).toBe(SCHEDULING_URL);
  });

  it("refuses an event type that changed in Calendly to ask the customer something", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const workshop = c.eventTypes[0];
    if (workshop) workshop.locations = [{ kind: "ask_invitee" }];
    await expect(cal.bookings?.put(runCtx(c, made).ctx, booking, null)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("cannot take bookings from here"),
    });
    c.eventTypes.splice(0, 1);
    await expect(cal.bookings?.put(runCtx(c, made).ctx, booking, null)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("gone from Calendly"),
    });
  });

  it("cancels, and treats gone, cancelled already, or over as done", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const { ctx } = runCtx(c, made);
    const link = await cal.bookings?.put(ctx, booking, null);
    if (!link) throw new Error("no link");
    await cal.bookings?.remove(ctx, link);
    expect(c.events.get(String(link.externalId))?.status).toBe("canceled");
    const sent = c.platform.requests("POST", `${API}/scheduled_events/`).at(-1);
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ reason: "Cancelled in the inbox" });
    // Twice: Calendly says it is cancelled already.
    await cal.bookings?.remove(ctx, link);
    // Gone.
    await cal.bookings?.remove(ctx, { ...link, externalId: "EVNOTTHERE0001" });
    // Over: Calendly will not cancel the past, and nothing is held any more.
    const d = fakeCalendly();
    d.platform.fail("POST", `${API}/scheduled_events/:id/cancellation`, 403);
    await cal.bookings?.remove(runCtx(d, made).ctx, { ...link, start: NOW - 3_600_000, end: NOW });
    d.platform.fail("POST", `${API}/scheduled_events/:id/cancellation`, 403);
    await expect(cal.bookings?.remove(runCtx(d, made).ctx, link)).rejects.toMatchObject({ code: "refused" });
  });

  it("says so when Calendly will not let it cancel, since the event still holds the time", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const { ctx } = runCtx(c, made);
    const link = await cal.bookings?.put(ctx, booking, null);
    if (!link) throw new Error("no link");
    c.cancelRefusal = "You are not allowed to cancel this event";
    await expect(cal.bookings?.remove(ctx, link)).rejects.toMatchObject({
      code: "refused",
      message: "Calendly would not cancel it: You are not allowed to cancel this event.",
    });
    expect(c.events.get(String(link.externalId))?.status).toBe("active");
    // In the past, Calendly's own words: nothing is held any more.
    c.cancelRefusal = "Event in the past";
    await cal.bookings?.remove({ ...ctx, now: booking.end + 60_000 }, link);
  });

  it("finds an event it made and kept no id for by its mark, never one someone else made", async () => {
    const c = fakeCalendly();
    const made = await connected(c);
    const { ctx } = runCtx(c, made);
    const link = await cal.bookings?.put(ctx, booking, null);
    expect(await cal.bookings?.find?.(ctx, booking)).toEqual({ ...link });
    // Another inbox, or a customer who set the same tracking by hand, has another mark.
    expect(await cal.bookings?.find?.({ ...ctx, marker: "another-inbox" }, booking)).toBeNull();
    expect(await cal.bookings?.find?.(ctx, { ...booking, itemId: "another-booking" })).toBeNull();
    const q = c.platform.requests("GET", `${API}/scheduled_events`)[0]?.url.searchParams;
    expect(q?.get("invitee_email")).toBe(OWNER_EMAIL);
    expect(q?.get("user")).toBe(USER);
    // Calendly's bounds are "after" and "prior to": a minute either side, so the start itself is in.
    expect(q?.get("min_start_time")).toBe("2026-11-04T08:59:00Z");
    expect(q?.get("max_start_time")).toBe("2026-11-04T09:01:00Z");
  });
});

describe("Calendly: its webhook", () => {
  async function hooked() {
    const c = fakeCalendly();
    const made = await connected(c);
    const key = String(made.secret.signing_key);
    const verify = async (d: { body: string; headers: Record<string, string> }, now = Date.now()) =>
      eventOf(
        await cal.hooks?.verify(runCtx(c, made, { now }).ctx, {
          headers: new Headers(d.headers),
          body: d.body,
          query: new URLSearchParams(),
        }),
      );
    return { c, made, key, verify };
  }

  it("takes a delivery signed over t.body with the key it made, and keeps ids only", async () => {
    const { key, verify } = await hooked();
    const event = await verify(await delivery(key));
    expect(event).toEqual({
      eventId: "invitee.created:INPIETER000001",
      topic: "invitee.created",
      refs: ["EVBOOKEDONCAL01", "INPIETER000001"],
    });
    expect(JSON.stringify(event)).not.toContain("Pieter");
    expect(JSON.stringify(event)).not.toContain("@");
    const cancelled = await verify(await delivery(key, { event: "invitee.canceled" }));
    expect(cancelled?.eventId).toBe("invitee.canceled:INPIETER000001");
  });

  it("refuses one byte off, another key, an old or future time, and no signature at all", async () => {
    const { key, verify } = await hooked();
    await expect(verify(await delivery(key, { tamper: true }))).rejects.toBeInstanceOf(ConnectorError);
    await expect(verify(await delivery("another-key"))).rejects.toMatchObject({ code: "refused" });
    const old = await delivery(key, { at: Date.now() - 181_000 });
    await expect(verify(old)).rejects.toMatchObject({ code: "refused" });
    await expect(verify(await delivery(key, { at: Date.now() + 181_000 }))).rejects.toMatchObject({ code: "refused" });
    const good = await delivery(key);
    await expect(verify({ body: good.body, headers: { "content-type": "application/json" } })).rejects.toMatchObject({
      code: "refused",
    });
    // The body changed after signing.
    await expect(verify({ ...good, body: good.body.replace("Pieter", "Petrus") })).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("checks a few signatures at most, each against one HMAC, in any case", async () => {
    const { key, verify } = await hooked();
    const good = await delivery(key);
    const header = good.headers["calendly-webhook-signature"] ?? "";
    const [t, v1] = header.split(",");
    const wrong = "v1=0000000000000000000000000000000000000000000000000000000000000000";
    // Calendly's own one among a few: taken. Upper case hex: taken.
    const few = { ...good.headers, "calendly-webhook-signature": [t, wrong, wrong, v1].join(",") };
    expect(await verify({ body: good.body, headers: few })).toMatchObject({ topic: "invitee.created" });
    const upper = { ...good.headers, "calendly-webhook-signature": `${t},${v1?.toUpperCase().replace("V1=", "v1=")}` };
    expect(await verify({ body: good.body, headers: upper })).toMatchObject({ topic: "invitee.created" });
    // Past the fifth, nothing more is looked at; a header of thousands is refused unread.
    const late = { ...good.headers, "calendly-webhook-signature": [t, ...Array(5).fill(wrong), v1].join(",") };
    await expect(verify({ body: good.body, headers: late })).rejects.toMatchObject({ code: "refused" });
    const huge = { ...good.headers, "calendly-webhook-signature": [t, ...Array(400).fill(wrong), v1].join(",") };
    await expect(verify({ body: good.body, headers: huge })).rejects.toMatchObject({ code: "refused" });
    expect(await hmacSha256Hex(key, `${t?.slice(2)}.${good.body}`)).toBe(v1?.slice(3));
  });

  it("answers nothing for an event it does not follow, and a connection with no key refuses everything", async () => {
    const { c, made, key, verify } = await hooked();
    expect(await verify(await delivery(key, { event: "invitee_no_show.created" }))).toBeNull();
    const keyless = runCtx(c, made, { secret: { token: TOKEN }, now: Date.now() }).ctx;
    await expect(
      cal.hooks?.verify(keyless, {
        headers: new Headers((await delivery(key)).headers),
        body: "{}",
        query: new URLSearchParams(),
      }),
    ).rejects.toMatchObject({ code: "refused" });
  });

  it("reads busy times again for what a delivery names, never the body", async () => {
    const { c, made } = await hooked();
    const before = c.platform.seen.length;
    expect(
      await cal.hooks?.read(runCtx(c, made).ctx, {
        eventId: "invitee.created:IN1",
        topic: "invitee.created",
        refs: [],
      }),
    ).toEqual([{ kind: "busy" }]);
    expect(c.platform.seen.length).toBe(before);
  });

  it("is made again when Calendly switched it off or the inbox moved, with a new signing key", async () => {
    const { c, made } = await hooked();
    const [id, hook] = [...c.webhooks.entries()][0] ?? [];
    if (!id || !hook) throw new Error("no webhook");
    hook.state = "disabled";
    const { ctx, saved } = runCtx(c, made);
    const fresh = await cal.refresh?.(ctx);
    expect(c.webhooks.has(id)).toBe(false);
    expect(c.webhooks.size).toBe(1);
    expect(fresh?.extra).toMatchObject({ webhook: "added" });
    expect(saved.at(-1)?.signing_key).toBe([...c.webhooks.values()][0]?.signingKey);
    // The inbox took its own domain: stale at once, then pointed there.
    const moved = "https://bookings.khanyisa.example.com/v1/hooks/calendly/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const there = { ...ctx, extra: fresh?.extra ?? {}, hookUrl: moved };
    expect(cal.stale?.(there)).toBe(true);
    const again = await cal.refresh?.(there);
    expect(again?.extra).toMatchObject({ webhook: "added", hook_url: moved });
    expect([...c.webhooks.values()].map((w) => w.url)).toEqual([moved]);
    expect(cal.stale?.({ ...there, extra: again?.extra ?? {} })).toBe(false);
  });
});

describe("Calendly: signing in with Calendly", () => {
  const signIn = calendlyConnector(CLIENT);
  const REDIRECT = "https://inbox.khanyisa.example.com/oauth/connect/calendly/callback";

  async function pkce() {
    const verifier = "kV8vYw3r2c1x0zQpLmNoJiHgFeDcBa9876543210abcdefGHIJK";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    let binary = "";
    for (const b of digest) binary += String.fromCharCode(b);
    return { verifier, challenge: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
  }

  async function signedIn(c: FakeCalendly) {
    const { verifier, challenge } = await pkce();
    const code = c.authorize(challenge, REDIRECT);
    const made = await signIn.oauth?.exchange(connectCtx(c), { code, verifier, redirectUri: REDIRECT });
    if (!made) throw new Error("not signed in");
    return made;
  }

  it("is a way beside the token, 'Soon' on a hosted inbox and 'set up' on one's own server until its app is set", () => {
    const way = (def: ReturnType<typeof calendlyConnector>) => def.presets?.find((p) => p.id === "oauth");
    const none = calendlyConnector();
    expect(readiness(none, way(none))).toBe("Calendly sign-in is not set up on this inbox yet.");
    expect(way(none)?.whenNotReady).toMatchObject({ status: "setup", hint: "Needs a Calendly app on the server." });
    const hosted = calendlyConnector(null, { hosted: true });
    expect(way(hosted)?.whenNotReady).toEqual({ status: "soon" });
    expect(readiness(signIn, way(signIn))).toBe(true);
    expect(way(signIn)).toMatchObject({ auth: "oauth", label: "Calendly", action: "Continue with Calendly" });
    // The token needs nothing of the server.
    expect(readiness(none)).toBe(true);
  });

  it("sends the owner to Calendly with PKCE (S256) and its state, and nothing secret", () => {
    const url = new URL(
      signIn.oauth?.authorizeUrl({ redirectUri: REDIRECT, state: "st4te", challenge: "ch4llenge" }) ?? "",
    );
    expect(`${url.origin}${url.pathname}`).toBe(`${CALENDLY_AUTH}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT.clientId,
      response_type: "code",
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
      code_challenge: "ch4llenge",
      state: "st4te",
    });
    expect(url.href).not.toContain(CLIENT.clientSecret);
  });

  it("turns the code into lasting access with the app's own key, then connects as the token does", async () => {
    const c = fakeCalendly();
    const made = await signedIn(c);
    expect(made).toMatchObject({
      account: `Khanyisa Plumbing (${OWNER_EMAIL})`,
      externalId: "KHANYISA0000001",
      extra: { userUri: USER, plan: "paid", webhook: "added" },
      note: null,
    });
    expect(Object.keys(made.secret).sort()).toEqual([
      "access_expires_at",
      "access_token",
      "refresh_token",
      "signing_key",
    ]);
    expect(made.secret.access_expires_at).toBe(String(NOW + 7_200_000));
    const [exchange] = c.platform.requests("POST", `${AUTH}/oauth/token`);
    expect(exchange?.headers.get("authorization")).toMatch(/^Basic /);
    expect(Object.fromEntries(new URLSearchParams(exchange?.body ?? ""))).toMatchObject({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    });
    // The app's secret goes to Calendly's sign-in alone; its API sees the access token only.
    const api = c.platform.seen.filter((r) => r.url.origin === API);
    expect(api.every((r) => r.headers.get("authorization") === `Bearer ${made.secret.access_token}`)).toBe(true);
    // A code is used once.
    const { verifier } = await pkce();
    await expect(
      signIn.oauth?.exchange(connectCtx(c), { code: "code-used", verifier, redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  it("refreshes before the two hours are up, keeps the new refresh token at once, and asks once per run", async () => {
    const c = fakeCalendly();
    const made = await signedIn(c);
    const later = NOW + 2 * 3_600_000;
    const { ctx, saved } = runCtx(c, made, { now: later });
    await signIn.bookings?.find?.(ctx, booking);
    await signIn.busy?.(ctx, { start: later, end: later + 86_400_000 });
    await signIn.bookings?.put(ctx, booking, null);
    const refreshes = c.platform.requests("POST", `${AUTH}/oauth/token`).slice(1);
    expect(refreshes).toHaveLength(1);
    expect(new URLSearchParams(refreshes[0]?.body ?? "").get("refresh_token")).toBe(made.secret.refresh_token);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.refresh_token).not.toBe(made.secret.refresh_token);
    expect(saved[0]?.signing_key).toBe(made.secret.signing_key);
    expect(c.oauth.refresh.has(String(made.secret.refresh_token))).toBe(false);
    // The webhook made again in the same run keeps the new refresh token, never the spent one.
    const [id, hook] = [...c.webhooks.entries()][0] ?? [];
    if (hook) hook.state = "disabled";
    await signIn.refresh?.(ctx);
    expect(c.webhooks.has(String(id))).toBe(false);
    expect(saved.at(-1)?.refresh_token).toBe(saved[0]?.refresh_token);
    expect(saved.at(-1)?.signing_key).not.toBe(made.secret.signing_key);
  });

  it("says to connect again when Calendly no longer takes the refresh token", async () => {
    const c = fakeCalendly();
    const made = await signedIn(c);
    c.oauth.refresh.clear();
    const { ctx } = runCtx(c, made, { now: NOW + 3 * 3_600_000 });
    await expect(signIn.busy?.(ctx, { start: ctx.now, end: ctx.now + 86_400_000 })).rejects.toMatchObject({
      code: "auth",
      message: "Calendly stopped this connection. Connect it again.",
    });
  });

  it("gives the access back to Calendly when it is disconnected, with its webhook", async () => {
    const c = fakeCalendly();
    const made = await signedIn(c);
    await signIn.disconnect?.(runCtx(c, made).ctx);
    expect(c.webhooks.size).toBe(0);
    expect(c.oauth.revoked).toEqual([made.secret.refresh_token]);
  });

  it("signed in again with a new address of its own, drops this inbox's old webhook once kept", async () => {
    const c = fakeCalendly();
    const first = await connected(c);
    await first.settle?.(true);
    const moved = "https://inbox.khanyisa.example.com/v1/hooks/calendly/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const { verifier, challenge } = await pkce();
    const code = c.authorize(challenge, REDIRECT);
    const again = await signIn.oauth?.exchange(connectCtx(c, { hookUrl: moved }), {
      code,
      verifier,
      redirectUri: REDIRECT,
    });
    await again?.settle?.(true);
    expect([...c.webhooks.values()].map((w) => w.url)).toEqual([moved]);
  });
});
