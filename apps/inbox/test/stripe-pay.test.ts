import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import {
  type Caller,
  customerCopyProblems,
  MANIFEST_PATH,
  manifestSchema,
  stripePayOffer,
  stripePayWords,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { confirmed, freshDb } from "./harness";

/**
 * Stripe Pay (ADR-045), end to end through the doors an owner and a customer's assistant use: the owner sets the
 * business's own Stripe handle in person; the manifest and the business profile say it; an order the business
 * accepted shows how to pay it by Stripe Pay, for exactly its total in its currency, with its reference, and the
 * customer's email says the same; nothing here sees the transfer, so the owner records the payment, and the order is
 * paid. The businesses are made up.
 */
const BASE = "https://inbox.harbour.example";
const SECRET_KEY = "stripe-pay-test-secret-0123456789abcdef";
const T0 = Date.UTC(2026, 9, 31, 10, 0, 0);
const inPerson: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup(stripePay: { to: string; currencies: string[] } | null = { to: "@harbour", currencies: ["GBP"] }) {
  const db = await freshDb();
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
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
  await inbox.caps.updateSettings(inPerson, {
    doc: {
      business: { name: "Harbour Coffee", currency: "GBP" },
      email: { fromAddress: "orders@harbour.example" },
      notifications: { ownerEmail: "owner@harbour.example", appUrl: BASE },
      payments: { accepted: ["card"], ...(stripePay ? { stripePay } : {}) },
    },
  });
  const drain = async () => {
    await Promise.all(pending);
    for (const ahead of [0, 60_000]) {
      for (let pass = 0; pass < 20; pass++) {
        if ((await inbox.runner.runDue(db, { now: Date.now() + ahead })).claimed === 0) break;
      }
    }
  };
  return { db, inbox, call, owner, drain };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A customer's order through the public door, confirmed by its person, accepted by the owner unless asked not to. */
async function order(s: S, opts: { currency?: string; accept?: boolean } = {}) {
  const currency = opts.currency ?? "GBP";
  const made = await confirmed(
    (r) => s.inbox.app.request(r),
    new Request(`${BASE}/v1/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          orderedItem: [{ name: "Coffee beans, 1 kg", quantity: 2, price: { value: 1450, currency } }],
          totalPrice: { value: 2900, currency },
        },
        contact: { name: "Rowan", email: "rowan@example.com", locale: "en" },
      }),
    }),
  );
  expect(made.status, await made.clone().text()).toBe(201);
  const body = (await made.json()) as { view: { item: { id: string } }; accessToken: string };
  const id = body.view.item.id;
  if (opts.accept !== false) {
    const accepted = await s.call("POST", `/v1/owner/items/${id}/transitions`, { event: "accept" }, s.owner);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    await s.drain();
  }
  return { id, token: body.accessToken };
}

interface PayTo {
  method: string;
  label: string;
  to: string;
  amount: { value: number; currency: string };
  reference: string;
  confirm: string[];
  marked_paid_by: string;
  human: string;
}

async function payment(s: S, o: { id: string; token: string }) {
  const res = await s.call("GET", `/v1/items/${o.id}?access_token=${o.token}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { payment?: { state: string; human: string; pay_to?: PayTo[] } }).payment;
}

describe("Stripe Pay", () => {
  it("is said in the manifest and the business profile, with the handle the owner gave", async () => {
    const s = await setup({ to: "@harbour", currencies: ["USD", "GBP"] });
    const res = await s.inbox.app.request(`${BASE}${MANIFEST_PATH}`);
    const m = manifestSchema.parse(await res.json());
    expect(m.profile?.payments).toEqual(["card", "stripe_pay"]);
    expect(m.profile?.pay_to).toEqual([{ method: "stripe_pay", to: "@harbour", currencies: ["USD", "GBP"] }]);
    const profile = await s.inbox.caps.getBusinessProfile();
    expect(profile.pay_to?.[0]?.to).toBe("@harbour");
  });

  it("is offered on an accepted order for exactly its total and reference, and the email says it", async () => {
    const s = await setup();
    const o = await order(s);
    const p = await payment(s, o);
    expect(p?.state).toBe("due");
    const reference = o.id.slice(-6).toUpperCase();
    expect(p?.pay_to).toEqual([
      {
        method: "stripe_pay",
        label: "Stripe Pay",
        to: "@harbour",
        amount: { value: 2900, currency: "GBP" },
        reference,
        confirm: ["to", "amount", "currency"],
        marked_paid_by: "business",
        human: `You can pay with Stripe Pay to @harbour: £29.00, reference ${reference}. We mark it paid once it reaches us.`,
      },
    ]);
    expect(p?.human).toContain("You can pay with Stripe Pay to @harbour");
    const { rows } = await s.db.client.query({
      sql: "SELECT template, body_text FROM outbound_mail WHERE item_id = ? AND recipient = 'customer'",
      params: [o.id],
      method: "all",
    });
    const accepted = rows.find((r) => r[0] === "order.accepted");
    expect(String(accepted?.[1])).toContain(`You can pay with Stripe Pay to @harbour: £29.00, reference ${reference}.`);
  });

  it("is not offered before acceptance, in a currency the business does not take there, or once paid", async () => {
    const s = await setup();
    expect((await payment(s, await order(s, { accept: false })))?.pay_to).toBeUndefined();
    expect((await payment(s, await order(s, { currency: "EUR" })))?.pay_to).toBeUndefined();
    // Nothing here sees the transfer: the owner records it, and the order is paid.
    const o = await order(s);
    const paid = await s.call(
      "POST",
      `/v1/owner/items/${o.id}/transitions`,
      { event: "record_payment", input: { paymentRef: "Stripe Pay from @rowan-ltd", method: "stripe_pay" } },
      s.owner,
    );
    expect(paid.status, await paid.clone().text()).toBe(200);
    const after = await payment(s, o);
    expect(after?.state).toBe("paid");
    expect(after?.pay_to).toBeUndefined();
  });

  it("is never offered while the owner has not set it", async () => {
    const s = await setup(null);
    const p = await payment(s, await order(s));
    expect(p?.state).toBe("due");
    expect(p?.pay_to).toBeUndefined();
  });

  it("tells an assistant what to confirm with its person, and who marks it paid", async () => {
    const s = await setup();
    const o = await order(s);
    const fetchLike = async (input: string | URL, init?: RequestInit) => s.inbox.app.request(String(input), init);
    const client = new Client({ name: "test-agent", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: fetchLike }));
    expect(client.getInstructions()).toContain("This business also takes Stripe Pay");
    const st = await client.callTool({ name: "get_item_status", arguments: { item_id: o.id, access_token: o.token } });
    const text = JSON.stringify(st.content);
    expect(text).toContain(`Pay with Stripe Pay to @harbour: £29.00 (GBP), reference ${o.id.slice(-6).toUpperCase()}.`);
    expect(text).toContain("Confirm the recipient, the amount and the currency with your person before sending");
    const profile = await client.callTool({ name: "get_business_profile", arguments: {} });
    expect(JSON.stringify(profile.content)).toContain("Paid to: Stripe Pay to @harbour (GBP).");
  });

  it("is never offered for a test order, which would be paid with real money", () => {
    const setting = { to: "@harbour", currencies: ["GBP"] };
    const total = { value: 2900, currency: "GBP" };
    expect(stripePayOffer({ id: "01JTEST0000000ABCDEF", total, sandbox: true }, setting, "en")).toBeNull();
    expect(
      stripePayOffer({ id: "01JTEST0000000ABCDEF", total: { ...total, value: 0 }, sandbox: false }, setting, "en"),
    ).toBeNull();
    expect(stripePayOffer({ id: "01JTEST0000000ABCDEF", total, sandbox: false }, setting, "pt")?.human).toMatch(
      /^Pode pagar com Stripe Pay para @harbour: 29,00\s£, referência ABCDEF\. Marcamo-lo como pago assim que nos chegar\.$/,
    );
  });

  it("speaks to the customer in the business's words, never naming the software or a network", () => {
    expect(customerCopyProblems(stripePayWords("en"), "en")).toEqual([]);
    expect(customerCopyProblems(stripePayWords("pt"), "pt")).toEqual([]);
  });
});
