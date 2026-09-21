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
