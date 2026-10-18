import { runMigrations } from "@surfingdog/platform";
import {
  MANIFEST_PATH,
  manifestSchema,
  PAYMENT_TOKENS,
  paymentLabel,
  paymentToken,
  profileSchema,
} from "@surfingdog/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { directoryProfile } from "../src/capabilities/directory";
import { frontHome, payLine } from "../src/capabilities/front";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { buildManifest } from "../src/manifest";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { readSettings, settingsSchema } from "../src/settings/schema";
import type { Caller, Principal } from "../src/write/index";
import { WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * How a business is paid (Settings → Payments): the tokens the owner ticks, kept only when they are the
 * vocabulary's, published in the manifest's profile so an agent knows before it pays, and changed only by the
 * owner in person. Node and workerd.
 */
const T0 = Date.parse("2026-10-18T10:00:00Z");
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
/** The inbox itself, as a hosted setup applies a plan. */
const system: Caller = {
  actor: { kind: "system", id: "apply-plan", channel: "system" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
/** The owner's AI over OAuth, holding every settings scope. */
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

describe("the payments vocabulary, as an inbox reads it", () => {
  it("names every token, and reads what a business writes", () => {
    for (const t of PAYMENT_TOKENS) expect(paymentLabel(t), t).not.toBe("");
    expect(paymentLabel("apple_pay")).toBe("Apple Pay");
    expect(paymentLabel("stripe_link")).toBe("Stripe Link");
    expect(paymentToken("Apple Pay")).toBe("apple_pay");
    expect(paymentToken("Transferência bancária")).toBe("bank_transfer");
    expect(paymentToken("SEPA Direct Debit")).toBe("sepa");
    expect(paymentToken("card")).toBe("card");
    expect(paymentToken("a cheque")).toBeNull();
  });
});

describe("Settings → Payments", () => {
  it("is empty out of the box, and publishes nothing", async () => {
    const { db } = await setup();
    expect((await readSettings(db)).payments.accepted).toEqual([]);
    expect(settingsSchema.parse({}).payments).toEqual({ accepted: [] });
  });

  it("keeps the tokens the owner ticks, and refuses anything else", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { payments: { accepted: ["card", "mb_way", "apple_pay"] } } });
    expect((await readSettings(db)).payments.accepted).toEqual(["card", "mb_way", "apple_pay"]);
    for (const accepted of [["card", "card"], ["Apple Pay"], ["cheques"], Array(25).fill("card")]) {
      const e = await refusal(caps.updateSettings(owner, { doc: { payments: { accepted } } }));
      expect(e.code, JSON.stringify(accepted)).toBe("invalid_input");
    }
    expect((await readSettings(db)).payments.accepted).toEqual(["card", "mb_way", "apple_pay"]);
    // Every way the vocabulary names fits at once: the chooser can never offer more than the settings keep.
    await caps.updateSettings(owner, { doc: { payments: { accepted: [...PAYMENT_TOKENS] } } });
    expect((await readSettings(db)).payments.accepted).toHaveLength(PAYMENT_TOKENS.length);
  });

  it("is never the owner's AI's to change: a customer's message could ask it to declare a way to pay", async () => {
    const { db, caps } = await setup();
    const e = await refusal(caps.updateSettings(ownersAi, { doc: { payments: { accepted: ["crypto"] } } }));
    expect(e.code).toBe("not_allowed");
    expect(e.details).toMatchObject({ reason: "owner_in_person", ask_owner: true });
    expect((await readSettings(db)).payments.accepted).toEqual([]);
  });

  it("is published in the manifest's profile, in the vocabulary's order, so an agent knows before it pays", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, {
      doc: { business: { name: "Harbour Coffee" }, payments: { accepted: ["apple_pay", "x402", "card"] } },
    });
    const settings = await readSettings(db);
    const profile = await directoryProfile(db, {
      name: settings.business.name,
      languages: settings.business.languages,
      timezone: settings.business.timezone,
      directory: settings.directory,
      payments: settings.payments.accepted,
      now: T0,
    });
    expect(profile?.payments).toEqual(["card", "apple_pay", "x402"]);
    expect(profileSchema.safeParse(profile).success).toBe(true);
    const manifest = buildManifest({ instanceUrl: "https://inbox.example.com", profile });
    expect(manifestSchema.parse(manifest).profile?.payments).toEqual(["card", "apple_pay", "x402"]);
    expect(MANIFEST_PATH).toBe("/.well-known/agent-inbox.json");
    // None ticked: no payments member at all.
    const none = await directoryProfile(db, {
      name: "Harbour Coffee",
      languages: ["en"],
      timezone: "UTC",
      directory: settings.directory,
      payments: [],
      now: T0,
    });
    expect(none && "payments" in none).toBe(false);
    // A card brand says a card.
    const brands = await directoryProfile(db, {
      name: "Harbour Coffee",
      languages: ["en"],
      timezone: "UTC",
      directory: settings.directory,
      payments: ["mb_way", "visa"],
      now: T0,
    });
    expect(brands?.payments).toEqual(["card", "visa", "mb_way"]);
  });

  it("is in the business's profile for agents, and one quiet line on its own page, in the visitor's language", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, {
      doc: {
        business: { name: "Harbour Coffee" },
        payments: { accepted: ["mastercard", "visa", "mb_way", "apple_pay", "x402"] },
      },
    });
    expect((await caps.getBusinessProfile()).payments).toEqual([
      "card",
      "visa",
      "mastercard",
      "mb_way",
      "apple_pay",
      "x402",
    ]);
    expect((await frontHome(caps, "en")).help).toBe("We take card (Visa, Mastercard), MB WAY and Apple Pay.");
    expect((await frontHome(caps, "pt")).help).toBe("Aceitamos cartão (Visa, Mastercard), MB WAY e Apple Pay.");
    expect(payLine(["cash", "bank_transfer"], "en")).toBe("We take cash and bank transfer.");
    expect(payLine(["pix"], "pt")).toBe("Aceitamos Pix.");
    // An agent's own way to pay is never on a person's page; none ticked, no line.
    expect(payLine(["x402", "ucp_handlers"], "en")).toBe("");
    expect(payLine(undefined, "en")).toBe("");
    await caps.updateSettings(owner, { doc: { payments: { accepted: [] } } });
    expect((await caps.getBusinessProfile()).payments).toBeUndefined();
    expect((await frontHome(caps, "en")).help).toBe("");
  });
});

