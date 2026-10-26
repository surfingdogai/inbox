import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { DOWNLOAD_TABLES } from "../src/capabilities/download";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { NETWORK_LISTING_KIND, NETWORK_PING_ONE_KIND } from "../src/network/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { type HostPolicy, hostPolicyFor, joinPatch, SET_BY_HOST } from "../src/settings/policy";
import { DEFAULT_NETWORK, readSettings } from "../src/settings/schema";
import type { Caller } from "../src/write/caller";
import { WriteError } from "../src/write/errors";
import { makeClient, resetTables } from "./harness";

/**
 * A host's hold and a host's seed (`settings/policy.ts`). A hosted inbox joins its host's network
 * from day one (`joins`): the network is switched on with its first settings, held off while the
 * business's own site does not link to the inbox yet, and on from the moment it does. A hold
 * remembers what each network and the listing were (`resume`), so the owner's own choice survives
 * the inbox dropping back (a lost DNS record) and coming back. During a hold the owner chooses what
 * comes back on (`resume`), anyone may choose off, and nothing reaches a network; outside a hold
 * nobody sets `resume`. The seed is written once, to a new inbox, never over settings someone chose.
 */
const T0 = Date.parse("2026-10-18T09:00:00Z");
const ADDRESS = "https://quiet-heron.example.net";
const SITE = "https://oficinamare.pt";
const OTHER = "https://people.example.org";

const held = (joins: readonly string[] = [DEFAULT_NETWORK]) => hostPolicyFor({ address: ADDRESS, site: null, joins });
const live = (joins: readonly string[] = [DEFAULT_NETWORK]) => hostPolicyFor({ address: ADDRESS, site: SITE, joins });

const caller = (c: Omit<Caller, "tier" | "sandbox" | "now">): Caller => ({
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
  ...c,
});
const owner = caller({
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  principal: { via: "session", id: "sess_1", name: "owner@oficinamare.pt", scopes: ["*"], userId: "user_1" },
});
const ownerKey = caller({
  actor: { kind: "owner", id: "key_cli", channel: "rest" },
  principal: { via: "api_key", id: "key_cli", name: "cli", scopes: ["*"], userId: null, keyKind: "owner" },
});
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
const system = caller({ actor: { kind: "system", id: "setup", channel: "system" } });

async function setup(policy: HostPolicy | null, before?: (caps: Capabilities) => Promise<void>) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const caps = new Capabilities(db, null);
  await before?.(caps);
  caps.attachPolicy(policy);
  return { db, caps };
}

const jobs = async (db: Db, kind: string) =>
  Number(
    (await db.client.query({ sql: "SELECT COUNT(*) FROM jobs WHERE kind = ?", params: [kind], method: "all" }))
      .rows[0]?.[0] ?? 0,
  );

const version = async (db: Db) =>
  Number((await db.client.query({ sql: "SELECT version FROM settings", method: "all" })).rows[0]?.[0] ?? 0);

async function moveTo(caps: Capabilities, policy: HostPolicy, at: number): Promise<void> {
  caps.attachPolicy(policy);
  await caps.applyHostPolicy(at);
}

