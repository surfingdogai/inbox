import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { callerFromRequest, createSession, hashKey, ROUTE_SCOPES, TOOL_SCOPES } from "@surfingdog/adapters";
import {
  Capabilities,
  createDb,
  createSecretBox,
  type Db,
  MIGRATIONS,
  parseSecretKeys,
  readSettings,
  schema,
  sealWebhookSecrets,
  ulid,
} from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
// The published verifier, by path: packages/sdk/src/webhooks/verify.ts is unchanged since sdk-v0.1.1.
import { verifyWebhook } from "../../../packages/sdk/src/index";
import { type App, createInbox } from "../src/app";
import { freshDb, makeClient } from "./harness";

/**
 * Keys, scopes, idempotency and attribution, as the live instance meets them on upgrade: the rows,
 * credentials and clients the previous release left behind keep working, exactly as they did.
 * Everything here was created the way the previous release created it; nobody does anything new.
 * Runs on Node and inside workerd.
 */
const INBOX = "https://inbox.surfingdog.ai";
const RECEIVER = "https://receiver.example.com/hooks/inbox";
const SECRET_KEY = "upgrade-keys-instance-key-0123456789";
const INBOUND = "gateway-inbound-secret-0123456789";
const T0 = Date.parse("2026-09-20T09:00:00Z");
const DEFAULT_CONSENT = "inbox:read inbox:write settings:read offline_access";

/** The owner MCP tools the previous release had, with the arguments each required. */
const PREVIOUS_TOOLS: Record<string, string[]> = {
  list_items: [],
  get_item: ["item_id"],
  transition_item: ["event", "item_id"],
  get_profile: [],
  update_profile: [],
  list_services: [],
  upsert_service: [],
  archive_service: ["service_id"],
  list_products: [],
  upsert_product: [],
  archive_product: ["product_id"],
  get_availability: [],
  set_opening_hours: ["weekly"],
  clear_service_hours: ["service_id"],
  set_closures: ["closures"],
  list_rules: [],
  list_rule_presets: [],
  apply_rule_preset: ["preset"],
  upsert_rule: [],
  delete_rule: ["rule_id"],
  test_rule: ["definition", "item_id"],
  reply: ["body", "item_id"],
  list_webhooks: [],
  create_webhook: ["url"],
  update_webhook: ["webhook_id"],
  rotate_webhook_secret: ["webhook_id"],
  delete_webhook: ["webhook_id"],
  send_test_event: ["webhook_id"],
  list_webhook_deliveries: [],
  replay_webhook_delivery: ["delivery_id"],
  replay_missing_webhook_deliveries: ["since", "webhook_id"],
  list_events: [],
  get_settings: [],
  get_networks: [],
  update_settings: ["doc"],
};

/** An owner key exactly as the previous release stored it: no expiry, no maker, no last four. */
async function previousOwnerKey(db: Db): Promise<string> {
  const key = `sdi_own_${ulid()}${ulid()}`.toLowerCase();
  await db.client.query({
    sql: "INSERT INTO api_keys (id, prefix, hash, name, kind, scopes, created_at) VALUES (?, ?, ?, 'laptop', 'owner', '[\"*\"]', ?)",
    params: [ulid(T0), key.slice(0, 12), await hashKey(key), T0],
    method: "run",
  });
  return key;
}

/** An AI app connected through the consent page before this release, with the default scopes. */
async function previousOAuth(db: Db, userId = "user_1"): Promise<string> {
  const token = `sdi_at_${ulid()}${ulid()}`;
  await db.client.query({
    sql: "INSERT INTO oauth_clients (id, name, redirect_uris, kind, created_at) VALUES ('client_claude', 'Claude', '[\"https://claude.ai/cb\"]', 'cimd', ?) ON CONFLICT DO NOTHING",
    params: [T0],
    method: "run",
  });
  await db.client.query({
    sql: "INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, family_id, expires_at, created_at) VALUES (?, 'access', 'client_claude', ?, ?, ?, ?, ?)",
    params: [await hashKey(token), userId, DEFAULT_CONSENT, ulid(), Date.now() + 3_600_000, T0],
    method: "run",
  });
  return token;
}

