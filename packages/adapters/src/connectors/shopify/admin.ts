import { ConnectorError, type ConnectorHttp, type ConnectorHttpResponse, type OAuthClient } from "@surfingdog/core";
import { retryAfterMs } from "../http";

/**
 * Talking to one Shopify shop (ADR-028): its address, the access token, and the GraphQL Admin API with
 * its cost-based rate limit. Every call goes to `https://<handle>.myshopify.com`, a host Shopify owns
 * and the shop's own address there; a custom domain is never called with a key.
 *
 * - Versions: https://shopify.dev/docs/api/usage/versioning (2026-10 is the stable version of
 *   1 October 2026, supported until 16 October 2027).
 * - GraphQL Admin API: https://shopify.dev/docs/api/admin-graphql
 * - Rate limits: https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
 * - Client credentials: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 * - Authorization code: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 */

/** The GraphQL Admin API version every call is made in: the stable one of October 2026. */
export const SHOPIFY_API_VERSION = "2026-10";

/**
 * What the app is given in the shop, and nothing more: products in, the orders it made read back,
 * draft orders written. `write_draft_orders` reads them too.
 */
export const SHOPIFY_SCOPES: readonly string[] = ["read_products", "read_orders", "write_draft_orders"];

/** Shopify's own pattern for a shop's address, anchored at both ends (authorization code grant). */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const HANDLE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The shop's `.myshopify.com` address from what the owner typed: that address, with or without
 * https and a path; the admin's own address (`admin.shopify.com/store/<handle>`); or the handle
 * alone. Null for anything else: a custom domain, plain http, an IP address.
 */
