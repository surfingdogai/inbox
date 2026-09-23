import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
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
    expect(text).toMatch(/Booking "Full service" .* is requested/);
    expect(text).toContain(structured.accessToken);

    const bad = await client.callTool({
      name: "create_booking",
      arguments: { payload: { reservationFor: { serviceId: svc } } },
    });
    expect(bad.isError).toBe(true);
    // The SDK validates arguments before the tool runs and names the offending fields itself.
    expect((bad.content as { text: string }[])[0]?.text).toMatch(/startTime/);
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
      "get_settings",
      "get_networks",
      "update_settings",
    ]);
    const settings = await client.callTool({ name: "get_settings", arguments: {} });
    expect((settings.structuredContent as { version: number }).version).toBe(0);
  });
});
