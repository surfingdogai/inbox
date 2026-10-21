import {
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type HookEvent,
  type HookFact,
  type InboundRequest,
  type Interval,
  mergeIntervals,
  type OAuthClient,
  type OutboundRequest,
  type RequestRef,
  type RunContext,
} from "@surfingdog/core";
import { verifyBase64Hmac } from "../hook-sign";
import { retryAfterMs } from "../http";
import { jobTitle, jsonOf, splitName } from "./common";

/**
 * Jobber (ADR-034 §5): code-complete and switched off. Jobber connects only through an app in its
 * Developer Center, by OAuth, and an app goes beyond five connected accounts only after Jobber's app
 * review; that is the founder's to start (docs/partners/trades.md). It is on only when the server holds
 * the app's client id and secret (`JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`) **and** the API version the
 * app was checked against (`JOBBER_API_VERSION`), never the template's: holding the app's keys to start
 * its review does not switch it on. Until then the card says "set up".
 *
 * What it does once on: a request the owner takes on becomes a Jobber request (the customer's client,
 * found by their email or phone or made, with the site as its property; `requestCreate` on the account's
 * first request form; the customer's words as a note); scheduled visits are the busy times. Webhooks are
 * set per app in the Developer Center, to one address (`POST /v1/hooks/jobber/app`): each is signed with
 * the app's client secret (`X-Jobber-Hmac-SHA256`, base64 HMAC-SHA-256 over the body), names its account
 * (`accountId`), and is only a nudge.
 *
 * Jobber's developer pages refused to be read here (HTTP 403). What this is built from is Jobber's own
 * published app template (github.com/GetJobber/Jobber-AppTemplate-RailsAPI: the GraphQL endpoint, the
 * version header, the OAuth paths, the webhook check) and the GraphQL schema it ships (`db/schema.json`,
 * dumped January 2023, at API version 2022-03-10). Jobber retires API versions on a schedule: the
 * version below, and each operation, are checked against the Developer Center before it is switched on.
 */

export const JOBBER_API = "https://api.getjobber.com/api";
export const JOBBER_GRAPHQL = `${JOBBER_API}/graphql`;
const AUTHORIZE = `${JOBBER_API}/oauth/authorize`;
const TOKEN = `${JOBBER_API}/oauth/token`;
/** The version the published template sends: never one this is switched on with. */
export const JOBBER_TEMPLATE_VERSION = "2022-03-10";
const VERSION = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGES = 5;

interface Gql {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly { readonly message?: string }[] | undefined;
}

