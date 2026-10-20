import { runMigrations } from "@surfingdog/platform";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/caller";
import { makeClient, resetTables } from "./harness";

/**
 * Places to stay for the stays tests (ADR-033), in their own zones and currencies, never one country's
 * by default: Ryokan Hoshi (Kyoto, JPY, exponent 0), Kijani House (Nairobi, KES, pay at the property),
 * Maple Hollow B&B (Nova Scotia, CAD, rooms kept for direct guests, DST), Haveli Rang (Jaipur, INR,
 * +5:30), Alpenrose Hostel (Innsbruck, EUR, dorm beds), Harbourlight Apartments (Hobart, AUD) and
 * Dar Al Bahr (Kuwait City, KWD, three decimals). Every figure is the example property's own.
 */

export const clock = { now: Date.parse("2026-11-02T01:00:00Z") };

export const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
};

export const ownerAi: Caller = {
  actor: { kind: "owner_ai", id: "ai_1", channel: "mcp_owner" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
};

export const system: Caller = {
  actor: { kind: "system", id: "test", channel: "system" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
};

let agentN = 0;
export function guest(opts: { accessToken?: string; key?: string; party?: string; locale?: string } = {}): Caller {
  return {
    actor: {
      kind: "customer_agent",
      id: `agent:${++agentN}`,
      channel: "rest",
      ...(opts.party ? { partyId: opts.party } : {}),
    },
    tier: "anonymous",
    sandbox: false,
    now: () => clock.now,
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.accessToken ? { accessToken: opts.accessToken } : {}),
    ...(opts.key ? { idempotency: { scope: "agent:test", key: opts.key } } : {}),
  };
}

export const SECRET = "stays-test-secret-0123456789abcdef0123";

export async function freshStays(
  timezone: string,
  currency: string,
  name: string,
): Promise<{ db: Db; caps: Capabilities }> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm.insert(business).values({
    id: "self",
    name,
    timezone,
    currency,
    languages: ["en"],
    createdAt: clock.now,
    updatedAt: clock.now,
  });
  await db.client.query({
    sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 1, ?)",
    params: [JSON.stringify({ business: { name, timezone, currency, languages: ["en"] } }), clock.now],
    method: "run",
  });
  const caps = new Capabilities(db, createSecretBox([SECRET]), "https://inbox.example.com", 0);
  return { db, caps };
}

export interface Built {
  readonly db: Db;
  readonly caps: Capabilities;
  readonly property: string;
  readonly rooms: Readonly<Record<string, string>>;
  readonly plans: Readonly<Record<string, string>>;
}