describe("a setup plan's payments", () => {
  const read = {
    source_url: "https://harbour.example/",
    checked_at: "2026-10-18T09:00:00Z",
    confidence: "read" as const,
  };

  it("fill in the ways the website showed, for the owner to untick, with where they were read", async () => {
    const { db, caps } = await setup();
    const plan = { payments: { accepted: ["apple_pay", "card", "mb_way"] }, sources: { payments: read } };
    const dry = await caps.applySetupPlan(owner, plan, { dryRun: true });
    expect(dry.sentences.join(" ")).toContain(
      "Shows the ways to pay read on your site: Card, MB WAY, Apple Pay (please check).",
    );
    expect((await readSettings(db)).payments.accepted).toEqual([]);
    const applied = await caps.applySetupPlan(system, plan);
    expect(applied.changed).toBe(true);
    const settings = await readSettings(db);
    expect(settings.payments.accepted).toEqual(["card", "mb_way", "apple_pay"]);
    expect(settings.setup.sources.payments?.confidence).toBe("read");
    // Applied again, nothing changes.
    expect((await caps.applySetupPlan(system, plan)).changed).toBe(false);
  });

  it("never ticks an agent's own way to pay, nor is applied by the owner's AI", async () => {
    const { caps } = await setup();
    await expect(caps.applySetupPlan(system, { payments: { accepted: ["x402"] } })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(caps.applySetupPlan(ownersAi, { payments: { accepted: ["card"] } })).rejects.toMatchObject({
      code: "not_allowed",
    });
  });
});
