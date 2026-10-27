import type { AgentChargeRequest, RunContext } from "@surfingdog/core";
import { ConnectorError } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  connectorHttp,
  STRIPE_AGENT_PERMISSIONS,
  STRIPE_AGENT_VERSION,
  STRIPE_VERSION,
  stripeConnector,
} from "../src/index";
import {
  HOOK,
  INBOX_ID,
  STRIPE_API_ERROR,
  STRIPE_LIVE_KEY,
  STRIPE_MISSING_PARAM,
  STRIPE_PERMISSION_ERROR,
  STRIPE_TEST_KEY,
  STRIPE_WEBHOOK_SECRET,
  stripeCardDeclined,
  stripeIdempotencyError,
  stripePaymentIntent,
  stripeTokenRefused,
} from "./fixtures/payments";

/**
 * Contract tests for an assistant's payment on the business's own Stripe account (ADR-042): the
 * charge on a Shared Payment Token, sent in the preview API version Stripe documents for it and in no
 * other call, under an idempotency key from the inbox's own id; what Stripe answers, mapped to the
 * inbox's own failure codes (Stripe's raw decline code kept for the owner only); the permission probe
 * that makes nothing. The answers are shaped after Stripe's documentation (fixtures/payments.ts); only
 * `fetch` is faked.
 */

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

