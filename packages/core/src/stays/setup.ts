import type { SqlInput, Statement } from "@surfingdog/platform";
import { type Policy, stayPolicySteps } from "@surfingdog/spec";
import { isOwnerOrSystem } from "../access/outbound";
import type { Db } from "../db";
import { ulid } from "../ids";
import type { SecretBox } from "../secrets/box";
import { readSettings } from "../settings/schema";
import { currencyProblem } from "../util/locale";
import { daysBetween, knownZone } from "../util/zoned";
import { type Caller, isCustomer, isOwnerAssistant, nowOf } from "../write/caller";
import { WriteError } from "../write/errors";
import type {
  PolicyPresetInput,
  SetRatesInput,
  SetStayFeesInput,
  UpsertPropertyInput,
  UpsertRatePlanInput,
  UpsertRoomTypeInput,
} from "./inputs";
import { businessZoneAndCurrency } from "./lang";
import { listProperties, propertyFor, readProperty, readSetup } from "./store";

/**
 * The owner's writes to a place to stay (ADR-033 §6.2): the property, its rooms, rates, policies, taxes
 * and fees, extras, the rooms it keeps for direct guests and the nights it closes. The owner's AI may
 * fill in rooms, rates, fees and extras from the property's own website and its system while nothing is
 * offered yet; how the property confirms (`mode`, `instant`), its policies, deposits, card holds,
 * allotments and registration are the owner's alone, in person (D10). A rate plan the AI makes waits
 * for the owner to offer it.
 */

export function requireOwner(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "setup needs an owner or staff principal");
}

/** The owner in person (ADR-018 §4): what bounds what the inbox confirms on its own is theirs. */
export function requireInPerson(caller: Caller, what: string): void {
  if (isOwnerOrSystem(caller)) return;
  throw new WriteError(
    "not_allowed",
    `Only the owner can ${what}, signed in to the owner app: it decides what confirms on its own and what a guest pays. Tell the owner in a note what you suggest. Nothing was changed.`,
    { details: { reason: "owner_in_person", ask_owner: true } },
  );
}

const IN_PERSON: readonly (keyof UpsertPropertyInput)[] = [
  "mode",
  "instant",
  "fresh_minutes",
  "registration",
  "connector_id",
];

/** The property a write is for: the one named, else the only one. */
async function propertyIdFor(db: Db, id: string | undefined): Promise<string> {
  const p = await propertyFor(db, id);
  if (!p) {
    throw new WriteError(
      "invalid_input",
      id ? "There is no such property." : "Name the property (property_id): there is more than one, or none yet.",
      {
        fields: [{ path: "property_id", problem: id ? "invalid" : "missing", message: "a property of this inbox" }],
      },
    );
  }
  return p.id;
}

/** Whether anything at the property is offered to guests at a price yet: then money is the owner's to change. */
async function pricesLive(db: Db, propertyId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM rate_plans WHERE property_id = ? AND offered = 1 AND active = 1 LIMIT 1",
    params: [propertyId],
    method: "all",
  });
  return rows.length > 0;
}

function aiMoney(what: string): WriteError {
  return new WriteError(
    "not_allowed",
    `${what} is the owner's to change once rates are offered to guests. Tell the owner in a note (reply with internal: true) what you suggest; the owner changes it in the app.`,
    { details: { reason: "owner_money", draft_for_owner: true } },
  );
}

