import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey, TOOL_SCOPES } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { freshDb } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");

async function connect(app: App, path: string, headers: Record<string, string> = {}) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return app.request(String(input), { ...init, headers: merged });
  };
  const transport = new StreamableHTTPClientTransport(new URL(`https://inbox.test${path}`), { fetch: fetchLike });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  return client;
}

describe("MCP doors", () => {
  it("lists the public tools and books through them", async () => {
    const db = await freshDb();
    const svc = ulid();
    await db.orm.insert(schema.services).values({
      id: svc,
      name: "Full service",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      createdAt: T0,
      updatedAt: T0,
    });
    const app = createApp({ db });
    const client = await connect(app, "/mcp");
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      "get_business_profile",
      "list_services",
      "list_products",
      "check_availability",
      "request_quote",
      "create_booking",
      "create_order",
      "get_item_status",
      "cancel_item",
      "send_message",
      "acknowledge_receipt",
      "verify_customer",
    ]);
    const booked = await client.callTool({
      name: "create_booking",
      arguments: {
        payload: {
          reservationFor: { serviceId: svc, name: "Full service" },
          startTime: "2026-09-22T08:00:00Z",
          endTime: "2026-09-22T09:30:00Z",
        },
        contact: { name: "Ana" },
        idempotency_key: "mcp-1",
      },
    });
    const structured = booked.structuredContent as {
      view: { item: { id: string; state: string } };
      accessToken: string;
    };
    expect(booked.isError, JSON.stringify(booked.content)).toBeFalsy();
    expect(structured.view.item.state).toBe("requested");
    const text = (booked.content as { type: string; text: string }[])[0]?.text ?? "";
    // The business answers its customer in its own voice.
    expect(text).toMatch(/^Your booking "Full service" .* is with us; we will confirm it or suggest another time\./);
    expect(text).toContain(structured.accessToken);

    const bad = await client.callTool({
      name: "create_booking",
      arguments: { payload: { reservationFor: { serviceId: svc } } },
    });
    expect(bad.isError).toBe(true);
    // The SDK validates arguments before the tool runs and names the offending fields itself.
    expect((bad.content as { text: string }[])[0]?.text).toMatch(/startTime/);
  });

  it("orders at the business's price through the public tools, whatever price the assistant sends", async () => {
    const db = await freshDb();
    const product = ulid();
    await db.orm.insert(schema.products).values({
      id: product,
      sku: "SD-1",
      name: "Saddle",
      price: { value: 15_000, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    });
    const client = await connect(createApp({ db }), "/mcp");
    const tools = await client.listTools();
    expect(tools.tools.find((t) => t.name === "create_order")?.description).toContain("business's price");
    const ordered = await client.callTool({
      name: "create_order",
      arguments: {
        payload: {
          orderedItem: [{ productId: product, name: "Saddle", quantity: 1, price: { value: 100, currency: "EUR" } }],
          totalPrice: { value: 100, currency: "EUR" },
        },
        idempotency_key: "mcp-order-1",
      },
    });
    expect(ordered.isError, JSON.stringify(ordered.content)).toBeFalsy();
    const structured = ordered.structuredContent as { view: { item: { payload: object } } };
    expect(structured.view.item.payload).toMatchObject({
      totalPrice: { value: 15_000, currency: "EUR" },
      customerStatedPrice: { value: 100, currency: "EUR" },
    });
    // Many assistants read only the text: it carries the business's price, in the business's words.
    expect((ordered.content as { text: string }[])[0]?.text).toContain("Our price is €150.00.");
  });

  it("does not offer the owner's AI a correction whose time has passed", async () => {
    const db = await freshDb();
    const app = createApp({ db });
    const now = Date.now();
    const HOUR = 3_600_000;
    const booked = (id: string, end: number) => [
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at, closed_at) VALUES (?, 'booking', 'completed', 3, 'p1', 'form', ?, ?, ?, ?, ?)",
        params: [
          id,
          JSON.stringify({
            reservationFor: { serviceId: "svc_1", name: "Surf lesson" },
            startTime: new Date(end - 90 * 60_000).toISOString(),
            endTime: new Date(end).toISOString(),
          }),
          JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 }),
          end,
          end,
          end,
        ],
        method: "run" as const,
      },
      ...["create:requested", "confirm:confirmed", "complete:completed"].map((step, i) => {
        const [event, to] = step.split(":");
        return {
          sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES (?, ?, ?, ?, NULL, ?, 'owner', 'u1', 0, ?)",
          params: [ulid(), id, i + 1, event, to, end],
          method: "run" as const,
        };
      }),
    ];
    await db.client.batch([
      { sql: "INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('p1', 'human', 0, 0)", method: "run" },
      ...booked("bk_old", now - 5 * 24 * HOUR),
      ...booked("bk_new", now - HOUR),
    ]);
    const owner = await createApiKey(db, { kind: "owner", name: "t" });
    const client = await connect(app, "/mcp/owner", { authorization: `Bearer ${owner.key}` });
    const text = async (id: string) =>
      ((await client.callTool({ name: "get_item", arguments: { item_id: id } })).content as { text: string }[])[0]
        ?.text ?? "";
    expect(await text("bk_old")).toMatch(/Next: nothing\.$/);
    expect(await text("bk_new")).toContain("Next: no_show (Correct: no-show).");
  });

  it("guards the owner tools behind an owner key", async () => {
    const db = await freshDb();
    const app = createApp({ db });
    await expect(connect(app, "/mcp/owner")).rejects.toThrow();
    const owner = await createApiKey(db, { kind: "owner", name: "t" });
    const client = await connect(app, "/mcp/owner", { authorization: `Bearer ${owner.key}` });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      "list_items",
      "get_item",
      "transition_item",
      "get_profile",
      "update_profile",
      "list_services",
      "upsert_service",
      "archive_service",
      "list_products",
      "upsert_product",
      "archive_product",
      "get_availability",
      "set_opening_hours",
      "clear_service_hours",
      "set_closures",
      "list_rules",
      "list_rule_presets",
      "apply_rule_preset",
      "upsert_rule",
      "delete_rule",
      "test_rule",
      "reply",
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
      "list_feeds",
      "add_feed",
      "import_feed_now",
      "remove_feed",
      "get_settings",
      "get_networks",
      "update_settings",
      "list_api_keys",
      "create_api_key",
      "revoke_api_key",
    ]);
    // Every owner tool names the scopes that let a caller through; one missing is a gap in the
    // log-first record and, once scopes are enforced, a tool only the owner could call.
    for (const t of tools.tools) expect(TOOL_SCOPES[t.name], t.name).toBeDefined();
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual(tools.tools.map((t) => t.name).sort());
    const settings = await client.callTool({ name: "get_settings", arguments: {} });
    expect((settings.structuredContent as { version: number }).version).toBe(0);
  });
});
