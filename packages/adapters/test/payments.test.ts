import type { InboundRequest, KnownLink, PayLinkRequest, RunContext } from "@surfingdog/core";
import {
  ConnectorError,
  decimalAmount,
  describeForm,
  ISO_4217_MINOR_UNITS,
  minorAmount,
  minorUnits,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  connectorHttp,
  fromStripeAmount,
  hmacSha256Hex,
  MOLLIE_DECIMALS,
  MOLLIE_METHODS,
  mollieConnector,
  mollieCurrencyProblem,
  STRIPE_CURRENCIES,
  STRIPE_EVENTS,
  STRIPE_VERSION,
  stripeAmount,
  stripeConnector,
  stripeForm,
} from "../src/index";
import {
  HOOK,
  INBOX_ID,
  MOLLIE_LIVE_KEY,
  MOLLIE_PROFILE,
  MOLLIE_SIGNING_SECRET,
  MOLLIE_TEST_KEY,
  MOLLIE_UNAUTHORIZED,
  MOLLIE_UNPROCESSABLE,
  mollieLinkPaidEvent,
  mollieLinkPayments,
  molliePaymentLink,
  STRIPE_AMOUNT_TOO_SMALL,
  STRIPE_EMPTY_LIST,
  STRIPE_ENDPOINT_CREATED,
  STRIPE_INVALID_KEY,
  STRIPE_LIVE_KEY,
  STRIPE_MISSING_PARAM,
  STRIPE_OLD_ENDPOINTS,
  STRIPE_PAYMENT_LINK,
  STRIPE_PERMISSION_ERROR,
  STRIPE_PRICE,
  STRIPE_SECRET_KEY,
  STRIPE_TEST_KEY,
  STRIPE_WEBHOOK_SECRET,
  stripeEvent,
  stripeSession,
} from "./fixtures/payments";

/**
 * Contract tests for the payment connectors (ADR-023) against answers shaped after Stripe's and
 * Mollie's documentation (fixtures/payments.ts): what is asked of the platform, with which headers
 * and body, and what the inbox makes of the answer — above all, that nothing a webhook's body says is
 * believed until the platform, asked back with the business's own key, says it too. The HTTP client
 * is the real one; only `fetch` is faked.
 */

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

type Route = (req: Seen) => Response | Promise<Response> | undefined;

