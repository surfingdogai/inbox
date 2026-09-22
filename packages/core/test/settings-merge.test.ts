import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { readSettings } from "../src/settings/schema";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * A settings write is a change, not a reset. On 22 Sep 2026 a partial write to our own instance
 * turned `network.join` off because every section the caller left out came back as its default;
 * this is the test that would have caught it.
 */
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => Date.parse("2026-09-22T10:37:13Z"),
};

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

describe("settings writes", () => {
  it("keep every section the caller leaves out", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, {
      doc: {
        business: { name: "Surfing Dog" },
        notifications: { ownerEmail: "hello@surfingdog.ai" },
        network: { url: "https://network.surfingdog.ai", join: true },
      },
    });
    // The write that did the damage: one section, nothing else.
    const r = await caps.updateSettings(owner, { doc: { business: { name: "Surfing Dog Lda" } } });
    expect(r.version).toBe(2);
    const s = await readSettings(db);
    expect(s.business.name).toBe("Surfing Dog Lda");
    expect(s.network).toEqual({ url: "https://network.surfingdog.ai", join: true });
    expect(s.notifications.ownerEmail).toBe("hello@surfingdog.ai");
  });

  it("merge inside a section too", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { network: { url: "https://network.example.com", join: true } } });
    await caps.updateSettings(owner, { doc: { network: { join: false } } });
    expect((await readSettings(db)).network).toEqual({ url: "https://network.example.com", join: false });
    // Arrays and scalars replace; they do not merge.
    await caps.updateSettings(owner, { doc: { business: { languages: ["pt", "en"] } } });
    await caps.updateSettings(owner, { doc: { business: { languages: ["pt"] } } });
    expect((await readSettings(db)).business.languages).toEqual(["pt"]);
  });

  it("still refuse a stale expected_version", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, { doc: { business: { name: "A" } } });
    await caps.updateSettings(owner, { doc: { business: { name: "B" } } });
    await expect(
      caps.updateSettings(owner, { doc: { business: { name: "C" } }, expected_version: 1 }),
    ).rejects.toMatchObject({
      code: "version_conflict",
    });
  });
});
