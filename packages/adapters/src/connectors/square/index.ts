import {
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttp,
  type HookEvent,
  type HookFact,
  type HooksHandler,
  type OAuthClient,
  type OAuthFlow,
  type RunContext,
  secretField,
  type Withheld,
} from "@surfingdog/core";
import { z } from "zod";
import { verifyBase64Hmac } from "../hook-sign";
import {
  type AccountRead,
  AUTO,
  choicesOf,
  destinationsOf,
  extraFrom,
  extraOf,
  type HookState,
  readAccount,
  type SquareVia,
  writeLevel,
} from "./account";
import { answerOf, arr, obj, SQUARE_API, SQUARE_VERSION, SquareApi, type SquareEnv, sha256, str } from "./api";
import { bookingWriter, busy } from "./bookings";
import { catalogueReader } from "./catalogue";
import { orderFacts, ordersHandler } from "./orders";

/**
 * Square (ADR-029): the business's own Square account for its bookings, its items and its orders,
 * paid at its own Square checkout. Salons, barbers, cafés, restaurants, trades and gyms that already
 * run their day on Square keep it as it is; their inbox reads it and writes into it.
 *
 * - **Busy times** (Square Appointments, on every plan): what Square would not book takes those times
 *   off what the inbox offers (`bookings.ts`).
 * - **Bookings**: each booking the inbox confirms is written into Square, moved and cancelled with it.
 *   Square takes them from an access token on Appointments Plus or Premium, where the token acts as
 *   the seller, and from Sign in with Square on every plan, where the app books as a customer
 *   (`writeLevel`). An access token on the free plan writes none, and the owner is told why (`withheld`).
 * - **The catalogue**: items and their variations, priced and counted at the chosen location
 *   (`catalogue.ts`).
 * - **Orders**: each order the inbox accepts becomes a Square order with its payment link, a pickup
 *   or a shipment, paid into the business's own account (`orders.ts`). Never a fee, never a share.
 * - **Webhooks**: one subscription at the connection's own address, signed by Square with HMAC-SHA-256
 *   over that address and the body (`x-square-hmacsha256-signature`); each is a nudge, read back with
 *   the business's key.
 *
 * Two ways in. **Sign in with Square**, the code flow of an app whoever runs the server registers
 * (`SQUARE_CLIENT_ID`/`_SECRET`), offered first where it is ready: "Soon" on a hosted inbox until ours
 * exists. Square keeps its webhook subscriptions for an app's own token, so a sign-in hears of changes
 * by polling. **An access token** the owner makes in their own Square app (Developer Console →
 * Credentials → Production), which needs nobody else's app: a personal access token opens the whole
 * account it was made in, and may make the webhook subscription (Square takes only such a token for
 * that). A Sandbox token connects in test mode.
 *
 * - https://developer.squareup.com/docs/build-basics/access-tokens
 * - https://developer.squareup.com/docs/oauth-api/create-urls-for-square-authorization
 * - https://developer.squareup.com/docs/oauth-api/receive-and-manage-tokens
 * - https://developer.squareup.com/docs/webhooks/webhook-subscriptions-api
 * - https://developer.squareup.com/docs/webhooks/step3validate
 */

export { SQUARE_API, SQUARE_SANDBOX_API, SQUARE_VERSION } from "./api";

/** What a sign-in asks Square for: reads, and the writes bookings and orders need. Never seller-level writes. */
export const SQUARE_SCOPES: readonly string[] = [
  "MERCHANT_PROFILE_READ",
  "ITEMS_READ",
  "INVENTORY_READ",
  "APPOINTMENTS_READ",
  "APPOINTMENTS_WRITE",
  "APPOINTMENTS_BUSINESS_SETTINGS_READ",
  "CUSTOMERS_READ",
  "CUSTOMERS_WRITE",
  "ORDERS_READ",
  "ORDERS_WRITE",
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
];

/** What the webhook subscription asks Square for: bookings, orders and their payments, items and stock. */
export const SQUARE_TOPICS: readonly string[] = [
  "booking.created",
  "booking.updated",
  "order.updated",
  "order.fulfillment.updated",
  "payment.updated",
  "refund.updated",
  "catalog.version.updated",
  "inventory.count.updated",
];