function fakePlatform(route: Route) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    seen.push(req);
    const res = await route(req);
    return res ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { http: connectorHttp({ fetchImpl }), seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const INBOX = {
  id: INBOX_ID,
  origin: "https://inbox.salon.example",
  host: "inbox.salon.example",
  name: "Ana's Salon",
  timezone: "Europe/Lisbon",
  language: "pt",
};
const NOW = Date.parse("2026-10-18T09:30:00Z");

function connectContext(http: RunContext["http"], over: Partial<RunContext> = {}) {
  return { http, now: NOW, inbox: INBOX, hookUrl: `${HOOK}/stripe`, ...over };
}

function runContext(http: RunContext["http"], over: Partial<RunContext> = {}): RunContext {
  return {
    http,
    now: NOW,
    inbox: INBOX,
    hookUrl: `${HOOK}/stripe`,
    secret: {},
    extra: {},
    calendars: [],
    busyCalendars: [],
    destinations: [],
    destination: null,
    own: { ids: new Set(), spans: [] },
    marker: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    saveSecret: async () => {},
    ...over,
  };
}

const REQUEST: PayLinkRequest = {
  ref: "01JC0PAYREF0000000000000001",
  itemId: "01JC0ORDER00000000000004F2K9Q",
  amount: { value: 4500, currency: "EUR" },
  title: "Colour and cut (4F2K9Q)",
  reference: "4F2K9Q",
  language: "en",
  thanks: "Thank you for your payment for order 4F2K9Q.",
  inactive:
    "This link to pay is closed. Ana's Salon's latest email about order 4F2K9Q says what is still to pay, if anything.",
  hookUrl: `${HOOK}/mollie?ref=01JC0PAYREF0000000000000001`,
};

const form = (body: string) => new URLSearchParams(body);
const noLookup = async (): Promise<KnownLink | null> => null;

/** A Stripe webhook as Stripe signs it: `t=<seconds>,v1=<hex HMAC of "<t>.<body>">`. */
async function signedStripe(body: string, opts: { at?: number; secret?: string; extra?: string } = {}) {
  const t = Math.floor((opts.at ?? NOW) / 1000);
  const v1 = await hmacSha256Hex(opts.secret ?? STRIPE_WEBHOOK_SECRET, `${t}.${body}`);
  const header = `t=${t},${opts.extra ? `v1=${opts.extra},` : ""}v1=${v1},v0=0000`;
  return {
    headers: new Headers({ "stripe-signature": header }),
    body,
    query: new URLSearchParams(),
  } satisfies InboundRequest;
}

/* --- money ------------------------------------------------------------------- */

describe("amounts as platforms write them", () => {
  it("writes each currency in its own minor unit, as every amount here is kept, and reads it back (ADR-032)", () => {
    expect(decimalAmount({ value: 4500, currency: "EUR" })).toBe("45.00");
    expect(decimalAmount({ value: 5, currency: "EUR" })).toBe("0.05");
    expect(decimalAmount({ value: 123_456, currency: "USD" })).toBe("1234.56");
    expect(decimalAmount({ value: 500, currency: "JPY" })).toBe("500");
    expect(decimalAmount({ value: 4_500, currency: "KWD" })).toBe("4.500");
    expect(decimalAmount({ value: 4_500, currency: "KWD" }, 2)).toBe("45.00");
    expect(minorAmount("500", 0)).toBe(500);
    expect(minorAmount("4.5", 3)).toBe(4_500);
    expect(minorAmount("4.5", 0)).toBeNull();
    expect(minorAmount("45.00")).toBe(4500);
    expect(minorAmount("45.5")).toBe(4550);
    expect(minorAmount("45")).toBe(4500);
    expect(minorAmount("45.000")).toBe(4500);
    expect(minorAmount("45.001")).toBeNull();
    expect(minorAmount("-1.00")).toBeNull();
    expect(minorAmount("abc")).toBeNull();
  });
});

/**
 * Every currency each platform takes, one test each (ADR-032): the inbox's ISO 4217 minor units go to
 * the platform in the platform's own count and come back the same, or the currency is refused with
 * the reason. https://docs.stripe.com/currencies and https://docs.mollie.com/docs/multicurrency.
 */
describe("Stripe's currencies, one by one", () => {
  const zero = new Set("BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF".split(" "));
  for (const [code, rule] of Object.entries(STRIPE_CURRENCIES)) {
    it(`${code}`, () => {
      const iso = minorUnits(code);
      if (typeof rule === "string") {
        expect(stripeAmount({ value: 500, currency: code })).toEqual({ ok: false, reason: rule });
        return;
      }
      if (iso === null) {
        // Listed by Stripe but not an ISO 4217 code this inbox prices in (STD, replaced by STN).
        expect(stripeAmount({ value: 500, currency: code }).ok).toBe(false);
        return;
      }
      expect(rule).toBe(code === "ISK" ? 2 : zero.has(code) ? 0 : 2);
      // One whole unit of the currency, in the inbox's count and in Stripe's.
      const one = 10 ** iso;
      const converted = stripeAmount({ value: 37 * one, currency: code });
      expect(converted).toEqual({ ok: true, value: 37 * 10 ** rule });
      expect(fromStripeAmount(37 * 10 ** rule, code)).toBe(37 * one);
    });
  }

  it("names the rows the docs single out", () => {
    // ISK is written as hundredths that are always 00: 5 ISK is 500.
    expect(stripeAmount({ value: 5, currency: "ISK" })).toEqual({ ok: true, value: 500 });
    expect(fromStripeAmount(550, "ISK")).toBeNull();
    // Ariary: ISO counts hundredths, Stripe whole ariary; a fraction is refused, never rounded.
    expect(stripeAmount({ value: 150_000, currency: "MGA" })).toEqual({ ok: true, value: 1_500 });
    expect(stripeAmount({ value: 150_050, currency: "MGA" }).ok).toBe(false);
    expect(stripeAmount({ value: 90_540, currency: "JPY" })).toEqual({ ok: true, value: 90_540 });
    for (const code of ["KWD", "BHD", "JOD", "OMR", "TND"]) {
      expect(stripeAmount({ value: 42_750, currency: code })).toMatchObject({ ok: false });
    }
  });
});

describe("Mollie's currencies, one by one", () => {
  for (const [code, decimals] of Object.entries(MOLLIE_DECIMALS)) {
    it(`${code}`, () => {
      expect(decimals).toBe(ISO_4217_MINOR_UNITS[code]);
      expect(mollieCurrencyProblem({ value: 37 * 10 ** decimals * 100, currency: code })).toBeNull();
      const written = decimalAmount({ value: 37 * 10 ** decimals, currency: code }, decimals);
      expect(written).toBe(decimals === 0 ? "37" : "37.00");
      expect(minorAmount(written, decimals)).toBe(37 * 10 ** decimals);
    });
  }

  it("refuses what it does not list, and a fraction of a forint", () => {
    expect(mollieCurrencyProblem({ value: 450_000, currency: "KES" })).toContain("does not list KES");
    expect(mollieCurrencyProblem({ value: 42_750, currency: "KWD" })).toContain("does not list KWD");
    expect(mollieCurrencyProblem({ value: 250_050, currency: "HUF" })).toContain("whole amount");
    expect(mollieCurrencyProblem({ value: 250_000, currency: "HUF" })).toBeNull();
    expect(mollieCurrencyProblem({ value: 90_540, currency: "JPY" })).toBeNull();
  });
});

/* --- Stripe --------------------------------------------------------------------- */

/** A Stripe account whose key may do everything the inbox asks, unless told otherwise. */
function stripeAccount(opts: { forbid?: readonly string[]; key?: string } = {}) {
  const forbid = new Set(opts.forbid ?? []);
  const key = opts.key ?? STRIPE_LIVE_KEY;
  return fakePlatform((r) => {
    const url = new URL(r.url);
    if (url.host !== "api.stripe.com") return undefined;
    if (r.headers.get("authorization") !== `Bearer ${key}`) return json(STRIPE_INVALID_KEY, 401);
    const route = `${r.method} ${url.pathname}`;
    const no = (permission: string) => json(STRIPE_PERMISSION_ERROR(permission), 403);
    switch (route) {
      case "GET /v1/payment_links":
        return forbid.has("links") ? no("rak_payment_links_read") : json(STRIPE_EMPTY_LIST("/v1/payment_links"));
      case "POST /v1/payment_links":
        if (forbid.has("links")) return no("rak_payment_links_write");
        return r.body ? json(STRIPE_PAYMENT_LINK) : json(STRIPE_MISSING_PARAM("line_items"), 400);
      case "POST /v1/products":
        return forbid.has("products") ? no("rak_product_write") : json(STRIPE_MISSING_PARAM("name"), 400);
      case "POST /v1/prices":
        if (forbid.has("prices")) return no("rak_plan_write");
        return r.body ? json(STRIPE_PRICE) : json(STRIPE_MISSING_PARAM("currency"), 400);
      case "GET /v1/checkout/sessions":
        return forbid.has("sessions")
          ? no("rak_checkout_session_read")
          : json({ ...STRIPE_EMPTY_LIST("/v1/checkout/sessions"), data: [stripeSession()] });
      case "GET /v1/webhook_endpoints":
        return forbid.has("webhooks") ? no("rak_webhook_read") : json(STRIPE_OLD_ENDPOINTS);
      case "POST /v1/webhook_endpoints":
        return forbid.has("webhooks") ? no("rak_webhook_write") : json(STRIPE_ENDPOINT_CREATED);
      case `DELETE /v1/webhook_endpoints/${STRIPE_OLD_ENDPOINTS.data[0]?.id}`:
        return json({ id: STRIPE_OLD_ENDPOINTS.data[0]?.id, object: "webhook_endpoint", deleted: true });
      case `POST /v1/payment_links/${STRIPE_PAYMENT_LINK.id}`:
        return json({ ...STRIPE_PAYMENT_LINK, active: false });
      case `GET /v1/checkout/sessions/${stripeSession().id}`:
        return json(stripeSession());
      default:
        return undefined;
    }
  });
}

describe("Stripe: connecting a restricted key", () => {
  it("refuses a secret key and a publishable key before it calls Stripe", async () => {
    const p = stripeAccount();
    const def = stripeConnector();
    for (const key of [STRIPE_SECRET_KEY, `pk_live_${"x".repeat(30)}`]) {
      const err = await def.connect?.(connectContext(p.http), { api_key: key }).catch((e) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe("config");
      expect((err as ConnectorError).field).toBe("api_key");
    }
    expect(p.seen).toHaveLength(0);
  });

  it("checks every permission without making anything, adds its webhook, and drops the one it added before once the new one is kept", async () => {
    const p = stripeAccount();
    const c = await stripeConnector().connect?.(connectContext(p.http), { api_key: STRIPE_LIVE_KEY });
    expect(c).toMatchObject({
      account: `Live · key ending ${STRIPE_LIVE_KEY.slice(-4)}`,
      externalId: "stripe:live",
      mode: "live",
      secret: { api_key: STRIPE_LIVE_KEY, webhook_secret: STRIPE_WEBHOOK_SECRET },
      extra: { webhook: "added", endpoint_id: STRIPE_ENDPOINT_CREATED.id, hook_url: `${HOOK}/stripe` },
      calendars: [],
      destinations: [],
    });
    expect(p.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "GET /v1/payment_links",
      "POST /v1/payment_links",
      "POST /v1/products",
      "POST /v1/prices",
      "GET /v1/checkout/sessions",
      "GET /v1/webhook_endpoints",
      "POST /v1/webhook_endpoints",
    ]);
    // Every call names the API version the inbox reads, and so does its webhook.
    for (const call of p.seen) expect(call.headers.get("stripe-version")).toBe(STRIPE_VERSION);
    // The probes carry nothing: Stripe makes nothing from them.
    for (const probe of p.seen.slice(1, 4)) expect(probe.body).toBe("");
    const made = form(p.seen[6]?.body ?? "");
    expect(made.get("url")).toBe(`${HOOK}/stripe`);
    expect(made.getAll("enabled_events[]")).toEqual([...STRIPE_EVENTS]);
    expect(made.get("api_version")).toBe(STRIPE_VERSION);
    expect(made.get("metadata[sdi_inbox]")).toBe(INBOX_ID);
    // The one it added before goes only once the new connection is kept.
    await c?.settle?.(true);
    expect(p.seen.at(-1)).toMatchObject({ method: "DELETE" });
    expect(p.seen.at(-1)?.url).toContain(`/v1/webhook_endpoints/${STRIPE_OLD_ENDPOINTS.data[0]?.id}`);
    // Another system's endpoint in the same account is never touched.
    expect(p.seen.some((s) => s.url.includes(STRIPE_OLD_ENDPOINTS.data[1]?.id ?? "-"))).toBe(false);
  });

  it("names every permission the key lacks at once", async () => {
    const p = stripeAccount({ forbid: ["prices", "sessions"] });
    const err = await stripeConnector()
      .connect?.(connectContext(p.http), { api_key: STRIPE_LIVE_KEY })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).message).toBe(
      "The Stripe key is missing Prices: Write and Checkout Sessions: Read. Edit the key in Stripe and connect again.",
    );
    expect(p.seen.some((s) => s.method === "POST" && s.url.endsWith("/v1/webhook_endpoints"))).toBe(false);
  });

  it("without webhook access, says to add it by hand; with the signing secret, takes the webhook as given", async () => {
    const p = stripeAccount({ forbid: ["webhooks"] });
    const err = await stripeConnector()
      .connect?.(connectContext(p.http), { api_key: STRIPE_LIVE_KEY })
      .catch((e) => e);
    expect((err as ConnectorError).message).toContain("paste its signing secret under More options");
    const q = stripeAccount({ forbid: ["webhooks"] });
    const c = await stripeConnector().connect?.(connectContext(q.http), {
      api_key: STRIPE_LIVE_KEY,
      webhook_secret: STRIPE_WEBHOOK_SECRET,
    });
    expect(c?.extra).toEqual({ webhook: "by_hand" });
    expect(c?.secret.webhook_secret).toBe(STRIPE_WEBHOOK_SECRET);
    expect(q.seen.some((s) => s.url.includes("/v1/webhook_endpoints"))).toBe(false);
  });

  it("a key Stripe does not take is an auth failure on the key's field; a test key is test mode", async () => {
    const p = stripeAccount({ key: STRIPE_TEST_KEY });
    const err = await stripeConnector()
      .connect?.(connectContext(p.http), { api_key: STRIPE_LIVE_KEY })
      .catch((e) => e);
    expect((err as ConnectorError).code).toBe("auth");
    const c = await stripeConnector().connect?.(connectContext(p.http), { api_key: STRIPE_TEST_KEY });
    expect(c).toMatchObject({ externalId: "stripe:test", mode: "test", account: `Test mode · key ending wxyz` });
  });

  it("will not connect an inbox that does not know its public address", async () => {
    const p = stripeAccount();
    const err = await stripeConnector()
      .connect?.(connectContext(p.http, { hookUrl: null }), { api_key: STRIPE_LIVE_KEY })
      .catch((e) => e);
    expect((err as ConnectorError).code).toBe("config");
    expect((err as ConnectorError).message).toContain("PUBLIC_URL");
  });
});

