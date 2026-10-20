import {
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  type InboundRequest,
  type KnownLink,
  minorUnits,
  type PayAmount,
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
 * are read leniently, so a field added later changes nothing. Every call names the API version the
 * inbox reads (`Stripe-Version`), and so does the webhook it adds, so what Stripe answers does not
 * change with the account's own default version.
 */

export const STRIPE_API = "https://api.stripe.com";
/** The Stripe API version every call and the inbox's webhook are read in: the fields used here are in it. */
export const STRIPE_VERSION = "2024-06-20";
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
/**
 * The currencies Stripe takes for a payment, and the exponent it counts each in, as
 * https://docs.stripe.com/currencies lists them (read 20 October 2026): two places unless it names the
 * currency as zero-decimal; ISK written as hundredths that are always 00 ("to charge 5 ISK, provide an
 * amount value of 500"). UGX it names both ways, so it is refused with that reason. A currency not
 * here (KWD, BHD, JOD and the other ISO currencies of thousandths) is refused: the page lists none.
 * Which of these a given account takes depends on its country; Stripe refuses the rest, in its words.
 * A test pins every row (`test/payments.test.ts`).
 */
export const STRIPE_CURRENCIES: Readonly<Record<string, number | string>> = {
  AED: 2,
  AFN: 2,
  ALL: 2,
  AMD: 2,
  ANG: 2,
  AOA: 2,
  ARS: 2,
  AUD: 2,
  AWG: 2,
  AZN: 2,
  BAM: 2,
  BBD: 2,
  BDT: 2,
  BIF: 0,
  BMD: 2,
  BND: 2,
  BOB: 2,
  BRL: 2,
  BSD: 2,
  BWP: 2,
  BYN: 2,
  BZD: 2,
  CAD: 2,
  CDF: 2,
  CHF: 2,
  CLP: 0,
  CNY: 2,
  COP: 2,
  CRC: 2,
  CVE: 2,
  CZK: 2,
  DJF: 0,
  DKK: 2,
  DOP: 2,
  DZD: 2,
  EGP: 2,
  ETB: 2,
  EUR: 2,
  FJD: 2,
  FKP: 2,
  GBP: 2,
  GEL: 2,
  GIP: 2,
  GMD: 2,
  GNF: 0,
  GTQ: 2,
  GYD: 2,
  HKD: 2,
  HNL: 2,
  HTG: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  ISK: 2,
  JMD: 2,
  JPY: 0,
  KES: 2,
  KGS: 2,
  KHR: 2,
  KMF: 0,
  KRW: 0,
  KYD: 2,
  KZT: 2,
  LAK: 2,
  LBP: 2,
  LKR: 2,
  LRD: 2,
  LSL: 2,
  MAD: 2,
  MDL: 2,
  MGA: 0,
  MKD: 2,
  MMK: 2,
  MNT: 2,
  MOP: 2,
  MUR: 2,
  MVR: 2,
  MWK: 2,
  MXN: 2,
  MYR: 2,
  MZN: 2,
  NAD: 2,
  NGN: 2,
  NIO: 2,
  NOK: 2,
  NPR: 2,
  NZD: 2,
  PAB: 2,
  PEN: 2,
  PGK: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  PYG: 0,
  QAR: 2,
  RON: 2,
  RSD: 2,
  RUB: 2,
  RWF: 0,
  SAR: 2,
  SBD: 2,
  SCR: 2,
  SEK: 2,
  SGD: 2,
  SHP: 2,
  SLE: 2,
  SOS: 2,
  SRD: 2,
  STD: 2,
  SZL: 2,
  THB: 2,
  TJS: 2,
  TOP: 2,
  TRY: 2,
  TTD: 2,
  TWD: 2,
  TZS: 2,
  UAH: 2,
  UGX: "Stripe lists UGX as zero-decimal and also as written in hundredths, so no link is made in it",
  USD: 2,
  UYU: 2,
  UZS: 2,
  VND: 0,
  VUV: 0,
  WST: 2,
  XAF: 0,
  XCD: 2,
  XCG: 2,
  XOF: 0,
  XPF: 0,
  YER: 2,
  ZAR: 2,
  ZMW: 2,
};

/** An amount in the inbox's minor units (ISO 4217) as Stripe counts it, or why Stripe cannot be asked for it. */
export function stripeAmount(
  amount: PayAmount,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string } {
  const code = amount.currency.toUpperCase();
  const stripe = STRIPE_CURRENCIES[code];
  const iso = minorUnits(code);
  if (typeof stripe === "string") return { ok: false, reason: stripe };
  if (stripe === undefined || iso === null) {
    return {
      ok: false,
      reason: `Stripe does not list ${code} among the currencies it takes, so no link is made in it`,
    };
  }
  if (stripe >= iso) return { ok: true, value: amount.value * 10 ** (stripe - iso) };
  // Stripe counts it in whole units where ISO counts hundredths (MGA): only a whole amount converts.
  const step = 10 ** (iso - stripe);
  if (amount.value % step !== 0) {
    return { ok: false, reason: `Stripe takes ${code} in whole units only, and this amount has a fraction` };
  }
  return { ok: true, value: amount.value / step };
}

/** An amount as Stripe counts it, back in the inbox's minor units (ISO 4217); null when it does not convert. */
export function fromStripeAmount(value: number, currency: string): number | null {
  const code = currency.toUpperCase();
  const stripe = STRIPE_CURRENCIES[code];
  const iso = minorUnits(code);
  if (typeof stripe !== "number" || iso === null || !Number.isInteger(value)) return null;
  if (stripe <= iso) return value * 10 ** (iso - stripe);
  const step = 10 ** (stripe - iso);
  return value % step === 0 ? value / step : null;
}

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
      help: "In Stripe: Developers → API keys → Create restricted key, then set:",
      steps: [
        "Payment Links · Write",
        "Products · Write",
        "Prices · Write",
        "Webhook Endpoints · Write",
        "Checkout Sessions · Read",
      ],
      link: { href: KEY_PAGE, text: "Create the key in Stripe" },
      placeholder: "rk_live_… or rk_test_…",
      byMode: { live: "rk_live_…", test: "rk_test_…" },
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
      "stripe-version": STRIPE_VERSION,
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

/**
 * A refusal in the owner's words: the ones an owner meets are said plainly, any other in Stripe's
 * own ("Stripe said: …").
 */
function refusalOf(json: Record<string, unknown>, status: number): string {
  const e = (json.error ?? {}) as { code?: unknown; message?: unknown };
  if (e.code === "amount_too_small") {
    const least =
      typeof e.message === "string" ? /at least (\S+?)(?:\s+[a-z]{3})?\.?$/i.exec(e.message)?.[1] : undefined;
    return `Stripe takes payments of ${least ?? "a little more"} or more. Ask for payment another way.`;
  }
  return `Stripe said: ${messageOf(json) || `HTTP ${status}`}`;
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
  if (res.status >= 400) throw new ConnectorError("refused", refusalOf(json, res.status));
  return json;
}

function modeOf(key: string): Mode {
  return key.includes("_live_") ? "live" : "test";
}

/**
 * The mode a typed restricted key is for, before Stripe is asked anything; null for anything else (a
 * secret or publishable key is refused for what it is, by `connect`).
 */
function modeOfInput(input: Readonly<Record<string, string>>): Mode | null {
  const m = /^rk_(live|test)_/.exec(String(input.api_key ?? "").trim());
  return m ? (m[1] as Mode) : null;
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
  // What the inbox added for the key before (connecting again in place): it goes once the new key is kept.
  const before = ctx.previous?.extra.webhook === "added" ? ctx.previous.extra.endpoint_id : undefined;
  const dropBefore = async () => {
    if (typeof before === "string" && before) await removeEndpoint(ctx, key, before);
  };
  if (given) {
    return connected(key, mode, { webhook_secret: given }, { webhook: "by_hand" }, async (kept) => {
      if (kept) await dropBefore();
    });
  }
  if (ctx.hooksLive === false) {
    // A hosted inbox before it goes live answers only its owner: a webhook added now would fail, and
    // Stripe would write to the business about it and switch it off. It is added on the first sync
    // once the inbox is live; until then a payment is found by asking Stripe.
    return connected(key, mode, {}, { webhook: "pending" }, async (kept) => {
      if (kept) await dropBefore();
    });
  }
  // The webhook, added afresh: Stripe shows a signing secret only once, when the endpoint is made.
  const made = await addEndpoint(ctx, key, ctx.hookUrl);
  return connected(
    key,
    mode,
    { webhook_secret: made.secret },
    { webhook: "added", endpoint_id: made.id, hook_url: ctx.hookUrl },
    async (kept) => {
      if (!kept) {
        // Refused after all (the mode is connected already): what was just made goes, the working one stays.
        await removeEndpoint(ctx, key, made.id);
        return;
      }
      // Kept: the endpoints this inbox added before go, now that the new one is in place.
      for (const e of endpoints) {
        const id = typeof e.id === "string" ? e.id : "";
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        if (!id || id === made.id) continue;
        if (meta.sdi_inbox === ctx.inbox.id || e.url === ctx.hookUrl) await removeEndpoint(ctx, key, id);
      }
      if (typeof before === "string" && before !== made.id && !endpoints.some((e) => e.id === before)) {
        await dropBefore();
      }
    },
  );
}

/** Adds the inbox's webhook endpoint in the account: its id and the signing secret Stripe shows only now. */
async function addEndpoint(ctx: Ctx & Pick<ConnectContext, "inbox">, key: string, url: string) {
  const made = await must(
    ctx,
    key,
    "POST",
    "/v1/webhook_endpoints",
    { doing: "add the webhook", permission: STRIPE_PERMISSIONS.webhooks },
    {
      body: form([
        ["url", url],
        ...STRIPE_EVENTS.map((e) => ["enabled_events[]", e] as const),
        ["api_version", STRIPE_VERSION],
        ["description", `Inbox at ${ctx.inbox.host}: marks orders paid`],
        ["metadata[sdi_inbox]", ctx.inbox.id],
      ]),
    },
  );
  const id = typeof made.id === "string" ? made.id : "";
  const secret = typeof made.secret === "string" ? made.secret : "";
  if (!id || !secret.startsWith("whsec_")) {
    throw new ConnectorError("bad_response", "Stripe added the webhook but did not give its signing secret.");
  }
  return { id, secret };
}

/** Takes one of the inbox's webhook endpoints away again. Best effort: never throws. */
async function removeEndpoint(ctx: Ctx, key: string, id: string): Promise<void> {
  try {
    await call(ctx, key, "DELETE", `/v1/webhook_endpoints/${encodeURIComponent(id)}`);
  } catch {
    // A courtesy to the account: an endpoint left behind is listed, and removed, on the next connect.
  }
}

function connected(
  key: string,
  mode: Mode,
  secret: Record<string, string>,
  extra: Record<string, unknown>,
  settle?: (kept: boolean) => Promise<void>,
): Connected {
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
    ...(settle ? { settle } : {}),
  };
}

