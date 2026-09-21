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

describe("scratch", () => {
  it("apply() failure on the second slice", async () => {
    const { db, caps } = await setup();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });

    const lines = ["id,title,description,price,quantity"];
    for (let i = 0; i < 100; i++) lines.push(`P${i},Product ${i},desc ${i},${(i + 1).toFixed(2)},5`);
    const body = lines.join("\n");

    const real = db.batch.bind(db);
    let calls = 0;
    (db as { batch: Db["batch"] }).batch = async (stmts) => {
      calls++;
      if (calls === 2) throw new Error("D1_ERROR: Too many API requests by single worker invocation");
      return real(stmts);
    };

    await expect(caps.feeds.importBody(feed.id, body, T0 + 1000)).rejects.toThrow(/D1_ERROR/);

    (db as { batch: Db["batch"] }).batch = real;
    const after = await caps.feeds.get(owner, feed.id);
    console.log("CONNECTOR AFTER FAILURE:", JSON.stringify(after));
    const { rows } = await db.client.query({ sql: "SELECT count(*) FROM products WHERE active = 1", method: "all" });
    console.log("ACTIVE PRODUCTS:", JSON.stringify(rows));
    console.log("BATCH CALLS:", calls);
  });
});
