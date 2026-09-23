import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey, hashKey, ROUTE_SCOPES } from "@surfingdog/adapters";
import { type Db, schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type App, createInbox, type Inbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * Connecting other software through the doors (keys and scopes, idempotency, attribution, webhook
 * conveniences, and the fixes integrators hit first), end to end over REST and the owner MCP.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const SECRET_KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";
const RECEIVER = "https://receiver.example.com/hooks/inbox";

async function setup(opts: { fetchImpl?: typeof fetch } = {}) {
  const db = await freshDb();
  const serviceId = ulid(T0);
  await db.orm.insert(schema.services).values({
    id: serviceId,
    name: "Full service",
    durationMin: 90,
    capacity: 5,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    secretKey: SECRET_KEY,
    baseUrl: "https://inbox.example.com",
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return { db, inbox, app: inbox.app, serviceId, ownerKey, owner: { authorization: `Bearer ${ownerKey}` }, pending };
}

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://inbox.example.com${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function book(app: App, serviceId: string, headers: Record<string, string> = {}, hour = 8): Promise<string> {
  const res = await app.request(
    req(
      "POST",
      "/v1/bookings",
      {
        payload: {
          reservationFor: { serviceId, name: "Full service" },
          startTime: `2026-09-22T${String(hour).padStart(2, "0")}:00:00Z`,
          endTime: `2026-09-22T${String(hour + 1).padStart(2, "0")}:30:00Z`,
        },
        contact: { name: "Rita", email: "rita@example.com" },
      },
      headers,
    ),
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { view: { item: { id: string } } }).view.item.id;
}

async function mintKey(app: App, owner: Record<string, string>, body: Record<string, unknown>) {
  const res = await app.request(req("POST", "/v1/owner/api-keys", body, owner));
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string; key: string; name: string; scopes: string[]; hint: string };
}

async function connectOwner(app: App, bearer: string) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    merged.set("authorization", `Bearer ${bearer}`);
    return app.request(String(input), { ...init, headers: merged });
  };
  const transport = new StreamableHTTPClientTransport(new URL("https://inbox.example.com/mcp/owner"), {
    fetch: fetchLike,
  });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  return client;
}

const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]?.text ?? "";

/** An OAuth access token for an AI app called Claude, as the consent flow would have issued it. */
async function oauthToken(db: Db, scope = "inbox:read inbox:write settings:read offline_access") {
  const token = `sdi_at_${ulid()}${ulid()}`;
  const clientId = "client_claude";
  await db.orm
    .insert(schema.oauthClients)
    .values({ id: clientId, name: "Claude", redirectUris: ["https://claude.ai/cb"], kind: "cimd", createdAt: T0 })
    .onConflictDoNothing();
  await db.orm.insert(schema.oauthTokens).values({
    tokenHash: await hashKey(token),
    kind: "access",
    clientId,
    userId: "user_1",
    scope,
    familyId: ulid(),
    expiresAt: Date.now() + 3_600_000,
    createdAt: T0,
  });
  return { token, clientId, auth: { authorization: `Bearer ${token}` } };
}

async function drain(inbox: Inbox, db: Db, pending: Promise<unknown>[]): Promise<void> {
  await Promise.all(pending);
  for (let pass = 0; pass < 10; pass++) {
    if ((await inbox.runner.runDue(db)).claimed === 0) return;
  }
  throw new Error("the outbox never settled");
}

