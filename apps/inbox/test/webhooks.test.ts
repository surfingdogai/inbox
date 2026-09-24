import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { type Db, schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
// The published verifier, imported by path: `@surfingdog/sdk` is MIT and deliberately not a
// dependency of this AGPL app, and checking our own signature with our own signer would prove
// only that we agree with ourselves.
import { verifyWebhook } from "../../../packages/sdk/src/index";
import { type App, createApp, createInbox, type Inbox } from "../src/app";
import { freshDb, futureDay } from "./harness";

/**
 * The doors onto ADR-015 step two: /v1/owner/webhooks, /v1/owner/deliveries and the developer
 * cursor at /v1/owner/events, plus the same operations as owner MCP tools.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");

/** A weekday to come: the inbox books nothing in the past. */
const DAY = futureDay();
const SECRET_KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";
const ITEM = "01JD0000000000000000ITEM01";
/** The server on the other side of the internet. Public and https, as every endpoint must be. */
const RECEIVER = "https://receiver.example.com/hooks/inbox";

async function setup(opts: { secretKey?: string | null } = {}) {
  const db = await freshDb();
  await db.batch([
    {
      sql: "INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('party_1', 'person', ?, ?)",
      params: [T0, T0],
      method: "run",
    },
    {
      sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES (?, 'booking', 'confirmed', 2, 'party_1', 'rest', '{}', '{}', ?, ?)",
      params: [ITEM, T0, T0],
      method: "run",
    },
    {
      sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES ('01JD00000000000000000000A1', ?, 1, 'create', NULL, 'requested', 'customer_agent', 'agent:claude', 0, ?)",
      params: [ITEM, T0],
      method: "run",
    },
    {
      sql: "INSERT INTO thread_entries (id, item_id, direction, channel, actor_kind, actor_id, body_text, body_format, created_at) VALUES ('01JD00000000000000000000A2', ?, 'in', 'email', 'customer_human', 'rita', 'any news?', 'text', ?)",
      params: [ITEM, T0 + 1_000],
      method: "run",
    },
    {
      sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES ('01JD00000000000000000000A3', ?, 2, 'confirm', 'requested', 'confirmed', 'owner', 'user_1', 0, ?)",
      params: [ITEM, T0 + 2_000],
      method: "run",
    },
  ]);
  const key = await createApiKey(db, { kind: "owner", name: "test" });
  const app = createApp({ db, secretKey: opts.secretKey === null ? undefined : (opts.secretKey ?? SECRET_KEY) });
  return { db, app, ownerKey: key.key };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://inbox.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function connectOwner(app: App, ownerKey: string) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    merged.set("authorization", `Bearer ${ownerKey}`);
    return app.request(String(input), { ...init, headers: merged });
  };
  const transport = new StreamableHTTPClientTransport(new URL("https://inbox.test/mcp/owner"), { fetch: fetchLike });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  return client;
}

