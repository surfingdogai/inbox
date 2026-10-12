import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { NETWORK_LISTING_KIND } from "../src/network/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { type HostPolicy, hostPolicyFor, SET_BY_HOST } from "../src/settings/policy";
import { DEFAULT_NETWORK, readSettings } from "../src/settings/schema";
import type { Caller } from "../src/write/caller";
import { WriteError } from "../src/write/errors";
import { makeClient, resetTables } from "./harness";

/**
 * A host's policy (`settings/policy.ts`): what it sets is written before the inbox serves, and
 * nobody changes what it holds through the inbox — the owner in person, a key with settings:write,
 * the owner's AI and the inbox's own system writes are each told it is set by their host, and
 * nothing changes. Everything else stays the owner's. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-10-12T09:00:00Z");
const ADDRESS = "https://calm-otter-7k2q.example.net";
const OTHER = "https://people.example.org";

/** An inbox no site links to yet: no sender of its own, no private calls, unlisted, no network. */
const POLICY = hostPolicyFor({ address: ADDRESS, site: null });

const caller = (c: Omit<Caller, "tier" | "sandbox" | "now">): Caller => ({
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
  ...c,
});
/** The owner, signed in to the owner app. */
const owner = caller({
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  principal: { via: "session", id: "sess_1", name: "owner@oficinamare.pt", scopes: ["*"], userId: "user_1" },
});
/** The owner with a full owner key, from the command line. */
const ownerKey = caller({
  actor: { kind: "owner", id: "key_cli", channel: "rest" },
  principal: { via: "api_key", id: "key_cli", name: "cli", scopes: ["*"], userId: null, keyKind: "owner" },
});
/** A key the owner minted for another system, with settings:write. */
const integration = caller({
  actor: { kind: "integration", id: "key_zap", channel: "rest" },
  actsAs: "owner",
  principal: {
    via: "api_key",
    id: "key_zap",
    name: "Zapier",
    scopes: ["settings:read", "settings:write"],
    userId: null,
    keyKind: "integration",
  },
});
/** The owner's AI, with every settings scope. */
const ai = caller({
  actor: { kind: "owner_ai", id: "client_claude", channel: "mcp_owner" },
  actsAs: "owner",
  principal: {
    via: "oauth",
    id: "client_claude",
    name: "Claude",
    scopes: ["settings:read", "settings:write"],
    userId: "user_1",
  },
});
/** The inbox itself: a setup plan, the command line. */
const system = caller({ actor: { kind: "system", id: "setup", channel: "system" } });

async function setup(policy: HostPolicy | null = POLICY, before?: (caps: Capabilities) => Promise<void>) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const caps = new Capabilities(db, null);
  await before?.(caps);
  caps.attachPolicy(policy);
  return { db, caps };
}

const version = async (db: Db) =>
  Number((await db.client.query({ sql: "SELECT version FROM settings", method: "all" })).rows[0]?.[0] ?? 0);

async function refused(write: Promise<unknown>, paths: readonly string[]): Promise<void> {
  const error = await write.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `${paths.join(", ")} was written`).toBeInstanceOf(WriteError);
  const e = error as WriteError;
  expect(e.code).toBe("not_allowed");
  expect(e.details?.reason).toBe("set_by_host");
  expect(e.message).toContain(SET_BY_HOST);
  for (const path of paths) {
    expect(e.fields?.find((f) => f.path === `doc.${path}`)?.message, path).toBe(SET_BY_HOST);
  }
}

