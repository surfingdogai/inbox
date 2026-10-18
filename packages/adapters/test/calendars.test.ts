import type { Interval, OutboundBooking, RunContext } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  buildICalEvent,
  busyFromICal,
  CALCOM_AUTO,
  calcomConnector,
  caldavConnector,
  connectorHttp,
  expandRRule,
  GOOGLE_SCOPES,
  googleCalendarConnector,
  googleEventId,
  multistatus,
  parseRRule,
  parseXml,
  resolveZone,
  siteOf,
  zonedToUtc,
} from "../src/index";
import {
  CALCOM_CALENDARS,
  CALCOM_EVENT_TYPES,
  CALCOM_ME,
  calcomBookings,
  EVENT_ALLDAY_BUSY,
  EVENT_ALLDAY_FREE,
  EVENT_CANCELLED_AND_FREE,
  EVENT_DENTIST,
  EVENT_OUTLOOK,
  EVENT_WEEKLY_LISBON,
  GOOGLE_PROBE,
  GOOGLE_TOKEN,
  ICLOUD_CALENDARS,
  ICLOUD_HOME_SET,
  ICLOUD_PRINCIPAL,
  icloudReport,
  NEXTCLOUD_CALENDARS,
  NEXTCLOUD_HOME_SET,
  NEXTCLOUD_PRINCIPAL,
} from "./fixtures/calendars";

/**
 * Contract tests for the calendar connectors (ADR-020) against answers shaped after each platform's
 * documentation (fixtures/calendars.ts): what is asked of the platform, with which headers and body,
 * and what the inbox makes of the answer. The HTTP client is the real one; only `fetch` is faked.
 */

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

type Route = (req: Seen) => Response | Promise<Response> | undefined;

function fakePlatform(route: Route) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    seen.push(req);
    const res = await route(req);
    return res ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { http: connectorHttp({ fetchImpl }), seen };
}

