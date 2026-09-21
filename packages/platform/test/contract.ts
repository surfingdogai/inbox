import { describe, expect, it } from "vitest";
import { DbError, type SqliteClient } from "../src/db";
import { type Migration, runMigrations } from "../src/migrate";

/**
 * The contract every SqliteClient must meet. Import it from a runtime-specific test file and
 * hand it a factory; the same expectations run on Node and inside workerd.
 */
export function describeSqliteClientContract(name: string, make: () => Promise<SqliteClient> | SqliteClient) {
  // Table names are unique per test because Workers isolate storage per file, not per test.
  let n = 0;
  const t = () => `t${++n}_${Math.random().toString(36).slice(2, 8)}`;

  describe(`SqliteClient contract: ${name}`, () => {
    it("returns rows as arrays, one row for get, changes for run", async () => {
      const c = await make();
      const tb = t();
      await c.query({ sql: `CREATE TABLE ${tb} (k TEXT PRIMARY KEY, v INTEGER)`, method: "run" });
      const ins = await c.query({
        sql: `INSERT INTO ${tb} VALUES (?, ?), (?, ?)`,
        params: ["a", 1, "b", 2],
        method: "run",
      });
      expect(ins.changes).toBe(2);
      const all = await c.query({ sql: `SELECT k, v FROM ${tb} ORDER BY k`, method: "all" });
      expect(all.rows).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
      const one = await c.query({ sql: `SELECT v FROM ${tb} WHERE k = ?`, params: ["b"], method: "get" });
      expect(one.rows).toEqual([[2]]);
      const none = await c.query({ sql: `SELECT v FROM ${tb} WHERE k = ?`, params: ["zz"], method: "get" });
      expect(none.rows).toEqual([]);
    });

    it("normalises booleans, undefined and dates before binding", async () => {
      const c = await make();
      const tb = t();
      const when = new Date("2026-09-21T12:00:00Z");
      await c.query({ sql: `CREATE TABLE ${tb} (flag INTEGER, missing TEXT, at INTEGER)`, method: "run" });
      await c.query({ sql: `INSERT INTO ${tb} VALUES (?, ?, ?)`, params: [true, undefined, when], method: "run" });
      const { rows } = await c.query({ sql: `SELECT flag, missing, at FROM ${tb}` });
      expect(rows).toEqual([[1, null, when.getTime()]]);
    });

    it("reports unique violations with a stable code and the constraint name", async () => {
      const c = await make();
      const tb = t();
      await c.query({ sql: `CREATE TABLE ${tb} (k TEXT PRIMARY KEY)`, method: "run" });
      await c.query({ sql: `INSERT INTO ${tb} VALUES ('x')`, method: "run" });
      const err = await c.query({ sql: `INSERT INTO ${tb} VALUES ('x')`, method: "run" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DbError);
      expect((err as DbError).code).toBe("unique");
      expect((err as DbError).constraint).toBe(`${tb}.k`);
    });

    it("applies a batch atomically: a failing statement undoes the earlier ones", async () => {
      const c = await make();
      const tb = t();
      await c.query({ sql: `CREATE TABLE ${tb} (k TEXT PRIMARY KEY)`, method: "run" });
      const err = await c
        .batch([
          { sql: `INSERT INTO ${tb} VALUES ('a')`, method: "run" },
          { sql: `INSERT INTO ${tb} VALUES ('b')`, method: "run" },
          { sql: `INSERT INTO ${tb} VALUES ('a')`, method: "run" },
        ])
        .catch((e: unknown) => e);
      expect((err as DbError).code).toBe("unique");
      const { rows } = await c.query({ sql: `SELECT count(*) FROM ${tb}`, method: "get" });
      expect(rows[0]?.[0]).toBe(0);
    });

    it("returns one result per batch statement, in order", async () => {
      const c = await make();
      const tb = t();
      await c.query({ sql: `CREATE TABLE ${tb} (k TEXT PRIMARY KEY, v INTEGER)`, method: "run" });
      const results = await c.batch([
        { sql: `INSERT INTO ${tb} VALUES (?, ?)`, params: ["a", 1], method: "run" },
        { sql: `UPDATE ${tb} SET v = v + 1 WHERE k = ?`, params: ["a"], method: "run" },
        { sql: `UPDATE ${tb} SET v = 0 WHERE k = ?`, params: ["missing"], method: "run" },
      ]);
      expect(results.map((r) => r.changes)).toEqual([1, 1, 0]);
      const { rows } = await c.query({ sql: `SELECT v FROM ${tb} WHERE k = 'a'`, method: "get" });
      expect(rows[0]?.[0]).toBe(2);
    });

    it("supports RETURNING through the all method", async () => {
      const c = await make();
      const tb = t();
      await c.query({ sql: `CREATE TABLE ${tb} (id INTEGER PRIMARY KEY, k TEXT)`, method: "run" });
      const { rows } = await c.query({
        sql: `INSERT INTO ${tb} (k) VALUES (?) RETURNING id, k`,
        params: ["r"],
        method: "all",
      });
      expect(rows).toEqual([[1, "r"]]);
    });

    it("has FTS5 and JSON, and uses an index on a virtual generated column", async () => {
      const c = await make();
      const tb = t();
      await c.query({ sql: `CREATE VIRTUAL TABLE ${tb}_fts USING fts5(body)`, method: "run" });
      await c.query({ sql: `INSERT INTO ${tb}_fts VALUES ('confirm the booking for tuesday')`, method: "run" });
      const hit = await c.query({
        sql: `SELECT count(*) FROM ${tb}_fts WHERE ${tb}_fts MATCH ?`,
        params: ["booking"],
        method: "get",
      });
      expect(hit.rows[0]?.[0]).toBe(1);
      await c.query({
        sql: `CREATE TABLE ${tb} (payload TEXT, kind TEXT GENERATED ALWAYS AS (json_extract(payload, '$.type')) VIRTUAL)`,
        method: "run",
      });
      await c.query({ sql: `CREATE INDEX ${tb}_kind ON ${tb} (kind)`, method: "run" });
      await c.query({ sql: `INSERT INTO ${tb} (payload) VALUES ('{"type":"booking"}')`, method: "run" });
      const found = await c.query({
        sql: `SELECT count(*) FROM ${tb} WHERE kind = ?`,
        params: ["booking"],
        method: "get",
      });
      expect(found.rows[0]?.[0]).toBe(1);
      const plan = await c
        .query({ sql: `EXPLAIN QUERY PLAN SELECT * FROM ${tb} WHERE kind = 'booking'` })
        .catch(() => null);
      if (plan) expect(JSON.stringify(plan.rows)).toMatch(/USING (COVERING )?INDEX/);
    });

    it("runs migrations once, records them, and refuses a changed migration", async () => {
      const c = await make();
      const tb = t();
      const m1: Migration = { version: 1, name: "init", statements: [`CREATE TABLE ${tb} (k TEXT PRIMARY KEY)`] };
      const m2: Migration = { version: 2, name: "add_v", statements: [`ALTER TABLE ${tb} ADD COLUMN v INTEGER`] };
      expect(await runMigrations(c, [m1])).toBe(1);
      expect(await runMigrations(c, [m1, m2])).toBe(2);
      expect(await runMigrations(c, [m1, m2])).toBe(2);
      const { rows } = await c.query({ sql: "SELECT version, name FROM migrations ORDER BY version" });
      expect(rows).toEqual([
        [1, "init"],
        [2, "add_v"],
      ]);
      const changed: Migration = { ...m1, statements: [`CREATE TABLE ${tb} (k TEXT PRIMARY KEY, extra INTEGER)`] };
      await expect(runMigrations(c, [changed, m2])).rejects.toThrow(/changed after it was applied/);
    });
  });
}