describe("keys and scopes", () => {
  it("mints a named, scoped key shown once, lists it without the key, and revokes it in one call", async () => {
    const { app, owner } = await setup();
    const zap = await mintKey(app, owner, { name: "Zapier", preset: "automation" });
    expect(zap.key.startsWith("sdi_own_")).toBe(true);
    expect(zap.scopes).toEqual(["inbox:read", "inbox:write", "events:read"]);
    expect(zap.hint.endsWith(zap.key.slice(-4))).toBe(true);

    const listed = await app.request(req("GET", "/v1/owner/api-keys", undefined, owner));
    const list = await listed.text();
    expect(list).not.toContain(zap.key);
    expect(JSON.parse(list).items.map((k: { name: string }) => k.name)).toEqual(["Zapier", "cli"]);

    const asZap = { authorization: `Bearer ${zap.key}` };
    expect((await app.request(req("GET", "/v1/owner/items", undefined, asZap))).status).toBe(200);
    const revoked = await app.request(req("DELETE", `/v1/owner/api-keys/${zap.id}`, undefined, owner));
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { active: boolean }).active).toBe(false);
    expect((await app.request(req("GET", "/v1/owner/items", undefined, asZap))).status).toBe(401);
  });

  it("records a call outside a key's scopes and lets it through, until the owner switches enforcement on", async () => {
    const { app, owner } = await setup();
    const zap = await mintKey(app, owner, { name: "Zapier", preset: "automation" });
    const asZap = { authorization: `Bearer ${zap.key}` };
    const service = { name: "Wash" };
    expect((await app.request(req("POST", "/v1/owner/services", service, asZap))).status).toBe(201);
    expect((await app.request(req("POST", "/v1/owner/services", service, asZap))).status).toBe(201);

    const keys = async () =>
      (await (await app.request(req("GET", "/v1/owner/api-keys", undefined, owner))).json()) as {
        items: { id: string; refusals: { operation: string; scope: string; count: number; enforced: boolean }[] }[];
      };
    const refusals = (await keys()).items.find((k) => k.id === zap.id)?.refusals;
    expect(refusals).toEqual([
      expect.objectContaining({ operation: "POST /services", scope: "catalogue:write", count: 2, enforced: false }),
    ]);

    // Only the owner can switch it on: the key itself cannot, whatever its scopes.
    const bySelf = await app.request(
      req("PUT", "/v1/owner/settings", { doc: { security: { enforceScopes: true } } }, asZap),
    );
    expect(bySelf.status).toBe(403);
    const on = await app.request(
      req("PUT", "/v1/owner/settings", { doc: { security: { enforceScopes: true } } }, owner),
    );
    expect(on.status).toBe(200);

    const refused = await app.request(req("POST", "/v1/owner/services", service, asZap));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "not_allowed",
      details: { required_scopes: ["catalogue:write"] },
    });
    expect((await keys()).items.find((k) => k.id === zap.id)?.refusals[0]).toMatchObject({ count: 3, enforced: true });
    // In scope, and the owner, go on as before.
    expect((await app.request(req("GET", "/v1/owner/items", undefined, asZap))).status).toBe(200);
    expect((await app.request(req("POST", "/v1/owner/services", service, owner))).status).toBe(201);
  });

  it("checks a key's scopes when it reaches an existing item through the public door too", async () => {
    const { app, owner, serviceId } = await setup();
    const itemId = await book(app, serviceId);
    const shop = await mintKey(app, owner, { name: "Shop", scopes: ["catalogue:write"] });
    const asShop = { authorization: `Bearer ${shop.key}` };
    // Logged first: the call goes through, and the owner sees it under the key.
    expect((await app.request(req("GET", `/v1/items/${itemId}`, undefined, asShop))).status).toBe(200);
    const listed = (await (await app.request(req("GET", "/v1/owner/api-keys", undefined, owner))).json()) as {
      items: { id: string; refusals: { operation: string; scope: string }[] }[];
    };
    expect(listed.items.find((k) => k.id === shop.id)?.refusals).toEqual([
      expect.objectContaining({ operation: "public:get_item_status", scope: "inbox:read" }),
    ]);
    // Enforced, the public door refuses what the owner door would.
    await app.request(req("PUT", "/v1/owner/settings", { doc: { security: { enforceScopes: true } } }, owner));
    expect((await app.request(req("GET", `/v1/items/${itemId}`, undefined, asShop))).status).toBe(403);
    const injected = await app.request(req("POST", "/v1/messages", { item_id: itemId, body: "from the key" }, asShop));
    expect(injected.status).toBe(403);
    expect((await app.request(req("POST", `/v1/items/${itemId}/cancel`, {}, asShop))).status).toBe(403);
    // A customer with the item's token, and the owner, are untouched.
    expect((await app.request(req("GET", `/v1/items/${itemId}`, undefined, owner))).status).toBe(200);
  });

  it("names the operation by its route, even behind a host's catch-all", async () => {
    const { app, owner } = await setup();
    // The Node host serves the owner app's files from a catch-all registered after the doors.
    app.get("/*", (_c, next) => next());
    const zap = await mintKey(app, owner, { name: "Zapier", preset: "automation" });
    const asZap = { authorization: `Bearer ${zap.key}` };
    expect((await app.request(req("GET", "/v1/owner/items", undefined, asZap))).status).toBe(200);
    expect((await app.request(req("GET", "/v1/owner/services", undefined, asZap))).status).toBe(200);
    const listed = (await (await app.request(req("GET", "/v1/owner/api-keys", undefined, owner))).json()) as {
      items: { id: string; refusals: { operation: string }[] }[];
    };
    expect(listed.items.find((k) => k.id === zap.id)?.refusals.map((r) => r.operation)).toEqual(["GET /services"]);
  });

  it("lets the owner's AI mint a key only after the owner allows it, and never a settings key", async () => {
    const { app, db, owner, ownerKey } = await setup();
    const zap = await mintKey(app, owner, { name: "Zapier", preset: "automation" });
    // An integration key never mints keys.
    const byKey = await app.request(
      req("POST", "/v1/owner/api-keys", { name: "x", preset: "read_only" }, { authorization: `Bearer ${zap.key}` }),
    );
    expect(byKey.status).toBe(403);
    // Over OAuth, not without leave.
    const claude = await oauthToken(db);
    const byAi = await app.request(
      req("POST", "/v1/owner/api-keys", { name: "Shop", preset: "shop_sync" }, claude.auth),
    );
    expect(byAi.status).toBe(403);
    expect(await byAi.text()).toContain("Let my AI create keys");

    // Over MCP — even holding the owner's own key, an AI is an AI — not without leave either.
    const mcp = await connectOwner(app, ownerKey);
    const refused = await mcp.callTool({ name: "create_api_key", arguments: { name: "Shop", preset: "shop_sync" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Let my AI create keys");
    // And the AI cannot give itself leave.
    const selfGrant = await mcp.callTool({
      name: "update_settings",
      arguments: { doc: { security: { aiMayCreateKeys: true } } },
    });
    expect(selfGrant.isError).toBe(true);

    await app.request(req("PUT", "/v1/owner/settings", { doc: { security: { aiMayCreateKeys: true } } }, owner));
    const made = await mcp.callTool({
      name: "create_api_key",
      arguments: { name: "Shop", preset: "shop_sync", idempotency_key: "mint-shop" },
    });
    expect(made.isError, text(made)).toBeFalsy();
    const shop = made.structuredContent as { id: string; key: string; created_by: string };
    expect(shop.key.startsWith("sdi_own_")).toBe(true);
    expect(text(made)).toContain(shop.key);
    // A retried call with the same key is the same key, not a second one.
    const again = await mcp.callTool({
      name: "create_api_key",
      arguments: { name: "Shop", preset: "shop_sync", idempotency_key: "mint-shop" },
    });
    expect((again.structuredContent as { id: string; key: string }).id).toBe(shop.id);
    expect((again.structuredContent as { key: string }).key).toBe(shop.key);
    const settingsKey = await mcp.callTool({
      name: "create_api_key",
      arguments: { name: "Bad", scopes: ["settings:write"] },
    });
    expect(settingsKey.isError).toBe(true);

    // The AI may revoke what it made, but not the owner's own key.
    const cliId = (
      (await (await app.request(req("GET", "/v1/owner/api-keys", undefined, owner))).json()) as {
        items: { id: string; name: string }[];
      }
    ).items.find((k) => k.name === "cli")?.id;
    expect((await mcp.callTool({ name: "revoke_api_key", arguments: { key_id: cliId } })).isError).toBe(true);
    expect((await mcp.callTool({ name: "revoke_api_key", arguments: { key_id: shop.id } })).isError).toBeFalsy();
  });

  it("gives the owner's AI its own name in the history, and keeps the owner's rights on the machines", async () => {
    const { app, db, owner, serviceId } = await setup();
    const itemId = await book(app, serviceId);
    const claude = await oauthToken(db);
    const confirmed = await app.request(
      req("POST", `/v1/owner/items/${itemId}/transitions`, { event: "confirm" }, claude.auth),
    );
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);

    const detail = (await (await app.request(req("GET", `/v1/owner/items/${itemId}`, undefined, owner))).json()) as {
      events: { event: string; actor: string; by: unknown; channel: string }[];
    };
    expect(detail.events.map((e) => [e.event, e.by, e.channel])).toEqual([
      ["create", { kind: "customer_agent", id: null }, "rest"],
      ["confirm", { kind: "owner_ai", id: claude.clientId, name: "Claude" }, "rest"],
    ]);

    // Its default consent does not cover the catalogue: recorded under the AI app, not refused.
    expect((await app.request(req("POST", "/v1/owner/services", { name: "Wash" }, claude.auth))).status).toBe(201);
    const keys = (await (await app.request(req("GET", "/v1/owner/api-keys", undefined, owner))).json()) as {
      ai_clients: { id: string; name: string; refusals: { operation: string; scope: string }[] }[];
    };
    expect(keys.ai_clients).toEqual([
      {
        kind: "owner_ai",
        id: claude.clientId,
        name: "Claude",
        refusals: [expect.objectContaining({ operation: "POST /services", scope: "catalogue:write" })],
      },
    ]);
  });

  it("stops an expired key, and slows a runaway integration key but never the owner", async () => {
    const { app, db, owner } = await setup();
    const zap = await mintKey(app, owner, { name: "Zapier", preset: "automation", expires_at: "2099-01-01T00:00:00Z" });
    const asZap = { authorization: `Bearer ${zap.key}` };
    expect((await app.request(req("GET", "/v1/owner/items", undefined, asZap))).status).toBe(200);

    // A key that has been knocking in a loop has emptied its bucket.
    await db.client.query({
      sql: "INSERT OR REPLACE INTO rate_limits (bucket, tokens, updated_at) VALUES (?, -1, ?)",
      params: [`integration:key:${zap.id}`, Date.now()],
      method: "run",
    });
    const slowed = await app.request(req("GET", "/v1/owner/items", undefined, asZap));
    expect(slowed.status).toBe(429);
    expect(Number(slowed.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await app.request(req("GET", "/v1/owner/items", undefined, owner))).status).toBe(200);

    await db.client.query({ sql: "UPDATE api_keys SET expires_at = ? WHERE id = ?", params: [Date.now() - 1, zap.id] });
    await db.client.query({ sql: "DELETE FROM rate_limits" });
    expect((await app.request(req("GET", "/v1/owner/items", undefined, asZap))).status).toBe(401);
  });
});

