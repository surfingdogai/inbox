import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { agentPayWords, customerCopyProblems, type Db } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { STRIPE_LIVE_KEY, STRIPE_TEST_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { createInbox } from "../src/app";
import { confirmed, freshDb } from "./harness";
import { stripePlatform } from "./pay-platforms";

/**
 * A customer's assistant pays an accepted order directly (ADR-042), end to end through the doors an
 * owner and an assistant use: the owner switches it on in person on the Stripe connection (the key is
 * asked for PaymentIntents: Write, and the profile assistants pay through is given); an order the
 * business accepted says on its status how to pay it; the assistant sends the one-time token its
 * platform got, and it is charged once, on the business's own Stripe account, for exactly the total the
 * customer confirmed; the order is paid, its receipt says so, and its link is closed. Stripe is a fake
 * at the fetch level that keeps state as the real one does. The businesses are made up.
 */
const BASE = "https://inbox.fjordbrod.example";
const SECRET_KEY = "agent-pay-test-secret-0123456789abcdef";
const PROFILE_LIVE = "profile_1FjordLive00001";
const PROFILE_TEST = "profile_test_1Fjord0001";

async function setup(opts: { stripeKey?: string; testMode?: boolean } = {}) {
  const db = await freshDb();
  const stripe = stripePlatform(opts.stripeKey ?? STRIPE_LIVE_KEY, BASE);
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    fetchImpl: stripe.fetch,
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
        business: { name: "Fjordbrød Bakery" },
        email: { fromAddress: "orders@fjordbrod.example" },
        notifications: { ownerEmail: "ingrid@fjordbrod.example", appUrl: BASE },
        ...(opts.testMode ? { testMode: true } : {}),
      },
    },
    owner,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  return { db, inbox, call, owner, stripe, pending };
}
type S = Awaited<ReturnType<typeof setup>>;

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