async function token(ctx: RunContext, client: OAuthClient | null): Promise<string> {
  const expires = Number(ctx.secret.access_expires_at ?? 0);
  if (ctx.secret.access_token && expires > ctx.now + 60_000) return ctx.secret.access_token;
  if (!client || !ctx.secret.refresh_token)
    throw new ConnectorError("auth", "Jobber stopped this connection. Connect it again.");
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
  const j = (jsonOf(res) ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (res.status !== 200 || typeof j.access_token !== "string") {
    throw new ConnectorError("auth", "Jobber stopped this connection. Connect it again.");
  }
  const next = {
    access_token: j.access_token,
    refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : ctx.secret.refresh_token,
    access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
  };
  await ctx.saveSecret(next);
  return next.access_token;
}

/** The app's keys, and the API version it was checked against. */
export interface JobberApp extends OAuthClient {
  readonly apiVersion: string;
}

async function gql(
  ctx: Pick<ConnectContext, "http">,
  app: JobberApp,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await ctx.http.request({
    method: "POST",
    url: JOBBER_GRAPHQL,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
      "x-jobber-graphql-version": app.apiVersion,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403)
    throw new ConnectorError("auth", "Jobber stopped this connection. Connect it again.");
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Jobber asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500)
    throw new ConnectorError(
      "unreachable",
      "Jobber is not answering properly; this inbox tries again in a few minutes.",
    );
  const j = (jsonOf(res) ?? {}) as Gql;
  const throttled = j.errors?.some((e) => /throttl/i.test(e.message ?? ""));
  if (throttled) throw new ConnectorError("rate_limited", "Jobber asked this inbox to slow down.");
  if (res.status !== 200 || !j.data || j.errors?.length) {
    throw new ConnectorError(
      "bad_response",
      `Jobber would not answer${j.errors?.[0]?.message ? `: ${j.errors[0].message.slice(0, 200)}` : "."}`,
    );
  }
  return j.data;
}

const userErrors = (payload: unknown): string | null => {
  const errs = (payload as { userErrors?: { message?: unknown }[] } | null)?.userErrors ?? [];
  const m = errs.map((e) => (typeof e.message === "string" ? e.message : "")).filter(Boolean);
  return m.length ? m.join("; ").slice(0, 300) : null;
};

const FIND = `query Find($term: String!) { requests(searchTerm: $term, first: 10) { nodes { id title jobberWebUri } } }`;

async function findRequest(ctx: RunContext, client: JobberApp, r: OutboundRequest): Promise<RequestRef | null> {
  const data = await gql(ctx, client, await token(ctx, client), FIND, { term: r.reference });
  const nodes = ((data.requests as { nodes?: unknown[] } | undefined)?.nodes ?? []) as {
    id?: unknown;
    title?: unknown;
    jobberWebUri?: unknown;
  }[];
  const hit = nodes.find((n) => typeof n.id === "string" && typeof n.title === "string" && n.title === jobTitle(r));
  if (!hit || typeof hit.id !== "string") return null;
  return { externalId: hit.id, ...(typeof hit.jobberWebUri === "string" ? { url: hit.jobberWebUri } : {}) };
}

const CLIENTS = `query Clients($term: String!) { clients(searchTerm: $term, first: 10) { nodes { id emails { address } phones { number } clientProperties(first: 1) { nodes { id } } } } }`;

/**
 * The customer's client in Jobber, when there is one: the same email, else the same phone. Looked for
 * before one is made, so a returning customer, or a request tried again after its client was made, is
 * one client, not several.
 */
async function findClient(
  ctx: RunContext,
  client: JobberApp,
  access: string,
  r: OutboundRequest,
): Promise<{ id: string; propertyId: string | null } | null> {
  const email = r.customer.email?.trim().toLowerCase() || null;
  const phone = r.customer.phone?.replace(/[^\d+]/g, "") || null;
  const term = email ?? phone;
  if (!term) return null;
  const data = await gql(ctx, client, access, CLIENTS, { term });
  const nodes = ((data.clients as { nodes?: unknown[] } | undefined)?.nodes ?? []) as {
    id?: unknown;
    emails?: { address?: unknown }[];
    phones?: { number?: unknown }[];
    clientProperties?: { nodes?: { id?: unknown }[] };
  }[];
  const hit = nodes.find(
    (n) =>
      typeof n.id === "string" &&
      (email
        ? (n.emails ?? []).some((e) => typeof e.address === "string" && e.address.trim().toLowerCase() === email)
        : (n.phones ?? []).some((p) => typeof p.number === "string" && p.number.replace(/[^\d+]/g, "") === phone)),
  );
  if (!hit || typeof hit.id !== "string") return null;
  const propertyId = hit.clientProperties?.nodes?.[0]?.id;
  return { id: hit.id, propertyId: typeof propertyId === "string" ? propertyId : null };
}

async function putRequest(ctx: RunContext, client: JobberApp, r: OutboundRequest): Promise<RequestRef> {
  const found = await findRequest(ctx, client, r);
  if (found) return found;
  const access = await token(ctx, client);
  const settings = await gql(ctx, client, access, `query { requestSettings { forms(first: 1) { nodes { id } } } }`);
  const formId = ((settings.requestSettings as { forms?: { nodes?: { id?: unknown }[] } } | undefined)?.forms?.nodes ??
    [])[0]?.id;
  if (typeof formId !== "string" && typeof formId !== "number") {
    throw new ConnectorError("refused", "This Jobber account has no request form to send requests on.");
  }
  const { first, last } = splitName(r.customer.name);
  const existing = await findClient(ctx, client, access, r);
  const { clientId, propertyId } = existing
    ? { clientId: existing.id, propertyId: existing.propertyId }
    : await createClient(ctx, client, access, r, first, last);
  const made = await gql(
    ctx,
    client,
    access,
    `mutation Request($input: RequestCreateInput!) { requestCreate(input: $input) { request { id jobberWebUri } userErrors { message path } } }`,
    {
      input: {
        clientId,
        ...(propertyId ? { propertyId } : {}),
        title: jobTitle(r),
        source: "EXTERNAL",
        customFormInput: { formId: String(formId), items: [] },
      },
    },
  );
  const reqPayload = made.requestCreate as { request?: { id?: unknown; jobberWebUri?: unknown } };
  const whyNot = userErrors(made.requestCreate);
  const requestId = reqPayload?.request?.id;
  if (whyNot || typeof requestId !== "string")
    throw new ConnectorError("refused", `Jobber would not take the request${whyNot ? `: ${whyNot}` : "."}`);
  await gql(
    ctx,
    client,
    access,
    `mutation Note($id: EncodedId!, $input: RequestCreateNoteInput!) { requestCreateNote(requestId: $id, input: $input) { userErrors { message } } }`,
    { id: requestId, input: { message: r.description.slice(0, 8_000) } },
  );
  return {
    externalId: requestId,
    ...(typeof reqPayload.request?.jobberWebUri === "string" ? { url: reqPayload.request.jobberWebUri } : {}),
  };
}

async function createClient(
  ctx: RunContext,
  client: JobberApp,
  access: string,
  r: OutboundRequest,
  first: string | null,
  last: string | null,
): Promise<{ clientId: string; propertyId: string | null }> {
  const created = await gql(
    ctx,
    client,
    access,
    `mutation Client($input: ClientCreateInput!) { clientCreate(input: $input) { client { id clientProperties(first: 1) { nodes { id } } } userErrors { message path } } }`,
    {
      input: {
        ...(first ? { firstName: first } : {}),
        ...(last ? { lastName: last } : {}),
        ...(r.customer.email ? { emails: [{ address: r.customer.email, primary: true }] } : {}),
        ...(r.customer.phone ? { phones: [{ number: r.customer.phone, primary: true }] } : {}),
        ...(r.site
          ? {
              properties: [
                {
                  address: {
                    street1: r.site.streetAddress ?? "",
                    city: r.site.addressLocality ?? "",
                    province: r.site.addressRegion ?? "",
                    postalCode: r.site.postalCode ?? "",
                    country: r.site.addressCountry ?? "",
                  },
                },
              ],
            }
          : {}),
      },
    },
  );
  const clientPayload = created.clientCreate as {
    client?: { id?: unknown; clientProperties?: { nodes?: { id?: unknown }[] } };
  };
  const why = userErrors(created.clientCreate);
  const clientId = clientPayload?.client?.id;
  if (why || typeof clientId !== "string")
    throw new ConnectorError("refused", `Jobber would not take the client${why ? `: ${why}` : "."}`);
  const propertyId = clientPayload.client?.clientProperties?.nodes?.[0]?.id;
  return { clientId, propertyId: typeof propertyId === "string" ? propertyId : null };
}

/** Why Jobber is not on here: its app's keys, or the version they were checked against; null when it is on. */
function jobberBlocked(client: OAuthClient | null, apiVersion: string | undefined): string | null {
  if (!client?.clientId || !client.clientSecret) return "Needs a Jobber app, reviewed by Jobber, on this server.";
  if (!apiVersion || !VERSION.test(apiVersion) || apiVersion === JOBBER_TEMPLATE_VERSION) {
    return "Needs the Jobber API version this server's app was checked against.";
  }
  return null;
}

export function jobberConnector(
  keys: OAuthClient | null = null,
  opts: { readonly apiVersion?: string | undefined } = {},
): ConnectorDefinition {
  const blocked = jobberBlocked(keys, opts.apiVersion);
  const client: JobberApp | null = keys && !blocked ? { ...keys, apiVersion: opts.apiVersion ?? "" } : null;
  const on = (): JobberApp => {
    if (!client) throw new ConnectorError("config", blocked ?? "Jobber is not set up on this inbox.");
    return client;
  };
  const ready = () => (blocked ? blocked : (true as const));
  return {
    kind: "jobber",
    title: "Jobber",
    group: "work",
    capabilities: ["requests_out", "busy_times"],
    auth: "oauth",
    ready,
    whenNotReady: {
      status: "setup",
      hint: blocked ?? "Needs a Jobber app, reviewed by Jobber, on this server.",
      href: "https://surfingdog.ai/docs/job-tools/#which-tools",
    },
    consent: "Jobber will ask to let this inbox add clients and requests, and see your visits.",
    note: "Requests you take on arrive as Jobber requests; scheduled visits block those times.",

    oauth: {
      authorizeUrl({ redirectUri, state }) {
        const q = new URLSearchParams({
          response_type: "code",
          client_id: client?.clientId ?? "",
          redirect_uri: redirectUri,
          state,
        });
        return `${AUTHORIZE}?${q}`;
      },
      async exchange(ctx, { code, redirectUri }): Promise<Connected> {
        if (!client) throw new ConnectorError("config", "Jobber sign-in is not set up on this inbox.");
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
          throw new ConnectorError("bad_response", "Jobber would not finish the sign-in. Try again.");
        }
        const data = await gql(ctx, client, j.access_token, `query { account { id name } }`);
        const account = data.account as { id?: unknown; name?: unknown } | undefined;
        if (typeof account?.id !== "string")
          throw new ConnectorError("bad_response", "Jobber did not say which account this is.");
        return {
          account: typeof account.name === "string" ? account.name : "Jobber",
          externalId: account.id,
          secret: {
            access_token: j.access_token,
            refresh_token: j.refresh_token,
            access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
          },
          extra: {},
          calendars: [{ id: "visits", name: "Scheduled visits", writable: false, primary: true }],
          destinations: [],
          defaults: { busy: ["visits"], destination: null },
        };
      },
    },

    async busy(ctx, window) {
      const app = on();
      const access = await token(ctx, app);
      const out: Interval[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await gql(
          ctx,
          app,
          access,
          `query Visits($after: String, $from: ISO8601DateTime!, $to: ISO8601DateTime!) { visits(filter: { startAt: { after: $from, before: $to } }, first: 100, after: $after) { nodes { id startAt endAt allDay } pageInfo { hasNextPage endCursor } } }`,
          {
            after,
            from: new Date(window.start - 7 * 86_400_000).toISOString(),
            to: new Date(window.end).toISOString(),
          },
        );
        const v = data.visits as {
          nodes?: { id?: unknown; startAt?: unknown; endAt?: unknown }[];
          pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
        };
        for (const n of v?.nodes ?? []) {
          const start = typeof n.startAt === "string" ? Date.parse(n.startAt) : Number.NaN;
          const end = typeof n.endAt === "string" ? Date.parse(n.endAt) : Number.NaN;
          if (
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            end <= start ||
            end <= window.start ||
            start >= window.end
          )
            continue;
          out.push({ start, end });
        }
        if (v?.pageInfo?.hasNextPage !== true || typeof v.pageInfo.endCursor !== "string")
          return mergeIntervals(out, window);
        after = v.pageInfo.endCursor;
      }
      return { intervals: mergeIntervals(out, window), until: window.start };
    },

    requests: {
      put: (ctx, r) => putRequest(ctx, on(), r),
      find: (ctx, r) => findRequest(ctx, on(), r),
    },

    hooks: {
      topics: ["VISIT_CREATE", "VISIT_UPDATE", "VISIT_DESTROY", "APP_DISCONNECT"],
      // Jobber sends every account's events to the app's one address: the account says whose they are.
      async account(request) {
        return eventOf(await checked(keys, request)).accountId;
      },
      async verify(_ctx, request): Promise<HookEvent | null> {
        const e = eventOf(await checked(keys, request));
        const topic = typeof e?.topic === "string" ? e.topic.slice(0, 60) : "";
        if (!topic) return null;
        const id = typeof e?.itemId === "string" ? e.itemId.slice(0, 100) : "";
        const at = typeof e?.occurredAt === "string" ? e.occurredAt.slice(0, 40) : "";
        return { eventId: `${topic}:${id}:${at}`, topic, refs: id ? [id] : [] };
      },
      async read(_ctx, event): Promise<readonly HookFact[]> {
        return event.topic === "APP_DISCONNECT" ? [{ kind: "revoked" }] : [{ kind: "busy" }];
      },
    },
  };
}

interface JobberEvent {
  readonly topic?: unknown;
  readonly accountId?: unknown;
  readonly itemId?: unknown;
  readonly occurredAt?: unknown;
}

/** The body, once the app's signature over its exact bytes checks out. */
async function checked(keys: OAuthClient | null, request: InboundRequest): Promise<unknown> {
  if (!keys?.clientSecret) throw new ConnectorError("refused", "Jobber is not set up on this inbox.");
  const ok = await verifyBase64Hmac(keys.clientSecret, request.body, request.headers.get("x-jobber-hmac-sha256"));
  if (!ok) throw new ConnectorError("refused", "The signature does not check out.");
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw new ConnectorError("refused", "Not a Jobber webhook.");
  }
}

/** `{data: {webHookEvent: {topic, appId, accountId, itemId, occurredAt}}}`, as far as it is there. */
function eventOf(body: unknown): JobberEvent & { readonly accountId: string | null } {
  const e = ((body as { data?: { webHookEvent?: JobberEvent } } | null)?.data?.webHookEvent ?? {}) as JobberEvent;
  return { ...e, accountId: typeof e.accountId === "string" && e.accountId ? e.accountId.slice(0, 200) : null };
}
