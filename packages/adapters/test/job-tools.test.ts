import {
  ConnectorError,
  type ConnectorHttp,
  type InboundRequest,
  type OutboundRequest,
  type RunContext,
  writeFirst,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  FERGUS_SOURCE,
  fergusConnector,
  hmacSha256Hex,
  housecallproConnector,
  JOBBER_TEMPLATE_VERSION,
  jobberConnector,
  leadTag,
  servicem8Connector,
} from "../src/index";
import { freshDb } from "./db";
import { fakePlatform, json } from "./fakes/platform";
import {
  cardDataSent,
  FERGUS,
  fakeFergus,
  fakeHousecallPro,
  fakeJobber,
  fakeServiceM8,
  SM8,
  type Sm8State,
} from "./fakes/work";

/**
 * The job tools (ADR-039 §5) against local fakes of their published references: connect with the
 * owner's own key, write a request the owner took on (a ServiceM8 job in Quote status with its photos,
 * a Housecall Pro lead, a Fergus enquiry with its files, a Jobber request), find it again after an
 * answer that never came, a key withdrawn, a 429, and a webhook nobody signed. Runs on Node and in workerd.
 */

const T0 = Date.parse("2026-11-04T07:30:00Z");
const INBOX = {
  id: "inb_7f3a",
  origin: "https://fundiflow.example",
  host: "fundiflow.example",
  name: "Fundi Flow Plumbing",
  timezone: "Africa/Nairobi",
  language: "en",
};

function ctx(http: ConnectorHttp, secret: Record<string, string>, extra: Record<string, unknown> = {}): RunContext {
  const saved: Record<string, string>[] = [];
  return {
    http,
    now: T0,
    inbox: INBOX,
    secret,
    extra,
    calendars: [],
    busyCalendars: [],
    destinations: [],
    destination: null,
    own: { ids: new Set(), spans: [] },
    marker: "marker-only-this-inbox-makes",
    async saveSecret(next) {
      saved.push({ ...next });
    },
  };
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xd9]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");

function request(over: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    itemId: "01JC7Q2M4X9ZK8T3R5V6W7Y8Z0",
    reference: "W7Y8Z0",
    key: "inb_7f3a:01JC7Q2M4X9ZK8T3R5V6W7Y8Z0",
    title: "Leaking kitchen tap",
    // As the inbox writes it (`outboundRequest`): the customer's words, the job, and where it is in the inbox.
    description:
      "The tap under the sink drips all night.\n\nUrgency: This week. A visit is needed first.\nPhotos and plans: 2.\nRequest W7Y8Z0: https://fundiflow.example/items/01JC7Q2M4X9ZK8T3R5V6W7Y8Z0",
    urgency: "this_week",
    visit: "needed",
    site: { streetAddress: "14 Mpaka Road", addressLocality: "Nairobi", postalCode: "00800", addressCountry: "KE" },
    siteNotes: "Blue gate, ask for the caretaker.",
    windows: [],
    customer: { name: "Wanjiru Kamau", email: "wanjiru@example.com", phone: "+254 712 345 678", language: "en" },
    url: "https://fundiflow.example/items/01JC7Q2M4X9ZK8T3R5V6W7Y8Z0",
    files: [
      {
        id: "att_aaaaaaaaaaaaaaaaaaaa",
        name: "sink.jpg",
        contentType: "image/jpeg",
        size: JPEG.byteLength,
        read: async () => JPEG,
      },
      {
        id: "att_bbbbbbbbbbbbbbbbbbbb",
        name: "plan.pdf",
        contentType: "application/pdf",
        size: PDF.byteLength,
        read: async () => PDF,
      },
    ],
    ...over,
  };
}

const hook = (body: string, headers: Record<string, string> = {}): InboundRequest => ({
  headers: new Headers(headers),
  body,
  query: new URLSearchParams(),
});