/** Whether the property's system has taken a stay this inbox wrote, read back: what unlocks "confirm at once" (§0.8). */
export async function systemProven(db: Db, connectorId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM connector_writes WHERE connector_id = ? AND owner = 'stays' AND op = 'reserve' AND outcome = 'written' LIMIT 1",
    params: [connectorId],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * Creates or changes the property. A new one needs a name and a currency, and takes a location of its
 * own (one property per location). Answers its id.
 */
export async function upsertProperty(
  db: Db,
  secrets: SecretBox | null,
  caller: Caller,
  input: UpsertPropertyInput,
): Promise<string> {
  requireOwner(caller);
  const now = nowOf(caller);
  for (const k of IN_PERSON) {
    if (input[k] !== undefined)
      requireInPerson(caller, `change how the property confirms stays and its registration (${k})`);
  }
  if (input.timezone !== undefined && knownZone(input.timezone) !== input.timezone) {
    throw new WriteError("invalid_input", "That is not a time zone this server knows.", {
      fields: [{ path: "timezone", problem: "invalid", message: "an IANA time zone, such as America/Mexico_City" }],
    });
  }
  if (input.currency !== undefined) {
    const problem = currencyProblem(input.currency);
    if (problem)
      throw new WriteError("invalid_input", problem, {
        fields: [{ path: "currency", problem: "invalid", message: problem }],
      });
  }
  const existing = input.id ? await readProperty(db, input.id) : null;
  if (input.id && !existing) throw new WriteError("not_found", "There is no such property.");
  if (input.mode === "connected" && !(input.connector_id ?? existing?.connectorId)) {
    throw new WriteError("invalid_input", "Connect your system first: confirming from it needs the connection.", {
      fields: [{ path: "mode", problem: "invalid", message: "needs a connected system" }],
    });
  }
  if (input.instant === true) {
    const conn = input.connector_id ?? existing?.connectorId;
    const mode = input.mode ?? existing?.mode;
    if (mode !== "connected" || !conn || !(await systemProven(db, conn))) {
      throw new WriteError("guard_failed", "Available after your first stay is written to your system.", {
        details: { reason: "instant_locked" },
      });
    }
  }
  if (
    input.registration?.required &&
    !input.registration.number &&
    existing?.active !== false &&
    input.active !== false
  ) {
    // Saved, but nothing is quoted or booked until the number is in (registration_ok).
  }
  const json = (v: unknown) => (v === undefined ? undefined : v === null ? null : JSON.stringify(v));
  const sealed =
    input.arrival_private === undefined
      ? undefined
      : input.arrival_private === null || input.arrival_private.trim() === ""
        ? null
        : "seal";
  if (sealed === "seal" && !secrets) {
    throw new WriteError(
      "not_allowed",
      "Private arrival details are sealed, and this server has no secret key to seal them with.",
      {
        details: { reason: "no_secret_key" },
      },
    );
  }
  if (!existing) {
    if (!input.name || !input.currency) {
      throw new WriteError("invalid_input", "A new property needs a name and the currency it prices in.", {
        fields: [
          ...(!input.name ? [{ path: "name", problem: "missing" as const, message: "required" }] : []),
          ...(!input.currency ? [{ path: "currency", problem: "missing" as const, message: "required" }] : []),
        ],
      });
    }
    const id = ulid(now);
    const locationId = input.location_id ?? (await freeLocation(db, input.name, now));
    const statements: Statement[] = [
      {
        sql: `INSERT INTO properties (id, location_id, kind, name, currency, check_in_from, check_in_until, check_out_until,
                mode, instant, fresh_minutes, answer_hours, quote_valid_hours, pay_within_hours, hold_minutes, max_nights,
                same_day_until, children, pets, house_rules, arrival_public, pre_arrival_text, registration, prices_include,
                connector_id, external_id, active, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          locationId,
          input.kind ?? "guesthouse",
          input.name,
          input.currency,
          input.check_in_from ?? "15:00",
          input.check_in_until ?? null,
          input.check_out_until ?? "11:00",
          input.mode ?? "request",
          input.instant ? 1 : 0,
          input.fresh_minutes ?? 15,
          input.answer_hours ?? 12,
          input.quote_valid_hours ?? 24,
          input.pay_within_hours ?? 24,
          input.hold_minutes ?? 20,
          input.max_nights ?? 30,
          input.same_day_until ?? null,
          JSON.stringify(childrenOf(input.children) ?? { welcome: true }),
          JSON.stringify(petsOf(input.pets) ?? { allowed: "no" }),
          JSON.stringify(input.house_rules ?? { chips: [] }),
          input.arrival_public ?? null,
          input.pre_arrival_text ?? null,
          json(input.registration) ?? null,
          json(pricesIncludeOf(input.prices_include)) ?? null,
          input.connector_id ?? null,
          input.external_id ?? null,
          input.active === false ? 0 : 1,
          now,
          now,
        ],
        method: "run",
      },
    ];
    await db.batch(statements);
    await setLocation(db, locationId, input);
    if (sealed === "seal" && secrets && input.arrival_private)
      await sealArrival(db, secrets, id, input.arrival_private, now);
    return id;
  }
  const sets: string[] = [];
  const params: SqlInput[] = [];
  const set = (col: string, v: SqlInput | undefined) => {
    if (v === undefined) return;
    sets.push(`${col} = ?`);
    params.push(v);
  };
  set("name", input.name);
  set("kind", input.kind);
  set("currency", input.currency);
  set("check_in_from", input.check_in_from);
  set("check_in_until", input.check_in_until);
  set("check_out_until", input.check_out_until);
  set("same_day_until", input.same_day_until);
  set("answer_hours", input.answer_hours);
  set("quote_valid_hours", input.quote_valid_hours);
  set("pay_within_hours", input.pay_within_hours);
  set("hold_minutes", input.hold_minutes);
  set("max_nights", input.max_nights);
  set("children", json(childrenOf(input.children)));
  set("pets", json(petsOf(input.pets)));
  set("house_rules", json(input.house_rules));
  set("arrival_public", input.arrival_public);
  set("pre_arrival_text", input.pre_arrival_text);
  set("prices_include", json(pricesIncludeOf(input.prices_include)));
  set("mode", input.mode);
  set("instant", input.instant === undefined ? undefined : input.instant ? 1 : 0);
  set("fresh_minutes", input.fresh_minutes);
  set("registration", json(input.registration));
  set("connector_id", input.connector_id);
  set("external_id", input.external_id);
  set("active", input.active === undefined ? undefined : input.active ? 1 : 0);
  if (sealed === null) set("arrival_private_enc", null);
  // Switched back to request or allotment: confirming at once from the system goes with it.
  if (input.mode !== undefined && input.mode !== "connected") set("instant", 0);
  if (sets.length > 0) {
    await db.client.query({
      sql: `UPDATE properties SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
      params: [...params, now, existing.id],
      method: "run",
    });
  }
  await setLocation(db, existing.locationId, input);
  if (sealed === "seal" && secrets && input.arrival_private)
    await sealArrival(db, secrets, existing.id, input.arrival_private, now);
  return existing.id;
}

/** The property's town and zone, kept on its location (the address schema.org and its guests read). */
async function setLocation(
  db: Db,
  locationId: string,
  input: Pick<UpsertPropertyInput, "town" | "timezone">,
): Promise<void> {
  if (input.town !== undefined) {
    const town = input.town?.trim() || null;
    await db.client.query({
      sql: town
        ? "UPDATE locations SET address = json_set(COALESCE(address, '{}'), '$.addressLocality', ?) WHERE id = ?"
        : "UPDATE locations SET address = json_remove(COALESCE(address, '{}'), '$.addressLocality') WHERE id = ?",
      params: town ? [town, locationId] : [locationId],
      method: "run",
    });
  }
  if (input.timezone !== undefined) {
    await db.client.query({
      sql: "UPDATE locations SET timezone = ? WHERE id = ?",
      params: [input.timezone, locationId],
      method: "run",
    });
  }
}

function childrenOf(c: UpsertPropertyInput["children"]) {
  if (!c) return undefined;
  return {
    welcome: c.welcome,
    ...(c.from_age !== undefined ? { fromAge: c.from_age } : {}),
    ...(c.free_under !== undefined ? { freeUnder: c.free_under } : {}),
    ...(c.cots !== undefined ? { cots: c.cots } : {}),
  };
}

function petsOf(p: UpsertPropertyInput["pets"]) {
  if (!p) return undefined;
  return { allowed: p.allowed, ...(p.fee_extra_id ? { feeExtraId: p.fee_extra_id } : {}) };
}

function pricesIncludeOf(p: UpsertPropertyInput["prices_include"]) {
  if (p === undefined) return undefined;
  if (p === null) return null;
  return { name: p.name, rateBp: p.rate_bp };
}

async function sealArrival(db: Db, secrets: SecretBox, id: string, text: string, now: number): Promise<void> {
  await db.client.query({
    sql: "UPDATE properties SET arrival_private_enc = ?, updated_at = ? WHERE id = ?",
    params: [await secrets.seal("arrival-details", id, text.trim()), now, id],
    method: "run",
  });
}

/** The private arrival details, opened at send time only. */
export async function openArrival(db: Db, secrets: SecretBox | null, propertyId: string): Promise<string | null> {
  if (!secrets) return null;
  const { rows } = await db.client.query({
    sql: "SELECT arrival_private_enc FROM properties WHERE id = ?",
    params: [propertyId],
    method: "all",
  });
  const sealed = rows[0]?.[0];
  if (typeof sealed !== "string") return null;
  try {
    return await secrets.open("arrival-details", propertyId, sealed);
  } catch {
    return null;
  }
}

/** A location no property has: the first one there is, else a new one named after the property. */
async function freeLocation(db: Db, name: string, now: number): Promise<string> {
  const { rows } = await db.client.query({
    sql: "SELECT l.id FROM locations l WHERE NOT EXISTS (SELECT 1 FROM properties p WHERE p.location_id = l.id) ORDER BY l.created_at LIMIT 1",
    params: [],
    method: "all",
  });
  if (rows[0]?.[0]) return String(rows[0][0]);
  const { timezone } = await businessZoneAndCurrency(db, await readSettings(db));
  const id = ulid(now);
  await db.client.query({
    sql: "INSERT INTO locations (id, name, timezone, address, created_at) VALUES (?, ?, ?, NULL, ?)",
    params: [id, name, timezone ? knownZone(timezone) : null, now],
    method: "run",
  });
  return id;
}

export async function upsertRoomType(db: Db, caller: Caller, input: UpsertRoomTypeInput): Promise<string> {
  requireOwner(caller);
  const now = nowOf(caller);
  if (input.capacity.adults > input.capacity.total || input.capacity.children > input.capacity.total) {
    throw new WriteError("invalid_input", "A room sleeps at most its total.", {
      fields: [
        { path: "capacity.total", problem: "invalid", message: "at least the adults and the children it sleeps" },
      ],
    });
  }
  const values = [
    input.name,
    input.description ?? null,
    input.units,
    JSON.stringify(input.capacity),
    JSON.stringify(input.beds),
    input.size_m2 ?? null,
    JSON.stringify(input.amenities),
    input.accessible ? 1 : 0,
    JSON.stringify(input.photos),
    input.external_id ?? null,
    input.offered ? 1 : 0,
    input.sort,
  ];
  if (input.id) {
    const r = await db.client.query({
      sql: `UPDATE room_types SET name = ?, description = ?, units = ?, capacity = ?, beds = ?, size_m2 = ?, amenities = ?,
                   accessible = ?, photos = ?, external_id = ?, offered = ?, sort = ?, active = 1, updated_at = ? WHERE id = ?`,
      params: [...values, now, input.id],
      method: "run",
    });
    if (r.changes !== 1) throw new WriteError("not_found", "There is no such room type.");
    return input.id;
  }
  const propertyId = await propertyIdFor(db, input.property_id);
  const id = ulid(now);
  await db.client.query({
    sql: `INSERT INTO room_types (name, description, units, capacity, beds, size_m2, amenities, accessible, photos, external_id,
            offered, sort, id, property_id, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    params: [...values, id, propertyId, now, now],
    method: "run",
  });
  return id;
}

/** A room type no longer offered: kept, so stays that had it still read it. */
export async function archiveRoomType(db: Db, caller: Caller, id: string): Promise<void> {
  requireOwner(caller);
  const r = await db.client.query({
    sql: "UPDATE room_types SET active = 0, offered = 0, updated_at = ? WHERE id = ?",
    params: [nowOf(caller), id],
    method: "run",
  });
  if (r.changes !== 1) throw new WriteError("not_found", "There is no such room type.");
}

function policyOf(p: PolicyPresetInput): { preset: string; policy: Policy } {
  if (p.preset === "free_until") {
    return {
      preset: `free_until:${p.days}:${p.after}:${p.no_show}`,
      policy: stayPolicySteps({ preset: "free_until", days: p.days, after: p.after, noShow: p.no_show }),
    };
  }
  if (p.preset === "non_refundable")
    return { preset: "non_refundable", policy: stayPolicySteps({ preset: "non_refundable" }) };
  return {
    preset: "custom",
    policy: stayPolicySteps({
      preset: "custom",
      steps: p.steps.map((s) => ({ daysBefore: s.days_before, fee: s.fee })),
      after: p.after,
      noShow: p.no_show,
    }),
  };
}

/** The policy a new plan starts with until the owner chooses: free until 3 days before, then the first night. */
const DEFAULT_POLICY: PolicyPresetInput = {
  preset: "free_until",
  days: 3,
  after: "first_night",
  no_show: "first_night",
};

export async function upsertRatePlan(db: Db, caller: Caller, input: UpsertRatePlanInput): Promise<string> {
  requireOwner(caller);
  const now = nowOf(caller);
  const ai = isOwnerAssistant(caller);
  if (
    input.policy !== undefined ||
    input.deposit !== undefined ||
    input.guarantee !== undefined ||
    input.balance !== undefined
  ) {
    requireInPerson(caller, "choose a rate's cancellation policy, its deposit and its card hold");
  }
  if (input.offered === true) requireInPerson(caller, "offer a rate to guests");
  if (input.deposit?.kind === "percent" && input.deposit.value === undefined) {
    throw new WriteError("invalid_input", "Say what share the deposit is.", {
      fields: [{ path: "deposit.value", problem: "missing", message: "1–100" }],
    });
  }
  if (input.guarantee === "card") await cardHoldsReady(db);
  const existingId = input.id;
  const propertyId = existingId ? await planProperty(db, existingId) : await propertyIdFor(db, input.property_id);
  if (input.derived) {
    const base = await planProperty(db, input.derived.from_plan_id).catch(() => null);
    if (base !== propertyId) {
      throw new WriteError("invalid_input", "A rate is derived from another rate of the same property.", {
        fields: [{ path: "derived.from_plan_id", problem: "invalid", message: "a rate of this property" }],
      });
    }
  }
  const statements: Statement[] = [];
  let policyId: string | null = null;
  if (input.policy || !existingId) {
    const { preset, policy } = policyOf(input.policy ?? DEFAULT_POLICY);
    policyId = ulid(now);
    statements.push({
      sql: "INSERT INTO stay_policies (id, property_id, preset, policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      params: [policyId, propertyId, preset, JSON.stringify(policy), now, now],
      method: "run",
    });
  }
  const id = existingId ?? ulid(now + 1);
  if (!existingId) {
    statements.push({
      sql: `INSERT INTO rate_plans (id, property_id, name, meal, policy_id, deposit, balance, guarantee, room_type_ids, derived,
              min_nights, max_nights, external_id, offered, active, sort, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      params: [
        id,
        propertyId,
        input.name,
        input.meal,
        policyId,
        JSON.stringify(input.deposit ?? { kind: "none" }),
        JSON.stringify(input.balance ?? { when: "at_property" }),
        input.guarantee ?? "none",
        input.room_type_ids ? JSON.stringify(input.room_type_ids) : null,
        input.derived
          ? JSON.stringify({ fromPlanId: input.derived.from_plan_id, percentOff: input.derived.percent_off })
          : null,
        input.min_nights,
        input.max_nights ?? null,
        input.external_id ?? null,
        // A rate the owner's AI made waits for the owner to offer it: money no.
        ai ? 0 : input.offered === false ? 0 : 1,
        input.sort,
        now,
        now,
      ],
      method: "run",
    });
  } else {
    if (ai && (await planOffered(db, existingId))) throw aiMoney("A rate guests are offered");
    const sets = ["name = ?", "meal = ?", "min_nights = ?", "sort = ?", "updated_at = ?"];
    const params: SqlInput[] = [input.name, input.meal, input.min_nights, input.sort, now];
    if (input.max_nights !== undefined) {
      sets.push("max_nights = ?");
      params.push(input.max_nights);
    }
    if (input.room_type_ids !== undefined) {
      sets.push("room_type_ids = ?");
      params.push(input.room_type_ids ? JSON.stringify(input.room_type_ids) : null);
    }
    if (input.external_id !== undefined) {
      sets.push("external_id = ?");
      params.push(input.external_id);
    }
    if (input.derived !== undefined) {
      sets.push("derived = ?");
      params.push(
        input.derived
          ? JSON.stringify({ fromPlanId: input.derived.from_plan_id, percentOff: input.derived.percent_off })
          : null,
      );
    }
    if (policyId) {
      sets.push("policy_id = ?");
      params.push(policyId);
    }
    if (input.deposit) {
      sets.push("deposit = ?");
      params.push(JSON.stringify(input.deposit));
    }
    if (input.balance) {
      sets.push("balance = ?");
      params.push(JSON.stringify(input.balance));
    }
    if (input.guarantee) {
      sets.push("guarantee = ?");
      params.push(input.guarantee);
    }
    if (input.offered !== undefined) {
      sets.push("offered = ?");
      params.push(input.offered ? 1 : 0);
    }
    statements.push({
      sql: `UPDATE rate_plans SET ${sets.join(", ")} WHERE id = ?`,
      params: [...params, existingId],
      method: "run",
    });
  }
  await db.batch(statements);
  return id;
}

/** Card holds need a payment platform that can take them, switched on: said before a plan offers one. */
async function cardHoldsReady(db: Db): Promise<void> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM connectors WHERE json_extract(config_public, '$.guarantees') = 1 AND status <> 'disabled' LIMIT 1",
    params: [],
    method: "all",
  });
  if (rows.length === 0) {
    throw new WriteError(
      "guard_failed",
      "Turn on card holds with Stripe first (Settings → Integrations): your key needs two more permissions.",
      {
        details: { reason: "card_holds_off" },
      },
    );
  }
}

