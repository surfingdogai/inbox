import { createApiKey, hmacSha256Hex } from "@surfingdog/adapters";
import type { Db } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import {
  MOLLIE_LIVE_KEY,
  MOLLIE_PROFILE,
  mollieLinkPayments,
  STRIPE_AMOUNT_TOO_SMALL,
  STRIPE_EMPTY_LIST,
  STRIPE_INVALID_KEY,
  STRIPE_LIVE_KEY,
  STRIPE_MISSING_PARAM,
  STRIPE_TEST_KEY,
  stripeEvent,
  stripeSession,
} from "../../../packages/adapters/test/fixtures/payments";
import { createInbox } from "../src/app";
import { confirmed, freshDb } from "./harness";

/**
 * Getting paid through the business's own account, end to end (ADR-023), through the doors an owner,
 * an agent and a payment platform use: Settings connects Stripe with a restricted key (or Mollie with
 * its API key); an order the owner accepts is asked to pay at a link in the business's own account,
 * in one email; the platform's signed word, read back with the key, marks it paid and its receipt
 * says what was paid; a cancelled order's link is switched off, and a payment that arrives anyway is
 * the owner's to refund, and they are told where. The platforms are fakes at the fetch level that keep
 * state as the real ones do.
 */
const BASE = "https://inbox.example.com";
const SECRET_KEY = "payments-test-secret-0123456789abcdef";

interface StripeLink {
  id: string;
  url: string;
  active: boolean;
  amount: number;
  currency: string;
  meta: Record<string, string>;
}

/** Stripe, as one account: prices, payment links, checkouts and webhook endpoints, by its rules. */
function stripePlatform(key: string) {
  const live = key.includes("_live_");
  const links = new Map<string, StripeLink>();
  const prices = new Map<string, { amount: number; currency: string }>();
  const sessions = new Map<string, ReturnType<typeof stripeSession>>();
  const endpoints = new Map<string, { url: string; secret: string; meta: Record<string, string> }>();
  const idem = new Map<string, unknown>();
  const calls: string[] = [];
  /** What making a price answers for now: Stripe down (500), or a refusal (400). */
  const outage: { prices: number | null } = { prices: null };
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
    if (headers.get("authorization") !== `Bearer ${key}`) return json(STRIPE_INVALID_KEY, 401);
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
      endpoints.set(id, { url: f.get("url") ?? "", secret, meta: meta("metadata") });
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
    if (route === "POST /v1/prices") {
      return once(() => {
        const id = `price_${++n}`;
        prices.set(id, { amount: Number(f.get("unit_amount")), currency: String(f.get("currency")) });
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
        };
        links.set(id, link);
        return { id, object: "payment_link", url: link.url, active: true, livemode: live, metadata: link.meta };
      });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/payment_links/")) {
      const link = links.get(url.pathname.split("/").at(-1) ?? "");
      if (!link) return json({ error: { message: "No such payment link", type: "invalid_request_error" } }, 404);
      if (f.get("active") === "false") link.active = false;
      return json({ id: link.id, object: "payment_link", active: link.active });
    }
    if (method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) {
      const s = sessions.get(url.pathname.split("/").at(-1) ?? "");
      return s ? json(s) : json({ error: { message: "No such checkout.session" } }, 404);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

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
    sessions.set(id, session);
    const body = JSON.stringify(stripeEvent(opts.type ?? "checkout.session.completed", session, `evt_${n}`));
    const [endpoint] = endpoints.values();
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacSha256Hex(endpoint?.secret ?? "none", `${t}.${body}`);
    return new Request(`${BASE}/v1/hooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` },
      body,
    });
  }
  return { fetch: fetchImpl, links, endpoints, sessions, calls, pay, outage };
}