/** Topics understood when they arrive: the subscription's, and a sign-in's access withdrawn. */
const KNOWN = new Set([...SQUARE_TOPICS, "oauth.authorization.revoked"]);
/** A sign-in's token lasts 30 days; Square asks apps to renew it every seven days or sooner. */
const RENEW_WHEN_LEFT_MS = 23 * 86_400_000;
/** A webhook Square would not make or move is tried again after this, never on every sync. */
const HOOK_RETRY_MS = 3_600_000;
const DOCS = "https://surfingdog.ai/docs/connectors/square/";

export const squareForm = z.object({
  access_token: secretField(
    z
      .string()
      .trim()
      .min(20)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "a Square access token is letters, digits, - and _"),
    {
      label: "Access token",
      help: "From your own Square app. It opens your Square account: this inbox only reads your business, items and team, and adds bookings and orders.",
      steps: [
        "Open the Square Developer Console with your Square login, and create an app (name it Inbox).",
        "In the app, open Credentials, switch to Production, press Show beside the access token and copy it.",
      ],
      link: { href: "https://developer.squareup.com/apps", text: "Open the Square Developer Console" },
      placeholder: "EAAA…",
    },
  ),
});

/* --- the token, and the API it opens ------------------------------------------------------------ */

/** One API per run: a sign-in's token is renewed once, and the next run reads what was saved. */
const opened = new WeakMap<object, SquareApi>();

async function obtainToken(
  http: ConnectorHttp,
  client: OAuthClient,
  grant: Readonly<Record<string, string>>,
): Promise<{ access: string; refresh: string | null; expires: string | null; merchant: string | null }> {
  const res = await http.request({
    method: "POST",
    url: `${SQUARE_API}/oauth2/token`,
    headers: { "content-type": "application/json", accept: "application/json", "square-version": SQUARE_VERSION },
    body: JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, ...grant }),
  });
  if (res.status === 400 || res.status === 401) {
    throw new ConnectorError("auth", "Square did not finish the sign-in. Sign in with Square again.");
  }
  const a = answerOf(res);
  const access = str(a.json.access_token);
  if (a.status !== 200 || !access) throw new ConnectorError("bad_response", "Square did not give this inbox a token.");
  return {
    access,
    refresh: str(a.json.refresh_token),
    expires: str(a.json.expires_at),
    merchant: str(a.json.merchant_id),
  };
}

function apiOpener(client: OAuthClient | null): (ctx: RunContext) => Promise<SquareApi> {
  return async (ctx) => {
    const cached = opened.get(ctx);
    if (cached) return cached;
    const env = extraOf(ctx).env;
    let token = ctx.secret.access_token ?? "";
    if (!token) throw new ConnectorError("auth", "The saved Square token is missing. Connect Square again.");
    const refresh = ctx.secret.refresh_token;
    if (refresh) {
      const expires = Date.parse(ctx.secret.expires_at ?? "");
      if (!Number.isFinite(expires) || expires - ctx.now < RENEW_WHEN_LEFT_MS) {
        if (!client) {
          throw new ConnectorError(
            "config",
            "This server no longer has its Square app. Connect Square with an access token instead.",
          );
        }
        const t = await obtainToken(ctx.http, client, { grant_type: "refresh_token", refresh_token: refresh });
        await ctx.saveSecret({
          ...ctx.secret,
          access_token: t.access,
          refresh_token: t.refresh ?? refresh,
          ...(t.expires ? { expires_at: t.expires } : {}),
        });
        token = t.access;
      }
    }
    const api = new SquareApi(ctx.http, env, token);
    opened.set(ctx, api);
    return api;
  };
}

/* --- the webhook subscription ------------------------------------------------------------------ */

/**
 * Makes the subscription at the connection's own address: its id and the key Square signs with.
 * `idempotency` makes a retry of the same attempt the same subscription; without it, each connect is its own.
 */