async function createLink(ctx: RunContext, req: PayLinkRequest) {
  const key = keyOf(ctx);
  const amount = stripeAmount(req.amount);
  // Asked only after `currencyProblem` said yes: a refusal here is a bug's, never a guessed amount.
  if (!amount.ok) throw new ConnectorError("refused", amount.reason);
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
        ["unit_amount", amount.value],
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
  const currency = typeof session.currency === "string" ? session.currency.toUpperCase() : "";
  // Back in the inbox's minor units: Stripe writes ISK as hundredths (ADR-032).
  const total = currency.length === 3 ? fromStripeAmount(Number(session.amount_total), currency) : null;
  const status = session.payment_status;
  return {
    status: status === "paid" ? "paid" : failed ? "failed" : "pending",
    linkId: typeof session.payment_link === "string" ? session.payment_link : null,
    ref: typeof meta.sdi_ref === "string" ? meta.sdi_ref : null,
    paymentId: pi ?? id,
    amount: total !== null && total >= 0 ? { value: total, currency } : null,
    ...(pi ? { dashboardUrl: dashboard(livemode ? "live" : "test", `payments/${encodeURIComponent(pi)}`) } : {}),
    livemode,
  };
}

/** Every paid checkout on the link, read with the key: two paid on one link are both seen. */
async function check(ctx: RunContext, link: KnownLink): Promise<PaymentFact[]> {
  if (!link.externalId) return [];
  const json = await must(
    ctx,
    keyOf(ctx),
    "GET",
    `/v1/checkout/sessions?payment_link=${encodeURIComponent(link.externalId)}&limit=10`,
    { doing: "read checkouts", permission: STRIPE_PERMISSIONS.sessions },
  );
  return arrayOf(json.data)
    .filter((s) => s.payment_status === "paid" && s.payment_link === link.externalId)
    .map((s) => factOf(s, false))
    .filter((f): f is PaymentFact => f !== null);
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
 * Every few hours, and on each sync while a link waits to be paid: the key still works, and the
 * webhook this inbox added still points at the inbox's address (which moves when a business takes
 * its inbox to its own domain) and is switched on. One that points elsewhere is moved; one Stripe
 * switched off (deliveries that kept failing) is switched on again; one removed in Stripe is said,
 * so the owner connects again. A webhook still to be added (the inbox was not live yet) is added
 * once it is.
 */