describe("idempotency on every owner write", () => {
  it("replays a setup write, refuses the key with another body, and dedupes across REST and MCP", async () => {
    const { app, owner, ownerKey, serviceId } = await setup();
    const k = { ...owner, "idempotency-key": "svc-7" };
    const first = await app.request(req("POST", "/v1/owner/services", { name: "Tune-up" }, k));
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };
    const again = await app.request(req("POST", "/v1/owner/services", { name: "Tune-up" }, k));
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(((await again.json()) as { id: string }).id).toBe(created.id);
    const other = await app.request(req("POST", "/v1/owner/services", { name: "Other" }, k));
    expect(other.status).toBe(422);
    expect(((await other.json()) as { code: string }).code).toBe("idempotency_mismatch");

    const mcp = await connectOwner(app, ownerKey);
    const viaMcp = await mcp.callTool({
      name: "upsert_service",
      arguments: { name: "Tune-up", idempotency_key: "svc-7" },
    });
    expect((viaMcp.structuredContent as { id: string }).id).toBe(created.id);
    expect(text(viaMcp)).toContain("nothing was done twice");
    const services = (await (await app.request(req("GET", "/v1/owner/services", undefined, owner))).json()) as {
      items: { name: string }[];
    };
    expect(services.items.filter((s) => s.name === "Tune-up")).toHaveLength(1);

    // A note is written once, however often it is retried.
    const itemId = await book(app, serviceId);
    for (let i = 0; i < 2; i++) {
      const note = await app.request(
        req(
          "POST",
          `/v1/owner/items/${itemId}/replies`,
          { body: "Bring the bike at 9", internal: true },
          {
            ...owner,
            "idempotency-key": "note-1",
          },
        ),
      );
      expect(note.status).toBe(200);
    }
    const detail = (await (await app.request(req("GET", `/v1/owner/items/${itemId}`, undefined, owner))).json()) as {
      thread: { body: string }[];
    };
    expect(detail.thread.filter((t) => t.body === "Bring the bike at 9")).toHaveLength(1);

    // Settings too.
    const s1 = await app.request(
      req("PUT", "/v1/owner/settings", { doc: { testMode: true } }, { ...owner, "idempotency-key": "set-1" }),
    );
    const s2 = await app.request(
      req("PUT", "/v1/owner/settings", { doc: { testMode: true } }, { ...owner, "idempotency-key": "set-1" }),
    );
    expect(((await s2.json()) as { version: number }).version).toBe(((await s1.json()) as { version: number }).version);
  });

  it("replays a new webhook with its secret sealed, and gives the key back when the write fails", async () => {
    const { app, db, owner } = await setup();
    const k = { ...owner, "idempotency-key": "hook-1" };
    const first = await app.request(req("POST", "/v1/owner/webhooks", { url: RECEIVER }, k));
    expect(first.status).toBe(201);
    expect(first.headers.get("location")).toMatch(/^\/v1\/owner\/webhooks\/[0-9A-Z]{26}$/);
    const hook = (await first.json()) as { id: string; secret: string };
    const again = await app.request(req("POST", "/v1/owner/webhooks", { url: RECEIVER }, k));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: hook.id, secret: hook.secret });
    const { rows } = await db.client.query({ sql: "SELECT response FROM idempotency_keys WHERE key = 'hook-1'" });
    expect(String(rows[0]?.[0])).not.toContain(hook.secret);
    expect((await db.orm.select().from(schema.webhooks)).length).toBe(1);

    // A refused write keeps nothing, so the same key and body go through once the cause is fixed.
    const kb = { ...owner, "idempotency-key": "hook-2" };
    const local = { url: "http://10.0.0.5/hook" };
    expect((await app.request(req("POST", "/v1/owner/webhooks", local, kb))).status).toBe(422);
    await app.request(
      req("PUT", "/v1/owner/settings", { doc: { integrations: { webhooks: { allowPrivateTargets: true } } } }, owner),
    );
    expect((await app.request(req("POST", "/v1/owner/webhooks", local, kb))).status).toBe(201);
  });

  it("replays a key or a signing secret only to whoever asked, never to another key or app reusing the key", async () => {
    const { app, db, owner } = await setup();
    const zap = await mintKey(app, owner, { name: "Zapier", preset: "automation" });
    const asZap = { authorization: `Bearer ${zap.key}` };
    const claude = (await oauthToken(db, "inbox:read keys:write integrations:write")).auth;
    const body = { name: "Shop", scopes: ["catalogue:write", "settings:write"] };
    const first = await app.request(req("POST", "/v1/owner/api-keys", body, { ...owner, "idempotency-key": "mint-1" }));
    expect(first.status).toBe(201);
    const shop = (await first.json()) as { id: string; key: string };

    // The owner's AI shares the business's idempotency keys, so the same key and body replay — but
    // the key itself goes only to the owner who asked.
    const replay = await app.request(
      req("POST", "/v1/owner/api-keys", body, { ...claude, "idempotency-key": "mint-1" }),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const replayed = await replay.text();
    expect(replayed).not.toContain(shop.key);
    expect(JSON.parse(replayed)).toMatchObject({ id: shop.id, key: null });
    // An integration key's idempotency keys are its own: the same string is its own request, refused.
    const byZap = await app.request(req("POST", "/v1/owner/api-keys", body, { ...asZap, "idempotency-key": "mint-1" }));
    expect(byZap.status).toBe(403);
    expect(await byZap.text()).not.toContain(shop.key);
    const mine = await app.request(req("POST", "/v1/owner/api-keys", body, { ...owner, "idempotency-key": "mint-1" }));
    expect(((await mine.json()) as { key: string }).key).toBe(shop.key);
    expect((await db.orm.select().from(schema.apiKeys)).filter((k) => k.name === "Shop")).toHaveLength(1);

    // The same for a webhook's signing secret.
    const hook = await app.request(
      req("POST", "/v1/owner/webhooks", { url: RECEIVER }, { ...owner, "idempotency-key": "hook-x" }),
    );
    const { id, secret } = (await hook.json()) as { id: string; secret: string };
    const stolen = await app.request(
      req("POST", "/v1/owner/webhooks", { url: RECEIVER }, { ...claude, "idempotency-key": "hook-x" }),
    );
    expect(stolen.status).toBe(200);
    const stolenText = await stolen.text();
    expect(stolenText).not.toContain(secret);
    expect(JSON.parse(stolenText)).toMatchObject({ id, secret: null });
  });

  it("refuses an Idempotency-Key longer than the field allows", async () => {
    const { app, owner } = await setup();
    const res = await app.request(
      req("POST", "/v1/owner/services", { name: "Tune-up" }, { ...owner, "idempotency-key": "k".repeat(201) }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "invalid_input" });
    const ok = await app.request(
      req("POST", "/v1/owner/services", { name: "Tune-up" }, { ...owner, "idempotency-key": "k".repeat(200) }),
    );
    expect(ok.status).toBe(201);
  });
});

