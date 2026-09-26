import { createApiKey } from "@surfingdog/adapters";
import { createDb, MIGRATIONS, schema } from "@surfingdog/core";
import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { confirmed, makeClient } from "./harness";

/**
 * The owner's limits (ADR-018 §4, migration 0016), as a live instance meets them on upgrade. A key the
 * owner handed another system that moves items along keeps recording payments and pricing as it did:
 * it is given `money:write`. A key that only reads, a revoked one, the owner's own and an assistant's
 * are left as they were; a key minted after the upgrade holds `money:write` only when the owner gives
 * it. Every product and service may be haggled once the owner switches price counters on, and no floor
 * is set. Run twice, the migration changes nothing more. Runs on Node and in workerd.
 */
const BASE = "https://inbox.example.com";

describe("upgrading to the owner's limits", () => {
  it("gives money:write to the keys that moved items along, and to no other", async () => {
    const client = await makeClient();
    const before = MIGRATIONS.filter((m) => m.name < "0016_limits");
    expect(await runMigrations(client, before)).toBe(before.length);
    const db = createDb(client);
    const now = Date.now();
    await client.batch([
      {
        sql: "INSERT INTO products (id, sku, name, price, created_at, updated_at) VALUES ('prod_1', 'CH-9', 'Chain', ?, ?, ?)",
        params: [JSON.stringify({ value: 1850, currency: "EUR" }), now, now],
        method: "run",
      },
    ]);
    const mint = (name: string, kind: "owner" | "integration" | "agent", scopes?: string[]) =>
      createApiKey(db, { kind, name, ...(scopes ? { scopes } : {}) });
    const till = await mint("Till", "integration", ["inbox:read", "inbox:write", "events:read"]);
    const full = await mint("Everything", "integration", ["*"]);
    const reader = await mint("Dashboard", "integration", ["inbox:read", "events:read"]);
    const revoked = await mint("Old till", "integration", ["inbox:write"]);
    const already = await mint("Shop", "integration", ["inbox:write", "money:write"]);
    const ownerKey = await mint("cli", "owner");
    const agent = await mint("Assistant", "agent");
    await client.batch([
      { sql: "UPDATE api_keys SET revoked_at = ? WHERE id = ?", params: [now, revoked.id], method: "run" },
    ]);

    // Twice: the second run finds nothing more to do.
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    const scopesOf = async (id: string) =>
      (await db.orm.select({ scopes: schema.apiKeys.scopes }).from(schema.apiKeys).where(eq(schema.apiKeys.id, id)))[0]
        ?.scopes;
    expect(await scopesOf(till.id)).toEqual(["inbox:read", "inbox:write", "events:read", "money:write"]);
    expect(await scopesOf(full.id)).toEqual(["*", "money:write"]);
    expect(await scopesOf(reader.id)).toEqual(["inbox:read", "events:read"]);
    expect(await scopesOf(revoked.id)).toEqual(["inbox:write"]);
    expect(await scopesOf(already.id)).toEqual(["inbox:write", "money:write"]);
    expect(await scopesOf(ownerKey.id)).toEqual(["*"]);
    expect(await scopesOf(agent.id)).toEqual(["public"]);

    // The catalogue: haggled only once the owner lets customers, with no floor anywhere.
    const [product] = await db.orm.select().from(schema.products);
    expect(product?.negotiable).toBe(1);
    const { rows } = await client.query({ sql: "SELECT COUNT(*) FROM price_floors", method: "all" });
    expect(Number(rows[0]?.[0])).toBe(0);

    // Through the app: the till records a payment as it did; a key minted now, without money:write, cannot.
    const inbox = createInbox({
      db,
      mailOut: logMailOut(),
      baseUrl: BASE,
      secretKey: "upgrade-limits-test-secret-0123456789",
      background: () => {},
    });
    const send = (method: string, path: string, body: unknown, bearer?: string) =>
      confirmed(
        (r) => inbox.app.request(r),
        new Request(`${BASE}${path}`, {
          method,
          headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
          body: JSON.stringify(body),
        }),
      );
    const order = async (n: number) => {
      const created = await send("POST", "/v1/orders", {
        payload: {
          orderedItem: [{ sku: "CH-9", name: "Chain", quantity: 1, price: { value: 1850, currency: "EUR" } }],
          totalPrice: { value: 1850, currency: "EUR" },
        },
        contact: { email: "rita@example.com", locale: "en" },
        idempotency_key: `order-${n}`,
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const id = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
      const accepted = await send("POST", `/v1/owner/items/${id}/transitions`, { event: "accept" }, ownerKey.key);
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      return id;
    };
    const pay = (id: string, bearer: string) =>
      send(
        "POST",
        `/v1/owner/items/${id}/transitions`,
        { event: "record_payment", input: { paymentRef: "pi_1" } },
        bearer,
      );

    const paid = await pay(await order(1), till.key);
    expect(paid.status, await paid.clone().text()).toBe(200);
    expect(((await paid.json()) as { view: { item: { state: string } } }).view.item.state).toBe("paid");

    const fresh = await createApiKey(db, {
      kind: "integration",
      name: "Zapier",
      scopes: ["inbox:read", "inbox:write"],
    });
    const refused = await pay(await order(2), fresh.key);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "not_allowed",
      details: { reason: "money_recorded", scope: "money:write" },
    });
  });
});