describe("webhook routes", () => {
  it("creates an endpoint with the secret once, then never shows it again", async () => {
    const { app, ownerKey } = await setup();
    const auth = { authorization: `Bearer ${ownerKey}` };
    const created = await app.request(
      post("/v1/owner/webhooks", { url: "https://hooks.example.com/inbox", events: ["booking.*"] }, auth),
    );
    expect(created.status).toBe(201);
    const hook = (await created.json()) as { id: string; secret: string; payload_style: string };
    expect(hook.secret.startsWith("whsec_")).toBe(true);
    expect(hook.payload_style).toBe("thin");

    const listed = await app.request("https://inbox.test/v1/owner/webhooks", { headers: auth });
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(body).toContain(hook.id);
    expect(body).not.toContain("whsec_");

    const rotated = await app.request(post(`/v1/owner/webhooks/${hook.id}/rotate-secret`, {}, auth));
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { secret: string; previous_secret_until: string };
    expect(next.secret).not.toBe(hook.secret);
    expect(next.previous_secret_until).toBeTruthy();

    const patched = await app.request(
      new Request(`https://inbox.test/v1/owner/webhooks/${hook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ active: false, payload_style: "full" }),
      }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ active: false, payload_style: "full" });

    const removed = await app.request(
      new Request(`https://inbox.test/v1/owner/webhooks/${hook.id}`, { method: "DELETE", headers: auth }),
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
  });

  it("refuses a private or non-https endpoint with a problem naming the field", async () => {
    const { app, ownerKey } = await setup();
    const auth = { authorization: `Bearer ${ownerKey}` };
    const bad = await app.request(post("/v1/owner/webhooks", { url: "https://localhost/hook" }, auth));
    expect(bad.status).toBe(422);
    expect(bad.headers.get("content-type")).toContain("application/problem+json");
    expect((await bad.json()) as { fields: { path: string }[] }).toMatchObject({
      code: "invalid_input",
      fields: [{ path: "url" }],
    });
    const plain = await app.request(post("/v1/owner/webhooks", { url: "http://hooks.example.com/h" }, auth));
    expect(plain.status).toBe(422);
  });

  it("names INBOX_SECRET_KEY when the instance has no key to seal with", async () => {
    const { app, ownerKey } = await setup({ secretKey: null });
    const refused = await app.request(
      post("/v1/owner/webhooks", { url: "https://hooks.example.com/h" }, { authorization: `Bearer ${ownerKey}` }),
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("INBOX_SECRET_KEY");
  });

  it("serves the event cursor in stable order and refuses everything without an owner key", async () => {
    const { app, ownerKey } = await setup();
    const auth = { authorization: `Bearer ${ownerKey}` };
    const first = await app.request("https://inbox.test/v1/owner/events?limit=2", { headers: auth });
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      events: { id: string; type: string; timestamp: string; data: Record<string, unknown> }[];
      next_cursor: string;
    };
    expect(page.events.map((e) => e.id)).toEqual(["01JD00000000000000000000A1", "01JD00000000000000000000A2"]);
    expect(page.events.map((e) => e.type)).toEqual(["booking.create", "booking.message"]);
    expect(page.events[0]?.data).toEqual({
      id: ITEM,
      type: "booking",
      state: "requested",
      version: 1,
      url: `/v1/owner/items/${ITEM}`,
      actor: { kind: "customer_agent", id: null },
      channel: "rest",
      sandbox: false,
    });
    expect(page.next_cursor).toBe("01JD00000000000000000000A2");

    const second = await app.request(`https://inbox.test/v1/owner/events?cursor=${page.next_cursor}&limit=2`, {
      headers: auth,
    });
    const rest = (await second.json()) as { events: { id: string }[]; next_cursor: string | null };
    expect(rest.events.map((e) => e.id)).toEqual(["01JD00000000000000000000A3"]);
    const empty = await app.request(`https://inbox.test/v1/owner/events?cursor=${rest.next_cursor}`, {
      headers: auth,
    });
    expect((await empty.json()) as { events: unknown[]; next_cursor: null }).toEqual({
      events: [],
      next_cursor: null,
    });

    const filtered = await app.request("https://inbox.test/v1/owner/events?types=booking.confirm", { headers: auth });
    expect(((await filtered.json()) as { events: { id: string }[] }).events.map((e) => e.id)).toEqual([
      "01JD00000000000000000000A3",
    ]);

    for (const path of [
      "/v1/owner/events",
      "/v1/owner/webhooks",
      "/v1/owner/deliveries",
      "/v1/owner/webhooks/x/deliveries",
    ]) {
      expect((await app.request(`https://inbox.test${path}`)).status, path).toBe(401);
    }
    for (const path of [
      "/v1/owner/webhooks",
      "/v1/owner/webhooks/x/rotate-secret",
      "/v1/owner/webhooks/x/test",
      "/v1/owner/webhooks/x/replay",
      "/v1/owner/deliveries/x/replay",
    ]) {
      expect((await app.request(post(path, {}))).status, path).toBe(401);
    }
  });

  it("lists deliveries and replays one, scoped to its endpoint", async () => {
    const { db, app, ownerKey } = await setup();
    const auth = { authorization: `Bearer ${ownerKey}` };
    const created = await app.request(post("/v1/owner/webhooks", { url: "https://hooks.example.com/inbox" }, auth));
    const hook = (await created.json()) as { id: string };
    await db.client.query({
      sql: "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, last_status, created_at) VALUES ('01JD0000000000000000000002', ?, '01JD00000000000000000000A1', 'booking.create', 'failed', 3, 500, ?)",
      params: [hook.id, T0],
      method: "run",
    });
    const listed = await app.request(`https://inbox.test/v1/owner/webhooks/${hook.id}/deliveries?limit=10`, {
      headers: auth,
    });
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { items: { id: string; status: string }[]; next_cursor: string | null };
    expect(page.items).toMatchObject([{ id: "01JD0000000000000000000002", status: "failed" }]);
    expect(page.next_cursor).toBeNull();

    const replayed = await app.request(post("/v1/owner/deliveries/01JD0000000000000000000002/replay", {}, auth));
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ status: "pending", attempts: 0 });

    const missing = await app.request(
      post(`/v1/owner/webhooks/${hook.id}/replay`, { since: new Date(T0 - 60_000).toISOString() }, auth),
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ webhook_id: hook.id, matched: 3 });
  });

  it("describes every route in the OpenAPI document", async () => {
    const { app } = await setup();
    const spec = (await (await app.request("https://inbox.test/openapi.json")).json()) as {
      paths: Record<string, Record<string, { summary?: string }>>;
    };
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/v1/owner/webhooks",
        "/v1/owner/webhooks/{id}",
        "/v1/owner/webhooks/{id}/rotate-secret",
        "/v1/owner/webhooks/{id}/test",
        "/v1/owner/webhooks/{id}/replay",
        "/v1/owner/webhooks/{id}/deliveries",
        "/v1/owner/deliveries",
        "/v1/owner/deliveries/{id}/replay",
        "/v1/owner/events",
      ]),
    );
    expect(spec.paths["/v1/owner/events"]?.get?.summary).toMatch(/cursor/i);
    expect(spec.paths["/v1/owner/webhooks"]?.post?.summary).toMatch(/secret/i);
  });
});

