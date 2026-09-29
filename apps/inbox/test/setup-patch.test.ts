import { createApiKey } from "@surfingdog/adapters";
import { schema } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * "Only the fields you send change", through the owner's API: a change to one field of a service, a
 * product or a rule leaves the rest exactly as they were, not as a new one would start.
 */
async function setup() {
  const db = await freshDb();
  const T0 = Date.parse("2026-09-21T10:00:00Z");
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en"],
    createdAt: T0,
    updatedAt: T0,
  });
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    baseUrl: "https://inbox.test",
    secretKey: "setup-patch-test-secret-0123456789ab",
    background: () => {},
  });
  const key = await createApiKey(db, { kind: "owner", name: "t" });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await inbox.app.request(
      new Request(`https://inbox.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key.key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { call };
}

describe("changing one field", () => {
  it("of a service leaves its duration, slots, order and the rest alone", async () => {
    const { call } = await setup();
    const made = await call("POST", "/v1/owner/services", {
      name: "Intro call",
      duration_min: 30,
      granularity_min: 30,
      capacity: 2,
      sort: 1,
    });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    const changed = await call("PATCH", `/v1/owner/services/${id}`, {
      description: "Half an hour about your business.",
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      description: "Half an hour about your business.",
      durationMin: 30,
      granularityMin: 30,
      capacity: 2,
      sort: 1,
    });
  });

  it("of a rule leaves it switched off, at its priority", async () => {
    const { call } = await setup();
    const made = await call("POST", "/v1/owner/rules", {
      name: "Owner's decisions are urgent",
      priority: 5,
      enabled: false,
      definition: {
        on: ["item.transitioned"],
        if: { all: [{ path: "event.actorKind", op: "eq", value: "owner" }] },
        actions: [{ action: "set_flags", priority: 3 }],
      },
    });
    expect(made.status).toBe(201);
    const changed = await call("PATCH", `/v1/owner/rules/${made.body.id as string}`, { name: "Renamed" });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ name: "Renamed", priority: 5, enabled: false });
  });

  it("of a product leaves it unpublished", async () => {
    const { call } = await setup();
    const made = await call("POST", "/v1/owner/products", {
      name: "Inner tube",
      price: { value: 800, currency: "EUR" },
      active: false,
    });
    expect(made.status).toBe(201);
    const changed = await call("PATCH", `/v1/owner/products/${made.body.id as string}`, { stock: 12 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ stock: 12, active: 0 });
  });
});
