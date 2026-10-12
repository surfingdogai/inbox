import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DbError } from "../src/db";
import { nodeSnapshot, nodeSqliteClient } from "../src/node/index";

/**
 * A copy of a `node:sqlite` database for its owner: consistent, stripped, rebuilt so nothing stripped
 * is left in its pages, one file, and nothing left behind in the directory it was made in.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nodeSnapshot", () => {
  it("strips the copy, not the database, and leaves nothing behind", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "snapshot-"));
    dirs.push(dir);
    const client = nodeSqliteClient(":memory:");
    await client.batch([
      { sql: "CREATE TABLE notes (body TEXT)", method: "run" },
      { sql: "CREATE TABLE secrets (value TEXT)", method: "run" },
      { sql: "INSERT INTO notes VALUES ('cut and colour'), ('fringe')", method: "run" },
      { sql: "INSERT INTO secrets VALUES ('a-secret-nobody-takes-away')", method: "run" },
    ]);
    const copy = await nodeSnapshot(client, dir)(["DELETE FROM secrets"]);
    expect(copy.tables).toEqual([
      { name: "notes", rows: 2 },
      { name: "secrets", rows: 0 },
    ]);
    expect(new TextDecoder().decode(copy.bytes.subarray(0, 16))).toBe("SQLite format 3\u0000");
    expect(new TextDecoder("latin1").decode(copy.bytes)).not.toContain("a-secret-nobody-takes-away");
    // The database itself is as it was.
    expect((await client.query({ sql: "SELECT count(*) FROM secrets" })).rows).toEqual([[1]]);
    expect(readdirSync(dir)).toEqual([]);
    // The copy is one file in the rollback journal, ready to open.
    const file = path.join(dir, "check.db");
    writeFileSync(file, copy.bytes);
    const opened = new DatabaseSync(file);
    expect(opened.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(opened.prepare("SELECT body FROM notes ORDER BY body").all()).toEqual([
      { body: "cut and colour" },
      { body: "fringe" },
    ]);
    opened.close();
    client.close();
  });

  it("fails whole when a statement fails, and still leaves nothing behind", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "snapshot-"));
    dirs.push(dir);
    const client = nodeSqliteClient(":memory:");
    await client.query({ sql: "CREATE TABLE notes (body TEXT)", method: "run" });
    await expect(nodeSnapshot(client, dir)(["DELETE FROM nowhere"])).rejects.toBeInstanceOf(DbError);
    expect(readdirSync(dir)).toEqual([]);
    client.close();
  });
});
