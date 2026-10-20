import {
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  decimalAmount,
  type InboundRequest,
  type KnownLink,
  minorAmount,
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
 * Mollie (ADR-023): pay links in the business's own Mollie account, with the profile's API key.
 *
 * An order the inbox accepts gets a Payment Link for what it comes to, good for one payment, made
 * with an idempotency key from the inbox's own id for the link. Each link names its own webhook
 * (`/v1/hooks/mollie?ref=<the inbox's id for it>`): Mollie posts there the id of a payment, unsigned,
 * and the inbox asks Mollie with the key what was paid on that link before it marks anything paid —
 * the body is never believed, so nothing needs adding in Mollie. Someone who also adds a signed
 * webhook in Mollie (`payment-link.paid`, `X-Mollie-Signature: sha256=<hex HMAC of the body>`) can give
 * its signing secret through the API (`webhook_secret`, not drawn in the form): those events are
 * checked by it as well, then read back the same way. A link whose order changed or ended is
 * archived. Refunds are made in Mollie, where the money is; what Mollie says was refunded of a
 * payment marks the inbox's refund done.
 *
 * The endpoints and fields are the ones Mollie documented on 18 October 2026; answers are read
 * leniently, so a field added later changes nothing.
 */

export const MOLLIE_API = "https://api.mollie.com";
/**
 * The currencies Mollie takes, and the decimals it wants in `amount.value`, as
 * https://docs.mollie.com/docs/multicurrency lists them (read 20 October 2026): two, but none for
 * ISK and JPY. For HUF and TWD Mollie rounds PayPal payments up to whole units, so only a whole amount
 * is asked for in them. A currency not here is refused with the reason; the guest pays another way. A
 * test pins every row (`test/payments.test.ts`).
 */
export const MOLLIE_DECIMALS: Readonly<Record<string, number>> = {
  AED: 2,
  AUD: 2,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 2,
  ILS: 2,
  ISK: 0,
  JPY: 0,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NZD: 2,
  PHP: 2,
  PLN: 2,
  RON: 2,
  RUB: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TWD: 2,
  USD: 2,
  ZAR: 2,
};
const WHOLE_ONLY: ReadonlySet<string> = new Set(["HUF", "TWD"]);

/** Why Mollie cannot be asked for this amount, or null: a currency it takes, in its own decimals, that ISO agrees with. */
export function mollieCurrencyProblem(amount: PayAmount): string | null {
  const code = amount.currency.toUpperCase();
  const decimals = MOLLIE_DECIMALS[code];
  if (decimals === undefined)
    return `Mollie does not list ${code} among the currencies it takes, so no link is made in it`;
  if (minorUnits(code) !== decimals)
    return `Mollie counts ${code} in ${decimals} decimals and ISO 4217 does not, so no link is made in it`;
  if (WHOLE_ONLY.has(code) && amount.value % 100 !== 0) {
    return `Mollie rounds ${code} up to whole units for some payments, so a link is made only for a whole amount`;
  }
  return null;
}
/** The event a signed webhook added in Mollie's dashboard sends for a link paid. */
export const MOLLIE_EVENTS: readonly string[] = ["payment-link.paid"];
const KEY_PAGE = "https://my.mollie.com/dashboard/developers/api-keys";
const MOLLIE_DASHBOARD = "https://my.mollie.com/dashboard";

export const mollieForm = z.object({
  api_key: secretField(
    z
      .string()
      .trim()
      .min(20)
      .max(200)
      .regex(/^(live|test|access)_[A-Za-z0-9]+$/, "a Mollie API key starts with live_ or test_"),
    {
      label: "API key",
      help: "In Mollie: Developers → API keys. Copy the Live API key, or the Test API key to try it first.",
      link: { href: KEY_PAGE, text: "Get your API key" },
      placeholder: "live_… or test_…",
      byMode: { live: "live_…", test: "test_…" },
    },
  ),
  // Mollie reports every payment either way; a signed webhook added in Mollie is for the few who want
  // one (docs/payments). Taken through the API, never drawn in the form.
  webhook_secret: secretField(z.string().trim().min(16).max(200).optional(), {
    label: "Webhook signing secret",
    hidden: true,
  }),
});

type Mode = "live" | "test";

interface Ctx {
  readonly http: ConnectContext["http"];
}

async function call(
  ctx: Ctx,
  key: string,
  method: string,
  path: string,
  opts: { readonly body?: unknown; readonly idempotency?: string } = {},
): Promise<{ res: ConnectorHttpResponse; json: Record<string, unknown> }> {
  const res = await ctx.http.request({
    method,
    url: `${MOLLIE_API}${path}`,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/hal+json, application/json",
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.idempotency ? { "idempotency-key": opts.idempotency } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    const parsed = res.text ? JSON.parse(res.text) : {};
    json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (res.status === 401) {
    throw new ConnectorError("auth", "Mollie did not take that API key. Copy it again from Mollie and connect again.", {
      field: "api_key",
    });
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Mollie asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Mollie is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  if (res.status === 404) throw new ConnectorError("not_found", detailOf(json) || "Mollie has no such thing.");
  if (res.status >= 400) {
    throw new ConnectorError("refused", `Mollie said: ${detailOf(json) || `HTTP ${res.status}`}`);
  }
  return { res, json };
}

function detailOf(json: Record<string, unknown>): string {
  return typeof json.detail === "string" ? json.detail.slice(0, 300) : "";
}

function modeOf(key: string): Mode {
  return key.startsWith("live_") ? "live" : "test";
}

/** The mode a typed key is for, before Mollie is asked anything; null when it is not a profile key. */
function modeOfInput(input: Readonly<Record<string, string>>): Mode | null {
  const m = /^(live|test)_/.exec(String(input.api_key ?? "").trim());
  return m ? (m[1] as Mode) : null;
}

function href(links: unknown, name: string): string | null {
  const l = (links as Record<string, { href?: unknown }> | undefined)?.[name];
  return typeof l?.href === "string" && l.href.startsWith("https://") ? l.href : null;
}

async function connect(ctx: ConnectContext, input: Readonly<Record<string, string>>): Promise<Connected> {
  const key = String(input.api_key ?? "");
  if (key.startsWith("access_")) {
    throw new ConnectorError(
      "config",
      "That is an access token. Use the profile's API key (live_… or test_…) from Developers → API keys.",
      { field: "api_key" },
    );
  }
  const mode = modeOf(key);
  const { json: profile } = await call(ctx, key, "GET", "/v2/profiles/me");
  const id = typeof profile.id === "string" ? profile.id : "";
  if (!id.startsWith("pfl_"))
    throw new ConnectorError("bad_response", "Mollie did not say which profile this key is for.");
  if (!ctx.hookUrl) {
    throw new ConnectorError(
      "config",
      "This inbox does not know its own public https address (INBOX_PUBLIC_URL, or the Inbox address in Settings), so Mollie could not tell it of payments.",
    );
  }
  const name = typeof profile.name === "string" && profile.name.trim() ? profile.name.trim().slice(0, 80) : id;
  const given = input.webhook_secret?.trim() || "";
  return {
    account: mode === "live" ? name : `${name} · test mode`,
    externalId: `${id}:${mode}`,
    secret: { api_key: key, ...(given ? { webhook_secret: given } : {}) },
    extra: {
      webhook: given ? "by_hand" : "per_link",
      profile_id: id,
      ...(typeof profile.status === "string" ? { profile_status: profile.status } : {}),
    },
    calendars: [],
    destinations: [],
    defaults: { busy: [], destination: null },
    mode,
  };
}

async function createLink(ctx: RunContext, req: PayLinkRequest) {
  const { json } = await call(ctx, keyOf(ctx), "POST", "/v2/payment-links", {
    idempotency: `sdi-${req.ref}`,
    body: {
      description: req.title.slice(0, 255),
      // In Mollie's own decimals for the currency (ADR-032): 4500 EUR is "45.00", 4500 JPY is "4500".
      amount: {
        currency: req.amount.currency.toUpperCase(),
        value: decimalAmount(req.amount, MOLLIE_DECIMALS[req.amount.currency.toUpperCase()] ?? 2),
      },
      // A link that closes with its window (a deposit's): Mollie stops taking payments on it then
      // (https://docs.mollie.com/reference/create-payment-link, `expiresAt`); the inbox archives it too.
      ...(req.expiresAt ? { expiresAt: mollieTime(req.expiresAt) } : {}),
      webhookUrl: req.hookUrl,
      reusable: false,
    },
  });
  const externalId = typeof json.id === "string" ? json.id : "";
  const url = href(json._links, "paymentLink");
  if (!externalId.startsWith("pl_") || !url) {
    throw new ConnectorError("bad_response", "Mollie made the payment link but did not say where it is.");
  }
  return { externalId, url };
}

/** An instant as Mollie writes one: ISO 8601 to the second, with its offset. */
function mollieTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

async function closeLink(ctx: RunContext, link: { readonly externalId: string }): Promise<void> {
  await call(ctx, keyOf(ctx), "PATCH", `/v2/payment-links/${encodeURIComponent(link.externalId)}`, {
    body: { archived: true },
  });
}

/**
 * Mollie's names for how it was paid, in the network's payment words (the receipt's `pay`, which the
 * payment-methods data reads): one with no word of its own there is left out rather than stored raw.
 */
export const MOLLIE_METHODS: Readonly<Record<string, string>> = {
  creditcard: "card",
  banktransfer: "sepa",
  directdebit: "sepa",
  ideal: "ideal",
  bancontact: "bancontact",
  paypal: "paypal",
  klarnapaylater: "klarna",
  klarnapaynow: "klarna",
  klarnasliceit: "klarna",
  klarna: "klarna",
  applepay: "apple_pay",
  googlepay: "google_pay",
  mbway: "mb_way",
  multibanco: "multibanco",
  blik: "blik",
  twint: "twint",
};

/** One Mollie payment as a fact, read with the key; null for one that is neither paid nor failed. */
function factOf(p: Record<string, unknown>, link: KnownLink): PaymentFact | null {
  if (typeof p.id !== "string" || !p.id.startsWith("tr_")) return null;
  const status = p.status === "paid" ? "paid" : p.status === "failed" ? "failed" : null;
  if (!status) return null;
  const amount = p.amount as { value?: unknown; currency?: unknown } | undefined;
  const currency = typeof amount?.currency === "string" ? amount.currency.toUpperCase() : "";
  const value =
    typeof amount?.value === "string" && currency ? minorAmount(amount.value, MOLLIE_DECIMALS[currency] ?? 2) : null;
  const method = typeof p.method === "string" ? MOLLIE_METHODS[p.method] : undefined;
  const paidAt = typeof p.paidAt === "string" ? Date.parse(p.paidAt) : Number.NaN;
  const dashboardUrl = href(p._links, "dashboard");
  return {
    status,
    linkId: link.externalId,
    ref: link.ref || null,
    paymentId: p.id,
    amount: value === null ? null : { value, currency },
    ...(method ? { method } : {}),
    ...(status === "paid" && Number.isFinite(paidAt) ? { paidAt } : {}),
    ...(dashboardUrl ? { dashboardUrl } : {}),
    livemode: p.mode === "live",
  };
}

/**
 * What Mollie holds about the link's payments, read with the key: each one paid. A failed attempt on
 * a Mollie link leaves the link open to try again, so only payments made count.
 */
async function check(ctx: RunContext, link: KnownLink): Promise<PaymentFact[]> {
  if (!link.externalId) return [];
  const { json } = await call(
    ctx,
    keyOf(ctx),
    "GET",
    `/v2/payment-links/${encodeURIComponent(link.externalId)}/payments?limit=10`,
  );
  const payments = ((json._embedded ?? {}) as { payments?: unknown }).payments;
  const list = Array.isArray(payments) ? (payments as Record<string, unknown>[]) : [];
  return list
    .filter((p) => p && typeof p === "object" && p.status === "paid")
    .map((p) => factOf(p, link))
    .filter((f): f is PaymentFact => f !== null);
}

/** What was refunded of a payment, read with the key: the dashboard's refunds mark the inbox's refund done. */
async function refunded(ctx: RunContext, payment: { readonly paymentId: string }) {
  if (!payment.paymentId.startsWith("tr_")) return null;
  const { json } = await call(
    ctx,
    keyOf(ctx),
    "GET",
    `/v2/payments/${encodeURIComponent(payment.paymentId)}/refunds?limit=50`,
  );
  const listed = ((json._embedded ?? {}) as { refunds?: unknown }).refunds;
  // Made: on its way back or back. One queued for want of balance, failed or cancelled is not.
  const made = new Set(["pending", "processing", "refunded"]);
  const refunds = (Array.isArray(listed) ? (listed as Record<string, unknown>[]) : []).filter(
    (r) => r && typeof r === "object" && typeof r.id === "string" && made.has(String(r.status)),
  );
  let total = 0;
  let currency = "";
  for (const r of refunds) {
    const a = r.amount as { value?: unknown; currency?: unknown } | undefined;
    const code = typeof a?.currency === "string" ? a.currency.toUpperCase() : "";
    const value = typeof a?.value === "string" && code ? minorAmount(a.value, MOLLIE_DECIMALS[code] ?? 2) : null;
    if (value === null || typeof a?.currency !== "string") continue;
    if (currency && currency !== a.currency.toUpperCase()) return null;
    currency = a.currency.toUpperCase();
    total += value;
  }
  if (!currency || total <= 0) return null;
  const newest = [...refunds].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return { amount: { value: total, currency }, refundIds: newest.map((r) => String(r.id)) };
}

/**
 * A webhook. A signed one (Mollie's newer webhooks, added in the dashboard) is checked by its
 * signature — each value Mollie sends while a secret is rolled — and names the link; Mollie's
 * per-link one is not signed and names a payment, and the link comes from the address it was sent to.
 * Either way what was paid is asked of Mollie with the key: nothing in the body is believed.
 */
async function receive(ctx: RunContext, request: InboundRequest, lookup: (ref: string) => Promise<KnownLink | null>) {
  const signed = request.headers.get("x-mollie-signature");
  if (signed !== null) {
    const secret = ctx.secret.webhook_secret;
    if (!secret) throw new ConnectorError("refused", "A signed Mollie webhook, but no signing secret is set here.");
    const expected = await hmacSha256Hex(secret, request.body);
    const given = signed
      .split(",")
      .map((s) =>
        s
          .trim()
          .replace(/^sha256=/i, "")
          .toLowerCase(),
      )
      .filter(Boolean);
    if (!given.some((g) => constantTimeEqual(g, expected))) {
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
    const entityId = typeof event.entityId === "string" ? event.entityId : "";
    if (!MOLLIE_EVENTS.includes(type) || !eventId || !entityId.startsWith("pl_")) return null;
    const facts = await check(ctx, { ref: "", externalId: entityId, itemId: "" });
    return facts.length > 0 ? { eventId, topic: type, facts: facts.map((f) => ({ ...f, ref: null })) } : null;
  }
  const ref = request.query.get("ref");
  if (!ref) return null;
  const link = await lookup(ref);
  if (!link?.externalId) return null;
  const facts = await check(ctx, link);
  if (facts.length === 0) return null;
  // The same payments told twice are one event; a second payment on the link is another.
  const ids = facts.map((f) => f.paymentId).sort();
  return { eventId: `${ids.join(",")}:paid`.slice(0, 200), topic: "payment-link.payment", facts };
}

async function refresh(ctx: RunContext) {
  const { json } = await call(ctx, keyOf(ctx), "GET", "/v2/profiles/me");
  const name = typeof json.name === "string" && json.name.trim() ? json.name.trim().slice(0, 80) : "Mollie";
  return {
    account: modeOf(keyOf(ctx)) === "live" ? name : `${name} · test mode`,
    calendars: [],
    destinations: [],
  };
}

function keyOf(ctx: Pick<RunContext, "secret">): string {
  const key = ctx.secret.api_key;
  if (!key) throw new ConnectorError("config", "The Mollie key is not there. Connect Mollie again.");
  return key;
}

export function mollieConnector(): ConnectorDefinition {
  return {
    kind: "mollie",
    title: "Mollie",
    group: "payments",
    capabilities: ["pay_links"],
    auth: "form",
    form: mollieForm,
    note: "Orders you accept get a link to pay into your own Mollie account. Refunds stay in Mollie.",
    hookEvents: MOLLIE_EVENTS,
    modeOf: modeOfInput,
    connect,
    refresh,
    payments: {
      createLink,
      currencyProblem: mollieCurrencyProblem,
      closeLink,
      check,
      refunded,
      receive,
      // Mollie opens the account's own organisation from here; each payment links to itself.
      dashboardUrl: () => MOLLIE_DASHBOARD,
    },
  };
}
