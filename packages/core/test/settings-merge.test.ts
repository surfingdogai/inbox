import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { DEFAULT_NETWORK, enabledNetworks, readSettings } from "../src/settings/schema";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * A settings write is a change, not a reset. On 22 Sep 2026 a partial write to our own instance
 * turned `network.join` off because every section the caller left out came back as its default;
 * these are the tests that would have caught it, and the ones that keep it from coming back
 * through another door: a stored value this version rejects, a key only a newer version knows,
 * and a second network added next to the first.
 */
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => Date.parse("2026-09-22T10:37:13Z"),
};

const A = "https://network.example.com";
const B = "https://second.example.net";

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

/** Writes a stored document as it is, the way an older version, or a hand edit, left it. */
async function store(db: Db, doc: unknown, version = 1) {
  await db.client.query({
    sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, ?, 0)",
    params: [JSON.stringify(doc), version],
    method: "run",
  });
}

async function raw(db: Db): Promise<Record<string, unknown>> {
  const { rows } = await db.client.query({ sql: "SELECT doc FROM settings", params: [], method: "all" });
  return JSON.parse(String(rows[0]?.[0])) as Record<string, unknown>;
}

describe("settings writes", () => {
  it("keep every section the caller leaves out", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, {
      doc: {
        business: { name: "Surfing Dog" },
        notifications: { ownerEmail: "hello@surfingdog.ai" },
        networks: { [DEFAULT_NETWORK]: { enabled: true } },
      },
    });
    // The write that did the damage: one section, nothing else.
    const r = await caps.updateSettings(owner, { doc: { business: { name: "Surfing Dog Lda" } } });
    expect(r.version).toBe(2);
    const s = await readSettings(db);
    expect(s.business.name).toBe("Surfing Dog Lda");
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(true);
    expect(s.notifications.ownerEmail).toBe("hello@surfingdog.ai");
  });

  it("merge inside a section too; arrays and scalars replace", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { networks: { [A]: { enabled: true } } } });
    await caps.updateSettings(owner, { doc: { networks: { [A]: { share: { counts: false } } } } });
    expect((await readSettings(db)).networks[A]).toEqual({
      enabled: true,
      issue: true,
      share: { listing: true, counts: false, receipts: true },
    });
    await caps.updateSettings(owner, { doc: { business: { languages: ["pt", "en"] } } });
    await caps.updateSettings(owner, { doc: { business: { languages: ["pt"] } } });
    expect((await readSettings(db)).business.languages).toEqual(["pt"]);
  });

  it("store what the owner wrote, never the defaults the parser filled in", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { business: { name: "Oficina" } } });
    expect(await raw(db)).toEqual({ business: { name: "Oficina" }, schemaVersion: 1 });
  });

  it("clear a value with null, and bring back a default the same way", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, {
      doc: { notifications: { ownerEmail: "a@example.com", appUrl: "https://inbox.example.com" } },
    });
    await caps.updateSettings(owner, { doc: { booking: { autoExpireHours: 12 } } });
    await caps.updateSettings(owner, {
      doc: { notifications: { ownerEmail: null }, booking: { autoExpireHours: null } },
    });
    const s = await readSettings(db);
    expect(s.notifications).toEqual({ appUrl: "https://inbox.example.com" });
    expect(s.booking.autoExpireHours).toBe(72);
  });

  it("merge the minimum notice like any key: an hour by default, kept beside the rest, refused out of range", async () => {
    const { db, caps } = await setup();
    expect((await readSettings(db)).booking.minNoticeMin).toBe(60);
    await caps.updateSettings(owner, { doc: { booking: { cancellationWindowMin: 120 } } });
    await caps.updateSettings(owner, { doc: { booking: { minNoticeMin: 30 } } });
    expect((await readSettings(db)).booking).toMatchObject({ cancellationWindowMin: 120, minNoticeMin: 30 });
    await expect(caps.updateSettings(owner, { doc: { booking: { minNoticeMin: -1 } } })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await caps.updateSettings(owner, { doc: { booking: { minNoticeMin: null } } });
    expect((await readSettings(db)).booking).toMatchObject({ cancellationWindowMin: 120, minNoticeMin: 60 });
  });

  it("keep a key only a newer version knows", async () => {
    const { db, caps } = await setup();
    await store(db, { business: { name: "A", motto: "keep me" }, customers: { otp: { enabled: true } } });
    await caps.updateSettings(owner, { doc: { business: { name: "B" } } });
    expect(await raw(db)).toMatchObject({
      business: { name: "B", motto: "keep me" },
      customers: { otp: { enabled: true } },
    });
  });

  it("read past one bad stored value instead of resetting everything, and never write the reset back", async () => {
    const { db, caps } = await setup();
    // A value a later schema tightened, next to the setting that matters most on the live instance.
    await store(db, {
      booking: { autoExpireHours: 0, cancellationWindowMin: 90 },
      network: { url: DEFAULT_NETWORK, join: true },
      notifications: { ownerEmail: "hello@surfingdog.ai" },
    });
    const s = await readSettings(db);
    expect(s.booking).toMatchObject({ autoExpireHours: 72, cancellationWindowMin: 90 });
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(true);
    expect((await caps.getSettings(owner)).doc.networks[DEFAULT_NETWORK]?.enabled).toBe(true);

    // A partial write elsewhere goes through, and the stored document keeps everything it had.
    await caps.updateSettings(owner, { doc: { business: { name: "Surfing Dog" } } });
    const after = await raw(db);
    expect(after).toMatchObject({
      booking: { autoExpireHours: 0, cancellationWindowMin: 90 },
      network: { url: DEFAULT_NETWORK, join: true },
      notifications: { ownerEmail: "hello@surfingdog.ai" },
      business: { name: "Surfing Dog" },
    });
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.enabled).toBe(true);

    // Writing that very field is held to the schema.
    await expect(caps.updateSettings(owner, { doc: { booking: { autoExpireHours: 0 } } })).rejects.toMatchObject({
      code: "invalid_input",
      fields: [expect.objectContaining({ path: "doc.booking.autoExpireHours" })],
    });
  });

  it("refuse a key that is not a setting", async () => {
    const { caps } = await setup();
    await expect(caps.updateSettings(owner, { doc: { netwroks: {} } })).rejects.toMatchObject({
      code: "invalid_input",
      fields: [{ path: "doc.netwroks", problem: "invalid", message: "not a setting" }],
    });
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

describe("networks in settings writes", () => {
  it("add a second network next to the first, on a map", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { networks: { [A]: { enabled: true } } } });
    await caps.updateSettings(owner, { doc: { networks: { [B]: { enabled: true } } } });
    const s = await readSettings(db);
    expect(Object.keys(s.networks).sort()).toEqual([B, DEFAULT_NETWORK, A].sort());
    expect(s.networks[A]?.enabled).toBe(true);
    expect(s.networks[B]?.enabled).toBe(true);
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(false);
  });

  it("add a second network next to the one migrated from the legacy pair (the live instance)", async () => {
    const { db, caps } = await setup();
    await store(db, { network: { url: DEFAULT_NETWORK, join: true } });
    await caps.updateSettings(owner, { doc: { networks: { [B]: { enabled: true } } } });
    const s = await readSettings(db);
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(true);
    expect(s.networks[B]?.enabled).toBe(true);
    // The legacy pair is never written back; it stays as it was, and is no longer read.
    expect((await raw(db)).network).toEqual({ url: DEFAULT_NETWORK, join: true });
  });

  it("switch one off with enabled: false and keep it listed", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { networks: { [A]: { enabled: true }, [B]: { enabled: true } } } });
    await caps.updateSettings(owner, { doc: { networks: { [A]: { enabled: false } } } });
    const s = await readSettings(db);
    expect(s.networks[A]?.enabled).toBe(false);
    expect(s.networks[B]?.enabled).toBe(true);
    // And remove it for good with null.
    await caps.updateSettings(owner, { doc: { networks: { [A]: null } } });
    expect(Object.keys((await readSettings(db)).networks)).not.toContain(A);
    // Not the whole map, though: that would bring back whatever it replaced.
    await expect(caps.updateSettings(owner, { doc: { networks: null } })).rejects.toMatchObject({
      fields: [expect.objectContaining({ path: "doc.networks" })],
    });
  });

  it("translate the legacy network pair older clients still send, never sharing more than it says", async () => {
    const { db, caps } = await setup();
    const on = async () => enabledNetworks(await readSettings(db));
    await caps.updateSettings(owner, { doc: { network: { join: true } } });
    expect(await on()).toEqual([DEFAULT_NETWORK]);
    // A second network added the new way; re-joining the old way leaves it alone.
    await caps.updateSettings(owner, { doc: { networks: { [B]: { enabled: true } } } });
    await caps.updateSettings(owner, { doc: { network: { url: DEFAULT_NETWORK, join: true } } });
    expect(await on()).toEqual([B, DEFAULT_NETWORK].sort());
    // A new URL moves the one network the client knows of, as it always did: nothing keeps going
    // anywhere else, and the switch carries over when it is not sent.
    await caps.updateSettings(owner, { doc: { network: { url: `${A}/` } } });
    expect(await on()).toEqual([A]);
    await caps.updateSettings(owner, { doc: { network: { url: `${B}/`, join: true } } });
    expect(await on()).toEqual([B]);
    // "Leave the network" leaves every one: the client cannot say which of several it means.
    await caps.updateSettings(owner, { doc: { network: { join: false } } });
    expect(await on()).toEqual([]);
    expect(Object.keys((await readSettings(db)).networks).sort()).toEqual([B, DEFAULT_NETWORK, A].sort());
    expect(await raw(db)).not.toHaveProperty("network");
  });

  it("move the live instance's legacy network the old way, and never re-point a URL that was never usable", async () => {
    const { db, caps } = await setup();
    await store(db, { network: { url: DEFAULT_NETWORK, join: true } });
    await caps.updateSettings(owner, { doc: { network: { url: A } } });
    expect(enabledNetworks(await readSettings(db))).toEqual([A]);

    const other = await setup();
    await store(other.db, { network: { url: "http://localhost:8080", join: false } });
    await expect(other.caps.updateSettings(owner, { doc: { network: { join: true } } })).rejects.toMatchObject({
      fields: [expect.objectContaining({ path: "doc.network.url" })],
    });
    expect(enabledNetworks(await readSettings(other.db))).toEqual([]);
  });

  it("canonicalise an origin and refuse anything that is not one", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { networks: { "https://Network.Example.com/": { enabled: true } } } });
    expect((await readSettings(db)).networks[A]?.enabled).toBe(true);
    for (const bad of [
      "http://network.example.com",
      "https://network.example.com/v1",
      "https://network.example.com:8443",
      "https://localhost",
      "https://10.0.0.5",
      "https://user:pw@network.example.com",
      "https://network.example.com/?x=1",
      "network.example.com",
    ]) {
      await expect(
        caps.updateSettings(owner, { doc: { networks: { [bad]: { enabled: true } } } }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        fields: [expect.objectContaining({ path: `doc.networks.${bad}` })],
      });
    }
    await expect(
      caps.updateSettings(owner, { doc: { network: { url: "http://10.0.0.5:8080/x", join: true } } }),
    ).rejects.toMatchObject({ code: "invalid_input", fields: [expect.objectContaining({ path: "doc.network.url" })] });
    await expect(caps.updateSettings(owner, { doc: { networks: { [B]: { enabled: "yes" } } } })).rejects.toMatchObject({
      fields: [expect.objectContaining({ path: `doc.networks.${B}.enabled` })],
    });
  });

  it("hold at most eight", async () => {
    const { db, caps } = await setup();
    const seven: Record<string, unknown> = {};
    for (let i = 0; i < 7; i++) seven[`https://n${i}.example.com`] = { enabled: i % 2 === 0 };
    await caps.updateSettings(owner, { doc: { networks: seven } });
    expect(Object.keys((await readSettings(db)).networks)).toHaveLength(8);
    await expect(
      caps.updateSettings(owner, { doc: { networks: { "https://ninth.example.com": { enabled: true } } } }),
    ).rejects.toMatchObject({ code: "invalid_input", fields: [expect.objectContaining({ path: "doc.networks" })] });
    // Removing one makes room.
    await caps.updateSettings(owner, { doc: { networks: { "https://n1.example.com": null } } });
    await caps.updateSettings(owner, { doc: { networks: { "https://ninth.example.com": { enabled: true } } } });
    expect((await readSettings(db)).networks["https://ninth.example.com"]?.enabled).toBe(true);
  });

  it("queue a ping and a publisher the moment a network is switched on", async () => {
    const { db, caps } = await setup();
    const jobs = async () =>
      (
        await db.client.query({ sql: "SELECT kind, dedupe_key FROM jobs ORDER BY kind", params: [], method: "all" })
      ).rows.map((r) => `${r[0]} ${r[1]}`);
    await caps.updateSettings(owner, { doc: { networks: { [A]: {} } } });
    expect(await jobs()).toEqual([]);
    await caps.updateSettings(owner, { doc: { networks: { [A]: { enabled: true } } } });
    const hour = Math.floor(Date.parse("2026-09-22T10:37:13Z") / 3_600_000);
    expect(await jobs()).toEqual([
      `network_ping_one network_ping:${A}:${hour}`,
      `network_publish network_publish:${A}:${hour}`,
    ]);
    // Changing something else does not queue them again.
    await caps.updateSettings(owner, { doc: { networks: { [A]: { issue: false } } } });
    expect(await jobs()).toHaveLength(2);
  });
});