export function shopDomainOf(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s || /^http:\/\//.test(s)) return null;
  s = s.replace(/^https:\/\//, "");
  const admin = /^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)(?:[/?#].*)?$/.exec(s);
  if (admin?.[1]) return `${admin[1]}.myshopify.com`;
  const host = (s.split(/[/?#]/)[0] ?? "").replace(/\.$/, "");
  if (SHOP_DOMAIN.test(host)) return host;
  if (HANDLE.test(host) && host.length <= 60) return `${host}.myshopify.com`;
  return null;
}

/** What is wrong with a typed shop address, in the owner's words; null when it is one. */
export function storeProblem(raw: string): string | null {
  if (shopDomainOf(raw) !== null) return null;
  if (/^\s*http:\/\//i.test(raw)) return "Shopify shops are reached over https.";
  return "Use your shop's address ending in .myshopify.com: Shopify shows it under Settings → Domains.";
}

/** The admin's own address for the shop: where "Open in Shopify" goes. */
export function adminUrl(shop: string, path = ""): string {
  return `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}${path}`;
}

/* --- waiting ----------------------------------------------------------------------- */

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The longest this inbox waits within one call for Shopify's bucket to refill; past it, it comes back later. */
export const MAX_WAIT_MS = 5_000;

/**
 * Each shop's bucket as Shopify last said it (`extensions.cost.throttleStatus`), so a call that would
 * be refused waits for the points it needs first. Kept for the life of the process, per shop: a
 * guess that is only ever a little early, since the bucket refills at `restoreRate` every second.
 */
interface Bucket {
  readonly available: number;
  readonly maximum: number;
  readonly restoreRate: number;
  readonly at: number;
}
const buckets = new Map<string, Bucket>();

/** Forgets what was learnt of the shops' buckets: for tests. */
export function forgetBuckets(): void {
  buckets.clear();
}

function availableNow(b: Bucket, now: number): number {
  return Math.min(b.maximum, b.available + (b.restoreRate * Math.max(0, now - b.at)) / 1000);
}

/**
 * After waiting `ms`, the bucket holds what it refilled meanwhile: counted from the time asleep as
 * well as the clock, so a wait that took no time on the clock (a test's) is not waited twice.
 */
async function waitAndCredit(t: { readonly shop: string; readonly sleep: Sleep }, ms: number): Promise<void> {
  const before = Date.now();
  await t.sleep(ms);
  const b = buckets.get(t.shop);
  if (!b) return;
  const now = Date.now();
  const credited = Math.max(availableNow(b, now), availableNow(b, before) + (b.restoreRate * ms) / 1000);
  buckets.set(t.shop, { ...b, available: Math.min(b.maximum, credited), at: now });
}

/** How long to wait for `cost` points, in milliseconds; 0 when they are there. */
function waitFor(b: Bucket, cost: number, now: number): number {
  const missing = cost - availableNow(b, now);
  if (missing <= 0 || b.restoreRate <= 0) return 0;
  return Math.ceil((missing / b.restoreRate) * 1000);
}

/* --- GraphQL ----------------------------------------------------------------------- */

/** A GraphQL document with its operation's name and what it is expected to cost, at most. */
export interface Doc {
  readonly name: string;
  readonly text: string;
  readonly cost: number;
}

export interface AdminTarget {
  readonly http: ConnectorHttp;
  readonly shop: string;
  readonly token: string;
  readonly sleep: Sleep;
}

interface Throttle {
  readonly requested: number;
  readonly status: Bucket | null;
}

function costOf(json: Record<string, unknown>, now: number): Throttle | null {
  const cost = (json.extensions as { cost?: Record<string, unknown> } | undefined)?.cost;
  if (!cost) return null;
  const t = cost.throttleStatus as Record<string, unknown> | undefined;
  const status =
    t &&
    Number.isFinite(Number(t.maximumAvailable)) &&
    Number.isFinite(Number(t.currentlyAvailable)) &&
    Number.isFinite(Number(t.restoreRate))
      ? {
          maximum: Number(t.maximumAvailable),
          available: Number(t.currentlyAvailable),
          restoreRate: Number(t.restoreRate),
          at: now,
        }
      : null;
  return { requested: Number(cost.requestedQueryCost) || 0, status };
}

function parse(res: ConnectorHttpResponse): Record<string, unknown> {
  try {
    const v = res.text ? JSON.parse(res.text) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface GraphQLError {
  readonly message: string;
  readonly code: string;
}

/** Shopify's words for a field it withholds: "This app is not approved to access the Order object." */
const WITHHELD = /not approved to access|protected customer data/i;

function errorsOf(json: Record<string, unknown>): GraphQLError[] {
  const raw = json.errors;
  // Shopify answers some refusals with a plain string (`{"errors": "[API] Invalid API key or access token"}`).
  if (typeof raw === "string") return [{ message: raw, code: "" }];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
    .map((e) => ({
      message: typeof e.message === "string" ? e.message.slice(0, 300) : "",
      code: String((e.extensions as { code?: unknown } | undefined)?.code ?? ""),
    }));
}

/**
 * One GraphQL Admin call, within the shop's rate limit: it waits first when the bucket would not hold
 * the document's cost, and once more when Shopify still says THROTTLED (HTTP 429, or `THROTTLED` in
 * `errors` with HTTP 200), each time only as long as the bucket needs and never more than
 * `MAX_WAIT_MS`. Past that it is a `rate_limited` error with the wait, so the job comes back then.
 */
export async function admin<T>(t: AdminTarget, doc: Doc, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const known = buckets.get(t.shop);
    if (known) {
      const wait = waitFor(known, doc.cost, Date.now());
      if (wait > MAX_WAIT_MS) {
        throw new ConnectorError("rate_limited", "Shopify asked this inbox to slow down.", { retryAfterMs: wait });
      }
      if (wait > 0) await waitAndCredit(t, wait);
    }
    const res = await t.http.request({
      method: "POST",
      url: `https://${t.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      headers: {
        "x-shopify-access-token": t.token,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ query: doc.text, variables }),
    });
    const json = parse(res);
    const throttle = costOf(json, Date.now());
    if (throttle?.status) buckets.set(t.shop, throttle.status);
    const errors = errorsOf(json);
    const throttled = res.status === 429 || errors.some((e) => e.code === "THROTTLED");
    if (throttled) {
      const status = throttle?.status ?? buckets.get(t.shop);
      const wait = status
        ? Math.max(1_000, waitFor(status, throttle?.requested || doc.cost, Date.now()))
        : (retryAfterMs(res.headers) ?? 1_000);
      if (attempt === 0 && wait <= MAX_WAIT_MS) {
        await waitAndCredit(t, wait);
        continue;
      }
      throw new ConnectorError("rate_limited", "Shopify asked this inbox to slow down.", { retryAfterMs: wait });
    }
    statusError(res, t.shop, errors);
    // Orders and draft orders are protected customer data: an app Shopify has not let see them gets
    // the field as null and an error naming it, with HTTP 200. That is never "not paid yet".
    // https://shopify.dev/docs/apps/launch/protected-customer-data
    if (errors.some((e) => WITHHELD.test(e.message))) {
      throw new ConnectorError(
        "config",
        `Shopify is keeping order details from this app (protected customer data). An app you make for your own shop has that access: make it with the account that owns ${t.shop}, and install it there.`,
      );
    }
    const denied = errors.find((e) => e.code === "ACCESS_DENIED");
    const data = json.data;
    if (denied && (!data || typeof data !== "object")) {
      throw new ConnectorError(
        "config",
        `The Shopify app is missing access this inbox needs (${SHOPIFY_SCOPES.join(", ")}). Add it to the app, release it, and approve it in Shopify.`,
      );
    }
    if (!data || typeof data !== "object") {
      throw new ConnectorError(
        "bad_response",
        `Shopify did not answer ${doc.name}${errors[0]?.message ? `: ${errors[0].message}` : "."}`,
      );
    }
    return data as T;
  }
  throw new ConnectorError("rate_limited", "Shopify asked this inbox to slow down.", { retryAfterMs: 1_000 });
}

/** The answers Shopify gives a whole call, said in the owner's words. */
function statusError(res: ConnectorHttpResponse, shop: string, errors: readonly GraphQLError[]): void {
  if (res.status === 401) {
    throw new ConnectorError("auth", `Shopify no longer takes this inbox's access to ${shop}. Connect Shopify again.`);
  }
  if (res.status === 402) {
    throw new ConnectorError(
      "config",
      `Shopify says ${shop} is paused or not paid for, so this inbox cannot reach it.`,
    );
  }
  if (res.status === 403) {
    throw new ConnectorError(
      "config",
      `The Shopify app is missing access this inbox needs (${SHOPIFY_SCOPES.join(", ")}). Add it to the app, release it, and approve it in Shopify.`,
    );
  }
  if (res.status === 404) {
    throw new ConnectorError("config", `There is no Shopify shop at ${shop}.`, { field: "store" });
  }
  if (res.status === 423) throw new ConnectorError("config", `Shopify has locked ${shop}.`);
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Shopify is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ConnectorError("config", `${shop} did not answer as a Shopify shop.`, { field: "store" });
  }
  if (res.status >= 400) {
    throw new ConnectorError("refused", `Shopify said: ${errors[0]?.message || `HTTP ${res.status}`}`.slice(0, 300));
  }
}

/** A mutation's `userErrors`, as one refusal in Shopify's own words; nothing when there are none. */
export function userErrors(payload: { readonly userErrors?: unknown } | null | undefined): string | null {
  const list = Array.isArray(payload?.userErrors) ? (payload.userErrors as { message?: unknown }[]) : [];
  const words = list.map((e) => (typeof e?.message === "string" ? e.message : "")).filter(Boolean);
  return words.length > 0 ? words.join("; ").slice(0, 300) : null;
}

/* --- access tokens ------------------------------------------------------------------ */

export interface Grant {
  readonly accessToken: string;
  /** Milliseconds since the epoch; null for a token that does not lapse. */
  readonly expiresAt: number | null;
  readonly refreshToken: string | null;
  readonly scopes: readonly string[];
}

function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function tokenCall(
  http: ConnectorHttp,
  shop: string,
  params: Record<string, string>,
  now: number,
  words: { readonly refused: string; readonly field: string },
): Promise<Grant> {
  const res = await http.request({
    method: "POST",
    url: `https://${shop}/admin/oauth/access_token`,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form(params),
  });
  const json = parse(res);
  const error = typeof json.error === "string" ? json.error : "";
  if (error === "shop_not_permitted") {
    throw new ConnectorError(
      "config",
      `This app can't reach ${shop}. Check the shop address, and that you made the app with the account that owns this shop and installed it there.`,
      { field: "store" },
    );
  }
  if (res.status === 404)
    throw new ConnectorError("config", `There is no Shopify shop at ${shop}.`, { field: "store" });
  if (res.status >= 300 && res.status < 400) {
    throw new ConnectorError("config", `${shop} did not answer as a Shopify shop.`, { field: "store" });
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Shopify asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Shopify is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  if (res.status >= 400) throw new ConnectorError("auth", words.refused, { field: words.field });
  const accessToken = typeof json.access_token === "string" ? json.access_token : "";
  if (!accessToken) throw new ConnectorError("bad_response", "Shopify answered without an access token.");
  const expiresIn = Number(json.expires_in);
  return {
    accessToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
    scopes:
      typeof json.scope === "string"
        ? json.scope
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
  };
}

/**
 * An access token for an app the owner made for their own shop, by the client credentials grant: it
 * lasts 24 hours (`expires_in` 86399) and is asked for again before it lapses. Shopify grants it only
 * when the app and the shop are in the same Shopify organization.
 */
export function clientCredentials(
  http: ConnectorHttp,
  shop: string,
  client: { readonly clientId: string; readonly clientSecret: string },
  now: number,
): Promise<Grant> {
  return tokenCall(
    http,
    shop,
    { grant_type: "client_credentials", client_id: client.clientId, client_secret: client.clientSecret },
    now,
    {
      refused: "Shopify did not take that Client ID and Client secret. Copy both again from the app's settings.",
      field: "client_secret",
    },
  );
}

/** The code of a sign-in (authorization code grant), for an offline token that lapses and is refreshed. */
export function exchangeCode(http: ConnectorHttp, shop: string, client: OAuthClient, code: string, now: number) {
  return tokenCall(
    http,
    shop,
    { client_id: client.clientId, client_secret: client.clientSecret, code, expiring: "1" },
    now,
    { refused: "Shopify did not finish the sign-in. Try again.", field: "store" },
  );
}

/** A lapsing offline token, refreshed. */
export function refreshGrant(
  http: ConnectorHttp,
  shop: string,
  client: OAuthClient,
  refreshToken: string,
  now: number,
) {
  return tokenCall(
    http,
    shop,
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    now,
    { refused: "Shopify no longer takes this inbox's sign-in. Sign in with Shopify again.", field: "store" },
  );
}