/** Mollie, as one profile: payment links and the payments made on them. */
function molliePlatform(key: string) {
  const links = new Map<
    string,
    { id: string; amount: { value: string; currency: string }; webhookUrl: string; archived: boolean; paid: boolean }
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
      const b = JSON.parse(body) as { amount: { value: string; currency: string }; webhookUrl: string };
      const id = `pl_test${++n}`;
      links.set(id, { id, amount: b.amount, webhookUrl: b.webhookUrl, archived: false, paid: false });
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
      return json(mollieLinkPayments(link.paid ? [{ id: `tr_${link.id}`, value: link.amount.value }] : []));
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

async function setup(opts: { stripeKey?: string; mollie?: boolean; testMode?: boolean } = {}) {
  const db = await freshDb();
  const stripe = stripePlatform(opts.stripeKey ?? STRIPE_LIVE_KEY);
  const mollie = molliePlatform(MOLLIE_LIVE_KEY);
  const mail = logMailOut();
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: mail,
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).host === "api.mollie.com"
        ? mollie.fetch(input, init)
        : stripe.fetch(input, init)) as typeof fetch,
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const owner = { authorization: `Bearer ${ownerKey}` };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const saved = await call(
    "PUT",
    "/v1/owner/settings",
    {
      doc: {
        business: { name: "Ana's Salon" },
        email: { fromAddress: "orders@salon.example" },
        notifications: { ownerEmail: "ana@salon.example", appUrl: BASE },
        ...(opts.testMode ? { testMode: true } : {}),
      },
    },
    owner,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  return { db, inbox, call, owner, stripe, mollie, mail, pending };
}
type S = Awaited<ReturnType<typeof setup>>;

/**
 * Every job due now, then (with `aheadMs`) every job due by then: the pay link is made at once, as
 * the runner does after the request, and the customer's email that waits a moment for it goes after.
 */
async function drain(s: S, aheadMs = 0): Promise<void> {
  await Promise.all(s.pending);
  for (const ahead of aheadMs > 0 ? [0, aheadMs] : [0]) {
    let settled = false;
    for (let pass = 0; pass < 20 && !settled; pass++) {
      settled = (await s.inbox.runner.runDue(s.db, { now: Date.now() + ahead })).claimed === 0;
    }
    if (!settled) throw new Error("the outbox never settled");
  }
}

async function connectStripe(s: S, values: Record<string, string> = { api_key: STRIPE_LIVE_KEY }) {
  const res = await s.call("POST", "/v1/owner/integrations", { kind: "stripe", values }, s.owner);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string; mode: string; pay_on: boolean; payments: Record<string, unknown> };
}