describe("Stripe: pay links", () => {
  const ctx = (http: RunContext["http"]) =>
    runContext(http, { secret: { api_key: STRIPE_LIVE_KEY, webhook_secret: STRIPE_WEBHOOK_SECRET } });

  it("makes a price and a one-payment link, each under an idempotency key from the inbox's own id", async () => {
    const p = stripeAccount();
    const link = await stripeConnector().payments?.createLink(ctx(p.http), REQUEST);
    expect(link).toEqual({ externalId: STRIPE_PAYMENT_LINK.id, url: STRIPE_PAYMENT_LINK.url });
    const [price, made] = p.seen;
    expect(price?.headers.get("idempotency-key")).toBe(`sdi-${REQUEST.ref}-price`);
    expect(Object.fromEntries(form(price?.body ?? ""))).toEqual({
      currency: "eur",
      unit_amount: "4500",
      "product_data[name]": "Colour and cut (4F2K9Q)",
      "product_data[metadata][sdi_item]": REQUEST.itemId,
      "metadata[sdi_ref]": REQUEST.ref,
    });
    expect(made?.headers.get("idempotency-key")).toBe(`sdi-${REQUEST.ref}-link`);
    expect(made?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(form(made?.body ?? ""))).toEqual({
      "line_items[0][price]": STRIPE_PRICE.id,
      "line_items[0][quantity]": "1",
      "restrictions[completed_sessions][limit]": "1",
      submit_type: "pay",
      "metadata[sdi_ref]": REQUEST.ref,
      "metadata[sdi_item]": REQUEST.itemId,
      "metadata[sdi_inbox]": INBOX_ID,
      "payment_intent_data[metadata][sdi_ref]": REQUEST.ref,
      "payment_intent_data[metadata][sdi_item]": REQUEST.itemId,
      "after_completion[type]": "hosted_confirmation",
      "after_completion[hosted_confirmation][custom_message]": REQUEST.thanks,
      inactive_message: REQUEST.inactive,
    });
    // Nothing about the customer goes to Stripe from here: no name, no email.
    expect(made?.body).not.toContain("%40");
  });

  it("says a refusal an owner meets plainly, any other in Stripe's words, and a missing permission by name", async () => {
    const small = fakePlatform(() => json(STRIPE_AMOUNT_TOO_SMALL, 400));
    const err = await stripeConnector()
      .payments?.createLink(ctx(small.http), REQUEST)
      .catch((e) => e);
    expect((err as ConnectorError).code).toBe("refused");
    expect((err as ConnectorError).message).toBe(
      "Stripe takes payments of €0.50 or more. Ask for payment another way.",
    );
    const odd = fakePlatform(() =>
      json({ error: { code: "parameter_invalid", message: "Invalid currency: xxx" } }, 400),
    );
    const said = await stripeConnector()
      .payments?.createLink(ctx(odd.http), REQUEST)
      .catch((e) => e);
    expect((said as ConnectorError).message).toBe("Stripe said: Invalid currency: xxx");
    const p = stripeAccount({ forbid: ["prices"] });
    const no = await stripeConnector()
      .payments?.createLink(ctx(p.http), REQUEST)
      .catch((e) => e);
    expect((no as ConnectorError).code).toBe("config");
    expect((no as ConnectorError).message).toContain("Prices: Write");
  });

  it("closes a link by switching it off; one Stripe no longer has is gone already", async () => {
    const p = stripeAccount();
    await stripeConnector().payments?.closeLink(ctx(p.http), { externalId: STRIPE_PAYMENT_LINK.id });
    expect(p.seen[0]?.method).toBe("POST");
    expect(p.seen[0]?.body).toBe("active=false");
    const gone = await stripeConnector()
      .payments?.closeLink(ctx(p.http), { externalId: "plink_gone" })
      .catch((e) => e);
    expect((gone as ConnectorError).code).toBe("not_found");
  });

  it("finds a payment a webhook never told of, by the link's own checkouts", async () => {
    const p = stripeAccount();
    const facts = await stripeConnector().payments?.check(ctx(p.http), {
      ref: REQUEST.ref,
      externalId: STRIPE_PAYMENT_LINK.id,
      itemId: REQUEST.itemId,
    });
    expect(new URL(p.seen[0]?.url ?? "").searchParams.get("payment_link")).toBe(STRIPE_PAYMENT_LINK.id);
    expect(facts).toMatchObject([
      { status: "paid", linkId: STRIPE_PAYMENT_LINK.id, amount: { value: 4500, currency: "EUR" } },
    ]);
  });

  it("sees every paid checkout on a link: a second one is not missed", async () => {
    const two = fakePlatform((r) =>
      r.url.includes("/v1/checkout/sessions?")
        ? json({
            ...STRIPE_EMPTY_LIST("/v1/checkout/sessions"),
            data: [
              stripeSession(),
              { ...stripeSession({ id: "cs_live_second" }), payment_intent: "pi_second" },
              stripeSession({ id: "cs_live_open", paymentStatus: "unpaid" }),
            ],
          })
        : undefined,
    );
    const facts = await stripeConnector().payments?.check(ctx(two.http), {
      ref: REQUEST.ref,
      externalId: STRIPE_PAYMENT_LINK.id,
      itemId: REQUEST.itemId,
    });
    expect(facts?.map((f) => f.paymentId)).toEqual(["pi_3QaZAeLkdIwHu7ix1cDe4500", "pi_second"]);
  });
});