describe("a host's policy", () => {
  it("writes what it sets before the inbox serves, and only once while nothing drifts", async () => {
    const { db, caps } = await setup();
    expect(await caps.applyHostPolicy(T0)).toBe(true);
    const s = await readSettings(db);
    expect(s.notifications.appUrl).toBe(ADDRESS);
    expect(s.directory.listed).toBe(false);
    expect(s.integrations.webhooks.allowPrivateTargets).toBe(false);
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(false);
    const v = await version(db);
    expect(await caps.applyHostPolicy(T0)).toBe(false);
    expect(await version(db)).toBe(v);
  });

  it("switches off what the owner had on before the host held it, every network included", async () => {
    const { db, caps } = await setup(POLICY, async (c) => {
      await c.updateSettings(owner, {
        doc: {
          networks: { [DEFAULT_NETWORK]: { enabled: true }, [OTHER]: { enabled: true } },
          integrations: { webhooks: { allowPrivateTargets: true } },
          identity: { extraAuthorities: ["agents.example.com"] },
        },
      });
    });
    expect(await caps.applyHostPolicy(T0)).toBe(true);
    const s = await readSettings(db);
    expect(Object.values(s.networks).map((n) => n.enabled)).toEqual([false, false]);
    expect(s.integrations.webhooks.allowPrivateTargets).toBe(false);
    expect(s.identity.extraAuthorities).toEqual([]);
    // The networks that left are told, by the same jobs any write queues.
    const { rows } = await db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = ?",
      params: [NETWORK_LISTING_KIND],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBeGreaterThan(0);
  });

  it("refuses what it holds from the owner, a key, the owner's AI and the inbox itself, and changes nothing", async () => {
    const { db, caps } = await setup();
    await caps.applyHostPolicy(T0);
    const v = await version(db);
    const attempts: [Record<string, unknown>, string[]][] = [
      [{ networks: { [DEFAULT_NETWORK]: { enabled: true } } }, [`networks`]],
      [{ networks: { [OTHER]: { enabled: true } } }, ["networks"]],
      [{ directory: { listed: true } }, ["directory.listed"]],
      [{ email: { fromAddress: "owner@personal.example" } }, ["email"]],
      [{ email: { fromName: "Someone else" } }, ["email"]],
      [{ email: { replyTo: "owner@personal.example" } }, ["email"]],
      [{ notifications: { appUrl: "https://evil.example" } }, ["notifications.appUrl"]],
      [{ notifications: { ownerEmail: "attacker@evil.example" } }, ["notifications.ownerEmail"]],
      [{ integrations: { webhooks: { allowPrivateTargets: true } } }, ["integrations.webhooks.allowPrivateTargets"]],
      [{ identity: { extraAuthorities: ["evil.example"] } }, ["identity.extraAuthorities"]],
      [{ security: { contact: "attacker@evil.example" } }, ["security.contact"]],
    ];
    for (const who of [owner, ownerKey, integration, ai, system]) {
      for (const [doc, paths] of attempts) {
        await refused(caps.updateSettings(who, { doc }), paths);
      }
    }
    // The legacy pair is a network too.
    await refused(caps.updateSettings(owner, { doc: { network: { join: true } } }), ["networks"]);
    expect(await version(db)).toBe(v);
    const s = await readSettings(db);
    expect(s.email.fromAddress).toBeUndefined();
    expect(s.notifications.appUrl).toBe(ADDRESS);
    expect(s.directory.listed).toBe(false);
    expect(Object.values(s.networks).every((n) => !n.enabled)).toBe(true);
  });

  it("holds what a forced patch would set over a write too: a network added is one it switches off", async () => {
    const off = (current: { networks: Record<string, unknown> }) => ({
      networks: Object.fromEntries(Object.keys(current.networks).map((origin) => [origin, { enabled: false }])),
    });
    const { db, caps } = await setup({ forced: off });
    await caps.applyHostPolicy(T0);
    await refused(caps.updateSettings(owner, { doc: { networks: { [OTHER]: { enabled: true } } } }), [
      `networks.${OTHER}.enabled`,
    ]);
    expect((await readSettings(db)).networks[OTHER]).toBeUndefined();
  });

  it("takes everything else, and a document written back as it was read", async () => {
    const { db, caps } = await setup();
    await caps.applyHostPolicy(T0);
    const read = await caps.getSettings(owner);
    expect(read.locked).toEqual(
      expect.arrayContaining(["email", "notifications.appUrl", "directory.listed", "networks", "security.contact"]),
    );
    const saved = await caps.updateSettings(owner, {
      doc: { ...read.doc, booking: { ...read.doc.booking, cancellationWindowMin: 90 } } as never,
      expected_version: read.version,
    });
    expect(saved.doc.booking.cancellationWindowMin).toBe(90);
    // The integration key and the inbox itself change what is theirs to change.
    await caps.updateSettings(integration, { doc: { business: { name: "Oficina Maré" } } });
    await caps.updateSettings(system, { doc: { directory: { description: "Bike repairs in Porto" } } });
    const s = await readSettings(db);
    expect(s.business.name).toBe("Oficina Maré");
    expect(s.directory.description).toBe("Bike repairs in Porto");
  });

  it("keeps the owner's sign-in from remembering an address the host holds", async () => {
    const { db, caps } = await setup({ locked: ["notifications.appUrl"] });
    expect(await caps.rememberInboxAddress("https://inbox.oficinamare.pt", T0)).toBe(false);
    expect((await readSettings(db)).notifications.appUrl).toBeUndefined();
    // Without a policy, it remembers it as before.
    const plain = await setup(null);
    expect(await plain.caps.rememberInboxAddress("https://inbox.oficinamare.pt", T0)).toBe(true);
  });

  it("refuses to be built over a path that is not a setting, so a typo never locks nothing", async () => {
    const { caps } = await setup(null);
    expect(() => caps.attachPolicy({ locked: ["emial"] })).toThrow(/"emial" is not a setting/);
    expect(() => caps.attachPolicy({ locked: ["email."] })).toThrow(/not a setting/);
    expect(() => caps.attachPolicy({ forced: { notification: { appUrl: ADDRESS } } })).toThrow(/not a setting/);
  });

  it("hands the networks and the directories to the owner once the site links to the inbox, and names the site", async () => {
    const { db, caps } = await setup();
    await caps.applyHostPolicy(T0);
    caps.attachPolicy(hostPolicyFor({ address: ADDRESS, site: "https://oficinamare.pt" }));
    expect(await caps.applyHostPolicy(T0 + 1)).toBe(true);
    let s = await readSettings(db);
    expect(s.directory.url).toBe("https://oficinamare.pt");
    // Still off: the owner switches them on, in person.
    expect(s.directory.listed).toBe(false);
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(false);
    await caps.updateSettings(owner, {
      doc: { directory: { listed: true }, networks: { [DEFAULT_NETWORK]: { enabled: true } } },
    });
    s = await readSettings(db);
    expect(s.directory.listed).toBe(true);
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(true);
    // The website and the sender are still the host's.
    await refused(caps.updateSettings(owner, { doc: { directory: { url: "https://elsewhere.example" } } }), [
      "directory.url",
    ]);
    await refused(caps.updateSettings(owner, { doc: { email: { replyTo: "hello@oficinamare.pt" } } }), ["email"]);
  });

  it("is nothing at all for an inbox run without one", async () => {
    const { db, caps } = await setup(null);
    expect(await caps.applyHostPolicy(T0)).toBe(false);
    await caps.updateSettings(owner, { doc: { email: { fromAddress: "hello@oficinamare.pt" } } });
    expect((await readSettings(db)).email.fromAddress).toBe("hello@oficinamare.pt");
    expect((await caps.getSettings(owner)).locked).toEqual([]);
  });
});
