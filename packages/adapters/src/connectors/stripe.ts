import {
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  type InboundRequest,
  type KnownLink,
  type PayLinkRequest,
  type PaymentFact,
  type RunContext,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { retryAfterMs } from "./http";
import { constantTimeEqual, hmacSha256Hex } from "./pay-sign";

/**
 * Stripe (ADR-023): pay links in the business's own Stripe account, with a restricted key the owner
 * makes for this inbox and nothing else. Never Stripe Connect: no platform account stands between the
 * business and its money, and none of it passes the inbox.
 *
 * An order the inbox accepts gets a Price and a Payment Link for what it comes to, good for one
 * payment, made with idempotency keys from the inbox's own id for the link so a retry never makes two.
 * Stripe tells the inbox of a payment by webhook, signed (`Stripe-Signature`, HMAC-SHA-256 over
 * `<t>.<body>` with the endpoint's secret, five minutes' tolerance); the inbox checks the signature,
 * then reads the Checkout Session back from Stripe with the key before anything is marked paid. The
 * webhook endpoint is added by the inbox when the key may (`Webhook Endpoints: Write`), or by the
 * owner, who pastes its signing secret. A link whose order changed or ended is deactivated. Refunds
 * are made in Stripe, where the money is.
 *
 * The endpoints, parameters and permissions are the ones Stripe documented on 18 October 2026; answers
 * are read leniently, so a field added later changes nothing.
 */

export const STRIPE_API = "https://api.stripe.com";
/** Every checkout a Payment Link starts ends in one of these. */
export const STRIPE_EVENTS: readonly string[] = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
];
/** What the restricted key needs, as Stripe's key page names each permission. */
export const STRIPE_PERMISSIONS = {
  links: "Payment Links: Write",
  products: "Products: Write",
  prices: "Prices: Write",
  sessions: "Checkout Sessions: Read",
  webhooks: "Webhook Endpoints: Write",
} as const;
/** How old a signed webhook may be: Stripe's own libraries' default. */
export const STRIPE_TOLERANCE_S = 300;
const KEY_PAGE = "https://dashboard.stripe.com/apikeys/create";

export const stripeForm = z.object({
  api_key: secretField(
    z
      .string()
      .trim()
      .min(20)
      .max(300)
      .regex(/^(rk|sk|pk)_(live|test)_[A-Za-z0-9]+$/, "a Stripe restricted key starts with rk_live_ or rk_test_"),
    {
      label: "Restricted key",
      help: "Stripe → Developers → API keys → Create restricted key. Write: Payment Links, Products, Prices, Webhook Endpoints. Read: Checkout Sessions. Everything else: None.",
      link: { href: KEY_PAGE, text: "Create the key in Stripe" },
      placeholder: "rk_live_…",
    },
  ),
  webhook_secret: secretField(
    z
      .string()
      .trim()
      .regex(/^whsec_[A-Za-z0-9+/=_-]{10,}$/, "a Stripe signing secret starts with whsec_")
      .optional(),
    {
      label: "Webhook signing secret",
      help: "Only for a key without Webhook Endpoints: add the address below in Stripe → Developers → Webhooks, with these events, and paste its signing secret.",
      placeholder: "whsec_…",
      advanced: true,
    },
  ),
});

type Mode = "live" | "test";

interface Ctx {
  readonly http: ConnectContext["http"];
}