async function subscribe(
  api: SquareApi,
  ctx: ConnectContext,
  url: string,
  idempotency: string = crypto.randomUUID(),
): Promise<{ id: string; key: string }> {
  const made = await api.must("POST", "/v2/webhooks/subscriptions", "add the webhook", {
    idempotency_key: idempotency,
    subscription: {
      name: `Inbox at ${ctx.inbox.host}`.slice(0, 64),
      event_types: SQUARE_TOPICS,
      notification_url: url,
      api_version: SQUARE_VERSION,
    },
  });
  const s = obj(made.subscription);
  const id = str(s.id);
  const key = str(s.signature_key);
  if (!id || !key) throw new ConnectorError("bad_response", "Square added the webhook but did not give its key.");
  return { id, key };
}

/** Takes a subscription away. Best effort: never throws. */
async function unsubscribe(api: SquareApi, id: string): Promise<void> {
  try {
    await api.call("DELETE", `/v2/webhooks/subscriptions/${encodeURIComponent(id)}`);
  } catch {
    // Left behind, it is found and removed on the next connect.
  }
}

/** This inbox's own Square subscriptions in the app: those that name its address for Square. */
async function subscriptionsOf(api: SquareApi, origin: string): Promise<string[]> {
  const a = await api.call("GET", "/v2/webhooks/subscriptions?include_disabled=true&limit=100");
  if (a.status !== 200) return [];
  const prefix = `${origin.replace(/\/+$/, "")}/v1/hooks/square/`;
  return arr(a.json.subscriptions)
    .filter((s) => typeof s.notification_url === "string" && s.notification_url.startsWith(prefix))
    .map((s) => String(s.id));
}

/* --- connecting ---------------------------------------------------------------------------------- */

function labelOf(read: AccountRead, env: SquareEnv): string {
  return env === "sandbox" ? `${read.account} (Sandbox)` : read.account;
}

function connectedOf(
  read: AccountRead,
  env: SquareEnv,
  via: SquareVia,
  secret: Record<string, string>,
  hooks: HookState,
  settle?: (kept: boolean) => Promise<void>,
): Connected {
  return {
    account: labelOf(read, env),
    // The same merchant in the Sandbox is another account.
    externalId: env === "sandbox" ? `sandbox:${read.merchantId}` : read.merchantId,
    secret,
    extra: extraFrom(read, env, via, hooks) as unknown as Record<string, unknown>,
    calendars: [],
    destinations: destinationsOf(read.services),
    defaults: { busy: [], destination: AUTO },
    // A Sandbox token takes test payments only: links for test orders only.
    mode: env === "sandbox" ? "test" : "live",
    choices: choicesOf(read, via),
    ...(settle ? { settle } : {}),
  };
}

/** Production first; a token Square's production does not know is tried in its Sandbox. */
async function openWithToken(http: ConnectorHttp, token: string): Promise<{ api: SquareApi; read: AccountRead }> {
  try {
    const api = new SquareApi(http, "production", token);
    return { api, read: await readAccount(api) };
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== "auth") throw error;
  }
  const api = new SquareApi(http, "sandbox", token);
  return { api, read: await readAccount(api) };
}

async function connectWithToken(ctx: ConnectContext, input: Readonly<Record<string, string>>): Promise<Connected> {
  const token = (input.access_token ?? "").trim();
  const { api, read } = await openWithToken(ctx.http, token);
  let made: { id: string; key: string } | null = null;
  if (ctx.hookUrl && ctx.hooksLive !== false) {
    try {
      made = await subscribe(api, ctx, ctx.hookUrl);
    } catch (error) {
      // Connected anyway: the webhook is tried again within the hour, and polling covers it meanwhile.
      if (!(error instanceof ConnectorError) || error.code === "auth") throw error;
    }
  }
  return connectedOf(
    read,
    api.env,
    "token",
    { access_token: token, ...(made ? { signature_key: made.key } : {}) },
    made
      ? { hooks: "added", subscriptionId: made.id, notificationUrl: ctx.hookUrl ?? undefined }
      : { hooks: "pending" },
    async (kept) => {
      if (!made) return;
      if (!kept) {
        await unsubscribe(api, made.id);
        return;
      }
      // Kept: the subscriptions this inbox made before for Square go, now that the new one is in place.
      for (const id of await subscriptionsOf(api, ctx.inbox.origin).catch(() => [])) {
        if (id !== made.id) await unsubscribe(api, id);
      }
    },
  );
}

