import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * Withdrawal, returns and the confirm step through the doors as the app serves them (ADR-018 §5–§7):
 * the customer's assistant is shown the summary before a priced order binds, withdraws in two steps,
 * asks to send goods back; the owner opens a return a customer phoned in; the business's profile
 * says its return policy. REST and MCP answer alike. Runs on Node and in workerd.
 */
const BASE = "https://inbox.example.com";

async function setup(doc: Record<string, unknown> = {}) {
  const db = await freshDb();
  const now = Date.now();
  const prod = ulid();
  await db.orm.insert(schema.products).values({
    id: prod,
    sku: "CH-9",
    name: "Chain",
    price: { value: 1850, currency: "EUR" },
    active: 1,
    createdAt: now,
    updatedAt: now,
  });
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    baseUrl: BASE,
    secretKey: "returns-doors-test-secret-0123456789",
    background: () => {},
  });
  const key = await createApiKey(db, { kind: "owner", name: "t" });
  const owner = { authorization: `Bearer ${key.key}` };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const saved = await call("PUT", "/v1/owner/settings", { doc: { returns: { respondHours: 24 }, ...doc } }, owner);
  expect(saved.status).toBe(200);
  const mcp = async (path: "/mcp" | "/mcp/owner") => {
    const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const merged = new Headers(init?.headers);
      if (path === "/mcp/owner") merged.set("authorization", owner.authorization);
      return inbox.app.request(String(input), { ...init, headers: merged });
    };
    const client = new Client({ name: "test-agent", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), { fetch: fetchLike }));
    return client;
  };
  return { db, prod, call, owner, mcp };
}

type Json = Record<string, unknown>;
const json = async (r: Response) => (await r.json()) as Json;

/** An order for three chains, confirmed at the confirm step, accepted, paid and delivered. */
async function delivered(s: Awaited<ReturnType<typeof setup>>) {
  const order = {
    payload: {
      orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 3, price: { value: 1, currency: "EUR" } }],
      totalPrice: { value: 3, currency: "EUR" },
    },
    contact: { name: "Rita", email: "rita@example.com", locale: "en" },
    idempotency_key: "order-1",
  };
  const asked = await s.call("POST", "/v1/orders", order);
  expect(asked.status).toBe(409);
  const problem = await json(asked);
  expect(problem.code).toBe("confirm_terms");
  const details = problem.details as { summary: string; terms_sha: string; obligation_to_pay: boolean };
  expect(details.summary).toMatch(/^Please check before you confirm: 3 × Chain — €55\.50\. Total €55\.50\./);
  expect(details.obligation_to_pay).toBe(true);
  const created = await s.call("POST", "/v1/orders", { ...order, terms_sha: details.terms_sha });
  expect(created.status).toBe(201);
  const { view, accessToken } = (await created.json()) as { view: { item: { id: string } }; accessToken: string };
  const id = view.item.id;
  for (const [event, input] of [
    ["accept", undefined],
    ["record_payment", { paymentRef: "pi_1", amount: { value: 5550, currency: "EUR" } }],
    ["fulfil", { deliveredAt: new Date(Date.now() - 60_000).toISOString() }],
  ] as const) {
    const moved = await s.call("POST", `/v1/owner/items/${id}/transitions`, { event, input }, s.owner);
    expect(moved.status, event).toBe(200);
  }
  return { id, token: accessToken };
}