async function connectStripe(s: S, key = STRIPE_LIVE_KEY) {
  const res = await s.call("POST", "/v1/owner/integrations", { kind: "stripe", values: { api_key: key } }, s.owner);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function agentPay(s: S, id: string, patch: Record<string, unknown>, headers = s.owner) {
  return s.call("PATCH", `/v1/owner/integrations/${id}`, patch, headers);
}

/** Stripe connected, and assistants' payments switched on by the owner. */
async function ready(s: S, key = STRIPE_LIVE_KEY) {
  const id = await connectStripe(s, key);
  const on = await agentPay(s, id, {
    agent_pay: true,
    agent_profile: key === STRIPE_LIVE_KEY ? PROFILE_LIVE : PROFILE_TEST,
  });
  expect(on.status, await on.clone().text()).toBe(200);
  expect(((await on.json()) as { agent_pay: { on: boolean } }).agent_pay.on).toBe(true);
  await drain(s);
  return id;
}

const tokens = new Map<string, string>();

/** A customer's order through the public door, confirmed by its person; accepted by the owner unless asked not to. */
async function order(s: S, opts: { value?: number; accept?: boolean } = {}) {
  const value = opts.value ?? 18900;
  const made = await confirmed(
    (r) => s.inbox.app.request(r),
    new Request(`${BASE}/v1/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          orderedItem: [{ name: "Sourdough loaf", quantity: 3, price: { value: value / 3, currency: "NOK" } }],
          totalPrice: { value, currency: "NOK" },
        },
        contact: { name: "Solveig", email: "solveig@example.com", locale: "en" },
      }),
    }),
  );
  expect(made.status, await made.clone().text()).toBe(201);
  const body = (await made.json()) as { view: { item: { id: string } }; accessToken: string };
  const id = body.view.item.id;
  tokens.set(id, body.accessToken);
  if (opts.accept !== false) {
    const accepted = await s.call("POST", `/v1/owner/items/${id}/transitions`, { event: "accept" }, s.owner);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    await drain(s, 60_000);
  }
  return id;
}

interface Status {
  item: { state: string };
  agreed: { terms_sha: string } | null;
  next: { action: string; label: string }[];
  payment?: {
    state: string;
    amount: { value: number; currency: string };
    payment_url: string | null;
    agent: {
      handler: string;
      business_profile: string;
      environment: string;
      amount: { value: number; currency: string };
      platform_amount: { value: number; currency: string } | null;
      terms_sha: string;
      binding_id: string;
    } | null;
    human: string;
  };
  receipts: { payload?: Record<string, unknown>; kind?: string }[];
}

async function status(s: S, id: string): Promise<Status> {
  const res = await s.call("GET", `/v1/items/${id}?access_token=${tokens.get(id)}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Status;
}

/** The idempotency key an assistant keeps for a payment: its own, never the token. */
const keys = new Map<string, string>();
const keyFor = (token: string) => {
  if (!keys.has(token)) keys.set(token, `pay-${keys.size + 1}`);
  return keys.get(token) as string;
};

/** The assistant pays: its platform's token, the terms its person confirmed, and a key it keeps. */
async function pay(
  s: S,
  id: string,
  token: string,
  opts: {
    termsSha?: string | undefined;
    key?: string;
    headers?: Record<string, string>;
    accessToken?: string | null | undefined;
  } = {},
) {
  const terms = opts.termsSha ?? (await status(s, id)).agreed?.terms_sha;
  return s.call(
    "POST",
    `/v1/items/${id}/pay`,
    {
      ...(opts.accessToken === null ? {} : { access_token: opts.accessToken ?? tokens.get(id) }),
      terms_sha: terms,
      payment: { handler: "stripe_spt", token },
    },
    { "idempotency-key": opts.key ?? keyFor(token), ...(opts.headers ?? {}) },
  );
}

async function itemOf(db: Db, id: string) {
  const { rows } = await db.client.query({
    sql: "SELECT state, payload FROM items WHERE id = ?",
    params: [id],
    method: "all",
  });
  return { state: String(rows[0]?.[0]), payload: JSON.parse(String(rows[0]?.[1])) as Record<string, unknown> };
}

/** The charges Stripe was asked for since `ready` (switching on asks once, with a request that makes nothing). */
const intentCalls = (s: S) => s.stripe.calls.filter((c) => c === "POST /v1/payment_intents").slice(1);
/** Money as the customer reads it, with plain spaces. */
const plain = (text: string | undefined) => text?.replace(/\u00a0/g, " ");

describe("Settings → Stripe: letting customers' assistants pay directly", () => {
  it("is the owner's switch, in person: the key is asked for PaymentIntents: Write, and the profile is needed", async () => {
    const s = await setup();
    const id = await connectStripe(s);
    const view = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as {
      connections: { id: string; agent_pay: Record<string, unknown> | null }[];
    };
    expect(view.connections.find((c) => c.id === id)?.agent_pay).toEqual({
      on: false,
      profile: null,
      missing: [],
      stopped: null,
      paid: 0,
    });
    // Without the profile assistants pay through, nothing is switched on.
    const noProfile = await agentPay(s, id, { agent_pay: true });
    expect(noProfile.status).toBe(422);
    expect(await noProfile.text()).toContain("agent_profile");
    // A key without the permission: named, and nothing written.
    s.stripe.agent.allowed = false;
    const missing = await agentPay(s, id, { agent_pay: true, agent_profile: PROFILE_LIVE });
    expect(missing.status).toBe(200);
    expect(((await missing.json()) as { agent_pay: unknown }).agent_pay).toMatchObject({
      on: false,
      missing: ["PaymentIntents: Write"],
      profile: null,
    });
    // The owner's AI and an integration key are refused, whatever their scopes.
    const integration = await createApiKey(s.db, { kind: "integration", name: "Zapier", scopes: ["*"] });
    s.stripe.agent.allowed = true;
    const byKey = await agentPay(
      s,
      id,
      { agent_pay: true, agent_profile: PROFILE_LIVE },
      { authorization: `Bearer ${integration.key}` },
    );
    expect(byKey.status).toBe(403);
    // A profile is Stripe's: it starts with profile_.
    expect((await agentPay(s, id, { agent_pay: true, agent_profile: "acct_1Fjord" })).status).toBe(422);
    const on = await agentPay(s, id, { agent_pay: true, agent_profile: PROFILE_LIVE });
    expect(((await on.json()) as { agent_pay: unknown }).agent_pay).toMatchObject({
      on: true,
      profile: PROFILE_LIVE,
      missing: [],
    });
    // The probe made nothing in Stripe.
    expect(s.stripe.intents.size).toBe(0);
    const off = await agentPay(s, id, { agent_pay: false });
    expect(((await off.json()) as { agent_pay: unknown }).agent_pay).toMatchObject({
      on: false,
      profile: PROFILE_LIVE,
    });
  });

  it("the profile says the business takes assistants' payments only while the switch is on", async () => {
    const s = await setup();
    const id = await connectStripe(s);
    const profile = async () =>
      ((await (await s.call("GET", "/v1/business")).json()) as { payments?: string[] }).payments ?? [];
    expect(await profile()).not.toContain("acp_delegated");
    await agentPay(s, id, { agent_pay: true, agent_profile: PROFILE_LIVE });
    expect(await profile()).toContain("acp_delegated");
    await agentPay(s, id, { agent_pay: false });
    expect(await profile()).not.toContain("acp_delegated");
  });
});

describe("an accepted order, paid by the customer's assistant into the business's own Stripe", () => {
  it("is charged once, for exactly the confirmed total: the order is paid, its receipt says so, and its link is closed", async () => {
    const s = await setup();
    await ready(s);
    const id = await order(s);
    const before = await status(s, id);
    expect(before.item.state).toBe("awaiting_payment");
    expect(before.payment).toMatchObject({
      state: "due",
      amount: { value: 18900, currency: "NOK" },
      agent: {
        handler: "stripe_spt",
        business_profile: PROFILE_LIVE,
        environment: "livemode",
        amount: { value: 18900, currency: "NOK" },
        platform_amount: { value: 18900, currency: "nok" },
        terms_sha: before.agreed?.terms_sha,
        binding_id: id,
      },
    });
    expect(before.payment?.payment_url).toMatch(/^https:\/\/buy\.stripe\.com\//);
    expect(before.next[0]).toEqual({ action: "pay_order", label: "Pay now" });
    expect(plain(before.payment?.human)).toBe("You can pay Fjordbrød Bakery now: NOK 189.00.");

    const token = s.stripe.grantToken({ maxAmount: 18900, currency: "nok" });
    const paid = await pay(s, id, token);
    expect(paid.status, await paid.clone().text()).toBe(200);
    const body = (await paid.json()) as { state: string; human: string; view: Status; replayed: boolean };
    expect(body).toMatchObject({ state: "paid", replayed: false });
    expect(plain(body.human)).toBe("Paid, thank you: NOK 189.00.");
    expect(body.view.item.state).toBe("paid");
    // One PaymentIntent, for the total, on the business's own account, named by the order.
    const [pi] = [...s.stripe.intents.values()];
    expect(s.stripe.intents.size).toBe(1);
    expect(pi).toMatchObject({ amount: 18900, currency: "nok", status: "succeeded" });
    expect(pi?.metadata).toMatchObject({ sdi_item: id, sdi_order: id.slice(-6).toUpperCase() });
    // The order is paid as a link's payment is: by the connector, with the payment's id.
    await drain(s, 60_000);
    const after = await itemOf(s.db, id);
    expect(after.state).toBe("paid");
    expect(after.payload.paymentRef).toBe(pi?.id);
    const receipts = (await status(s, id)).receipts;
    expect(JSON.stringify(receipts)).toContain('"paid"');
    // The link made at acceptance no longer takes a payment.
    expect([...s.stripe.links.values()].every((l) => !l.active)).toBe(true);
    // The owner sees it on the order, with the payment's page in Stripe.
    const owner = (await (await s.call("GET", `/v1/owner/items/${id}/payments`, undefined, s.owner)).json()) as {
      agent_payments: Record<string, unknown>[];
    };
    expect(owner.agent_payments).toMatchObject([
      {
        via: "agent",
        state: "paid",
        amount: { value: 18900, currency: "NOK" },
        payment_id: pi?.id,
        dashboard_url: `https://dashboard.stripe.com/payments/${pi?.id}`,
      },
    ]);

    // The same request again is answered, never charged again; the same token under another key too.
    const again = await pay(s, id, token);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
    const otherKey = await pay(s, id, token, { key: "another-key", termsSha: before.agreed?.terms_sha });
    expect(otherKey.status).toBe(409);
    expect(((await otherKey.json()) as { code: string }).code).toBe("already_paid");
    expect(intentCalls(s)).toHaveLength(1);

    // The token is never kept, anywhere: only its hash.
    const { rows: tables } = await s.db.client.query({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
      method: "all",
    });
    for (const [name] of tables) {
      const { rows } = await s.db.client.query({ sql: `SELECT * FROM "${String(name)}"`, method: "all" });
      expect([String(name), JSON.stringify(rows).includes(token)]).toEqual([String(name), false]);
    }
  });

  it("says nothing of paying before the order is accepted, and refuses to charge it", async () => {
    const s = await setup();
    await ready(s);
    const id = await order(s, { accept: false });
    const before = await status(s, id);
    expect(before.payment).toBeUndefined();
    expect(before.next.map((n) => n.action)).not.toContain("pay_order");
    const token = s.stripe.grantToken({ maxAmount: 18900, currency: "nok" });
    const early = await s.call(
      "POST",
      `/v1/items/${id}/pay`,
      {
        access_token: tokens.get(id),
        terms_sha: "A".repeat(43),
        payment: { handler: "stripe_spt", token },
      },
      { "idempotency-key": "early" },
    );
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: "not_accepted_yet", details: { waiting_on: "us" } });
    expect(intentCalls(s)).toHaveLength(0);
  });

  it("refuses before Stripe is asked anything: other terms, no key to retry with, the business's own key, someone else's order", async () => {
    const s = await setup();
    await ready(s);
    const id = await order(s);
    const token = s.stripe.grantToken({ maxAmount: 18900, currency: "nok" });
    const changed = await pay(s, id, token, { termsSha: "B".repeat(43) });
    expect(changed.status).toBe(409);
    const problem = (await changed.json()) as { code: string; details: { terms_sha: string } };
    expect(problem.code).toBe("terms_changed");
    expect(problem.details.terms_sha).toBe((await status(s, id)).agreed?.terms_sha);
    const terms = (await status(s, id)).agreed?.terms_sha;
    const noKey = await s.call("POST", `/v1/items/${id}/pay`, {
      access_token: tokens.get(id),
      terms_sha: terms,
      payment: { handler: "stripe_spt", token },
    });
    expect(noKey.status).toBe(422);
    expect(await noKey.text()).toContain("idempotency_key");
    // The business's own key never pays its customer's order.
    const ownerPays = await pay(s, id, token, { headers: s.owner, accessToken: null });
    expect(ownerPays.status).toBe(403);
    // Another customer's order is not theirs to pay.
    const other = await order(s);
    const theirs = await pay(s, other, token, { accessToken: tokens.get(id), termsSha: terms });
    expect(theirs.status).toBe(403);
    // Not a card number, nor anything but a token.
    const card = await pay(s, id, "4242 4242 4242 4242");
    expect(card.status).toBe(422);
    expect(intentCalls(s)).toHaveLength(0);
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");
  });

  it("a declined card charges nothing and leaves the order as it was; a new token pays it", async () => {
    const s = await setup();
    await ready(s);
    const id = await order(s);
    const declined = await pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok", outcome: "declined" }));
    expect(declined.status).toBe(402);
    const problem = (await declined.json()) as { code: string; detail: string; details: Record<string, unknown> };
    expect(problem.code).toBe("payment_declined");
    expect(problem.details).toEqual({
      human: "The payment did not go through: the card was declined. Nothing was charged.",
      attempts_left: 4,
    });
    // Stripe's own decline code is the owner's to read, never the assistant's.
    expect(JSON.stringify(problem)).not.toContain("insufficient_funds");
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");
    const owner = (await (await s.call("GET", `/v1/owner/items/${id}/payments`, undefined, s.owner)).json()) as {
      agent_payments: { state: string; failure: string; error: string }[];
    };
    expect(owner.agent_payments[0]).toMatchObject({ state: "declined", failure: "declined" });
    expect(owner.agent_payments[0]?.error).toContain("insufficient_funds");
    // Due again, and payable with another card.
    expect((await status(s, id)).payment?.agent).not.toBeNull();
    const paid = await pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok" }));
    expect(paid.status).toBe(200);
    expect((await itemOf(s.db, id)).state).toBe("paid");
  });

  it("a card that asks its holder to confirm: the payment is stopped, and the person is given the link", async () => {
    const s = await setup();
    await ready(s);
    const id = await order(s);
    const link = (await status(s, id)).payment?.payment_url;
    const res = await pay(
      s,
      id,
      s.stripe.grantToken({ maxAmount: 18900, currency: "nok", outcome: "requires_action" }),
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      code: "authentication_required",
      details: {
        payment_url: link,
        human: "Your card asks you to confirm this payment yourself: pay at this link.",
      },
    });
    const [pi] = [...s.stripe.intents.values()];
    expect(pi?.status).toBe("canceled");
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");
  });

  it("a token Stripe will not take says why: another mode's or another business's, expired, used, below the total", async () => {
    const s = await setup();
    await ready(s);
    const id = await order(s);
    const codeOf = async (token: string, key: string) => {
      const res = await pay(s, id, token, { key });
      return [res.status, ((await res.json()) as { code: string }).code];
    };
    expect(
      await codeOf(s.stripe.grantToken({ maxAmount: 18900, currency: "nok", profile: "profile_1Other" }), "a"),
    ).toEqual([422, "token_invalid"]);
    expect(await codeOf(s.stripe.grantToken({ maxAmount: 18900, currency: "nok", livemode: false }), "b")).toEqual([
      422,
      "token_invalid",
    ]);
    expect(
      await codeOf(s.stripe.grantToken({ maxAmount: 18900, currency: "nok", expiresAt: Date.now() - 1 }), "c"),
    ).toEqual([422, "token_expired"]);
    expect(
      await codeOf(s.stripe.grantToken({ maxAmount: 18900, currency: "nok", deactivated: "revoked" }), "d"),
    ).toEqual([422, "token_used"]);
    expect(await codeOf(s.stripe.grantToken({ maxAmount: 18000, currency: "nok" }), "e")).toEqual([422, "token_limit"]);
    expect(await codeOf(s.stripe.grantToken({ maxAmount: 18900, currency: "eur" }), "f")).toEqual([422, "token_limit"]);
    // What the assistant echoes of the token can only refuse, before Stripe is asked.
    const calls = intentCalls(s).length;
    const echoed = await s.call(
      "POST",
      `/v1/items/${id}/pay`,
      {
        access_token: tokens.get(id),
        terms_sha: (await status(s, id)).agreed?.terms_sha,
        payment: {
          handler: "stripe_spt",
          token: s.stripe.grantToken({ maxAmount: 18900, currency: "nok" }),
          allowance: { max_amount: 100, currency: "nok" },
        },
      },
      { "idempotency-key": "echo" },
    );
    expect(((await echoed.json()) as { code: string }).code).toBe("token_limit");
    expect(intentCalls(s)).toHaveLength(calls);
    expect((await itemOf(s.db, id)).state).toBe("awaiting_payment");
  });

  it("two payments at once make one charge, and a platform that does not answer is asked again under the same key", async () => {
    const s = await setup();
    await ready(s);
    const id = await order(s);
    const terms = (await status(s, id)).agreed?.terms_sha;
    const [a, b] = await Promise.all([
      pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok" }), { termsSha: terms }),
      pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok" }), { termsSha: terms }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = (await (a.status === 409 ? a : b).json()) as { code: string };
    expect(["in_progress", "already_paid"]).toContain(loser.code);
    expect([...s.stripe.intents.values()].filter((p) => p.status === "succeeded")).toHaveLength(1);

    // Stripe down: nothing is charged twice when it answers again.
    const next = await order(s);
    const token = s.stripe.grantToken({ maxAmount: 18900, currency: "nok" });
    s.stripe.agent.down = 500;
    const down = await pay(s, next, token, { key: "same" });
    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBeTruthy();
    expect(((await down.json()) as { code: string }).code).toBe("platform_unavailable");
    s.stripe.agent.down = null;
    const retried = await pay(s, next, token, { key: "same" });
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await itemOf(s.db, next)).state).toBe("paid");
  });

  it("a payment that settles later is on its way until the sync hears it went through", async () => {
    const s = await setup();
    const conn = await ready(s);
    const id = await order(s);
    const res = await pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok", outcome: "processing" }));
    expect(res.status).toBe(202);
    expect(((await res.json()) as { state: string }).state).toBe("processing");
    expect((await status(s, id)).payment).toMatchObject({ state: "processing", agent: null });
    const [pi] = [...s.stripe.intents.keys()];
    s.stripe.settle(pi ?? "", "succeeded");
    await s.inbox.caps.connectors.run(conn, Date.now() + 10 * 60_000, "sync");
    await drain(s, 60_000);
    expect((await itemOf(s.db, id)).state).toBe("paid");
  });

  it("after five declined cards in a day an order takes no more tries: the person is sent to the link", async () => {
    const s = await setup();
    await ready(s);
    const id = await order(s);
    for (let i = 0; i < 5; i++) {
      const res = await pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok", outcome: "declined" }));
      expect(res.status).toBe(402);
    }
    const asked = intentCalls(s).length;
    const sixth = await pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok" }));
    expect(sixth.status).toBe(429);
    expect(((await sixth.json()) as { code: string }).code).toBe("too_many_attempts");
    expect(intentCalls(s)).toHaveLength(asked);
  });

  it("a payment that went through after the order was cancelled is kept, and the owner told where to refund it", async () => {
    const s = await setup();
    const conn = await ready(s);
    const id = await order(s);
    const res = await pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok", outcome: "processing" }));
    expect(res.status).toBe(202);
    const cancelled = await s.call(
      "POST",
      `/v1/owner/items/${id}/transitions`,
      { event: "cancel", input: { note: "Out of flour today." } },
      s.owner,
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const [pi] = [...s.stripe.intents.keys()];
    s.stripe.settle(pi ?? "", "succeeded");
    await s.inbox.caps.connectors.run(conn, Date.now() + 10 * 60_000, "sync");
    expect((await itemOf(s.db, id)).state).toBe("cancelled");
    const owner = (await (await s.call("GET", `/v1/owner/items/${id}/payments`, undefined, s.owner)).json()) as {
      agent_payments: { state: string; note: string | null; dashboard_url: string | null }[];
    };
    expect(owner.agent_payments[0]).toMatchObject({
      state: "paid",
      dashboard_url: `https://dashboard.stripe.com/payments/${pi}`,
    });
    expect(owner.agent_payments[0]?.note).toContain("refund it in Stripe");
    const detail = await (await s.call("GET", `/v1/owner/items/${id}`, undefined, s.owner)).text();
    expect(detail).toContain("refund it in Stripe");
  });

  it("a key that lost its permission switches it off, sends assistants to the link, and tells the owner", async () => {
    const s = await setup();
    const conn = await ready(s);
    const id = await order(s);
    s.stripe.agent.allowed = false;
    const res = await pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "agent_pay_unavailable", details: { reason: "connection" } });
    const view = (await (await s.call("GET", "/v1/owner/integrations", undefined, s.owner)).json()) as {
      connections: { id: string; agent_pay: { on: boolean; stopped: string | null } }[];
    };
    const tile = view.connections.find((c) => c.id === conn)?.agent_pay;
    expect(tile?.on).toBe(false);
    expect(tile?.stopped).toContain("PaymentIntents: Write");
    expect((await status(s, id)).payment).toMatchObject({ state: "due", agent: null });
  });

  it("a test order is paid only on the test key, with a test token; a real one never with a test key", async () => {
    const s = await setup({ stripeKey: STRIPE_TEST_KEY, testMode: true });
    await ready(s, STRIPE_TEST_KEY);
    const id = await order(s);
    const st = await status(s, id);
    expect(st.payment?.agent).toMatchObject({ environment: "testmode", business_profile: PROFILE_TEST });
    const res = await pay(s, id, s.stripe.grantToken({ maxAmount: 18900, currency: "nok" }));
    expect(res.status, await res.clone().text()).toBe(200);
    // A real order has no live connection to pay it here.
    const live = await setup({ stripeKey: STRIPE_TEST_KEY });
    await ready(live, STRIPE_TEST_KEY);
    const real = await order(live);
    expect((await status(live, real)).payment?.agent ?? null).toBeNull();
    const refused = await pay(live, real, live.stripe.grantToken({ maxAmount: 18900, currency: "nok" }));
    expect(await refused.json()).toMatchObject({ code: "agent_pay_unavailable", details: { reason: "no_connection" } });
  });

  it("speaks to the customer in the business's words, never naming the software or a network", () => {
    expect(customerCopyProblems(agentPayWords("en"), "en")).toEqual([]);
    expect(customerCopyProblems(agentPayWords("pt"), "pt")).toEqual([]);
  });
});