/* --- reading again ----------------------------------------------------------------------------- */

/**
 * Every few hours, and as soon as the webhook needs it: the account read again (locations, services,
 * team), and the webhook made once the inbox is live, moved with the inbox's address, put back when it
 * was removed in Square, switched on again when Square switched it off, and its key taken again when
 * the owner made a new one in the Developer Console. One Square would not make or move is tried again
 * an hour on (`hooksTriedAt`).
 */
async function refresh(apiOf: (ctx: RunContext) => Promise<SquareApi>, ctx: RunContext) {
  const api = await apiOf(ctx);
  const read = await readAccount(api);
  const x = extraOf(ctx);
  let hooks: HookState = { hooks: x.hooks, subscriptionId: x.subscriptionId, notificationUrl: x.notificationUrl };
  if (x.via === "token" && ctx.hookUrl && ctx.hooksLive !== false) {
    const url = ctx.hookUrl;
    const anew = async () => {
      // The same attempt is the same subscription: a retry whose answer was lost makes no second one.
      const key = `sdi-${(await sha256(`${ctx.marker}:hook:${url}:${x.subscriptionId ?? "none"}`)).slice(0, 40)}`;
      const made = await subscribe(api, ctx, url, key);
      await ctx.saveSecret({ ...ctx.secret, signature_key: made.key });
      hooks = { hooks: "added", subscriptionId: made.id, notificationUrl: url };
      // Any other this inbox made for Square goes, now that this one is in place.
      for (const id of await subscriptionsOf(api, ctx.inbox.origin).catch(() => [])) {
        if (id !== made.id) await unsubscribe(api, id);
      }
    };
    try {
      if (x.hooks !== "added" || !x.subscriptionId) {
        await anew();
      } else {
        const got = await api.call("GET", `/v2/webhooks/subscriptions/${encodeURIComponent(x.subscriptionId)}`);
        const s = obj(got.json.subscription);
        if (got.status === 404) await anew();
        else if (got.status === 200) {
          // A key made anew in the Developer Console: every delivery would fail its signature until taken.
          const key = str(s.signature_key);
          if (key && key !== ctx.secret.signature_key) await ctx.saveSecret({ ...ctx.secret, signature_key: key });
          if (s.notification_url !== url || s.enabled === false) {
            await api.must(
              "PUT",
              `/v2/webhooks/subscriptions/${encodeURIComponent(x.subscriptionId)}`,
              "move the webhook",
              { subscription: { notification_url: url, enabled: true } },
            );
            hooks = { ...hooks, notificationUrl: url };
          }
        }
      }
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code === "auth") throw error;
      hooks = { ...hooks, hooksTriedAt: ctx.now };
    }
  }
  return {
    account: labelOf(read, x.env),
    calendars: [],
    destinations: destinationsOf(read.services),
    choices: choicesOf(read, x.via),
    extra: extraFrom(read, x.env, x.via, hooks) as unknown as Record<string, unknown>,
  };
}

/**
 * Read again now: the webhook is still to make (the inbox went live), or the inbox moved to another
 * address. Not again within the hour when Square would not, the last time.
 */
function stale(ctx: RunContext): boolean {
  const x = extraOf(ctx);
  if (x.via !== "token" || !ctx.hookUrl || ctx.hooksLive === false) return false;
  if (x.hooksTriedAt !== undefined && ctx.now - x.hooksTriedAt < HOOK_RETRY_MS) return false;
  return x.hooks !== "added" || x.notificationUrl !== ctx.hookUrl;
}

/** What Square cannot do for this account now, a line each: bookings, on a plan or way in that takes none. */
function withheldOf(extra: Readonly<Record<string, unknown>>, signIn: boolean): Withheld {
  const x = extraOf({ extra });
  if (!x.booking.enabled) {
    const off = "Square Appointments is off for this account.";
    return { busy_times: off, write_bookings: off };
  }
  if (writeLevel(x) !== null) return {};
  return {
    write_bookings: signIn
      ? "On Square Appointments Free, Square takes bookings through Sign in with Square only: connect again that way to add them. Busy times still come from Square."
      : "Square adds bookings from an access token on Appointments Plus or Premium only. Busy times still come from Square.",
  };
}