describe("returns through the REST doors", () => {
  it("say the return policy, and withdraw in two steps: the statement, then the withdrawal", async () => {
    const s = await setup({ returns: { days: 30, postage: "business" }, commerce: { legal: { country: "PT" } } });
    const business = await json(await s.call("GET", "/v1/business"));
    expect(business.item_types).toContain("refund");
    expect(business.return_policy).toEqual({
      "@type": "MerchantReturnPolicy",
      returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
      merchantReturnDays: 30,
      returnMethod: "https://schema.org/ReturnByMail",
      returnFees: "https://schema.org/FreeReturn",
      itemDefectReturnFees: "https://schema.org/FreeReturn",
      refundType: "https://schema.org/FullRefund",
      returnPolicyCountry: "PT",
    });

    const o = await delivered(s);
    const status = await json(await s.call("GET", `/v1/items/${o.id}?access_token=${o.token}`));
    // Portuguese law, and a customer who writes in English: the EU's words, in English.
    expect(status.withdrawal).toMatchObject({ available: true, label: "Withdraw from contract here" });

    const first = await s.call("POST", `/v1/items/${o.id}/withdraw`, { access_token: o.token });
    expect(first.status).toBe(409);
    const statement = ((await json(first)).details as { statement: Json }).statement;
    expect(statement).toMatchObject({ available: true, email: "rita@example.com", confirm: "Confirm withdrawal" });

    const done = await s.call("POST", `/v1/items/${o.id}/withdraw`, {
      access_token: o.token,
      confirm_withdrawal: true,
      lines: [{ index: 0, quantity: 1 }],
      idempotency_key: "withdraw-1",
    });
    expect(done.status).toBe(200);
    const body = (await done.json()) as {
      view: { item: { state: string } };
      linked: { item: { id: string; payload: Json } };
    };
    expect(body.view.item.state).toBe("fulfilled");
    expect(body.linked.item.payload).toMatchObject({
      kind: "withdrawal",
      amount: { value: 1850, currency: "EUR" },
      goodsBack: true,
    });
    // The same request again is the same answer.
    const again = await s.call("POST", `/v1/items/${o.id}/withdraw`, {
      access_token: o.token,
      confirm_withdrawal: true,
      lines: [{ index: 0, quantity: 1 }],
      idempotency_key: "withdraw-1",
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
    const after = await json(await s.call("GET", `/v1/items/${o.id}?access_token=${o.token}`));
    expect(after.refunds).toEqual([
      {
        item_id: body.linked.item.id,
        reference: body.linked.item.id.slice(-6).toUpperCase(),
        state: "approved",
        human: expect.stringMatching(/^Your return "3 × Chain" is agreed: please send it back by /),
      },
    ]);
  });

  it("ask for a return (201), and the owner opens one a customer phoned in", async () => {
    const s = await setup();
    const o = await delivered(s);
    const asked = await s.call("POST", `/v1/items/${o.id}/returns`, {
      access_token: o.token,
      reason: "faulty",
      note: "One link is cracked",
    });
    expect(asked.status).toBe(201);
    const r = (await asked.json()) as { linked: { item: { state: string; payload: Json } } };
    expect(r.linked.item).toMatchObject({ state: "requested", payload: { kind: "faulty" } });
    // One open at a time.
    const twice = await s.call("POST", `/v1/items/${o.id}/returns`, { access_token: o.token, reason: "faulty" });
    expect(twice.status).toBe(409);

    const other = await s.call("POST", "/v1/orders", {
      payload: {
        orderedItem: [{ name: "Custom frame", quantity: 1, price: { value: 900, currency: "EUR" } }],
        totalPrice: { value: 900, currency: "EUR" },
      },
      contact: { email: "ana@example.com" },
    });
    const otherId = ((await other.json()) as { view: { item: { id: string } } }).view.item.id;
    for (const event of ["accept", "fulfil"]) {
      await s.call("POST", `/v1/owner/items/${otherId}/transitions`, { event }, s.owner);
    }
    const opened = await s.call(
      "POST",
      `/v1/owner/items/${otherId}/returns`,
      { reason: "wrong_item", note: "She rang: the frame is the wrong size" },
      { ...s.owner, "idempotency-key": "open-1" },
    );
    expect(opened.status).toBe(201);
    const view = (await opened.json()) as { linked: { item: { state: string; payload: Json } } };
    expect(view.linked.item).toMatchObject({
      state: "requested",
      payload: { kind: "faulty", reasonCode: "wrong_item" },
    });
  });

  it("refuse a withdrawal from what is not agreed yet, and ask a return only of goods that were sent", async () => {
    const s = await setup();
    const made = await s.call("POST", "/v1/orders", {
      payload: {
        orderedItem: [{ name: "Custom frame", quantity: 1, price: { value: 900, currency: "EUR" } }],
        totalPrice: { value: 900, currency: "EUR" },
      },
    });
    const { view, accessToken } = (await made.json()) as { view: { item: { id: string } }; accessToken: string };
    const w = await s.call("POST", `/v1/items/${view.item.id}/withdraw`, {
      access_token: accessToken,
      confirm_withdrawal: true,
    });
    expect(w.status).toBe(409);
    expect((await json(w)).code).toBe("wrong_state");
    const r = await s.call("POST", `/v1/items/${view.item.id}/returns`, {
      access_token: accessToken,
      reason: "faulty",
    });
    expect(r.status).toBe(409);
  });
});

describe("returns through MCP", () => {
  it("shows the summary before a priced order, the statement before a withdrawal, and takes a return", async () => {
    const s = await setup();
    const client = await s.mcp("/mcp");
    const order = {
      payload: {
        orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 1, price: { value: 1, currency: "EUR" } }],
        totalPrice: { value: 1, currency: "EUR" },
      },
      contact: { email: "rita@example.com" },
    };
    const asked = (await client.callTool({ name: "create_order", arguments: order })) as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent: { confirm: { summary: string; terms_sha: string } };
    };
    expect(asked.isError).toBeFalsy();
    expect(asked.content[0]?.text).toMatch(
      /^Nothing is sent yet\. Before this binds your customer, show them: Please check/,
    );
    const made = (await client.callTool({
      name: "create_order",
      arguments: { ...order, terms_sha: asked.structuredContent.confirm.terms_sha },
    })) as { structuredContent: { view: { item: { id: string } }; accessToken: string } };
    const id = made.structuredContent.view.item.id;
    const token = made.structuredContent.accessToken;
    for (const event of ["accept", "fulfil"]) {
      await s.call("POST", `/v1/owner/items/${id}/transitions`, { event }, s.owner);
    }
    const statement = (await client.callTool({
      name: "withdraw_from_contract",
      arguments: { item_id: id, access_token: token },
    })) as { isError?: boolean; content: { text: string }[]; structuredContent: { confirm: { statement: Json } } };
    expect(statement.isError).toBeFalsy();
    expect(statement.content[0]?.text).toMatch(
      /^Nothing is sent yet\. Show your person this, and send confirm_withdrawal: true/,
    );
    expect(statement.structuredContent.confirm.statement).toMatchObject({
      available: true,
      label: "Withdraw from contract here",
    });
    const returned = (await client.callTool({
      name: "request_return",
      arguments: { item_id: id, access_token: token, reason: "not_as_described" },
    })) as { structuredContent: { linked: { item: { payload: Json } } } };
    expect(returned.structuredContent.linked.item.payload).toMatchObject({ kind: "faulty" });

    // The owner's AI sees the return and may approve it, the goods coming back; refusing it is a person's.
    const ownerClient = await s.mcp("/mcp/owner");
    const listed = (await ownerClient.callTool({ name: "list_items", arguments: { type: "refund" } })) as {
      structuredContent: { items: { item: { id: string } }[] };
    };
    const refundId = listed.structuredContent.items[0]?.item.id as string;
    const refused = (await ownerClient.callTool({
      name: "transition_item",
      arguments: { item_id: refundId, event: "reject", input: { note: "No" } },
    })) as { isError?: boolean; structuredContent: { error: { code: string } } };
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error.code).toBe("not_allowed");
    const approved = (await ownerClient.callTool({
      name: "transition_item",
      arguments: { item_id: refundId, event: "approve", idempotency_key: "approve-1" },
    })) as { isError?: boolean; structuredContent: { view: { item: { state: string } } } };
    expect(approved.isError).toBeFalsy();
    expect(approved.structuredContent.view.item.state).toBe("approved");
  });
});