/** Ryokan Hoshi, Kyoto: JPY, a Japanese room for two on Flexible with breakfast, the first night as deposit. */
export async function ryokanHoshi(opts: { mode?: "request" | "allotment" } = {}): Promise<Built> {
  const { db, caps } = await freshStays("Asia/Tokyo", "JPY", "Ryokan Hoshi");
  const { id: property } = await caps.stays.upsertProperty(owner, {
    name: "Ryokan Hoshi",
    kind: "ryokan",
    currency: "JPY",
    check_in_from: "15:00",
    check_out_until: "10:00",
    answer_hours: 12,
    prices_include: { name: "consumption tax", rate_bp: 1_000 },
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  const { id: room } = await caps.stays.upsertRoomType(owner, {
    name: "Japanese room",
    units: 3,
    capacity: { adults: 2, children: 1, total: 3 },
    beds: [{ type: "futon", count: 2 }],
  });
  const { id: plan } = await caps.stays.upsertRatePlan(owner, {
    name: "Flexible with breakfast",
    meal: "breakfast",
    policy: { preset: "free_until", days: 3, after: "first_night", no_show: "full" },
    deposit: { kind: "first_night" },
    balance: { when: "at_property" },
  });
  await caps.stays.setRates(owner, { rate_plan_id: plan, room_type_id: room, nightly: 25_800, base_guests: 2 });
  await caps.stays.setFees(owner, {
    fees: [
      { name: "Service charge 10%", kind: "fee", basis: "percent_of_room", rate_bp: 1_000, collected: "with_booking" },
      { name: "Accommodation tax", kind: "tax", basis: "per_person_night", amount: 400, collected: "at_property" },
    ],
  });
  return { db, caps, property, rooms: { japanese: room }, plans: { flexible: plan } };
}

/** Kijani House, Nairobi: KES, pay at the property, request mode. */
export async function kijaniHouse(): Promise<Built> {
  const { db, caps } = await freshStays("Africa/Nairobi", "KES", "Kijani House");
  const { id: property } = await caps.stays.upsertProperty(owner, {
    name: "Kijani House",
    kind: "guesthouse",
    currency: "KES",
    check_in_from: "14:00",
    check_out_until: "11:00",
    answer_hours: 4,
  });
  const { id: room } = await caps.stays.upsertRoomType(owner, {
    name: "Garden double",
    units: 2,
    capacity: { adults: 2, children: 1, total: 3 },
    beds: [{ type: "double", count: 1 }],
  });
  const { id: plan } = await caps.stays.upsertRatePlan(owner, {
    name: "Bed and breakfast",
    meal: "breakfast",
    policy: { preset: "free_until", days: 2, after: "first_night", no_show: "first_night" },
    deposit: { kind: "none" },
  });
  await caps.stays.setRates(owner, { rate_plan_id: plan, room_type_id: room, nightly: 650_000, base_guests: 2 });
  return { db, caps, property, rooms: { garden: room }, plans: { bnb: plan } };
}

/** Maple Hollow B&B, Nova Scotia: CAD, two Harbour rooms kept for direct guests, closed elsewhere. */
export async function mapleHollow(): Promise<Built> {
  const { db, caps } = await freshStays("America/Halifax", "CAD", "Maple Hollow B&B");
  const { id: property } = await caps.stays.upsertProperty(owner, {
    name: "Maple Hollow B&B",
    kind: "bnb",
    currency: "CAD",
    check_in_from: "16:00",
    check_out_until: "11:00",
    mode: "allotment",
    hold_minutes: 20,
  });
  const { id: room } = await caps.stays.upsertRoomType(owner, {
    name: "Harbour room",
    units: 4,
    capacity: { adults: 2, children: 0, total: 2 },
    beds: [{ type: "queen", count: 1 }],
  });
  const { id: plan } = await caps.stays.upsertRatePlan(owner, {
    name: "Flexible",
    meal: "breakfast",
    policy: { preset: "free_until", days: 7, after: "first_night", no_show: "full" },
    deposit: { kind: "none" },
  });
  await caps.stays.setRates(owner, { rate_plan_id: plan, room_type_id: room, nightly: 18_900, base_guests: 2 });
  await caps.stays.setFees(owner, {
    fees: [{ name: "HST 15%", kind: "tax", basis: "percent_of_room", rate_bp: 1_500, collected: "with_booking" }],
  });
  await caps.stays.setAllotment(owner, {
    room_type_id: room,
    from_date: "2026-11-01",
    to_date: "2027-03-31",
    units: 1,
    closed_elsewhere: true,
  });
  return { db, caps, property, rooms: { harbour: room }, plans: { flexible: plan } };
}

/** Dar Al Bahr, Kuwait City: KWD, three decimals. */
export async function darAlBahr(): Promise<Built> {
  const { db, caps } = await freshStays("Asia/Kuwait", "KWD", "Dar Al Bahr");
  const { id: property } = await caps.stays.upsertProperty(owner, {
    name: "Dar Al Bahr",
    kind: "hotel",
    currency: "KWD",
  });
  const { id: room } = await caps.stays.upsertRoomType(owner, {
    name: "Sea view king",
    units: 6,
    capacity: { adults: 2, children: 2, total: 3 },
    beds: [{ type: "king", count: 1 }],
  });
  const { id: plan } = await caps.stays.upsertRatePlan(owner, {
    name: "Room only",
    meal: "room_only",
    policy: { preset: "free_until", days: 1, after: "half", no_show: "full" },
    deposit: { kind: "percent", value: 30 },
  });
  await caps.stays.setRates(owner, { rate_plan_id: plan, room_type_id: room, nightly: 45_750, base_guests: 2 });
  return { db, caps, property, rooms: { king: room }, plans: { roomOnly: plan } };
}

export const contact = { name: "Amara O.", email: "amara@example.org", locale: "en" };
