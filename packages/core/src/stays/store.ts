import type { Policy } from "@surfingdog/spec";
import { policySchema } from "@surfingdog/spec";
import type { Db } from "../db";
import { readSettings } from "../settings/schema";

/**
 * A place to stay as the inbox keeps it (ADR-033, migration 0026): the property, its room types, rate
 * plans, policies, prices, taxes and fees, extras and the rooms it keeps for direct guests, read as
 * plain objects. Writes are the owner's (`stays/setup.ts`); everything here reads.
 */

export type StayMode = "request" | "allotment" | "connected";

export interface PropertyRow {
  readonly id: string;
  readonly locationId: string;
  readonly kind: string;
  readonly name: string;
  readonly currency: string;
  readonly timezone: string;
  readonly checkInFrom: string;
  readonly checkInUntil: string | null;
  readonly checkOutUntil: string;
  readonly mode: StayMode;
  readonly instant: boolean;
  /** How fresh the property system's availability must be for anything to confirm at once: 5, 15 or 60. */
  readonly freshMinutes: number;
  readonly answerHours: number;
  readonly quoteValidHours: number;
  readonly payWithinHours: number;
  readonly holdMinutes: number;
  readonly maxNights: number;
  readonly sameDayUntil: string | null;
  readonly children: {
    readonly welcome: boolean;
    readonly fromAge?: number;
    readonly freeUnder?: number;
    readonly cots?: boolean;
  };
  readonly pets: { readonly allowed: "no" | "yes" | "ask"; readonly feeExtraId?: string };
  readonly houseRules: {
    readonly chips: readonly string[];
    readonly quiet?: readonly [string, string];
    readonly text?: string;
  };
  readonly arrivalPublic: string | null;
  readonly hasArrivalPrivate: boolean;
  readonly preArrivalText: string | null;
  readonly registration: { readonly required: boolean; readonly number?: string } | null;
  readonly pricesInclude: { readonly name: string; readonly rateBp: number } | null;
  readonly connectorId: string | null;
  readonly externalId: string | null;
  readonly active: boolean;
  /** The town it is in, for "23:59 Kyoto time": its location's address, when it has one. */
  readonly locality: string | null;
}

export interface RoomTypeRow {
  readonly id: string;
  readonly propertyId: string;
  readonly name: string;
  readonly description: string | null;
  readonly units: number;
  readonly capacity: { readonly adults: number; readonly children: number; readonly total: number };
  readonly beds: readonly { readonly type: string; readonly count: number }[];
  readonly sizeM2: number | null;
  readonly amenities: readonly string[];
  readonly accessible: boolean;
  readonly photos: readonly string[];
  readonly externalId: string | null;
  readonly offered: boolean;
  readonly active: boolean;
  readonly sort: number;
}

export interface DepositChoice {
  /** none: nothing now; first_night; percent (value 0–100); full. */
  readonly kind: "none" | "first_night" | "percent" | "full";
  readonly value?: number;
}

export interface BalanceChoice {
  /** at_property: on arrival; days_before: a second link `days` before arrival. */
  readonly when: "at_property" | "days_before";
  readonly days?: number;
}

export interface RatePlanRow {
  readonly id: string;
  readonly propertyId: string;
  readonly name: string;
  readonly meal: string;
  readonly policyId: string;
  readonly policy: Policy;
  readonly policyPreset: string;
  readonly deposit: DepositChoice;
  readonly balance: BalanceChoice;
  readonly guarantee: "none" | "card";
  readonly roomTypeIds: readonly string[] | null;
  readonly derived: { readonly fromPlanId: string; readonly percentOff: number } | null;
  readonly minNights: number;
  readonly maxNights: number | null;
  readonly externalId: string | null;
  readonly offered: boolean;
  readonly active: boolean;
  readonly sort: number;
}

export interface RateRow {
  readonly ratePlanId: string;
  readonly roomTypeId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly weekdays: number;
  readonly nightly: number;
  readonly baseGuests: number;
  readonly extraAdult: number | null;
  readonly extraChild: number | null;
  readonly minNights: number | null;
}