async function planProperty(db: Db, planId: string): Promise<string> {
  const { rows } = await db.client.query({
    sql: "SELECT property_id FROM rate_plans WHERE id = ?",
    params: [planId],
    method: "all",
  });
  if (!rows[0]) throw new WriteError("not_found", "There is no such rate.");
  return String(rows[0][0]);
}

async function planOffered(db: Db, planId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT offered FROM rate_plans WHERE id = ?",
    params: [planId],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0) === 1;
}

export async function setRates(db: Db, caller: Caller, input: SetRatesInput): Promise<void> {
  requireOwner(caller);
  const now = nowOf(caller);
  if (isOwnerAssistant(caller) && (await planOffered(db, input.rate_plan_id)))
    throw aiMoney("The price of a rate guests are offered");
  const propertyId = await planProperty(db, input.rate_plan_id);
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM room_types WHERE id = ? AND property_id = ?",
    params: [input.room_type_id, propertyId],
    method: "all",
  });
  if (rows.length === 0)
    throw new WriteError("invalid_input", "That room type is not this rate's property's.", {
      fields: [{ path: "room_type_id", problem: "invalid", message: "a room type of the same property" }],
    });
  if (
    (input.from_date === "") !== (input.to_date === "") ||
    (input.from_date !== "" && daysBetween(input.from_date, input.to_date) < 0)
  ) {
    throw new WriteError(
      "invalid_input",
      "A season has a first and a last night, in order; the base price has neither.",
      {
        fields: [{ path: "to_date", problem: "invalid", message: "on or after from_date" }],
      },
    );
  }
  if (input.remove) {
    await db.client.query({
      sql: "DELETE FROM rates WHERE rate_plan_id = ? AND room_type_id = ? AND from_date = ? AND weekdays = ?",
      params: [input.rate_plan_id, input.room_type_id, input.from_date, input.weekdays],
      method: "run",
    });
    return;
  }
  await db.client.query({
    sql: `INSERT INTO rates (rate_plan_id, room_type_id, from_date, to_date, weekdays, nightly, base_guests, extra_adult, extra_child, min_nights)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (rate_plan_id, room_type_id, from_date, weekdays) DO UPDATE SET to_date = excluded.to_date,
            nightly = excluded.nightly, base_guests = excluded.base_guests, extra_adult = excluded.extra_adult,
            extra_child = excluded.extra_child, min_nights = excluded.min_nights`,
    params: [
      input.rate_plan_id,
      input.room_type_id,
      input.from_date,
      input.to_date,
      input.weekdays,
      input.nightly,
      input.base_guests,
      input.extra_adult ?? null,
      input.extra_child ?? null,
      input.min_nights ?? null,
    ],
    method: "run",
  });
  void now;
}