/** An order of the customer's, through the public door, accepted by the owner. */
async function acceptedOrder(s: S, value = 4500) {
  const made = await confirmed(
    (r) => s.inbox.app.request(r),
    new Request(`${BASE}/v1/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          orderedItem: [{ name: "Colour and cut", quantity: 1, price: { value, currency: "EUR" } }],
          totalPrice: { value, currency: "EUR" },
        },
        contact: { name: "Rita", email: "rita@example.com", locale: "en" },
      }),
    }),
  );
  expect(made.status, await made.clone().text()).toBe(201);
  const body = (await made.json()) as { view: { item: { id: string } }; accessToken: string };
  const id = body.view.item.id;
  tokens.set(id, body.accessToken);
  const accepted = await s.call("POST", `/v1/owner/items/${id}/transitions`, { event: "accept" }, s.owner);
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  return id;
}

/** The customer's access to each order made here, as their agent holds it. */
const tokens = new Map<string, string>();

async function itemOf(db: Db, id: string) {
  const { rows } = await db.client.query({
    sql: "SELECT state, payload FROM items WHERE id = ?",
    params: [id],
    method: "all",
  });
  return { state: String(rows[0]?.[0]), payload: JSON.parse(String(rows[0]?.[1])) as Record<string, unknown> };
}

async function customerMails(db: Db, id: string) {
  const { rows } = await db.client.query({
    sql: "SELECT template, status, body_text FROM outbound_mail WHERE item_id = ? AND recipient = 'customer' ORDER BY created_at, id",
    params: [id],
    method: "all",
  });
  return rows.map((r) => ({ template: String(r[0]), status: String(r[1]), text: String(r[2]) }));
}

async function paymentsOf(s: S, id: string) {
  const res = await s.call("GET", `/v1/owner/items/${id}/payments`, undefined, s.owner);
  expect(res.status).toBe(200);
  return ((await res.json()) as { payments: Record<string, unknown>[] }).payments;
}

describe("Settings → Integrations: Stripe and Mollie", () => {
  it("are ready to connect, each with its key, a webhook secret under More options, and the address to add by hand", async () => {
    const s = await setup();
    const res = await s.call("GET", "/v1/owner/integrations", undefined, s.owner);
    const body = (await res.json()) as {
      cards: {
        id: string;
        status: string;
        line: string;
        ways: {
          status: string;
          form: { key: string; secret: boolean; advanced: boolean; link?: { href: string } }[];
          note?: string;
          hook?: { url: string; events: string[] };
        }[];
      }[];
    };
    const stripe = body.cards.find((c) => c.id === "stripe");
    const mollie = body.cards.find((c) => c.id === "mollie");
    expect(stripe).toMatchObject({ status: "ready", line: "Paid into your own account" });
    expect(mollie).toMatchObject({ status: "ready", line: "Paid into your own account" });
    expect(stripe?.ways[0]?.form.map((f) => [f.key, f.secret, f.advanced])).toEqual([
      ["api_key", true, false],
      ["webhook_secret", true, true],
    ]);
    expect(stripe?.ways[0]?.form[0]?.link?.href).toBe("https://dashboard.stripe.com/apikeys/create");
    expect(stripe?.ways[0]?.hook).toEqual({
      url: `${BASE}/v1/hooks/stripe`,
      events: [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
      ],
    });
    expect(mollie?.ways[0]?.hook).toEqual({ url: `${BASE}/v1/hooks/mollie`, events: ["payment-link.paid"] });
  });

  it("connects a restricted key: checked against Stripe, sealed, never shown again, its webhook added", async () => {
    const s = await setup();
    const res = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "stripe", values: { api_key: STRIPE_LIVE_KEY } },
      s.owner,
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(STRIPE_LIVE_KEY);
    expect(text).not.toContain("whsec_");
    expect(JSON.parse(text)).toMatchObject({
      kind: "stripe",
      account: `Live · key ending ${STRIPE_LIVE_KEY.slice(-4)}`,
      mode: "live",
      pay_on: true,
      payments: { open: 0, paid: 0, webhook: "added", dashboard_url: "https://dashboard.stripe.com/payments" },
    });
    expect([...s.stripe.endpoints.values()].map((e) => e.url)).toEqual([`${BASE}/v1/hooks/stripe`]);
    const { rows } = await s.db.client.query({
      sql: "SELECT config_enc, config_public FROM connectors",
      method: "all",
    });
    expect(String(rows[0]?.[0])).toMatch(/^v1\./);
    expect(String(rows[0]?.[1])).not.toContain(STRIPE_LIVE_KEY.slice(8));
    // A secret key is refused for what it is.
    const sk = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "stripe", values: { api_key: STRIPE_LIVE_KEY.replace(/^rk/, "sk") } },
      s.owner,
    );
    expect(sk.status).toBe(422);
    expect(await sk.text()).toContain("secret key, which can do anything");
  });

  it("only the owner in person connects it: an integration key is refused", async () => {
    const s = await setup();
    const key = await createApiKey(s.db, { kind: "integration", name: "Zapier", scopes: ["*"] });
    const res = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "stripe", values: { api_key: STRIPE_LIVE_KEY } },
      {
        authorization: `Bearer ${key.key}`,
      },
    );
    expect(res.status).toBe(403);
    expect(s.stripe.calls).toHaveLength(0);
  });
});

describe("an accepted order, paid into the business's own Stripe account", () => {
  it("is asked to pay at a link for what it comes to, in one email; Stripe's signed word marks it paid, and the receipt says so", async () => {
    const s = await setup();
    await connectStripe(s);
    await drain(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const [link] = [...s.stripe.links.values()];
    expect(link).toMatchObject({ amount: 4500, currency: "eur", active: true });
    expect(link?.meta).toMatchObject({ sdi_item: id });
    const waiting = await itemOf(s.db, id);
    expect(waiting.state).toBe("awaiting_payment");
    expect(waiting.payload.paymentUrl).toBe(link?.url);
    // One email to the customer: the order accepted and the link to pay, in the business's own words.
    const mails = (await customerMails(s.db, id)).filter((m) => m.status !== "skipped");
    expect(mails.map((m) => m.template)).toEqual(["order.awaiting_payment"]);
    expect(mails[0]?.text).toContain(link?.url ?? "-");
    expect(mails[0]?.text).toContain("it is waiting for your payment of €45.00");
    // The customer's agent is given the link on the order, to hand to its person.
    const status = await s.call("GET", `/v1/items/${id}?access_token=${tokens.get(id)}`);
    const seen = JSON.stringify(await status.json());
    expect(seen).toContain(link?.url ?? "-");
    expect(seen).not.toContain("plink_");
    expect(mails[0]?.text.replace(/https:\/\/\S+/g, "")).not.toMatch(/surfing dog|stripe|network/i);

    // The customer pays; Stripe tells the inbox, signed.
    const paidHook = await s.stripe.pay(link?.id ?? "");
    const told = await s.inbox.app.request(paidHook.clone() as Request);
    expect(told.status, await told.clone().text()).toBe(200);
    expect(await told.json()).toMatchObject({ ok: true, handled: 1, duplicate: false });
    const paid = await itemOf(s.db, id);
    expect(paid.state).toBe("paid");
    expect(paid.payload).toMatchObject({
      paymentRef: expect.stringMatching(/^pi_/),
      paidAmount: { value: 4500, currency: "EUR" },
    });
    // Stripe sending it again changes nothing.
    const again = await s.inbox.app.request(paidHook.clone() as Request);
    expect(await again.json()).toMatchObject({ ok: true, handled: 0, duplicate: true });
    await drain(s, 60_000);
    const { rows: events } = await s.db.client.query({
      sql: "SELECT event, actor_kind FROM item_events WHERE item_id = ? ORDER BY seq",
      params: [id],
      method: "all",
    });
    expect(events.map((e) => `${e[0]}:${e[1]}`)).toEqual([
      "create:customer_agent",
      "accept:owner",
      "request_payment:connector",
      "record_payment:connector",
    ]);
    // The receipt attests the payment, with what Stripe says was paid.
    const { rows: receipts } = await s.db.client.query({
      sql: "SELECT kind, payload FROM receipts WHERE item_id = ?",
      params: [id],
      method: "all",
    });
    const paidReceipt = receipts.find((r) => r[0] === "paid");
    expect(JSON.parse(String(paidReceipt?.[1]))).toMatchObject({
      knd: "paid",
      typ: "order",
      amt: { value: 4500, currency: "EUR" },
    });
    // The owner sees where the money is, and where to refund it.
    expect(await paymentsOf(s, id)).toMatchObject([
      {
        provider: "Stripe",
        state: "paid",
        amount: { value: 4500, currency: "EUR" },
        paid_amount: { value: 4500, currency: "EUR" },
        dashboard_url: expect.stringMatching(/^https:\/\/dashboard\.stripe\.com\/payments\/pi_/),
        livemode: true,
      },
    ]);
  });

  it("refuses a webhook whose signature does not check out, and nothing moves", async () => {
    const s = await setup();
    await connectStripe(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const [link] = [...s.stripe.links.values()];
    const real = await s.stripe.pay(link?.id ?? "");
    const forged = new Request(real.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`,
      },
      body: await real.text(),
    });
    const res = await s.inbox.app.request(forged);
    expect(res.status).toBe(400);
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");
  });

  it("finds a payment the webhook never told of, on the next sync", async () => {
    const s = await setup();
    await connectStripe(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const [link] = [...s.stripe.links.values()];
    await s.stripe.pay(link?.id ?? ""); // made, never delivered
    const { rows } = await s.db.client.query({ sql: "SELECT id FROM connectors", method: "all" });
    const conn = String(rows[0]?.[0]);
    // Eleven minutes on, the five-minute sync asks Stripe about the links still open.
    await s.inbox.caps.connectors.run(conn, Date.now() + 11 * 60_000, "sync");
    expect((await itemOf(s.db, id)).state).toBe("paid");
  });

  it("switches the link off when the order is cancelled; a payment that arrives anyway is the owner's to refund, and they are told where", async () => {
    const s = await setup();
    await connectStripe(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const [link] = [...s.stripe.links.values()];
    const cancelled = await s.call(
      "POST",
      `/v1/owner/items/${id}/transitions`,
      { event: "cancel", input: { note: "Out of stock" } },
      s.owner,
    );
    expect(cancelled.status).toBe(200);
    await drain(s, 60_000);
    expect(link?.active).toBe(false);
    const late = await s.inbox.app.request(await s.stripe.pay(link?.id ?? ""));
    expect(late.status).toBe(200);
    await drain(s, 60_000);
    expect((await itemOf(s.db, id)).state).toBe("cancelled");
    const owner = s.mail.sent.find((m) => m.subject.startsWith("A payment for order"));
    expect(owner?.to).toEqual(["ana@salon.example"]);
    expect(owner?.text).toMatch(
      /^The customer paid €45\.00 for order \w{6} through Stripe, but the order was cancelled by then/,
    );
    expect(owner?.text).toContain("Refund it in Stripe: https://dashboard.stripe.com/payments/pi_");
    expect((await paymentsOf(s, id))[0]).toMatchObject({
      state: "paid",
      note: expect.stringContaining("refund it in Stripe"),
    });
  });

  it("closes the link and sends a new one when the total changes, and a link for each try after a payment fails", async () => {
    const s = await setup();
    await connectStripe(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const first = [...s.stripe.links.values()][0];
    // What the order comes to now (as an agreed change would leave it).
    await s.db.client.query({
      sql: "UPDATE items SET payload = json_set(payload, '$.totalPrice.value', 5200) WHERE id = ?",
      params: [id],
      method: "run",
    });
    await s.inbox.caps.connectors.payments.ensure(id, Date.now());
    const second = [...s.stripe.links.values()][1];
    expect(first?.active).toBe(false);
    expect(second).toMatchObject({ amount: 5200, active: true });
    expect((await itemOf(s.db, id)).payload.paymentUrl).toBe(second?.url);
    // A bank payment that later fails: the order says so, and a fresh link follows.
    const failed = await s.inbox.app.request(
      await s.stripe.pay(second?.id ?? "", { status: "unpaid", type: "checkout.session.async_payment_failed" }),
    );
    expect(failed.status).toBe(200);
    await drain(s, 60_000);
    const third = [...s.stripe.links.values()][2];
    expect(third).toMatchObject({ amount: 5200, active: true });
    // The spent link is switched off, so it cannot be paid beside the new one.
    expect(second?.active).toBe(false);
    const now = await itemOf(s.db, id);
    expect(now.state).toBe("awaiting_payment");
    expect(now.payload.paymentUrl).toBe(third?.url);
    expect((await paymentsOf(s, id)).map((p) => p.state)).toEqual(["open", "failed", "closed"]);
  });

  it("makes no link for an order the owner priced at nothing, with pay links off, or with a key of the other mode", async () => {
    const test = await setup({ stripeKey: STRIPE_TEST_KEY });
    await connectStripe(test, { api_key: STRIPE_TEST_KEY });
    const real = await acceptedOrder(test);
    await drain(test, 60_000);
    expect(test.stripe.links.size).toBe(0);
    expect((await itemOf(test.db, real)).state).toBe("accepted");

    const s = await setup();
    const conn = await connectStripe(s);
    const off = await s.call("PATCH", `/v1/owner/integrations/${conn.id}`, { pay_on: false }, s.owner);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ pay_on: false });
    await acceptedOrder(s);
    await drain(s, 60_000);
    expect(s.stripe.links.size).toBe(0);
  });

  it("leaves alone an order the owner gave a payment link of their own", async () => {
    const s = await setup();
    await connectStripe(s);
    const made = await confirmed(
      (r) => s.inbox.app.request(r),
      new Request(`${BASE}/v1/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload: {
            orderedItem: [{ name: "Gift card", quantity: 1, price: { value: 3000, currency: "EUR" } }],
            totalPrice: { value: 3000, currency: "EUR" },
          },
          contact: { email: "rita@example.com" },
        }),
      }),
    );
    const id = ((await made.json()) as { view: { item: { id: string } } }).view.item.id;
    await s.call("POST", `/v1/owner/items/${id}/transitions`, { event: "accept" }, s.owner);
    // The owner asks at once, with their own link, before the inbox made one.
    const own = await s.call(
      "POST",
      `/v1/owner/items/${id}/transitions`,
      { event: "request_payment", input: { paymentUrl: "https://pay.salon.example/gift" } },
      s.owner,
    );
    expect(own.status).toBe(200);
    await drain(s, 60_000);
    const item = await itemOf(s.db, id);
    expect(item.payload.paymentUrl).toBe("https://pay.salon.example/gift");
    expect([...s.stripe.links.values()].every((l) => !l.active)).toBe(true);
  });

  it("disconnecting switches every open link off and takes away the webhook it added", async () => {
    const s = await setup();
    const conn = await connectStripe(s);
    await acceptedOrder(s);
    await drain(s, 60_000);
    const res = await s.call("DELETE", `/v1/owner/integrations/${conn.id}`, undefined, s.owner);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: true, links_closed: 1 });
    expect([...s.stripe.links.values()].map((l) => l.active)).toEqual([false]);
    expect(s.stripe.endpoints.size).toBe(0);
  });
});

describe("a quote the customer accepts", () => {
  it("becomes an order that is asked to pay at a link", async () => {
    const s = await setup();
    await connectStripe(s);
    const asked = await s.call("POST", "/v1/quotes", {
      payload: { itemOffered: { name: "Wedding hair" }, description: "Bride and two bridesmaids", quantity: 1 },
      contact: { name: "Rita", email: "rita@example.com", locale: "en" },
    });
    expect(asked.status, await asked.clone().text()).toBe(201);
    const created = (await asked.json()) as { view: { item: { id: string } }; accessToken: string };
    const id = created.view.item.id;
    const q = `access_token=${created.accessToken}`;
    const quoted = await s.call(
      "POST",
      `/v1/owner/items/${id}/transitions`,
      {
        event: "quote",
        input: {
          totalPrice: { value: 32_000, currency: "EUR" },
          validThrough: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          lines: [{ name: "Wedding hair", quantity: 1, price: { value: 32_000, currency: "EUR" } }],
        },
      },
      s.owner,
    );
    expect(quoted.status, await quoted.clone().text()).toBe(200);
    const status = (await (await s.call("GET", `/v1/items/${id}?${q}`)).json()) as {
      offer: { id: string; terms_sha: string };
    };
    const accepted = await s.call("POST", `/v1/items/${id}/accept?${q}`, {
      offer_id: status.offer.id,
      terms_sha: status.offer.terms_sha,
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    await drain(s, 60_000);
    const { rows } = await s.db.client.query({
      sql: "SELECT id FROM items WHERE type = 'order' AND linked_item_id = ?",
      params: [id],
      method: "all",
    });
    const orderId = String(rows[0]?.[0]);
    const [link] = [...s.stripe.links.values()];
    expect(link).toMatchObject({ amount: 32_000, active: true, meta: { sdi_item: orderId } });
    expect(await itemOf(s.db, orderId)).toMatchObject({
      state: "awaiting_payment",
      payload: { paymentUrl: link?.url },
    });
  });
});

describe("an accepted order, paid into the business's own Mollie account", () => {
  it("names its own webhook; Mollie's unsigned word is only a nudge, and what Mollie says when asked marks it paid", async () => {
    const s = await setup();
    const res = await s.call(
      "POST",
      "/v1/owner/integrations",
      { kind: "mollie", values: { api_key: MOLLIE_LIVE_KEY } },
      s.owner,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ account: "Ana's Salon", mode: "live", payments: { webhook: "per_link" } });
    const id = await acceptedOrder(s, 2750);
    await drain(s, 60_000);
    const [link] = [...s.mollie.links.values()];
    expect(link?.amount).toEqual({ value: "27.50", currency: "EUR" });
    expect(link?.webhookUrl).toMatch(new RegExp(`^${BASE}/v1/hooks/mollie\\?ref=`));
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");
    // Someone who learned the address posts to it before anything was paid: nothing happens.
    const early = await s.inbox.app.request(
      new Request(link?.webhookUrl ?? "", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "id=tr_fake",
      }),
    );
    expect(early.status).toBe(200);
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");
    // The customer pays.
    const told = await s.inbox.app.request(s.mollie.pay(link?.id ?? ""));
    expect(told.status).toBe(200);
    await drain(s, 60_000);
    const paid = await itemOf(s.db, id);
    expect(paid).toMatchObject({
      state: "paid",
      payload: { paymentMethod: "ideal", paidAmount: { value: 2750, currency: "EUR" } },
    });
    const { rows } = await s.db.client.query({
      sql: "SELECT payload FROM receipts WHERE item_id = ? AND kind = 'paid'",
      params: [id],
      method: "all",
    });
    expect(JSON.parse(String(rows[0]?.[0]))).toMatchObject({ amt: { value: 2750, currency: "EUR" }, pay: "ideal" });
    expect((await paymentsOf(s, id))[0]).toMatchObject({
      provider: "Mollie",
      state: "paid",
      method: "ideal",
      dashboard_url: expect.stringContaining("my.mollie.com"),
    });
  });
});

describe("test keys and test orders", () => {
  it("a test key makes links for test orders only, and a test payment pays only them", async () => {
    const s = await setup({ stripeKey: STRIPE_TEST_KEY, testMode: true });
    const conn = await connectStripe(s, { api_key: STRIPE_TEST_KEY });
    expect(conn).toMatchObject({
      mode: "test",
      payments: { dashboard_url: "https://dashboard.stripe.com/test/payments" },
    });
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const [link] = [...s.stripe.links.values()];
    expect(link?.url).toMatch(/^https:\/\/buy\.stripe\.com\/test_/);
    // A test order emails nobody; it is kept, and says so.
    expect((await customerMails(s.db, id)).every((m) => m.status === "skipped")).toBe(true);
    await s.inbox.app.request(await s.stripe.pay(link?.id ?? ""));
    expect((await itemOf(s.db, id)).state).toBe("paid");
    expect((await paymentsOf(s, id))[0]).toMatchObject({ livemode: false, state: "paid" });
  });

  it("a live key makes no link for a test order", async () => {
    const s = await setup({ testMode: true });
    await connectStripe(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    expect(s.stripe.links.size).toBe(0);
    expect((await itemOf(s.db, id)).state).toBe("accepted");
  });
});

describe("the doors around it", () => {
  it("a webhook for a platform nothing here takes is not found; one with no signature at all is refused", async () => {
    const s = await setup();
    const none = await s.call("POST", "/v1/hooks/stripe", { id: "evt_1", type: "checkout.session.completed" });
    expect(none.status).toBe(404);
    await connectStripe(s);
    const bare = await s.call("POST", "/v1/hooks/stripe", { id: "evt_1", type: "checkout.session.completed" });
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({ error: "bad_signature" });
    const odd = await s.call("POST", "/v1/hooks/..%2Fowner", {});
    expect(odd.status).toBe(404);
  });

  it("the owner's AI reads the links and the connection, never a key, and cannot connect one", async () => {
    const s = await setup();
    await connectStripe(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const client = new Client({ name: "owner-ai", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/owner`), {
        fetch: async (input: string | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", s.owner.authorization);
          return s.inbox.app.request(String(input), { ...init, headers });
        },
      }),
    );
    const listed = (await client.callTool({ name: "list_integrations", arguments: {} })) as {
      content: { text: string }[];
    };
    expect(listed.content[0]?.text).toMatch(/Stripe \[active\] pay links on, 1 waiting to be paid, 0 paid/);
    const pays = (await client.callTool({ name: "list_payments", arguments: { item_id: id } })) as {
      content: { text: string }[];
    };
    expect(pays.content[0]?.text).toMatch(/^Stripe open: 45\.00 EUR at https:\/\/buy\.stripe\.com\//);
    expect(JSON.stringify([listed, pays])).not.toContain(STRIPE_LIVE_KEY);
    const recorded = (await client.callTool({
      name: "transition_item",
      arguments: { item_id: id, event: "record_payment", input: { paymentRef: "pi_x" } },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(recorded.isError).toBe(true);
    expect(recorded.content[0]?.text).toMatch(/recorded by the owner or the payment provider/);
  });
});

describe("when Stripe does not make the link", () => {
  it("tries again later while Stripe is down, and asks to pay once it answers", async () => {
    const s = await setup();
    await connectStripe(s);
    await drain(s);
    s.stripe.outage.prices = 500;
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    expect((await itemOf(s.db, id)).state).toBe("accepted");
    const [waiting] = await paymentsOf(s, id);
    expect(waiting).toMatchObject({ state: "creating", error: expect.stringContaining("Stripe is not answering") });
    // The order's own email went without a link: it waited its moment, and the link did not come.
    expect((await customerMails(s.db, id)).map((m) => m.template)).toEqual(["order.accepted"]);
    s.stripe.outage.prices = null;
    await drain(s, 10 * 60_000);
    const asked = await itemOf(s.db, id);
    expect(asked.state).toBe("awaiting_payment");
    expect(asked.payload.paymentUrl).toBe([...s.stripe.links.values()][0]?.url);
    expect((await customerMails(s.db, id)).map((m) => m.template)).toEqual([
      "order.accepted",
      "order.awaiting_payment",
    ]);
  });

  it("gives up on a refusal and tells the owner, in Stripe's words; the order waits for them", async () => {
    const s = await setup();
    await connectStripe(s);
    s.stripe.outage.prices = 400;
    const id = await acceptedOrder(s, 20);
    await drain(s, 60_000);
    expect((await itemOf(s.db, id)).state).toBe("accepted");
    expect((await paymentsOf(s, id))[0]).toMatchObject({
      state: "error",
      error: "Stripe said: Amount must be at least €0.50 eur",
    });
    const told = s.mail.sent.find((m) => m.subject.endsWith("has no payment link"));
    expect(told?.to).toEqual(["ana@salon.example"]);
    expect(told?.text).toContain("Stripe did not make a payment link for order");
    expect(told?.text).toContain("Amount must be at least €0.50 eur");
  });

  it("two jobs that meet make one link", async () => {
    const s = await setup();
    await connectStripe(s);
    await drain(s);
    const made = await confirmed(
      (r) => s.inbox.app.request(r),
      new Request(`${BASE}/v1/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload: {
            orderedItem: [{ name: "Gift card", quantity: 1, price: { value: 3000, currency: "EUR" } }],
            totalPrice: { value: 3000, currency: "EUR" },
          },
          contact: { email: "rita@example.com" },
        }),
      }),
    );
    const id = ((await made.json()) as { view: { item: { id: string } } }).view.item.id;
    await s.db.client.query({ sql: "UPDATE items SET state = 'accepted' WHERE id = ?", params: [id], method: "run" });
    const now = Date.now();
    await Promise.all([1, 2, 3].map(() => s.inbox.caps.connectors.payments.ensure(id, now)));
    expect(s.stripe.links.size).toBe(1);
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM connector_payments WHERE item_id = ?",
      params: [id],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(1);
  });

  it("a second payment for a paid order is the owner's to refund, and they are told", async () => {
    const s = await setup();
    await connectStripe(s);
    const id = await acceptedOrder(s);
    await drain(s, 60_000);
    const [first] = [...s.stripe.links.values()];
    // The total changed and a new link went out; the customer pays the new one, then the old one too.
    await s.db.client.query({
      sql: "UPDATE items SET payload = json_set(payload, '$.totalPrice.value', 4600) WHERE id = ?",
      params: [id],
      method: "run",
    });
    await s.inbox.caps.connectors.payments.ensure(id, Date.now());
    const second = [...s.stripe.links.values()][1];
    await s.inbox.app.request(await s.stripe.pay(second?.id ?? ""));
    expect((await itemOf(s.db, id)).state).toBe("paid");
    // A checkout begun on the old link before it was switched off completes.
    if (first) first.active = true;
    await s.inbox.app.request(await s.stripe.pay(first?.id ?? ""));
    await drain(s, 60_000);
    const told = s.mail.sent.find((m) => m.subject.endsWith("was paid twice"));
    expect(told?.text).toContain("A second payment of €45.00 arrived for order");
    expect(told?.text).toContain("Refund it in Stripe: https://dashboard.stripe.com/payments/pi_");
    expect((await itemOf(s.db, id)).payload.paidAmount).toEqual({ value: 4600, currency: "EUR" });
  });
});
