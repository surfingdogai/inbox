import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { items, parties, threadEntries } from "../src/schema/tables";
import { makeClient } from "./harness";

// Runs on Node (node:sqlite) and inside workerd (D1): the schema must behave the same on both.
describe("core schema", () => {
  it("migrates, stores an item with generated columns, and finds it through FTS", async () => {
    const db = createDb(await makeClient());
    await runMigrations(db.client, MIGRATIONS);
    await runMigrations(db.client, MIGRATIONS);
    const now = Date.now();
    const partyId = ulid();
    const itemId = ulid();
    await db.orm
      .insert(parties)
      .values({ id: partyId, kind: "human", displayName: "Rita Amaral", createdAt: now, updatedAt: now });
    await db.orm.insert(items).values({
      id: itemId,
      type: "booking",
      state: "requested",
      partyId,
      channel: "form",
      subject: "Full service, city bike",
      payload: {
        reservationFor: { serviceId: "svc_1", name: "Full service" },
        startTime: "2026-09-23T14:00:00Z",
        endTime: "2026-09-23T15:30:00Z",
        totalPrice: { value: 4500, currency: "EUR" },
      },
      flags: { needsHuman: true, sandbox: false, priority: 0 },
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.orm
      .select({ startAt: items.startAt, amount: items.amountMinor, needsHuman: items.needsHuman })
      .from(items)
      .where(eq(items.id, itemId));
    expect(row).toEqual({ startAt: "2026-09-23T14:00:00Z", amount: 4500, needsHuman: 1 });

    await db.orm.insert(threadEntries).values({
      id: ulid(),
      itemId,
      direction: "in",
      channel: "form",
      actorKind: "customer_human",
      partyId,
      bodyText: "Brakes squeak at low speed. Please check the rear wheel.",
      createdAt: now,
    });
    const hit = await db.client.query({
      sql: "SELECT item_id, party FROM search_fts WHERE search_fts MATCH ?",
      params: ["brakes"],
      method: "get",
    });
    expect(hit.rows[0]).toEqual([itemId, "Rita Amaral"]);
  });

  it("refuses interactive transactions", async () => {
    const db = createDb(await makeClient());
    expect(() => (db.orm as unknown as { transaction: () => void }).transaction()).toThrow(/batch/);
  });
});