export interface FeeRow {
  readonly id: string;
  readonly name: string;
  readonly kind: "tax" | "fee";
  readonly basis: "per_stay" | "per_night" | "per_room_night" | "per_person_night" | "percent_of_room";
  readonly amount: number | null;
  readonly rateBp: number | null;
  /** For a tax that depends on the nightly price per guest: up to `upToNightly`, this. */
  readonly tiers:
    | readonly { readonly upToNightly: number | null; readonly amount?: number; readonly rateBp?: number }[]
    | null;
  readonly collected: "with_booking" | "at_property";
  readonly childExemptUnder: number | null;
  readonly maxNights: number | null;
  readonly active: boolean;
}

export interface ExtraRow {
  readonly id: string;
  readonly item: string;
  readonly name: string;
  readonly price: number;
  readonly basis: "per_stay" | "per_night" | "per_person_night";
  readonly active: boolean;
}

export interface AllotmentRow {
  readonly roomTypeId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly weekdays: number;
  readonly units: number;
  readonly closedElsewhereAt: number;
  readonly setBy: string;
}

export interface ClosureRow {
  readonly roomTypeId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly note: string | null;
}

/** Everything a stay is priced and checked against, read once. */
export interface PropertySetup {
  readonly property: PropertyRow;
  readonly rooms: readonly RoomTypeRow[];
  readonly plans: readonly RatePlanRow[];
  readonly rates: readonly RateRow[];
  readonly fees: readonly FeeRow[];
  readonly extras: readonly ExtraRow[];
  readonly allotments: readonly AllotmentRow[];
  readonly closures: readonly ClosureRow[];
}

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const PROPERTY_COLUMNS = `p.id, p.location_id, p.kind, p.name, p.currency, COALESCE(l.timezone, b.timezone),
  p.check_in_from, p.check_in_until, p.check_out_until, p.mode, p.instant, p.fresh_minutes, p.answer_hours,
  p.quote_valid_hours, p.pay_within_hours, p.hold_minutes, p.max_nights, p.same_day_until, p.children, p.pets,
  p.house_rules, p.arrival_public, p.arrival_private_enc IS NOT NULL, p.pre_arrival_text, p.registration,
  p.prices_include, p.connector_id, p.external_id, p.active, json_extract(l.address, '$.addressLocality')`;

function propertyOf(r: readonly unknown[]): PropertyRow {
  return {
    id: String(r[0]),
    locationId: String(r[1]),
    kind: String(r[2]),
    name: String(r[3]),
    currency: String(r[4]),
    timezone: r[5] === null || r[5] === undefined ? "" : String(r[5]),
    checkInFrom: String(r[6]),
    checkInUntil: str(r[7]),
    checkOutUntil: String(r[8]),
    mode: String(r[9]) as StayMode,
    instant: Number(r[10]) === 1,
    freshMinutes: Number(r[11] ?? 15),
    answerHours: Number(r[12]),
    quoteValidHours: Number(r[13]),
    payWithinHours: Number(r[14]),
    holdMinutes: Number(r[15]),
    maxNights: Number(r[16]),
    sameDayUntil: str(r[17]),
    children: json(r[18], { welcome: true }),
    pets: json(r[19], { allowed: "no" as const }),
    houseRules: json(r[20], { chips: [] }),
    arrivalPublic: str(r[21]),
    hasArrivalPrivate: Number(r[22]) === 1,
    preArrivalText: str(r[23]),
    registration: json(r[24], null),
    pricesInclude: json(r[25], null),
    connectorId: str(r[26]),
    externalId: str(r[27]),
    active: Number(r[28]) === 1,
    locality: str(r[29]),
  };
}

const PROPERTY_FROM = `FROM properties p LEFT JOIN locations l ON l.id = p.location_id LEFT JOIN business b ON 1 = 1`;

