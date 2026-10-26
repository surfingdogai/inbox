import { hmacSha256Hex } from "@surfingdog/adapters";
import {
  MOLLIE_PROFILE,
  mollieLinkPayments,
  STRIPE_AMOUNT_TOO_SMALL,
  STRIPE_EMPTY_LIST,
  STRIPE_INVALID_KEY,
  STRIPE_MISSING_PARAM,
  STRIPE_PERMISSION_ERROR,
  stripeCardDeclined,
  stripeEvent,
  stripePaymentIntent,
  stripeSession,
  stripeTokenRefused,
} from "../../../packages/adapters/test/fixtures/payments";

/**
 * Stripe and Mollie as fakes at the fetch level that keep state as the real ones do (ADR-023): for
 * the payments tests, and for screenshots of the owner app. Never a real account.
 */

export interface StripeLink {
  id: string;
  url: string;
  active: boolean;
  amount: number;
  currency: string;
  meta: Record<string, string>;
  /** What the customer reads on Stripe's page: the product's name, the thanks, and the closed link's line. */
  name: string;
  thanks: string;
  inactive: string;
  /** The words on Stripe's button: pay, or book for a booking's deposit (ADR-036). */
  submit: string;
}

/**
 * A Shared Payment Token an assistant's platform got for the business (ADR-042), as Stripe holds it:
 * granted to a profile, in a mode, with its limits, and what charging it does (a card that pays, one
 * that is declined, one that asks its holder to confirm, a payment that settles later).
 */
export interface GrantedToken {
  profile: string;
  livemode: boolean;
  currency: string;
  maxAmount: number;
  expiresAt: number;
  outcome: "succeeded" | "processing" | "requires_action" | "declined" | "authentication_required";
  deactivated: null | "consumed" | "revoked" | "expired";
}