/** The property's taxes and fees, all of them at once: what is not in the list is switched off. */
export async function setFees(db: Db, caller: Caller, input: SetStayFeesInput): Promise<void> {
  requireOwner(caller);
  const now = nowOf(caller);
  const propertyId = await propertyIdFor(db, input.property_id);
  if (isOwnerAssistant(caller) && (await pricesLive(db, propertyId)))
    throw aiMoney("A tax or fee on rates guests are offered");
  input.fees.forEach((f, i) => {
    const basisPercent = f.basis === "percent_of_room";
    const priced = f.tiers?.length ? true : basisPercent ? f.rate_bp != null : f.amount != null;
    if (!priced) {
      throw new WriteError("invalid_input", "Say what it comes to: an amount, a percentage of the room, or steps.", {
        fields: [{ path: `fees.${i}`, problem: "missing", message: basisPercent ? "rate_bp" : "amount" }],
      });
    }
  });
  const statements: Statement[] = [
    {
      sql: "UPDATE stay_fees SET active = 0, updated_at = ? WHERE property_id = ?",
      params: [now, propertyId],
      method: "run",
    },
  ];
  input.fees.forEach((f, i) => {
    const id = f.id ?? ulid(now + i);
    const tiers = f.tiers
      ? JSON.stringify(
          f.tiers.map((t) => ({
            upToNightly: t.up_to_nightly,
            ...(t.amount !== undefined ? { amount: t.amount } : {}),
            ...(t.rate_bp !== undefined ? { rateBp: t.rate_bp } : {}),
          })),
        )
      : null;
    statements.push({
      sql: `INSERT INTO stay_fees (id, property_id, name, kind, basis, amount, rate_bp, tiers, collected, child_exempt_under, max_nights,
              active, sort, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, basis = excluded.basis, amount = excluded.amount,
              rate_bp = excluded.rate_bp, tiers = excluded.tiers, collected = excluded.collected,
              child_exempt_under = excluded.child_exempt_under, max_nights = excluded.max_nights, active = excluded.active,
              sort = excluded.sort, updated_at = excluded.updated_at
            WHERE stay_fees.property_id = excluded.property_id`,
      params: [
        id,
        propertyId,
        f.name,
        f.kind,
        f.basis,
        f.amount ?? null,
        f.rate_bp ?? null,
        tiers,
        f.collected,
        f.child_exempt_under ?? null,
        f.max_nights ?? null,
        f.active ? 1 : 0,
        i,
        now,
        now,
      ],
      method: "run",
    });
  });
  await db.batch(statements);
}

