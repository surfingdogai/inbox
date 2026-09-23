import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// The Node target uses the built-in SQLite; it must ship FTS5 and JSON1 for search and payloads.
describe("node:sqlite", () => {
  it("has FTS5 and JSON1", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("create virtual table t using fts5(body)");
    db.exec("insert into t values ('confirm the booking for tuesday')");
    const hit = db.prepare("select count(*) as c from t where t match 'booking'").get() as { c: number };
    expect(hit.c).toBe(1);
    const j = db.prepare("select json_extract('{\"type\":\"booking\"}', '$.type') as t").get() as { t: string };
    expect(j.t).toBe("booking");
  });
});

// The doors the server answers before the owner app: the Node host, the Worker's assets and the dev
// proxy each list them, and the page a link in the business's email opens (`/c/…`) is one of them.
describe("the doors each host answers first", () => {
  const read = (file: string) => readFileSync(path.resolve(import.meta.dirname, file), "utf8");
  it("include the customer's page everywhere", () => {
    expect(read("../src/node.ts")).toMatch(/const DOOR_PREFIXES = \[[^\]]*"\/c"/);
    expect(read("../vite.config.ts")).toMatch(/const API_PATHS = \[[^\]]*"\/c\/"/);
    expect(read("../../../wrangler.jsonc")).toMatch(/"run_worker_first": \[[^\]]*"\/c\/\*"/);
  });
});