describe("Stripe: what a webhook says", () => {
  const ctx = (http: RunContext["http"]) =>
    runContext(http, { secret: { api_key: STRIPE_LIVE_KEY, webhook_secret: STRIPE_WEBHOOK_SECRET } });
  const completed = JSON.stringify(stripeEvent("checkout.session.completed", stripeSession()));

  it("checks the signature, then reads the checkout back from Stripe before saying it was paid", async () => {
    const p = stripeAccount();
    const r = await stripeConnector().payments?.receive(ctx(p.http), await signedStripe(completed), noLookup);
    expect(r).toEqual({
      eventId: "evt_1QaZAfLkdIwHu7ixPaid0001",
      topic: "checkout.session.completed",
      facts: [
        {
          status: "paid",
          linkId: STRIPE_PAYMENT_LINK.id,
          ref: "01JC0PAYREF0000000000000001",
          paymentId: "pi_3QaZAeLkdIwHu7ix1cDe4500",
          amount: { value: 4500, currency: "EUR" },
          dashboardUrl: "https://dashboard.stripe.com/payments/pi_3QaZAeLkdIwHu7ix1cDe4500",
          livemode: true,
        },
      ],
    });
    expect(p.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      `GET /v1/checkout/sessions/${stripeSession().id}`,
    ]);
    // The customer's details in the event are never part of what is kept.
    expect(JSON.stringify(r)).not.toContain("rita@example.com");
  });

  it("refuses a body with no signature, a wrong one, or an old one, and takes either signature while a secret rolls", async () => {
    const p = stripeAccount();
    const pay = stripeConnector().payments;
    const bare: InboundRequest = { headers: new Headers(), body: completed, query: new URLSearchParams() };
    for (const req of [
      bare,
      await signedStripe(completed, { secret: "whsec_someone_else_00000000000000" }),
      await signedStripe(completed, { at: NOW - 301_000 }),
      await signedStripe(`${completed} `),
    ]) {
      const tampered = req.body === `${completed} ` ? { ...req, body: completed } : req;
      const err = await pay?.receive(ctx(p.http), tampered, noLookup).catch((e) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe("refused");
    }
    expect(p.seen).toHaveLength(0);
    const rolled = await signedStripe(completed, { extra: "deadbeef".repeat(8) });
    expect((await pay?.receive(ctx(p.http), rolled, noLookup))?.facts[0]?.status).toBe("paid");
  });

  it("believes Stripe, never the body: a checkout the body calls paid that Stripe holds unpaid stays waiting", async () => {
    const p = fakePlatform((r) =>
      r.url.includes("/v1/checkout/sessions/") ? json(stripeSession({ paymentStatus: "unpaid" })) : undefined,
    );
    const r = await stripeConnector().payments?.receive(ctx(p.http), await signedStripe(completed), noLookup);
    expect(r?.facts[0]?.status).toBe("pending");
  });

  it("leaves alone, without a call, a checkout that is not from a link this inbox made", async () => {
    const p = stripeAccount();
    for (const session of [stripeSession({ paymentLink: null }), stripeSession({ inbox: "another-inbox" })]) {
      const body = JSON.stringify(stripeEvent("checkout.session.completed", session));
      expect(await stripeConnector().payments?.receive(ctx(p.http), await signedStripe(body), noLookup)).toBeNull();
    }
    const other = JSON.stringify({
      ...stripeEvent("checkout.session.completed", stripeSession()),
      type: "charge.refunded",
    });
    expect(await stripeConnector().payments?.receive(ctx(p.http), await signedStripe(other), noLookup)).toBeNull();
    expect(p.seen).toHaveLength(0);
  });

  it("a delayed payment that failed says so", async () => {
    const p = fakePlatform((r) =>
      r.url.includes("/v1/checkout/sessions/") ? json(stripeSession({ paymentStatus: "unpaid" })) : undefined,
    );
    const body = JSON.stringify(
      stripeEvent("checkout.session.async_payment_failed", stripeSession({ paymentStatus: "unpaid" })),
    );
    const r = await stripeConnector().payments?.receive(ctx(p.http), await signedStripe(body), noLookup);
    expect(r?.facts[0]?.status).toBe("failed");
  });

  it("every few hours, moves the webhook it added to where the inbox is now, and says when it was removed", async () => {
    const at = (url: string) =>
      fakePlatform((r) => {
        const path = new URL(r.url).pathname;
        if (path === "/v1/payment_links") return json(STRIPE_EMPTY_LIST("/v1/payment_links"));
        if (path === "/v1/webhook_endpoints/we_1Ours" && r.method === "GET") {
          return url
            ? json({ ...STRIPE_ENDPOINT_CREATED, id: "we_1Ours", url, secret: undefined })
            : json({ error: { message: "No such webhook endpoint" } }, 404);
        }
        if (path === "/v1/webhook_endpoints/we_1Ours" && r.method === "POST")
          return json({ id: "we_1Ours", url: form(r.body).get("url") });
        return undefined;
      });
    const ctx = (http: RunContext["http"]) =>
      runContext(http, {
        hookUrl: "https://inbox.anas-salon.example/v1/hooks/stripe",
        secret: { api_key: STRIPE_LIVE_KEY },
        extra: { webhook: "added", endpoint_id: "we_1Ours" },
      });
    const moved = at("https://ana-setup.inbox-host.example/v1/hooks/stripe");
    const before = ctx(moved.http);
    const stale = {
      ...before,
      extra: { ...before.extra, hook_url: "https://ana-setup.inbox-host.example/v1/hooks/stripe" },
    };
    // The address moved since: it is read again before the usual six hours.
    expect(stripeConnector().stale?.(stale)).toBe(true);
    expect(await stripeConnector().refresh?.(stale)).toMatchObject({
      account: expect.stringContaining("Live"),
      extra: { hook_url: "https://inbox.anas-salon.example/v1/hooks/stripe" },
    });
    expect(moved.seen.at(-1)?.method).toBe("POST");
    expect(form(moved.seen.at(-1)?.body ?? "").get("url")).toBe("https://inbox.anas-salon.example/v1/hooks/stripe");
    const same = at("https://inbox.anas-salon.example/v1/hooks/stripe");
    await stripeConnector().refresh?.(ctx(same.http));
    expect(same.seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    const gone = at("");
    const err = await stripeConnector()
      .refresh?.(ctx(gone.http))
      .catch((e) => e);
    expect((err as ConnectorError).code).toBe("config");
    expect((err as ConnectorError).message).toContain("was removed");
  });

  it("on disconnect, takes away the webhook it added, and only that", async () => {
    const p = fakePlatform((r) => (r.method === "DELETE" ? json({ deleted: true }) : undefined));
    await stripeConnector().disconnect?.(
      runContext(p.http, {
        secret: { api_key: STRIPE_LIVE_KEY },
        extra: { webhook: "added", endpoint_id: "we_1Ours" },
      }),
    );
    await stripeConnector().disconnect?.(
      runContext(p.http, { secret: { api_key: STRIPE_LIVE_KEY }, extra: { webhook: "by_hand" } }),
    );
    expect(p.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "DELETE /v1/webhook_endpoints/we_1Ours",
    ]);
  });
});