describe("webhook MCP tools", () => {
  it("exposes the integration tools on the owner server, and leaves adding or re-pointing an endpoint to the owner", async () => {
    const { app, db, ownerKey } = await setup();
    const owner = { authorization: `Bearer ${ownerKey}` };
    const client = await connectOwner(app, ownerKey);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_webhooks",
        "create_webhook",
        "update_webhook",
        "rotate_webhook_secret",
        "delete_webhook",
        "send_test_event",
        "list_webhook_deliveries",
        "replay_webhook_delivery",
        "replay_missing_webhook_deliveries",
        "list_events",
      ]),
    );

    // The owner's AI, even holding the owner's own key, cannot add an endpoint: a customer's
    // message could have asked it to. It is told to ask the owner, and nothing is stored.
    const asked = await client.callTool({
      name: "create_webhook",
      arguments: { url: "https://hooks.example.com/inbox", events: ["booking.*"] },
    });
    expect(asked.isError).toBe(true);
    const said = (asked.content as { text: string }[])[0]?.text ?? "";
    expect(said).toContain("Only the owner can add a webhook endpoint");
    expect(said).toContain("Settings → Integrations");
    expect((asked.structuredContent as { error: { details: unknown } }).error.details).toMatchObject({
      reason: "owner_in_person",
      ask_owner: true,
    });
    expect(await db.orm.select().from(schema.webhooks)).toHaveLength(0);

    // The owner adds it in person; the secret is in that answer and no other.
    const made = await app.request(
      post("/v1/owner/webhooks", { url: "https://hooks.example.com/inbox", events: ["booking.*"] }, owner),
    );
    expect(made.status).toBe(201);
    const hook = (await made.json()) as { id: string; secret: string };
    expect(hook.secret.startsWith("whsec_")).toBe(true);

    const listed = await client.callTool({ name: "list_webhooks", arguments: {} });
    expect(JSON.stringify(listed)).not.toContain("whsec_");
    expect(JSON.stringify(listed)).toContain(hook.id);

    const events = await client.callTool({ name: "list_events", arguments: { limit: 50 } });
    const page = events.structuredContent as { events: { id: string }[]; next_cursor: string };
    expect(page.events).toHaveLength(3);
    expect(page.next_cursor).toBe("01JD00000000000000000000A3");

    // The AI may pause it, and nothing else: not re-point it, wake it, rotate or remove it.
    const paused = await client.callTool({ name: "update_webhook", arguments: { webhook_id: hook.id, active: false } });
    expect(paused.isError, JSON.stringify(paused.content)).toBeFalsy();
    for (const [name, args] of [
      ["update_webhook", { webhook_id: hook.id, url: "https://evil.example/hook" }],
      ["update_webhook", { webhook_id: hook.id, active: true }],
      ["update_webhook", { webhook_id: hook.id, active: false, payload_style: "full" }],
      ["rotate_webhook_secret", { webhook_id: hook.id }],
      ["delete_webhook", { webhook_id: hook.id }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    const [row] = await db.orm.select().from(schema.webhooks);
    expect(row).toMatchObject({ url: "https://hooks.example.com/inbox", active: 0, payloadStyle: "thin" });

    // A private address is refused to the owner as well.
    const local = await app.request(post("/v1/owner/webhooks", { url: "https://10.0.0.5.nip.internal/hook" }, owner));
    expect(local.status).toBe(422);
  });

  it("keeps the public MCP server free of every one of them", async () => {
    const { app } = await setup();
    const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> =>
      app.request(String(input), init);
    const transport = new StreamableHTTPClientTransport(new URL("https://inbox.test/mcp"), { fetch: fetchLike });
    const client = new Client({ name: "customer-agent", version: "0" });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["list_webhooks", "create_webhook", "list_events", "send_test_event"]) {
      expect(names).not.toContain(name);
    }
  });
});

