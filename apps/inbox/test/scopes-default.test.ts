import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  createApiKey,
  DEFAULT_AI_SCOPES,
  OWNER_SCOPES,
  PHONE_OPERATIONS,
  PHONE_SCOPES,
  ROUTE_SCOPES,
  routeScopes,
  TOOL_SCOPES,
} from "@surfingdog/adapters";
import { DEFAULT_SETTINGS, holdsScope, KEY_PRESETS, schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type App, createInbox } from "../src/app";
import { freshDb, futureDay, openWeekdays } from "./harness";

/**
 * Scopes are refused out of the box (security.enforceScopes, 2 November 2026). Before the default
 * moved, every caller of our own was checked against it: what each one calls is within the scopes it
 * holds, so none of them meets the refusal. The owner app and the owner's own keys hold everything;
 * the email gateway, connectors, feeds, the demo and the seeds call as the inbox itself, with no
 * principal, and their own tests run under the new default.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const DAY = futureDay();
const INBOX = "https://inbox.example.com";

const preset = (key: string): readonly string[] => KEY_PRESETS.find((p) => p.key === key)?.scopes ?? [];
const covers = (held: readonly string[], operation: string) => holdsScope(held, routeScopes(operation));

describe("scopes refused out of the box", () => {
  it("is the default, and an AI app that asks for no scopes is offered all an AI may hold but keys:write", () => {
    expect(DEFAULT_SETTINGS.security.enforceScopes).toBe(true);
    expect(DEFAULT_AI_SCOPES).toEqual(OWNER_SCOPES.filter((s) => s !== "keys:write"));
    for (const s of ["keys:write", "customers:erase", "money:write", "forms:submit"])
      expect(DEFAULT_AI_SCOPES, s).not.toContain(s);
    // Every owner tool an AI may use is covered by it, but the keys' own.
    const uncovered = Object.entries(TOOL_SCOPES)
      .filter(([, scopes]) => !holdsScope(DEFAULT_AI_SCOPES, scopes))
      .map(([tool]) => tool);
    expect(uncovered.sort()).toEqual(["create_api_key", "revoke_api_key"]);
  });

  it("lets a phone do everything a phone does: each of its operations is within its scopes", () => {
    for (const op of PHONE_OPERATIONS) {
      expect(ROUTE_SCOPES[op], op).toBeDefined();
      expect(covers(PHONE_SCOPES, op), op).toBe(true);
    }
  });

  it("gives each preset what the system it is for calls", () => {
    const calls: Record<string, readonly string[]> = {
      // n8n, Zapier, Make: an event's item, a reply, a move, the event stream.
      automation: [
        "GET /items",
        "GET /items/:id",
        "POST /items/:id/replies",
        "POST /items/:id/transitions",
        "GET /items/:id/offers",
        "GET /events",
      ],
      shop_sync: [
        "GET /products",
        "POST /products",
        "PATCH /products/:id",
        "DELETE /products/:id",
        "GET /catalogue",
        "GET /items/:id",
        "POST /items/:id/transitions",
        "GET /events",
      ],
      calendar_sync: [
        "GET /availability",
        "PUT /availability",
        "PUT /availability/closures",
        "GET /items/:id",
        "POST /items/:id/transitions",
        "GET /events",
      ],
      read_only: ["GET /items", "GET /items/:id", "GET /events", "GET /settings", "GET /services", "GET /products"],
    };
    for (const [key, ops] of Object.entries(calls))
      for (const op of ops) expect(covers(preset(key), op), `${key}: ${op}`).toBe(true);
    // And none of them changes the settings, mints a key or changes the rules.
    for (const p of KEY_PRESETS)
      for (const op of ["PUT /settings", "POST /api-keys", "POST /rules"])
        expect(covers(p.scopes, op), `${p.key}: ${op}`).toBe(false);
  });

  it("names no scope to ask for where no scope lets a key through: keys, and connecting a system", async () => {
    const PERSON_ONLY = [
      "POST /integrations",
      "POST /integrations/authorize",
      "PATCH /integrations/:id",
      "POST /integrations/:id/link",
      "DELETE /integrations/:id",
      "POST /property/system",
      "POST /items/:id/job-tool",
    ];
    for (const op of PERSON_ONLY) expect(ROUTE_SCOPES[op], op).toEqual(["*"]);
    // Listing and syncing a connection stay a key's with integrations:write.
    for (const op of ["GET /integrations", "POST /integrations/:id/sync"])
      expect(holdsScope(["integrations:write"], routeScopes(op)), op).toBe(true);

    const db = await freshDb();
    const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
    const app = createInbox({
      db,
      secretKey: "2f8c1d0a6b4e37925c8f01ad6e3b47f0",
      baseUrl: INBOX,
      eventSettleMs: 0,
    }).app;
    const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      app.request(`${INBOX}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const minted = await call("POST", "/v1/owner/api-keys", owner, { name: "Sync", scopes: ["integrations:write"] });
    expect(minted.status).toBe(201);
    const sync = { authorization: `Bearer ${((await minted.json()) as { key: string }).key}` };
    for (const [method, path, body] of [
      ["POST", "/v1/owner/integrations", { kind: "ics_feed" }],
      ["POST", "/v1/owner/api-keys", { name: "More", preset: "read_only" }],
    ] as const) {
      const r = await call(method, path, sync, body);
      expect(r.status, path).toBe(403);
      const answer = (await r.json()) as { detail: string; details: { reason: string } };
      expect(answer.details.reason, path).toBe("owner_only");
      expect(answer.detail, path).toContain("which only the owner does, in person");
      expect(answer.detail, path).not.toContain("Settings → Keys, for this system");
    }
  });

  it("runs the n8n flow end to end with an Automation tool key, and refuses it the settings", async () => {
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
    await openWeekdays(db);
    const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
    const inbox = createInbox({ db, secretKey: "2f8c1d0a6b4e37925c8f01ad6e3b47f0", baseUrl: INBOX, eventSettleMs: 0 });
    const app = inbox.app;
    const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      app.request(`${INBOX}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const minted = await call("POST", "/v1/owner/api-keys", owner, { name: "n8n", preset: "automation" });
    const n8n = { authorization: `Bearer ${((await minted.json()) as { key: string }).key}` };

    // A message and a booking, as the webhook would announce them.
    const message = await call("POST", "/v1/messages", {}, { body: "Open on Sunday?", contact: { name: "João" } });
    const messageId = ((await message.json()) as { view: { item: { id: string } } }).view.item.id;
    const booking = await call(
      "POST",
      "/v1/bookings",
      {},
      {
        payload: {
          reservationFor: { serviceId, name: "Full service" },
          startTime: `${DAY}T09:00:00Z`,
          endTime: `${DAY}T10:30:00Z`,
        },
        contact: { name: "Rita", email: "rita@example.com" },
      },
    );
    const bookingId = ((await booking.json()) as { view: { item: { id: string } } }).view.item.id;

    // The flow: read the event's item, reply, confirm, and poll the stream.
    const read = await call("GET", `/v1/owner/items/${messageId}`, n8n);
    expect(read.status, await read.clone().text()).toBe(200);
    const replied = await call(
      "POST",
      `/v1/owner/items/${messageId}/replies`,
      { ...n8n, "idempotency-key": "evt-1" },
      { body: "Yes, from ten." },
    );
    expect(replied.status, await replied.clone().text()).toBe(200);
    const confirmed = await call(
      "POST",
      `/v1/owner/items/${bookingId}/transitions`,
      { ...n8n, "idempotency-key": "evt-2" },
      { event: "confirm" },
    );
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect((await call("GET", "/v1/owner/events?limit=10", n8n)).status).toBe(200);
    // The same through the owner MCP.
    const mcp = await connect(app, n8n.authorization);
    for (const [name, args] of [
      ["list_items", {}],
      ["get_item", { item_id: messageId }],
      ["list_events", {}],
    ] as const) {
      const r = await mcp.callTool({ name, arguments: args });
      expect(r.isError, `${name}: ${JSON.stringify(r.content)}`).toBeFalsy();
    }

    // Nothing of ours went outside its scopes.
    const listed = (await (await call("GET", "/v1/owner/api-keys", owner)).json()) as {
      items: { name: string; refusals: unknown[] }[];
    };
    expect(listed.items.find((k) => k.name === "n8n")?.refusals).toEqual([]);

    // What it was never for is refused, with why, and changes nothing.
    const put = await call("PUT", "/v1/owner/settings", n8n, { doc: { booking: { autoExpireHours: 6 } } });
    expect(put.status).toBe(403);
    expect(await put.json()).toMatchObject({
      details: { reason: "outside_scopes", required_scopes: ["settings:write"] },
    });
    const tool = await mcp.callTool({
      name: "update_settings",
      arguments: { doc: { booking: { autoExpireHours: 6 } } },
    });
    expect(tool.isError).toBe(true);
    expect(JSON.stringify(tool.content)).toContain('the key \\"n8n\\" was not given the scope settings:write');
  });
});

async function connect(app: App, authorization: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${INBOX}/mcp/owner`), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", authorization);
      return app.request(String(input), { ...init, headers });
    },
  });
  const client = new Client({ name: "n8n", version: "0" });
  await client.connect(transport);
  return client;
}
