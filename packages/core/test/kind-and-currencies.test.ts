import { runMigrations } from "@surfingdog/platform";
import { manifestSchema, profileSchema } from "@surfingdog/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { directoryProfile } from "../src/capabilities/directory";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { buildManifest } from "../src/manifest";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { readSettings, settingsSchema } from "../src/settings/schema";
import type { Caller, Principal } from "../src/write/index";
import { WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * What the business runs (`directory.kind`, the setup's first question) and the currencies it takes besides its own
 * (`payments.currencies`): kept only when they read, published in the manifest's profile as a network reads it (the
 * kind in the categories, the currencies with its own first), and the currencies changed only by the owner in person.
 * Node and workerd.
 */
const T0 = Date.parse("2026-10-31T10:00:00Z");
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
const ownersAi: Caller = {
  actor: { kind: "owner_ai", id: "client_assistant", channel: "mcp_owner" },
  actsAs: "owner",
  principal: principal({
    via: "oauth",
    id: "client_assistant",
    name: "An assistant",
    scopes: ["inbox:read", "inbox:write", "settings:read", "settings:write", "offline_access"],
    userId: "user_1",
  }),
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

beforeAll(async () => {
  await setup();
}, 60_000);

async function refusal(write: Promise<unknown>): Promise<WriteError> {
  try {
    await write;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("the write was not refused");
}

async function profileOf(db: Awaited<ReturnType<typeof setup>>["db"], currency = "EUR") {
  const s = await readSettings(db);
  return directoryProfile(db, {
    name: "Ink & Anchor",
    languages: s.business.languages,
    timezone: "Europe/Berlin",
    directory: s.directory,
    currency,
    currencies: s.payments.currencies,
    now: T0,
  });
}

describe("what the business runs", () => {
  it("is nothing out of the box", () => {
    expect(settingsSchema.parse({}).directory.kind).toBeNull();
  });

  it("keeps a kind of the vocabulary, or the owner's own words, and refuses an id the vocabulary lacks", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { directory: { kind: { id: "tattoo-studio", label: "Tattoo studio" } } } });
    expect((await readSettings(db)).directory.kind).toEqual({ id: "tattoo-studio", label: "Tattoo studio" });
    await caps.updateSettings(owner, { doc: { directory: { kind: { id: null, label: "  Hovercraft tours " } } } });
    expect((await readSettings(db)).directory.kind).toEqual({ id: null, label: "Hovercraft tours" });
    for (const kind of [
      { id: "spaceport", label: "Spaceport" },
      { id: null, label: " " },
      { id: null, label: "x".repeat(61) },
    ]) {
      const e = await refusal(caps.updateSettings(owner, { doc: { directory: { kind } } }));
      expect(e.code, JSON.stringify(kind)).toBe("invalid_input");
    }
    expect((await readSettings(db)).directory.kind).toEqual({ id: null, label: "Hovercraft tours" });
    await caps.updateSettings(owner, { doc: { directory: { kind: null } } });
    expect((await readSettings(db)).directory.kind).toBeNull();
  });

  it("is published in the profile's categories, after the owner's own, as a network reads them", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, {
      doc: {
        directory: { categories: ["piercing", "hair-beauty"], kind: { id: "tattoo-studio", label: "Tattoo studio" } },
      },
    });
    const profile = await profileOf(db);
    // The kind's slug is the owner's already: once. Its name follows as a free tag.
    expect(profile?.categories).toEqual(["piercing", "hair-beauty", "Tattoo studio"]);
    expect(profileSchema.safeParse(profile).success).toBe(true);
    const manifest = buildManifest({ instanceUrl: "https://inbox.example.com", profile });
    expect(manifestSchema.parse(manifest).profile?.categories).toContain("Tattoo studio");
    // A kind in the owner's own words is a free tag of its own.
    await caps.updateSettings(owner, {
      doc: { directory: { categories: [], kind: { id: null, label: "Hovercraft tours" } } },
    });
    expect((await profileOf(db))?.categories).toEqual(["Hovercraft tours"]);
    // Ten at most, the owner's first.
    const ten = Array.from({ length: 10 }, (_, i) => `tag-${i}`);
    await caps.updateSettings(owner, {
      doc: { directory: { categories: ten, kind: { id: "bakery", label: "Bakery" } } },
    });
    expect((await profileOf(db))?.categories).toEqual(ten);
  });
});

describe("the currencies the business takes", () => {
  it("are its own alone out of the box, and nothing extra is published", async () => {
    const { db, caps } = await setup();
    expect((await readSettings(db)).payments.currencies).toEqual([]);
    expect((await profileOf(db))?.currencies).toBeUndefined();
    expect((await caps.getBusinessProfile()).currencies).toBeUndefined();
  });

  it("keeps up to four others, each once, in capitals, and refuses what is not a currency", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { payments: { currencies: ["usd", " GBP"] } } });
    expect((await readSettings(db)).payments.currencies).toEqual(["USD", "GBP"]);
    for (const currencies of [["USD", "USD"], ["XYZ"], ["dollars"], ["USD", "GBP", "CHF", "JPY", "KWD"]]) {
      const e = await refusal(caps.updateSettings(owner, { doc: { payments: { currencies } } }));
      expect(e.code, JSON.stringify(currencies)).toBe("invalid_input");
    }
    expect((await readSettings(db)).payments.currencies).toEqual(["USD", "GBP"]);
  });

  it("are never the owner's AI's to change: what the business tells every agent it takes", async () => {
    const { db, caps } = await setup();
    const e = await refusal(caps.updateSettings(ownersAi, { doc: { payments: { currencies: ["USD"] } } }));
    expect(e.code).toBe("not_allowed");
    expect((await readSettings(db)).payments.currencies).toEqual([]);
  });

  it("are published with its own first, whose prices are in it, and its own never twice", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { payments: { currencies: ["CHF", "EUR", "GBP"] } } });
    expect((await profileOf(db, "EUR"))?.currencies).toEqual(["EUR", "CHF", "GBP"]);
    expect((await caps.getBusinessProfile()).currencies).toEqual(["EUR", "CHF", "GBP"]);
    // Its own named alone among the others: nothing more to say.
    await caps.updateSettings(owner, { doc: { payments: { currencies: ["EUR"] } } });
    expect((await profileOf(db, "EUR"))?.currencies).toBeUndefined();
    expect((await caps.getBusinessProfile()).currencies).toBeUndefined();
  });
});
