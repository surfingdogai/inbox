import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { availabilityRules, business, idempotencyKeys, items, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, transitionItem, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * A customer books a time the business offers (ADR-043 §2). A tester's assistant read Saturday's free
 * times (09:00 to 11:30), then asked for 03:00 anyway: it was shown a summary to confirm, and the
 * request landed on the owner as work. Now a time outside the hours, on a closed day, off the grid or
 * with no place free is refused before the summary, naming the nearest free times. Runs on Node and in
 * workerd.
 */
const T0 = Date.parse("2026-10-28T10:00:00Z"); // a Wednesday, 10:00 in Lisbon
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Saturday 31 October 2026, in Lisbon (UTC+0 from 25 October). */
const SAT = "2026-10-31";

const agent = (key?: string): Caller => ({
  actor: { kind: "customer_agent", id: "anon:0123456789abcdef", channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
  ...(key ? { idempotency: { scope: "customer_agent:anon:0123456789abcdef:mcp_public", key } } : {}),
});
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm.insert(business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en", "pt"],
    createdAt: T0,
    updatedAt: T0,
  });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const day = [["09:00", "18:00"]];
  await db.orm.insert(availabilityRules).values({
    id: ulid(),
    kind: "open",
    weekly: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: [["09:00", "13:00"]] },
    createdAt: T0,
  });
  const raw = new Capabilities(
    db,
    createSecretBox(["free-times-test-secret-0123456789abcdef"]),
    "https://inbox.example",
  );
  return { db, raw, caps: confirming(raw), svc };
}

const at = (svc: string, start: string, minutes = 90) => ({
  payload: {
    reservationFor: { serviceId: svc, name: "Full service" },
    startTime: start,
    endTime: new Date(Date.parse(start) + minutes * MIN).toISOString(),
  },
  contact: { name: "Rita", email: "rita@example.com" },
});

/** The start of each free time a refusal names. */
const starts = (e: WriteError): string[] =>
  ((e.details?.free_times ?? []) as { start_time: string }[]).map((t) => t.start_time);