describe("ServiceM8", () => {
  const def = servicem8Connector();

  it("connects with the owner's API key, reads the account's zone, and asks to hear of schedule changes", async () => {
    const p = fakePlatform();
    const sm8 = fakeServiceM8(p);
    const c = await def.connect?.(
      {
        http: p.http,
        now: T0,
        inbox: INBOX,
        hookUrl: "https://fundiflow.example/v1/hooks/servicem8/tok",
        hooksLive: true,
      },
      { api_key: sm8.key },
    );
    expect(c).toMatchObject({
      account: "Fundi Flow Plumbing",
      externalId: "6f1c2a3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
      extra: { timezone: "Africa/Nairobi", webhook: true },
    });
    expect(sm8.subscriptions[0]?.get("object")).toBe("jobactivity");
    expect(sm8.subscriptions[0]?.get("callback_url")).toBe("https://fundiflow.example/v1/hooks/servicem8/tok");
    expect(p.seen.every((r) => r.headers.get("x-api-key") === sm8.key)).toBe(true);
    await expect(
      def.connect?.({ http: p.http, now: T0, inbox: INBOX }, { api_key: "smk-wrong-wrong" }),
    ).rejects.toMatchObject({ code: "auth", field: "api_key" });
  });

  it("writes a job in Quote status, with a client, a contact and the photos in the job diary, once", async () => {
    const p = fakePlatform();
    const sm8 = fakeServiceM8(p);
    const run = ctx(p.http, { api_key: sm8.key }, { timezone: "Africa/Nairobi" });
    const ref = await def.requests?.put(run, request());
    const job = [...sm8.records.entries()].find(([k]) => k.startsWith("job:"))?.[1];
    expect(job).toMatchObject({ status: "Quote", job_address: "14 Mpaka Road, Nairobi, 00800, KE" });
    expect(String(job?.job_description)).toContain("Leaking kitchen tap (W7Y8Z0)");
    expect(ref?.externalId).toBe(job?.uuid);
    expect(ref?.url).toBe(`https://go.servicem8.com/OpenJob/${job?.uuid}`);
    expect([...sm8.records.keys()].filter((k) => k.startsWith("jobcontact:"))).toHaveLength(1);
    expect(sm8.attachments.map((a) => [a.related_object, a.related_object_uuid, a.file?.split(":")[1]])).toEqual([
      ["job", job?.uuid, "sink.jpg"],
      ["job", job?.uuid, "plan.pdf"],
    ]);
    // Again (a retry, a second press): found under the same ids, nothing made twice.
    const again = await def.requests?.put(run, request());
    expect(again?.externalId).toBe(ref?.externalId);
    expect([...sm8.records.keys()].filter((k) => k.startsWith("job:"))).toHaveLength(1);
    expect(sm8.attachments).toHaveLength(2);
    expect(cardDataSent(p)).toBe(false);
  });

  it("finds a job whose answer never came, by the ids only this inbox makes", async () => {
    const p = fakePlatform();
    // The job lands, and the answer is lost on the way back.
    let sm8: Sm8State | null = null;
    p.on("POST", `${SM8}/job.json`, (req) => {
      const body = JSON.parse(req.body) as { uuid: string };
      sm8?.records.set(`job:${body.uuid}`, { ...body, active: 1 });
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    sm8 = fakeServiceM8(p);
    const run = ctx(p.http, { api_key: sm8.key });
    expect(await def.requests?.find(run, request())).toBeNull();
    await expect(def.requests?.put(run, request())).rejects.toMatchObject({ code: "unreachable" });
    const found = await def.requests?.find(run, request());
    expect(found?.externalId).toBe([...sm8.records.values()].find((r) => r.status === "Quote")?.uuid);
  });

  it("is written first: an answer that never came is looked for before anything is decided", async () => {
    const p = fakePlatform();
    const sm8 = fakeServiceM8(p);
    const run = ctx(p.http, { api_key: sm8.key });
    const writes: string[] = [];
    let landed = false;
    const { db } = await freshDb();
    await db.client.query({
      sql: "INSERT INTO connectors (id, kind, name, config_enc, status, created_at, updated_at) VALUES ('sm8', 'servicem8', 'ServiceM8', '', 'active', ?, ?)",
      params: [T0, T0],
      method: "run",
    });
    const r = await writeFirst(db, {
      connectorId: "sm8",
      itemId: "item1",
      op: "request",
      owner: "trades",
      key: request().key,
      request: { reference: "W7Y8Z0" },
      now: T0,
      timeoutMs: 50,
      async write() {
        writes.push("write");
        await def.requests?.put(run, request());
        landed = true;
        // The tool took it, and its answer never arrived.
        return new Promise(() => {});
      },
      async find() {
        const f = await def.requests?.find(run, request());
        return f ? { externalId: f.externalId } : null;
      },
    });
    expect(landed).toBe(true);
    expect(r.status).toBe("written");
    expect(writes).toEqual(["write"]);
  });

  it("starts the inbox from the account's opening hours, in the zone it keeps them in", async () => {
    const p = fakePlatform();
    const sm8 = fakeServiceM8(p);
    const run = ctx(p.http, { api_key: sm8.key }, { timezone: "Africa/Nairobi" });
    expect(def.capabilities).toContain("setup_in");
    const snap = await def.setup?.read(run);
    expect(snap).toEqual({
      source: {
        kind: "servicem8",
        account: "6f1c2a3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
        readAt: T0,
        zone: "Africa/Nairobi",
      },
      hours: {
        mon: [["08:00", "17:00"]],
        tue: [["08:00", "17:00"]],
        wed: [["08:00", "17:00"]],
        thu: [["08:00", "17:00"]],
        fri: [["08:00", "17:00"]],
        sat: [["09:00", "13:00"]],
      },
    });
    // Nothing but the account was read, and nothing was written.
    expect(p.seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(["GET /api_1.0/vendor.json"]);
    sm8.key = "smk-revoked-in-settings";
    await expect(def.setup?.read(run)).rejects.toMatchObject({ code: "auth" });
  });

  it("says when its key is withdrawn, and waits when it is asked to slow down", async () => {
    const p = fakePlatform();
    const sm8 = fakeServiceM8(p);
    const run = ctx(p.http, { api_key: sm8.key }, { timezone: "Africa/Nairobi" });
    p.fail("POST", `${SM8}/company.json`, 429);
    await expect(def.requests?.put(run, request())).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 7_000,
    });
    sm8.key = "smk-revoked-in-settings";
    await expect(def.busy?.(run, { start: T0, end: T0 + 86_400_000 })).rejects.toMatchObject({ code: "auth" });
  });

  it("reads scheduled visits in the account's own zone, page by page, leaving out what is not scheduled", async () => {
    const p = fakePlatform();
    const sm8 = fakeServiceM8(p);
    sm8.pageSize = 1;
    sm8.activities = [
      {
        uuid: "a1",
        active: 1,
        activity_was_scheduled: "1",
        start_date: "2026-11-05 09:00:00",
        end_date: "2026-11-05 11:00:00",
      },
      {
        uuid: "a2",
        active: 0,
        activity_was_scheduled: "1",
        start_date: "2026-11-05 13:00:00",
        end_date: "2026-11-05 14:00:00",
      },
      {
        uuid: "a3",
        active: 1,
        activity_was_scheduled: "1",
        start_date: "2026-11-06 08:00:00",
        end_date: "2026-11-06 09:30:00",
      },
    ];
    const run = ctx(p.http, { api_key: sm8.key }, { timezone: "Africa/Nairobi" });
    const busy = await def.busy?.(run, { start: T0, end: T0 + 3 * 86_400_000 });
    expect(busy).toEqual([
      { start: Date.parse("2026-11-05T06:00:00Z"), end: Date.parse("2026-11-05T08:00:00Z") },
      { start: Date.parse("2026-11-06T05:00:00Z"), end: Date.parse("2026-11-06T06:30:00Z") },
    ]);
    expect(p.requests("GET", `${SM8}/jobactivity.json`)).toHaveLength(3);
    expect(
      decodeURIComponent(p.seen.find((r) => r.url.pathname.endsWith("jobactivity.json"))?.url.search ?? ""),
    ).toContain("activity_was_scheduled eq 1");
  });

  it("signs in with no webhook yet, answers ServiceM8's challenge, and subscribes on the first sync", async () => {
    const p = fakePlatform();
    const sm8 = fakeServiceM8(p, "sm8-access-token-0001");
    p.on("POST", "https://go.servicem8.com/oauth/access_token", () =>
      json({ access_token: sm8.key, refresh_token: "sm8-refresh-1", expires_in: 3600 }),
    );
    const app = servicem8Connector({ clientId: "app-id", clientSecret: "app-secret" });
    const hookUrl = "https://fundiflow.example/v1/hooks/servicem8/tok";
    const c = await app.oauth?.exchange(
      { http: p.http, now: T0, inbox: INBOX, hookUrl, hooksLive: true },
      { code: "code-1", verifier: "v", redirectUri: "https://fundiflow.example/oauth/connect/servicem8/callback" },
    );
    // While connecting, the address does not answer yet: no subscription is asked for.
    expect(c?.extra).toMatchObject({ webhook: false });
    expect(sm8.subscriptions).toHaveLength(0);
    const saved: Record<string, string>[] = [];
    const run: RunContext = {
      ...ctx(p.http, { ...(c?.secret ?? {}) }, { timezone: "Africa/Nairobi" }),
      hookUrl,
      hooksLive: true,
      async saveSecret(next) {
        saved.push({ ...next });
      },
    };
    // ServiceM8 proves the address before it sends anything: its challenge goes back as it came.
    expect(await app.hooks?.verify(run, hook("mode=subscribe&challenge=8f2c1d9e-challenge"))).toEqual({
      challenge: "8f2c1d9e-challenge",
    });
    await app.busy?.(run, { start: T0, end: T0 + 86_400_000 });
    expect(sm8.subscriptions).toHaveLength(1);
    expect(sm8.subscriptions[0]?.get("callback_url")).toBe(hookUrl);
    expect(saved[0]?.hooked).toBe("1");
    // Once subscribed, a sync asks for no other.
    await app.busy?.({ ...run, secret: saved[0] ?? {} }, { start: T0, end: T0 + 86_400_000 });
    expect(sm8.subscriptions).toHaveLength(1);
  });

  it("takes a webhook only as a nudge to read the schedule again: its body is never believed", async () => {
    const run = ctx(fakePlatform().http, { api_key: "smk-x" });
    const event = await def.hooks?.verify(
      run,
      hook(
        JSON.stringify({
          object: "JobActivity",
          entry: [
            {
              uuid: "de305d54-75b4-431b-adb2-eb6b9e546013",
              time: "2026-11-04 07:31:00",
              changed_fields: ["start_date"],
            },
          ],
          resource_url: "https://evil.example/x",
        }),
      ),
    );
    expect(event).toMatchObject({ topic: "jobactivity", refs: ["de305d54-75b4-431b-adb2-eb6b9e546013"] });
    expect(await def.hooks?.read(run, event as never)).toEqual([{ kind: "busy" }]);
    await expect(def.hooks?.verify(run, hook("not a webhook"))).rejects.toBeInstanceOf(ConnectorError);
    expect(await def.hooks?.verify(run, hook(JSON.stringify({ object: "job", entry: [] })))).toBeNull();
  });
});

describe("Housecall Pro", () => {
  const def = housecallproConnector({ cleared: true });

  it("says set up until its API terms are cleared on this server", () => {
    expect(housecallproConnector().ready?.()).toBe("Needs setup: waiting on Housecall Pro's API terms.");
    expect(housecallproConnector().whenNotReady?.status).toBe("setup");
    expect(def.ready?.()).toBe(true);
  });

  it("connects with the company's API key and writes a lead with the customer, tagged to be found again", async () => {
    const p = fakePlatform();
    const hcp = fakeHousecallPro(p);
    const c = await def.connect?.({ http: p.http, now: T0, inbox: INBOX }, { api_key: hcp.key });
    expect(c).toMatchObject({ account: "Southern Cross Renovations", externalId: "cmp_8b2f" });
    const run = ctx(p.http, { api_key: hcp.key });
    expect(await def.requests?.find(run, request())).toBeNull();
    const ref = await def.requests?.put(run, request());
    expect(ref).toEqual({ externalId: "lea_1" });
    expect(hcp.leads[0]).toMatchObject({
      customer: {
        first_name: "Wanjiru",
        last_name: "Kamau",
        email: "wanjiru@example.com",
        notifications_enabled: false,
      },
      tags: [leadTag(request())],
    });
    // Leads take no files: the note says where they are, in the business's own inbox.
    expect(String(hcp.leads[0]?.note)).toContain("https://fundiflow.example/items/");
    expect(await def.requests?.put(run, request())).toEqual({ externalId: "lea_1" });
    expect(hcp.leads).toHaveLength(1);
    expect(p.seen.every((r) => r.headers.get("authorization") === `Token ${hcp.key}`)).toBe(true);
    expect(cardDataSent(p)).toBe(false);
  });

  it("reads scheduled jobs as UTC, says a withdrawn key, and waits as asked", async () => {
    const p = fakePlatform();
    const hcp = fakeHousecallPro(p);
    hcp.jobs = [
      {
        id: "job_1",
        work_status: "scheduled",
        schedule: { scheduled_start: "2026-11-05T01:00:00", scheduled_end: "2026-11-05T03:00:00" },
      },
      {
        id: "job_2",
        work_status: "pro canceled",
        schedule: { scheduled_start: "2026-11-05T04:00:00", scheduled_end: "2026-11-05T05:00:00" },
      },
    ];
    const run = ctx(p.http, { api_key: hcp.key });
    expect(await def.busy?.(run, { start: T0, end: T0 + 2 * 86_400_000 })).toEqual([
      { start: Date.parse("2026-11-05T01:00:00Z"), end: Date.parse("2026-11-05T03:00:00Z") },
    ]);
    p.fail("POST", "https://api.housecallpro.com/leads", 429);
    await expect(def.requests?.put(run, request())).rejects.toMatchObject({ code: "rate_limited" });
    hcp.key = "revoked";
    await expect(def.busy?.(run, { start: T0, end: T0 + 1 })).rejects.toMatchObject({ code: "auth" });
  });

  it("checks a webhook's signature over its timestamp and body, refusing a forged or stale one", async () => {
    const secret = "hcp-signing-southerncross";
    const run = ctx(fakePlatform().http, { api_key: "k", signing_secret: secret });
    const body = JSON.stringify({
      event: "job.scheduled",
      company_id: "cmp_8b2f",
      event_occurred_at: "2026-11-04T07:29:00Z",
      job: { id: "job_9" },
    });
    const ts = String(Math.floor(T0 / 1000));
    const sig = await hmacSha256Hex(secret, `${ts}.${body}`);
    const event = await def.hooks?.verify(run, hook(body, { "api-timestamp": ts, "api-signature": sig }));
    expect(event).toMatchObject({ topic: "job.scheduled", refs: ["job_9"] });
    expect(await def.hooks?.read(run, event as never)).toEqual([{ kind: "busy" }]);
    await expect(
      def.hooks?.verify(run, hook(body, { "api-timestamp": ts, "api-signature": sig.replace(/.$/, "0") })),
    ).rejects.toMatchObject({ code: "refused" });
    await expect(
      def.hooks?.verify(run, hook(`${body} `, { "api-timestamp": ts, "api-signature": sig })),
    ).rejects.toMatchObject({ code: "refused" });
    const old = String(Math.floor(T0 / 1000) - 3600);
    await expect(
      def.hooks?.verify(
        run,
        hook(body, { "api-timestamp": old, "api-signature": await hmacSha256Hex(secret, `${old}.${body}`) }),
      ),
    ).rejects.toMatchObject({ code: "refused" });
    await expect(
      def.hooks?.verify(
        ctx(fakePlatform().http, { api_key: "k" }),
        hook(body, { "api-timestamp": ts, "api-signature": sig }),
      ),
    ).rejects.toMatchObject({ code: "refused" });
  });
});

describe("Fergus", () => {
  const def = fergusConnector({ cleared: true });

  it("says set up until its API terms are cleared on this server", () => {
    expect(fergusConnector().ready?.()).toBe("Needs setup: waiting on Fergus's API terms.");
    expect(def.ready?.()).toBe(true);
  });

  it("connects with a personal access token and keeps when it runs out", async () => {
    const p = fakePlatform();
    const fg = fakeFergus(p);
    const c = await def.connect?.({ http: p.http, now: T0, inbox: INBOX }, { token: fg.token });
    expect(c).toMatchObject({ account: "Elektro Brandt", externalId: "8a7d2c1e-elektro" });
    expect(c?.extra?.tokenExpiresAt).toBe(T0 + 365 * 86_400_000);
    await expect(
      def.connect?.({ http: p.http, now: T0, inbox: INBOX }, { token: "nope-nope-nope" }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  it("writes an enquiry with its files, found again by the reference it carries", async () => {
    const p = fakePlatform();
    const fg = fakeFergus(p);
    const run = ctx(p.http, { token: fg.token });
    const ref = await def.requests?.put(run, request());
    expect(ref).toEqual({ externalId: "100" });
    expect(fg.enquiries[0]).toMatchObject({
      name: "Wanjiru Kamau",
      source: FERGUS_SOURCE,
      addressPostcode: "00800",
      addressCountry: "KE",
    });
    expect(fg.attachments.map((a) => [a.entityType, a.entityId, a.fileName])).toEqual([
      ["enquiry", "100", "1-sink.jpg"],
      ["enquiry", "100", "2-plan.pdf"],
    ]);
    expect(await def.requests?.find(run, request())).toEqual({ externalId: "100" });
    // A retry finds it, and adds no file twice.
    await def.requests?.put(run, request());
    expect(fg.enquiries).toHaveLength(1);
    expect(fg.attachments).toHaveLength(2);
    // Another request is another enquiry.
    await def.requests?.put(run, request({ reference: "Q1R2S3", key: "inb_7f3a:other" }));
    expect(fg.enquiries).toHaveLength(2);
    expect(cardDataSent(p)).toBe(false);
  });

  it("keeps every photo of a request, though phones name them all alike", async () => {
    const p = fakePlatform();
    const fg = fakeFergus(p);
    const run = ctx(p.http, { token: fg.token });
    const photo = (id: string) => ({
      id,
      name: "image.jpg",
      contentType: "image/jpeg",
      size: JPEG.byteLength,
      read: async () => JPEG,
    });
    const files = [photo("att_cccccccccccccccccccc"), photo("att_dddddddddddddddddddd")];
    await def.requests?.put(run, request({ files }));
    expect(fg.attachments.map((a) => a.fileName)).toEqual(["1-image.jpg", "2-image.jpg"]);
    await def.requests?.put(run, request({ files }));
    expect(fg.attachments).toHaveLength(2);
  });

  it("finds an enquiry with a long description whose answer never came, and writes it once", async () => {
    const p = fakePlatform();
    let fg: ReturnType<typeof fakeFergus> | null = null;
    let lost = true;
    // The first enquiry lands, and its answer is lost on the way back.
    p.on("POST", `${FERGUS}/enquiries`, (req) => {
      const body = JSON.parse(req.body) as Record<string, unknown>;
      fg?.enquiries.push({ id: 100 + (fg?.enquiries.length ?? 0), ...body });
      if (lost) {
        lost = false;
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      return new Response(JSON.stringify({ result: "success", data: { id: 99, ...body } }), { status: 201 });
    });
    fg = fakeFergus(p);
    const run = ctx(p.http, { token: fg.token });
    const long = request({ description: "The pipe under the floor. ".repeat(360) });
    expect(long.description.length).toBeGreaterThan(9_000);
    await expect(def.requests?.put(run, long)).rejects.toMatchObject({ code: "unreachable" });
    // The reference comes first in the enquiry's words, so the cut takes the end of the description.
    expect(String(fg.enquiries[0]?.description)).toMatch(/^Ref W7Y8Z0-/);
    expect(await def.requests?.find(run, long)).toEqual({ externalId: "100" });
    expect(await def.requests?.put(run, long)).toEqual({ externalId: "100" });
    expect(fg.enquiries).toHaveLength(1);
  });

  it("reads its calendar month by month, says a withdrawn token, and waits as asked", async () => {
    const p = fakePlatform();
    const fg = fakeFergus(p);
    fg.events = [
      { id: 1, startTime: "2026-11-05T07:00:00.000Z", endTime: "2026-11-05T09:00:00.000Z", isActive: true },
      { id: 2, startTime: "2026-11-05T10:00:00.000Z", endTime: "2026-11-05T11:00:00.000Z", isActive: false },
    ];
    const run = ctx(p.http, { token: fg.token });
    const busy = await def.busy?.(run, { start: T0, end: T0 + 3 * 86_400_000 });
    expect(busy).toEqual([{ start: Date.parse("2026-11-05T07:00:00Z"), end: Date.parse("2026-11-05T09:00:00Z") }]);
    p.fail("POST", "https://api.fergus.com/enquiries", 429);
    await expect(def.requests?.put(run, request())).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 7_000,
    });
    fg.token = "rotated";
    await expect(def.busy?.(run, { start: T0, end: T0 + 1 })).rejects.toMatchObject({ code: "auth" });
    // No webhooks in its reference: nothing to forge.
    expect(def.hooks).toBeUndefined();
  });
});

describe("Jobber (switched off until a reviewed app and its API version are on the server)", () => {
  const VERSION = "2025-04-16";

  it("says set up without its app, or with only the template's version, and writes a request once on", async () => {
    expect(jobberConnector(null).ready?.()).toBe("Needs a Jobber app, reviewed by Jobber, on this server.");
    const client = { clientId: "jobber-client", clientSecret: "jobber-secret" };
    // The app's keys alone (held to start Jobber's review) do not switch it on.
    expect(jobberConnector(client).ready?.()).toMatch(/API version/);
    expect(jobberConnector(client, { apiVersion: JOBBER_TEMPLATE_VERSION }).ready?.()).toMatch(/API version/);
    const def = jobberConnector(client, { apiVersion: VERSION });
    expect(def.ready?.()).toBe(true);
    const p = fakePlatform();
    const jb = fakeJobber(p);
    const run = ctx(p.http, { access_token: jb.token, refresh_token: "r", access_expires_at: String(T0 + 3_600_000) });
    const ref = await def.requests?.put(run, request());
    expect(ref?.externalId).toMatch(/^Z2lk/);
    expect(jb.requests[0]?.title).toBe("Leaking kitchen tap (W7Y8Z0)");
    expect(jb.notes[0]).toContain("drips all night");
    expect(jb.versions.every((v) => v === VERSION)).toBe(true);
    expect((await def.requests?.put(run, request()))?.externalId).toBe(ref?.externalId);
    expect(jb.requests).toHaveLength(1);
    // The same customer's next request goes to the client they already are.
    await def.requests?.put(run, request({ reference: "Q1R2S3", key: "inb_7f3a:other", title: "Blocked drain" }));
    expect(jb.requests).toHaveLength(2);
    expect(jb.clients).toHaveLength(1);
    jb.token = "revoked";
    await expect(def.busy?.(run, { start: T0, end: T0 + 1 })).rejects.toMatchObject({ code: "auth" });
  });

  it("checks Jobber's signature with the app's secret, and hears a disconnect as access withdrawn", async () => {
    const def = jobberConnector({ clientId: "c", clientSecret: "jobber-secret" }, { apiVersion: VERSION });
    const run = ctx(fakePlatform().http, { access_token: "t" });
    const body = JSON.stringify({
      data: {
        webHookEvent: {
          topic: "APP_DISCONNECT",
          appId: "a",
          accountId: "acc",
          itemId: "acc",
          occurredAt: "2026-11-04T07:00:00Z",
        },
      },
    });
    const { hmacSha256Base64 } = await import("../src/index");
    const good = await hmacSha256Base64("jobber-secret", body);
    const event = await def.hooks?.verify(run, hook(body, { "x-jobber-hmac-sha256": good }));
    expect(await def.hooks?.read(run, event as never)).toEqual([{ kind: "revoked" }]);
    // Sent to the app's one address: the account says whose connection it is, once the signature checks out.
    expect(await def.hooks?.account?.(hook(body, { "x-jobber-hmac-sha256": good }))).toBe("acc");
    await expect(
      def.hooks?.account?.(hook(body, { "x-jobber-hmac-sha256": await hmacSha256Base64("other", body) })),
    ).rejects.toMatchObject({ code: "refused" });
    await expect(
      def.hooks?.verify(run, hook(body, { "x-jobber-hmac-sha256": await hmacSha256Base64("other", body) })),
    ).rejects.toMatchObject({ code: "refused" });
    await expect(
      jobberConnector(null).hooks?.verify(run, hook(body, { "x-jobber-hmac-sha256": good })),
    ).rejects.toMatchObject({ code: "refused" });
  });
});
