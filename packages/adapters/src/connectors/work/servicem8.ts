import {
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  type HookChallenge,
  type HookEvent,
  type Interval,
  instantOf,
  isoIn,
  mergeIntervals,
  type OAuthClient,
  type OutboundRequest,
  type RequestRef,
  type RunContext,
  type SetupSnapshot,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { addressLine, failOn, fileName, jobTitle, jsonOf, multipart, splitName, uuidFrom } from "./common";

/**
 * ServiceM8 (ADR-034 §5), with the owner's own API key: "You do not need a ServiceM8 Developer account
 * to use API keys" (https://developer.servicem8.com/docs/authentication). A request the owner takes on
 * becomes a job in Quote status, with a client, a job contact, the site as the job address, and the
 * customer's photos and plans in the job diary; the staff's scheduled job activities are the busy
 * times visits are offered around.
 *
 * Every record is created under a UUID this inbox makes from its own mark and the request (ServiceM8
 * takes the caller's: "UUID is optional for record creation"), and is looked for by it before it is
 * made, so a retry, a timeout or a second press never makes two. A webhook from ServiceM8 names only
 * a record and the fields that changed, never their values, and carries no signature for API-key
 * subscriptions (https://developer.servicem8.com/docs/webhooks-overview): it is a nudge, and busy
 * times are read again with the key. Limits: 180 requests a minute and 20,000 a day per account
 * (https://developer.servicem8.com/reference/createjobs.md); a 429 waits.
 *
 * The OAuth way (a one-click sign-in) needs ServiceM8's Development Partner registration and a Public
 * Application (App ID and Secret): it is built, and says "set up" until the server holds them. A public
 * application's webhook subscription is proved by a challenge ServiceM8 posts to the address
 * (`mode=subscribe&challenge=…`, answered with the challenge), so it is made on the first sync after
 * the connection is kept, never while connecting, when the address does not answer yet.
 *
 * Docs read 21 Oct 2026: /docs/authentication, /docs/rest-overview, /docs/pagination, /docs/filtering,
 * /docs/webhooks-overview, /docs/attaching-files-to-a-job-diary, /reference/createjobs, getjobs,
 * createclients, createjobcontacts, createattachments, listjobactivities, listvendors,
 * post_object_webhook_subscription.
 */

export const SERVICEM8_API = "https://api.servicem8.com/api_1.0";
export const SERVICEM8_WEBHOOKS = "https://api.servicem8.com/webhook_subscriptions/object";
const AUTHORIZE = "https://go.servicem8.com/oauth/authorize";
const TOKEN = "https://go.servicem8.com/oauth/access_token";
/** Only what the inbox needs, which ServiceM8 rewards with a higher rate limit. */
export const SERVICEM8_SCOPES = [
  "vendor",
  "read_jobs",
  "create_jobs",
  "manage_customers",
  "manage_job_contacts",
  "manage_attachments",
  "read_schedule",
] as const;
/** The job activity fields a webhook is asked for: a visit scheduled, moved, given to someone or removed. */
const ACTIVITY_FIELDS = "start_date,end_date,staff_uuid,active,activity_was_scheduled";
/** Pages of job activities one read takes (1,000 a page): past them, nothing further is offered. */
const MAX_PAGES = 10;
/** How far before the window a visit's start is looked for: one that began then may still be going. */
const LOOK_BACK_MS = 7 * 86_400_000;

export const servicem8Form = z.object({
  api_key: secretField(z.string().trim().min(10).max(200), {
    label: "API key",
    help: "In ServiceM8: Settings → API Keys → Generate. Copy it when it is shown.",
    link: { href: "https://developer.servicem8.com/docs/authentication", text: "How to make an API key" },
    placeholder: "smk-…",
  }),
});

function auth(secret: Readonly<Record<string, string>>): Record<string, string> {
  if (secret.api_key) return { "x-api-key": secret.api_key };
  if (secret.access_token) return { authorization: `Bearer ${secret.access_token}` };
  throw new ConnectorError("auth", "ServiceM8's key is missing. Connect it again.");
}

interface Api {
  get(path: string): Promise<{ res: ConnectorHttpResponse; json: unknown }>;
  post(path: string, body: unknown): Promise<{ res: ConnectorHttpResponse; json: unknown }>;
  upload(
    fields: Record<string, string>,
    file: { filename: string; contentType: string; bytes: Uint8Array },
  ): Promise<ConnectorHttpResponse>;
}

function apiOf(ctx: Pick<ConnectContext, "http">, secret: Readonly<Record<string, string>>): Api {
  const headers = () => ({ ...auth(secret), accept: "application/json" });
  const done = (res: ConnectorHttpResponse) => {
    failOn("ServiceM8", res, "api_key");
    return { res, json: jsonOf(res) };
  };
  return {
    async get(path) {
      return done(await ctx.http.request({ method: "GET", url: `${SERVICEM8_API}${path}`, headers: headers() }));
    },
    async post(path, body) {
      return done(
        await ctx.http.request({
          method: "POST",
          url: `${SERVICEM8_API}${path}`,
          headers: { ...headers(), "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async upload(fields, file) {
      const form = multipart([
        ...Object.entries(fields).map(([name, value]) => ({ name, value })),
        { name: "file", value: file },
      ]);
      const res = await ctx.http.request({
        method: "POST",
        url: `${SERVICEM8_API}/attachment.json`,
        headers: { ...headers(), "content-type": form.contentType },
        bytes: form.body,
        timeoutMs: 60_000,
      });
      failOn("ServiceM8", res, "api_key");
      return res;
    },
  };
}

interface Vendor {
  readonly uuid: string;
  readonly name: string;
  readonly timezone: string;
}

async function vendorOf(api: Api): Promise<Vendor> {
  const { res, json } = await api.get("/vendor.json");
  if (res.status !== 200 || !Array.isArray(json) || !json[0]) {
    throw new ConnectorError("bad_response", "ServiceM8 did not say which account this is.");
  }
  const v = json[0] as { uuid?: unknown; name?: unknown; timezone_name?: unknown };
  if (typeof v.uuid !== "string" || !v.uuid)
    throw new ConnectorError("bad_response", "ServiceM8 did not say which account this is.");
  return {
    uuid: v.uuid,
    name: typeof v.name === "string" && v.name.trim() ? v.name.trim() : "ServiceM8",
    timezone: typeof v.timezone_name === "string" && v.timezone_name ? v.timezone_name : "UTC",
  };
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** A minute of the day as ServiceM8 sends it ("480" is 08:00), or null when it is not one. */
function minuteOf(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,4}$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 1440 ? n : null;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * The account's opening hours, to start from (`setup_in`): `opening_time_<day>` and
 * `closing_time_<day>` of the vendor record, each "the minute of the day (from midnight)", in the
 * account's `timezone_name` (https://developer.servicem8.com/reference/getvendors.md). A day whose
 * times are missing, not minutes, or do not close after they open is a closed day.
 */
export async function servicem8Setup(
  ctx: RunContext,
  secret: Readonly<Record<string, string>>,
): Promise<SetupSnapshot> {
  const { res, json } = await apiOf(ctx, secret).get("/vendor.json");
  if (res.status !== 200 || !Array.isArray(json) || !json[0] || typeof json[0] !== "object") {
    throw new ConnectorError("bad_response", "ServiceM8 did not send the account's details.");
  }
  const v = json[0] as Record<string, unknown>;
  const hours: Record<string, (readonly [string, string])[]> = {};
  DAYS.forEach((day, i) => {
    const open = minuteOf(v[`opening_time_${day}`]);
    const close = minuteOf(v[`closing_time_${day}`]);
    if (open !== null && close !== null && close > open) hours[DAY_KEYS[i] as string] = [[hhmm(open), hhmm(close)]];
  });
  return {
    source: {
      kind: "servicem8",
      account: typeof v.uuid === "string" ? v.uuid : "",
      readAt: ctx.now,
      ...(typeof v.timezone_name === "string" && v.timezone_name ? { zone: v.timezone_name } : {}),
    },
    hours,
  };
}

/** Whether a record is there under a UUID: found (200), not there (404), else what went wrong. */
async function exists(api: Api, path: string): Promise<boolean> {
  const { res } = await api.get(path);
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new ConnectorError("bad_response", `ServiceM8 answered ${res.status} when asked for a record.`);
}

async function create(api: Api, path: string, body: Record<string, unknown>): Promise<void> {
  const { res, json } = await api.post(path, body);
  if (res.status === 200) return;
  const message = (json as { message?: unknown } | null)?.message;
  throw new ConnectorError(
    res.status === 400 ? "refused" : "bad_response",
    `ServiceM8 would not take it${typeof message === "string" ? `: ${message.slice(0, 200)}` : "."}`,
  );
}

/** Subscribes to job activity changes at the connection's own address; a nudge to read busy times again. */
async function subscribe(ctx: ConnectContext, secret: Readonly<Record<string, string>>): Promise<boolean> {
  if (!ctx.hookUrl || ctx.hooksLive === false) return false;
  const body = new URLSearchParams({
    object: "jobactivity",
    fields: ACTIVITY_FIELDS,
    callback_url: ctx.hookUrl,
    unique_id: `inbox-${ctx.inbox.id}`.slice(0, 100),
  }).toString();
  try {
    const res = await ctx.http.request({
      method: "POST",
      url: SERVICEM8_WEBHOOKS,
      headers: { ...auth(secret), accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    return res.status === 200;
  } catch {
    // A webhook is a nudge: busy times are read every few minutes without one.
    return false;
  }
}

async function connected(ctx: ConnectContext, secret: Readonly<Record<string, string>>): Promise<Connected> {
  const vendor = await vendorOf(apiOf(ctx, secret));
  // An API key's subscription is made now. A sign-in's is proved by a challenge to the connection's
  // address, which answers only once the connection is kept: it is made on the first sync (`busy`).
  const hooked = secret.api_key ? await subscribe(ctx, secret) : false;
  return {
    account: vendor.name,
    externalId: vendor.uuid,
    secret,
    extra: { timezone: vendor.timezone, webhook: hooked },
    calendars: [{ id: "schedule", name: "Scheduled visits", writable: false, primary: true }],
    destinations: [],
    defaults: { busy: ["schedule"], destination: null },
  };
}

/** ServiceM8 writes local times, "YYYY-MM-DD HH:MM:SS", in the account's own zone. */
function localOf(ms: number, zone: string): string {
  return isoIn(ms, zone).slice(0, 19).replace("T", " ");
}

function instantOfLocal(text: unknown, zone: string): number | null {
  if (typeof text !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(text.trim());
  if (!m?.[1] || !m[2]) return null;
  try {
    return instantOf(m[1], m[2].length === 5 ? `${m[2]}:00` : m[2], zone);
  } catch {
    return null;
  }
}

/** The ids of the request's records, from the inbox's own mark: the job, its client, its contact, each file. */
async function idsOf(ctx: RunContext, r: OutboundRequest) {
  return {
    job: await uuidFrom(ctx.marker, `${r.key}:job`),
    company: await uuidFrom(ctx.marker, `${r.key}:company`),
    contact: await uuidFrom(ctx.marker, `${r.key}:contact`),
    file: (id: string) => uuidFrom(ctx.marker, `${r.key}:file:${id}`),
  };
}

const openJob = (uuid: string) => `https://go.servicem8.com/OpenJob/${uuid}`;

async function put(ctx: RunContext, r: OutboundRequest): Promise<RequestRef> {
  const api = apiOf(ctx, ctx.secret);
  const ids = await idsOf(ctx, r);
  const { first, last } = splitName(r.customer.name);
  if (!(await exists(api, `/company/${ids.company}.json`))) {
    await create(api, "/company.json", {
      uuid: ids.company,
      name: (r.customer.name ?? `Request ${r.reference}`).slice(0, 200),
      ...(r.site ? { address: addressLine(r.site).slice(0, 500) } : {}),
    });
  }
  if (!(await exists(api, `/job/${ids.job}.json`))) {
    await create(api, "/job.json", {
      uuid: ids.job,
      status: "Quote",
      company_uuid: ids.company,
      job_address: addressLine(r.site),
      job_description: `${jobTitle(r)}\n\n${r.description}`.slice(0, 8_000),
    });
  }
  if ((r.customer.email || r.customer.phone || first) && !(await exists(api, `/jobcontact/${ids.contact}.json`))) {
    await create(api, "/jobcontact.json", {
      uuid: ids.contact,
      job_uuid: ids.job,
      type: "JOB",
      ...(first ? { first } : {}),
      ...(last ? { last } : {}),
      ...(r.customer.email ? { email: r.customer.email } : {}),
      ...(r.customer.phone ? { mobile: r.customer.phone } : {}),
    });
  }
  for (const f of r.files) {
    const uuid = await ids.file(f.id);
    if (await exists(api, `/attachment/${uuid}.json`)) continue;
    const res = await api.upload(
      { related_object: "job", related_object_uuid: ids.job, attachment_name: f.name.slice(0, 200), uuid },
      { filename: fileName(f.name, f.contentType), contentType: f.contentType, bytes: await f.read() },
    );
    if (res.status !== 200) {
      throw new ConnectorError("bad_response", `ServiceM8 did not take the file ${f.name} (${res.status}).`);
    }
  }
  return { externalId: ids.job, url: openJob(ids.job) };
}

async function find(ctx: RunContext, r: OutboundRequest): Promise<RequestRef | null> {
  const ids = await idsOf(ctx, r);
  return (await exists(apiOf(ctx, ctx.secret), `/job/${ids.job}.json`))
    ? { externalId: ids.job, url: openJob(ids.job) }
    : null;
}

/** The ids a webhook names: `{object, entry: [{uuid, time, changed_fields}], resource_url}`, as JSON or in a form field. */
function hookBody(raw: string): { object: string; entries: { uuid: string; time: string }[] } | null {
  const parse = (text: string) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  };
  let body = parse(raw);
  if (!body) {
    const form = new URLSearchParams(raw);
    for (const value of form.values()) {
      const inner = parse(value);
      if (inner && typeof inner === "object") {
        body = inner;
        break;
      }
    }
    if (!body && form.get("object")) body = { object: form.get("object"), entry: [] };
  }
  if (!body || typeof body !== "object") return null;
  const b = body as { object?: unknown; entry?: unknown };
  const object = typeof b.object === "string" ? b.object.toLowerCase().slice(0, 40) : "";
  const entries = (Array.isArray(b.entry) ? b.entry : [])
    .map((e) => e as { uuid?: unknown; time?: unknown })
    .filter((e) => typeof e.uuid === "string" && /^[0-9a-f-]{36}$/i.test(e.uuid))
    .map((e) => ({ uuid: String(e.uuid), time: typeof e.time === "string" ? e.time.slice(0, 40) : "" }))
    .slice(0, 50);
  return object ? { object, entries } : null;
}

export function servicem8Connector(client: OAuthClient | null = null): ConnectorDefinition {
  const oauthReady = () =>
    client?.clientId && client.clientSecret ? (true as const) : "Needs a ServiceM8 partner app on this server.";
  return {
    kind: "servicem8",
    title: "ServiceM8",
    group: "work",
    capabilities: ["requests_out", "busy_times", "setup_in"],
    auth: "form",
    form: servicem8Form,
    note: "Requests you take on become jobs in Quote status, with the photos; scheduled visits block those times.",
    action: "Connect ServiceM8",
    disconnectNote: "Remove the API key in ServiceM8: Settings → API Keys.",
    presets: [
      {
        id: "oauth",
        label: "Sign in with ServiceM8",
        values: {},
        auth: "oauth",
        ready: oauthReady,
        whenNotReady: {
          status: "setup",
          hint: "Needs a ServiceM8 partner app on this server.",
          href: "https://surfingdog.ai/docs/job-tools/#which-tools",
        },
        consent: "ServiceM8 will ask to let this inbox add jobs, clients and photos, and see your schedule.",
      },
    ],

    async connect(ctx, input) {
      const key = (input.api_key ?? "").trim();
      if (!key) throw new ConnectorError("config", "Paste the API key.", { field: "api_key" });
      return connected(ctx, { api_key: key });
    },

    oauth: {
      authorizeUrl({ redirectUri, state }) {
        const q = new URLSearchParams({
          response_type: "code",
          client_id: client?.clientId ?? "",
          scope: SERVICEM8_SCOPES.join(" "),
          redirect_uri: redirectUri,
          state,
        });
        return `${AUTHORIZE}?${q}`;
      },
      async exchange(ctx, { code, redirectUri }) {
        if (!client) throw new ConnectorError("config", "ServiceM8 sign-in is not set up on this inbox.");
        const res = await ctx.http.request({
          method: "POST",
          url: TOKEN,
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: client.clientId,
            client_secret: client.clientSecret,
            code,
            redirect_uri: redirectUri,
          }).toString(),
        });
        const j = (jsonOf(res) ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
        if (res.status !== 200 || typeof j.access_token !== "string" || typeof j.refresh_token !== "string") {
          throw new ConnectorError("bad_response", "ServiceM8 would not finish the sign-in. Try again.");
        }
        return connected(ctx, {
          access_token: j.access_token,
          refresh_token: j.refresh_token,
          access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
        });
      },
    },

    async busy(ctx, window) {
      const zone = typeof ctx.extra.timezone === "string" ? ctx.extra.timezone : "UTC";
      const secret = await fresh(ctx, client);
      // A sign-in's webhook, made once the connection is kept, so ServiceM8's challenge finds it.
      if (secret.access_token && secret.hooked !== "1" && (await subscribe(ctx, secret))) {
        await ctx.saveSecret({ ...secret, hooked: "1" });
      }
      const api = apiOf(ctx, secret);
      // Visits that start before the window ends and end after it starts; ServiceM8 filters on one
      // field with gt and lt, so the start is bounded (a week back, for a visit still going) and the
      // end checked here.
      const filter = `start_date gt '${localOf(window.start - LOOK_BACK_MS, zone)}' and start_date lt '${localOf(window.end, zone)}' and active eq 1 and activity_was_scheduled eq 1`;
      const out: Interval[] = [];
      let cursor = "-1";
      for (let page = 0; page < MAX_PAGES; page++) {
        const { res, json } = await api.get(
          `/jobactivity.json?%24filter=${encodeURIComponent(filter)}&cursor=${encodeURIComponent(cursor)}`,
        );
        if (res.status !== 200 || !Array.isArray(json)) {
          throw new ConnectorError("bad_response", "ServiceM8 did not send the schedule.");
        }
        for (const a of json as { uuid?: unknown; start_date?: unknown; end_date?: unknown; active?: unknown }[]) {
          if (Number(a.active ?? 1) !== 1) continue;
          if (typeof a.uuid === "string" && ctx.own.ids.has(a.uuid)) continue;
          const start = instantOfLocal(a.start_date, zone);
          const end = instantOfLocal(a.end_date, zone);
          if (start === null || end === null || end <= start) continue;
          if (end <= window.start || start >= window.end) continue;
          out.push({ start, end });
        }
        const next = res.headers.get("x-next-cursor");
        if (!next) return mergeIntervals(out, window);
        cursor = next;
      }
      // More visits than one read takes: nothing is offered past what was read.
      return { intervals: mergeIntervals(out, window), until: window.start };
    },

    requests: {
      async put(ctx, request) {
        return put({ ...ctx, secret: await fresh(ctx, client) }, request);
      },
      async find(ctx, request) {
        return find({ ...ctx, secret: await fresh(ctx, client) }, request);
      },
      openUrl: openJob,
    },

    // Start from ServiceM8 (ADR-034 §5): its opening hours, kept only when the owner keeps them.
    setup: {
      async read(ctx) {
        return servicem8Setup(ctx, await fresh(ctx, client));
      },
    },

    hooks: {
      topics: ["jobactivity"],
      async verify(_ctx, request): Promise<HookEvent | HookChallenge | null> {
        // A public application's subscription is proved first: the challenge goes back as it came.
        const form = new URLSearchParams(request.body);
        const challenge = form.get("challenge");
        if (form.get("mode") === "subscribe" && challenge && /^[\w.~-]{1,200}$/.test(challenge)) {
          return { challenge };
        }
        // API-key subscriptions are not signed: the connection's own address is what lets it in, and
        // what it says is never believed. It only asks for the schedule to be read again.
        const body = hookBody(request.body);
        if (!body) throw new ConnectorError("refused", "Not a ServiceM8 webhook.");
        const first = body.entries[0];
        if (!first) return null;
        return {
          eventId: `${body.object}:${first.uuid}:${first.time}`.slice(0, 200),
          topic: body.object,
          refs: body.entries.map((e) => e.uuid),
        };
      },
      async read() {
        return [{ kind: "busy" }];
      },
    },
  };
}

/**
 * The secret to call with: the key as it is, or, for the OAuth way, an access token refreshed when it
 * has a minute left (ServiceM8 tokens last an hour, and a refresh sends a new refresh token too).
 */
async function fresh(ctx: RunContext, client: OAuthClient | null): Promise<Readonly<Record<string, string>>> {
  if (ctx.secret.api_key) return ctx.secret;
  const expires = Number(ctx.secret.access_expires_at ?? 0);
  if (ctx.secret.access_token && expires > ctx.now + 60_000) return ctx.secret;
  if (!client || !ctx.secret.refresh_token)
    throw new ConnectorError("auth", "ServiceM8 stopped this connection. Connect it again.");
  const res = await ctx.http.request({
    method: "POST",
    url: TOKEN,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: ctx.secret.refresh_token,
    }).toString(),
  });
  failOn("ServiceM8", res, "api_key");
  const j = (jsonOf(res) ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (res.status !== 200 || typeof j.access_token !== "string") {
    throw new ConnectorError("auth", "ServiceM8 stopped this connection. Connect it again.");
  }
  const next = {
    access_token: j.access_token,
    refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : ctx.secret.refresh_token,
    access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
    ...(ctx.secret.hooked ? { hooked: ctx.secret.hooked } : {}),
  };
  await ctx.saveSecret(next);
  return next;
}