/**
 * The whole of ADR-015 step two in one pass, through the real doors and nothing stubbed but the
 * receiver's socket: the owner adds an endpoint over REST, a customer's agent books over
 * the public REST door, the owner confirms it, the job runner drains — and a server on the other
 * side of the internet gets two signed POSTs it can verify with the MIT helper we publish, while a
 * poller of `GET /v1/owner/events` sees exactly the same events under exactly the same ids.
 *
 * `verifyWebhook` is imported from `packages/sdk` by path: the SDK is deliberately not a
 * dependency of the app (it is MIT and the app is AGPL), and a test that used our own signer to
 * check our own signature would prove only that we agree with ourselves.
 */
describe("end to end: from a booking to a signed request on someone else's server", () => {
  it("delivers every event the cursor shows, signed so the published helper accepts it", async () => {
    const db = await freshDb();
    const serviceId = ulid(T0);
    await db.orm.insert(schema.services).values({
      id: serviceId,
      name: "Full service",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      createdAt: T0,
      updatedAt: T0,
    });
    const ownerKey = (await createApiKey(db, { kind: "owner", name: "e2e" })).key;
    const auth = { authorization: `Bearer ${ownerKey}` };

    // The receiver: a server we do not control, which answers 204 and remembers what it was sent.
    const received: { url: string; headers: Headers; body: string }[] = [];
    const receiver: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(RECEIVER)) return new Response(null, { status: 404 });
      received.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(null, { status: 204 });
    };
    const pending: Promise<unknown>[] = [];
    const inbox = createInbox({
      db,
      secretKey: SECRET_KEY,
      fetchImpl: receiver,
      baseUrl: "https://inbox.example.com",
      background: (work) => void pending.push(work),
      // The cursor normally trails live by `EVENT_SETTLE_MS`, so that a write which commits after
      // its id was minted can never fall below a cursor that has passed it. This test books and
      // polls in the same tick, which is the one case that lag exists to make impossible, so the
      // horizon is switched off here. `packages/core/test/webhooks.test.ts` covers the default.
      eventSettleMs: 0,
    });
    const app = inbox.app;

    // 1. The owner adds the endpoint, in person (their AI may not: core access/outbound.ts).
    const created = await app.request(
      post("/v1/owner/webhooks", { url: RECEIVER, events: ["booking.*"], payload_style: "thin" }, auth),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const endpoint = (await created.json()) as { id: string; secret: string };

    // The REST door sees the same endpoint, and never the secret.
    const listed = await app.request("https://inbox.example.com/v1/owner/webhooks", { headers: auth });
    const list = (await listed.json()) as { items: { id: string; url: string; active: boolean }[] };
    expect(list.items).toMatchObject([{ id: endpoint.id, url: RECEIVER, active: true }]);

    // 2. A customer's agent books, over the public door, with no key at all.
    const booked = await app.request(
      post("/v1/bookings", {
        payload: {
          reservationFor: { serviceId, name: "Full service" },
          startTime: `${DAY}T08:00:00Z`,
          endTime: `${DAY}T09:30:00Z`,
        },
        contact: { name: "Rita", email: "rita@example.com" },
      }),
    );
    expect(booked.status).toBe(201);
    const itemId = ((await booked.json()) as { view: { item: { id: string } } }).view.item.id;

    // 3. The owner confirms it.
    const confirmed = await app.request(post(`/v1/owner/items/${itemId}/transitions`, { event: "confirm" }, auth));
    expect(confirmed.status, await confirmed.text().catch(() => "")).toBe(200);

    // 4. The outbox drains: fanout writes the delivery rows, then the delivery jobs run.
    await Promise.all(pending);
    await drain(inbox, db);

    // 5. Three requests arrived on the other server, in the order things happened: the booking,
    //    its confirmation, and the receipt the confirmation earned (ADR-016) — issued by a job after
    //    the transition, so always third, and covered by `booking.*` like any other event.
    const types = received.map((r) => r.headers.get("sdi-event-type"));
    expect(types).toEqual(["booking.create", "booking.confirm", "booking.receipt_issued"]);
    expect(received.every((r) => r.url === RECEIVER)).toBe(true);
    expect(received[0]?.headers.get("sdi-delivery-attempt")).toBe("1");
    expect(received[0]?.headers.get("content-type")).toBe("application/json");
    expect(received[0]?.headers.get("user-agent")).toMatch(/^surfingdog-inbox\//);

    // 6. The signature is one an off-the-shelf receiver accepts: the helper we publish, holding
    //    nothing but the secret the owner was shown once, verifies both requests.
    for (const request of received) {
      const event = await verifyWebhook({
        payload: request.body,
        headers: request.headers,
        secret: endpoint.secret,
        now: Number(request.headers.get("webhook-timestamp")) * 1000,
      });
      expect(event.data.id).toBe(itemId);
      expect(event.id).toBe(request.headers.get("webhook-id"));
      // Thin: a pointer, and nothing of Rita's.
      expect(JSON.stringify(event)).not.toMatch(/Rita|rita@example\.com/);
      expect(event.data.url).toBe(`https://inbox.example.com/v1/owner/items/${itemId}`);
    }
    const confirmedEvent = JSON.parse(received[1]?.body ?? "{}") as { type: string; data: { state: string } };
    expect(confirmedEvent).toMatchObject({ type: "booking.confirm", data: { state: "confirmed" } });
    // The receipt event is named by the receipt's own id, the one the owner sees on the item.
    const detail = await app.request(`https://inbox.example.com/v1/owner/items/${itemId}`, { headers: auth });
    const [receipt] = ((await detail.json()) as { receipts: { id: string; kind: string }[] }).receipts;
    expect(receipt).toMatchObject({ kind: "confirmed" });
    expect(received[2]?.headers.get("webhook-id")).toBe(receipt?.id);

    // A secret that is not the endpoint's is refused, so the check above meant something.
    await expect(
      verifyWebhook({
        payload: received[0]?.body ?? "",
        headers: received[0]?.headers ?? new Headers(),
        secret: "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        now: Number(received[0]?.headers.get("webhook-timestamp")) * 1000,
      }),
    ).rejects.toThrow();

    // 7. The cursor is the same stream: the same ids, the same types, the same thin bodies.
    const page = (await (
      await app.request("https://inbox.example.com/v1/owner/events?types=booking.*", { headers: auth })
    ).json()) as { events: { id: string; type: string }[] };
    expect(page.events.map((e) => e.type)).toEqual(["booking.create", "booking.confirm", "booking.receipt_issued"]);
    expect(page.events.map((e) => e.id)).toEqual(received.map((r) => r.headers.get("webhook-id")));
    expect(page.events[1]).toEqual(JSON.parse(received[1]?.body ?? "{}"));

    // 8. And the owner can see that it worked, without the receiver telling them.
    const deliveries = (await (
      await app.request("https://inbox.example.com/v1/owner/deliveries", { headers: auth })
    ).json()) as { items: { status: string; last_status: number; event_type: string }[] };
    expect(deliveries.items.map((d) => [d.event_type, d.status, d.last_status])).toEqual([
      ["booking.receipt_issued", "delivered", 204],
      ["booking.confirm", "delivered", 204],
      ["booking.create", "delivered", 204],
    ]);
  });
});

/** Runs the outbox to a standstill: fanout enqueues delivery, so one pass is never enough. */
async function drain(inbox: Inbox, db: Db): Promise<void> {
  for (let pass = 0; pass < 10; pass++) {
    if ((await inbox.runner.runDue(db)).claimed === 0) return;
  }
  throw new Error("the outbox never settled");
}