/** Stripe's form encoding: `a[b][0]=c`, in the order given. */
function form(params: readonly (readonly [string, string | number | boolean])[]): string {
  return params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

async function call(
  ctx: Ctx,
  key: string,
  method: string,
  path: string,
  opts: { readonly body?: string; readonly idempotency?: string } = {},
): Promise<{ res: ConnectorHttpResponse; json: Record<string, unknown> }> {
  const res = await ctx.http.request({
    method,
    url: `${STRIPE_API}${path}`,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(opts.body !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(opts.idempotency ? { "idempotency-key": opts.idempotency } : {}),
    },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    const parsed = res.text ? JSON.parse(res.text) : {};
    json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (res.status === 401) {
    throw new ConnectorError("auth", "Stripe did not take that key. Make a new restricted key and connect again.", {
      field: "api_key",
    });
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Stripe asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Stripe is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  return { res, json };
}

/** Stripe's own words for what went wrong, short. */
function messageOf(json: Record<string, unknown>): string {
  const e = json.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message.slice(0, 300) : "";
}

/** A call that must work: a refusal said in Stripe's words, a missing permission named. */
async function must(
  ctx: Ctx,
  key: string,
  method: string,
  path: string,
  what: { readonly doing: string; readonly permission: string },
  opts: { readonly body?: string; readonly idempotency?: string } = {},
): Promise<Record<string, unknown>> {
  const { res, json } = await call(ctx, key, method, path, opts);
  if (res.status === 403) {
    throw new ConnectorError(
      "config",
      `The Stripe key cannot ${what.doing}: give it ${what.permission} on Stripe's key page and connect again.`,
      { field: "api_key" },
    );
  }
  if (res.status === 404) throw new ConnectorError("not_found", messageOf(json) || "Stripe has no such thing.");
  if (res.status >= 400) {
    throw new ConnectorError("refused", `Stripe said: ${messageOf(json) || `HTTP ${res.status}`}`);
  }
  return json;
}

function modeOf(key: string): Mode {
  return key.includes("_live_") ? "live" : "test";
}

function accountLabel(key: string): string {
  return `${modeOf(key) === "live" ? "Live" : "Test mode"} · key ending ${key.slice(-4)}`;
}

/** The business's payments in its own dashboard. */
function dashboard(mode: Mode, path = "payments"): string {
  return `https://dashboard.stripe.com/${mode === "test" ? "test/" : ""}${path}`;
}

/**
 * Connects: the key is checked against what the inbox needs before anything is kept — every
 * permission it lacks named at once, never discovered later on a customer's order — and the
 * webhook is added in the account (or taken as the owner added it).
 */
async function connect(ctx: ConnectContext, input: Readonly<Record<string, string>>): Promise<Connected> {
  const key = String(input.api_key ?? "");
  if (key.startsWith("sk_")) {
    throw new ConnectorError(
      "config",
      "That is a secret key, which can do anything in your Stripe account. Create a restricted key with only what this inbox needs.",
      { field: "api_key" },
    );
  }
  if (key.startsWith("pk_")) {
    throw new ConnectorError("config", "That is a publishable key. Create a restricted key instead.", {
      field: "api_key",
    });
  }
  const mode = modeOf(key);
  const missing: string[] = [];
  // Reading payment links: the key works at all, and is this account's.
  const first = await call(ctx, key, "GET", "/v1/payment_links?limit=1");
  if (first.res.status === 403) missing.push(STRIPE_PERMISSIONS.links);
  else if (first.res.status >= 400) {
    throw new ConnectorError("refused", `Stripe said: ${messageOf(first.json) || `HTTP ${first.res.status}`}`, {
      field: "api_key",
    });
  }
  // What it may write, asked with requests missing their parameters, which make nothing: a key without
  // the permission is refused (403), one with it is told what is missing (400). Should Stripe ever read
  // the parameters first, a missing permission still shows, as a link that could not be made (ADR-023).
  for (const [permission, method, path] of [
    [STRIPE_PERMISSIONS.links, "POST", "/v1/payment_links"],
    [STRIPE_PERMISSIONS.products, "POST", "/v1/products"],
    [STRIPE_PERMISSIONS.prices, "POST", "/v1/prices"],
    [STRIPE_PERMISSIONS.sessions, "GET", "/v1/checkout/sessions?limit=1"],
  ] as const) {
    if (missing.includes(permission)) continue;
    const { res } = await call(ctx, key, method, path, method === "POST" ? { body: "" } : {});
    if (res.status === 403) missing.push(permission);
  }
  const given = input.webhook_secret?.trim() || "";
  let endpoints: Record<string, unknown>[] = [];
  if (!given) {
    const listed = await call(ctx, key, "GET", "/v1/webhook_endpoints?limit=100");
    if (listed.res.status === 403) missing.push(STRIPE_PERMISSIONS.webhooks);
    else if (listed.res.status < 400) endpoints = arrayOf(listed.json.data);
  }
  if (missing.length > 0) {
    const hookOnly = missing.length === 1 && missing[0] === STRIPE_PERMISSIONS.webhooks;
    throw new ConnectorError(
      "config",
      hookOnly
        ? `The key cannot add the webhook (${STRIPE_PERMISSIONS.webhooks}). Give it that, or add the webhook in Stripe yourself and paste its signing secret under More options.`
        : `The Stripe key is missing ${listOf(missing)}. Edit the key in Stripe and connect again.`,
      { field: "api_key" },
    );
  }
  if (!ctx.hookUrl) {
    throw new ConnectorError(
      "config",
      "This inbox does not know its own public https address (INBOX_PUBLIC_URL, or the Inbox address in Settings), so Stripe could not tell it of payments.",
    );
  }
  if (given) {
    return connected(key, mode, { webhook_secret: given }, { webhook: "by_hand" });
  }
  // The webhook, added afresh: Stripe shows a signing secret only once, when the endpoint is made. The
  // ones this inbox added before go once the new one is there.
  const made = await must(
    ctx,
    key,
    "POST",
    "/v1/webhook_endpoints",
    { doing: "add the webhook", permission: STRIPE_PERMISSIONS.webhooks },
    {
      body: form([
        ["url", ctx.hookUrl],
        ...STRIPE_EVENTS.map((e) => ["enabled_events[]", e] as const),
        ["description", `Inbox at ${ctx.inbox.host}: marks orders paid`],
        ["metadata[sdi_inbox]", ctx.inbox.id],
      ]),
    },
  );
  const endpointId = typeof made.id === "string" ? made.id : "";
  const secret = typeof made.secret === "string" ? made.secret : "";
  if (!endpointId || !secret.startsWith("whsec_")) {
    throw new ConnectorError("bad_response", "Stripe added the webhook but did not give its signing secret.");
  }
  for (const e of endpoints) {
    const id = typeof e.id === "string" ? e.id : "";
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    if (!id || id === endpointId) continue;
    if (meta.sdi_inbox === ctx.inbox.id || e.url === ctx.hookUrl) {
      await call(ctx, key, "DELETE", `/v1/webhook_endpoints/${encodeURIComponent(id)}`).catch(() => {});
    }
  }
  return connected(
    key,
    mode,
    { webhook_secret: secret },
    { webhook: "added", endpoint_id: endpointId, hook_url: ctx.hookUrl },
  );
}

function connected(key: string, mode: Mode, secret: Record<string, string>, extra: Record<string, unknown>): Connected {
  return {
    account: accountLabel(key),
    // One Stripe account per mode per inbox: a restricted key cannot say which account it is without
    // a Connect permission this inbox does not ask for.
    externalId: `stripe:${mode}`,
    secret: { api_key: key, ...secret },
    extra,
    calendars: [],
    destinations: [],
    defaults: { busy: [], destination: null },
    mode,
  };
}

async function createLink(ctx: RunContext, req: PayLinkRequest) {
  const key = keyOf(ctx);
  const price = await must(
    ctx,
    key,
    "POST",
    "/v1/prices",
    { doing: "make prices", permission: STRIPE_PERMISSIONS.prices },
    {
      idempotency: `sdi-${req.ref}-price`,
      body: form([
        ["currency", req.amount.currency.toLowerCase()],
        ["unit_amount", req.amount.value],
        ["product_data[name]", req.title],
        ["product_data[metadata][sdi_item]", req.itemId],
        ["metadata[sdi_ref]", req.ref],
      ]),
    },
  );
  const priceId = typeof price.id === "string" ? price.id : "";
  if (!priceId) throw new ConnectorError("bad_response", "Stripe made the price but did not say its id.");
  const link = await must(
    ctx,
    key,
    "POST",
    "/v1/payment_links",
    { doing: "make payment links", permission: STRIPE_PERMISSIONS.links },
    {
      idempotency: `sdi-${req.ref}-link`,
      body: form([
        ["line_items[0][price]", priceId],
        ["line_items[0][quantity]", 1],
        // Good for one payment: once paid, Stripe deactivates it.
        ["restrictions[completed_sessions][limit]", 1],
        ["submit_type", "pay"],
        ["metadata[sdi_ref]", req.ref],
        ["metadata[sdi_item]", req.itemId],
        ["metadata[sdi_inbox]", ctx.inbox.id],
        ["payment_intent_data[metadata][sdi_ref]", req.ref],
        ["payment_intent_data[metadata][sdi_item]", req.itemId],
        ["after_completion[type]", "hosted_confirmation"],
        ["after_completion[hosted_confirmation][custom_message]", req.thanks.slice(0, 500)],
        ["inactive_message", req.inactive.slice(0, 500)],
      ]),
    },
  );
  const externalId = typeof link.id === "string" ? link.id : "";
  const url = typeof link.url === "string" ? link.url : "";
  if (!externalId.startsWith("plink_") || !url.startsWith("https://")) {
    throw new ConnectorError("bad_response", "Stripe made the payment link but did not say where it is.");
  }
  if (typeof link.livemode === "boolean" && link.livemode !== (modeOf(key) === "live")) {
    throw new ConnectorError("bad_response", "Stripe made the link in the other mode than the key's.");
  }
  return { externalId, url };
}

async function closeLink(ctx: RunContext, link: { readonly externalId: string }): Promise<void> {
  await must(
    ctx,
    keyOf(ctx),
    "POST",
    `/v1/payment_links/${encodeURIComponent(link.externalId)}`,
    { doing: "change payment links", permission: STRIPE_PERMISSIONS.links },
    { body: form([["active", "false"]]) },
  );
}

/** A Checkout Session as Stripe answers it, read back with the key: what it says about the payment. */
function factOf(session: Record<string, unknown>, failed: boolean): PaymentFact | null {
  if (session.object !== "checkout.session") return null;
  const id = typeof session.id === "string" ? session.id : "";
  if (!id) return null;
  const livemode = session.livemode === true;
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : null;
  const total = Number(session.amount_total);
  const currency = typeof session.currency === "string" ? session.currency.toUpperCase() : "";
  const status = session.payment_status;
  return {
    status: status === "paid" ? "paid" : failed ? "failed" : "pending",
    linkId: typeof session.payment_link === "string" ? session.payment_link : null,
    ref: typeof meta.sdi_ref === "string" ? meta.sdi_ref : null,
    paymentId: pi ?? id,
    amount: Number.isInteger(total) && total >= 0 && currency.length === 3 ? { value: total, currency } : null,
    ...(pi ? { dashboardUrl: dashboard(livemode ? "live" : "test", `payments/${encodeURIComponent(pi)}`) } : {}),
    livemode,
  };
}

async function check(ctx: RunContext, link: KnownLink): Promise<PaymentFact | null> {
  if (!link.externalId) return null;
  const json = await must(
    ctx,
    keyOf(ctx),
    "GET",
    `/v1/checkout/sessions?payment_link=${encodeURIComponent(link.externalId)}&limit=10`,
    { doing: "read checkouts", permission: STRIPE_PERMISSIONS.sessions },
  );
  const sessions = arrayOf(json.data);
  const paid = sessions.find((s) => s.payment_status === "paid" && s.payment_link === link.externalId);
  return paid ? factOf(paid, false) : null;
}

/**
 * A webhook: the signature first (any of the `v1` values Stripe sends while a secret is rolled), then
 * the event, then the Checkout Session read back from Stripe. A checkout that did not come from a link
 * this inbox made (the business sells through Stripe elsewhere too) is left alone without a call.
 */
async function receive(ctx: RunContext, request: InboundRequest) {
  const secret = ctx.secret.webhook_secret;
  const header = request.headers.get("stripe-signature");
  if (!secret || !header) throw new ConnectorError("refused", "No Stripe signature.");
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isInteger(t) || signatures.length === 0) throw new ConnectorError("refused", "A malformed signature.");
  if (Math.abs(Math.floor(ctx.now / 1000) - t) > STRIPE_TOLERANCE_S) {
    throw new ConnectorError("refused", "The signature is too old.");
  }
  const expected = await hmacSha256Hex(secret, `${t}.${request.body}`);
  if (!signatures.some((s) => constantTimeEqual(s, expected))) {
    throw new ConnectorError("refused", "The signature does not check out.");
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(request.body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "";
  const eventId = typeof event.id === "string" ? event.id : "";
  if (!STRIPE_EVENTS.includes(type) || !eventId) return null;
  const object = ((event.data ?? {}) as { object?: unknown }).object as Record<string, unknown> | undefined;
  if (object?.object !== "checkout.session" || typeof object.id !== "string") return null;
  const meta = (object.metadata ?? {}) as Record<string, unknown>;
  if (typeof object.payment_link !== "string" || meta.sdi_inbox !== ctx.inbox.id) return null;
  // Never the body's word: the session as Stripe holds it now.
  const session = await must(ctx, keyOf(ctx), "GET", `/v1/checkout/sessions/${encodeURIComponent(object.id)}`, {
    doing: "read checkouts",
    permission: STRIPE_PERMISSIONS.sessions,
  });
  const fact = factOf(session, type === "checkout.session.async_payment_failed");
  if (!fact || fact.linkId !== object.payment_link) return null;
  return { eventId, topic: type, facts: [fact] };
}

async function disconnect(ctx: RunContext): Promise<void> {
  const id = ctx.extra.endpoint_id;
  if (ctx.extra.webhook !== "added" || typeof id !== "string") return;
  await call(ctx, keyOf(ctx), "DELETE", `/v1/webhook_endpoints/${encodeURIComponent(id)}`);
}

/**
 * Every few hours: the key still works, and the webhook this inbox added still points at the inbox's
 * address, which moves when a business takes its inbox to its own domain. One that points elsewhere
 * is moved; one that was removed in Stripe is said, so the owner connects again.
 */
async function refresh(ctx: RunContext) {
  const key = keyOf(ctx);
  await must(ctx, key, "GET", "/v1/payment_links?limit=1", {
    doing: "read payment links",
    permission: STRIPE_PERMISSIONS.links,
  });
  const id = ctx.extra.endpoint_id;
  if (ctx.extra.webhook === "added" && typeof id === "string" && ctx.hookUrl) {
    const path = `/v1/webhook_endpoints/${encodeURIComponent(id)}`;
    let endpoint: Record<string, unknown>;
    try {
      endpoint = await must(ctx, key, "GET", path, {
        doing: "read the webhook",
        permission: STRIPE_PERMISSIONS.webhooks,
      });
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "not_found") {
        throw new ConnectorError(
          "config",
          "The webhook this inbox added in Stripe was removed, so Stripe no longer tells it of payments. Connect Stripe again.",
        );
      }
      throw error;
    }
    if (endpoint.url !== ctx.hookUrl) {
      await must(
        ctx,
        key,
        "POST",
        path,
        { doing: "change the webhook", permission: STRIPE_PERMISSIONS.webhooks },
        { body: form([["url", ctx.hookUrl]]) },
      );
    }
    return {
      account: accountLabel(key),
      calendars: [],
      destinations: [],
      extra: { ...ctx.extra, hook_url: ctx.hookUrl },
    };
  }
  return { account: accountLabel(key), calendars: [], destinations: [] };
}

/** The inbox moved to another address since the webhook was last pointed at it. */
function stale(ctx: RunContext): boolean {
  return ctx.extra.webhook === "added" && Boolean(ctx.hookUrl) && ctx.extra.hook_url !== ctx.hookUrl;
}

function keyOf(ctx: Pick<RunContext, "secret">): string {
  const key = ctx.secret.api_key;
  if (!key) throw new ConnectorError("config", "The Stripe key is not there. Connect Stripe again.");
  return key;
}

function arrayOf(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];
}

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function stripeConnector(): ConnectorDefinition {
  return {
    kind: "stripe",
    title: "Stripe",
    group: "payments",
    capabilities: ["pay_links"],
    auth: "form",
    form: stripeForm,
    note: "Orders you accept get a link to pay into your own Stripe account. Refunds stay in Stripe.",
    hookEvents: STRIPE_EVENTS,
    connect,
    refresh,
    stale,
    disconnect,
    payments: {
      createLink,
      closeLink,
      check,
      receive: (ctx, request) => receive(ctx, request),
      dashboardUrl: (_ctx, mode) => dashboard(mode),
    },
  };
}