/* --- webhooks ---------------------------------------------------------------------------------- */

/** The ids a delivery names, each marked with what it is: never anything else of the body. */
function refsOf(topic: string, data: Record<string, unknown>): string[] {
  const object = obj(data.object);
  const id = str(data.id);
  const out: (string | null)[] = [];
  if (topic.startsWith("booking.")) out.push(id ? `booking:${id.split(":")[0]}` : null);
  if (topic === "order.updated") out.push(`order:${str(obj(object.order_updated).order_id) ?? id ?? ""}`);
  if (topic === "order.fulfillment.updated") {
    out.push(`order:${str(obj(object.order_fulfillment_updated).order_id) ?? id ?? ""}`);
  }
  if (topic === "payment.updated") {
    out.push(id ? `payment:${id}` : null);
    const order = str(obj(object.payment).order_id);
    out.push(order ? `order:${order}` : null);
  }
  if (topic === "refund.updated") {
    out.push(id ? `refund:${id}` : null);
    const order = str(obj(object.refund).order_id);
    out.push(order ? `order:${order}` : null);
  }
  if (topic === "inventory.count.updated") {
    for (const c of arr(object.inventory_counts).slice(0, 50)) {
      const v = str(c.catalog_object_id);
      out.push(v ? `variation:${v}` : null);
    }
  }
  return out.filter((r): r is string => r !== null && !r.endsWith(":"));
}

function hooksOf(apiOf: (ctx: RunContext) => Promise<SquareApi>): HooksHandler {
  return {
    topics: SQUARE_TOPICS,
    async verify(ctx, request): Promise<HookEvent | null> {
      const x = extraOf(ctx);
      // Square signs the address it was given for the subscription, then the body, byte for byte.
      const url = x.notificationUrl ?? ctx.hookUrl ?? "";
      const ok = await verifyBase64Hmac(
        ctx.secret.signature_key ?? "",
        `${url}${request.body}`,
        request.headers.get("x-square-hmacsha256-signature"),
      );
      if (!ok) throw new ConnectorError("refused", "The signature does not check out.");
      let body: Record<string, unknown>;
      try {
        body = obj(JSON.parse(request.body));
      } catch {
        return null;
      }
      const topic = str(body.type);
      const eventId = str(body.event_id);
      // Another seller's event (an app's subscription is the app's), or one this inbox does not follow.
      if (!topic || !eventId || !KNOWN.has(topic) || (str(body.merchant_id) ?? x.merchantId) !== x.merchantId) {
        return null;
      }
      return { eventId, topic, refs: refsOf(topic, obj(body.data)) };
    },

    async read(ctx, event): Promise<HookFact[]> {
      const of = (kind: string) =>
        event.refs.filter((r) => r.startsWith(`${kind}:`)).map((r) => r.slice(kind.length + 1));
      if (event.topic.startsWith("booking.")) return [{ kind: "busy" }];
      if (event.topic === "catalog.version.updated") return [{ kind: "catalogue", externalIds: "all" }];
      if (event.topic === "inventory.count.updated") return [{ kind: "catalogue", externalIds: of("variation") }];
      const api = await apiOf(ctx);
      if (event.topic === "oauth.authorization.revoked") {
        // Believed only once Square, asked with the token, no longer takes it.
        try {
          await api.call("GET", "/v2/locations");
          return [];
        } catch (error) {
          if (error instanceof ConnectorError && error.code === "auth") return [{ kind: "revoked" }];
          throw error;
        }
      }
      const orders = new Set(of("order"));
      if (orders.size === 0) {
        for (const id of of("payment")) {
          const a = await api.call("GET", `/v2/payments/${encodeURIComponent(id)}`);
          const order = str(obj(a.json.payment).order_id);
          if (a.status === 200 && order) orders.add(order);
        }
        for (const id of of("refund")) {
          const a = await api.call("GET", `/v2/refunds/${encodeURIComponent(id)}`);
          const order = str(obj(a.json.refund).order_id);
          if (a.status === 200 && order) orders.add(order);
        }
      }
      const facts: HookFact[] = [];
      for (const id of [...orders].slice(0, 3)) facts.push(...(await orderFacts(api, ctx, id)));
      return facts;
    },
  };
}

