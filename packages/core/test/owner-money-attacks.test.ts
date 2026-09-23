import { runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import type { RuleDefinition } from "../src/rules/schema";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, services } from "../src/schema/tables";
import { type Caller, WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * The ways round "time yes, money no" (Tiago, 23 September 2026) that the owner's AI could take
 * without touching a price field itself: a time proposed with no price, which keeps the price the
 * customer typed, or a longer time at the list price; a rule it writes that quotes or prices for
 * it; a booking it makes itself, at a price of its own. Each is held, and the owner in person may
 * do every one. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const EUR = (value: number) => ({ value, currency: "EUR" });

const person: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const ai: Caller = {
  actor: { kind: "owner_ai", id: "client_1", channel: "rest" },
  actsAs: "owner",
  principal: { via: "oauth", id: "client_1", name: "Assistant", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const mcp: Caller = {
  actor: { kind: "owner", id: "u1", channel: "mcp_owner" },
  principal: { via: "api_key", id: "k1", name: "cli", scopes: ["*"], userId: null, keyKind: "owner" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const customer: Caller = {
  actor: { kind: "customer_agent", id: "anon:agent", channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm
    .insert(business)
    .values({ id: "self", name: "Oficina Maré", timezone: "UTC", currency: "EUR", createdAt: T0, updatedAt: T0 });
  const svc = { fixed: ulid(), from: ulid() };
  const service = (id: string, price: typeof services.$inferInsert.price) => ({
    id,
    name: "Full service",
    durationMin: 60,
    capacity: 2,
    granularityMin: 30,
    price,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm
    .insert(services)
    .values([
      service(svc.fixed, { model: "fixed", value: 10_000, currency: "EUR" }),
      service(svc.from, { model: "from", value: 2_000, currency: "EUR" }),
    ]);
  const caps = new Capabilities(db);
  const book = (serviceId: string, hour: number, extra: Record<string, unknown> = {}, who: Caller = customer) =>
    caps.createBooking(who, {
      payload: {
        reservationFor: { serviceId, name: "Full service" },
        startTime: `2026-09-22T${String(hour).padStart(2, "0")}:00:00Z`,
        endTime: `2026-09-22T${String(hour + 1).padStart(2, "0")}:00:00Z`,
        ...extra,
      },
    });
  return { db, caps, svc, book };
}

async function refusal(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

async function rowOf(db: Awaited<ReturnType<typeof setup>>["db"], id: string) {
  const [row] = await db.orm.select().from(items).where(eq(items.id, id));
  return row;
}

const later = { startTime: "2026-09-23T10:00:00Z", endTime: "2026-09-23T11:00:00Z" };

describe("the owner's AI proposing a time", () => {
  it("does not offer the customer's own price back by leaving the price out", async () => {
    const s = await setup();
    // "From €20": the customer wrote €1. No rule and no AI may confirm that (business_priced)…
    const b = await s.book(s.svc.from, 9, { totalPrice: EUR(100) });
    // …and a time proposed with no price would carry the €1 to the customer's yes.
    for (const caller of [ai, mcp]) {
      const e = await refusal(
        s.caps.transitionItem(caller, { item_id: b.view.item.id, event: "propose", input: later }),
      );
      expect(e.code).toBe("not_allowed");
      expect(e.details).toMatchObject({ reason: "owner_money", draft_for_owner: true });
    }
    expect((await rowOf(s.db, b.view.item.id))?.state).toBe("requested");
    // The owner may: it is the owner's price to set, or to keep.
    await s.caps.transitionItem(person, { item_id: b.view.item.id, event: "propose", input: later });
    expect((await rowOf(s.db, b.view.item.id))?.state).toBe("proposed");
  });

  it("does not sell a longer time at the list price", async () => {
    const s = await setup();
    const b = await s.book(s.svc.fixed, 9);
    const twoHours = { startTime: "2026-09-23T10:00:00Z", endTime: "2026-09-23T12:00:00Z" };
    const e = await refusal(s.caps.transitionItem(ai, { item_id: b.view.item.id, event: "propose", input: twoHours }));
    expect(e.code).toBe("not_allowed");
    expect(e.details).toMatchObject({ reason: "owner_money", draft_for_owner: true });
    expect(e.fields?.[0]?.path).toBe("input.endTime");
    // The service's own length is a time, at the price the catalogue gives it.
    await s.caps.transitionItem(ai, { item_id: b.view.item.id, event: "propose", input: later });
    expect((await rowOf(s.db, b.view.item.id))?.state).toBe("proposed");
    const theirs: Caller = { ...customer, accessToken: b.accessToken as string };
    const status = await s.caps.getItemStatus(theirs, { item_id: b.view.item.id });
    const accepted = await s.caps.customer.acceptOffer(theirs, {
      item_id: b.view.item.id,
      terms_sha: status.offer?.terms_sha as string,
    });
    expect(accepted.view.item.state).toBe("confirmed");
    expect((accepted.view.item.payload as { totalPrice: unknown }).totalPrice).toEqual(EUR(10_000));
  });
});

describe("the owner's AI writing rules", () => {
  const onQuote = (input: Record<string, unknown>): RuleDefinition =>
    ({
      on: ["item.created"],
      if: { path: "item.type", op: "eq", value: "quote_request" },
      actions: [{ action: "transition", event: "quote", input }],
    }) as unknown as RuleDefinition;
  const quote = { totalPrice: EUR(100), validThrough: "2026-09-28T18:00:00Z" };

  it("writes no rule that sends a quote or puts a price on a time; the owner can", async () => {
    const s = await setup();
    for (const caller of [ai, mcp]) {
      const e = await refusal(
        s.caps.setup.createRule(caller, {
          name: "Quote everything at €1",
          priority: 0,
          enabled: true,
          definition: onQuote(quote),
        }),
      );
      expect(e.code).toBe("not_allowed");
      expect(e.details).toMatchObject({ reason: "owner_money", draft_for_owner: true });
      const proposes = await refusal(
        s.caps.setup.createRule(caller, {
          name: "Move every booking, cheaper",
          priority: 0,
          enabled: true,
          definition: {
            on: ["item.created"],
            if: { path: "item.type", op: "eq", value: "booking" },
            actions: [{ action: "transition", event: "propose", input: { ...later, totalPrice: EUR(1) } }],
          } as unknown as RuleDefinition,
        }),
      );
      expect(proposes.code).toBe("not_allowed");
    }
    // A rule of times and words is the AI's to write.
    await s.caps.setup.createRule(ai, {
      name: "Confirm fixed-price bookings",
      priority: 0,
      enabled: true,
      definition: {
        on: ["item.created"],
        if: { path: "item.type", op: "eq", value: "booking" },
        actions: [{ action: "transition", event: "confirm" }],
      } as unknown as RuleDefinition,
    });
    // The owner writes the quoting rule; the AI may not switch it back on, or rewrite it, once off.
    const owners = await s.caps.setup.createRule(person, {
      name: "Standard quote",
      priority: 0,
      enabled: false,
      definition: onQuote(quote),
    });
    const on = await refusal(s.caps.setup.updateRule(ai, { rule_id: owners.id, enabled: true }));
    expect(on.details).toMatchObject({ reason: "owner_money", draft_for_owner: true });
    await refusal(
      s.caps.setup.updateRule(ai, { rule_id: owners.id, definition: onQuote({ ...quote, totalPrice: EUR(1) }) }),
    );
    // Renaming it, or switching it off, is not money.
    await s.caps.setup.updateRule(ai, { rule_id: owners.id, name: "Standard quote (old)", enabled: false });
    expect((await s.caps.setup.updateRule(person, { rule_id: owners.id, enabled: true })).enabled).toBe(true);
  });
});

describe("the owner's AI making a booking itself", () => {
  it("books at the catalogue's price, never at one of its own", async () => {
    const s = await setup();
    // Through the public door with its owner token: its figure is not the price.
    const b = await s.book(s.svc.fixed, 9, { totalPrice: EUR(100) }, ai);
    const row = await rowOf(s.db, b.view.item.id);
    expect((row?.payload as { totalPrice?: unknown } | undefined)?.totalPrice).toEqual(EUR(10_000));
    // A price the catalogue does not give waits for the owner: the AI cannot confirm it.
    const from = await s.book(s.svc.from, 11, { totalPrice: EUR(100) }, ai);
    const e = await refusal(s.caps.transitionItem(ai, { item_id: from.view.item.id, event: "confirm" }));
    expect(e.details).toMatchObject({ guard: "business_priced", draft_for_owner: true });
    await s.caps.transitionItem(person, { item_id: from.view.item.id, event: "confirm" });
    expect((await rowOf(s.db, from.view.item.id))?.state).toBe("confirmed");
  });
});

describe("the owner's AI and the networks", () => {
  const net = "https://people.example.org";

  it("switches no network on: a network is sent customers' addresses; the owner in person does it", async () => {
    const s = await setup();
    for (const caller of [ai, mcp]) {
      const e = await refusal(
        s.caps.updateSettings(caller, { doc: { networks: { [net]: { enabled: true, issue: true } } } }),
      );
      expect(e.code).toBe("not_allowed");
      expect(e.fields?.[0]?.path).toBe(`doc.networks.${net}.enabled`);
    }
    // Added switched off, it is sent nothing: that is the AI's to do.
    await s.caps.updateSettings(ai, { doc: { networks: { [net]: { enabled: false } } } });
    await s.caps.updateSettings(person, { doc: { networks: { [net]: { enabled: true, issue: false } } } });
    // On already, letting it issue codes sends it every first-time customer's address: the owner's too.
    await refusal(s.caps.updateSettings(ai, { doc: { networks: { [net]: { issue: true } } } }));
    // Switching one off, or sharing less with it, is never refused.
    const off = await s.caps.updateSettings(ai, { doc: { networks: { [net]: { enabled: false } } } });
    expect(off.doc.networks[net]?.enabled).toBe(false);
  });
});

describe("another system and the networks", () => {
  it("switches no network on with a key handed to it; the command line and the owner's jobs still do", async () => {
    const s = await setup();
    const zap: Caller = {
      actor: { kind: "integration", id: "k2", channel: "rest" },
      actsAs: "owner",
      principal: { via: "api_key", id: "k2", name: "Zap", scopes: ["*"], userId: null, keyKind: "integration" },
      tier: "verified_principal",
      sandbox: false,
      now: () => T0,
    };
    const net = "https://people.example.org";
    await refusal(s.caps.updateSettings(zap, { doc: { networks: { [net]: { enabled: true } } } }));
    const system: Caller = {
      actor: { kind: "system", id: "cli", channel: "system" },
      tier: "verified_principal",
      sandbox: false,
      now: () => T0,
    };
    const on = await s.caps.updateSettings(system, { doc: { networks: { [net]: { enabled: true } } } });
    expect(on.doc.networks[net]?.enabled).toBe(true);
  });
});