function inboxOn(db: Db, fetchImpl?: typeof fetch) {
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    secretKey: SECRET_KEY,
    baseUrl: INBOX,
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const request = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    inbox.app.request(`${INBOX}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const drain = async () => {
    await Promise.allSettled(pending.splice(0));
    for (let i = 0; i < 20; i++) if ((await inbox.runner.runDue(db, { workerId: "t" })).claimed === 0) break;
  };
  return { inbox, app: inbox.app, request, drain };
}

async function connectOwner(app: App, bearer: string) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    merged.set("authorization", `Bearer ${bearer}`);
    return app.request(String(input), { ...init, headers: merged });
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${INBOX}/mcp/owner`), { fetch: fetchLike });
  const client = new Client({ name: "claude", version: "0" });
  await client.connect(transport);
  return client;
}

const text = (r: { content: unknown }) => (r.content as { text?: string }[])[0]?.text ?? "";

async function seedBusiness(db: Db) {
  const serviceId = ulid(T0);
  await db.orm.insert(schema.services).values({
    id: serviceId,
    name: "Intro call",
    durationMin: 30,
    capacity: 5,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  return serviceId;
}

async function book(request: ReturnType<typeof inboxOn>["request"], serviceId: string, hour = 9): Promise<string> {
  const res = await request(
    "POST",
    "/v1/bookings",
    {},
    {
      payload: {
        reservationFor: { serviceId, name: "Intro call" },
        startTime: `2026-10-05T${String(hour).padStart(2, "0")}:00:00Z`,
        endTime: `2026-10-05T${String(hour).padStart(2, "0")}:30:00Z`,
      },
      contact: { name: "Rita", email: "rita@example.com" },
    },
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { view: { item: { id: string } } }).view.item.id;
}

describe("upgrading to keys, scopes and attribution", () => {
  // First in the file: on workerd a file starts with an empty database, and this one needs it.
  it("upgrades the previous release's database in place, and a second run changes nothing", async () => {
    const client = await makeClient();
    expect(
      await runMigrations(
        client,
        MIGRATIONS.filter((m) => m.version <= 7),
      ),
    ).toBe(7);
    const db = createDb(client);
    // What the previous release left: an owner key, an endpoint, an item with two events (one
    // from before events carried a channel), and its settings.
    const key = `sdi_own_${ulid()}${ulid()}`.toLowerCase();
    const keyId = ulid(T0);
    const webhookId = ulid(T0);
    const box = createSecretBox(parseSecretKeys(SECRET_KEY));
    if (!box) throw new Error("no secret box");
    const secretEnc = await sealWebhookSecrets(box, webhookId, { current: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" });
    await client.batch([
      { sql: "DELETE FROM api_keys", method: "run" },
      {
        sql: "INSERT INTO api_keys (id, prefix, hash, name, kind, scopes, created_at) VALUES (?, ?, ?, 'laptop', 'owner', '[\"*\"]', ?)",
        params: [keyId, key.slice(0, 12), await hashKey(key), T0],
        method: "run",
      },
      { sql: "DELETE FROM webhooks", method: "run" },
      {
        sql: "INSERT INTO webhooks (id, url, secret_enc, events, payload_style, active, created_at, updated_at) VALUES (?, ?, ?, '[\"*\"]', 'thin', 1, ?, ?)",
        params: [webhookId, RECEIVER, secretEnc, T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('party_1', 'person', ?, ?) ON CONFLICT DO NOTHING",
        params: [T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES ('item_1', 'booking', 'confirmed', 2, 'party_1', 'email', '{}', '{}', ?, ?) ON CONFLICT DO NOTHING",
        params: [T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES ('01JD00000000000000000000A1', 'item_1', 1, 'create', NULL, 'requested', 'customer_human', 'anon:x', 0, ?) ON CONFLICT DO NOTHING",
        params: [T0],
        method: "run",
      },
      {
        sql: `INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, meta, depth, created_at) VALUES ('01JD00000000000000000000A2', 'item_1', 2, 'confirm', 'requested', 'confirmed', 'owner', 'user_1', '{"channel":"owner_ui","tier":"verified_principal"}', 0, ?) ON CONFLICT DO NOTHING`,
        params: [T0 + 1],
        method: "run",
      },
    ]);

    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);

    const { request } = inboxOn(db);
    const auth = { authorization: `Bearer ${key}` };
    expect((await request("GET", "/v1/owner/items", auth)).status).toBe(200);
    const keys = (await (await request("GET", "/v1/owner/api-keys", auth)).json()) as {
      items: { id: string; kind: string; scopes: string[]; active: boolean; created_by: string | null }[];
    };
    expect(keys.items.find((k) => k.id === keyId)).toMatchObject({
      kind: "owner",
      scopes: ["*"],
      active: true,
      created_by: "cli",
    });
    const hooks = (await (await request("GET", "/v1/owner/webhooks", auth)).json()) as {
      items: { id: string; headers: string[]; active: boolean }[];
    };
    expect(hooks.items.find((w) => w.id === webhookId)).toMatchObject({ headers: [], active: true });
    const events = (await (await request("GET", "/v1/owner/events", auth)).json()) as {
      events: { id: string; data: Record<string, unknown> }[];
    };
    const byId = new Map(events.events.map((e) => [e.id, e.data]));
    // Events from before carry what they always carried, and the new fields from what was stored.
    expect(byId.get("01JD00000000000000000000A1")).toMatchObject({
      id: "item_1",
      type: "booking",
      state: "requested",
      version: 1,
      actor: { kind: "customer_human", id: null },
      channel: "email",
      sandbox: false,
    });
    expect(byId.get("01JD00000000000000000000A2")).toMatchObject({
      actor: { kind: "owner", id: "user_1" },
      channel: "owner_ui",
    });
    const refusals = await client.query({ sql: "SELECT count(*) FROM scope_refusals", method: "all" });
    expect(Number(refusals.rows[0]?.[0])).toBe(0);
  });

  it("keeps every right of an owner key minted before scopes, even with scopes enforced", async () => {
    const db = await freshDb();
    const key = await previousOwnerKey(db);
    const caps = new Capabilities(db);
    await caps.updateSettings(
      { actor: { kind: "owner", id: "owner", channel: "owner_ui" }, tier: "verified_principal", sandbox: false },
      { doc: { security: { enforceScopes: true } } },
    );
    expect((await readSettings(db)).security.enforceScopes).toBe(true);
    // Through the one check every owner route and tool runs: all of them, none recorded.
    for (const channel of ["rest", "mcp_owner"] as const) {
      const caller = await callerFromRequest(
        db,
        new Request(`${INBOX}/v1/owner/items`, { headers: { authorization: `Bearer ${key}` } }),
        { channel },
      );
      expect(caller.actor.kind).toBe("owner");
      for (const [op, scopes] of Object.entries(ROUTE_SCOPES)) await caps.access.requireScope(caller, scopes, op);
      for (const [tool, scopes] of Object.entries(TOOL_SCOPES)) {
        await caps.access.requireScope(caller, scopes, `mcp:${tool}`);
      }
    }
    const refusals = await db.client.query({ sql: "SELECT count(*) FROM scope_refusals", method: "all" });
    expect(Number(refusals.rows[0]?.[0])).toBe(0);
    // And through the doors, writes included.
    const { request, app } = inboxOn(db);
    const auth = { authorization: `Bearer ${key}` };
    expect((await request("POST", "/v1/owner/services", auth, { name: "Board" })).status).toBe(201);
    expect(
      (await request("PUT", "/v1/owner/settings", auth, { doc: { booking: { autoExpireHours: 48 } } })).status,
    ).toBe(200);
    const mcp = await connectOwner(app, key);
    const r = await mcp.callTool({ name: "upsert_service", arguments: { name: "Lesson" } });
    expect(r.isError, text(r)).toBeFalsy();
  });

  it("lets an AI connected with the default consent use every tool it had, recording instead of refusing", async () => {
    const db = await freshDb();
    const serviceId = await seedBusiness(db);
    const token = await previousOAuth(db);
    const { request, app, drain } = inboxOn(db);
    const itemId = await book(request, serviceId);
    await drain();
    const mcp = await connectOwner(app, token);
    const listed = new Map((await mcp.listTools()).tools.map((t) => [t.name, t]));
    const hook = await mcp.callTool({ name: "create_webhook", arguments: { url: RECEIVER } });
    expect(hook.isError, text(hook)).toBeFalsy();
    const webhookId = (hook.structuredContent as { id: string }).id;
    const rule = {
      on: ["item.created"],
      if: { all: [{ path: "item.type", op: "eq", value: "order" }] },
      actions: [{ action: "set_flags", priority: 1 }],
    };
    const args: Record<string, Record<string, unknown>> = {
      get_item: { item_id: itemId },
      transition_item: { item_id: itemId, event: "decline", input: { note: "full" } },
      update_profile: { name: "Surfing Dog" },
      upsert_service: { name: "Board" },
      archive_service: { service_id: serviceId },
      upsert_product: { name: "Wax", price: { value: 500, currency: "EUR" } },
      archive_product: { product_id: "none" },
      set_opening_hours: { weekly: { mon: [["09:00", "17:00"]] } },
      clear_service_hours: { service_id: serviceId },
      set_closures: { closures: [{ from: "2026-12-24", to: "2026-12-26" }] },
      apply_rule_preset: { preset: "appointments" },
      upsert_rule: { name: "Flag orders", definition: rule },
      delete_rule: { rule_id: "none" },
      test_rule: { definition: rule, item_id: itemId },
      reply: { item_id: itemId, body: "A note", internal: true },
      create_webhook: { url: `${RECEIVER}/2` },
      update_webhook: { webhook_id: webhookId, active: true },
      rotate_webhook_secret: { webhook_id: webhookId },
      send_test_event: { webhook_id: webhookId },
      list_webhook_deliveries: { webhook_id: webhookId },
      replay_webhook_delivery: { delivery_id: "none" },
      replay_missing_webhook_deliveries: { webhook_id: webhookId, since: "2026-09-01T00:00:00Z" },
      update_settings: { doc: { booking: { autoExpireHours: 36 } } },
      delete_webhook: { webhook_id: webhookId },
    };
    for (const [name, required] of Object.entries(PREVIOUS_TOOLS)) {
      const t = listed.get(name);
      expect(t, name).toBeDefined();
      // The same arguments required as before: none newly required.
      const now = (t?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
      expect([...now].sort(), name).toEqual([...required].sort());
      const r = await mcp.callTool({ name, arguments: args[name] ?? {} });
      // Some calls fail on their own merits (an id that does not exist); none on its scopes.
      expect(text(r), name).not.toMatch(/not given the scope|not_allowed/);
    }
    // Recorded for the owner to see, one row per tool, none refused.
    const { rows } = await db.client.query({
      sql: "SELECT principal_kind, principal_id, enforced FROM scope_refusals",
      method: "all",
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((r) => String(r[0]) === "owner_ai" && String(r[1]) === "client_claude" && Number(r[2]) === 0),
    ).toBe(true);
  });

  it("takes back the whole settings document an AI read, security and masked secret included", async () => {
    const db = await freshDb();
    const token = await previousOAuth(db);
    const caps = new Capabilities(db);
    const owner = {
      actor: { kind: "owner" as const, id: "owner", channel: "owner_ui" as const },
      tier: "verified_principal" as const,
      sandbox: false,
    };
    await caps.updateSettings(owner, { doc: { email: { inboundSecret: INBOUND } } });
    const { app } = inboxOn(db);
    const mcp = await connectOwner(app, token);
    const read = (await mcp.callTool({ name: "get_settings", arguments: {} })).structuredContent as {
      doc: Record<string, Record<string, unknown>>;
      version: number;
      redacted: string[];
    };
    // The shape the previous release returned, secret key included; the value is not the secret.
    expect(read.doc.email?.inboundSecret).toBe("(redacted)");
    expect(read.redacted).toEqual(["email.inboundSecret"]);
    expect(read.doc.security).toEqual({ aiMayCreateKeys: false, enforceScopes: false });
    const echoed = await mcp.callTool({
      name: "update_settings",
      arguments: {
        doc: { ...read.doc, booking: { ...read.doc.booking, autoExpireHours: 24 } },
        expected_version: read.version,
      },
    });
    expect(echoed.isError, text(echoed)).toBeFalsy();
    const { rows } = await db.client.query({ sql: "SELECT doc FROM settings", method: "all" });
    const stored = JSON.parse(String(rows[0]?.[0])) as Record<string, Record<string, unknown>>;
    expect(stored.email?.inboundSecret).toBe(INBOUND);
    expect(stored.booking?.autoExpireHours).toBe(24);
    // Sent back unchanged, the section is not written as if the owner had chosen it.
    expect(stored).not.toHaveProperty("security");
    // A change is still the owner's alone.
    const grant = await mcp.callTool({
      name: "update_settings",
      arguments: { doc: { ...read.doc, security: { aiMayCreateKeys: true, enforceScopes: false } } },
    });
    expect(grant.isError).toBe(true);
    expect((await readSettings(db)).security.aiMayCreateKeys).toBe(false);
  });

  it("lets an owner app tab from before the upgrade save General without wiping the inbound secret", async () => {
    const db = await freshDb();
    const userId = ulid(T0);
    await db.orm
      .insert(schema.users)
      .values({ id: userId, email: "hello@surfingdog.ai", role: "owner", createdAt: T0 });
    const session = await createSession(db, userId, new Request(INBOX));
    const key = await previousOwnerKey(db);
    const { request } = inboxOn(db);
    const put = (headers: Record<string, string>, body: unknown) => request("PUT", "/v1/owner/settings", headers, body);
    // Signed in by link (the session) and by a pasted owner key (a bearer): the tab's two ways in.
    for (const headers of [
      { cookie: `sdi_session=${session.token}`, origin: INBOX },
      { authorization: `Bearer ${key}` },
    ]) {
      expect((await put(headers, { doc: { email: { inboundSecret: INBOUND } } })).status).toBe(200);
      const loaded = (await (await request("GET", "/v1/owner/settings", headers)).json()) as {
        doc: PreviousDoc;
        version: number;
      };
      const form = { ...previousToSettingsForm(loaded.doc), cancellationWindowMin: "90" };
      const saved = await put(headers, { doc: previousToSettingsDoc(form), expected_version: loaded.version });
      expect(saved.status, await saved.clone().text()).toBe(200);
      expect((await readSettings(db)).email.inboundSecret).toBe(INBOUND);
      expect((await readSettings(db)).booking.cancellationWindowMin).toBe(90);
      const mail = await request("POST", "/v1/email/inbound", { "x-inbox-email-secret": INBOUND }, undefined);
      expect(mail.status).not.toBe(401);
    }
    // Emptying the field in that tab still removes it, as it always did.
    const headers = { authorization: `Bearer ${key}` };
    const loaded = (await (await request("GET", "/v1/owner/settings", headers)).json()) as {
      doc: PreviousDoc;
      version: number;
    };
    const form = { ...previousToSettingsForm(loaded.doc), inboundSecret: "" };
    expect((await put(headers, { doc: previousToSettingsDoc(form) })).status).toBe(200);
    expect((await readSettings(db)).email.inboundSecret).toBeUndefined();
  });

  it("fires the owner's own rules on what their AI and their keys decide, while the history says who", async () => {
    const db = await freshDb();
    const serviceId = await seedBusiness(db);
    const token = await previousOAuth(db);
    const ownerKey = await previousOwnerKey(db);
    const { request, drain } = inboxOn(db);
    const owner = { authorization: `Bearer ${ownerKey}` };
    // A rule written before this release for "anything I decide".
    const rule = await request("POST", "/v1/owner/rules", owner, {
      name: "My decisions are urgent",
      definition: {
        on: ["item.transitioned"],
        if: { all: [{ path: "event.actorKind", op: "eq", value: "owner" }] },
        actions: [{ action: "set_flags", priority: 3 }],
      },
    });
    expect(rule.status).toBe(201);
    const zap = (await (
      await request("POST", "/v1/owner/api-keys", owner, { name: "Zapier", preset: "automation" })
    ).json()) as { key: string };
    for (const [who, auth, hour] of [
      ["owner_ai", { authorization: `Bearer ${token}` }, 9],
      ["integration", { authorization: `Bearer ${zap.key}` }, 10],
    ] as const) {
      const itemId = await book(request, serviceId, hour);
      await drain();
      const moved = await request("POST", `/v1/owner/items/${itemId}/transitions`, auth, { event: "decline" });
      expect(moved.status, await moved.clone().text()).toBe(200);
      await drain();
      const detail = (await (await request("GET", `/v1/owner/items/${itemId}`, owner)).json()) as {
        item: { flags: { priority: number } };
        events: { event: string; by: { kind: string } }[];
      };
      expect(detail.item.flags.priority, who).toBe(3);
      expect(detail.events.find((e) => e.event === "decline")?.by.kind).toBe(who);
    }
  });

  it("keeps an endpoint's payload and signature for the published verifier", async () => {
    const db = await freshDb();
    const serviceId = await seedBusiness(db);
    const key = await previousOwnerKey(db);
    const sent: { headers: Record<string, string>; body: string }[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      sent.push({ headers, body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const { request, drain } = inboxOn(db, fetchImpl);
    const auth = { authorization: `Bearer ${key}` };
    // Added the way the previous release added it: no extra headers.
    const created = (await (
      await request("POST", "/v1/owner/webhooks", auth, { url: RECEIVER, events: ["booking.*"] })
    ).json()) as { secret: string };
    await book(request, serviceId);
    await drain();
    expect(sent.length).toBeGreaterThan(0);
    for (const d of sent) {
      const event = (await verifyWebhook({ payload: d.body, headers: d.headers, secret: created.secret })) as {
        type: string;
        data: Record<string, unknown>;
      };
      // Every field the previous release sent, with its type; the new ones beside them.
      expect(event.data).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          type: "booking",
          state: expect.any(String),
          version: expect.any(Number),
          url: expect.stringContaining(`${INBOX}/v1/owner/items/`),
          actor: expect.objectContaining({ kind: expect.any(String) }),
          sandbox: false,
        }),
      );
      // The same headers as before, and no other.
      expect(Object.keys(d.headers).sort()).toEqual([
        "accept",
        "content-type",
        "sdi-delivery-attempt",
        "sdi-event-type",
        "user-agent",
        "webhook-id",
        "webhook-signature",
        "webhook-timestamp",
      ]);
    }
  });
});

// ---- the previous owner app's General form, as it shipped (apps/inbox/client/src/lib/settings.ts) ----

type PreviousDoc = {
  booking: { cancellationWindowMin: number; holdOnPropose: boolean; autoExpireHours: number };
  orders: { maxValueWithoutApprovalMinor: number };
  notifications: { ownerEmail?: string; appUrl?: string };
  email: { fromAddress?: string; fromName?: string; replyTo?: string; inboundSecret?: string };
  testMode: boolean;
};

function previousToSettingsForm(doc: PreviousDoc) {
  return {
    cancellationWindowMin: String(doc.booking.cancellationWindowMin),
    holdOnPropose: doc.booking.holdOnPropose,
    autoExpireHours: String(doc.booking.autoExpireHours),
    approvalLimit: doc.orders.maxValueWithoutApprovalMinor
      ? (doc.orders.maxValueWithoutApprovalMinor / 100).toFixed(2)
      : "",
    ownerEmail: doc.notifications.ownerEmail ?? "",
    appUrl: doc.notifications.appUrl ?? "",
    fromAddress: doc.email.fromAddress ?? "",
    fromName: doc.email.fromName ?? "",
    replyTo: doc.email.replyTo ?? "",
    inboundSecret: doc.email.inboundSecret ?? "",
    testMode: doc.testMode,
  };
}

function previousToSettingsDoc(f: ReturnType<typeof previousToSettingsForm>): Record<string, unknown> {
  const num = (s: string): number | string => {
    const t = s.trim();
    return t !== "" && Number.isFinite(Number(t)) ? Number(t) : t;
  };
  const opt = (s: string): string | null => (s.trim() ? s.trim() : null);
  const limit = f.approvalLimit.trim() ? Math.round(Number(f.approvalLimit.replace(",", ".")) * 100) : 0;
  return {
    booking: {
      cancellationWindowMin: num(f.cancellationWindowMin),
      holdOnPropose: f.holdOnPropose,
      autoExpireHours: num(f.autoExpireHours),
    },
    orders: { maxValueWithoutApprovalMinor: Number.isFinite(limit) ? limit : f.approvalLimit.trim() },
    notifications: { ownerEmail: opt(f.ownerEmail), appUrl: opt(f.appUrl) },
    email: {
      fromAddress: opt(f.fromAddress),
      fromName: opt(f.fromName),
      replyTo: opt(f.replyTo),
      inboundSecret: opt(f.inboundSecret),
    },
    testMode: f.testMode,
  };
}
