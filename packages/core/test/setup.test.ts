import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { summarizeRule } from "../src/rules/describe";
import { PRESETS } from "../src/rules/presets";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import type { Caller } from "../src/write/index";
import { WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");
const owner: Caller = {
  actor: { kind: "owner", id: "owner", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const customer: Caller = {
  actor: { kind: "customer_human", id: "web:1", channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};

async function setup(): Promise<{ db: Db; caps: Capabilities }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

describe("setup: profile, services, products", () => {
  it("creates the profile, refuses a bad time zone, and keeps languages on the business row", async () => {
    const { caps } = await setup();
    await expect(caps.setup.updateProfile(owner, { timezone: "Mars/Olympus" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const p = await caps.setup.updateProfile(owner, {
      name: "Surfing Dog",
      timezone: "Europe/Lisbon",
      languages: ["pt", "en"],
      domain: "inbox.surfingdog.ai",
    });
    expect(p).toMatchObject({
      name: "Surfing Dog",
      timezone: "Europe/Lisbon",
      currency: "EUR",
      languages: ["pt", "en"],
      domain: "inbox.surfingdog.ai",
    });
    const again = await caps.setup.updateProfile(owner, { currency: "usd" as "USD" });
    expect(again).toMatchObject({ name: "Surfing Dog", currency: "USD", languages: ["pt", "en"] });
    expect((await caps.getBusinessProfile()).languages).toEqual(["pt", "en"]);
    await expect(caps.setup.getProfile(customer)).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("manages services and products; archived ones vanish from the public lists", async () => {
    const { caps } = await setup();
    const svc = await caps.setup.createService(owner, {
      name: "Intro call",
      duration_min: 30,
      capacity: 1,
      granularity_min: 15,
      active: true,
      sort: 1,
      buffer_before_min: 0,
      buffer_after_min: 0,
    });
    expect(svc).toMatchObject({ name: "Intro call", durationMin: 30, active: 1 });
    const updated = await caps.setup.updateService(owner, {
      service_id: svc.id,
      duration_min: 45,
      price: { model: "fixed", value: 9000, currency: "EUR" },
    });
    expect(updated).toMatchObject({ durationMin: 45, price: { model: "fixed", value: 9000, currency: "EUR" } });
    await expect(caps.setup.updateService(owner, { service_id: "nope", name: "x" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect((await caps.listServices({ limit: 50 })).items.map((s) => s.id)).toEqual([svc.id]);
    await caps.setup.archiveService(owner, { service_id: svc.id });
    expect((await caps.listServices({ limit: 50 })).items).toEqual([]);
    expect((await caps.setup.listServices(owner)).map((s) => [s.id, s.active])).toEqual([[svc.id, 0]]);

    const prod = await caps.setup.createProduct(owner, {
      sku: "T-1",
      name: "T-shirt",
      price: { value: 2500, currency: "EUR" },
      stock: 3,
      active: true,
    });
    await expect(
      caps.setup.createProduct(owner, { sku: "T-1", name: "Dup", price: { value: 1, currency: "EUR" }, active: true }),
    ).rejects.toMatchObject({ code: "invalid_input", fields: [{ path: "sku" }] });
    await caps.setup.updateProduct(owner, { product_id: prod.id, stock: null });
    expect((await caps.setup.listProducts(owner))[0]).toMatchObject({ sku: "T-1", stock: null });
  });
});

describe("setup: availability", () => {
  it("sets weekly hours and closed days that the slot search honours", async () => {
    const { caps } = await setup();
    await caps.setup.updateProfile(owner, { timezone: "Europe/Lisbon" });
    const svc = await caps.setup.createService(owner, {
      name: "Full service",
      duration_min: 60,
      capacity: 1,
      granularity_min: 60,
      active: true,
      sort: 0,
      buffer_before_min: 0,
      buffer_after_min: 0,
    });
    const a = await caps.setup.setWeekly(owner, { weekly: { mon: [["09:00", "12:00"]], tue: [["09:00", "12:00"]] } });
    expect(a.weekly).toEqual({ mon: [["09:00", "12:00"]], tue: [["09:00", "12:00"]] });
    // Monday 5 Oct and Tuesday 6 Oct 2026: three one-hour slots each before the closure.
    const before = await caps.checkAvailability({
      service_id: svc.id,
      from: "2026-10-05T00:00:00Z",
      to: "2026-10-07T00:00:00Z",
    });
    expect(before.slots.map((s) => s.startTime)).toEqual([
      "2026-10-05T08:00:00.000Z",
      "2026-10-05T09:00:00.000Z",
      "2026-10-05T10:00:00.000Z",
      "2026-10-06T08:00:00.000Z",
      "2026-10-06T09:00:00.000Z",
      "2026-10-06T10:00:00.000Z",
    ]);
    const closed = await caps.setup.setClosures(owner, {
      closures: [{ from: "2026-10-05", to: "2026-10-05", reason: "Republic Day" }],
    });
    expect(closed.closures).toEqual([{ from: "2026-10-05", to: "2026-10-05", reason: "Republic Day" }]);
    const after = await caps.checkAvailability({
      service_id: svc.id,
      from: "2026-10-05T00:00:00Z",
      to: "2026-10-07T00:00:00Z",
    });
    expect(after.slots.map((s) => s.startTime)).toEqual([
      "2026-10-06T08:00:00.000Z",
      "2026-10-06T09:00:00.000Z",
      "2026-10-06T10:00:00.000Z",
    ]);
    await expect(caps.setup.setWeekly(owner, { weekly: {}, service_id: "nope" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const override = await caps.setup.setWeekly(owner, { weekly: { sat: [["10:00", "13:00"]] }, service_id: svc.id });
    expect(override.overrides).toEqual([{ service_id: svc.id, weekly: { sat: [["10:00", "13:00"]] } }]);
  });
});

describe("setup: rules", () => {
  it("applies presets, edits with optimistic versions, summarises in words and tests against a real item", async () => {
    const { caps } = await setup();
    await caps.setup.updateProfile(owner, { timezone: "Europe/Lisbon" });
    const svc = await caps.setup.createService(owner, {
      name: "Full service",
      duration_min: 60,
      capacity: 1,
      granularity_min: 60,
      active: true,
      sort: 0,
      buffer_before_min: 0,
      buffer_after_min: 0,
    });
    const presets = caps.setup.listPresets(owner);
    expect(presets.map((p) => p.key)).toEqual(["appointments", "trades", "shop"]);
    expect(presets[0]?.rules[0]?.summary).toBe(
      "When a new item arrives and it is a booking and it is not a test and (the total is under 50.00 or there is no a total) and the slot is free and it is inside opening hours: confirm it. Stop there.",
    );
    const applied = await caps.setup.applyPreset(owner, { preset: "appointments", replace: false });
    expect(applied.map((r) => r.name)).toEqual((PRESETS.appointments ?? []).map((r) => r.name));

    const custom = await caps.setup.createRule(owner, {
      name: "Flag big quotes",
      priority: 50,
      enabled: true,
      definition: {
        on: ["item.created"],
        if: { path: "item.type", op: "eq", value: "quote_request" },
        actions: [{ action: "set_flags", needsHuman: true, priority: 2 }],
        stop: false,
        maxRunsPerItem: 1,
      },
    });
    expect(custom.summary).toBe(
      "When a new item arrives and it is a quote request: flag it for a person and set priority 2.",
    );
    const edited = await caps.setup.updateRule(owner, { rule_id: custom.id, enabled: false, expected_version: 1 });
    expect(edited).toMatchObject({ enabled: false, version: 2 });
    await expect(
      caps.setup.updateRule(owner, { rule_id: custom.id, name: "x", expected_version: 1 }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect((await caps.setup.listRules(owner)).map((r) => r.name)).toEqual([
      "Auto-confirm small bookings when the slot is free",
      "Flag big quotes",
      "Ask a person about anything else",
    ]);

    const booking = (await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc.id, name: "Full service" },
        startTime: "2026-10-05T09:00:00.000Z",
        endTime: "2026-10-05T10:00:00.000Z",
        partySize: 1,
      },
      contact: { email: "rita@example.com" },
    })) as { view: { item: { id: string } } };
    const test = await caps.setup.testRule(owner, {
      definition: (PRESETS.appointments ?? [])[0]?.definition as never,
      item_id: booking.view.item.id,
    });
    expect(test).toMatchObject({
      matched: true,
      would: ["confirm it"],
      facts: { slotIsFree: true, withinBusinessHours: true },
    });
    const miss = await caps.setup.testRule(owner, { definition: custom.definition, item_id: booking.view.item.id });
    expect(miss).toMatchObject({ matched: false, would: [] });

    await caps.setup.deleteRule(owner, { rule_id: custom.id });
    await expect(caps.setup.deleteRule(owner, { rule_id: custom.id })).rejects.toBeInstanceOf(WriteError);
    expect(
      summarizeRule({
        on: ["item.transitioned:confirm"],
        if: { fn: "party_verified" },
        actions: [{ action: "reply", template: "See you then!", internal: false }],
        stop: false,
        maxRunsPerItem: 1,
      }),
    ).toBe('When an item is confirmed and the sender is verified: reply "See you then!".');
  });
});
