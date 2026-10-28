import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { listingOwed, wantsListed } from "../src/network/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { openedNetworks } from "../src/settings/guard";
import { DEFAULT_SETTINGS, parseStoredSettings, readSettings, type Settings } from "../src/settings/schema";
import type { Caller, Principal } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * The business in the networks' directories (ADR-017 A2.3, A2.5): the `directory` settings, what
 * they make each network want, and who may change them. Leaving is anyone's to do; coming back,
 * like switching a network on, is the owner's alone. Node and workerd.
 */
const T0 = Date.parse("2026-10-06T10:00:00Z");
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
  now: () => T0,
};
/** The owner's AI over OAuth. */
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
  now: () => T0,
};
/** A key the owner handed to another system. */
const zapier: Caller = {
  actor: { kind: "integration", id: "key_zap", channel: "rest" },
  principal: principal({ via: "api_key", keyKind: "integration", id: "key_zap", name: "Zapier" }),
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

const withSettings = (doc: Record<string, unknown>): Settings => parseStoredSettings(doc).settings;

describe("the directory settings", () => {
  it("default to listed, with an empty profile", () => {
    expect(DEFAULT_SETTINGS.directory).toEqual({
      listed: true,
      description: "",
      categories: [],
      // What the business runs: nothing until the owner says (the setup's first question).
      kind: null,
      address: { streetAddress: "", addressLocality: "", postalCode: "", addressCountry: "" },
      geo: null,
      url: "",
      placeCategory: null,
      cuisines: [],
      reservations: null,
      priceBand: null,
      features: [],
      saved: {},
    });
  });

  it("drop a stored value this version rejects alone", () => {
    const { settings, ignored } = parseStoredSettings({
      directory: {
        listed: false,
        address: { addressLocality: "Ericeira", addressCountry: "pt" },
        url: "javascript:alert(1)",
      },
    });
    expect(settings.directory).toMatchObject({
      listed: false,
      address: { addressLocality: "Ericeira", addressCountry: "" },
      url: "",
    });
    expect(ignored.sort()).toEqual(["directory.address.addressCountry", "directory.url"]);
  });
});

describe("what each network wants", () => {
  it("is listed only with the directory on, the network on, and its listing shared", () => {
    const s = withSettings({
      networks: {
        [A]: { enabled: true },
        [B]: { enabled: true, share: { listing: false } },
        "https://off.example.net": { enabled: false },
      },
    });
    expect(wantsListed(s, A)).toBe(true);
    expect(wantsListed(s, B)).toBe(false);
    expect(wantsListed(s, "https://off.example.net")).toBe(false);
    expect(wantsListed(s, "https://unknown.example.net")).toBe(false);
    expect(wantsListed({ ...s, directory: { ...s.directory, listed: false } }, A)).toBe(false);
  });

  it("is owed to a network only when it was told something else, or never told it is not listed", () => {
    expect(listingOwed(null, true)).toBe(false);
    expect(listingOwed(null, false)).toBe(true);
    expect(listingOwed(1, true)).toBe(false);
    expect(listingOwed(1, false)).toBe(true);
    expect(listingOwed(0, false)).toBe(false);
    expect(listingOwed(0, true)).toBe(true);
  });
});

describe("coming back into the directories", () => {
  it("counts as opening every network", () => {
    const out = withSettings({ directory: { listed: false } });
    expect(openedNetworks(out, DEFAULT_SETTINGS)).toEqual(["directory.listed"]);
    expect(openedNetworks(DEFAULT_SETTINGS, out)).toEqual([]);
  });

  it("is the owner's alone: the owner's AI and another system's key may leave, never come back", async () => {
    const { db, caps } = await setup();
    // Leaving shares less, which anyone with settings:write may do.
    await caps.updateSettings(claude, { doc: { directory: { listed: false } } });
    expect((await readSettings(db)).directory.listed).toBe(false);

    for (const caller of [claude, zapier]) {
      await expect(caps.updateSettings(caller, { doc: { directory: { listed: true } } })).rejects.toMatchObject({
        code: "not_allowed",
        details: { reason: "owner_in_person", where: "Settings → Networks" },
        fields: [{ path: "doc.directory.listed" }],
      });
    }
    expect((await readSettings(db)).directory.listed).toBe(false);

    await caps.updateSettings(owner, { doc: { directory: { listed: true } } });
    expect((await readSettings(db)).directory.listed).toBe(true);
  });

  it("lets the owner's AI edit the public address and categories, but never put a key or a secret in them", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(claude, { doc: { directory: { categories: ["repairs"] } } });
    expect((await readSettings(db)).directory.categories).toEqual(["repairs"]);
    await expect(
      caps.updateSettings(claude, {
        doc: { directory: { address: { streetAddress: "Use sdi_own_0123456789abcdef to manage us." } } },
      }),
    ).rejects.toMatchObject({ code: "not_allowed" });
    expect((await readSettings(db)).directory.address.streetAddress).toBe("");
  });
});

