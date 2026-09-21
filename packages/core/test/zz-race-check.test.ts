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

function feedNoSku(n: number): string {
  const lines = ["id,title,price,quantity"];
  for (let i = 1; i <= n; i++) lines.push(`A${i},Product ${i},${(i + 1).toFixed(2)},5`);
  return lines.join("\n");
}

describe("race check", () => {
  it("two overlapping imports, no sku column", async () => {
    const { db, caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const body = feedNoSku(10);
    const [a, b] = await Promise.all([
      caps.feeds.importBody(feed.id, body, T0 + 1000),
      caps.feeds.importBody(feed.id, body, T0 + 1001),
    ]);
    console.log("A", JSON.stringify(a));
    console.log("B", JSON.stringify(b));
    const { rows } = await db.client.query({ sql: "SELECT count(*), count(DISTINCT external_id) FROM products", method: "all" });
    console.log("rows/distinct", JSON.stringify(rows));
    const again = await caps.feeds.importBody(feed.id, body, T0 + 5000);
    console.log("third import", JSON.stringify(again));
    console.log("get", JSON.stringify(await caps.feeds.get(owner, feed.id)));
    const conn = await db.client.query({ sql: "SELECT status, last_error FROM connectors", method: "all" });
    console.log("connector", JSON.stringify(conn.rows));
    expect(true).toBe(true);
  });

  it("two overlapping imports, with a sku column", async () => {
    const { db, caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop2.example.com/feed.csv" });
    const body = ["id,title,sku,price,quantity", "A1,Chain lube,LUBE-100,8.50,3", "A2,Tube,TUBE-7,4.99,2"].join("\n");
    const settled = await Promise.allSettled([
      caps.feeds.importBody(feed.id, body, T0 + 1000),
      caps.feeds.importBody(feed.id, body, T0 + 1001),
    ]);
    console.log("settled", JSON.stringify(settled.map((s) => (s.status === "fulfilled" ? s.value : String(s.reason)))));
    const { rows } = await db.client.query({ sql: "SELECT id, sku, external_id FROM products", method: "all" });
    console.log("products", JSON.stringify(rows));
    expect(true).toBe(true);
  });
});
