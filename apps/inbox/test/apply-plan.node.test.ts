import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, schema } from "@surfingdog/core";
import { nodeSqliteClient } from "@surfingdog/platform/node";
import { describe, expect, it } from "vitest";

/**
 * `apply-plan`, from the command line of the Node server: a dry run prints what applying would do
 * and writes nothing, applying prints the same and does it, and applying again prints that nothing
 * changes.
 */
const app = path.resolve(import.meta.dirname, "..");

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(path.join(app, "node_modules/.bin/tsx"), ["src/node.ts", ...args], {
      cwd: app,
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** The services in the database file, by name. */
async function services(file: string): Promise<string[]> {
  const client = nodeSqliteClient(file);
  try {
    return (await createDb(client).orm.select().from(schema.services)).map((s) => s.name);
  } finally {
    client.close();
  }
}

describe("apply-plan", () => {
  it("prints a dry run, applies the plan once, and changes nothing the second time", { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inbox-plan-"));
    try {
      const file = path.join(dir, "inbox.db");
      const plan = path.join(dir, "plan.json");
      writeFileSync(
        plan,
        JSON.stringify({
          profile: { name: "Canalizações Sousa", timezone: "Europe/Lisbon" },
          services: [{ name: "Visit", duration_min: 60 }],
          preset: "trades",
          doors: ["message", "quote_request"],
        }),
      );
      const env = { INBOX_DB: file };
      const dry = await run(["apply-plan", plan, "--dry-run"], env);
      expect(dry.code).toBe(0);
      expect(dry.out).toContain("Names the business Canalizações Sousa.");
      expect(dry.out).toContain("Adds the service Visit: 60 minutes, price on request.");
      expect(await services(file)).toEqual([]);

      const applied = await run(["apply-plan", plan], env);
      expect(applied.code).toBe(0);
      expect(applied.out).toBe(dry.out);
      const again = await run(["apply-plan", plan], env);
      expect(again.out).toContain("Nothing to change: the inbox already matches this plan.");
      expect(await services(file)).toEqual(["Visit"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
