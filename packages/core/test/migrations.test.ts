import { type DbError, runMigrations } from "@surfingdog/platform";
import { gt } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import {
  connectorEvents,
  connectors,
  eventsV1,
  itemEvents,
  items,
  parties,
  threadEntries,
  webhookDeliveries,
  webhooks,
} from "../src/schema/tables";
import { makeClient, resetTables } from "./harness";

/**
 * Migration 4 (ADR-015) on both runtimes: D1 and node:sqlite have to accept the same DDL, the view
 * included, or half the fleet starts and half does not.
 */
describe("migration 4 — connectors, webhooks and the event view", () => {
  it("applies on a fresh database and creates every table, index and the view", async () => {
    const db = await fresh();
    expect(await names(db, "table")).toEqual(
      expect.arrayContaining(["connectors", "connector_events", "webhooks", "webhook_deliveries"]),
    );
    expect(await names(db, "view")).toContain("events_v1");
    expect(await names(db, "index")).toEqual(
      expect.arrayContaining([
        "connectors_kind_external",
        "connectors_inbound_token",
        "connectors_status",
        "connector_events_once",
        "connector_events_pending",
        "webhook_deliveries_once",
        "webhook_deliveries_due",
      ]),
    );

    // Every column by name: a missing one fails the insert rather than passing quietly.
    const now = Date.now();
    const connectorId = ulid();
    await db.orm.insert(connectors).values({
      id: connectorId,
      kind: "shopify",
      name: "Bike shop",
      externalId: "bike-shop.myshopify.com",
      configEnc: "v1.aXYaXYaXYaXY.Y2lwaGVy",
      configPublic: { shop: "bike-shop.myshopify.com", scopes: ["read_orders"] },
      cursor: null,
      inboundToken: `tok_${ulid()}`,
      status: "active",
      lastError: null,
      lastErrorAt: null,
      lastSyncAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.orm.insert(connectorEvents).values({
      id: ulid(),
      connectorId,
      externalId: "5678901234",
      topic: "orders/create",
      receivedAt: now,
      status: "pending",
      itemId: null,
      handledAt: null,
      error: null,
      raw: '{"id":5678901234}',
    });
    const webhookId = ulid();
    await db.orm.insert(webhooks).values({
      id: webhookId,
      url: "https://hooks.example.com/inbox",
      secretEnc: "v1.aXYaXYaXYaXY.c2VjcmV0",
      events: ["booking.create", "order.pay"],
      payloadStyle: "thin",
      active: 1,
      failingSince: null,
      disabledAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.orm.insert(webhookDeliveries).values({
      id: ulid(),
      webhookId,
      eventId: ulid(),
      eventType: "booking.create",
      status: "pending",
      attempts: 0,
      nextAt: now,
      lastStatus: null,
      lastError: null,
      durationMs: null,
      createdAt: now,
      deliveredAt: null,
    });

    // The non-secret mirror is readable without the key, and a connector that needs no credentials
    // stores no ciphertext at all.
    const [row] = await db.orm.select().from(connectors);
    expect(row?.configPublic).toEqual({ shop: "bike-shop.myshopify.com", scopes: ["read_orders"] });
    await db.orm.insert(connectors).values({
      id: ulid(),
      kind: "feed",
      name: "Price feed",
      createdAt: now,
      updatedAt: now,
    });
    const feed = (await db.orm.select().from(connectors)).find((c) => c.kind === "feed");
    expect(feed?.configEnc).toBeNull();
    expect(feed?.configPublic).toEqual({});
    expect(feed?.status).toBe("configured");
  });

  it("refuses a duplicate on every unique index", async () => {
    const db = await fresh();
    const now = Date.now();
    const base = { kind: "shopify", name: "Bike shop", externalId: "bike-shop.myshopify.com", createdAt: now };
    const connectorId = ulid();
    await db.orm.insert(connectors).values({ ...base, id: connectorId, inboundToken: "tok_one", updatedAt: now });

    // (kind, external_id): the same shop cannot be connected twice.
    await expectUnique(
      db.orm.insert(connectors).values({ ...base, id: ulid(), inboundToken: "tok_two", updatedAt: now }),
    );
    // inbound_token: the unguessable path segment is one connector's alone.
    await expectUnique(
      db.orm
        .insert(connectors)
        .values({ ...base, id: ulid(), externalId: "other.myshopify.com", inboundToken: "tok_one", updatedAt: now }),
    );
    // Nulls do not collide, so connectors without an external id or a token still insert.
    await db.orm.insert(connectors).values({ id: ulid(), kind: "feed", name: "A", createdAt: now, updatedAt: now });
    await db.orm.insert(connectors).values({ id: ulid(), kind: "feed", name: "B", createdAt: now, updatedAt: now });

    // (connector_id, external_id): a platform's redelivery is ignored, not doubled.
    const event = { connectorId, externalId: "5678901234", topic: "orders/create", receivedAt: now, raw: "{}" };
    await db.orm.insert(connectorEvents).values({ ...event, id: ulid() });
    await expectUnique(db.orm.insert(connectorEvents).values({ ...event, id: ulid() }));

    // (webhook_id, event_id): one event is delivered to one endpoint once.
    const webhookId = ulid();
    await db.orm.insert(webhooks).values({
      id: webhookId,
      url: "https://hooks.example.com/inbox",
      secretEnc: "v1.aXYaXYaXYaXY.c2VjcmV0",
      events: [],
      createdAt: now,
      updatedAt: now,
    });
    const delivery = { webhookId, eventId: ulid(), eventType: "booking.create", createdAt: now };
    await db.orm.insert(webhookDeliveries).values({ ...delivery, id: ulid() });
    await expectUnique(db.orm.insert(webhookDeliveries).values({ ...delivery, id: ulid() }));
  });

  it("is a no-op the second time, and keeps what the first run created", async () => {
    const db = await fresh();
    const now = Date.now();
    await db.orm
      .insert(connectors)
      .values({ id: ulid(), kind: "feed", name: "Price feed", createdAt: now, updatedAt: now });
    const before = await db.client.query({ sql: "SELECT version, name, hash, applied_at FROM migrations ORDER BY 1" });

    expect(await runMigrations(db.client, MIGRATIONS)).toBe(MIGRATIONS.length);

    const after = await db.client.query({ sql: "SELECT version, name, hash, applied_at FROM migrations ORDER BY 1" });
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(MIGRATIONS.length);
    // A re-run must not drop and recreate what is now a populated table.
    expect(await db.orm.select().from(connectors)).toHaveLength(1);
  });

  it("streams item events and inbound messages through events_v1, in id order", async () => {
    const db = await fresh();
    const now = Date.now();
    const partyId = ulid();
    const itemId = ulid();
    await db.orm.insert(parties).values({ id: partyId, kind: "human", createdAt: now, updatedAt: now });
    await db.orm.insert(items).values({
      id: itemId,
      type: "booking",
      state: "confirmed",
      version: 2,
      partyId,
      channel: "form",
      payload: { startTime: "2026-09-23T14:00:00Z" },
      flags: { needsHuman: false, sandbox: false, priority: 0 },
      createdAt: now,
      updatedAt: now,
    });
    const created = ulid();
    const confirmed = ulid();
    await db.orm.insert(itemEvents).values([
      {
        id: created,
        itemId,
        seq: 1,
        event: "create",
        fromState: null,
        toState: "requested",
        actorKind: "customer_human",
        actorId: partyId,
        createdAt: now,
      },
      {
        id: confirmed,
        itemId,
        seq: 2,
        event: "confirm",
        fromState: "requested",
        toState: "confirmed",
        actorKind: "owner",
        actorId: "owner",
        createdAt: now + 1,
      },
    ]);
    const inbound = ulid();
    await db.orm.insert(threadEntries).values([
      {
        id: inbound,
        itemId,
        direction: "in",
        channel: "email",
        actorKind: "customer_human",
        actorId: partyId,
        partyId,
        bodyText: "Can I come an hour later?",
        createdAt: now + 2,
      },
      {
        id: ulid(),
        itemId,
        direction: "out",
        channel: "email",
        actorKind: "owner",
        actorId: "owner",
        partyId,
        bodyText: "Yes, see you then.",
        createdAt: now + 3,
      },
    ]);

    const stream = await db.orm.select().from(eventsV1).orderBy(eventsV1.id);
    expect(stream.map((e) => [e.id, e.type, e.source])).toEqual([
      [created, "booking.create", "item_event"],
      [confirmed, "booking.confirm", "item_event"],
      [inbound, "booking.message", "thread_entry"],
    ]);
    expect(stream[0]).toMatchObject({
      itemId,
      itemType: "booking",
      itemState: "requested",
      itemVersion: 1,
      partyId,
      sandbox: 0,
      actorKind: "customer_human",
      event: "create",
    });
    expect(stream[2]).toMatchObject({ itemState: "confirmed", itemVersion: 2, event: "message" });

    // The whole point of the view: a cursor is `WHERE id > ?`, and replay is free.
    const after = await db.orm.select().from(eventsV1).where(gt(eventsV1.id, created)).orderBy(eventsV1.id).limit(10);
    expect(after.map((e) => e.id)).toEqual([confirmed, inbound]);
  });
});

async function fresh(): Promise<Db> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return db;
}

async function names(db: Db, type: "table" | "view" | "index"): Promise<string[]> {
  const { rows } = await db.client.query({
    sql: "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name",
    params: [type],
  });
  return rows.map((r) => String(r[0]));
}

/** Drizzle wraps what the client threw, so unwrap to the DbError the way `setup.ts` does. */
async function expectUnique(write: Promise<unknown>): Promise<void> {
  const thrown = await write.then(
    () => null,
    (e: unknown) => e,
  );
  expect(thrown, "expected the unique index to refuse this write").not.toBeNull();
  let e = thrown as { code?: string; cause?: unknown };
  for (let i = 0; i < 3 && e && e.code !== "unique" && e.cause; i++) e = e.cause as { code?: string; cause?: unknown };
  expect((e as DbError | undefined)?.code).toBe("unique");
}
