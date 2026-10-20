import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, MIGRATIONS } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { nodeSqliteClient } from "@surfingdog/platform/node";
import { describe, expect, it } from "vitest";
import { commandDatabaseRefusal, DEFAULT_HOST } from "../src/node-server";

/**
 * A command of the Node server runs against the instance's database: run without the instance's
 * settings from another directory, it once made a new database there and printed an owner key that
 * opened nothing (401). It now says which database it uses, and creates none it was not told of.
 */
const app = path.resolve(import.meta.dirname, "..");

function run(args: string[], cwd: string, env: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const childEnv = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
    const child = spawn(path.join(app, "node_modules/.bin/tsx"), [path.join(app, "src/node.ts"), ...args], {
      cwd,
      env: childEnv,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    child.stderr.on("data", (c) => {
      err += String(c);
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

describe("a command's database", () => {
  it("is refused when it would be a new one nobody named", () => {
    expect(commandDatabaseRefusal("/nowhere/data/inbox.db", undefined, "create-owner-key")).toContain(
      "node --env-file=/opt/inbox/.env /opt/inbox/server.mjs create-owner-key",
    );
    expect(commandDatabaseRefusal("/nowhere/data/inbox.db", "/nowhere/data/inbox.db", "create-owner-key")).toBeNull();
  });

  it("creates none from another directory, and uses the one INBOX_DB names", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inbox-cli-"));
    try {
      const elsewhere = await run(["create-owner-key", "laptop"], dir, { INBOX_DB: undefined });
      expect(elsewhere.code).toBe(2);
      expect(elsewhere.out).toBe("");
      expect(elsewhere.err).toContain("--env-file=/opt/inbox/.env");
      expect(existsSync(path.join(dir, "data"))).toBe(false);

      const file = path.join(dir, "inbox.db");
      const client = nodeSqliteClient(file);
      await runMigrations(createDb(client).client, MIGRATIONS);
      client.close();
      const named = await run(["create-owner-key", "laptop"], dir, { INBOX_DB: file });
      expect(named.code).toBe(0);
      expect(named.err).toContain(`database: ${file}`);
      expect(named.out.trim()).toMatch(/^sdi_own_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backup and check-db", () => {
  it("back up the database as it is, migrating nothing, and look at a file before a restore", {
    timeout: 120_000,
  }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inbox-backup-"));
    try {
      const file = path.join(dir, "inbox.db");
      const client = nodeSqliteClient(file);
      await runMigrations(createDb(client).client, MIGRATIONS);
      // As an older version would have left it: the newest migration not applied yet.
      const newest = Math.max(...MIGRATIONS.map((m) => m.version));
      await client.query({ sql: "DELETE FROM migrations WHERE version = ?", params: [newest], method: "run" });
      client.close();

      const target = path.join(dir, "backup.db");
      const backup = await run(["backup", target], dir, { INBOX_DB: file });
      expect(backup.code).toBe(0);
      expect(JSON.parse(backup.out)).toMatchObject({ file: target, ok: true, migration: newest - 1, owner: false });
      // Neither the database nor its copy was migrated by the command.
      const check = await run(["check-db", target], dir, { INBOX_DB: undefined });
      expect(check.code).toBe(0);
      expect(JSON.parse(check.out)).toMatchObject({ ok: true, migration: newest - 1 });
      expect((await run(["check-db", file], dir, {})).out).toContain(`"migration":${newest - 1}`);

      // A second backup to the same file is refused; a file that is no database is named as such.
      const again = await run(["backup", target], dir, { INBOX_DB: file });
      expect(again.code).toBe(1);
      expect(again.err).toContain("exists already");
      const bogus = path.join(dir, "bogus.db");
      writeFileSync(bogus, "not a database, only words");
      const refused = await run(["check-db", bogus], dir, {});
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.out)).toMatchObject({ ok: false, problem: "it is not an SQLite database" });
      // check-db opens no instance database: none is made where it runs.
      expect(existsSync(path.join(dir, "data"))).toBe(false);

      // Into a folder that is not there yet, as on a fresh volume: it makes it, for its user only.
      const nested = path.join(dir, "backups", "first.db");
      expect((await run(["backup", nested], dir, { INBOX_DB: file })).code).toBe(0);
      expect(statSync(path.dirname(nested)).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("where the Node server listens", () => {
  it("is loopback unless HOST says otherwise, and the Docker image says so", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(readFileSync(path.resolve(app, "src/node.ts"), "utf8")).toMatch(
      /hostname: process\.env\.HOST \|\| DEFAULT_HOST/,
    );
    expect(readFileSync(path.resolve(app, "../../Dockerfile"), "utf8")).toMatch(/HOST=0\.0\.0\.0/);
  });
});