describe("a hosted inbox joins its host's network from day one", () => {
  it("starts with the network on but held, out of the directories, until the site links to it", async () => {
    const { db, caps } = await setup(held());
    expect(await caps.applyHostPolicy(T0)).toBe(true);
    const s = await readSettings(db);
    expect(s.networks[DEFAULT_NETWORK]).toMatchObject({ enabled: false, resume: true });
    expect(s.directory).toMatchObject({ listed: false, resume: true });
    // Nothing reaches a network while it is held.
    expect(await jobs(db, NETWORK_PING_ONE_KIND)).toBe(0);
    // Prepared again, nothing moves.
    const v = await version(db);
    expect(await caps.applyHostPolicy(T0 + 1)).toBe(false);
    expect(await version(db)).toBe(v);
  });

  it("is on and listed from the moment the site links to it, and the network hears at once", async () => {
    const { db, caps } = await setup(held());
    await caps.applyHostPolicy(T0);
    await moveTo(caps, live(), T0 + 1);
    const s = await readSettings(db);
    // Listed, counted, receipts: and no first-time customer's email until a person switches keys on.
    expect(s.networks[DEFAULT_NETWORK]).toMatchObject({ enabled: true, issue: false });
    expect(s.networks[DEFAULT_NETWORK]?.share).toEqual({
      listing: true,
      counts: true,
      receipts: true,
      catalogue: true,
    });
    expect(s.networks[DEFAULT_NETWORK]?.resume).toBeUndefined();
    expect(s.directory.listed).toBe(true);
    expect(s.directory.resume).toBeUndefined();
    expect(await jobs(db, NETWORK_PING_ONE_KIND)).toBeGreaterThan(0);
    // The owner can switch it off, in person, and it stays off however often the inbox is prepared.
    await caps.updateSettings(owner, { doc: { networks: { [DEFAULT_NETWORK]: { enabled: false } } } });
    expect(await caps.applyHostPolicy(T0 + 2)).toBe(false);
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.enabled).toBe(false);
  });

  it("keeps the owner's choice through a hold and back: on stays on, off stays off", async () => {
    for (const choice of [true, false]) {
      const { db, caps } = await setup(held());
      await caps.applyHostPolicy(T0);
      await moveTo(caps, live(), T0 + 1);
      await caps.updateSettings(owner, {
        doc: {
          networks: { [DEFAULT_NETWORK]: { enabled: choice }, [OTHER]: { enabled: !choice } },
          directory: { listed: choice },
        },
      });
      // The site's record goes (a lost hostname): everything is held off, and remembered.
      await moveTo(caps, held(), T0 + 2);
      let s = await readSettings(db);
      expect(Object.values(s.networks).every((n) => !n.enabled)).toBe(true);
      expect(s.networks[DEFAULT_NETWORK]?.resume).toBe(choice);
      expect(s.networks[OTHER]?.resume).toBe(!choice);
      expect(s.directory).toMatchObject({ listed: false, resume: choice });
      // Prepared again while held: what it remembers does not drift to off.
      await caps.applyHostPolicy(T0 + 3);
      expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.resume).toBe(choice);
      // Back: as the owner left it, and the seed is not written again.
      await moveTo(caps, live(), T0 + 4);
      s = await readSettings(db);
      expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(choice);
      expect(s.networks[OTHER]?.enabled).toBe(!choice);
      expect(s.directory.listed).toBe(choice);
      expect(Object.values(s.networks).every((n) => n.resume === undefined)).toBe(true);
    }
  });

  it("never seeds an inbox that already had settings: it stays as it was", async () => {
    const { db, caps } = await setup(null, async (c) => {
      await c.updateSettings(owner, { doc: { business: { name: "Oficina Maré" } } });
    });
    caps.attachPolicy(live());
    await caps.applyHostPolicy(T0);
    const s = await readSettings(db);
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(false);
    expect(s.business.name).toBe("Oficina Maré");
  });

  it("joins none when the host names none", async () => {
    const { db, caps } = await setup(hostPolicyFor({ address: ADDRESS, site: SITE }));
    await caps.applyHostPolicy(T0);
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.enabled).toBe(false);
  });

  it("lets anyone choose off while held, the owner in person choose on, and sends nothing until live", async () => {
    const { db, caps } = await setup(held());
    await caps.applyHostPolicy(T0);
    const net = (doc: Record<string, unknown>) => ({ doc: { networks: { [DEFAULT_NETWORK]: doc } } });
    const refused = async (who: Caller, doc: { doc: Record<string, unknown> }) =>
      caps.updateSettings(who, doc).then(
        () => null,
        (e: unknown) => e as WriteError,
      );

    // The owner's AI may say "stay off"; never "come on".
    await caps.updateSettings(ai, net({ resume: false }));
    let s = await readSettings(db);
    expect(s.networks[DEFAULT_NETWORK]).toMatchObject({ enabled: false, resume: false });
    for (const [who, doc] of [
      [ai, net({ resume: true })],
      [integration, net({ enabled: true })],
      [ai, { doc: { directory: { resume: true } } }],
    ] as const) {
      const e = await refused(who, doc);
      expect(e?.code, JSON.stringify(doc)).toBe("not_allowed");
      expect(e?.details).toMatchObject({ reason: "owner_in_person" });
    }
    // The owner in person, either way; `enabled` means the same while held.
    await caps.updateSettings(owner, net({ enabled: true }));
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.resume).toBe(true);
    await caps.updateSettings(integration, net({ enabled: false }));
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.resume).toBe(false);
    await caps.updateSettings(owner, { doc: { directory: { listed: false } } });
    s = await readSettings(db);
    expect(s.directory).toMatchObject({ listed: false, resume: false });
    // Less to share is anyone's; more, adding a network or dropping the hold, nobody's but the host's.
    await caps.updateSettings(ownerKey, net({ share: { counts: false } }));
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.share.counts).toBe(false);
    for (const [who, doc] of [
      [owner, net({ share: { counts: true } })],
      [owner, net({ issue: true })],
      [owner, net({ resume: null })],
      [owner, { doc: { networks: { [OTHER]: { enabled: false } } } }],
      [system, { doc: { directory: { resume: null } } }],
    ] as const) {
      const e = await refused(who, doc);
      expect(e?.code, JSON.stringify(doc)).toBe("not_allowed");
      expect(e?.message).toContain(SET_BY_HOST);
    }
    // The document written back as it was read changes nothing and is never refused.
    const read = await caps.getSettings(owner);
    const v = await version(db);
    await caps.updateSettings(owner, { doc: read.doc as never, expected_version: read.version });
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]).toMatchObject({ enabled: false, resume: false });
    expect(await version(db)).toBe(v + 1);
    // Shown as held, with what comes back.
    const views = await caps.getNetworks(owner);
    expect(views.networks.find((n) => n.origin === DEFAULT_NETWORK)?.held).toEqual({ on_when_released: false });
    expect(await jobs(db, NETWORK_PING_ONE_KIND)).toBe(0);

    // Live: it stays off, out of the directories, and the network hears nothing at all.
    await moveTo(caps, live(), T0 + 1);
    s = await readSettings(db);
    expect(s.networks[DEFAULT_NETWORK]).toMatchObject({ enabled: false });
    expect(s.networks[DEFAULT_NETWORK]?.resume).toBeUndefined();
    expect(s.directory.listed).toBe(false);
    expect(await jobs(db, NETWORK_PING_ONE_KIND)).toBe(0);
    expect(await jobs(db, NETWORK_LISTING_KIND)).toBe(0);
    expect((await caps.getNetworks(owner)).networks[0]?.held).toBeNull();
  });

  it("comes on when live after the owner, in person, said so during the hold", async () => {
    const { db, caps } = await setup(held());
    await caps.applyHostPolicy(T0);
    await caps.updateSettings(ai, { doc: { networks: { [DEFAULT_NETWORK]: { resume: false } } } });
    await caps.updateSettings(owner, { doc: { networks: { [DEFAULT_NETWORK]: { resume: true } } } });
    await moveTo(caps, live(), T0 + 1);
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.enabled).toBe(true);
    expect(await jobs(db, NETWORK_PING_ONE_KIND)).toBeGreaterThan(0);
  });

  it("refuses resume from everyone where nothing holds the networks, and takes the document back unchanged", async () => {
    for (const policy of [live(), null]) {
      const { db, caps } = await setup(policy);
      await caps.applyHostPolicy(T0);
      const v = await version(db);
      const attempts: Record<string, unknown>[] = [
        { networks: { [DEFAULT_NETWORK]: { resume: false } } },
        { networks: { [OTHER]: { enabled: false, resume: true } } },
        { directory: { resume: false } },
      ];
      for (const who of [owner, ownerKey, integration, ai, system]) {
        for (const doc of attempts) {
          const error = await caps.updateSettings(who, { doc }).then(
            () => null,
            (e: unknown) => e,
          );
          expect(error, JSON.stringify(doc)).toBeInstanceOf(WriteError);
          const e = error as WriteError;
          expect(e.code).toBe("not_allowed");
          // A live hosted inbox's host still says what its policy holds; with no host, there is no hold.
          expect(e.details).toMatchObject({ reason: policy ? "set_by_host" : "no_hold" });
        }
      }
      expect(await version(db)).toBe(v);
      const read = await caps.getSettings(owner);
      await caps.updateSettings(owner, {
        doc: { ...read.doc, booking: { ...read.doc.booking, cancellationWindowMin: 90 } } as never,
        expected_version: read.version,
      });
      expect((await readSettings(db)).booking.cancellationWindowMin).toBe(90);
    }
  });

  it("leaves no hold in a download: the copy's networks are the owner's to switch and remove", async () => {
    const { db, caps } = await setup(held());
    await caps.applyHostPolicy(T0);
    // The strip a download runs on its copy, here on the inbox itself, then opened with no host.
    for (const sql of DOWNLOAD_TABLES.settings?.strip?.(T0) ?? []) await db.client.query({ sql, method: "run" });
    caps.attachPolicy(null);
    let s = await readSettings(db);
    expect(s.networks[DEFAULT_NETWORK]?.resume).toBeUndefined();
    expect(s.directory.resume).toBeUndefined();
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(false);
    expect((await caps.getNetworks(owner)).networks[0]?.held).toBeNull();
    await caps.updateSettings(owner, { doc: { networks: { [DEFAULT_NETWORK]: { enabled: true } } } });
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.enabled).toBe(true);
    await caps.updateSettings(owner, { doc: { networks: { [DEFAULT_NETWORK]: { enabled: false } } } });
    await caps.updateSettings(owner, { doc: { networks: { [DEFAULT_NETWORK]: null } } });
    s = await readSettings(db);
    expect(s.networks[DEFAULT_NETWORK]).toBeUndefined();
  });

  it("lets a hold left in a copy go, without the download's strip, and never shows it as held", async () => {
    const { db, caps } = await setup(held());
    await caps.applyHostPolicy(T0);
    caps.attachPolicy(null);
    expect((await caps.getNetworks(owner)).networks[0]?.held).toBeNull();
    // Taking it away is anyone's; the network can then be switched and removed like any other.
    await caps.updateSettings(ai, { doc: { networks: { [DEFAULT_NETWORK]: { resume: null } } } });
    expect((await readSettings(db)).networks[DEFAULT_NETWORK]?.resume).toBeUndefined();
    await caps.updateSettings(owner, { doc: { networks: { [DEFAULT_NETWORK]: null }, directory: { resume: null } } });
    const s = await readSettings(db);
    expect(s.networks[DEFAULT_NETWORK]).toBeUndefined();
    expect(s.directory.resume).toBeUndefined();
  });

  it("switches on an inbox from before, when its host decides to, held or not", async () => {
    // Live already, with settings from before the seed: on and listed now.
    const a = await setup(null, async (c) => {
      await c.updateSettings(owner, { doc: { business: { name: "Oficina Maré" } } });
    });
    a.caps.attachPolicy(hostPolicyFor({ address: ADDRESS, site: SITE }));
    await a.caps.applyHostPolicy(T0);
    a.caps.attachPolicy(live());
    expect(await a.caps.applyHostSeed(T0 + 1)).toBe(true);
    let s = await readSettings(a.db);
    expect(s.networks[DEFAULT_NETWORK]?.enabled).toBe(true);
    expect(s.directory.listed).toBe(true);
    expect(await jobs(a.db, NETWORK_PING_ONE_KIND)).toBeGreaterThan(0);
    // Done twice, the second changes nothing.
    const v = await version(a.db);
    expect(await a.caps.applyHostSeed(T0 + 2)).toBe(false);
    expect(await version(a.db)).toBe(v);

    // Held, with an old hold that remembered off: remembered as on, still held.
    const b = await setup(null, async (c) => {
      await c.updateSettings(owner, { doc: { business: { name: "Oficina Maré" } } });
    });
    b.caps.attachPolicy(hostPolicyFor({ address: ADDRESS, site: null }));
    await b.caps.applyHostPolicy(T0);
    b.caps.attachPolicy(held());
    expect(await b.caps.applyHostSeed(T0 + 1)).toBe(true);
    s = await readSettings(b.db);
    expect(s.networks[DEFAULT_NETWORK]).toMatchObject({ enabled: false, resume: true });
    expect(s.directory).toMatchObject({ listed: false, resume: true });
    expect(await jobs(b.db, NETWORK_PING_ONE_KIND)).toBe(0);
    await moveTo(b.caps, live(), T0 + 2);
    expect((await readSettings(b.db)).networks[DEFAULT_NETWORK]?.enabled).toBe(true);
  });

  it("does nothing on a seed for a policy that has none", async () => {
    const { caps } = await setup(hostPolicyFor({ address: ADDRESS, site: SITE }));
    expect(await caps.applyHostSeed(T0)).toBe(false);
  });

  it("refuses to be built over a seed that is not settings", async () => {
    const { caps } = await setup(null);
    expect(() => caps.attachPolicy({ seed: { netwerks: {} } })).toThrow(/seed/);
    expect(() =>
      caps.attachPolicy({ seed: { networks: { "http://network.example.com": { enabled: true } } } }),
    ).toThrow(/seed/);
  });
});

describe("joinPatch", () => {
  it("joins and lists", () => {
    expect(joinPatch([DEFAULT_NETWORK])).toEqual({
      networks: { [DEFAULT_NETWORK]: { enabled: true, issue: false } },
      directory: { listed: true },
    });
  });

  it("joins a network the inbox never knew while it is held, without a moment on", async () => {
    const { db, caps } = await setup(held([]));
    await caps.applyHostPolicy(T0);
    caps.attachPolicy(held([DEFAULT_NETWORK, OTHER]));
    expect(await caps.applyHostSeed(T0 + 1)).toBe(true);
    const s = await readSettings(db);
    expect(s.networks[OTHER]).toMatchObject({ enabled: false, resume: true });
    expect(await jobs(db, NETWORK_PING_ONE_KIND)).toBe(0);
  });
});