describe("the listing (spec 0.13)", () => {
  const listing = {
    description: "Hand-pulled ramen in Arroios. The vegan shoyu is made with kombu and mushroom broth.",
    placeCategory: { primary: "noodles_restaurant", alternates: ["japanese_restaurant"] },
    cuisines: ["ramen", "japanese"],
    reservations: "recommended",
    priceBand: 2,
    features: ["wifi", "outdoor_seating"],
  };

  it("is the owner's alone: the owner's AI and another system's key change none of it", async () => {
    const { db, caps } = await setup();
    for (const [field, value] of Object.entries(listing)) {
      for (const caller of [claude, zapier]) {
        await expect(
          caps.updateSettings(caller, { doc: { directory: { [field]: value } } }),
          `${caller.actor.id}: ${field}`,
        ).rejects.toMatchObject({ code: "not_allowed", fields: [{ path: `doc.directory.${field}` }] });
      }
    }
    await caps.updateSettings(owner, { doc: { directory: listing } });
    expect((await readSettings(db)).directory).toMatchObject(listing);
    // Written back as it was read, it changes nothing, so the owner's AI is not refused.
    await caps.updateSettings(claude, { doc: { directory: listing } });
  });

  it("holds only choices: cuisines of the vocabulary, each once, at most five; declarable features; a band 1 to 4", async () => {
    const { caps } = await setup();
    const bad: Record<string, unknown>[] = [
      { cuisines: ["Ramen"] },
      { cuisines: ["ramen", "ramen"] },
      { cuisines: ["ramen", "sushi", "pizza", "thai", "korean", "greek"] },
      { cuisines: ["vegan"] },
      { features: ["halal"] },
      { features: ["open_24h"] },
      { features: ["cuisine"] },
      { reservations: "maybe" },
      { priceBand: 5 },
      { placeCategory: { primary: "Hair Salon" } },
      { description: "x".repeat(601) },
    ];
    for (const directory of bad) {
      await expect(caps.updateSettings(owner, { doc: { directory } }), JSON.stringify(directory)).rejects.toMatchObject(
        {
          code: "invalid_input",
        },
      );
    }
    await caps.updateSettings(owner, { doc: { directory: { description: "x".repeat(600) } } });
  });

  it("stamps when the owner last said each field, never taking a time a write sends", async () => {
    const { db, caps } = await setup();
    const later = (ms: number): Caller => ({ ...owner, now: () => T0 + ms });
    await caps.updateSettings(owner, { doc: { directory: { cuisines: ["ramen"], description: "Ramen." } } });
    expect((await readSettings(db)).directory.saved).toEqual({
      cuisines: "2026-10-06T10:00:00.000Z",
      description: "2026-10-06T10:00:00.000Z",
    });
    // A write that changes one field stamps that one; a forged time is not taken.
    await caps.updateSettings(later(60_000), {
      doc: { directory: { cuisines: ["ramen", "japanese"], saved: { description: "2030-01-01T00:00:00.000Z" } } },
    });
    expect((await readSettings(db)).directory.saved).toEqual({
      cuisines: "2026-10-06T10:01:00.000Z",
      description: "2026-10-06T10:00:00.000Z",
    });
    // The same value written again is no new statement.
    await caps.updateSettings(later(120_000), { doc: { directory: { cuisines: ["ramen", "japanese"] } } });
    expect((await readSettings(db)).directory.saved.cuisines).toBe("2026-10-06T10:01:00.000Z");
  });

  it("stamps a value read from the website once the owner checks it", async () => {
    const { db, caps } = await setup();
    const read = { source_url: "https://tasca.example/sobre", checked_at: "2026-10-05T09:00:00Z", confidence: "read" };
    await caps.updateSettings(owner, {
      doc: { directory: { description: "Ramen." }, setup: { sources: { "directory.description": read } } },
    });
    await caps.updateSettings(
      { ...owner, now: () => T0 + 3_600_000 },
      {
        doc: { setup: { sources: { "directory.description": null } } },
      },
    );
    expect((await readSettings(db)).directory.saved.description).toBe("2026-10-06T11:00:00.000Z");
  });
});
