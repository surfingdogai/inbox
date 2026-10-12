import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import type { SetupPlanInput } from "../src/capabilities/plan";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { PRESETS } from "../src/rules/presets";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { readSettings } from "../src/settings/schema";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * A setup plan (`capabilities/plan.ts`): a salon's details as a check read them and its owner checked
 * them, applied in one go. A dry run says what applying would do and writes nothing; applying does
 * exactly that; applying again changes nothing. Prices go in only when the owner confirmed them, a
 * plan never holds products or legal details, and only the owner or the inbox itself applies one.
 */
const T0 = Date.parse("2026-10-12T10:00:00Z");
const system: Caller = {
  actor: { kind: "system", id: "apply-plan", channel: "system" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const owner: Caller = {
  actor: { kind: "owner", id: "owner", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const ownerAi: Caller = {
  actor: { kind: "owner_ai", id: "claude", channel: "mcp_owner" },
  actsAs: "owner",
  principal: { via: "oauth", id: "claude", name: "Claude", scopes: ["setup:run"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const integration: Caller = {
  actor: { kind: "integration", id: "k1", channel: "rest" },
  actsAs: "owner",
  principal: { via: "api_key", id: "k1", name: "Zapier", scopes: ["*"], userId: null, keyKind: "integration" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup(): Promise<{ db: Db; caps: Capabilities }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

const READ = "2026-10-11T09:30:00Z";
/** A salon whose site gave its name and a description, and nothing else: the owner picked hours and typed one service. */
const salon: SetupPlanInput = {
  profile: { name: "Salão Rosa", timezone: "Europe/Lisbon", currency: "EUR", languages: ["pt", "en"] },
  directory: { listed: false, url: "", description: "Cortes e cor no Porto." },
  hours: {
    mon: [["09:00", "18:00"]],
    tue: [["09:00", "18:00"]],
    wed: [["09:00", "18:00"]],
    thu: [["09:00", "18:00"]],
    fri: [["09:00", "18:00"]],
    sat: [["09:00", "14:00"]],
  },
  services: [{ name: "Corte", duration_min: 30 }],
  preset: "appointments",
  booking: { confirm: "owner" },
  doors: ["message", "quote_request", "booking"],
  sources: {
    "profile.name": { source_url: "https://www.salaorosa.pt/", checked_at: READ, confidence: "declared" },
    "directory.description": { source_url: "https://www.salaorosa.pt/sobre", checked_at: READ, confidence: "read" },
  },
};

describe("a setup plan", () => {
  // The first database a file opens in workerd takes a while to load the runtime's modules.
  it("says what it would do and writes nothing, then does exactly that, then nothing the second time", {
    timeout: 60_000,
  }, async () => {
    const { db, caps } = await setup();
    const dry = await caps.applySetupPlan(owner, salon, { dryRun: true });
    expect(dry).toMatchObject({ dry_run: true, changed: true });
    expect(dry.sentences).toEqual([
      "Read from salaorosa.pt on 11 Oct 2026.",
      "Names the business Salão Rosa.",
      "Sets the time zone to Europe/Lisbon.",
      "Sets the languages to Portuguese and English.",
      "Adds the service Corte: 30 minutes, price on request.",
      "Sets the opening hours: Mon–Fri 09:00–18:00, Sat 09:00–14:00.",
      expect.stringMatching(/^Applies the appointments rules: /),
      "Keeps the business out of every network's directory until you choose to be listed.",
      "Sets the public description: “Cortes e cor no Porto.” (please check).",
      "Keeps a note of where each detail was read.",
      "Agents can see your free times and ask to book, ask you for a price or send you a message.",
      "You confirm each booking.",
    ]);
    expect(dry.doors).toEqual({ on: ["message", "quote_request", "booking"], expected: dry.doors.on, missing: [] });
    // Nothing was written.
    expect(await caps.setup.listServices(owner)).toEqual([]);
    expect(await caps.setup.listRules(owner)).toEqual([]);
    expect((await caps.getBusinessProfile()).item_types).toEqual(["message"]);

    const applied = await caps.applySetupPlan(system, salon);
    expect(applied).toMatchObject({ dry_run: false, changed: true, sentences: dry.sentences });
    // What the dry run worked out is what the inbox now offers.
    expect(applied.doors).toEqual(dry.doors);
    expect((await caps.getBusinessProfile()).item_types).toEqual(["message", "quote_request", "booking"]);
    const services = await caps.setup.listServices(owner);
    expect(services.map((s) => [s.name, s.durationMin, s.price, s.active])).toEqual([["Corte", 30, null, 1]]);
    expect((await caps.setup.getProfile(owner)).languages).toEqual(["pt", "en"]);
    const settings = await readSettings(db);
    expect(settings.directory).toMatchObject({ listed: false, url: "", description: "Cortes e cor no Porto." });
    expect(Object.keys(settings.setup.sources).sort()).toEqual(["directory.description", "profile.name"]);
    // The owner confirms each booking: the preset without the rules that would on their own.
    const rules = await caps.setup.listRules(owner);
    const preset = PRESETS.appointments ?? [];
    expect(rules.map((r) => r.name).sort()).toEqual(
      preset
        .filter((r) => !r.definition.actions.some((a) => a.action === "transition"))
        .map((r) => r.name)
        .sort(),
    );
    expect(rules.length).toBeLessThan(preset.length);
    // Slots on a Monday in Lisbon, from the hours the plan set.
    const slots = await caps.checkAvailability(
      { service_id: services[0]?.id as string, from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z" },
      { now: T0 },
    );
    expect(slots.slots.length).toBeGreaterThan(0);

    const again = await caps.applySetupPlan(system, salon);
    expect(again.changed).toBe(false);
    expect(again.sentences).toContain("Nothing to change: the inbox already matches this plan.");
    expect(await caps.setup.listServices(owner)).toHaveLength(1);
    expect(await caps.setup.listRules(owner)).toHaveLength(rules.length);
  });

  it("puts a price in only when the owner confirmed it, and never takes products, feeds or legal details", async () => {
    const { caps } = await setup();
    const r = await caps.applySetupPlan(system, {
      services: [
        { name: "Corte", duration_min: 30, price: { model: "fixed", value: 1800 } },
        { name: "Cor", duration_min: 90, price: { model: "fixed", value: 4500 }, price_confirmed: true },
        { name: "Noivas", price: { model: "quote" } },
      ],
    });
    expect(r.sentences).toEqual(
      expect.arrayContaining([
        "Adds the service Corte: 30 minutes, price on request.",
        "Adds the service Cor: 90 minutes, €45.00.",
        "Adds the service Noivas: 60 minutes, priced by quote.",
        "Corte's price is left out until you confirm it.",
      ]),
    );
    const prices = Object.fromEntries((await caps.setup.listServices(owner)).map((s) => [s.name, s.price]));
    expect(prices).toEqual({ Corte: null, Cor: { model: "fixed", value: 4500 }, Noivas: { model: "quote" } });
    // A price the owner did not confirm never replaces the one they set.
    const later = await caps.applySetupPlan(system, {
      services: [{ name: "cor", duration_min: 90, price: { model: "fixed", value: 100 } }],
    });
    expect(later.changed).toBe(false);
    expect((await caps.setup.listServices(owner)).find((s) => s.name === "Cor")?.price).toEqual({
      model: "fixed",
      value: 4500,
    });

    for (const [field, value] of [
      ["products", [{ name: "Champô", price: { value: 900, currency: "EUR" } }]],
      ["feeds", [{ url: "https://shop.example.com/feed.xml" }]],
      ["commerce", { legal: { legalName: "Rosa Lda" } }],
    ] as const) {
      await expect(caps.applySetupPlan(system, { [field]: value } as SetupPlanInput)).rejects.toMatchObject({
        code: "invalid_input",
        fields: [{ path: `plan.${field}`, message: expect.stringContaining("never holds") }],
      });
    }
    await expect(caps.applySetupPlan(system, { website: "x" } as SetupPlanInput)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("is the owner's or the inbox's own to apply: the owner's AI and a key may only see what it would do", async () => {
    const { caps } = await setup();
    const plan: SetupPlanInput = { services: [{ name: "Corte", duration_min: 30 }] };
    for (const caller of [ownerAi, integration]) {
      expect((await caps.applySetupPlan(caller, plan, { dryRun: true })).changed).toBe(true);
      await expect(caps.applySetupPlan(caller, plan)).rejects.toMatchObject({
        code: "not_allowed",
        details: { ask_owner: true },
      });
    }
    expect(await caps.setup.listServices(owner)).toEqual([]);
    expect((await caps.applySetupPlan(owner, plan)).changed).toBe(true);
    expect(await caps.setup.listServices(owner)).toHaveLength(1);
  });

  it("matches services by name, brings an archived one back, and leaves the owner's other rules alone", async () => {
    const { caps } = await setup();
    const own = await caps.setup.createRule(owner, {
      name: "Weddings go to Rosa",
      priority: 50,
      enabled: true,
      definition: {
        on: ["item.created"],
        if: { fn: "text_has_keywords", args: { keywords: ["noiva"] } },
        actions: [{ action: "set_flags", priority: 3 }],
        stop: false,
        maxRunsPerItem: 1,
      },
    });
    const svc = await caps.setup.createService(owner, {
      name: "Corte",
      duration_min: 45,
      buffer_before_min: 0,
      buffer_after_min: 0,
      capacity: 1,
      granularity_min: 15,
      active: true,
      sort: 0,
    });
    await caps.setup.archiveService(owner, { service_id: svc.id });
    // The preset's own rules, saying yes on their own: applied once by the owner, before the plan.
    await caps.setup.applyPreset(owner, { preset: "appointments", replace: false, confirm: "rules" });
    const r = await caps.applySetupPlan(system, {
      services: [{ name: "  CORTE ", duration_min: 30 }],
      preset: "appointments",
    });
    expect(r.sentences).toContain("Changes the service Corte: 30 minutes (was 45 minutes), on offer again.");
    // A length the plan leaves out is the service's own.
    expect((await caps.applySetupPlan(system, { services: [{ name: "Corte" }] })).changed).toBe(false);
    const services = await caps.setup.listServices(owner);
    expect(services.map((s) => [s.id, s.durationMin, s.active])).toEqual([[svc.id, 30, 1]]);
    const names = (await caps.setup.listRules(owner)).map((r) => r.name);
    expect(names).toContain(own.name);
    // One copy of each, and none that confirms a booking on its own.
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("Auto-confirm small bookings when the slot is free");
    // Saying yes by rule again replaces the set once more, still one copy of each.
    await caps.applySetupPlan(system, { preset: "appointments", booking: { confirm: "rules" } });
    const after = (await caps.setup.listRules(owner)).map((r) => r.name);
    expect(after).toHaveLength((PRESETS.appointments ?? []).length + 1);
    expect(after).toContain("Auto-confirm small bookings when the slot is free");
  });

  it("says which doors it expects stay shut and what opens them", async () => {
    const { caps } = await setup();
    const hoursOnly: SetupPlanInput = { hours: { mon: [["09:00", "18:00"]] }, doors: ["message", "booking"] };
    const dry = await caps.applySetupPlan(owner, hoursOnly, { dryRun: true });
    expect(dry.doors).toEqual({
      on: ["message"],
      expected: ["message", "booking"],
      missing: [{ door: "booking", why: "Booking turns on once there is a service to book." }],
    });
    expect(dry.sentences.at(-1)).toBe("Booking turns on once there is a service to book.");
    expect((await caps.applySetupPlan(system, hoursOnly)).doors).toEqual(dry.doors);
    const both = await caps.applySetupPlan(
      owner,
      { services: [{ name: "Corte" }], hours: {}, doors: ["booking"] },
      { dryRun: true },
    );
    expect(both.doors.missing).toEqual([{ door: "booking", why: "Booking turns on once there are opening hours." }]);
  });

  it("keeps bookings at a booking platform: booking stays shut, quotes and messages stay here", async () => {
    const { db, caps } = await setup();
    const BOOKING = "https://booking.example.com/salao-rosa";
    const plan: SetupPlanInput = {
      ...salon,
      doors: ["message", "quote_request"],
      doors_elsewhere: [{ door: "booking", url: BOOKING, name: "Booking Example" }],
    };
    const dry = await caps.applySetupPlan(owner, plan, { dryRun: true });
    expect(dry.sentences).toContain("Bookings stay at Booking Example.");
    expect(dry.doors.on).toEqual(["message", "quote_request"]);
    expect((await readSettings(db)).doorsElsewhere).toEqual([]);

    const applied = await caps.applySetupPlan(system, plan);
    expect(applied.doors).toEqual(dry.doors);
    expect((await readSettings(db)).doorsElsewhere).toEqual([{ itemType: "booking", url: BOOKING }]);
    expect((await caps.applySetupPlan(system, plan)).changed).toBe(false);
    // Expected anyway, it says where agents go instead.
    const expecting = await caps.applySetupPlan(owner, { ...plan, doors: ["booking"] }, { dryRun: true });
    expect(expecting.doors.missing).toEqual([
      { door: "booking", why: "Bookings stay at Booking Example, so agents are sent there." },
    ]);

    // An empty list brings bookings back to the inbox.
    const back = await caps.applySetupPlan(system, { doors_elsewhere: [] });
    expect(back.sentences).toContain("Bookings come to this inbox again.");
    expect(back.doors.on).toContain("booking");
    expect((await readSettings(db)).doorsElsewhere).toEqual([]);
  });

  it("keeps a shop's orders in its own checkout, and says so", async () => {
    const { db, caps } = await setup();
    const CHECKOUT = "https://shop.example.com/";
    const r = await caps.applySetupPlan(system, {
      profile: { name: "Maré Surf Shop" },
      preset: "shop",
      doors: ["message"],
      doors_elsewhere: [{ door: "order", url: CHECKOUT }],
    });
    expect(r.sentences).toContain("Orders stay in your own checkout.");
    expect(r.doors.on).not.toContain("order");
    expect((await readSettings(db)).doorsElsewhere).toEqual([{ itemType: "order", url: CHECKOUT }]);
  });

  it("refuses a door kept elsewhere that is not a booking or an order, or not on a public host, and a time zone it does not know", async () => {
    const { caps } = await setup();
    await expect(
      caps.applySetupPlan(system, {
        doors_elsewhere: [{ door: "quote_request" as "booking", url: "https://booking.example.com/salao-rosa" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      caps.applySetupPlan(system, { doors_elsewhere: [{ door: "booking", url: "https://localhost/book" }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      caps.applySetupPlan(system, {
        doors_elsewhere: [
          { door: "booking", url: "https://booking.example.com/a" },
          { door: "booking", url: "https://booking.example.com/b" },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(caps.applySetupPlan(system, { profile: { timezone: "Mars/Olympus" } })).rejects.toMatchObject({
      code: "invalid_input",
      fields: [{ path: "plan.profile.timezone" }],
    });
  });
});