export async function upsertExtra(
  db: Db,
  caller: Caller,
  input: {
    id?: string | undefined;
    property_id?: string | undefined;
    item: string;
    name: string;
    price: number;
    basis: string;
    active: boolean;
  },
): Promise<string> {
  requireOwner(caller);
  const now = nowOf(caller);
  const propertyId = await propertyIdFor(db, input.property_id);
  if (isOwnerAssistant(caller) && (await pricesLive(db, propertyId)))
    throw aiMoney("An extra's price on rates guests are offered");
  const id = input.id ?? ulid(now);
  await db.client.query({
    sql: `INSERT INTO stay_extras (id, property_id, item, name, price, basis, active, sort, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT (id) DO UPDATE SET item = excluded.item, name = excluded.name, price = excluded.price, basis = excluded.basis,
            active = excluded.active, updated_at = excluded.updated_at WHERE stay_extras.property_id = excluded.property_id`,
    params: [id, propertyId, input.item, input.name, input.price, input.basis, input.active ? 1 : 0, now, now],
    method: "run",
  });
  return id;
}

/**
 * Rooms the owner keeps for direct guests, closed on every other channel (§4.1): what confirms at once
 * in allotment mode. Only a person sets one, and says the rooms are closed elsewhere.
 */
export async function setAllotment(
  db: Db,
  caller: Caller,
  input: { room_type_id: string; from_date: string; to_date: string; weekdays: number; units: number },
): Promise<void> {
  requireInPerson(caller, "keep rooms for direct guests");
  const now = nowOf(caller);
  if (daysBetween(input.from_date, input.to_date) < 0) {
    throw new WriteError("invalid_input", "The last night is on or after the first.", {
      fields: [{ path: "to_date", problem: "invalid", message: "on or after from_date" }],
    });
  }
  const { rows } = await db.client.query({
    sql: "SELECT units FROM room_types WHERE id = ?",
    params: [input.room_type_id],
    method: "all",
  });
  if (!rows[0]) throw new WriteError("not_found", "There is no such room type.");
  if (input.units > Number(rows[0][0])) {
    throw new WriteError("invalid_input", `You have ${Number(rows[0][0])} of these rooms.`, {
      fields: [{ path: "units", problem: "invalid", message: "at most the rooms you have" }],
    });
  }
  const who = caller.actor.id ?? caller.actor.kind;
  if (input.units === 0) {
    await db.client.query({
      sql: "DELETE FROM allotments WHERE room_type_id = ? AND from_date = ? AND weekdays = ?",
      params: [input.room_type_id, input.from_date, input.weekdays],
      method: "run",
    });
    return;
  }
  await db.client.query({
    sql: `INSERT INTO allotments (room_type_id, from_date, to_date, weekdays, units, closed_elsewhere_at, set_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (room_type_id, from_date, weekdays) DO UPDATE SET to_date = excluded.to_date, units = excluded.units,
            closed_elsewhere_at = excluded.closed_elsewhere_at, set_by = excluded.set_by`,
    params: [input.room_type_id, input.from_date, input.to_date, input.weekdays, input.units, now, `user:${who}`],
    method: "run",
  });
}

