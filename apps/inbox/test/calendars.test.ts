import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { type Db, schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_PROBE,
  GOOGLE_TOKEN,
  ICLOUD_CALENDARS,
  ICLOUD_HOME_SET,
  ICLOUD_PRINCIPAL,
  icloudReport,
} from "../../../packages/adapters/test/fixtures/calendars";
import { createInbox, type Inbox } from "../src/app";
import { freshDb, futureDay, nextDay, openWeekdays } from "./harness";

/**
 * A calendar connected end to end (ADR-022), through the doors an owner and an agent use: Settings
 * connects iCloud with an app-specific password, the five-minute sync reads a dentist's appointment
 * that takes 10:00 off the free times, a booking the owner confirms lands in iCloud within the same
 * run of the outbox, and goes when it is cancelled. Google is connected by its sign-in, through the
 * callback the owner's browser comes back to. The platforms are fakes at the fetch level.
 */
const DAY = futureDay(7);
const NEXT = nextDay(DAY);
const SECRET_KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";
const APPLE_ID = "ana@icloud.com";
const APP_PASSWORD = "abcd-efgh-ijkl-mnop";
const GOOGLE = { clientId: "1234-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test" };

function dentist(day: string): string {
  const d = day.replaceAll("-", "");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:dentist@icloud.com\r\nDTSTART:${d}T100000Z\r\nDTEND:${d}T110000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}

interface Platforms {
  readonly fetch: typeof fetch;
  readonly icloud: Map<string, string>;
  readonly calls: string[];
}

/** iCloud and Google, as fakes behind one fetch. */
function platforms(): Platforms {
  const icloud = new Map<string, string>();
  const calls: string[] = [];
  const auth = `Basic ${btoa(`${APPLE_ID}:${APP_PASSWORD}`)}`;
  const xml = (body: string) => new Response(body, { status: 207, headers: { "content-type": "application/xml" } });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === "caldav.icloud.com" || url.host === "p42-caldav.icloud.com") {
      if (url.pathname === "/.well-known/caldav") {
        return new Response(null, { status: 301, headers: { location: "https://caldav.icloud.com/" } });
      }
      if (headers.get("authorization") !== auth) {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="iCloud"' } });
      }
      if (url.host === "caldav.icloud.com" && url.pathname === "/") return xml(ICLOUD_PRINCIPAL);
      if (url.pathname === "/123456789/principal/") return xml(ICLOUD_HOME_SET);
      if (url.pathname === "/123456789/calendars/" && method === "PROPFIND") return xml(ICLOUD_CALENDARS);
      if (method === "REPORT") {
        const own = [...icloud]
          .filter(([href]) => href.startsWith(`https://${url.host}${url.pathname}`))
          .map(([href, ics]) => ({ href: new URL(href).pathname, ics }));
        const theirs = url.pathname.endsWith("/home/")
          ? [{ href: `${url.pathname}dentist.ics`, ics: dentist(DAY) }]
          : [];
        return xml(icloudReport([...theirs, ...own]));
      }
      if (method === "PUT") {
        const had = icloud.has(url.toString());
        if (headers.get("if-none-match") === "*" && had) return new Response("", { status: 412 });
        icloud.set(url.toString(), body);
        return new Response(null, { status: had ? 204 : 201, headers: { etag: `"${body.length}"` } });
      }
      if (method === "DELETE") return new Response(null, { status: icloud.delete(url.toString()) ? 204 : 404 });
    }
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") return json(GOOGLE_TOKEN);
    if (url.host === "www.googleapis.com") {
      if (url.pathname === "/calendar/v3/calendars/primary/events" && method === "GET") return json(GOOGLE_PROBE);
      if (url.pathname === "/calendar/v3/freeBusy") return json({ calendars: { primary: { busy: [] } } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, icloud, calls };
}

async function setup(opts: { google?: boolean; secretKey?: string | null; hosted?: boolean } = {}) {
  const db = await freshDb();
  const serviceId = ulid();
  const now = Date.now();
  await db.orm.insert(schema.services).values({
    id: serviceId,
    name: "Haircut",
    durationMin: 60,
    capacity: 1,
    granularityMin: 30,
    createdAt: now,
    updatedAt: now,
  });
  await openWeekdays(db);
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const p = platforms();
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    secretKey: opts.secretKey === null ? undefined : (opts.secretKey ?? SECRET_KEY),
    baseUrl: "https://inbox.example.com",
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    fetchImpl: p.fetch,
    ...(opts.google === false ? {} : { oauth: { google: GOOGLE } }),
    ...(opts.hosted ? { oauthRedirect: () => "https://oauth.example.com/oauth/google/callback" } : {}),
  });
  return { db, inbox, app: inbox.app, serviceId, owner: { authorization: `Bearer ${ownerKey}` }, p, pending };
}

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://inbox.example.com${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function drain(inbox: Inbox, db: Db, pending: Promise<unknown>[]): Promise<void> {
  await Promise.all(pending);
  for (let pass = 0; pass < 10; pass++) {
    if ((await inbox.runner.runDue(db)).claimed === 0) return;
  }
  throw new Error("the outbox never settled");
}