const xml = (body: string, status = 207) =>
  new Response(body, { status, headers: { "content-type": "application/xml; charset=utf-8" } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const INBOX = {
  origin: "https://inbox.salon.example",
  host: "inbox.salon.example",
  name: "Ana's Salon",
  timezone: "Europe/Lisbon",
  language: "pt",
};
const NOW = Date.parse("2026-11-02T08:00:00Z");
const WINDOW: Interval = { start: Date.parse("2026-11-02T00:00:00Z"), end: Date.parse("2026-12-31T00:00:00Z") };

function runContext(http: RunContext["http"], over: Partial<RunContext> = {}): RunContext {
  return {
    http,
    now: NOW,
    inbox: INBOX,
    secret: {},
    extra: {},
    calendars: [],
    busyCalendars: [],
    destinations: [],
    destination: null,
    own: { ids: new Set(), spans: [] },
    saveSecret: async () => {},
    ...over,
  };
}

const booking: OutboundBooking = {
  itemId: "01JB7Z3Q8R5XK2N4M6P8T0V2W4",
  start: Date.parse("2026-11-03T15:00:00Z"),
  end: Date.parse("2026-11-03T16:00:00Z"),
  title: "Haircut · Rita Amaral",
  description: "Booked in your inbox.\nhttps://inbox.salon.example/items/01JB7Z3Q8R5XK2N4M6P8T0V2W4",
  url: "https://inbox.salon.example/items/01JB7Z3Q8R5XK2N4M6P8T0V2W4",
  serviceId: "svc1",
  serviceName: "Haircut",
  customerName: "Rita Amaral",
  durationMin: 60,
};

const iso = (ms: number) => new Date(ms).toISOString();

/* --- the HTTP client ----------------------------------------------------------- */

describe("the connectors' HTTP client", () => {
  it("goes only to public https hosts", async () => {
    const { http, seen } = fakePlatform(() => new Response("ok"));
    for (const url of [
      "http://caldav.example.com/",
      "https://127.0.0.1/",
      "https://localhost/",
      "https://10.0.0.5/",
      "https://calendar.internal/",
      "https://user:pw@caldav.example.com/",
    ]) {
      await expect(http.request({ method: "GET", url }), url).rejects.toMatchObject({ code: "config" });
    }
    expect(seen).toHaveLength(0);
  });

  it("checks every redirect again and keeps a sign-in within its site only", async () => {
    const { http, seen } = fakePlatform((req) => {
      if (req.url === "https://caldav.icloud.com/start")
        return new Response(null, { status: 301, headers: { location: "https://p42-caldav.icloud.com/next" } });
      if (req.url === "https://p42-caldav.icloud.com/next")
        return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.net/last" } });
      if (req.url === "https://elsewhere.example.net/last") return new Response("done");
      if (req.url === "https://caldav.icloud.com/evil")
        return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } });
      return undefined;
    });
    const r = await http.request({
      method: "PROPFIND",
      url: "https://caldav.icloud.com/start",
      headers: { authorization: "Basic c2VjcmV0" },
      followRedirects: true,
    });
    expect(r.text).toBe("done");
    expect(seen.map((s) => [s.method, s.headers.get("authorization")])).toEqual([
      ["PROPFIND", "Basic c2VjcmV0"],
      ["PROPFIND", "Basic c2VjcmV0"],
      ["PROPFIND", null],
    ]);
    await expect(
      http.request({ method: "GET", url: "https://caldav.icloud.com/evil", followRedirects: true }),
    ).rejects.toMatchObject({ code: "config" });
    expect(siteOf("p42-caldav.icloud.com")).toBe("icloud.com");
    expect(siteOf("cloud.salon.co.uk")).toBe("salon.co.uk");
  });

  it("stops reading past the size it was given", async () => {
    const { http } = fakePlatform(() => new Response("x".repeat(5000)));
    await expect(
      http.request({ method: "GET", url: "https://api.example.com/", maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("says when a platform cannot be reached", async () => {
    const http = connectorHttp({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(http.request({ method: "GET", url: "https://api.cal.com/v2/me" })).rejects.toMatchObject({
      code: "unreachable",
      message: "Could not reach api.cal.com.",
    });
  });
});

/* --- XML and iCalendar -------------------------------------------------------- */

describe("reading WebDAV answers", () => {
  it("resolves namespaces, entities and CDATA, and never reads a DOCTYPE", () => {
    const doc = parseXml(`<?xml version="1.0"?>
<!DOCTYPE x [<!ENTITY boom SYSTEM "file:///etc/passwd">]>
<d:a xmlns:d="DAV:"><d:b>one &amp; &#x41;&boom;</d:b><c xmlns="urn:x"><![CDATA[<raw>]]></c></d:a>`);
    const a = doc.children[0];
    expect(a?.ns).toBe("DAV:");
    expect(a?.children[0]?.text).toBe("one & A&boom;");
    expect(a?.children[1]).toMatchObject({ ns: "urn:x", name: "c", text: "<raw>" });
  });

  it("keeps only the properties that came back 200", () => {
    const [r] = multistatus(ICLOUD_PRINCIPAL);
    expect(r?.href).toBe("/");
    expect(r?.props.map((p) => p.name)).toEqual(["current-user-principal"]);
  });
});

describe("busy times from iCalendar", () => {
  const read = (ics: string, skipUid?: (uid: string) => boolean) =>
    busyFromICal(ics, WINDOW, { timezone: "Europe/Lisbon", skipUid }).map((i) => [iso(i.start), iso(i.end)]);

  it("reads a plain event in UTC", () => {
    expect(read(EVENT_DENTIST)).toEqual([["2026-11-03T10:00:00.000Z", "2026-11-03T11:00:00.000Z"]]);
  });

  it("repeats a weekly event on wall time, skips an excluded week and moves an overridden one", () => {
    const out = read(EVENT_WEEKLY_LISBON);
    // Lisbon is on UTC from 25 October: 18:00 there is 18:00Z.
    expect(out.slice(0, 4)).toEqual([
      ["2026-11-03T18:00:00.000Z", "2026-11-03T19:00:00.000Z"],
      // 5 November is excluded.
      ["2026-11-10T20:00:00.000Z", "2026-11-10T21:00:00.000Z"],
      ["2026-11-12T18:00:00.000Z", "2026-11-12T19:00:00.000Z"],
      ["2026-11-17T18:00:00.000Z", "2026-11-17T19:00:00.000Z"],
    ]);
    expect(out.some(([s]) => s === "2026-11-05T18:00:00.000Z")).toBe(false);
    expect(out.some(([s]) => s === "2026-11-10T18:00:00.000Z")).toBe(false);
    expect(out.at(-1)?.[0]).toBe("2026-12-29T18:00:00.000Z");
  });

  it("counts an all-day event only when it is marked busy, in the business's own day", () => {
    expect(read(EVENT_ALLDAY_FREE)).toEqual([]);
    expect(read(EVENT_ALLDAY_BUSY)).toEqual([["2026-11-04T00:00:00.000Z", "2026-11-05T00:00:00.000Z"]]);
  });

  it("leaves out cancelled events, free ones, and the inbox's own", () => {
    expect(read(EVENT_CANCELLED_AND_FREE)).toEqual([]);
    expect(read(EVENT_DENTIST, (uid) => uid.startsWith("7E4F"))).toEqual([]);
  });

  it("reads Outlook's zone names and folded lines", () => {
    expect(resolveZone("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(resolveZone("/mozilla.org/20050126_1/Europe/Paris")).toBe("Europe/Paris");
    expect(read(EVENT_OUTLOOK)).toEqual([["2026-11-03T08:00:00.000Z", "2026-11-03T08:30:00.000Z"]]);
  });

  it("places wall times across a change of clocks", () => {
    // 29 March 2026: Lisbon goes from 01:00 to 02:00. 10:00 is 09:00Z after, 10:00Z before.
    const w = (day: number) => ({ year: 2026, month: 3, day, hour: 10, minute: 0, second: 0 });
    expect(iso(zonedToUtc(w(28), "Europe/Lisbon"))).toBe("2026-03-28T10:00:00.000Z");
    expect(iso(zonedToUtc(w(30), "Europe/Lisbon"))).toBe("2026-03-30T09:00:00.000Z");
    // In the gap, past it.
    expect(iso(zonedToUtc({ ...w(29), hour: 1, minute: 30 }, "Europe/Lisbon"))).toBe("2026-03-29T01:30:00.000Z");
  });

  it("expands monthly and yearly rules, and refuses the ones it does not read", () => {
    const until = (v: string) => Date.parse(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T23:59:59Z`);
    const second = parseRRule("FREQ=MONTHLY;BYDAY=2TU;COUNT=3", until);
    if (!second) throw new Error("unread");
    const start = { year: 2026, month: 11, day: 10, hour: 9, minute: 0, second: 0 };
    const utc = (w: typeof start) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    expect(expandRRule(second, start, utc, { after: 0, before: Date.parse("2027-12-31T00:00:00Z") }).map(iso)).toEqual([
      "2026-11-10T09:00:00.000Z",
      "2026-12-08T09:00:00.000Z",
      "2027-01-12T09:00:00.000Z",
    ]);
    const last = parseRRule("FREQ=MONTHLY;BYMONTHDAY=-1;INTERVAL=2;UNTIL=20270401", until);
    if (!last) throw new Error("unread");
    expect(
      expandRRule(last, { ...start, day: 30 }, utc, { after: 0, before: Date.parse("2027-12-31T00:00:00Z") }).map(
        (ms) => iso(ms).slice(0, 10),
      ),
    ).toEqual(["2026-11-30", "2027-01-31", "2027-03-31"]);
    expect(parseRRule("FREQ=YEARLY;BYSETPOS=-1", until)).toBeNull();
    expect(parseRRule("FREQ=HOURLY", until)).toBeNull();
  });

  it("writes an event any calendar reads back: escaped, folded, in UTC, marked busy", () => {
    const ics = buildICalEvent({
      uid: "sdi-01JB@inbox.salon.example",
      start: booking.start,
      end: booking.end,
      title: "Corte, barba; e lavagem",
      description: `Linha um\nLinha dois ${"x".repeat(90)}`,
      url: booking.url,
      itemId: booking.itemId,
      now: NOW,
    });
    expect(ics).toContain("DTSTART:20261103T150000Z\r\n");
    expect(ics).toContain("SUMMARY:Corte\\, barba\\; e lavagem\r\n");
    expect(ics).toContain("TRANSP:OPAQUE");
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(busyFromICal(ics, WINDOW, { timezone: "UTC" })).toEqual([{ start: booking.start, end: booking.end }]);
  });
});

/* --- CalDAV ---------------------------------------------------------------------- */

function icloudServer(state: { events: Map<string, string>; password?: string } = { events: new Map() }) {
  const password = state.password ?? "abcd-efgh-ijkl-mnop";
  const auth = `Basic ${btoa(`ana@icloud.com:${password}`)}`;
  return fakePlatform((req) => {
    const u = new URL(req.url);
    if (u.host === "caldav.icloud.com" && u.pathname === "/.well-known/caldav") {
      return new Response(null, { status: 301, headers: { location: "https://caldav.icloud.com/" } });
    }
    if (req.headers.get("authorization") !== auth) return new Response("", { status: 401 });
    if (u.host === "caldav.icloud.com" && u.pathname === "/" && req.method === "PROPFIND") return xml(ICLOUD_PRINCIPAL);
    if (u.host === "caldav.icloud.com" && u.pathname === "/123456789/principal/") return xml(ICLOUD_HOME_SET);
    if (u.host !== "p42-caldav.icloud.com") return undefined;
    if (u.pathname === "/123456789/calendars/" && req.method === "PROPFIND") return xml(ICLOUD_CALENDARS);
    if (req.method === "REPORT" && u.pathname === "/123456789/calendars/home/") {
      return xml(
        icloudReport([
          { href: "/123456789/calendars/home/dentist.ics", ics: EVENT_DENTIST },
          ...[...state.events].map(([href, ics]) => ({ href: new URL(href).pathname, ics })),
        ]),
      );
    }
    if (req.method === "REPORT" && u.pathname === "/123456789/calendars/work/") {
      return xml(icloudReport([{ href: "/123456789/calendars/work/yoga.ics", ics: EVENT_WEEKLY_LISBON }]));
    }
    if (req.method === "PUT") {
      const exists = state.events.has(req.url);
      if (req.headers.get("if-none-match") === "*" && exists) return new Response("", { status: 412 });
      state.events.set(req.url, req.body);
      return new Response(null, { status: exists ? 204 : 201, headers: { etag: `"${req.body.length}"` } });
    }
    if (req.method === "DELETE") {
      const had = state.events.delete(req.url);
      return new Response(null, { status: had ? 204 : 404 });
    }
    return undefined;
  });
}

describe("CalDAV: iCloud", () => {
  const icloud = caldavConnector();

  it("connects with the Apple Account email and an app-specific password, finding the partition host", async () => {
    const { http, seen } = icloudServer();
    const c = await icloud.connect?.(
      { http, now: NOW, inbox: INBOX },
      { username: "ana@icloud.com", password: "abcd-efgh-ijkl-mnop", server: "https://caldav.icloud.com" },
    );
    expect(c?.account).toBe("ana@icloud.com");
    expect(c?.externalId).toBe("https://caldav.icloud.com/123456789/principal/");
    expect(c?.calendars.map((k) => [k.name, k.writable])).toEqual([
      ["Home", true],
      ["Salon & Work", true],
      ["Family", false],
    ]);
    expect(c?.destinations.map((d) => d.name)).toEqual(["Home", "Salon & Work"]);
    expect(c?.defaults).toEqual({
      busy: c?.calendars.map((k) => k.id),
      destination: "https://p42-caldav.icloud.com/123456789/calendars/home/",
    });
    expect(c?.secret).toEqual({ username: "ana@icloud.com", password: "abcd-efgh-ijkl-mnop" });
    expect(seen.every((s) => s.url.startsWith("https://"))).toBe(true);
    expect(seen.filter((s) => s.method === "PROPFIND").map((s) => s.headers.get("depth"))).toEqual([
      "0",
      "0",
      "0",
      "1",
    ]);
  });

  it("says the password is wrong on the password field", async () => {
    const { http } = icloudServer();
    await expect(
      icloud.connect?.(
        { http, now: NOW, inbox: INBOX },
        { username: "ana@icloud.com", password: "my-apple-password", server: "https://caldav.icloud.com" },
      ),
    ).rejects.toMatchObject({ code: "auth", field: "password" });
  });

  it("reads busy times from the chosen calendars, leaving out the events this inbox wrote", async () => {
    const state = { events: new Map<string, string>() };
    const { http, seen } = icloudServer(state);
    const home = "https://p42-caldav.icloud.com/123456789/calendars/home/";
    const work = "https://p42-caldav.icloud.com/123456789/calendars/work/";
    const ctx = runContext(http, {
      secret: { username: "ana@icloud.com", password: "abcd-efgh-ijkl-mnop" },
      calendars: [
        { id: home, name: "Home", writable: true },
        { id: work, name: "Work", writable: true },
      ],
      destinations: [{ id: home, name: "Home", writable: true }],
      busyCalendars: [home, work],
      destination: home,
    });
    const link = await icloud.bookings?.put(ctx, booking, null);
    expect(link?.externalId).toBe(`${home}sdi-${booking.itemId}.ics`);
    const put = seen.find((s) => s.method === "PUT");
    expect(put?.headers.get("if-none-match")).toBe("*");
    expect(put?.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(put?.body).toContain(`UID:sdi-${booking.itemId}@inbox.salon.example`);

    const busy = await icloud.busy?.(ctx, WINDOW);
    const starts = (busy ?? []).map((i) => iso(i.start));
    expect(starts).toContain("2026-11-03T10:00:00.000Z");
    expect(starts).toContain("2026-11-03T18:00:00.000Z");
    // The booking it wrote is not a busy time of its own.
    expect(starts).not.toContain("2026-11-03T15:00:00.000Z");
    const report = seen.find((s) => s.method === "REPORT");
    expect(report?.headers.get("depth")).toBe("1");
    expect(report?.body).toContain('<c:expand start="20261102T000000Z" end="20261231T000000Z"/>');
    expect(report?.body).toContain('<c:comp-filter name="VEVENT"><c:time-range');
  });

  it("writes again over its own event, moves it between calendars, and deletes what is there or gone", async () => {
    const state = { events: new Map<string, string>() };
    const { http } = icloudServer(state);
    const home = "https://p42-caldav.icloud.com/123456789/calendars/home/";
    const work = "https://p42-caldav.icloud.com/123456789/calendars/work/";
    const ctx = runContext(http, {
      secret: { username: "ana@icloud.com", password: "abcd-efgh-ijkl-mnop" },
      destinations: [
        { id: home, name: "Home", writable: true },
        { id: work, name: "Work", writable: true },
      ],
      destination: home,
    });
    // A run that wrote the event and stopped before noting it: the next one writes it again.
    await icloud.bookings?.put(ctx, booking, null);
    const again = await icloud.bookings?.put(ctx, { ...booking, start: booking.start + 3_600_000 }, null);
    expect(state.events.size).toBe(1);
    expect(state.events.get(String(again?.externalId))).toContain("DTSTART:20261103T160000Z");
    const moved = await icloud.bookings?.put({ ...ctx, destination: work }, booking, again ?? null);
    expect(moved?.calendar).toBe(work);
    expect([...state.events.keys()]).toEqual([`${work}sdi-${booking.itemId}.ics`]);
    if (moved) await icloud.bookings?.remove(ctx, moved);
    expect(state.events.size).toBe(0);
    if (moved) await icloud.bookings?.remove(ctx, moved);
  });
});

describe("CalDAV: finding the server", () => {
  const dav = caldavConnector();

  it("follows Nextcloud's well-known redirect from the address the owner gave", async () => {
    const { http, seen } = fakePlatform((req) => {
      const u = new URL(req.url);
      if (u.host !== "cloud.example.org") return undefined;
      if (u.pathname === "/.well-known/caldav")
        return new Response(null, { status: 301, headers: { location: "/remote.php/dav/" } });
      if (u.pathname === "/remote.php/dav/") return xml(NEXTCLOUD_PRINCIPAL);
      if (u.pathname === "/remote.php/dav/principals/users/ana/") return xml(NEXTCLOUD_HOME_SET);
      if (u.pathname === "/remote.php/dav/calendars/ana/") return xml(NEXTCLOUD_CALENDARS);
      return undefined;
    });
    const c = await dav.connect?.(
      { http, now: NOW, inbox: INBOX },
      { username: "ana", password: "Xy7-app", server: "cloud.example.org" },
    );
    expect(c?.calendars).toEqual([
      { id: "https://cloud.example.org/remote.php/dav/calendars/ana/personal/", name: "Personal", writable: true },
    ]);
    expect(seen[0]?.url).toBe("https://cloud.example.org/.well-known/caldav");
  });

  it("finds the server from the email's domain through DNS when nobody gave one", async () => {
    const { http, seen } = fakePlatform((req) => {
      const u = new URL(req.url);
      if (u.host === "cloudflare-dns.com") {
        const type = u.searchParams.get("type");
        const name = u.searchParams.get("name");
        if (name !== "_caldavs._tcp.example.org") return json({ Status: 3 });
        if (type === "SRV")
          return json({ Status: 0, Answer: [{ type: 33, data: "0 1 443 dav.mailhost.example.net." }] });
        if (type === "TXT") return json({ Status: 0, Answer: [{ type: 16, data: '"path=/dav/"' }] });
      }
      if (u.host === "dav.mailhost.example.net") {
        if (u.pathname === "/dav/") return xml(NEXTCLOUD_PRINCIPAL.replaceAll("/remote.php/dav/", "/dav/"));
        if (u.pathname === "/dav/principals/users/ana/")
          return xml(NEXTCLOUD_HOME_SET.replaceAll("/remote.php/dav/", "/dav/"));
        if (u.pathname === "/dav/calendars/ana/")
          return xml(NEXTCLOUD_CALENDARS.replaceAll("/remote.php/dav/", "/dav/"));
      }
      return undefined;
    });
    const c = await dav.connect?.({ http, now: NOW, inbox: INBOX }, { username: "ana@example.org", password: "pw" });
    expect(c?.calendars[0]?.id).toBe("https://dav.mailhost.example.net/dav/calendars/ana/personal/");
    // DNS was asked for the name only.
    const dns = seen.filter((s) => s.url.startsWith("https://cloudflare-dns.com/"));
    expect(dns.map((s) => new URL(s.url).searchParams.get("name"))).toEqual([
      "_caldavs._tcp.example.org",
      "_caldavs._tcp.example.org",
    ]);
    expect(dns.every((s) => s.headers.get("authorization") === null)).toBe(true);
  });

  it("says plainly when no calendar server is found", async () => {
    const { http } = fakePlatform(() => undefined);
    await expect(
      dav.connect?.({ http, now: NOW, inbox: INBOX }, { username: "ana@example.org", password: "pw" }),
    ).rejects.toMatchObject({ code: "config", field: "server" });
  });
});

/* --- Cal.com ---------------------------------------------------------------------- */

function calcomServer(opts: { key?: string } = {}) {
  const key = opts.key ?? "cal_live_0123456789abcdef";
  const made: { uid: string; body: Record<string, unknown> }[] = [];
  const cancelled: string[] = [];
  const { http, seen } = fakePlatform((req) => {
    const u = new URL(req.url);
    if (u.host !== "api.cal.com") return undefined;
    if (req.headers.get("authorization") !== `Bearer ${key}`) {
      return json({ status: "error", error: { code: "UNAUTHORIZED", message: "Invalid API Key" } }, 401);
    }
    if (u.pathname === "/v2/me") return json(CALCOM_ME);
    if (u.pathname === "/v2/event-types") return json(CALCOM_EVENT_TYPES);
    if (u.pathname === "/v2/calendars") return json(CALCOM_CALENDARS);
    if (u.pathname === "/v2/calendars/busy-times") {
      return json({
        status: "success",
        data: [
          { start: "2026-11-03T15:00:00.000Z", end: "2026-11-03T16:00:00.000Z", source: "google" },
          { start: "2026-11-04T09:00:00.000Z", end: "2026-11-04T09:45:00.000Z", source: "google" },
        ],
      });
    }
    if (u.pathname === "/v2/bookings" && req.method === "GET") {
      if (!u.searchParams.get("cursor")) {
        return json(
          calcomBookings(
            [
              { uid: "bk-1", start: "2026-11-03T11:00:00.000Z", end: "2026-11-03T12:00:00.000Z", status: "accepted" },
              { uid: "bk-2", start: "2026-11-03T13:00:00.000Z", end: "2026-11-03T13:30:00.000Z", status: "cancelled" },
              ...made.map((m) => ({
                uid: m.uid,
                start: String(m.body.start),
                end: new Date(Date.parse(String(m.body.start)) + 3_600_000).toISOString(),
                status: "accepted",
                metadata: m.body.metadata as Record<string, string>,
              })),
            ],
            "page-2",
          ),
        );
      }
      return json(
        calcomBookings([
          { uid: "bk-3", start: "2026-11-05T10:00:00.000Z", end: "2026-11-05T10:30:00.000Z", status: "pending" },
        ]),
      );
    }
    if (u.pathname === "/v2/bookings" && req.method === "POST") {
      const body = JSON.parse(req.body) as Record<string, unknown>;
      if (String(body.start).startsWith("2026-11-07")) {
        return json(
          { status: "error", error: { message: "User either already has booking at this time or is not available" } },
          400,
        );
      }
      const uid = `new-${made.length + 1}`;
      made.push({ uid, body });
      return json({ status: "success", data: { id: 1, uid, start: body.start, status: "accepted" } }, 201);
    }
    const reschedule = /^\/v2\/bookings\/([^/]+)\/reschedule$/.exec(u.pathname);
    if (reschedule && req.method === "POST") {
      const body = JSON.parse(req.body) as Record<string, unknown>;
      const uid = `${reschedule[1]}-r`;
      return json({ status: "success", data: { uid, start: body.start, rescheduledFromUid: reschedule[1] } }, 201);
    }
    const cancel = /^\/v2\/bookings\/([^/]+)\/cancel$/.exec(u.pathname);
    if (cancel && req.method === "POST") {
      if (cancelled.includes(String(cancel[1]))) {
        return json({ status: "error", error: { message: "This booking has already been cancelled." } }, 400);
      }
      cancelled.push(String(cancel[1]));
      return json({ status: "success", data: { uid: cancel[1], status: "cancelled" } });
    }
    return undefined;
  });
  return { http, seen, made, cancelled };
}

describe("Cal.com", () => {
  const cal = calcomConnector();

  it("connects with an API key, reading whose it is and the event types", async () => {
    const { http, seen } = calcomServer();
    const c = await cal.connect?.({ http, now: NOW, inbox: INBOX }, { api_key: "cal_live_0123456789abcdef" });
    expect(c).toMatchObject({
      account: "Ana's Salon (ana-salon)",
      externalId: "4417",
      secret: { api_key: "cal_live_0123456789abcdef" },
      extra: { apiBase: "https://api.cal.com", email: "ana@salon.example" },
      defaults: { busy: [], destination: CALCOM_AUTO },
    });
    expect(c?.destinations.map((d) => [d.id, d.lengths])).toEqual([
      [CALCOM_AUTO, undefined],
      ["101", [60]],
      ["102", [30]],
      ["103", [90, 120]],
    ]);
    expect(seen.find((s) => s.url.endsWith("/v2/event-types"))?.headers.get("cal-api-version")).toBe("2026-06-12");
  });

  it("says the key is wrong on the key field", async () => {
    const { http } = calcomServer();
    await expect(
      cal.connect?.({ http, now: NOW, inbox: INBOX }, { api_key: "cal_live_wrongwrongwrong" }),
    ).rejects.toMatchObject({ code: "auth", field: "api_key" });
  });

  const ctxFor = (http: RunContext["http"], over: Partial<RunContext> = {}) =>
    runContext(http, {
      secret: { api_key: "cal_live_0123456789abcdef" },
      extra: { apiBase: "https://api.cal.com", email: "ana@salon.example" },
      destinations: [
        { id: CALCOM_AUTO, name: "auto", writable: true },
        { id: "101", name: "Haircut · 60 min", writable: true, lengths: [60] },
        { id: "102", name: "Quick trim · 30 min", writable: true, lengths: [30] },
        { id: "103", name: "Colour · 90 min", writable: true, lengths: [90, 120] },
      ],
      destination: CALCOM_AUTO,
      ...over,
    });

  it("creates the booking on the event type as long as it, naming the customer but giving Cal.com no email", async () => {
    const { http, seen, made } = calcomServer();
    const link = await cal.bookings?.put(ctxFor(http), booking, null);
    expect(link).toEqual({ externalId: "new-1", etag: null, calendar: "101" });
    const post = seen.find((s) => s.method === "POST" && s.url.endsWith("/v2/bookings"));
    expect(post?.headers.get("cal-api-version")).toBe("2026-02-25");
    expect(made[0]?.body).toEqual({
      start: "2026-11-03T15:00:00.000Z",
      eventTypeId: 101,
      attendee: { name: "Rita Amaral", timeZone: "Europe/Lisbon", language: "pt" },
      metadata: { sdi_item: booking.itemId, sdi_inbox: "inbox.salon.example" },
    });
    expect(JSON.stringify(made[0]?.body)).not.toContain("@");
    // A length an event type takes as an option is asked for.
    await cal.bookings?.put(ctxFor(http), { ...booking, durationMin: 120, end: booking.start + 7_200_000 }, null);
    expect(made[1]?.body).toMatchObject({ eventTypeId: 103, lengthInMinutes: 120 });
  });

  it("moves by rescheduling, cancels, and treats cancelled already as done", async () => {
    const { http, seen, cancelled } = calcomServer();
    const ctx = ctxFor(http);
    const moved = await cal.bookings?.put(
      ctx,
      { ...booking, start: booking.start + 3_600_000, end: booking.end + 3_600_000 },
      { externalId: "new-1", etag: null, calendar: "101", start: booking.start, end: booking.end },
    );
    expect(moved?.externalId).toBe("new-1-r");
    const r = seen.find((s) => s.url.endsWith("/reschedule"));
    expect(JSON.parse(r?.body ?? "{}")).toEqual({
      start: "2026-11-03T16:00:00.000Z",
      rescheduledBy: "ana@salon.example",
      reschedulingReason: "Moved in the inbox",
    });
    // Same times: nothing is sent.
    const before = seen.length;
    await cal.bookings?.put(ctx, booking, {
      externalId: "x",
      etag: null,
      calendar: "101",
      start: booking.start,
      end: booking.end,
    });
    expect(seen.length).toBe(before);
    await cal.bookings?.remove(ctx, { externalId: "new-1-r", etag: null, calendar: "101" });
    await cal.bookings?.remove(ctx, { externalId: "new-1-r", etag: null, calendar: "101" });
    expect(cancelled).toEqual(["new-1-r"]);
  });

  it("refuses honestly when no event type fits, or Cal.com will not take the time", async () => {
    const { http } = calcomServer();
    await expect(
      cal.bookings?.put(ctxFor(http), { ...booking, durationMin: 45, end: booking.start + 45 * 60_000 }, null),
    ).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("No Cal.com event type is 45 minutes long"),
    });
    await expect(cal.bookings?.put(ctxFor(http, { destination: "102" }), booking, null)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("cannot take a 60-minute booking"),
    });
    const saturday = Date.parse("2026-11-07T10:00:00Z");
    await expect(
      cal.bookings?.put(ctxFor(http), { ...booking, start: saturday, end: saturday + 3_600_000 }, null),
    ).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("Cal.com would not take 7 Nov") });
  });

  it("reads busy times from bookings and checked calendars, leaving out this inbox's own", async () => {
    const { http, made } = calcomServer();
    await cal.bookings?.put(ctxFor(http), booking, null);
    const busy = await cal.busy?.(
      ctxFor(http, { own: { ids: new Set(["new-1"]), spans: [{ start: booking.start, end: booking.end }] } }),
      WINDOW,
    );
    expect((busy ?? []).map((i) => [iso(i.start), iso(i.end)])).toEqual([
      ["2026-11-03T11:00:00.000Z", "2026-11-03T12:00:00.000Z"],
      ["2026-11-04T09:00:00.000Z", "2026-11-04T09:45:00.000Z"],
      ["2026-11-05T10:00:00.000Z", "2026-11-05T10:30:00.000Z"],
    ]);
    expect(made).toHaveLength(1);
  });

  it("finds a booking it made when a run stopped before noting it", async () => {
    const { http } = calcomServer();
    await cal.bookings?.put(ctxFor(http), booking, null);
    expect(await cal.bookings?.find?.(ctxFor(http), booking)).toEqual({
      externalId: "new-1",
      etag: null,
      calendar: null,
    });
  });
});

/* --- Google Calendar ----------------------------------------------------------------- */

function googleServer() {
  const events = new Map<string, { status: string; body: Record<string, unknown> }>();
  const tokenBodies: URLSearchParams[] = [];
  let access = "ya29.a0-test-access";
  const { http, seen } = fakePlatform((req) => {
    const u = new URL(req.url);
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      const body = new URLSearchParams(req.body);
      tokenBodies.push(body);
      if (body.get("grant_type") === "refresh_token") {
        if (body.get("refresh_token") === "revoked") return json({ error: "invalid_grant" }, 400);
        access = "ya29.a0-refreshed";
        return json({ access_token: access, expires_in: 3599, token_type: "Bearer" });
      }
      return json(GOOGLE_TOKEN);
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") return new Response("");
    if (u.host !== "www.googleapis.com") return undefined;
    if (req.headers.get("authorization") !== `Bearer ${access}`) return json({ error: { code: 401 } }, 401);
    if (u.pathname === "/calendar/v3/calendars/primary/events" && req.method === "GET") return json(GOOGLE_PROBE);
    if (u.pathname === "/calendar/v3/freeBusy") {
      const body = JSON.parse(req.body) as { timeMin: string; timeMax: string };
      const busy = [
        { start: "2026-11-03T10:00:00Z", end: "2026-11-03T11:00:00Z" },
        { start: "2026-11-03T15:00:00Z", end: "2026-11-03T16:00:00Z" },
        { start: "2026-12-20T10:00:00Z", end: "2026-12-20T12:00:00Z" },
      ].filter((b) => b.start >= body.timeMin && b.start < body.timeMax);
      return json({ kind: "calendar#freeBusy", calendars: { primary: { busy } } });
    }
    const one = /^\/calendar\/v3\/calendars\/primary\/events\/([a-v0-9]+)$/.exec(u.pathname);
    if (u.pathname === "/calendar/v3/calendars/primary/events" && req.method === "POST") {
      const body = JSON.parse(req.body) as Record<string, unknown>;
      const id = String(body.id);
      if (events.has(id))
        return json({ error: { code: 409, message: "The requested identifier already exists." } }, 409);
      events.set(id, { status: "confirmed", body });
      return json({ ...body, etag: '"1"' });
    }
    if (one && req.method === "PATCH") {
      const id = String(one[1]);
      const e = events.get(id);
      if (!e) return json({ error: { code: 404 } }, 404);
      const body = JSON.parse(req.body) as Record<string, unknown>;
      events.set(id, { status: String(body.status ?? e.status), body: { ...e.body, ...body } });
      return json({ id, ...body, etag: '"2"' });
    }
    if (one && req.method === "DELETE") {
      const id = String(one[1]);
      const e = events.get(id);
      if (!e || e.status === "cancelled") return json({ error: { code: 410 } }, 410);
      e.status = "cancelled";
      return new Response(null, { status: 204 });
    }
    return undefined;
  });
  return { http, seen, events, tokenBodies };
}

describe("Google Calendar", () => {
  const client = { clientId: "1234-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test" };

  it("is soon until the instance has a client, and asks for the two narrow scopes with PKCE and offline access", () => {
    expect(googleCalendarConnector(null).ready?.()).toBe("Google sign-in is not set up on this inbox yet.");
    const google = googleCalendarConnector(client);
    expect(google.ready?.()).toBe(true);
    const url = new URL(
      google.oauth?.authorizeUrl({
        redirectUri: "https://inbox.salon.example/oauth/connect/google_calendar/callback",
        state: "st",
        challenge: "ch",
      }) ?? "",
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: client.clientId,
      redirect_uri: "https://inbox.salon.example/oauth/connect/google_calendar/callback",
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
    expect(GOOGLE_SCOPES).toEqual([
      "https://www.googleapis.com/auth/calendar.events.owned",
      "https://www.googleapis.com/auth/calendar.freebusy",
    ]);
  });

  it("exchanges the code with its verifier and names the account by its calendar", async () => {
    const { http, tokenBodies } = googleServer();
    const c = await googleCalendarConnector(client).oauth?.exchange(
      { http, now: NOW, inbox: INBOX },
      { code: "4/0Ab-code", verifier: "v".repeat(64), redirectUri: "https://inbox.salon.example/cb" },
    );
    expect(Object.fromEntries(tokenBodies[0] ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "4/0Ab-code",
      code_verifier: "v".repeat(64),
      redirect_uri: "https://inbox.salon.example/cb",
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    expect(c).toMatchObject({
      account: "ana.salon@gmail.com",
      externalId: "ana.salon@gmail.com",
      secret: { refresh_token: "1//0g-test-refresh", access_token: "ya29.a0-test-access" },
      defaults: { busy: ["primary"], destination: "primary" },
    });
  });

  it("refuses an access that left the calendar out", async () => {
    const { http } = fakePlatform((req) =>
      req.url.startsWith("https://oauth2.googleapis.com/token")
        ? json({ ...GOOGLE_TOKEN, scope: "https://www.googleapis.com/auth/calendar.freebusy" })
        : undefined,
    );
    await expect(
      googleCalendarConnector(client).oauth?.exchange(
        { http, now: NOW, inbox: INBOX },
        { code: "c", verifier: "v".repeat(64), redirectUri: "https://x.example/cb" },
      ),
    ).rejects.toMatchObject({ code: "refused" });
  });

  const secret = {
    refresh_token: "1//0g-test-refresh",
    access_token: "ya29.a0-test-access",
    access_expires_at: String(NOW + 3_000_000),
  };

  it("reads busy times in pieces Google answers, leaving out the inbox's own by their times", async () => {
    const { http, seen } = googleServer();
    const busy = await googleCalendarConnector(client).busy?.(
      runContext(http, {
        secret,
        busyCalendars: ["primary"],
        own: { ids: new Set(), spans: [{ start: booking.start, end: booking.end }] },
      }),
      WINDOW,
    );
    expect((busy ?? []).map((i) => iso(i.start))).toEqual(["2026-11-03T10:00:00.000Z", "2026-12-20T10:00:00.000Z"]);
    expect(seen.filter((s) => s.url.endsWith("/freeBusy")).length).toBe(2);
  });

  it("writes with an id of its own, so a retry or a booking made again lands on the same event", async () => {
    const { http, seen, events } = googleServer();
    const google = googleCalendarConnector(client);
    const ctx = runContext(http, { secret, destination: "primary" });
    const link = await google.bookings?.put(ctx, booking, null);
    const id = googleEventId(booking.itemId);
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(link).toEqual({ externalId: id, etag: '"1"', calendar: "primary" });
    const post = seen.find((s) => s.method === "POST" && s.url.includes("/events?"));
    expect(new URL(post?.url ?? "").searchParams.get("sendUpdates")).toBe("none");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      id,
      summary: "Haircut · Rita Amaral",
      transparency: "opaque",
      extendedProperties: { private: { sdiItem: booking.itemId, sdiInbox: "inbox.salon.example" } },
    });
    // Written again without the link (a run that stopped): the 409 becomes an update.
    await google.bookings?.put(ctx, { ...booking, title: "Haircut" }, null);
    expect(events.size).toBe(1);
    expect(events.get(id)?.body.summary).toBe("Haircut");
    if (link) await google.bookings?.remove(ctx, link);
    expect(events.get(id)?.status).toBe("cancelled");
    if (link) await google.bookings?.remove(ctx, link);
    // Booked again after a cancellation: the cancelled event comes back.
    await google.bookings?.put(ctx, booking, null);
    expect(events.get(id)?.status).toBe("confirmed");
  });

  it("says so when the Calendar API is not switched on for the client", async () => {
    const { http } = fakePlatform((req) =>
      req.url.includes("/calendar/v3/")
        ? json(
            {
              error: {
                code: 403,
                message: "Google Calendar API has not been used in project 123 before or it is disabled.",
                errors: [{ reason: "accessNotConfigured" }],
              },
            },
            403,
          )
        : undefined,
    );
    await expect(
      googleCalendarConnector(client).busy?.(runContext(http, { secret, busyCalendars: ["primary"] }), WINDOW),
    ).rejects.toMatchObject({ code: "config" });
  });

  it("refreshes an access token that ran out, keeps the new one, and says when access was withdrawn", async () => {
    const { http } = googleServer();
    const google = googleCalendarConnector(client);
    const saved: Record<string, string>[] = [];
    const ctx = runContext(http, {
      secret: { ...secret, access_expires_at: String(NOW - 1) },
      busyCalendars: ["primary"],
      saveSecret: async (next) => {
        saved.push({ ...next });
      },
    });
    await google.busy?.(ctx, WINDOW);
    expect(saved[0]).toMatchObject({ access_token: "ya29.a0-refreshed", refresh_token: "1//0g-test-refresh" });
    await expect(
      google.busy?.(
        runContext(http, {
          secret: { refresh_token: "revoked", access_token: "", access_expires_at: "0" },
          busyCalendars: ["primary"],
        }),
        WINDOW,
      ),
    ).rejects.toMatchObject({ code: "auth", message: "Google stopped this connection. Connect it again." });
  });
});