function fakeStripe(route: (req: Seen) => Response | undefined) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    seen.push(req);
    return route(req) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { http: connectorHttp({ fetchImpl }), seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOW = Date.parse("2026-10-26T09:30:00Z");

function ctx(http: RunContext["http"], key = STRIPE_LIVE_KEY): RunContext {
  return {
    http,
    now: NOW,
    inbox: {
      id: INBOX_ID,
      origin: "https://inbox.bakery.example",
      host: "inbox.bakery.example",
      name: "Fjordbrød Bakery",
      timezone: "Europe/Oslo",
      language: "en",
    },
    hookUrl: `${HOOK}/stripe`,
    secret: { api_key: key, webhook_secret: STRIPE_WEBHOOK_SECRET },
    extra: {},
    calendars: [],
    busyCalendars: [],
    destinations: [],
    destination: null,
    own: { ids: new Set(), spans: [] },
    marker: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    saveSecret: async () => {},
  };
}

const TOKEN = "spt_1QFjordbrodTestToken0001";
const CHARGE: AgentChargeRequest = {
  ref: "01JC0AGENTPAY0000000000001",
  itemId: "01JC0ORDER00000000000004F2K9Q",
  amount: { value: 18900, currency: "NOK" },
  token: TOKEN,
  title: "2 × Sourdough loaf, 1 × Cardamom bun (4F2K9Q)",
  reference: "4F2K9Q",
};

const stripe = stripeConnector();
const payments = stripe.payments;
if (
  !payments?.chargeToken ||
  !payments.agentPayPermissions ||
  !payments.agentCharge ||
  !payments.cancelCharge ||
  !payments.findCharge
) {
  throw new Error("Stripe takes assistants' payments");
}
const { chargeToken, agentPayPermissions, agentCharge, cancelCharge, findCharge } = payments;
const form = (body: string) => Object.fromEntries(new URLSearchParams(body));

describe("Stripe: an assistant's shared payment token, charged once on the business's own account", () => {
  it("makes one PaymentIntent, confirmed, for exactly the order's total, in the preview version, with nothing about the customer", async () => {
    const p = fakeStripe(() => json(stripePaymentIntent({ id: "pi_1Fjord", amount: 18900, currency: "nok" })));
    const charge = await chargeToken(ctx(p.http), CHARGE);
    expect(charge).toEqual({
      status: "succeeded",
      externalId: "pi_1Fjord",
      amount: { value: 18900, currency: "NOK" },
      method: "card",
      livemode: true,
      dashboardUrl: "https://dashboard.stripe.com/payments/pi_1Fjord",
    });
    const [made] = p.seen;
    expect(made?.method).toBe("POST");
    expect(made?.url).toBe("https://api.stripe.com/v1/payment_intents");
    expect(made?.headers.get("stripe-version")).toBe(STRIPE_AGENT_VERSION);
    expect(STRIPE_AGENT_VERSION).toBe("2026-09-30.preview");
    expect(made?.headers.get("idempotency-key")).toBe(`sdi-${CHARGE.ref}-pi`);
    expect(form(made?.body ?? "")).toEqual({
      amount: "18900",
      currency: "nok",
      confirm: "true",
      "payment_method_data[shared_payment_granted_token]": TOKEN,
      description: CHARGE.title,
      "metadata[sdi_pay]": CHARGE.ref,
      "metadata[sdi_item]": CHARGE.itemId,
      "metadata[sdi_order]": "4F2K9Q",
      "metadata[sdi_inbox]": INBOX_ID,
    });
    // No name, email or address goes to Stripe from here.
    expect(made?.body).not.toMatch(/%40|receipt_email|customer|billing/);
  });

  it("counts each currency as Stripe does: yen in whole units, krónur in hundredths", async () => {
    const p = fakeStripe((req) => {
      const f = form(req.body);
      return json(stripePaymentIntent({ id: "pi_1", amount: Number(f.amount), currency: String(f.currency) }));
    });
    const yen = await chargeToken(ctx(p.http), { ...CHARGE, amount: { value: 2800, currency: "JPY" } });
    expect(form(p.seen[0]?.body ?? "").amount).toBe("2800");
    expect(yen.amount).toEqual({ value: 2800, currency: "JPY" });
    const isk = await chargeToken(ctx(p.http), { ...CHARGE, amount: { value: 4500, currency: "ISK" } });
    expect(form(p.seen[1]?.body ?? "").amount).toBe("450000");
    expect(isk.amount).toEqual({ value: 4500, currency: "ISK" });
    expect(stripe.payments?.platformAmount?.({ value: 4500, currency: "ISK" })).toEqual({
      value: 450000,
      currency: "isk",
    });
  });

  it("every other call stays on the pinned version", async () => {
    const p = fakeStripe((req) =>
      req.url.endsWith("/v1/payment_intents") ? json(STRIPE_MISSING_PARAM("amount"), 400) : json({}),
    );
    await agentPayPermissions(ctx(p.http));
    await stripe.payments?.closeLink(ctx(p.http), { externalId: "plink_1" });
    expect(p.seen.map((s) => [s.url.replace("https://api.stripe.com", ""), s.headers.get("stripe-version")])).toEqual([
      ["/v1/payment_intents", STRIPE_AGENT_VERSION],
      ["/v1/payment_links/plink_1", STRIPE_VERSION],
    ]);
  });

  it("a card Stripe declines charges nothing: declined in our words, Stripe's decline code for the owner only", async () => {
    const p = fakeStripe(() => json(stripeCardDeclined("insufficient_funds", "pi_1Declined"), 402));
    const charge = await chargeToken(ctx(p.http), CHARGE);
    expect(charge).toMatchObject({
      status: "failed",
      externalId: "pi_1Declined",
      amount: null,
      failure: { code: "declined", platformCode: "insufficient_funds" },
    });
    // A fraud code is the owner's to read, never words for the customer's assistant.
    const fraud = fakeStripe(() => json(stripeCardDeclined("fraudulent", "pi_1Fraud"), 402));
    expect((await chargeToken(ctx(fraud.http), CHARGE)).failure).toMatchObject({
      code: "declined",
      platformCode: "fraudulent",
    });
  });

  it("a card that asks its holder to confirm is said so, whether Stripe answers it as a decline or as an intent waiting", async () => {
    const declined = fakeStripe(() => json(stripeCardDeclined("authentication_required", "pi_1Auth"), 402));
    expect((await chargeToken(ctx(declined.http), CHARGE)).failure?.code).toBe("authentication_required");
    const waiting = fakeStripe(() =>
      json(stripePaymentIntent({ id: "pi_1Wait", amount: 18900, currency: "nok", status: "requires_action" })),
    );
    expect(await chargeToken(ctx(waiting.http), CHARGE)).toMatchObject({
      status: "requires_action",
      externalId: "pi_1Wait",
    });
    const p = fakeStripe(() => json(stripePaymentIntent({ id: "pi_1Wait", status: "canceled" })));
    await cancelCharge(ctx(p.http), { externalId: "pi_1Wait" });
    expect([p.seen[0]?.method, p.seen[0]?.url, p.seen[0]?.headers.get("stripe-version")]).toEqual([
      "POST",
      "https://api.stripe.com/v1/payment_intents/pi_1Wait/cancel",
      STRIPE_AGENT_VERSION,
    ]);
  });

  it("a token Stripe refuses says why, as the assistant can act on it, in Stripe's words as a sandbox gave them", async () => {
    for (const [said, code] of [
      ["missing", "token_invalid"],
      // Expired, spent and revoked: Stripe answers them alike, with no code.
      ["deactivated", "token_used"],
      ["in_use", "token_used"],
      ["limit", "token_limit"],
      // "can only be used to process payments in": another currency, not a spent token.
      ["currency", "token_limit"],
    ] as const) {
      const p = fakeStripe(() => json(stripeTokenRefused(said, TOKEN), 400));
      const charge = await chargeToken(ctx(p.http), CHARGE);
      expect([said, charge.status, charge.failure?.code]).toEqual([said, "failed", code]);
      // Stripe's words may name the token: never passed on with them.
      expect(JSON.stringify(charge)).not.toContain(TOKEN);
    }
    // Words Stripe may yet use for an expired one are read too; a token's own characters never decide.
    const expired = fakeStripe(() =>
      json(
        { error: { type: "invalid_request_error", message: "This shared payment granted token has expired." } },
        400,
      ),
    );
    expect((await chargeToken(ctx(expired.http), CHARGE)).failure?.code).toBe("token_expired");
    const odd = "spt_1Expired0usedLimit0currency";
    const unknown = fakeStripe(() => json(stripeTokenRefused("missing", odd), 400));
    expect((await chargeToken(ctx(unknown.http), { ...CHARGE, token: odd })).failure?.code).toBe("token_invalid");
    const named = fakeStripe(() =>
      json({ error: { type: "invalid_request_error", message: `Something about '${TOKEN}' is wrong.` } }, 400),
    );
    const refused = (await chargeToken(ctx(named.http), CHARGE).catch((e) => e)) as ConnectorError;
    expect(refused.code).toBe("refused");
    expect(refused.message).not.toContain(TOKEN);
  });

  it("Stripe not saying what it did is said so, with whether the same request under the same key may yet tell", async () => {
    // A 500 is kept under the key, and every retry with it gets the same: only a lookup can tell.
    const inside = fakeStripe(() => json(STRIPE_API_ERROR, 500));
    expect(await chargeToken(ctx(inside.http), CHARGE)).toMatchObject({
      status: "unknown",
      resend: false,
      externalId: null,
    });
    // An edge's 502, 503 or 504 keeps nothing: the same request under the same key may yet be answered.
    for (const status of [502, 503, 504]) {
      const edge = fakeStripe(() => json(STRIPE_API_ERROR, status));
      expect([status, await chargeToken(ctx(edge.http), CHARGE)]).toMatchObject([
        status,
        { status: "unknown", resend: true },
      ]);
    }
    // The first request under the key still runs (409); or the key was first used with other parameters (400).
    const running = fakeStripe(() => json(stripeIdempotencyError("running", `sdi-${CHARGE.ref}-pi`), 409));
    expect(await chargeToken(ctx(running.http), CHARGE)).toMatchObject({ status: "unknown", resend: true });
    const other = fakeStripe(() => json(stripeIdempotencyError("mismatch", `sdi-${CHARGE.ref}-pi`), 400));
    expect(await chargeToken(ctx(other.http), CHARGE)).toMatchObject({ status: "unknown", resend: false });
    // A request that never got an answer is the transport's to say: unreachable, thrown.
    const cut = {
      request: async () => Promise.reject(new ConnectorError("unreachable", "api.stripe.com did not answer in time.")),
    };
    expect(((await chargeToken(ctx(cut), CHARGE).catch((e) => e)) as ConnectorError).code).toBe("unreachable");
  });

  it("asks again only as it asked first: the same request, under the attempt's one key", async () => {
    const p = fakeStripe(() => json(stripePaymentIntent({ id: "pi_1Fjord", amount: 18900, currency: "nok" })));
    await chargeToken(ctx(p.http), CHARGE);
    await chargeToken(ctx(p.http), CHARGE);
    expect(p.seen.map((r) => r.headers.get("idempotency-key"))).toEqual([
      `sdi-${CHARGE.ref}-pi`,
      `sdi-${CHARGE.ref}-pi`,
    ]);
    expect(p.seen[1]?.body).toBe(p.seen[0]?.body);
    expect(form(p.seen[0]?.body ?? "")["metadata[sdi_pay]"]).toBe(CHARGE.ref);
  });


  it("a refusal about anything else is Stripe's to say; a key without the permission names it; a platform down is tried again", async () => {
    const small = fakeStripe(() =>
      json({ error: { type: "invalid_request_error", code: "amount_too_small", message: "Amount too small" } }, 400),
    );
    const refused = await chargeToken(ctx(small.http), CHARGE).catch((e) => e);
    expect(refused).toBeInstanceOf(ConnectorError);
    expect((refused as ConnectorError).code).toBe("refused");
    const forbidden = fakeStripe(() => json(STRIPE_PERMISSION_ERROR("rak_payment_intent_write"), 403));
    const no = await chargeToken(ctx(forbidden.http), CHARGE).catch((e) => e);
    expect((no as ConnectorError).code).toBe("config");
    expect((no as ConnectorError).message).toContain(STRIPE_AGENT_PERMISSIONS.intents);
    const busy = fakeStripe(() => json({ error: { type: "rate_limit_error", message: "slow down" } }, 429));
    expect(((await chargeToken(ctx(busy.http), CHARGE).catch((e) => e)) as ConnectorError).code).toBe("rate_limited");
  });

  it("refuses an answer that is not the charge asked for: another amount, another mode", async () => {
    const other = fakeStripe(() => json(stripePaymentIntent({ id: "pi_1", amount: 100, currency: "nok" })));
    expect(((await chargeToken(ctx(other.http), CHARGE).catch((e) => e)) as ConnectorError).code).toBe("bad_response");
    const mode = fakeStripe(() =>
      json(stripePaymentIntent({ id: "pi_1", amount: 18900, currency: "nok", livemode: false })),
    );
    expect(((await chargeToken(ctx(mode.http), CHARGE).catch((e) => e)) as ConnectorError).code).toBe("bad_response");
  });

  it("reads a charge back with the key: one that was processing, settled since", async () => {
    const p = fakeStripe(() =>
      json(stripePaymentIntent({ id: "pi_1Later", amount: 18900, currency: "nok", livemode: false })),
    );
    const charge = await agentCharge(ctx(p.http, STRIPE_TEST_KEY), { externalId: "pi_1Later" });
    expect(charge).toMatchObject({ status: "succeeded", livemode: false, amount: { value: 18900, currency: "NOK" } });
    expect(charge?.dashboardUrl).toBe("https://dashboard.stripe.com/test/payments/pi_1Later");
    expect([p.seen[0]?.method, p.seen[0]?.headers.get("stripe-version")]).toEqual(["GET", STRIPE_AGENT_VERSION]);
  });

  it("finds a charge it never heard back about by the inbox's own id, with the list Stripe keeps current, never its search", async () => {
    const since = NOW - 10 * 60_000;
    const theirs = (i: number) =>
      stripePaymentIntent({ id: `pi_1Other${i}`, metadata: { sdi_pay: "01JC0SOMEONEELSE00000000001" } });
    // The account's payments since the attempt was first asked, newest first, a page at a time.
    const pages: Record<string, unknown[]> = {
      "": [theirs(1), theirs(2)],
      pi_1Other2: [
        theirs(3),
        stripePaymentIntent({
          id: "pi_1Ours",
          amount: 18900,
          currency: "nok",
          status: "processing",
          metadata: { sdi_pay: CHARGE.ref },
        }),
      ],
    };
    const p = fakeStripe((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/payment_intents") {
        const after = url.searchParams.get("starting_after") ?? "";
        return json({ object: "list", data: pages[after] ?? [], has_more: after === "" });
      }
      // Read again by its id, as Stripe holds it now: it went through meanwhile.
      if (url.pathname === "/v1/payment_intents/pi_1Ours") {
        return json(
          stripePaymentIntent({ id: "pi_1Ours", amount: 18900, currency: "nok", metadata: { sdi_pay: CHARGE.ref } }),
        );
      }
      return undefined;
    });
    const found = await findCharge(ctx(p.http), { ref: CHARGE.ref, since });
    expect(found).toMatchObject({ status: "succeeded", externalId: "pi_1Ours" });
    const urls = p.seen.map((r) => new URL(r.url));
    expect(urls.map((u) => u.pathname)).toEqual([
      "/v1/payment_intents",
      "/v1/payment_intents",
      "/v1/payment_intents/pi_1Ours",
    ]);
    // From a little before the first ask, against the clocks' difference; never Stripe's search.
    expect(urls[0]?.searchParams.get("created[gte]")).toBe(String(Math.floor(since / 1000) - 300));
    expect(urls[1]?.searchParams.get("starting_after")).toBe("pi_1Other2");
    expect(p.seen.every((r) => r.method === "GET" && r.headers.get("stripe-version") === STRIPE_AGENT_VERSION)).toBe(
      true,
    );
    expect(p.seen.some((r) => r.url.includes("/search"))).toBe(false);
    // None there: null, which the inbox never takes for none made.
    const none = fakeStripe(() => json({ object: "list", data: [theirs(1)], has_more: false }));
    expect(await findCharge(ctx(none.http), { ref: CHARGE.ref, since })).toBeNull();
    expect(none.seen).toHaveLength(1);
    // A key that may not read them says so.
    const forbidden = fakeStripe(() => json(STRIPE_PERMISSION_ERROR("rak_payment_intent_read"), 403));
    expect(
      ((await findCharge(ctx(forbidden.http), { ref: CHARGE.ref, since }).catch((e) => e)) as ConnectorError).code,
    ).toBe("config");
  });

  it("a payment Stripe never tried, or holds authorised, is waiting, never failed; one it declined says why", async () => {
    const read = async (pi: Record<string, unknown>) =>
      agentCharge(ctx(fakeStripe(() => json(pi)).http), { externalId: String(pi.id) });
    const untried = stripePaymentIntent({ id: "pi_1Untried", status: "requires_payment_method" });
    expect((await read(untried))?.status).toBe("requires_action");
    expect((await read({ ...untried, id: "pi_1Held", status: "requires_capture" }))?.status).toBe("processing");
    const declined = {
      ...untried,
      id: "pi_1Declined",
      last_payment_error: {
        type: "card_error",
        code: "card_declined",
        decline_code: "insufficient_funds",
        message: "Your card was declined.",
      },
    };
    expect(await read(declined)).toMatchObject({
      status: "failed",
      failure: { code: "declined", platformCode: "insufficient_funds" },
    });
  });

  it("asks whether the key may charge with a request that makes nothing: 400 it may, 403 it may not", async () => {
    const may = fakeStripe(() => json(STRIPE_MISSING_PARAM("amount"), 400));
    expect(await agentPayPermissions(ctx(may.http))).toEqual([]);
    expect(may.seen[0]?.body).toBe("");
    const mayNot = fakeStripe(() => json(STRIPE_PERMISSION_ERROR("rak_payment_intent_write"), 403));
    expect(await agentPayPermissions(ctx(mayNot.http))).toEqual(["PaymentIntents: Write"]);
  });

  it("names the permission in the key's form for the owner who switches it on", () => {
    expect(STRIPE_AGENT_PERMISSIONS).toEqual({ intents: "PaymentIntents: Write" });
  });
});
