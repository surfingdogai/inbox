import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { schema, ulid } from "@surfingdog/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { freshDb, futureDay, openWeekdays } from "./harness";

/**
 * What an agent sends on first touch, as agents write it: service_id or serviceId, access_token or
 * accessToken (the create answer itself carries `accessToken`), and a booking with no end, or no
 * service name, which follow from the service. The same over REST and over MCP. Node and workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const DAY = futureDay();
const START = `${DAY}T09:00:00Z`;
const END = new Date(Date.parse(START) + 90 * 60_000).toISOString();

async function setup() {
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
  await openWeekdays(db);
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    createdAt: T0,
    updatedAt: T0,
  });
  return { db, svc, app: createApp({ db }) };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://inbox.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function connect(app: App) {
  const fetchLike = async (input: string | URL, init?: RequestInit) => app.request(String(input), init);
  const transport = new StreamableHTTPClientTransport(new URL("https://inbox.test/mcp"), { fetch: fetchLike });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  return client;
}

type Created = { view: { item: { id: string; state: string } }; accessToken?: string };

async function payloadOf(db: Awaited<ReturnType<typeof freshDb>>, id: string) {
  const [row] = await db.orm
    .select({ payload: schema.items.payload })
    .from(schema.items)
    .where(eq(schema.items.id, id));
  return (typeof row?.payload === "string" ? JSON.parse(row.payload) : row?.payload) as {
    reservationFor: { serviceId: string; name: string };
    startTime: string;
    endTime: string;
  };
}

describe("either spelling, over REST", () => {
  it("finds times for serviceId as for service_id", async () => {
    const { app, svc } = await setup();
    const window = `from=${DAY}T00:00:00Z&to=${DAY}T23:59:00Z`;
    const snake = await app.request(`https://inbox.test/v1/availability?service_id=${svc}&${window}`);
    const camel = await app.request(`https://inbox.test/v1/availability?serviceId=${svc}&${window}`);
    expect(camel.status).toBe(200);
    expect(await camel.json()).toEqual(await snake.json());
  });

  it("books with no end and no name, both from the service, and cancels with accessToken in the body", async () => {
    const { app, db, svc } = await setup();
    const res = await app.request(
      post(
        "/v1/bookings",
        { payload: { reservationFor: { service_id: svc }, startTime: START }, contact: { email: "rita@example.com" } },
        { "idempotency-key": "first-touch-1" },
      ),
    );
    expect(res.status).toBe(201);
    const made = (await res.json()) as Created;
    const p = await payloadOf(db, made.view.item.id);
    expect(p.reservationFor).toEqual({ serviceId: svc, name: "Full service" });
    expect(Date.parse(p.endTime)).toBe(Date.parse(END));

    const cancel = await app.request(
      post(
        `/v1/items/${made.view.item.id}/cancel`,
        { accessToken: made.accessToken, reason: "Found a closer workshop" },
        { "idempotency-key": "first-touch-cancel" },
      ),
    );
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { view: { item: { state: string } } }).view.item.state).toBe(
      "cancelled_by_customer",
    );
  });

  it("keeps an end it was given", async () => {
    const { app, db, svc } = await setup();
    const end = new Date(Date.parse(START) + 60 * 60_000).toISOString();
    const res = await app.request(
      post("/v1/bookings", {
        payload: { reservationFor: { serviceId: svc, name: "Service" }, startTime: START, endTime: end },
        contact: { email: "rita@example.com" },
      }),
    );
    expect(res.status).toBe(201);
    expect((await payloadOf(db, ((await res.json()) as Created).view.item.id)).endTime).toBe(end);
  });

  it("refuses a booking with no end for a service it does not have, naming the field", async () => {
    const { app } = await setup();
    const res = await app.request(
      post("/v1/bookings", { payload: { reservationFor: { serviceId: "nope" }, startTime: START } }),
    );
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { details?: { reason?: string }; fields?: { path: string }[] };
    expect(problem.details?.reason).toBe("unknown_service");
    expect(problem.fields?.[0]?.path).toBe("payload.reservationFor.serviceId");
  });
});

describe("either spelling, over MCP", () => {
  it("checks, books with no end and reads back with accessToken", async () => {
    const { app, db, svc } = await setup();
    const client = await connect(app);
    const times = await client.callTool({
      name: "check_availability",
      arguments: { serviceId: svc, from: `${DAY}T00:00:00Z`, to: `${DAY}T23:59:00Z` },
    });
    expect(times.isError).toBeFalsy();
    expect((times.structuredContent as { slots: unknown[] }).slots.length).toBeGreaterThan(0);

    const booked = await client.callTool({
      name: "create_booking",
      arguments: {
        payload: { reservationFor: { serviceId: svc }, startTime: START },
        contact: { email: "rita@example.com" },
        idempotency_key: "first-touch-mcp",
      },
    });
    expect(booked.isError).toBeFalsy();
    const made = booked.structuredContent as Created;
    expect(made.accessToken).toBeTruthy();
    expect(Date.parse((await payloadOf(db, made.view.item.id)).endTime)).toBe(Date.parse(END));

    const status = await client.callTool({
      name: "get_item_status",
      arguments: { item_id: made.view.item.id, accessToken: made.accessToken },
    });
    expect(status.isError).toBeFalsy();
    expect((status.structuredContent as { item: { id: string } }).item.id).toBe(made.view.item.id);
  });

  it("lists each tool's schema in the spelling it documents", async () => {
    const { app } = await setup();
    const client = await connect(app);
    const { tools } = await client.listTools();
    const check = tools.find((t) => t.name === "check_availability");
    expect(Object.keys(check?.inputSchema.properties ?? {})).toContain("service_id");
    expect(Object.keys(check?.inputSchema.properties ?? {})).not.toContain("serviceId");
    const status = tools.find((t) => t.name === "get_item_status");
    expect(Object.keys(status?.inputSchema.properties ?? {})).toContain("access_token");
  });
});