/** A property's zone: its location's, else the business's, else the settings' (UTC when none is set). */
async function zoned(db: Db, list: PropertyRow[]): Promise<PropertyRow[]> {
  if (list.every((p) => p.timezone)) return list;
  const zone = (await readSettings(db)).business.timezone || "UTC";
  return list.map((p) => (p.timezone ? p : { ...p, timezone: zone }));
}

/** The inbox's places to stay, in the owner's order. */
export async function listProperties(db: Db, opts: { readonly active?: boolean } = {}): Promise<PropertyRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${PROPERTY_COLUMNS} ${PROPERTY_FROM} ${opts.active ? "WHERE p.active = 1" : ""} ORDER BY p.sort, p.created_at`,
    params: [],
    method: "all",
  });
  return zoned(db, rows.map(propertyOf));
}

/** One property, or null. */
export async function readProperty(db: Db, id: string): Promise<PropertyRow | null> {
  const { rows } = await db.client.query({
    sql: `SELECT ${PROPERTY_COLUMNS} ${PROPERTY_FROM} WHERE p.id = ?`,
    params: [id],
    method: "all",
  });
  return rows[0] ? ((await zoned(db, [propertyOf(rows[0])]))[0] ?? null) : null;
}

/** The property a request is for: the one named, else the only active one. */
export async function propertyFor(db: Db, id: string | null | undefined): Promise<PropertyRow | null> {
  if (id) return readProperty(db, id);
  const all = await listProperties(db, { active: true });
  return all.length === 1 ? (all[0] ?? null) : null;
}

function roomOf(r: readonly unknown[]): RoomTypeRow {
  return {
    id: String(r[0]),
    propertyId: String(r[1]),
    name: String(r[2]),
    description: str(r[3]),
    units: Number(r[4]),
    capacity: json(r[5], { adults: 2, children: 0, total: 2 }),
    beds: json(r[6], []),
    sizeM2: num(r[7]),
    amenities: json(r[8], []),
    accessible: Number(r[9]) === 1,
    photos: json(r[10], []),
    externalId: str(r[11]),
    offered: Number(r[12]) === 1,
    active: Number(r[13]) === 1,
    sort: Number(r[14] ?? 0),
  };
}

const ROOM_COLUMNS =
  "id, property_id, name, description, units, capacity, beds, size_m2, amenities, accessible, photos, external_id, offered, active, sort";

export async function roomTypesOf(db: Db, propertyId: string): Promise<RoomTypeRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${ROOM_COLUMNS} FROM room_types WHERE property_id = ? ORDER BY sort, created_at`,
    params: [propertyId],
    method: "all",
  });
  return rows.map(roomOf);
}

export async function readRoomType(db: Db, id: string): Promise<RoomTypeRow | null> {
  const { rows } = await db.client.query({
    sql: `SELECT ${ROOM_COLUMNS} FROM room_types WHERE id = ?`,
    params: [id],
    method: "all",
  });
  return rows[0] ? roomOf(rows[0]) : null;
}