/** Stripe, as one account: prices, payment links, checkouts and webhook endpoints, by its rules. */
export function stripePlatform(key: string, base = "https://inbox.example.com") {
  const live = key.includes("_live_");
  /** The key the account takes now: revoked, it takes none. */
  const account = { key };
  const links = new Map<string, StripeLink>();
  const prices = new Map<string, { amount: number; currency: string; name: string }>();
  const sessions = new Map<string, ReturnType<typeof stripeSession>>();
  const endpoints = new Map<
    string,
    { url: string; secret: string; meta: Record<string, string>; status: "enabled" | "disabled" }
  >();
  const idem = new Map<string, unknown>();
  const calls: string[] = [];
  /** What making a price answers for now: Stripe down (500), or a refusal (400); and switching a link off. */
  const outage: { prices: number | null; close: number | null } = { prices: null, close: null };
  /** Whether the key may make card-hold pages and customers (ADR-036): asked only when holds are switched on. */
  const holds: { allowed: boolean } = { allowed: true };
  /**
   * Assistants' payments (ADR-042): the account's profile, whether the key may write PaymentIntents, the
   * tokens platforms got for the profile, the PaymentIntents made from them, and outages.
   */
  /** `lost`: Stripe makes the charge, and the answer never reaches the inbox (a cut connection). */
  const agent: { allowed: boolean; profile: string; down: number | null; lost: boolean } = {
    allowed: true,
    profile: live ? "profile_1FjordLive00001" : "profile_test_1Fjord0001",
    down: null,
    lost: false,
  };
  const tokens = new Map<string, GrantedToken>();
  const intents = new Map<string, ReturnType<typeof stripePaymentIntent>>();
  const answered = new Map<string, { status: number; body: unknown }>();
  let n = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.host !== "api.stripe.com") return new Response("not found", { status: 404 });
    calls.push(`${method} ${url.pathname}`);
    if (headers.get("authorization") !== `Bearer ${account.key}`) return json(STRIPE_INVALID_KEY, 401);
    if (outage.prices !== null && method === "POST" && url.pathname === "/v1/prices" && body) {
      return outage.prices === 400
        ? json(STRIPE_AMOUNT_TOO_SMALL, 400)
        : json(
            { error: { message: "An error occurred with our connection to Stripe.", type: "api_error" } },
            outage.prices,
          );
    }
    const f = new URLSearchParams(body);
    const once = (make: () => unknown) => {
      const k = headers.get("idempotency-key");
      if (k && idem.has(k)) return json(idem.get(k));
      const made = make();
      if (k) idem.set(k, made);
      return json(made);
    };
    const meta = (prefix: string) => {
      const out: Record<string, string> = {};
      for (const [k, v] of f) if (k.startsWith(`${prefix}[`)) out[k.slice(prefix.length + 1, -1)] = v;
      return out;
    };
    const route = `${method} ${url.pathname}`;
    if (route === "GET /v1/payment_links") return json(STRIPE_EMPTY_LIST("/v1/payment_links"));
    if (route === "POST /v1/payment_links" && !body) return json(STRIPE_MISSING_PARAM("line_items"), 400);
    if (route === "POST /v1/products") return json(STRIPE_MISSING_PARAM("name"), 400);
    if (route === "POST /v1/prices" && !body) return json(STRIPE_MISSING_PARAM("currency"), 400);
    if (route === "GET /v1/checkout/sessions") {
      const link = url.searchParams.get("payment_link");
      return json({
        ...STRIPE_EMPTY_LIST("/v1/checkout/sessions"),
        data: [...sessions.values()].filter((s) => !link || s.payment_link === link),
      });
    }
    if (route === "GET /v1/webhook_endpoints") {
      return json({
        ...STRIPE_EMPTY_LIST("/v1/webhook_endpoints"),
        data: [...endpoints].map(([id, e]) => ({ id, object: "webhook_endpoint", url: e.url, metadata: e.meta })),
      });
    }
    if (route === "POST /v1/webhook_endpoints") {
      const id = `we_${++n}`;
      const secret = `whsec_${"s".repeat(10)}${n}${"x".repeat(20)}`;
      endpoints.set(id, { url: f.get("url") ?? "", secret, meta: meta("metadata"), status: "enabled" });
      return json({
        id,
        object: "webhook_endpoint",
        url: f.get("url"),
        secret,
        livemode: live,
        metadata: meta("metadata"),
        enabled_events: f.getAll("enabled_events[]"),
      });
    }
    if (method === "DELETE" && url.pathname.startsWith("/v1/webhook_endpoints/")) {
      endpoints.delete(url.pathname.split("/").at(-1) ?? "");
      return json({ deleted: true });
    }
    if (url.pathname.startsWith("/v1/webhook_endpoints/")) {
      const id = url.pathname.split("/").at(-1) ?? "";
      const e = endpoints.get(id);
      if (!e) return json({ error: { message: "No such webhook endpoint", type: "invalid_request_error" } }, 404);
      if (method === "POST") {
        if (f.get("url")) e.url = f.get("url") ?? e.url;
        if (f.get("disabled") === "false") e.status = "enabled";
      }
      return json({ id, object: "webhook_endpoint", url: e.url, status: e.status, metadata: e.meta });
    }
    if (route === "POST /v1/prices") {
      return once(() => {
        const id = `price_${++n}`;
        prices.set(id, {
          amount: Number(f.get("unit_amount")),
          currency: String(f.get("currency")),
          name: String(f.get("product_data[name]") ?? ""),
        });
        return {
          id,
          object: "price",
          currency: f.get("currency"),
          unit_amount: Number(f.get("unit_amount")),
          livemode: live,
        };
      });
    }
    if (route === "POST /v1/payment_links") {
      return once(() => {
        const id = `plink_${++n}`;
        const price = prices.get(f.get("line_items[0][price]") ?? "");
        const link: StripeLink = {
          id,
          url: `https://buy.stripe.com/${live ? "" : "test_"}link${n}`,
          active: true,
          amount: price?.amount ?? 0,
          currency: price?.currency ?? "eur",
          meta: meta("metadata"),
          name: price?.name ?? "",
          thanks: f.get("after_completion[hosted_confirmation][custom_message]") ?? "",
          inactive: f.get("inactive_message") ?? "",
          submit: f.get("submit_type") ?? "",
        };
        links.set(id, link);
        return { id, object: "payment_link", url: link.url, active: true, livemode: live, metadata: link.meta };
      });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/payment_links/")) {
      if (outage.close !== null)
        return json({ error: { message: "An error occurred.", type: "api_error" } }, outage.close);
      const link = links.get(url.pathname.split("/").at(-1) ?? "");
      if (!link) return json({ error: { message: "No such payment link", type: "invalid_request_error" } }, 404);
      if (f.get("active") === "false") link.active = false;
      return json({ id: link.id, object: "payment_link", active: link.active });
    }
    // Assistants' payments (ADR-042): PaymentIntents from shared payment tokens, in the preview version.
    if (url.pathname === "/v1/payment_intents" || url.pathname.startsWith("/v1/payment_intents/")) {
      if (agent.allowed === false) return json(STRIPE_PERMISSION_ERROR("rak_payment_intent_write"), 403);
      if (headers.get("stripe-version") !== "2026-09-30.preview") {
        return json(
          { error: { type: "invalid_request_error", message: "shared payment tokens need the preview version" } },
          400,
        );
      }
      if (agent.down !== null) return json({ error: { type: "api_error", message: "An error occurred." } }, agent.down);
      const [, , , id, verb] = url.pathname.split("/");
      if (method === "GET" && id === "search") {
        // Stripe's search, for the one query the inbox asks: its own id for an attempt.
        const ref = /metadata\['sdi_pay'\]:'([^']+)'/.exec(url.searchParams.get("query") ?? "")?.[1];
        const data = [...intents.values()].filter((pi) => ref && pi.metadata.sdi_pay === ref);
        return json({ object: "search_result", data, has_more: false, url: "/v1/payment_intents/search" });
      }
      if (method === "GET" && id) {
        const pi = intents.get(id);
        return pi ? json(pi) : json({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
      }
      if (method === "POST" && id && verb === "cancel") {
        const pi = intents.get(id);
        if (!pi) return json({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
        pi.status = "canceled";
        return json(pi);
      }
      if (route !== "POST /v1/payment_intents") return new Response("not found", { status: 404 });
      if (!body) return json(STRIPE_MISSING_PARAM("amount"), 400);
      // An idempotent request is answered as it was the first time, whatever that was.
      const k = headers.get("idempotency-key");
      const seen = k ? answered.get(k) : undefined;
      if (seen) return json(seen.body, seen.status);
      const answer = chargeToken(f);
      if (k) answered.set(k, answer);
      if (agent.lost) return json({ error: { type: "api_error", message: "An error occurred." } }, 502);
      return json(answer.body, answer.status);
    }
    // Card holds (ADR-036): a Checkout Session in setup mode, and a customer probe that makes nothing.
    if (route === "POST /v1/checkout/sessions") {
      if (holds.allowed === false) return json(STRIPE_PERMISSION_ERROR, 403);
      if (!body) return json(STRIPE_MISSING_PARAM("mode"), 400);
      return once(() => {
        const id = `cs_${live ? "live" : "test"}_hold${++n}`;
        const session = {
          id,
          object: "checkout.session",
          mode: f.get("mode"),
          currency: f.get("currency"),
          customer_creation: f.get("customer_creation"),
          expires_at: Number(f.get("expires_at")),
          success_url: f.get("success_url"),
          cancel_url: f.get("cancel_url"),
          submit_type: f.get("submit_type"),
          metadata: meta("metadata"),
          status: "open",
          setup_intent: null as string | null,
          customer: null as string | null,
          livemode: live,
          url: `https://checkout.stripe.com/c/pay/${id}`,
        };
        sessions.set(id, session as unknown as ReturnType<typeof stripeSession>);
        return session;
      });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/customers/")) {
      if (holds.allowed === false) return json(STRIPE_PERMISSION_ERROR, 403);
      return json({ error: { message: "No such customer", type: "invalid_request_error" } }, 404);
    }
    if (method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) {
      const s = sessions.get(url.pathname.split("/").at(-1) ?? "");
      return s ? json(s) : json({ error: { message: "No such checkout.session" } }, 404);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  /** A PaymentIntent from a shared payment token, by Stripe's rules for one (ADR-042). */
  function chargeToken(f: URLSearchParams): { status: number; body: unknown } {
    const spt = f.get("payment_method_data[shared_payment_granted_token]") ?? "";
    const token = tokens.get(spt);
    const amount = Number(f.get("amount"));
    const currency = String(f.get("currency"));
    // Another business's token, another mode's, or none: Stripe knows no such token for this account.
    if (!token || token.profile !== agent.profile || token.livemode !== live) {
      return { status: 400, body: stripeTokenRefused("missing", spt) };
    }
    if (token.deactivated === "consumed") return { status: 400, body: stripeTokenRefused("consumed", spt) };
    if (token.deactivated === "revoked") return { status: 400, body: stripeTokenRefused("revoked", spt) };
    if (token.deactivated === "expired" || token.expiresAt <= Date.now()) {
      return { status: 400, body: stripeTokenRefused("expired", spt) };
    }
    if (token.currency !== currency || amount > token.maxAmount) {
      return { status: 400, body: stripeTokenRefused("limit", spt) };
    }
    const id = `pi_${live ? "" : "test_"}${++n}`;
    const metadata: Record<string, string> = {};
    for (const [k, v] of f) if (k.startsWith("metadata[")) metadata[k.slice(9, -1)] = v;
    if (token.outcome === "declined" || token.outcome === "authentication_required") {
      const declined = stripeCardDeclined(
        token.outcome === "declined" ? "insufficient_funds" : "authentication_required",
        id,
      );
      intents.set(id, {
        ...stripePaymentIntent({ id, amount, currency, status: "requires_payment_method", livemode: live, metadata }),
      });
      return { status: 402, body: declined };
    }
    token.deactivated = "consumed";
    const pi = stripePaymentIntent({ id, amount, currency, status: token.outcome, livemode: live, metadata });
    intents.set(id, pi);
    return { status: 200, body: pi };
  }

  /** An assistant's platform gets a token for the business's profile (Stripe's test helper does the same). */
  function grantToken(o: Partial<GrantedToken> & { maxAmount: number; currency: string }): string {
    const id = `spt_${live ? "" : "test_"}${(++n).toString().padStart(8, "0")}grant`;
    tokens.set(id, {
      profile: agent.profile,
      livemode: live,
      expiresAt: Date.now() + 3_600_000,
      outcome: "succeeded",
      deactivated: null,
      ...o,
    });
    return id;
  }

  /** A payment that was processing settles: paid, or not. */
  function settle(id: string, status: "succeeded" | "requires_payment_method") {
    const pi = intents.get(id);
    if (!pi) throw new Error(`no payment intent ${id}`);
    pi.status = status;
    pi.amount_received = status === "succeeded" ? pi.amount : 0;
  }

  /** The customer saves a card on a hold's page: the session completes with a SetupIntent and a Customer. */
  function saveCard(sessionId: string) {
    const session = sessions.get(sessionId) as unknown as
      | { status: string; setup_intent: string | null; customer: string | null }
      | undefined;
    if (!session) throw new Error(`no session ${sessionId}`);
    session.status = "complete";
    session.setup_intent = `seti_${++n}`;
    session.customer = `cus_${n}`;
  }

  /** The customer pays at a link: the checkout as Stripe keeps it, and the signed webhook Stripe sends. */
  async function pay(linkId: string, opts: { status?: "paid" | "unpaid"; type?: string } = {}) {
    const link = links.get(linkId);
    if (!link) throw new Error(`no link ${linkId}`);
    const id = `cs_${live ? "live" : "test"}_${++n}`;
    const session = stripeSession({
      id,
      paymentStatus: opts.status ?? "paid",
      paymentLink: linkId,
      amount: link.amount,
      livemode: live,
      ref: link.meta.sdi_ref ?? "",
      inbox: link.meta.sdi_inbox ?? "",
    });
    (session as { payment_intent: string }).payment_intent = `pi_${n}`;
    // The checkout is in the link's own currency, in Stripe's count of it.
    (session as { currency: string }).currency = link.currency;
    sessions.set(id, session);
    const body = JSON.stringify(stripeEvent(opts.type ?? "checkout.session.completed", session, `evt_${n}`));
    const [endpoint] = endpoints.values();
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacSha256Hex(endpoint?.secret ?? "none", `${t}.${body}`);
    // Good for one payment: once paid, Stripe switches the link off itself.
    if ((opts.status ?? "paid") === "paid") link.active = false;
    return new Request(`${base}/v1/hooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` },
      body,
    });
  }
  return {
    fetch: fetchImpl,
    links,
    endpoints,
    sessions,
    calls,
    pay,
    saveCard,
    holds,
    outage,
    account,
    agent,
    tokens,
    intents,
    grantToken,
    settle,
  };
}

/** Mollie, as one profile: payment links and the payments made on them. */
export function molliePlatform(key: string) {
  const links = new Map<
    string,
    {
      id: string;
      amount: { value: string; currency: string };
      webhookUrl: string;
      expiresAt: string | null;
      archived: boolean;
      paid: boolean;
      method: string;
      refunds: { id: string; value: string; status: string }[];
    }
  >();
  const calls: string[] = [];
  let n = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/hal+json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.host !== "api.mollie.com") return new Response("not found", { status: 404 });
    calls.push(`${method} ${url.pathname}`);
    if (headers.get("authorization") !== `Bearer ${key}`)
      return json({ status: 401, detail: "Missing authentication" }, 401);
    if (method === "GET" && url.pathname === "/v2/profiles/me") return json(MOLLIE_PROFILE);
    if (method === "POST" && url.pathname === "/v2/payment-links") {
      const b = JSON.parse(body) as {
        amount: { value: string; currency: string };
        webhookUrl: string;
        expiresAt?: string;
      };
      const id = `pl_test${++n}`;
      links.set(id, {
        id,
        amount: b.amount,
        webhookUrl: b.webhookUrl,
        expiresAt: b.expiresAt ?? null,
        archived: false,
        paid: false,
        method: "ideal",
        refunds: [],
      });
      return json(
        {
          resource: "payment-link",
          id,
          amount: b.amount,
          _links: { paymentLink: { href: `https://payment-links.mollie.com/payment/test${n}` } },
        },
        201,
      );
    }
    const m = /^\/v2\/payment-links\/([^/]+)(\/payments)?$/.exec(url.pathname);
    const link = m ? links.get(m[1] ?? "") : undefined;
    if (link && method === "PATCH") {
      link.archived = JSON.parse(body).archived === true;
      return json({ resource: "payment-link", id: link.id, archived: link.archived });
    }
    if (link && m?.[2])
      return json(
        mollieLinkPayments(link.paid ? [{ id: `tr_${link.id}`, value: link.amount.value, method: link.method }] : []),
      );
    const r = /^\/v2\/payments\/tr_([^/]+)\/refunds$/.exec(url.pathname);
    const refunded = r ? links.get(r[1] ?? "") : undefined;
    if (refunded && method === "GET") {
      return json({
        count: refunded.refunds.length,
        _embedded: {
          refunds: refunded.refunds.map((x) => ({
            resource: "refund",
            id: x.id,
            status: x.status,
            amount: { value: x.value, currency: refunded.amount.currency },
            createdAt: "2026-10-19T09:00:00+00:00",
          })),
        },
      });
    }
    return json({ status: 404, detail: "No payment link exists with token" }, 404);
  }) as typeof fetch;
  /** The customer pays: Mollie marks the link paid and calls the link's own webhook with the payment's id. */
  function pay(linkId: string) {
    const link = links.get(linkId);
    if (!link) throw new Error(`no link ${linkId}`);
    link.paid = true;
    return new Request(link.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `id=tr_${linkId}`,
    });
  }
  return { fetch: fetchImpl, links, calls, pay };
}
