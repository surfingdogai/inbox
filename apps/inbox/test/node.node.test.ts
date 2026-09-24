import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDb, MIGRATIONS } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { nodeSqliteClient } from "@surfingdog/platform/node";
import { describe, expect, it } from "vitest";
import { seedSurfingDog } from "../src/seed";

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
  it("include the demo's live view everywhere", () => {
    expect(read("../src/node.ts")).toMatch(/const DOOR_PREFIXES = \[[^\]]*"\/demo"/);
    expect(read("../vite.config.ts")).toMatch(/const API_PATHS = \[[^\]]*"\/demo\/"/);
    expect(read("../../../wrangler.jsonc")).toMatch(/"run_worker_first": \[[^\]]*"\/demo\/\*"/);
  });
});

// INBOX_DEMO over a database that holds a real business: the server says why and does not start,
// rather than serving that business with its mail off.
describe("the Node server in demo mode", () => {
  it("refuses to start over a database that already holds data", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inbox-demo-"));
    try {
      const file = path.join(dir, "inbox.db");
      const db = createDb(nodeSqliteClient(file));
      await runMigrations(db.client, MIGRATIONS);
      await seedSurfingDog(db, Date.now());
      const app = path.resolve(import.meta.dirname, "..");
      const child = spawn(path.join(app, "node_modules/.bin/tsx"), ["src/node.ts"], {
        cwd: app,
        env: { ...process.env, INBOX_DB: file, INBOX_DEMO: "1", PORT: "0", HOST: "127.0.0.1" },
      });
      let err = "";
      child.stderr.on("data", (chunk) => {
        err += String(chunk);
      });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve(null);
        }, 20_000);
        child.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(code).toBe(1);
      expect(err).toContain("only starts on an empty database");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