export async function ratePlansOf(db: Db, propertyId: string): Promise<RatePlanRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT r.id, r.property_id, r.name, r.meal, r.policy_id, sp.policy, sp.preset, r.deposit, r.balance,
                 r.guarantee, r.room_type_ids, r.derived, r.min_nights, r.max_nights, r.external_id, r.offered,
                 r.active, r.sort
            FROM rate_plans r JOIN stay_policies sp ON sp.id = r.policy_id
           WHERE r.property_id = ? ORDER BY r.sort, r.created_at`,
    params: [propertyId],
    method: "all",
  });
  return rows.map((r) => {
    const parsed = policySchema.safeParse(json(r[5], null));
    return {
      id: String(r[0]),
      propertyId: String(r[1]),
      name: String(r[2]),
      meal: String(r[3]),
      policyId: String(r[4]),
      policy: parsed.success ? parsed.data : { steps: [], after: { kind: "full" }, noShow: { kind: "full" } },
      policyPreset: String(r[6]),
      deposit: json(r[7], { kind: "none" as const }),
      balance: json(r[8], { when: "at_property" as const }),
      guarantee: String(r[9]) === "card" ? "card" : "none",
      roomTypeIds: json(r[10], null),
      derived: json(r[11], null),
      minNights: Number(r[12] ?? 1),
      maxNights: num(r[13]),
      externalId: str(r[14]),
      offered: Number(r[15]) === 1,
      active: Number(r[16]) === 1,
      sort: Number(r[17] ?? 0),
    };
  });
}

/** Everything a stay at the property is priced and checked against. */
export async function readSetup(db: Db, propertyId: string): Promise<PropertySetup | null> {
  const property = await readProperty(db, propertyId);
  if (!property) return null;
  const [rooms, plans, rates, fees, extras, allotments, closures] = await Promise.all([
    roomTypesOf(db, propertyId),
    ratePlansOf(db, propertyId),
    db.client.query({
      sql: `SELECT r.rate_plan_id, r.room_type_id, r.from_date, r.to_date, r.weekdays, r.nightly, r.base_guests,
                   r.extra_adult, r.extra_child, r.min_nights
              FROM rates r JOIN rate_plans p ON p.id = r.rate_plan_id WHERE p.property_id = ?`,
      params: [propertyId],
      method: "all",
    }),
    db.client.query({
      sql: `SELECT id, name, kind, basis, amount, rate_bp, tiers, collected, child_exempt_under, max_nights, active
              FROM stay_fees WHERE property_id = ? ORDER BY sort, created_at`,
      params: [propertyId],
      method: "all",
    }),
    db.client.query({
      sql: "SELECT id, item, name, price, basis, active FROM stay_extras WHERE property_id = ? ORDER BY sort, created_at",
      params: [propertyId],
      method: "all",
    }),
    db.client.query({
      sql: `SELECT a.room_type_id, a.from_date, a.to_date, a.weekdays, a.units, a.closed_elsewhere_at, a.set_by
              FROM allotments a JOIN room_types r ON r.id = a.room_type_id WHERE r.property_id = ?`,
      params: [propertyId],
      method: "all",
    }),
    db.client.query({
      sql: "SELECT room_type_id, from_date, to_date, note FROM stay_closures WHERE property_id = ?",
      params: [propertyId],
      method: "all",
    }),
  ]);
  return {
    property,
    rooms,
    plans,
    rates: rates.rows.map((r) => ({
      ratePlanId: String(r[0]),
      roomTypeId: String(r[1]),
      fromDate: String(r[2] ?? ""),
      toDate: String(r[3] ?? ""),
      weekdays: Number(r[4] ?? 127),
      nightly: Number(r[5]),
      baseGuests: Number(r[6] ?? 2),
      extraAdult: num(r[7]),
      extraChild: num(r[8]),
      minNights: num(r[9]),
    })),
    fees: fees.rows.map((r) => ({
      id: String(r[0]),
      name: String(r[1]),
      kind: String(r[2]) === "tax" ? "tax" : "fee",
      basis: String(r[3]) as FeeRow["basis"],
      amount: num(r[4]),
      rateBp: num(r[5]),
      tiers: json(r[6], null),
      collected: String(r[7]) === "at_property" ? "at_property" : "with_booking",
      childExemptUnder: num(r[8]),
      maxNights: num(r[9]),
      active: Number(r[10]) === 1,
    })),
    extras: extras.rows.map((r) => ({
      id: String(r[0]),
      item: String(r[1]),
      name: String(r[2]),
      price: Number(r[3]),
      basis: String(r[4]) as ExtraRow["basis"],
      active: Number(r[5]) === 1,
    })),
    allotments: allotments.rows.map((r) => ({
      roomTypeId: String(r[0]),
      fromDate: String(r[1]),
      toDate: String(r[2]),
      weekdays: Number(r[3]),
      units: Number(r[4]),
      closedElsewhereAt: Number(r[5]),
      setBy: String(r[6]),
    })),
    closures: closures.rows.map((r) => ({
      roomTypeId: String(r[0] ?? ""),
      fromDate: String(r[1]),
      toDate: String(r[2]),
      note: str(r[3]),
    })),
  };
}