describe("attribution and webhook headers", () => {
  it("delivers who caused each event, the door and sandbox, with the endpoint's headers, to subscribers only", async () => {
    const received: { url: string; headers: Headers; body: string }[] = [];
    const receiver: typeof fetch = async (input, init) => {
      received.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(null, { status: 204 });
    };
    const { app, db, inbox, owner, serviceId, pending } = await setup({ fetchImpl: receiver });
    const created = await app.request(
      req(
        "POST",
        "/v1/owner/webhooks",
        { url: RECEIVER, events: ["booking.*"], headers: { Authorization: "Bearer n8n-token", "X-Source": "inbox" } },
        owner,
      ),
    );
    expect(created.status).toBe(201);
    const hook = (await created.json()) as { id: string; headers: string[] };
    expect(hook.headers).toEqual(["Authorization", "X-Source"]);
    // Orders only: this one must hear nothing about bookings.
    await app.request(req("POST", "/v1/owner/webhooks", { url: `${RECEIVER}/orders`, events: ["order.*"] }, owner));
    expect(await (await app.request(req("GET", "/v1/owner/webhooks", undefined, owner))).text()).not.toContain(
      "n8n-token",
    );
    // Reserved and too many are refused, naming the field.
    const reserved = await app.request(
      req("PATCH", `/v1/owner/webhooks/${hook.id}`, { headers: { "Webhook-Signature": "x" } }, owner),
    );
    expect(reserved.status).toBe(422);
    // No header smuggling, and nothing a runtime's fetch would refuse on every delivery.
    for (const value of ["a\r\nHost: evil.example", "a\nX-Other: 1", "tab\u0001ctl", "café-€"]) {
      const bad = await app.request(
        req("PATCH", `/v1/owner/webhooks/${hook.id}`, { headers: { "X-Token": value } }, owner),
      );
      expect(bad.status, value).toBe(422);
    }
    for (const name of ["Host", "Content-Length", "Transfer-Encoding", "X Bad", "X-Bad\r\n"]) {
      const bad = await app.request(req("PATCH", `/v1/owner/webhooks/${hook.id}`, { headers: { [name]: "v" } }, owner));
      expect(bad.status, name).toBe(422);
    }
    const patched = await app.request(
      req("PATCH", `/v1/owner/webhooks/${hook.id}`, { headers: { "X-Source": null } }, owner),
    );
    expect(((await patched.json()) as { headers: string[] }).headers).toEqual(["Authorization"]);

    const zap = await mintKey(app, owner, { name: "Zapier", preset: "automation" });
    const itemId = await book(app, serviceId, { "x-sandbox": "1" });
    const confirmed = await app.request(
      req(
        "POST",
        `/v1/owner/items/${itemId}/transitions`,
        { event: "confirm" },
        { authorization: `Bearer ${zap.key}` },
      ),
    );
    expect(confirmed.status).toBe(200);
    await drain(inbox, db, pending);

    expect(received.every((r) => r.url === RECEIVER)).toBe(true);
    const bodies = received.map((r) => JSON.parse(r.body) as { type: string; data: Record<string, unknown> });
    const confirm = bodies.find((b) => b.type === "booking.confirm");
    expect(confirm?.data).toMatchObject({
      actor: { kind: "integration", id: zap.id, name: "Zapier" },
      channel: "rest",
      sandbox: true,
    });
    expect(bodies.find((b) => b.type === "booking.create")?.data.actor).toEqual({ kind: "customer_agent", id: null });
    for (const r of received) {
      expect(r.headers.get("authorization")).toBe("Bearer n8n-token");
      expect(r.headers.get("x-source")).toBeNull();
      expect(r.headers.get("webhook-signature")).toMatch(/^v1,/);
    }
    // The cursor carries the same attribution.
    const events = (await (
      await app.request(req("GET", "/v1/owner/events?types=booking.confirm", undefined, owner))
    ).json()) as { events: { data: Record<string, unknown> }[] };
    expect(events.events[0]?.data.actor).toEqual({ kind: "integration", id: zap.id, name: "Zapier" });
  });
});