/** Nights the owner closes (or opens again) for a room type or the whole property. */
export async function closeNights(
  db: Db,
  caller: Caller,
  input: {
    property_id?: string | undefined;
    room_type_id?: string | undefined;
    from_date: string;
    to_date: string;
    note?: string | undefined;
    reopen?: boolean | undefined;
  },
): Promise<void> {
  requireOwner(caller);
  const now = nowOf(caller);
  const propertyId = await propertyIdFor(db, input.property_id);
  if (input.reopen) {
    await db.client.query({
      sql: "DELETE FROM stay_closures WHERE property_id = ? AND room_type_id = ? AND from_date = ?",
      params: [propertyId, input.room_type_id ?? "", input.from_date],
      method: "run",
    });
    return;
  }
  await db.client.query({
    sql: `INSERT INTO stay_closures (property_id, room_type_id, from_date, to_date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (property_id, room_type_id, from_date) DO UPDATE SET to_date = excluded.to_date, note = excluded.note`,
    params: [propertyId, input.room_type_id ?? "", input.from_date, input.to_date, input.note ?? null, now],
    method: "run",
  });
}

/** Whether this inbox is a place to stay: it has a property with a room type offered. */
export async function isPlaceToStay(db: Db): Promise<boolean> {
  return (await listProperties(db, { active: true })).length > 0;
}

export { readSetup };
