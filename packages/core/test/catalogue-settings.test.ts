import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { catalogueOwed, NETWORK_CATALOGUE_KIND, wantsCatalogue } from "../src/network/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { DEFAULT_SETTINGS, parseStoredSettings, readSettings, type Settings } from "../src/settings/schema";
import type { Caller, Principal } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * "Your products on networks" (ADR-029): on by default (the founder, 26 October 2026), switched by
 * the owner in person only, per network as well, and listing products only while the business is in
 * that network's directory. Node and workerd.
 */
const T0 = Date.parse("2026-10-26T10:00:00Z");
/** Moved on by a test that makes several writes, so each queues its own job. */
let clock = T0;
const A = "https://network.example.com";
const B = "https://other.example.org";

const principal = (p: Partial<Principal> & Pick<Principal, "via" | "id">): Principal => ({
  name: "p",
  scopes: ["*"],
  userId: null,
  ...p,
});
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  principal: principal({ via: "session", id: "sess_1", name: "owner@example.com", userId: "user_1" }),
  tier: "verified_principal",
  sandbox: false,
  now: () => clock,
};
const claude: Caller = {
  actor: { kind: "owner_ai", id: "client_claude", channel: "mcp_owner" },
  actsAs: "owner",
  principal: principal({
    via: "oauth",
    id: "client_claude",
    name: "Claude",
    scopes: ["inbox:read", "inbox:write", "settings:read", "settings:write", "offline_access"],
    userId: "user_1",
  }),
  tier: "verified_principal",
  sandbox: false,
  now: () => clock,
};
const zapier: Caller = {
  actor: { kind: "integration", id: "key_zap", channel: "rest" },
  principal: principal({ via: "api_key", keyKind: "integration", id: "key_zap", name: "Zapier" }),
  tier: "verified_principal",
  sandbox: false,
  now: () => clock,
};

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

const withSettings = (doc: Record<string, unknown>): Settings => parseStoredSettings(doc).settings;

async function catalogueJobs(db: ReturnType<typeof createDb>): Promise<string[]> {
  const { rows } = await db.client.query({
    sql: "SELECT payload FROM jobs WHERE kind = ? ORDER BY created_at, id",
    params: [NETWORK_CATALOGUE_KIND],
    method: "all",
  });
  return rows.map((r) => (JSON.parse(String(r[0])) as { network: string }).network);
}

describe("the catalogue settings", () => {
  it("are on by default, prices' tax unsaid, and every network gets the products", () => {
    expect(DEFAULT_SETTINGS.catalogue).toEqual({ listed: true, taxIncluded: null, skuBarcodes: "ask" });
    expect(withSettings({ networks: { [A]: { enabled: true } } }).networks[A]?.share.catalogue).toBe(true);
  });

  it("are read leniently: a stored value this version rejects falls back alone", () => {
    const { settings, ignored } = parseStoredSettings({ catalogue: { listed: false, taxIncluded: "maybe" } });
    expect(settings.catalogue).toEqual({ listed: false, taxIncluded: null, skuBarcodes: "ask" });
    expect(ignored).toEqual(["catalogue.taxIncluded"]);
  });
});

describe("what each network wants", () => {
  it("lists products only with the switch on, the network sharing them, and the business in its directory", () => {
    const s = withSettings({
      networks: {
        [A]: { enabled: true },
        [B]: { enabled: true, share: { catalogue: false } },
        "https://unlisted.example.net": { enabled: true, share: { listing: false } },
        "https://off.example.net": { enabled: false },
      },
    });
    expect(wantsCatalogue(s, A)).toBe(true);
    expect(wantsCatalogue(s, B)).toBe(false);
    expect(wantsCatalogue(s, "https://unlisted.example.net")).toBe(false);
    expect(wantsCatalogue(s, "https://off.example.net")).toBe(false);
    expect(wantsCatalogue(s, "https://unknown.example.net")).toBe(false);
    expect(wantsCatalogue({ ...s, directory: { ...s.directory, listed: false } }, A)).toBe(false);
    expect(wantsCatalogue({ ...s, catalogue: { ...s.catalogue, listed: false } }, A)).toBe(false);
  });

  it("is owed to a network whenever it was told something else, and listed ones that were never told", () => {
    expect(catalogueOwed(null, true)).toBe(true);
    expect(catalogueOwed(null, false)).toBe(false);
    expect(catalogueOwed(1, true)).toBe(false);
    expect(catalogueOwed(1, false)).toBe(true);
    expect(catalogueOwed(0, false)).toBe(false);
    expect(catalogueOwed(0, true)).toBe(true);
  });
});

describe("who switches it", () => {
  it("is the owner in person: the owner's AI and another system's key change none of it, on or off", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { networks: { [A]: { enabled: true } } } });
    for (const caller of [claude, zapier]) {
      for (const doc of [
        { catalogue: { listed: false } },
        { catalogue: { taxIncluded: true } },
        { catalogue: { skuBarcodes: "used" } },
        { networks: { [A]: { share: { catalogue: false } } } },
      ]) {
        await expect(caps.updateSettings(caller, { doc }), JSON.stringify(doc)).rejects.toMatchObject({
          code: "not_allowed",
          message: expect.stringContaining("Listing on networks is yours to switch, in the app."),
          details: { reason: "owner_in_person" },
        });
      }
    }
    const after = await readSettings(db);
    expect(after.catalogue).toEqual(DEFAULT_SETTINGS.catalogue);
    expect(after.networks[A]?.share.catalogue).toBe(true);
  });

  it("still lets the owner's AI switch a network off, which takes its products with it", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { networks: { [A]: { enabled: true } } } });
    await caps.updateSettings(claude, { doc: { networks: { [A]: { enabled: false } } } });
    expect(wantsCatalogue(await readSettings(db), A)).toBe(false);
  });

  it("tells each network whose answer a write changed, at once", async () => {
    const { db, caps } = await setup();
    const write = (doc: Record<string, unknown>) => {
      clock += 1000;
      return caps.updateSettings(owner, { doc });
    };
    await write({ networks: { [A]: { enabled: true }, [B]: { enabled: true } } });
    // Switching two networks on changes what both want.
    expect(await catalogueJobs(db)).toEqual([A, B]);
    await write({ networks: { [B]: { share: { catalogue: false } } } });
    expect(await catalogueJobs(db)).toEqual([A, B, B]);
    await write({ catalogue: { listed: false } });
    expect(await catalogueJobs(db)).toEqual([A, B, B, A]);
    // The tax chooser changes no network's answer: the next ping's rev says it.
    await write({ catalogue: { listed: true, taxIncluded: true } });
    expect(await catalogueJobs(db)).toEqual([A, B, B, A, A]);
    await write({ catalogue: { taxIncluded: false } });
    expect(await catalogueJobs(db)).toHaveLength(5);
  });
});
