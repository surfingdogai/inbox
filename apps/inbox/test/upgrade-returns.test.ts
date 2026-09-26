import { type Caller, Capabilities, createDb, MIGRATIONS, rowToItem, schema, transitionItem } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeClient } from "./harness";

/**
 * Returns (ADR-018 §3.4, §7, migration 0015), as a live instance meets them on upgrade: its products
 * and services read as `standard` — the right of withdrawal runs, as the law says unless the owner
 * flags otherwise — and a refund written before returns were built (a reason, an amount, nothing
 * else) still reads, is approved and refunded as it always was. Run twice, the migration changes
 * nothing more. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const flags = JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 });
const owner: Caller = {
  actor: { kind: "owner", id: "owner_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

describe("upgrading to returns", () => {
  it("reads the catalogue as standard and keeps an old refund working", async () => {
    const client = await makeClient();
    const before = MIGRATIONS.filter((m) => m.name < "0015_returns");
    expect(await runMigrations(client, before)).toBe(before.length);
    const db = createDb(client);
    await client.batch([
      {
        sql: "INSERT INTO services (id, name, duration_min, capacity, granularity_min, price, created_at, updated_at) VALUES ('svc_1', 'Full service', 90, 1, 30, ?, ?, ?)",
        params: [JSON.stringify({ model: "fixed", value: 4500, currency: "EUR" }), T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO products (id, sku, name, price, created_at, updated_at) VALUES ('prod_1', 'CH-9', 'Chain', ?, ?, ?)",
        params: [JSON.stringify({ value: 1850, currency: "EUR" }), T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO parties (id, kind, contact, created_at, updated_at) VALUES ('party_1', 'human', '{\"email\":\"rita@example.com\"}', ?, ?)",
        params: [T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES ('item_o', 'order', 'completed', 4, 'party_1', 'form', ?, ?, ?, ?)",
        params: [
          JSON.stringify({
            orderedItem: [{ productId: "prod_1", name: "Chain", quantity: 1, price: { value: 1850, currency: "EUR" } }],
            totalPrice: { value: 1850, currency: "EUR" },
            paymentRef: "pi_1",
          }),
          flags,
          T0,
          T0,
        ],
        method: "run",
      },
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, linked_item_id, payload, flags, created_at, updated_at) VALUES ('item_r', 'refund', 'requested', 1, 'party_1', 'form', NULL, ?, ?, ?, ?)",
        params: [
          JSON.stringify({
            orderItemId: "item_o",
            amount: { value: 1850, currency: "EUR" },
            reason: "Broken on arrival",
          }),
          flags,
          T0,
          T0,
        ],
        method: "run",
      },
    ]);

    // Twice: the second run finds nothing more to do.
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    const [product] = await db.orm.select().from(schema.products);
    const [service] = await db.orm.select().from(schema.services);
    expect(product?.withdrawal).toBe("standard");
    expect(service?.withdrawal).toBe("standard");
    const { rows } = await client.query({
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'items_linked'",
      method: "all",
    });
    expect(rows).toHaveLength(1);

    // The refund from before: it reads, the owner approves it (no goods to wait for) and refunds it.
    const [row] = await db.orm.select().from(schema.items).where(eq(schema.items.id, "item_r"));
    const old = rowToItem(row as typeof schema.items.$inferSelect);
    expect(old.payload).toEqual({
      orderItemId: "item_o",
      amount: { value: 1850, currency: "EUR" },
      reason: "Broken on arrival",
    });
    const caps = new Capabilities(db);
    const detail = await caps.getItem(owner, { item_id: "item_r" });
    expect(detail.transitions.map((t) => t.event)).toEqual(["approve", "reject", "record_cancel"]);
    const approved = await transitionItem(db, owner, { itemId: "item_r", event: "approve" });
    expect(approved.view.item.payload).toMatchObject({
      goodsBack: false,
      refundDue: new Date(T0 + 14 * 86_400_000).toISOString(),
    });
    const refunded = await transitionItem(db, owner, {
      itemId: "item_r",
      event: "refund",
      input: { paymentRef: "re_1" },
    });
    expect(refunded.view.item).toMatchObject({
      state: "refunded",
      payload: { paidAmount: { value: 1850, currency: "EUR" } },
    });
  });
});
