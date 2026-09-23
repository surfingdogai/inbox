import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { PRESETS } from "../src/rules/presets";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import {
  availabilityRules,
  itemEvents,
  items,
  jobs,
  products,
  rules,
  services,
  threadEntries,
} from "../src/schema/tables";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");
const customer: Caller = {
  actor: { kind: "customer_human", id: "form", channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};

async function setup(vertical: keyof typeof PRESETS) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    // A rule reads the business's price (ADR-018 §3.2): the €45 this suite books at is the catalogue's.
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm
    .insert(availabilityRules)
    .values({ id: ulid(), kind: "open", weekly: { tue: [["09:00", "18:00"]] }, createdAt: T0 });
  await db.orm.insert(rules).values(
    PRESETS[vertical]?.map((p) => ({
      id: ulid(),
      name: p.name,
      priority: p.priority,
      enabled: 1,
      definition: p.definition,
      createdAt: T0,
      updatedAt: T0,
    })) ?? [],
  );
  const runner = createRunner({ mailOut: logMailOut() });
  return { db, svc, caps: new Capabilities(db), runner };
}

async function drain(db: ReturnType<typeof createDb>, runner: ReturnType<typeof createRunner>) {
  for (let i = 0; i < 5; i++) {
    const r = await runner.runDue(db, { now: T0 + i });
    if (r.claimed === 0) break;
  }
}

describe("rules engine", () => {
  it("auto-confirms a small booking inside opening hours when the slot is free, and flags the rest", async () => {
    const { db, svc, caps, runner } = await setup("appointments");
    // Tuesday 09:00 UTC = 09:00 opening; small price.
    const small = await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-22T09:00:00Z",
        endTime: "2026-09-22T10:30:00Z",
        totalPrice: { value: 4500, currency: "EUR" },
      },
    });
    await drain(db, runner);
    const [row] = await db.orm.select().from(items).where(eq(items.id, small.view.item.id));
    expect(row).toMatchObject({ state: "confirmed", version: 2 });
    const events = await db.orm
      .select({ event: itemEvents.event, actorKind: itemEvents.actorKind, depth: itemEvents.depth })
      .from(itemEvents)
      .where(eq(itemEvents.itemId, small.view.item.id));
    expect(events).toEqual([
      { event: "create", actorKind: "customer_human", depth: 0 },
      { event: "confirm", actorKind: "rule", depth: 1 },
    ]);
    // Same slot again: not free any more → falls through to "ask a person".
    const clash = await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-22T09:00:00Z",
        endTime: "2026-09-22T10:30:00Z",
        totalPrice: { value: 4500, currency: "EUR" },
      },
    });
    await drain(db, runner);
    const [clashRow] = await db.orm.select().from(items).where(eq(items.id, clash.view.item.id));
    expect(clashRow?.state).toBe("requested");
    expect(clashRow?.flags).toMatchObject({ needsHuman: true });
    // Outside opening hours (Sunday): flagged, not confirmed.
    const sunday = await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-27T09:00:00Z",
        endTime: "2026-09-27T10:30:00Z",
      },
    });
    await drain(db, runner);
    const [sundayRow] = await db.orm.select().from(items).where(eq(items.id, sunday.view.item.id));
    expect(sundayRow?.state).toBe("requested");
    const notes = (await db.orm.select({ lastError: jobs.lastError, kind: jobs.kind }).from(jobs)).filter(
      (j) => j.kind === "rules",
    );
    expect(notes.every((n) => n.lastError?.includes("evaluated"))).toBe(true);
  });

  it("flags quotes, raises priority on urgent words, and never chains past the depth limit", async () => {
    const { db, caps, runner } = await setup("trades");
    const q = await caps.requestQuote(customer, {
      payload: {
        itemOffered: { name: "Boiler repair" },
        description: "URGENT: the boiler is leaking water into the kitchen.",
      },
    });
    await drain(db, runner);
    const [row] = await db.orm.select().from(items).where(eq(items.id, q.view.item.id));
    expect(row?.flags).toMatchObject({ needsHuman: true, priority: 3 });
    const events = await db.orm
      .select({ event: itemEvents.event, actorKind: itemEvents.actorKind, depth: itemEvents.depth })
      .from(itemEvents)
      .where(eq(itemEvents.itemId, q.view.item.id))
      .orderBy(itemEvents.seq);
    // create, then two rule-driven flag events; nothing at depth 2 or beyond.
    expect(events.map((e) => e.depth)).toEqual([0, 1, 1]);
  });

  it("accepts small orders and asks a new customer to pay, and asks a person for large ones", async () => {
    const { db, caps, runner } = await setup("shop");
    const chain = ulid();
    await db.orm.insert(products).values({
      id: chain,
      name: "Chain, 9-speed",
      price: { value: 1850, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    });
    const line = { productId: chain, name: "Chain, 9-speed", quantity: 1, price: { value: 1850, currency: "EUR" } };
    const small = await caps.createOrder(customer, {
      payload: { orderedItem: [line], totalPrice: { value: 1850, currency: "EUR" } },
    });
    const big = await caps.createOrder(customer, {
      payload: { orderedItem: [{ ...line, quantity: 20 }], totalPrice: { value: 37000, currency: "EUR" } },
    });
    await drain(db, runner);
    const rows = await db.orm.select({ id: items.id, state: items.state, flags: items.flags }).from(items);
    // A new customer pays as the shop's flow says (ADR-017 §8.3): accepted, then asked for payment.
    expect(rows.find((r) => r.id === small.view.item.id)?.state).toBe("awaiting_payment");
    const large = rows.find((r) => r.id === big.view.item.id);
    expect(large?.state).toBe("received");
    expect(large?.flags).toMatchObject({ needsHuman: true, priority: 2 });
  });

  it("renders reply templates and ignores disabled rules", async () => {
    const { db, caps, runner } = await setup("appointments");
    await db.orm.delete(rules);
    await db.orm.insert(rules).values([
      {
        id: ulid(),
        name: "Greet",
        priority: 5,
        enabled: 1,
        definition: {
          on: ["item.created"],
          if: { path: "item.type", op: "eq", value: "message" },
          actions: [
            { action: "reply", template: "Thanks, we read every message about {{item.subject}} within a day." },
          ],
          stop: false,
          maxRunsPerItem: 1,
        },
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: ulid(),
        name: "Off",
        priority: 9,
        enabled: 0,
        definition: {
          on: ["item.created"],
          if: { path: "item.type", op: "eq", value: "message" },
          actions: [{ action: "set_flags", priority: 3 }],
          stop: false,
          maxRunsPerItem: 1,
        },
        createdAt: T0,
        updatedAt: T0,
      },
    ]);
    const m = (await caps.sendMessage(customer, { body: "Do you fix e-bike batteries?" })) as {
      view: { item: { id: string } };
    };
    await drain(db, runner);
    const thread = await db.orm
      .select({ direction: threadEntries.direction, body: threadEntries.bodyText })
      .from(threadEntries)
      .where(eq(threadEntries.itemId, m.view.item.id));
    expect(thread.map((t) => t.direction)).toEqual(["in", "out"]);
    expect(thread[1]?.body).toBe("Thanks, we read every message about Do you fix e-bike batteries? within a day.");
    const [row] = await db.orm.select().from(items).where(eq(items.id, m.view.item.id));
    expect(row?.flags).toMatchObject({ priority: 0 });
  });
});