async function refused(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

describe("a customer's booking at a time the business does not offer", () => {
  it("is refused at 03:00 on Saturday, before any summary, naming Saturday morning's free times", async () => {
    const s = await setup();
    // The confirm step is not reached: nothing to confirm for a time nobody takes.
    const e = await refused(s.raw.createBooking(agent("k-1"), at(s.svc, `${SAT}T03:00:00Z`)));
    expect(e.code).toBe("invalid_input");
    expect(e.status).toBe(422);
    expect(e.details).toEqual({
      reason: "outside_hours",
      free_times: [
        { start_time: `${SAT}T09:00:00.000Z`, end_time: `${SAT}T10:30:00.000Z` },
        { start_time: `${SAT}T09:30:00.000Z`, end_time: `${SAT}T11:00:00.000Z` },
        { start_time: `${SAT}T10:00:00.000Z`, end_time: `${SAT}T11:30:00.000Z` },
      ],
    });
    expect(e.message).toBe(
      "We do not take bookings at Saturday, 31 October 2026 at 03:00 (Western European Time). The nearest free times: Saturday 31 October: 09:00, 09:30, 10:00.",
    );
    expect(e.fields).toEqual([{ path: "payload.startTime", problem: "invalid", message: e.message }]);
    // Nothing was written, and the key keeps nothing: the corrected request runs under it.
    expect(await s.db.orm.select().from(items)).toHaveLength(0);
    expect(await s.db.orm.select().from(idempotencyKeys)).toHaveLength(0);
    const fixed = await s.caps.createBooking(agent("k-1"), at(s.svc, `${SAT}T09:00:00Z`));
    expect(fixed.replayed).toBe(false);
    expect(fixed.view.item.state).toBe("requested");
  });

  it("names the nearest times on either side, and none past closing or on a closed day", async () => {
    const s = await setup();
    // Friday 19:00: after closing. The nearest are Friday's last starts, before Saturday's first.
    const late = await refused(s.caps.createBooking(agent(), at(s.svc, "2026-10-30T19:00:00Z")));
    expect(starts(late)).toEqual(["2026-10-30T15:30:00.000Z", "2026-10-30T16:00:00.000Z", "2026-10-30T16:30:00.000Z"]);
    // Sunday: closed all day. Monday's first.
    const sunday = await refused(s.caps.createBooking(agent(), at(s.svc, "2026-11-01T10:00:00Z")));
    expect(sunday.details?.reason).toBe("outside_hours");
    expect(starts(sunday)[0]).toBe("2026-11-02T09:00:00.000Z");
    // Saturday 12:00 for 90 minutes runs past 13:00.
    const over = await refused(s.caps.createBooking(agent(), at(s.svc, `${SAT}T12:00:00Z`)));
    expect(over.details?.reason).toBe("outside_hours");
    // Off the half-hour grid: inside the hours, and not one of the start times.
    const odd = await refused(s.caps.createBooking(agent(), at(s.svc, `${SAT}T09:10:00Z`)));
    expect(odd.details?.reason).toBe("not_a_start_time");
    expect(odd.message).toContain("is not one of our start times");
    expect(starts(odd)).toEqual([`${SAT}T09:00:00.000Z`, `${SAT}T09:30:00.000Z`, `${SAT}T10:00:00.000Z`]);
  });

  it("tells a business half an hour off UTC that the local hour is not a start time, and names those that are", async () => {
    const s = await setup();
    await s.db.client.query({ sql: "UPDATE business SET timezone = 'Asia/Kolkata'", method: "run" });
    await s.db.client.query({ sql: "UPDATE services SET granularity_min = 60, duration_min = 60", method: "run" });
    // Monday 2 November, 10:00 in Kolkata (04:30 UTC): inside the hours, off the hourly grid counted from UTC.
    const e = await refused(s.caps.createBooking(agent(), at(s.svc, "2026-11-02T04:30:00Z", 60)));
    expect(e.details?.reason).toBe("not_a_start_time");
    expect(e.message).toContain("is not one of our start times");
    expect(starts(e)).toContain("2026-11-02T04:00:00.000Z");
    expect(starts(e)).toContain("2026-11-02T05:00:00.000Z");
  });

  it("is refused when its time is taken, saying it is not free", async () => {
    const s = await setup();
    const first = await s.caps.createBooking(agent(), at(s.svc, `${SAT}T09:00:00Z`));
    await transitionItem(s.db, owner, { itemId: first.view.item.id, event: "confirm" });
    const e = await refused(
      s.caps.createBooking(
        { ...agent(), actor: { ...agent().actor, id: "anon:fedcba9876543210" } },
        at(s.svc, `${SAT}T09:30:00Z`),
      ),
    );
    expect(e.details?.reason).toBe("time_not_free");
    expect(e.message).toMatch(
      /^Saturday, 31 October 2026 at 09:30 \(Western European Time\) is not free\. The nearest free times: /,
    );
    expect(starts(e)).toEqual([`${SAT}T10:30:00.000Z`, `${SAT}T11:00:00.000Z`, `${SAT}T11:30:00.000Z`]);
  });

  it("speaks the customer's language", async () => {
    const s = await setup();
    const e = await refused(
      s.caps.createBooking(agent(), {
        ...at(s.svc, `${SAT}T03:00:00Z`),
        contact: { email: "a@example.pt", locale: "pt-PT" },
      }),
    );
    expect(e.message).toMatch(
      /^Não aceitamos marcações para sábado, 31 de outubro de 2026 às 03:00 .* As horas livres mais próximas: sábado, 31 de outubro: 09:00, 09:30, 10:00\.$/,
    );
  });

  it("still takes a time inside the minimum notice that the business would otherwise offer, for a person", async () => {
    const s = await setup();
    // Wednesday 10:30 in Lisbon, half an hour away: inside the hour's notice, inside the hours, free.
    const soon = await s.caps.createBooking(agent(), at(s.svc, new Date(T0 + 30 * MIN).toISOString()));
    expect(soon.view.item.state).toBe("requested");
    // A time that has passed is refused as before, in its own words.
    const past = await refused(s.caps.createBooking(agent(), at(s.svc, new Date(T0 - HOUR).toISOString())));
    expect(past.message).toBe("That time has passed.");
  });

  it("answers a retry of a request it took as it did, whatever the time is now", async () => {
    const s = await setup();
    const first = await s.caps.createBooking(agent("k-2"), at(s.svc, `${SAT}T09:00:00Z`));
    await transitionItem(s.db, owner, { itemId: first.view.item.id, event: "confirm" });
    // Its own claim holds the time now; the retry is the same request, not a new one for a taken time.
    const again = await s.caps.createBooking(agent("k-2"), at(s.svc, `${SAT}T09:00:00Z`));
    expect(again.replayed).toBe(true);
    expect(again.view.item.id).toBe(first.view.item.id);
  });

  it("leaves the business itself free to write down any time", async () => {
    const s = await setup();
    const made = await s.caps.createBooking(owner, at(s.svc, `${SAT}T03:00:00Z`));
    expect(made.view.item.state).toBe("requested");
  });
});