async function freeTimes(inbox: Inbox, serviceId: string): Promise<string[]> {
  const res = await inbox.app.request(
    req("GET", `/v1/availability?service_id=${serviceId}&from=${DAY}T00:00:00Z&to=${NEXT}T00:00:00Z`),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { slots: { startTime: string }[] };
  return body.slots.map((s) => s.startTime.slice(11, 16));
}

async function connectIcloud(s: Awaited<ReturnType<typeof setup>>, password = APP_PASSWORD) {
  return s.app.request(
    req(
      "POST",
      "/v1/owner/integrations",
      { kind: "caldav", preset: "icloud", values: { username: APPLE_ID, password } },
      s.owner,
    ),
  );
}

describe("Settings → Integrations", () => {
  it("shows every card, with Google ready only when the inbox has a client, the payment platforms ready, and what is being built saying soon", async () => {
    const withGoogle = await setup();
    const res = await withGoogle.app.request(req("GET", "/v1/owner/integrations", undefined, withGoogle.owner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cards: {
        id: string;
        status: string;
        ways: {
          kind: string;
          preset: string | null;
          status: string;
          form: { key: string; secret: boolean; link?: { href: string } }[];
        }[];
      }[];
      can_connect: boolean;
    };
    expect(body.can_connect).toBe(true);
    // Ready: what this release connects. Soon: only what is being built now, a till that takes bookings
    // first for an inbox with services. Nothing else is listed.
    expect(body.cards.map((c) => [c.id, c.status])).toEqual([
      ["calendar", "ready"],
      ["calcom", "ready"],
      ["calendly", "ready"],
      ["ics_feed", "ready"],
      ["stripe", "ready"],
      ["mollie", "ready"],
      ["square", "ready"],
      ["woocommerce", "ready"],
      ["shopify", "ready"],
      // A trade's job tool (ADR-039): ServiceM8 with the owner's own key.
      ["job_tool", "ready"],
      // A kitchen's ordering system and till (ADR-040): GloriaFood and Flipdish with the owner's own keys.
      ["pos", "ready"],
    ]);
    const tools = body.cards.find((c) => c.id === "job_tool");
    // Housecall Pro and Fergus until their API terms are cleared on the server, Jobber and ServiceM8's
    // own sign-in until a partner app is there: "set up", never a button that goes nowhere.
    expect(tools?.ways.map((w) => [w.preset ?? w.kind, w.status])).toEqual([
      ["servicem8", "ready"],
      ["housecallpro", "setup"],
      ["fergus", "setup"],
      ["jobber", "setup"],
      ["oauth", "setup"],
    ]);
    const calendar = body.cards.find((c) => c.id === "calendar");
    // Outlook is its published calendar link, with Outlook's steps: busy times only, and ready.
    expect(calendar?.ways.map((w) => [w.preset ?? w.kind, w.status])).toEqual([
      ["google_calendar", "ready"],
      ["icloud", "ready"],
      ["fastmail", "ready"],
      ["nextcloud", "ready"],
      ["other", "ready"],
      ["ics", "ready"],
      ["outlook", "ready"],
    ]);
    expect((calendar as { line?: string } | undefined)?.line).toBe("Google, iCloud, Fastmail and more");
    const icloud = calendar?.ways.find((w) => w.preset === "icloud");
    expect(icloud?.form.map((f) => [f.key, f.secret])).toEqual([
      ["username", false],
      ["password", true],
    ]);
    expect(icloud?.form[1]?.link?.href).toBe("https://account.apple.com/account/manage/section/security");
    const calcom = body.cards.find((c) => c.id === "calcom")?.ways[0];
    expect(calcom?.form[0]?.link?.href).toBe("https://app.cal.com/settings/developer/api-keys");

    const without = await setup({ google: false });
    const plain = (await (
      await without.app.request(req("GET", "/v1/owner/integrations", undefined, without.owner))
    ).json()) as typeof body;
    const google = plain.cards.find((c) => c.id === "calendar")?.ways.find((w) => w.kind === "google_calendar");
    // One's own server with no Google client: something to set up, and how; never "soon" for ever.
    expect(google).toMatchObject({ status: "setup", form: [], hint: "Needs a Google client on the server." });
    const calendarLine = plain.cards.find((c) => c.id === "calendar") as { line?: string; ways: { kind: string }[] };
    expect(calendarLine.line).toBe("iCloud, Fastmail, Nextcloud and more");
    expect(calendarLine.ways.map((w) => w.kind).slice(-1)).toEqual(["google_calendar"]);

    const hosted = await setup({ google: false, hosted: true });
    const onHosted = (await (
      await hosted.app.request(req("GET", "/v1/owner/integrations", undefined, hosted.owner))
    ).json()) as typeof body;
    expect(
      onHosted.cards.find((c) => c.id === "calendar")?.ways.find((w) => w.kind === "google_calendar"),
    ).toMatchObject({ status: "soon" });
  });

  it("says nothing can be connected without INBOX_SECRET_KEY, and refuses to try", async () => {
    const s = await setup({ secretKey: null });
    const body = (await (await s.app.request(req("GET", "/v1/owner/integrations", undefined, s.owner))).json()) as {
      can_connect: boolean;
    };
    expect(body.can_connect).toBe(false);
    const res = await connectIcloud(s);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("INBOX_SECRET_KEY");
  });

  it("names the wrong field when iCloud refuses the password", async () => {
    const s = await setup();
    const res = await connectIcloud(s, "my-real-apple-password");
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { fields: { path: string }[]; detail: string };
    expect(problem.fields[0]?.path).toBe("values.password");
    expect(problem.detail).toContain("app password");
  });
});

describe("an iCloud calendar, end to end", () => {
  it("connects, takes the busy hour off the free times, and keeps a confirmed booking in step", async () => {
    const s = await setup();
    expect(await freeTimes(s.inbox, s.serviceId)).toContain("10:00");

    const connected = await connectIcloud(s);
    expect(connected.status, await connected.clone().text()).toBe(201);
    const view = (await connected.json()) as { id: string; account: string; title: string; status: string };
    expect(view).toMatchObject({ account: APPLE_ID, title: "iCloud", status: "configured" });
    // The password is in no answer, and in no row in the clear.
    const listing = await (await s.app.request(req("GET", "/v1/owner/integrations", undefined, s.owner))).text();
    expect(listing).not.toContain(APP_PASSWORD);
    const { rows } = await s.db.client.query({
      sql: "SELECT config_enc, config_public FROM connectors",
      method: "all",
    });
    expect(JSON.stringify(rows)).not.toContain(APP_PASSWORD);

    await s.inbox.app.request(req("POST", `/v1/owner/integrations/${view.id}/sync`, {}, s.owner));
    await drain(s.inbox, s.db, s.pending);
    const free = await freeTimes(s.inbox, s.serviceId);
    expect(free).not.toContain("10:00");
    expect(free).not.toContain("09:30");
    expect(free).toContain("09:00");
    expect(free).toContain("14:00");
    const synced = (await (
      await s.app.request(req("GET", `/v1/owner/integrations/${view.id}`, undefined, s.owner))
    ).json()) as { status: string; busy_times: number };
    expect(synced).toMatchObject({ status: "active", busy_times: 1 });

    // A customer asks for 14:00; the owner confirms; the booking is in iCloud after the outbox runs.
    const created = await s.app.request(
      req("POST", "/v1/bookings", {
        payload: {
          reservationFor: { serviceId: s.serviceId, name: "Haircut" },
          startTime: `${DAY}T14:00:00Z`,
          endTime: `${DAY}T15:00:00Z`,
        },
        contact: { name: "Rita Amaral", email: "rita@example.com" },
      }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const itemId = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
    const confirmed = await s.app.request(
      req("POST", `/v1/owner/items/${itemId}/transitions`, { event: "confirm" }, s.owner),
    );
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    await drain(s.inbox, s.db, s.pending);
    const href = `https://p42-caldav.icloud.com/123456789/calendars/home/sdi-${itemId}.ics`;
    expect(s.p.icloud.get(href)).toContain("SUMMARY:Haircut · Rita Amaral");
    const { rows: instance } = await s.db.client.query({
      sql: "SELECT value FROM instance_meta WHERE key = 'instance_id'",
      method: "all",
    });
    expect(s.p.icloud.get(href)).toContain(`UID:sdi-${itemId}@${String(instance[0]?.[0])}.inbox`);

    // Read back on the next sync, it is the inbox's own: it does not block itself.
    await s.inbox.app.request(req("POST", `/v1/owner/integrations/${view.id}/sync`, {}, s.owner));
    await drain(s.inbox, s.db, s.pending);
    const again = (await (
      await s.app.request(req("GET", `/v1/owner/integrations/${view.id}`, undefined, s.owner))
    ).json()) as { busy_times: number; bookings_written: number };
    expect(again).toMatchObject({ busy_times: 1, bookings_written: 1 });

    const cancelled = await s.app.request(
      req("POST", `/v1/owner/items/${itemId}/transitions`, { event: "cancel_by_business" }, s.owner),
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    await drain(s.inbox, s.db, s.pending);
    expect(s.p.icloud.has(href)).toBe(false);
  });

  it("lets the owner choose the calendars and pause, and the owner's AI only read and sync", async () => {
    const s = await setup();
    const view = (await (await connectIcloud(s)).json()) as { id: string; calendars: { id: string; name: string }[] };
    const work = view.calendars.find((c) => c.name === "Salon & Work")?.id;
    const patched = await s.app.request(
      req("PATCH", `/v1/owner/integrations/${view.id}`, { busy_calendars: [work], destination: work }, s.owner),
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await patched.json()).toMatchObject({ busy_calendars: [work], destination: work });
    const bad = await s.app.request(
      req(
        "PATCH",
        `/v1/owner/integrations/${view.id}`,
        { busy_calendars: ["https://elsewhere.example.com/x/"] },
        s.owner,
      ),
    );
    expect(bad.status).toBe(422);

    await drain(s.inbox, s.db, s.pending);

    // The owner's AI, over the owner MCP: it lists and syncs; connecting is the owner's.
    const transport = new StreamableHTTPClientTransport(new URL("https://inbox.example.com/mcp/owner"), {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", s.owner.authorization);
        return s.app.fetch(new Request(String(input), { ...init, headers }));
      }) as typeof fetch,
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    const listed = (await client.callTool({ name: "list_integrations", arguments: {} })) as {
      content: { text: string }[];
      structuredContent: { connections: { id: string }[] };
    };
    // The PATCH synced at once: the work calendar holds nothing here.
    expect(listed.content[0]?.text).toContain(`${view.id} iCloud [active] 0 busy times ahead (read to `);
    expect(listed.content[0]?.text).toContain("), 0 bookings written");
    // Every card is built: nothing is said to be on its way.
    expect(listed.content[0]?.text).not.toContain("Soon:");
    expect(JSON.stringify(listed)).not.toContain(APP_PASSWORD);
    const sync = (await client.callTool({ name: "sync_integration", arguments: { connection_id: view.id } })) as {
      isError?: boolean;
    };
    expect(sync.isError).toBeFalsy();
    await client.close();

    const removed = await s.app.request(req("DELETE", `/v1/owner/integrations/${view.id}`, undefined, s.owner));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true, left_in_calendar: 0 });
  });
});

describe("who may connect", () => {
  it("lets a key handed to another system list and sync, and refuses it the rest", async () => {
    const s = await setup();
    const view = (await (await connectIcloud(s)).json()) as { id: string };
    const integration = (
      await createApiKey(s.db, { kind: "integration", name: "Zapier", scopes: ["integrations:write"] })
    ).key;
    const key = { authorization: `Bearer ${integration}` };
    expect((await s.app.request(req("GET", "/v1/owner/integrations", undefined, key))).status).toBe(200);
    expect((await s.app.request(req("POST", `/v1/owner/integrations/${view.id}/sync`, {}, key))).status).toBe(200);
    expect(
      (await s.app.request(req("PATCH", `/v1/owner/integrations/${view.id}`, { busy_on: false }, key))).status,
    ).toBe(403);
    expect((await s.app.request(req("DELETE", `/v1/owner/integrations/${view.id}`, undefined, key))).status).toBe(403);
    expect(
      (
        await s.app.request(
          req(
            "POST",
            "/v1/owner/integrations",
            { kind: "caldav", preset: "icloud", values: { username: APPLE_ID, password: APP_PASSWORD } },
            key,
          ),
        )
      ).status,
    ).toBe(403);
  });

  it("connects a failing calendar again in place, with only the new password", async () => {
    const s = await setup();
    const view = (await (await connectIcloud(s)).json()) as { id: string; calendars: { id: string; name: string }[] };
    const work = view.calendars.find((c) => c.name === "Salon & Work")?.id;
    await s.app.request(req("PATCH", `/v1/owner/integrations/${view.id}`, { busy_calendars: [work] }, s.owner));
    const again = await s.app.request(
      req(
        "POST",
        "/v1/owner/integrations",
        { kind: "caldav", connection_id: view.id, values: { password: APP_PASSWORD } },
        s.owner,
      ),
    );
    expect(again.status, await again.clone().text()).toBe(201);
    expect(await again.json()).toMatchObject({ id: view.id, preset: "icloud", busy_calendars: [work] });
  });
});

describe("Google, by its sign-in", () => {
  it("sends the owner to Google with PKCE and connects when Google sends them back", async () => {
    const s = await setup();
    const started = await s.app.request(
      req("POST", "/v1/owner/integrations/authorize", { kind: "google_calendar" }, s.owner),
    );
    expect(started.status, await started.clone().text()).toBe(200);
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const url = new URL(authorize_url);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://inbox.example.com/oauth/connect/google_calendar/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state") ?? "";

    const back = await s.app.request(
      req("GET", `/oauth/connect/google_calendar/callback?state=${encodeURIComponent(state)}&code=4%2F0Ab-code`),
    );
    expect(back.status).toBe(303);
    expect(back.headers.get("referrer-policy")).toBe("no-referrer");
    const location = new URL(back.headers.get("location") ?? "", "https://inbox.example.com");
    expect(location.pathname).toBe("/settings/integrations");
    const id = location.searchParams.get("connected");
    expect(id).toBeTruthy();
    const view = (await (
      await s.app.request(req("GET", `/v1/owner/integrations/${id}`, undefined, s.owner))
    ).json()) as { account: string; kind: string };
    expect(view).toMatchObject({ kind: "google_calendar", account: "ana.salon@gmail.com" });

    // The same state again, or a made-up one: nothing happens but a plain sentence.
    const replay = await s.app.request(
      req("GET", `/oauth/connect/google_calendar/callback?state=${encodeURIComponent(state)}&code=again`),
    );
    expect(new URL(replay.headers.get("location") ?? "", "https://x.example").searchParams.get("connect_error")).toBe(
      "That sign-in had expired or was used already. Try again.",
    );
    const forged = await s.app.request(req("GET", "/oauth/connect/google_calendar/callback?state=made-up&code=x"));
    expect(new URL(forged.headers.get("location") ?? "", "https://x.example").searchParams.get("connect_error")).toBe(
      "That sign-in was not started here. Try again from Settings.",
    );
  });

  it("never sends the owner back to another site, whatever path the sign-in was started with", async () => {
    const s = await setup();
    for (const path of ["/.//evil.example/x", "/a/..//evil.example/x", "//evil.example"]) {
      const started = await s.app.request(
        req("POST", "/v1/owner/integrations/authorize", { kind: "google_calendar", return_to: path }, s.owner),
      );
      const state = new URL(((await started.json()) as { authorize_url: string }).authorize_url).searchParams.get(
        "state",
      );
      const back = await s.app.request(
        req(
          "GET",
          `/oauth/connect/google_calendar/callback?state=${encodeURIComponent(state ?? "")}&error=access_denied`,
        ),
      );
      const location = back.headers.get("location") ?? "";
      expect(location.startsWith("/settings/integrations?"), location).toBe(true);
    }
  });

  it("is refused when the inbox has no Google client", async () => {
    const s = await setup({ google: false });
    const res = await s.app.request(
      req("POST", "/v1/owner/integrations/authorize", { kind: "google_calendar" }, s.owner),
    );
    expect(res.status).toBe(403);
  });
});