/* --- sign in with Square (an app of whoever runs the server) ------------------------------------- */

function oauthFlow(client: OAuthClient): OAuthFlow {
  return {
    authorizeUrl({ redirectUri, state }) {
      // The code flow, with the app's secret on the server: its refresh token lasts and can be used again.
      const q = new URLSearchParams({
        client_id: client.clientId,
        scope: SQUARE_SCOPES.join(" "),
        session: "false",
        state,
        redirect_uri: redirectUri,
      });
      return `${SQUARE_API}/oauth2/authorize?${q}`;
    },
    async exchange(ctx, { code, redirectUri }) {
      const t = await obtainToken(ctx.http, client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });
      const api = new SquareApi(ctx.http, "production", t.access);
      const read = await readAccount(api);
      if (t.merchant && t.merchant !== read.merchantId) {
        throw new ConnectorError("bad_response", "Square signed in another account than it named.");
      }
      return connectedOf(
        read,
        "production",
        "signin",
        {
          access_token: t.access,
          ...(t.refresh ? { refresh_token: t.refresh } : {}),
          ...(t.expires ? { expires_at: t.expires } : {}),
        },
        { hooks: "none" },
      );
    },
  };
}

async function revoke(http: ConnectorHttp, client: OAuthClient, token: string): Promise<void> {
  try {
    await http.request({
      method: "POST",
      url: `${SQUARE_API}/oauth2/revoke`,
      headers: {
        authorization: `Client ${client.clientSecret}`,
        "content-type": "application/json",
        "square-version": SQUARE_VERSION,
      },
      body: JSON.stringify({ client_id: client.clientId, access_token: token }),
    });
  } catch {
    // Best effort: the owner can also remove the app in Square → Apps.
  }
}

/* --- the connector ----------------------------------------------------------------------------- */

export function squareConnector(
  client: OAuthClient | null = null,
  opts: { readonly hosted?: boolean | undefined } = {},
): ConnectorDefinition {
  const app = client?.clientId && client.clientSecret ? client : null;
  const apiOf = apiOpener(app);
  const payments = ordersHandler(apiOf);
  return {
    kind: "square",
    title: "Square",
    group: "shops",
    capabilities: ["busy_times", "write_bookings", "catalogue", "pay_links", "shop_orders"],
    auth: "form",
    form: squareForm,
    presets: [
      {
        id: "oauth",
        label: "Sign in with Square",
        values: {},
        auth: "oauth",
        ready: () => (app ? true : "Needs a Square app on the server (SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET)."),
        whenNotReady: opts.hosted
          ? { status: "soon" }
          : { status: "setup", hint: "Needs a Square app on the server.", href: `${DOCS}#sign-in-with-square` },
        consent:
          "Square asks you to let this inbox read your business, items, stock and team, and make bookings, customer records and orders.",
      },
    ],
    disconnectNote:
      "If you pasted an access token, delete your Inbox app in the Square Developer Console to switch it off.",
    bookingsNote: "Square texts its booking messages to your location's phone, never to your customer.",
    withheld: ({ extra }) => withheldOf(extra, app !== null),
    connect: connectWithToken,
    ...(app ? { oauth: oauthFlow(app) } : {}),
    refresh: (ctx) => refresh(apiOf, ctx),
    stale,
    busy: (ctx, window) => busy(apiOf, ctx, window),
    bookings: bookingWriter(apiOf),
    catalogue: catalogueReader(apiOf),
    payments,
    hooks: hooksOf(apiOf),
    async disconnect(ctx) {
      const x = extraOf(ctx);
      let api: SquareApi | null = null;
      try {
        api = await apiOf(ctx);
      } catch {
        api = null;
      }
      if (api && x.subscriptionId) await unsubscribe(api, x.subscriptionId);
      const token = ctx.secret.access_token;
      if (app && ctx.secret.refresh_token && token) await revoke(ctx.http, app, token);
    },
  };
}
