import { runMigrations } from "@surfingdog/platform";
import { profileHoursSchema } from "@surfingdog/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { findSlots } from "../src/capabilities/availability";
import { offeredItemTypes } from "../src/capabilities/directory";
import { Capabilities } from "../src/capabilities/service";
import {
  productInput,
  profileInput,
  serviceInput,
  updateServiceInput,
  weeklySchema,
} from "../src/capabilities/setup-types";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { hostPolicyFor } from "../src/settings/policy";
import { readSettings } from "../src/settings/schema";
import { canonicalLanguages, currencyProblem, isHundredthsCurrency } from "../src/util/locale";
import type { Caller } from "../src/write/index";
import { WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * What the owner sets in Settings, as the server holds it: the switches for what agents can do,
 * opening hours that run to midnight (open all the time), currencies counted in hundredths, language
 * tags kept canonical, a service with no price, and what a read says the owner has not set yet.
 * Node and workerd.
 */
const T0 = Date.parse("2026-10-14T10:00:00Z"); // a Wednesday
const owner: Caller = {
  actor: { kind: "owner", id: "owner", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const system: Caller = {
  actor: { kind: "system", id: "apply-plan", channel: "system" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const ownerAi: Caller = {
  actor: { kind: "owner_ai", id: "claude", channel: "mcp_owner" },
  actsAs: "owner",
  principal: { via: "oauth", id: "claude", name: "Claude", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const agent: Caller = {
  actor: { kind: "customer_agent", id: "agent:test", channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};
/** A person on the business's own page: not an agent. */
const visitor: Caller = {
  actor: { kind: "customer_human", id: "anon:page", channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};

async function setup(opts: { policy?: Parameters<typeof hostPolicyFor>[0] } = {}): Promise<{
  db: Db;
  caps: Capabilities;
}> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const caps = new Capabilities(db);
  if (opts.policy) caps.attachPolicy(hostPolicyFor(opts.policy));
  return { db, caps };
}

// A database's first migration takes seconds in workerd: done once here, before any test is timed.
beforeAll(async () => {
  await setup();
}, 60_000);

async function refusal(write: Promise<unknown>): Promise<WriteError> {
  const error = await write.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WriteError);
  return error as WriteError;
}

const ALL_DAY: [string, string][] = [["00:00", "24:00"]];
const ALWAYS = {
  mon: ALL_DAY,
  tue: ALL_DAY,
  wed: ALL_DAY,
  thu: ALL_DAY,
  fri: ALL_DAY,
  sat: ALL_DAY,
  sun: ALL_DAY,
};

describe("what agents can do (settings.doors)", () => {
  it("left out, each door follows what the inbox holds, as before", async () => {
    const { db, caps } = await setup();
    expect(await offeredItemTypes(db)).toEqual(["message"]);
    expect((await readSettings(db)).doors).toEqual({});
    await caps.setup.createService(owner, serviceInput.parse({ name: "Haircut", duration_min: 30 }));
    await caps.setup.setWeekly(owner, { weekly: { mon: [["09:00", "18:00"]] } });
    expect((await caps.getBusinessProfile()).item_types).toEqual(["message", "quote_request", "booking"]);
  });

  it("asking for a price opens with nothing listed, and false shuts any door whatever the inbox holds", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, { doc: { doors: { quoteRequest: true } } });
    expect((await caps.getBusinessProfile()).item_types).toEqual(["message", "quote_request"]);

    await caps.setup.createService(owner, serviceInput.parse({ name: "Haircut", duration_min: 30 }));
    await caps.setup.setWeekly(owner, { weekly: { mon: [["09:00", "18:00"]] } });
    await caps.updateSettings(owner, { doc: { doors: { booking: false, message: false } } });
    expect((await caps.getBusinessProfile()).item_types).toEqual(["quote_request"]);

    // null takes the switch away: the door follows what the inbox holds again.
    await caps.updateSettings(owner, { doc: { doors: { booking: null, message: null } } });
    expect((await caps.getBusinessProfile()).item_types).toEqual(["message", "quote_request", "booking"]);
  });

  it("refuses an agent at a door the owner shut, and leaves people on the business's own page alone", async () => {
    const { caps } = await setup();
    const svc = await caps.setup.createService(owner, serviceInput.parse({ name: "Haircut", duration_min: 30 }));
    await caps.setup.setWeekly(owner, { weekly: { thu: [["09:00", "18:00"]] } });
    await caps.updateSettings(owner, { doc: { doors: { booking: false, quoteRequest: false, message: false } } });
    const booking = {
      payload: {
        reservationFor: { serviceId: svc.id, name: "Haircut" },
        startTime: "2026-10-15T10:00:00Z",
        endTime: "2026-10-15T10:30:00Z",
      },
      contact: { name: "Rita", email: "rita@example.com" },
    };
    for (const [kind, write] of [
      ["booking", () => caps.createBooking(agent, booking)],
      [
        "quote_request",
        () =>
          caps.requestQuote(agent, {
            payload: { itemOffered: { name: "A fringe" }, description: "Shorter, please" },
            contact: { email: "rita@example.com" },
          }),
      ],
      ["message", () => caps.sendMessage(agent, { body: "Hello", contact: { email: "rita@example.com" } })],
    ] as const) {
      const e = await refusal(write());
      expect(e.code, kind).toBe("not_allowed");
      expect(e.details, kind).toMatchObject({ reason: "door_shut", item_type: kind });
      expect(e.message, kind).toContain("Nothing was written");
    }
    // A person writing on the page is not an agent: their message still comes in.
    const sent = await caps.sendMessage(visitor, {
      body: "Hello",
      contact: { name: "Rita", email: "rita@example.com" },
    });
    expect("view" in sent && sent.view.item.type).toBe("message");
  });

  it("are the owner's alone: the owner's AI may neither shut a door nor open one", async () => {
    const { db, caps } = await setup();
    const e = await refusal(caps.updateSettings(ownerAi, { doc: { doors: { booking: false } } }));
    expect(e.code).toBe("not_allowed");
    expect((await readSettings(db)).doors).toEqual({});
    await caps.updateSettings(owner, { doc: { doors: { message: false } } });
    await refusal(caps.updateSettings(ownerAi, { doc: { doors: { message: true } } }));
    expect((await readSettings(db)).doors).toEqual({ message: false });
  });

  it("a plan that expects asking for a price with nothing listed switches it on, and says so", async () => {
    const { caps } = await setup();
    const plan = {
      profile: { name: "Canalizações Lima", timezone: "Europe/Lisbon", currency: "EUR" },
      directory: { listed: false as const, url: "" as const },
      preset: "trades" as const,
      booking: { confirm: "owner" as const },
      doors: ["message", "quote_request"] as ("message" | "quote_request")[],
    };
    const dry = await caps.applySetupPlan(system, plan, { dryRun: true });
    expect(dry.doors).toEqual({
      on: ["message", "quote_request"],
      expected: ["message", "quote_request"],
      missing: [],
    });
    expect(dry.sentences).toContain("Lets agents ask you for a price, in their own words, before you list a service.");
    const done = await caps.applySetupPlan(system, plan);
    expect(done.doors.on).toEqual(dry.doors.on);
    expect((await caps.getBusinessProfile()).item_types).toEqual(["message", "quote_request"]);
    const again = await caps.applySetupPlan(system, plan);
    expect(again.changed).toBe(false);
  });

  it("a plan opens a door the owner shut only when it expects it, and the applied doors match the dry run", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { doors: { booking: false } } });
    const plan = {
      hours: { mon: [["09:00", "18:00"]] as [string, string][] },
      services: [{ name: "Haircut", duration_min: 30 }],
    };
    const quiet = await caps.applySetupPlan(owner, { ...plan, doors: ["message", "quote_request"] }, { dryRun: true });
    expect(quiet.doors.on).toEqual(["message", "quote_request"]);
    expect(quiet.sentences).not.toContain("Lets agents book again.");

    const expecting = {
      ...plan,
      doors: ["message", "quote_request", "booking"] as ("message" | "quote_request" | "booking")[],
    };
    const dry = await caps.applySetupPlan(owner, expecting, { dryRun: true });
    expect(dry.sentences).toContain("Lets agents book again.");
    expect(dry.doors).toMatchObject({ on: ["message", "quote_request", "booking"], missing: [] });
    const done = await caps.applySetupPlan(owner, expecting);
    expect(done.doors.on).toEqual(dry.doors.on);
    expect((await readSettings(db)).doors).toEqual({ booking: true });
  });
});

describe("opening hours that run to midnight", () => {
  it("take 24:00 as a closing time only, here and in the public profile", () => {
    expect(weeklySchema.safeParse(ALWAYS).success).toBe(true);
    expect(weeklySchema.safeParse({ fri: [["18:00", "24:00"]] }).success).toBe(true);
    for (const bad of [[["24:00", "25:00"]], [["24:00", "24:00"]], [["09:00", "24:01"]], [["18:00", "09:00"]]]) {
      expect(weeklySchema.safeParse({ mon: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(profileHoursSchema.safeParse({ timezone: "Europe/Lisbon", weekly: ALWAYS }).success).toBe(true);
    expect(
      profileHoursSchema.safeParse({ timezone: "Europe/Lisbon", weekly: { mon: [["24:00", "25:00"]] } }).success,
    ).toBe(false);
  });

  it("open all the time offers every slot of the day, the last one and the one across midnight included", async () => {
    const { db, caps } = await setup();
    await caps.setup.updateProfile(owner, { timezone: "UTC" });
    const svc = await caps.setup.createService(
      owner,
      serviceInput.parse({ name: "Locksmith call-out", duration_min: 60, granularity_min: 30 }),
    );
    await caps.setup.setWeekly(owner, { weekly: ALWAYS });
    const { slots } = await findSlots(db, {
      serviceId: svc.id,
      from: "2026-10-15T22:00:00Z",
      to: "2026-10-16T02:00:00Z",
      timezone: "UTC",
      now: T0,
      minNoticeMin: 0,
    });
    expect(slots.map((s) => s.startTime)).toEqual([
      "2026-10-15T22:00:00.000Z",
      "2026-10-15T22:30:00.000Z",
      "2026-10-15T23:00:00.000Z",
      "2026-10-15T23:30:00.000Z",
      "2026-10-16T00:00:00.000Z",
      "2026-10-16T00:30:00.000Z",
      "2026-10-16T01:00:00.000Z",
    ]);
  });

  it("never offers a slot across midnight into a day that opens later", async () => {
    const { db, caps } = await setup();
    await caps.setup.updateProfile(owner, { timezone: "UTC" });
    const svc = await caps.setup.createService(
      owner,
      serviceInput.parse({ name: "Late table", duration_min: 60, granularity_min: 30 }),
    );
    await caps.setup.setWeekly(owner, { weekly: { thu: [["18:00", "24:00"]], fri: [["09:00", "12:00"]] } });
    const { slots } = await findSlots(db, {
      serviceId: svc.id,
      from: "2026-10-15T22:00:00Z",
      to: "2026-10-16T10:00:00Z",
      timezone: "UTC",
      now: T0,
      minNoticeMin: 0,
    });
    expect(slots.map((s) => s.startTime)).toEqual([
      "2026-10-15T22:00:00.000Z",
      "2026-10-15T22:30:00.000Z",
      "2026-10-15T23:00:00.000Z",
      "2026-10-16T09:00:00.000Z",
    ]);
  });

  it("a plan says a day open 24 hours, and a week of them open all the time", async () => {
    const { caps } = await setup();
    const always = await caps.applySetupPlan(owner, { hours: ALWAYS }, { dryRun: true });
    expect(always.sentences).toContain("Sets the opening hours: open all the time.");
    const some = await caps.applySetupPlan(
      owner,
      { hours: { mon: ALL_DAY, tue: ALL_DAY, sat: [["10:00", "24:00"]] } },
      { dryRun: true },
    );
    expect(some.sentences).toContain("Sets the opening hours: Mon–Tue open 24 hours, Sat 10:00–24:00.");
  });

  it("a read says whether the business has saved hours, not only what bookings fall back to", async () => {
    const { caps } = await setup();
    const before = await caps.setup.getAvailability(owner);
    expect(before.weekly_set).toBe(false);
    await caps.setup.setWeekly(owner, { weekly: ALWAYS });
    const after = await caps.setup.getAvailability(owner);
    expect(after).toMatchObject({ weekly_set: true, weekly: ALWAYS });
  });
});

describe("currencies are counted in hundredths", () => {
  it("only an ISO 4217 code in hundredths is taken, for the profile, a service's price and a product's", () => {
    for (const ok of ["EUR", "USD", "GBP", "CHF", "BRL", "PLN", "HUF", "eur"]) {
      expect(profileInput.safeParse({ currency: ok }).success, ok).toBe(true);
    }
    for (const bad of ["JPY", "KRW", "ISK", "KWD", "BHD", "CLF", "XAU", "XXX", "ABC", "EURO", "€"]) {
      expect(profileInput.safeParse({ currency: bad }).success, bad).toBe(false);
      expect(
        serviceInput.safeParse({ name: "x", price: { model: "fixed", value: 100, currency: bad } }).success,
        bad,
      ).toBe(false);
      expect(productInput.safeParse({ name: "x", price: { value: 100, currency: bad } }).success, bad).toBe(false);
    }
    expect(profileInput.parse({ currency: " gbp " }).currency).toBe("GBP");
    expect(isHundredthsCurrency("EUR")).toBe(true);
    expect(currencyProblem("JPY")).toContain("hundredths");
    expect(currencyProblem("ABC")).toContain("not an ISO 4217");
  });
});

describe("languages", () => {
  it("are kept as canonical tags, once each, in the business's order", async () => {
    expect(canonicalLanguages(["PT-br", "en", "pt-BR", "zh-hant-tw"])).toEqual(["pt-BR", "en", "zh-Hant-TW"]);
    expect(canonicalLanguages(["english"])).toBeNull();
    expect(canonicalLanguages(["x-private"])).toBeNull();
    expect(profileInput.safeParse({ languages: ["es", "en-GB"] }).success).toBe(true);
    expect(profileInput.safeParse({ languages: ["Spanish"] }).success).toBe(false);
    const { caps } = await setup();
    const saved = await caps.setup.updateProfile(owner, { name: "Bar Sol", languages: ["ES", "en-gb", "es"] });
    expect(saved.languages).toEqual(["es", "en-GB"]);
  });
});

describe("a service priced on request", () => {
  it("is one whose price was taken off with null", async () => {
    const { caps } = await setup();
    const svc = await caps.setup.createService(
      owner,
      serviceInput.parse({ name: "Colour", duration_min: 90, price: { model: "fixed", value: 4500, currency: "EUR" } }),
    );
    expect(svc.price).toMatchObject({ value: 4500 });
    const input = updateServiceInput.parse({ service_id: svc.id, price: null });
    const after = await caps.setup.updateService(owner, input);
    expect(after.price).toBeNull();
    // Left out, a price stays as it is.
    const renamed = await caps.setup.updateService(owner, { service_id: svc.id, name: "Full colour" });
    expect(renamed.price).toBeNull();
  });
});

describe("the profile", () => {
  it("says whether the host holds the domain", async () => {
    const own = await setup();
    expect((await own.caps.setup.getProfile(owner)).domain_held).toBe(false);
    const hosted = await setup({ policy: { address: "https://inbox.example.com", site: null } });
    expect((await hosted.caps.setup.getProfile(owner)).domain_held).toBe(true);
  });
});