async function refresh(ctx: RunContext) {
  const key = keyOf(ctx);
  await must(ctx, key, "GET", "/v1/payment_links?limit=1", {
    doing: "read payment links",
    permission: STRIPE_PERMISSIONS.links,
  });
  const base = { account: accountLabel(key), calendars: [], destinations: [] };
  if (ctx.extra.webhook === "pending" && ctx.hookUrl && ctx.hooksLive !== false) {
    const made = await addEndpoint(ctx, key, ctx.hookUrl);
    await ctx.saveSecret({ ...ctx.secret, webhook_secret: made.secret });
    return { ...base, extra: { ...ctx.extra, webhook: "added", endpoint_id: made.id, hook_url: ctx.hookUrl } };
  }
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
    const moved = endpoint.url !== ctx.hookUrl;
    const off = endpoint.status === "disabled";
    if (moved || off) {
      await must(
        ctx,
        key,
        "POST",
        path,
        { doing: "change the webhook", permission: STRIPE_PERMISSIONS.webhooks },
        { body: form([["url", ctx.hookUrl], ...(off ? [["disabled", "false"] as const] : [])]) },
      );
    }
    return { ...base, extra: { ...ctx.extra, hook_url: ctx.hookUrl } };
  }
  return base;
}

/**
 * Read again now: the inbox moved to another address since the webhook was last pointed at it, went
 * live with it still to add, or has a link waiting to be paid (its webhook is looked at every sync).
 */
function stale(ctx: RunContext, opts?: { readonly openLinks: boolean }): boolean {
  if (!ctx.hookUrl) return false;
  if (ctx.extra.webhook === "pending") return ctx.hooksLive !== false;
  return ctx.extra.webhook === "added" && (ctx.extra.hook_url !== ctx.hookUrl || opts?.openLinks === true);
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
    modeOf: modeOfInput,
    connect,
    refresh,
    stale,
    disconnect,
    payments: {
      currencyProblem: (amount) => {
        const converted = stripeAmount(amount);
        return converted.ok ? null : converted.reason;
      },
      createLink,
      closeLink,
      check,
      receive: (ctx, request) => receive(ctx, request),
      dashboardUrl: (_ctx, mode) => dashboard(mode),
    },
  };
}
