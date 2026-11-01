import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { DEFAULT_LOOK, isDefaultLook, lookOf } from "../src/look/palette";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { DEFAULT_SETTINGS, parseStoredSettings, readSettings } from "../src/settings/schema";
import type { Caller, Principal } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * The look setting: its defaults, a bad stored value, and who may change it. The theme and the
 * accent are the owner's in person; the logo moves only through its upload. Node and workerd.
 */
const T0 = Date.parse("2026-11-01T10:00:00Z");

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
const ownerAi: Caller = {
  actor: { kind: "owner_ai", id: "client_assistant", channel: "mcp_owner" },
  actsAs: "owner",
  principal: principal({
    via: "oauth",
    id: "client_assistant",
    name: "Assistant",
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

const LOGO = {
  id: "logo_0123456789abcdef",
  type: "image/png",
  sha256: "ab".repeat(32),
  width: 120,
  height: 40,
} as const;

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

describe("the look setting", () => {
  it("starts as the look every inbox had: Standard, Ink, no logo", () => {
    expect(DEFAULT_SETTINGS.look).toEqual({ theme: "standard", accent: "ink", logo: null });
    expect(lookOf(DEFAULT_SETTINGS)).toEqual(DEFAULT_LOOK);
    expect(isDefaultLook(lookOf(DEFAULT_SETTINGS))).toBe(true);
  });

  it("drops a bad stored value alone: the rest of the look stands", () => {
    const { settings, ignored } = parseStoredSettings({ look: { theme: "neon", accent: "teal", logo: LOGO } });
    expect(settings.look).toEqual({ theme: "standard", accent: "teal", logo: LOGO });
    expect(ignored).toEqual(["look.theme"]);
    expect(parseStoredSettings({ look: { accent: "red" } }).settings.look.accent).toBe("ink");
    expect(parseStoredSettings({ look: { logo: { ...LOGO, type: "image/svg+xml" } } }).settings.look.logo).toBeNull();
  });

  it("names the logo's file by its hash, with its extension", () => {
    const look = lookOf(parseStoredSettings({ look: { theme: "dark", logo: LOGO } }).settings);
    expect(look).toEqual({
      theme: "dark",
      accent: "ink",
      logo: { file: "abababababababab.png", width: 120, height: 40 },
    });
    expect(isDefaultLook(look)).toBe(false);
    expect(lookOf(parseStoredSettings({ look: { logo: { ...LOGO, type: "image/jpeg" } } }).settings).logo?.file).toBe(
      "abababababababab.jpg",
    );
  });
});

describe("who changes the look", () => {
  it("is the owner in person: the owner's AI and another system's key are refused", async () => {
    const { db, caps } = await setup();
    for (const caller of [ownerAi, zapier]) {
      await expect(caps.updateSettings(caller, { doc: { look: { theme: "dark" } } })).rejects.toMatchObject({
        code: "not_allowed",
        details: { reason: "owner_in_person" },
        fields: [{ path: "doc.look" }],
      });
      await expect(caps.updateSettings(caller, { doc: { look: { accent: "teal" } } })).rejects.toMatchObject({
        details: { reason: "owner_in_person" },
      });
    }
    expect((await readSettings(db)).look).toEqual(DEFAULT_SETTINGS.look);

    await caps.updateSettings(owner, { doc: { look: { theme: "warm" } } });
    await caps.updateSettings(owner, { doc: { look: { accent: "plum" } } });
    expect((await readSettings(db)).look).toEqual({ theme: "warm", accent: "plum", logo: null });
  });

  it("sends the look back as it was: nothing changed, nothing refused", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, { doc: { look: { theme: "minimal" } } });
    const view = await caps.getSettings(ownerAi);
    await expect(caps.updateSettings(ownerAi, { doc: { look: view.doc.look } })).resolves.toMatchObject({
      doc: { look: { theme: "minimal" } },
    });
  });

  it("never points the logo anywhere through the settings, whoever asks", async () => {
    const { db, caps } = await setup();
    for (const caller of [owner, ownerAi, zapier]) {
      await expect(caps.updateSettings(caller, { doc: { look: { logo: LOGO } } })).rejects.toMatchObject({
        code: expect.stringMatching(/^(invalid_input|not_allowed)$/),
      });
    }
    await expect(caps.updateSettings(owner, { doc: { look: { logo: LOGO } } })).rejects.toMatchObject({
      code: "invalid_input",
      fields: [{ path: "doc.look.logo", message: "the logo changes by uploading it (Settings → Look)" }],
    });
    expect((await readSettings(db)).look.logo).toBeNull();
  });
});
