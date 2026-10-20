import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase, inspectDatabase, nodeSqliteClient } from "../src/node/index";

/**
 * A backup is the whole database, secrets included, made while it serves; a restore looks at a file
 * before trusting it. Both are what `inbox backup`, `inbox update` and `inbox restore` stand on.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-"));
  dirs.push(dir);
  return dir;
};

async function inboxLike(file: string) {
  const client = nodeSqliteClient(file);
  await client.batch([
    { sql: "CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT, hash TEXT, applied_at INTEGER)" },
    { sql: "INSERT INTO migrations VALUES (1, 'one', 'h1', 0), (7, 'seven', 'h7', 0)", method: "run" },
    { sql: "CREATE TABLE items (id TEXT)", method: "run" },
    { sql: "INSERT INTO items VALUES ('a'), ('b'), ('c')", method: "run" },
    { sql: "CREATE TABLE users (id TEXT)", method: "run" },
    { sql: "CREATE TABLE signing_keys (sealed TEXT)", method: "run" },
    { sql: "INSERT INTO signing_keys VALUES ('sealed-key-kept-in-a-backup')", method: "run" },
  ]);
  return client;
}

describe("backupDatabase", () => {
  it("copies everything, secrets too, into one file only its user can read", async () => {
    const dir = tmp();
    const client = await inboxLike(path.join(dir, "inbox.db"));
    const target = path.join(dir, "backup.db");
    const report = backupDatabase(client, target);
    expect(report).toMatchObject({ ok: true, problem: null, migration: 7, items: 3, owner: false });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    // One file, in the rollback journal, and nothing half-made left beside it.
    expect(readdirSync(dir).sort()).toEqual(["backup.db", "inbox.db", "inbox.db-shm", "inbox.db-wal"]);
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      expect(copy.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(copy.prepare("SELECT sealed FROM signing_keys").get()).toEqual({ sealed: "sealed-key-kept-in-a-backup" });
    } finally {
      copy.close();
    }
    // The database serves on as it was.
    expect((await client.query({ sql: "SELECT count(*) FROM items" })).rows).toEqual([[3]]);
    client.close();
  });

  it("never overwrites a file, and leaves no partial copy when it fails", async () => {
    const dir = tmp();
    const client = await inboxLike(path.join(dir, "inbox.db"));
    const target = path.join(dir, "taken.db");
    writeFileSync(target, "someone else's file");
    expect(() => backupDatabase(client, target)).toThrow(/exists already/);
    expect(() => backupDatabase(client, path.join(dir, "no-such-dir", "b.db"))).toThrow();
    expect(existsSync(path.join(dir, "no-such-dir"))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".partial"))).toEqual([]);
    client.close();
  });
});

describe("inspectDatabase", () => {
  it("knows an inbox's database, and says who has signed in", async () => {
    const dir = tmp();
    const file = path.join(dir, "inbox.db");
    const client = await inboxLike(file);
    await client.query({ sql: "INSERT INTO users VALUES ('owner')", method: "run" });
    client.close();
    expect(inspectDatabase(file)).toMatchObject({ ok: true, migration: 7, items: 3, owner: true });
  });

  it("refuses what is not one, and says why in a few words", async () => {
    const dir = tmp();
    expect(inspectDatabase(path.join(dir, "missing.db"))).toMatchObject({
      ok: false,
      problem: "there is no such file",
    });
    const text = path.join(dir, "notes.txt");
    writeFileSync(text, "this is not a database at all, not even close");
    expect(inspectDatabase(text)).toMatchObject({ ok: false, problem: "it is not an SQLite database" });
    const other = path.join(dir, "other.db");
    const db = new DatabaseSync(other);
    db.exec("CREATE TABLE notes (body TEXT)");
    db.close();
    expect(inspectDatabase(other)).toMatchObject({ ok: false, problem: "it is not an inbox's database" });
  });
});
