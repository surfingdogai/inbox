import { PRESETS, schema } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { localTime, seedShowcase } from "../src/seed";
import { freshDb } from "./harness";

// The showcase goes through the real write path and the rules, so every state it promises must be there.
describe("seed-showcase", () => {
  it("fills an empty instance with a week of Oficina Maré and is idempotent", async () => {
    const db = await freshDb();
    const now = Date.parse("2026-09-22T14:00:00Z"); // a Tuesday: tomorrow is a working day
    const first = await seedShowcase(db, now);
    expect(first.seeded).toBe(true);
    expect(first.items).toBeGreaterThanOrEqual(14);

    const rows = await db.orm
      .select({ type: schema.items.type, state: schema.items.state, flags: schema.items.flags })
      .from(schema.items);
    const states = rows.map((r) => `${r.type}:${r.state}`);
    for (const expected of [
      "booking:confirmed",
      "booking:requested",
      "booking:proposed",
      "booking:cancelled_by_customer",
      "booking:completed",
      "quote_request:quoted",
      "quote_request:accepted",
      "quote_request:declined",
      "order:received",
      "order:paid",
      "order:completed",
      "message:answered",
      "message:open",
      "message:spam",
      "refund:approved",
    ]) {
      expect(states).toContain(expected);
    }
    expect(rows.length).toBe(first.items);
    // The rules did their part: a flagged item exists, and the big order carries its priority.
    const flagged = rows.filter((r) => (r.flags as { needsHuman?: boolean }).needsHuman);
    expect(flagged.length).toBeGreaterThan(0);
    const big = rows.find((r) => r.type === "order" && (r.flags as { priority?: number }).priority === 2);
    expect(big?.state).toBe("received");
    // Rita's booking was confirmed by the auto-confirm rule, not by hand.
    const confirmedBy = await db.client.query({
      sql: "SELECT actor_kind FROM item_events WHERE event = 'confirm' ORDER BY created_at LIMIT 1",
      method: "all",
    });
    expect(["rule", "owner"]).toContain(String(confirmedBy.rows[0]?.[0]));
    const rules = await db.orm.select({ name: schema.rules.name }).from(schema.rules);
    // The appointments preset (ADR-017 §8.3 added the known-customer rules) and two of its own.
    expect(rules.length).toBe((PRESETS.appointments ?? []).length + 2);
    const hours = await db.orm.select({ weekly: schema.availabilityRules.weekly }).from(schema.availabilityRules);
    const weekly = hours[0]?.weekly as { sat?: unknown[] } | undefined;
    expect(weekly?.sat).toEqual([["09:00", "13:00"]]);

    const again = await seedShowcase(db, now);
    expect(again.seeded).toBe(false);
    expect((await db.orm.select({ id: schema.items.id }).from(schema.items)).length).toBe(rows.length);
  });

  it("places local times in the business time zone", () => {
    const now = Date.parse("2026-09-22T14:00:00Z");
    const t = localTime(now, "Europe/Lisbon", 1, 10, 0);
    expect(new Date(t).toISOString()).toBe("2026-09-23T09:00:00.000Z"); // WEST is UTC+1 in September
    const winter = localTime(Date.parse("2026-01-10T14:00:00Z"), "Europe/Lisbon", 0, 10, 0);
    expect(new Date(winter).toISOString()).toBe("2026-01-10T10:00:00.000Z");
  });
});
