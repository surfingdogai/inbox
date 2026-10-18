import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("where the Node server listens", () => {
  it("is loopback unless HOST says otherwise, and the Docker image says so", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(readFileSync(path.resolve(app, "src/node.ts"), "utf8")).toMatch(
      /hostname: process\.env\.HOST \|\| DEFAULT_HOST/,
    );
    expect(readFileSync(path.resolve(app, "../../Dockerfile"), "utf8")).toMatch(/HOST=0\.0\.0\.0/);
  });
});