/* --- Mollie --------------------------------------------------------------------- */

function mollieAccount(opts: { key?: string; payments?: Parameters<typeof mollieLinkPayments>[0] } = {}) {
  const key = opts.key ?? MOLLIE_LIVE_KEY;
  return fakePlatform((r) => {
    const url = new URL(r.url);
    if (url.host !== "api.mollie.com") return undefined;
    if (r.headers.get("authorization") !== `Bearer ${key}`) return json(MOLLIE_UNAUTHORIZED, 401);
    const route = `${r.method} ${url.pathname}`;
    if (route === "GET /v2/profiles/me") return json(MOLLIE_PROFILE);
    if (route === "POST /v2/payment-links") {
      const body = JSON.parse(r.body) as { amount: { value: string; currency: string }; webhookUrl: string };
      return json(
        molliePaymentLink({ value: body.amount.value, currency: body.amount.currency, webhookUrl: body.webhookUrl }),
        201,
      );
    }
    if (route === "PATCH /v2/payment-links/pl_4Y0eZitmBnQ6IDoMqZQKh")
      return json({ ...molliePaymentLink(), archived: true });
    if (route === "GET /v2/payment-links/pl_4Y0eZitmBnQ6IDoMqZQKh/payments") {
      return json(mollieLinkPayments(opts.payments ?? [{}]));
    }
    return undefined;
  });
}