describe("the doors integrators hit first", () => {
  it("pages public lists with a coerced limit and a cursor that moves", async () => {
    const { app, db } = await setup();
    for (const name of ["Brakes", "Chain", "Derailleur"]) {
      await db.orm.insert(schema.services).values({ id: ulid(), name, createdAt: T0, updatedAt: T0 });
      await db.orm
        .insert(schema.products)
        .values({ id: ulid(), name, price: { value: 100, currency: "EUR" }, createdAt: T0, updatedAt: T0 });
    }
    for (const list of ["services", "products"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res = await app.request(req("GET", `/v1/${list}?limit=1${cursor ? `&cursor=${cursor}` : ""}`));
        expect(res.status, await res.clone().text()).toBe(200);
        const body = (await res.json()) as { items: { name: string }[]; next_cursor: string | null };
        expect(body.items.length).toBeLessThanOrEqual(1);
        seen.push(...body.items.map((i) => i.name));
        cursor = body.next_cursor;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(list === "services" ? 4 : 3);
    }
    expect((await app.request(req("GET", "/v1/services?cursor=nope"))).status).toBe(422);
  });

  it("describes every owner operation with its security, its response and its query parameters", async () => {
    const { app } = await setup();
    const doc = (await (await app.request("https://inbox.example.com/openapi.json")).json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            security?: unknown;
            responses: Record<string, { content?: unknown }>;
            parameters?: { name: string; in: string }[];
          }
        >
      >;
    };
    const ownerOps = Object.entries(doc.paths).filter(([p]) => p.startsWith("/v1/owner/"));
    expect(ownerOps.flatMap(([, ops]) => Object.keys(ops)).length).toBeGreaterThan(45);
    for (const [path, ops] of ownerOps) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op.security, `${method} ${path}`).toEqual([{ ownerKey: [] }]);
        const ok = op.responses["200"] ?? op.responses["201"];
        expect(ok?.content, `${method} ${path}`).toBeDefined();
      }
    }
    const names = (path: string) => (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
    expect(names("/v1/owner/items")).toEqual(
      expect.arrayContaining(["type", "state", "needs_human", "cursor", "limit"]),
    );
    expect(names("/v1/owner/events")).toEqual(expect.arrayContaining(["cursor", "limit", "types", "since"]));
    expect(names("/v1/owner/deliveries")).toEqual(expect.arrayContaining(["webhook_id", "status", "cursor", "limit"]));
    expect(doc.paths["/v1/owner/services"]?.post?.parameters?.map((p) => p.name)).toContain("Idempotency-Key");
  });

  it("maps every owner route to its scopes, and nothing else", async () => {
    const { app } = await setup();
    const routes = app.routes
      .filter((r) => r.method !== "ALL" && r.path.startsWith("/v1/owner/"))
      .map((r) => `${r.method} ${r.path.slice("/v1/owner".length)}`);
    const unique = [...new Set(routes)].sort();
    expect(unique.filter((r) => !ROUTE_SCOPES[r])).toEqual([]);
    expect(Object.keys(ROUTE_SCOPES).sort()).toEqual(unique);
  });

  it("never hands a secret in settings to anyone, and keeps it when the document is written back", async () => {
    const { app, owner, ownerKey } = await setup();
    const secret = "inbound-secret-0123456789";
    await app.request(req("PUT", "/v1/owner/settings", { doc: { email: { inboundSecret: secret } } }, owner));
    const read = await app.request(req("GET", "/v1/owner/settings", undefined, owner));
    const body = (await read.json()) as { doc: Record<string, unknown>; version: number; redacted: string[] };
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.redacted).toEqual(["email.inboundSecret"]);
    const mcp = await connectOwner(app, ownerKey);
    const viaMcp = await mcp.callTool({ name: "get_settings", arguments: {} });
    expect(JSON.stringify(viaMcp)).not.toContain(secret);
    // The document written back as it was read keeps the secret: inbound mail still gets in.
    await app.request(req("PUT", "/v1/owner/settings", { doc: body.doc, expected_version: body.version }, owner));
    const mail = await app.request(
      new Request("https://inbox.example.com/v1/email/inbound", {
        method: "POST",
        headers: { "x-inbox-email-secret": secret },
        body: "From: a@example.com\r\nTo: shop@example.com\r\nSubject: hi\r\n\r\nhello",
      }),
    );
    expect(mail.status).not.toBe(401);
  });

  it("gives the owner's AI the product feed tools", async () => {
    const { app, ownerKey } = await setup();
    const mcp = await connectOwner(app, ownerKey);
    expect(text(await mcp.callTool({ name: "list_feeds", arguments: {} }))).toContain("No feeds yet");
    const added = await mcp.callTool({
      name: "add_feed",
      arguments: { url: "https://shop.example.com/feed.xml", name: "Shop", idempotency_key: "feed-1" },
    });
    expect(added.isError, text(added)).toBeFalsy();
    const feed = added.structuredContent as { id: string };
    const listed = await mcp.callTool({ name: "list_feeds", arguments: {} });
    expect((listed.structuredContent as { items: { id: string }[] }).items.map((f) => f.id)).toEqual([feed.id]);
    expect((await mcp.callTool({ name: "import_feed_now", arguments: { feed_id: feed.id } })).isError).toBeFalsy();
    const removed = await mcp.callTool({ name: "remove_feed", arguments: { feed_id: feed.id } });
    expect(removed.isError, text(removed)).toBeFalsy();
    expect(removed.structuredContent).toMatchObject({ removed: true });
  });
});