describe("the MCP door", () => {
  async function connect(s: S) {
    const fetchLike = async (input: string | URL, init?: RequestInit) => s.inbox.app.request(String(input), init);
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: fetchLike });
    const client = new Client({ name: "test-agent", version: "0" });
    await client.connect(transport);
    return client;
  }

  it("has pay_order only while the business takes it, and pays as the REST door does", async () => {
    const s = await setup();
    const conn = await connectStripe(s);
    const before = await connect(s);
    expect((await before.listTools()).tools.map((t) => t.name)).not.toContain("pay_order");
    await agentPay(s, conn, { agent_pay: true, agent_profile: PROFILE_LIVE });
    const client = await connect(s);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("pay_order");
    const id = await order(s);
    const st = await client.callTool({
      name: "get_item_status",
      arguments: { item_id: id, access_token: tokens.get(id) },
    });
    const view = st.structuredContent as unknown as Status;
    expect(view.payment?.agent?.business_profile).toBe(PROFILE_LIVE);
    const declined = await client.callTool({
      name: "pay_order",
      arguments: {
        item_id: id,
        access_token: tokens.get(id),
        terms_sha: view.agreed?.terms_sha,
        payment: {
          handler: "stripe_spt",
          token: s.stripe.grantToken({ maxAmount: 18900, currency: "nok", outcome: "declined" }),
        },
        idempotency_key: "mcp-pay-1",
      },
    });
    expect(declined.isError).toBe(true);
    expect(JSON.stringify(declined.content)).toContain("Tell your person");
    const paid = await client.callTool({
      name: "pay_order",
      arguments: {
        item_id: id,
        access_token: tokens.get(id),
        terms_sha: view.agreed?.terms_sha,
        payment: { handler: "stripe_spt", token: s.stripe.grantToken({ maxAmount: 18900, currency: "nok" }) },
        idempotency_key: "mcp-pay-2",
      },
    });
    expect(paid.isError, JSON.stringify(paid.content)).toBeFalsy();
    expect(paid.structuredContent).toMatchObject({ state: "paid" });
    expect(plain((paid.structuredContent as { human: string }).human)).toBe("Paid, thank you: NOK 189.00.");
    expect((await itemOf(s.db, id)).state).toBe("paid");
  });
});