describe("Mollie: connecting the profile's API key", () => {
  it("knows the profile by its id and mode, and is told of payments by each link's own webhook", async () => {
    const p = mollieAccount();
    const c = await mollieConnector().connect?.(connectContext(p.http, { hookUrl: `${HOOK}/mollie` }), {
      api_key: MOLLIE_LIVE_KEY,
    });
    expect(c).toMatchObject({
      account: "Ana's Salon",
      externalId: "pfl_QkEhN94Ba:live",
      mode: "live",
      secret: { api_key: MOLLIE_LIVE_KEY },
      extra: { webhook: "per_link", profile_id: "pfl_QkEhN94Ba", profile_status: "verified" },
    });
    expect(p.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(["GET /v2/profiles/me"]);
  });

  it("asks only for the API key: a signing secret is taken through the API for a signed webhook, never drawn in the form", async () => {
    expect(describeForm(mollieConnector().form as never).map((f) => f.key)).toEqual(["api_key"]);
    expect(describeForm(mollieConnector().form as never)[0]).toMatchObject({
      placeholder: "live_… or test_…",
      byMode: { live: "live_…", test: "test_…" },
    });
    expect(mollieConnector().modeOf?.({ api_key: MOLLIE_TEST_KEY })).toBe("test");
    expect(mollieConnector().modeOf?.({ api_key: "access_x" })).toBeNull();
  });

  it("keeps a signing secret when the owner added a signed webhook; a test key is test mode", async () => {
    const p = mollieAccount({ key: MOLLIE_TEST_KEY });
    const c = await mollieConnector().connect?.(connectContext(p.http, { hookUrl: `${HOOK}/mollie` }), {
      api_key: MOLLIE_TEST_KEY,
      webhook_secret: MOLLIE_SIGNING_SECRET,
    });
    expect(c).toMatchObject({ mode: "test", account: "Ana's Salon · test mode", extra: { webhook: "by_hand" } });
    expect(c?.secret.webhook_secret).toBe(MOLLIE_SIGNING_SECRET);
  });

  it("refuses an access token and a key Mollie does not take", async () => {
    const p = mollieAccount();
    const token = await mollieConnector()
      .connect?.(connectContext(p.http), { api_key: `access_${"a".repeat(30)}` })
      .catch((e) => e);
    expect((token as ConnectorError).code).toBe("config");
    expect(p.seen).toHaveLength(0);
    const wrong = await mollieConnector()
      .connect?.(connectContext(p.http), { api_key: MOLLIE_TEST_KEY })
      .catch((e) => e);
    expect((wrong as ConnectorError).code).toBe("auth");
  });
});

describe("Mollie: pay links", () => {
  const ctx = (http: RunContext["http"], secret: Record<string, string> = { api_key: MOLLIE_LIVE_KEY }) =>
    runContext(http, { secret, hookUrl: `${HOOK}/mollie` });

  it("makes a one-payment link for the amount in Mollie's decimals, naming its own webhook", async () => {
    const p = mollieAccount();
    const link = await mollieConnector().payments?.createLink(ctx(p.http), REQUEST);
    expect(link).toEqual({
      externalId: "pl_4Y0eZitmBnQ6IDoMqZQKh",
      url: "https://payment-links.mollie.com/payment/4Y0eZitmBnQ6IDoMqZQKh",
    });
    expect(p.seen[0]?.headers.get("idempotency-key")).toBe(`sdi-${REQUEST.ref}`);
    expect(JSON.parse(p.seen[0]?.body ?? "{}")).toEqual({
      description: "Colour and cut (4F2K9Q)",
      amount: { currency: "EUR", value: "45.00" },
      webhookUrl: `${HOOK}/mollie?ref=${REQUEST.ref}`,
      reusable: false,
    });
    await mollieConnector().payments?.createLink(ctx(p.http), { ...REQUEST, amount: { value: 1205, currency: "USD" } });
    expect(JSON.parse(p.seen[1]?.body ?? "{}").amount).toEqual({ currency: "USD", value: "12.05" });
  });

  it("says Mollie's refusal in Mollie's words, and archives a link that is no longer wanted", async () => {
    const no = fakePlatform(() => json(MOLLIE_UNPROCESSABLE, 422));
    const err = await mollieConnector()
      .payments?.createLink(ctx(no.http), REQUEST)
      .catch((e) => e);
    expect((err as ConnectorError).code).toBe("refused");
    expect((err as ConnectorError).message).toBe("Mollie said: The amount is lower than the minimum");
    const p = mollieAccount();
    await mollieConnector().payments?.closeLink(ctx(p.http), { externalId: "pl_4Y0eZitmBnQ6IDoMqZQKh" });
    expect(p.seen[0]?.method).toBe("PATCH");
    expect(JSON.parse(p.seen[0]?.body ?? "{}")).toEqual({ archived: true });
  });
});

describe("Mollie: what a webhook says", () => {
  const ctx = (http: RunContext["http"], secret: Record<string, string> = { api_key: MOLLIE_LIVE_KEY }) =>
    runContext(http, { secret, hookUrl: `${HOOK}/mollie` });
  const known: KnownLink = { ref: REQUEST.ref, externalId: "pl_4Y0eZitmBnQ6IDoMqZQKh", itemId: REQUEST.itemId };
  const perLink = (body = "id=tr_5B8cwPMGnU", ref: string | null = REQUEST.ref): InboundRequest => ({
    headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
    body,
    query: new URLSearchParams(ref ? { ref } : {}),
  });

  it("an unsigned per-link webhook is only a nudge: what was paid is asked of Mollie for the link the address names", async () => {
    const p = mollieAccount();
    const lookups: string[] = [];
    const r = await mollieConnector().payments?.receive(ctx(p.http), perLink(), async (ref) => {
      lookups.push(ref);
      return known;
    });
    expect(lookups).toEqual([REQUEST.ref]);
    expect(r).toEqual({
      eventId: "tr_5B8cwPMGnU:paid",
      topic: "payment-link.payment",
      facts: [
        {
          status: "paid",
          linkId: "pl_4Y0eZitmBnQ6IDoMqZQKh",
          ref: REQUEST.ref,
          paymentId: "tr_5B8cwPMGnU",
          amount: { value: 4500, currency: "EUR" },
          method: "ideal",
          paidAt: Date.parse("2026-10-18T09:31:42+00:00"),
          dashboardUrl: "https://my.mollie.com/dashboard/org_12345678/payments/tr_5B8cwPMGnU",
          livemode: true,
        },
      ],
    });
    // The customer's bank details in Mollie's answer are not part of what is kept.
    expect(JSON.stringify(r)).not.toContain("NL55");
  });

  it("whatever the body says, nothing is paid until Mollie says so; an address naming no link of ours is let go without a call", async () => {
    const open = mollieAccount({ payments: [{ status: "open" }, { id: "tr_failed", status: "failed" }] });
    expect(
      await mollieConnector().payments?.receive(
        ctx(open.http),
        perLink("id=tr_5B8cwPMGnU&status=paid"),
        async () => known,
      ),
    ).toBeNull();
    const p = mollieAccount();
    expect(await mollieConnector().payments?.receive(ctx(p.http), perLink(), async () => null)).toBeNull();
    expect(
      await mollieConnector().payments?.receive(ctx(p.http), perLink("id=tr_x", null), async () => known),
    ).toBeNull();
    expect(p.seen).toHaveLength(0);
  });

  it("a signed webhook is checked by its signature and then read back the same way", async () => {
    const p = mollieAccount();
    const body = JSON.stringify(mollieLinkPaidEvent());
    const sig = await hmacSha256Hex(MOLLIE_SIGNING_SECRET, body);
    const signed = (header: string): InboundRequest => ({
      headers: new Headers({ "x-mollie-signature": header, "content-type": "application/json" }),
      body,
      query: new URLSearchParams(),
    });
    const withSecret = ctx(p.http, { api_key: MOLLIE_LIVE_KEY, webhook_secret: MOLLIE_SIGNING_SECRET });
    const r = await mollieConnector().payments?.receive(withSecret, signed(`sha256=${sig}`), noLookup);
    expect(r).toMatchObject({
      eventId: "event_GvJ8WHrp5isUdRub9CJyH",
      topic: "payment-link.paid",
      facts: [{ status: "paid", linkId: "pl_4Y0eZitmBnQ6IDoMqZQKh", ref: null, paymentId: "tr_5B8cwPMGnU" }],
    });
    expect(p.seen.map((s) => new URL(s.url).pathname)).toEqual(["/v2/payment-links/pl_4Y0eZitmBnQ6IDoMqZQKh/payments"]);
    // During a secret rotation two values travel; either may be the one.
    const rotated = await mollieConnector().payments?.receive(
      withSecret,
      signed(`sha256=${"0".repeat(64)}, sha256=${sig}`),
      noLookup,
    );
    expect(rotated?.facts).toHaveLength(1);
    for (const [c, h] of [
      [withSecret, `sha256=${"0".repeat(64)}`],
      [ctx(p.http), `sha256=${sig}`],
    ] as const) {
      const err = await mollieConnector()
        .payments?.receive(c, signed(h), noLookup)
        .catch((e) => e);
      expect((err as ConnectorError).code).toBe("refused");
    }
  });
});

/* --- the fixes after review ---------------------------------------------------- */

describe("Stripe: a key replaced, a webhook kept honest", () => {
  it("asks for the key with the rows to tick on Stripe's page, for either mode", () => {
    const [key] = describeForm(stripeForm as never);
    expect(key).toMatchObject({
      placeholder: "rk_live_… or rk_test_…",
      byMode: { live: "rk_live_…", test: "rk_test_…" },
      steps: [
        "Payment Links · Write",
        "Products · Write",
        "Prices · Write",
        "Webhook Endpoints · Write",
        "Checkout Sessions · Read",
      ],
    });
    expect(key?.help).toBe("In Stripe: Developers → API keys → Create restricted key, then set:");
    expect(stripeConnector().modeOf?.({ api_key: STRIPE_TEST_KEY })).toBe("test");
    expect(stripeConnector().modeOf?.({ api_key: STRIPE_LIVE_KEY })).toBe("live");
    expect(stripeConnector().modeOf?.({ api_key: "nonsense" })).toBeNull();
  });

  it("refused after all, takes away the webhook it just added and leaves the working one alone", async () => {
    const p = stripeAccount();
    const c = await stripeConnector().connect?.(connectContext(p.http), { api_key: STRIPE_LIVE_KEY });
    const before = p.seen.length;
    await c?.settle?.(false);
    const after = p.seen.slice(before).map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(after).toEqual([`DELETE /v1/webhook_endpoints/${STRIPE_ENDPOINT_CREATED.id}`]);
  });

  it("connected again with a signing secret by hand, takes away the webhook it had added itself", async () => {
    const p = stripeAccount({ forbid: ["webhooks"] });
    const ctx = {
      ...connectContext(p.http),
      previous: { externalId: "stripe:live", extra: { webhook: "added", endpoint_id: "we_1Before" } },
    };
    const c = await stripeConnector().connect?.(ctx, {
      api_key: STRIPE_LIVE_KEY,
      webhook_secret: STRIPE_WEBHOOK_SECRET,
    });
    expect(c?.extra).toEqual({ webhook: "by_hand" });
    expect(p.seen.some((r) => r.method === "DELETE")).toBe(false);
    await c?.settle?.(true);
    expect(p.seen.at(-1)).toMatchObject({ method: "DELETE" });
    expect(p.seen.at(-1)?.url).toContain("/v1/webhook_endpoints/we_1Before");
  });

  it("before the inbox is live adds no webhook (it would fail), and adds it on the first sync once it is", async () => {
    const p = stripeAccount();
    const c = await stripeConnector().connect?.(connectContext(p.http, { hooksLive: false }), {
      api_key: STRIPE_LIVE_KEY,
    });
    expect(c?.extra).toEqual({ webhook: "pending" });
    expect(c?.secret).toEqual({ api_key: STRIPE_LIVE_KEY });
    expect(p.seen.some((r) => r.method === "POST" && r.url.endsWith("/v1/webhook_endpoints"))).toBe(false);
    // Still not live: nothing to do. Live: it is added, and its signing secret sealed.
    const saved: Record<string, string>[] = [];
    const run = (hooksLive: boolean) =>
      runContext(p.http, {
        hooksLive,
        secret: { api_key: STRIPE_LIVE_KEY },
        extra: { webhook: "pending" },
        saveSecret: async (next) => void saved.push({ ...next }),
      });
    expect(stripeConnector().stale?.(run(false))).toBe(false);
    expect(stripeConnector().stale?.(run(true))).toBe(true);
    const fresh = await stripeConnector().refresh?.(run(true));
    expect(fresh?.extra).toEqual({
      webhook: "added",
      endpoint_id: STRIPE_ENDPOINT_CREATED.id,
      hook_url: `${HOOK}/stripe`,
    });
    expect(saved).toEqual([{ api_key: STRIPE_LIVE_KEY, webhook_secret: STRIPE_WEBHOOK_SECRET }]);
  });

  it("switches its webhook on again when Stripe switched it off, and looks at it every sync while a link waits", async () => {
    const p = fakePlatform((r) => {
      const path = new URL(r.url).pathname;
      if (path === "/v1/payment_links") return json(STRIPE_EMPTY_LIST("/v1/payment_links"));
      if (path === "/v1/webhook_endpoints/we_1Ours" && r.method === "GET")
        return json({
          ...STRIPE_ENDPOINT_CREATED,
          id: "we_1Ours",
          url: `${HOOK}/stripe`,
          status: "disabled",
          secret: undefined,
        });
      if (path === "/v1/webhook_endpoints/we_1Ours" && r.method === "POST")
        return json({ id: "we_1Ours", status: "enabled" });
      return undefined;
    });
    const ctx = runContext(p.http, {
      secret: { api_key: STRIPE_LIVE_KEY },
      extra: { webhook: "added", endpoint_id: "we_1Ours", hook_url: `${HOOK}/stripe` },
    });
    expect(stripeConnector().stale?.(ctx, { openLinks: false })).toBe(false);
    expect(stripeConnector().stale?.(ctx, { openLinks: true })).toBe(true);
    await stripeConnector().refresh?.(ctx);
    const on = p.seen.at(-1);
    expect(on?.method).toBe("POST");
    expect(Object.fromEntries(form(on?.body ?? ""))).toEqual({ url: `${HOOK}/stripe`, disabled: "false" });
  });
});

describe("Mollie: how it was paid, in the network's words; refunds made in the dashboard", () => {
  const ctx = (http: RunContext["http"]) =>
    runContext(http, { secret: { api_key: MOLLIE_LIVE_KEY }, hookUrl: `${HOOK}/mollie` });
  const known: KnownLink = { ref: REQUEST.ref, externalId: "pl_4Y0eZitmBnQ6IDoMqZQKh", itemId: REQUEST.itemId };

  it("names each method as the payment-methods data does, and drops one with no word of its own", async () => {
    expect(MOLLIE_METHODS).toMatchObject({
      creditcard: "card",
      banktransfer: "sepa",
      directdebit: "sepa",
      klarnapaylater: "klarna",
      mbway: "mb_way",
      applepay: "apple_pay",
    });
    const p = mollieAccount({
      payments: [
        { id: "tr_bank", method: "banktransfer" },
        { id: "tr_odd", method: "voucher" },
        { id: "tr_open", status: "open" },
      ],
    });
    const facts = await mollieConnector().payments?.check(ctx(p.http), known);
    expect(facts?.map((f) => [f.paymentId, f.method])).toEqual([
      ["tr_bank", "sepa"],
      ["tr_odd", undefined],
    ]);
  });

  it("a second payment on a link is its own event", async () => {
    const one = mollieAccount({ payments: [{ id: "tr_first" }] });
    const two = mollieAccount({ payments: [{ id: "tr_first" }, { id: "tr_second" }] });
    const nudge: InboundRequest = {
      headers: new Headers(),
      body: "id=tr_second",
      query: new URLSearchParams({ ref: REQUEST.ref }),
    };
    const a = await mollieConnector().payments?.receive(ctx(one.http), nudge, async () => known);
    const b = await mollieConnector().payments?.receive(ctx(two.http), nudge, async () => known);
    expect(a?.eventId).toBe("tr_first:paid");
    expect(b?.eventId).toBe("tr_first,tr_second:paid");
    expect(b?.facts).toHaveLength(2);
  });

  it("reads what was refunded of a payment, counting only refunds that were made", async () => {
    const p = fakePlatform((r) =>
      new URL(r.url).pathname === "/v2/payments/tr_5B8cwPMGnU/refunds"
        ? json({
            count: 3,
            _embedded: {
              refunds: [
                {
                  resource: "refund",
                  id: "re_1",
                  status: "refunded",
                  amount: { value: "20.00", currency: "EUR" },
                  createdAt: "2026-10-19T09:00:00+00:00",
                },
                {
                  resource: "refund",
                  id: "re_2",
                  status: "pending",
                  amount: { value: "25.00", currency: "EUR" },
                  createdAt: "2026-10-20T09:00:00+00:00",
                },
                {
                  resource: "refund",
                  id: "re_3",
                  status: "failed",
                  amount: { value: "45.00", currency: "EUR" },
                  createdAt: "2026-10-21T09:00:00+00:00",
                },
              ],
            },
          })
        : undefined,
    );
    const r = await mollieConnector().payments?.refunded?.(ctx(p.http), { paymentId: "tr_5B8cwPMGnU" });
    expect(r).toEqual({ amount: { value: 4500, currency: "EUR" }, refundIds: ["re_2", "re_1"] });
    expect(await mollieConnector().payments?.refunded?.(ctx(p.http), { paymentId: "pi_not_mollie" })).toBeNull();
    // Stripe's restricted key asks for no refunds: it does not read them.
    expect(stripeConnector().payments?.refunded).toBeUndefined();
  });
});
