import { type Caller, FEED_IMPORT_KIND, JobRunner } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { feedImportHandler } from "../src/feeds/index";
import { freshDb } from "./db";

const T0 = Date.parse("2026-09-21T10:00:00Z");
const owner = (t: number): Caller => ({
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});

const CSV = ["id,title,price", "A1,Chain lube,8.50", "A2,Inner tube,4.99", "A3,Bar tape,14.00"].join("\n");

describe("two isolates, one connector", () => {
  it("add + import now, drained by two runners at once", async () => {
    const { db, caps } = await freshDb();
    const feed = await caps.feeds.add(owner(T0), { url: "https://shop.example.com/feed.csv" });
    await caps.feeds.importNow(owner(T0 + 1500), feed.id);

    const jobs = await db.client.query({ sql: "SELECT id, dedupe_key, status FROM jobs WHERE kind = ?", params: [FEED_IMPORT_KIND], method: "all" });
    console.log("queued jobs", JSON.stringify(jobs.rows));

    // A slow feed, so the two handlers really do overlap the way two isolates would.
    const fetchImpl = (async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response(CSV, { status: 200, headers: { "content-type": "text/csv" } });
    }) as unknown as typeof fetch;

    const runnerA = new JobRunner().register(FEED_IMPORT_KIND, feedImportHandler({ caps, fetchImpl }));
    const runnerB = new JobRunner().register(FEED_IMPORT_KIND, feedImportHandler({ caps, fetchImpl }));
    const [a, b] = await Promise.all([
      runnerA.runDue(db, { now: T0 + 2000, workerId: "isolate-a", limit: 1 }),
      runnerB.runDue(db, { now: T0 + 2000, workerId: "isolate-b", limit: 1 }),
    ]);
    console.log("A", JSON.stringify(a), "B", JSON.stringify(b));

    const { rows } = await db.client.query({ sql: "SELECT count(*), count(DISTINCT external_id) FROM products", method: "all" });
    console.log("products rows/distinct", JSON.stringify(rows));
    console.log("get", JSON.stringify(await caps.feeds.get(owner(T0 + 3000), feed.id)));
    const done = await db.client.query({ sql: "SELECT id, status, last_error, leased_by FROM jobs", method: "all" });
    console.log("jobs after", JSON.stringify(done.rows));
    expect(true).toBe(true);
  });
});
