import {
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type HookEvent,
  type HookFact,
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
 * review; that is the founder's to start (docs/partners/trades.md). Until the server holds the app's
 * client id and secret (`JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`), the card says "set up".
 *
 * What it does once on: a request the owner takes on becomes a Jobber request (a client with the site
 * as its property, `requestCreate` on the account's first request form, the customer's words as a note);
 * scheduled visits are the busy times. Webhooks are signed with the app's client secret
 * (`X-Jobber-Hmac-SHA256`, base64 HMAC-SHA-256 over the body) and are only nudges.
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
/** The version the published template sends; to be set to a current one before this is switched on. */
export const JOBBER_API_VERSION = "2022-03-10";
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

async function gql(
  ctx: Pick<ConnectContext, "http">,
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
      "x-jobber-graphql-version": JOBBER_API_VERSION,
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

async function findRequest(
  ctx: RunContext,
  client: OAuthClient | null,
  r: OutboundRequest,
): Promise<RequestRef | null> {
  const data = await gql(ctx, await token(ctx, client), FIND, { term: r.reference });
  const nodes = ((data.requests as { nodes?: unknown[] } | undefined)?.nodes ?? []) as {
    id?: unknown;
    title?: unknown;
    jobberWebUri?: unknown;
  }[];
  const hit = nodes.find((n) => typeof n.id === "string" && typeof n.title === "string" && n.title === jobTitle(r));
  if (!hit || typeof hit.id !== "string") return null;
  return { externalId: hit.id, ...(typeof hit.jobberWebUri === "string" ? { url: hit.jobberWebUri } : {}) };
}

async function putRequest(ctx: RunContext, client: OAuthClient | null, r: OutboundRequest): Promise<RequestRef> {
  const found = await findRequest(ctx, client, r);
  if (found) return found;
  const access = await token(ctx, client);
  const settings = await gql(ctx, access, `query { requestSettings { forms(first: 1) { nodes { id } } } }`);
  const formId = ((settings.requestSettings as { forms?: { nodes?: { id?: unknown }[] } } | undefined)?.forms?.nodes ??
    [])[0]?.id;
  if (typeof formId !== "string" && typeof formId !== "number") {
    throw new ConnectorError("refused", "This Jobber account has no request form to send requests on.");
  }
  const { first, last } = splitName(r.customer.name);
  const created = await gql(
    ctx,
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
  const made = await gql(
    ctx,
    access,
    `mutation Request($input: RequestCreateInput!) { requestCreate(input: $input) { request { id jobberWebUri } userErrors { message path } } }`,
    {
      input: {
        clientId,
        ...(typeof propertyId === "string" ? { propertyId } : {}),
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
    access,
    `mutation Note($id: EncodedId!, $input: RequestCreateNoteInput!) { requestCreateNote(requestId: $id, input: $input) { userErrors { message } } }`,
    { id: requestId, input: { message: r.description.slice(0, 8_000) } },
  );
  return {
    externalId: requestId,
    ...(typeof reqPayload.request?.jobberWebUri === "string" ? { url: reqPayload.request.jobberWebUri } : {}),
  };
}

export function jobberConnector(client: OAuthClient | null = null): ConnectorDefinition {
  const ready = () =>
    client?.clientId && client.clientSecret ? (true as const) : "Needs our Jobber app, reviewed by Jobber.";
  return {
    kind: "jobber",
    title: "Jobber",
    group: "work",
    capabilities: ["requests_out", "busy_times"],
    auth: "oauth",
    ready,
    whenNotReady: {
      status: "setup",
      hint: "Needs our Jobber app, reviewed by Jobber.",
      href: "https://surfingdog.ai/docs/job-tools/#jobber",
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
        const data = await gql(ctx, j.access_token, `query { account { id name } }`);
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
      const access = await token(ctx, client);
      const out: Interval[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await gql(
          ctx,
          access,
          `query Visits($after: String, $from: ISO8601DateTime!, $to: ISO8601DateTime!) { visits(filter: { startAt: { after: $from, before: $to } }, first: 100, after: $after) { nodes { id startAt endAt allDay } pageInfo { hasNextPage endCursor } } }`,
          { after, from: new Date(window.start - 86_400_000).toISOString(), to: new Date(window.end).toISOString() },
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
      put: (ctx, r) => putRequest(ctx, client, r),
      find: (ctx, r) => findRequest(ctx, client, r),
    },

    hooks: {
      topics: ["VISIT_CREATE", "VISIT_UPDATE", "VISIT_DESTROY", "APP_DISCONNECT"],
      async verify(_ctx, request): Promise<HookEvent | null> {
        if (!client?.clientSecret) throw new ConnectorError("refused", "Jobber is not set up on this inbox.");
        const ok = await verifyBase64Hmac(
          client.clientSecret,
          request.body,
          request.headers.get("x-jobber-hmac-sha256"),
        );
        if (!ok) throw new ConnectorError("refused", "The signature does not check out.");
        let body: { data?: { webHookEvent?: { topic?: unknown; itemId?: unknown; occurredAt?: unknown } } } = {};
        try {
          body = JSON.parse(request.body) as typeof body;
        } catch {
          throw new ConnectorError("refused", "Not a Jobber webhook.");
        }
        const e = body.data?.webHookEvent;
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
