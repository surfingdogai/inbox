import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup(): Promise<{ db: Db; caps: Capabilities }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

describe("probe", () => {
  it("A: sku-only change is treated as unchanged", async () => {
    const { db, caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, "id,title,sku,price\nA1,Chain lube,LUBE-100,8.50", T0);
    let r = await db.client.query({ sql: "SELECT sku FROM products WHERE external_id='A1'", method: "all" });
    expect.soft(JSON.stringify(["after first import sku =", r.rows])).toBe("SHOW");

    const second = await caps.feeds.importBody(feed.id, "id,title,sku,price\nA1,Chain lube,LUBE-200,8.50", T0 + 1000);
    expect.soft(JSON.stringify(["summary", second.created, second.updated, second.unchanged])).toBe("SHOW");
    r = await db.client.query({ sql: "SELECT sku FROM products WHERE external_id='A1'", method: "all" });
    expect.soft(JSON.stringify(["after sku change sku =", r.rows])).toBe("SHOW");
  });

  it("B: sku released by collision is never written back", async () => {
    const { db, caps } = await setup();
    const mine = await caps.setup.createProduct(owner, {
      sku: "LUBE-100", name: "my listing", price: { value: 900, currency: "EUR" }, active: true,
    });
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importBody(feed.id, "id,title,sku,price\nA1,Chain lube,LUBE-100,8.50", T0);
    let r = await db.client.query({ sql: "SELECT sku FROM products WHERE external_id='A1'", method: "all" });
    expect.soft(JSON.stringify(["collided sku =", r.rows])).toBe("SHOW");
    // Owner frees the sku.
    await caps.setup.updateProduct(owner, { product_id: mine.id, sku: "OTHER" });
    const again = await caps.feeds.importBody(feed.id, "id,title,sku,price\nA1,Chain lube,LUBE-100,8.50", T0 + 1000);
    expect.soft(JSON.stringify(["summary", again.created, again.updated, again.unchanged])).toBe("SHOW");
    r = await db.client.query({ sql: "SELECT sku FROM products WHERE external_id='A1'", method: "all" });
    expect.soft(JSON.stringify(["after collision cleared sku =", r.rows])).toBe("SHOW");
  });

  it("C: remove + reconnect same URL duplicates instead of adopting", async () => {
    const { db, caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const body = "id,title,sku,price\nA1,Chain lube,LUBE-100,8.50\nA2,Inner tube,TUBE-700,4.99";
    await caps.feeds.importBody(feed.id, body, T0);
    await caps.feeds.remove(owner, feed.id);

    const again = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    expect.soft(JSON.stringify(["old id", feed.id, "new id", again.id])).toBe("SHOW");
    const summary = await caps.feeds.importBody(again.id, body, T0 + 1000);
    expect.soft(JSON.stringify(["summary", JSON.stringify(summary)])).toBe("SHOW");
    const r = await db.client.query({ sql: "SELECT id, sku, name, source, active FROM products ORDER BY name, source", method: "all" });
    expect.soft(JSON.stringify(["products:", JSON.stringify(r.rows)])).toBe("SHOW");
  });
});
