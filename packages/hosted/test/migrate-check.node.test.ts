import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "@surfingdog/core";
import { afterAll, describe, expect, it } from "vitest";
import { migrateCheck } from "../src/migrate-check";

/** The dry run a deploy makes on a copy of each inbox's file before a release runs it. */
describe("migrate-check", () => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-migrate-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const latest = Math.max(...MIGRATIONS.map((m) => m.version));

  it("brings a file to this release's schema, and a second run finds nothing to do", async () => {
    const file = join(dir, "inbox.db");
    expect(await migrateCheck(file)).toEqual({ from: 0, to: latest });
    expect(await migrateCheck(file)).toEqual({ from: latest, to: latest });
  });

  it("fails on a file that is not an inbox's database", async () => {
    const file = join(dir, "broken.db");
    writeFileSync(file, "this is not a database, only text long enough to look like a file ".repeat(64));
    await expect(migrateCheck(file)).rejects.toThrow();
  });
});
