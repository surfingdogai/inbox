import { bedTypeSchema, extraItemSchema, lodgingKindSchema, mealSchema, stayQuoteSchema } from "@surfingdog/spec";
import { z } from "zod";
import { contactSchema, moneySchema } from "../domain/types";

/**
 * The inputs of the stays doors (ADR-033 §6): the guest's assistant's tools, and the owner's. Every
 * door validates against these, so an agent gets the same field-level error whichever way it comes in.
 * Top-level fields are snake_case, as every other door's.
 */

const date = z.iso.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const id = z.string().min(1).max(64);
const accessToken = z.string().min(16).max(200).optional();
const idempotencyKey = z.string().min(1).max(200).optional().describe("Same key + same request = same answer.");
const sha = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .optional();
const pass = z
  .string()
  .max(8 * 201)
  .optional();
const key = z.string().max(200).optional();
const carried = { pass, key };

/** One room as the guest asks for it: who sleeps in it, and the room type when they chose one. */
const guestRoom = z.object({
  room_type_id: id.optional().describe("A room type from get_property; any room for these guests when left out."),
  rate_plan_id: id.optional(),
  adults: z.int().min(1).max(20),
  children_ages: z.array(z.int().min(0).max(17)).max(10).default([]).describe("Each child's age on arrival."),
  extras: z
    .array(z.object({ extra_id: id, quantity: z.int().min(1).max(20) }))
    .max(10)
    .default([]),
});
export type GuestRoom = z.infer<typeof guestRoom>;

const dates = {
  check_in: date.describe("Arrival date, the property's own, YYYY-MM-DD."),
  check_out: date.describe("Departure date, after check_in."),
};

export const getPropertyInput = z.object({ property_id: id.optional() });

export const checkStayAvailabilityInput = z.object({
  property_id: id.optional(),
  ...dates,
  adults: z.int().min(1).max(20).default(2),
  children_ages: z.array(z.int().min(0).max(17)).max(10).default([]),
  rooms: z.int().min(1).max(9).default(1).describe("How many rooms, the guests shared between them."),
  room_type_id: id.optional(),
});

export const quoteStayInput = z.object({
  property_id: id.optional(),
  ...dates,
  rooms: z.array(guestRoom).min(1).max(9),
  offer_id: z
    .string()
    .max(120)
    .optional()
    .describe("An offer you were given before: the answer says if its totals changed."),
});

export const requestStayInput = z.object({
  property_id: id.optional(),
  ...dates,
  rooms: z.array(guestRoom).min(1).max(9),
  guests: z
    .object({
      lead: z.object({ name: z.string().min(1).max(200) }),
      others: z
        .array(z.object({ name: z.string().max(200) }))
        .max(40)
        .default([]),
    })
    .optional(),
  arrival: z.object({ from: hhmm, to: hhmm }).optional().describe("When the guests expect to arrive."),
  requests: z.string().max(2_000).optional().describe("Special requests, in the guest's words."),
  contact: contactSchema.describe("How the property reaches the guest."),
  consent: z.literal(true).describe("The guest agreed that their request, with these details, goes to the property."),
  message: z.string().max(20_000).optional(),
  idempotency_key: idempotencyKey,
  ...carried,
});

export const holdStayInput = requestStayInput.extend({
  offer_id: z.string().max(120).optional().describe("The offer from check_stay_availability or quote_stay."),
});

export const bookStayInput = z.object({
  item_id: z.string().min(1).describe("The held stay, from hold_stay."),
  terms_sha: sha.describe(
    "The fingerprint of the terms your person said yes to; without it, the answer gives the terms.",
  ),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

export const changeStayInput = z.object({
  item_id: z.string().min(1),
  ...dates,
  rooms: z.array(guestRoom).min(1).max(9).optional(),
  terms_sha: sha.describe("The fingerprint of the new terms your person saw; without it, the answer gives them first."),
  note: z.string().max(2_000).optional(),
  access_token: accessToken,
  idempotency_key: idempotencyKey,
  ...carried,
});

// ---- the owner's ----------------------------------------------------------------

const capacity = z.object({
  adults: z.int().min(1).max(40),
  children: z.int().min(0).max(20),
  total: z.int().min(1).max(60),
});

export const upsertPropertyInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  kind: lodgingKindSchema.optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  location_id: id.optional(),
  /** The town the property is in: what its guests read a time by ("23:59 Oaxaca time"), and its address. */
  town: z.string().trim().max(80).nullable().optional(),
  /** The property's own time zone, where it is not the business's: as its system keeps it, say. */
  timezone: z.string().trim().min(1).max(64).optional(),
  check_in_from: hhmm.optional(),
  check_in_until: hhmm.nullable().optional(),
  check_out_until: hhmm.optional(),
  same_day_until: hhmm.nullable().optional(),
  answer_hours: z.union([z.literal(1), z.literal(4), z.literal(12), z.literal(24)]).optional(),
  quote_valid_hours: z.union([z.literal(2), z.literal(12), z.literal(24), z.literal(48)]).optional(),
  pay_within_hours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(48)]).optional(),
  hold_minutes: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(60)]).optional(),
  max_nights: z.int().min(1).max(90).optional(),
  children: z
    .object({
      welcome: z.boolean(),
      from_age: z.int().min(0).max(17).optional(),
      free_under: z.int().min(0).max(17).optional(),
      cots: z.boolean().optional(),
    })
    .optional(),
  pets: z.object({ allowed: z.enum(["no", "yes", "ask"]), fee_extra_id: id.optional() }).optional(),
  house_rules: z
    .object({
      chips: z.array(z.string().max(40)).max(10),
      quiet: z.tuple([hhmm, hhmm]).optional(),
      text: z.string().max(500).optional(),
    })
    .optional(),
  arrival_public: z.string().max(1_000).nullable().optional().describe("How to find the property: public."),
  arrival_private: z
    .string()
    .max(2_000)
    .nullable()
    .optional()
    .describe("Door codes, key box, wifi: sealed, sent only to confirmed guests."),
  pre_arrival_text: z.string().max(2_000).nullable().optional(),
  prices_include: z
    .object({ name: z.string().min(1).max(40), rate_bp: z.int().min(1).max(10_000) })
    .nullable()
    .optional(),
  // The owner's alone, in person (ADR-033 D10): how it confirms, and the register it is in.
  mode: z.enum(["request", "allotment", "connected"]).optional(),
  instant: z.boolean().optional(),
  fresh_minutes: z.union([z.literal(5), z.literal(15), z.literal(60)]).optional(),
  registration: z
    .object({ required: z.boolean(), number: z.string().trim().max(60).optional() })
    .nullable()
    .optional(),
  connector_id: id.nullable().optional(),
  external_id: z.string().max(120).nullable().optional(),
  active: z.boolean().optional(),
});
export type UpsertPropertyInput = z.infer<typeof upsertPropertyInput>;

export const upsertRoomTypeInput = z.object({
  id: id.optional(),
  property_id: id.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1_000).nullable().optional(),
  units: z.int().min(1).max(500).default(1),
  capacity,
  beds: z
    .array(z.object({ type: bedTypeSchema, count: z.int().min(1).max(20) }))
    .max(8)
    .default([]),
  size_m2: z.int().min(1).max(2_000).nullable().optional(),
  amenities: z.array(z.string().max(40)).max(30).default([]),
  accessible: z.boolean().default(false),
  photos: z.array(z.url()).max(8).default([]),
  external_id: z.string().max(120).nullable().optional(),
  offered: z.boolean().default(true),
  sort: z.int().min(0).max(10_000).default(0),
});
export type UpsertRoomTypeInput = z.infer<typeof upsertRoomTypeInput>;

const policyFee = z.union([
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("percent"), value: z.int().min(1).max(100) }),
  z.object({ kind: z.literal("amount"), value: z.int().min(1) }),
  z.object({ kind: z.literal("units"), value: z.int().min(1).max(30) }),
  z.object({ kind: z.literal("full") }),
]);

export const policyPresetInput = z.union([
  z.object({
    preset: z.literal("free_until"),
    days: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(7), z.literal(14), z.literal(30)]),
    after: z.enum(["first_night", "half", "full"]).describe("What cancelling costs once the free days are over."),
    no_show: z.enum(["first_night", "full"]),
  }),
  z.object({ preset: z.literal("non_refundable") }),
  z.object({
    preset: z.literal("custom"),
    steps: z
      .array(z.object({ days_before: z.int().min(0).max(365), fee: policyFee }))
      .min(1)
      .max(4),
    after: policyFee,
    no_show: policyFee,
  }),
]);
export type PolicyPresetInput = z.infer<typeof policyPresetInput>;

export const upsertRatePlanInput = z.object({
  id: id.optional(),
  property_id: id.optional(),
  name: z.string().trim().min(1).max(80),
  meal: mealSchema.default("room_only"),
  room_type_ids: z.array(id).max(100).nullable().optional(),
  min_nights: z.int().min(1).max(30).default(1),
  max_nights: z.int().min(1).max(90).nullable().optional(),
  external_id: z.string().max(120).nullable().optional(),
  offered: z.boolean().optional(),
  sort: z.int().min(0).max(10_000).default(0),
  // The owner's alone, in person: what a stay on it costs to cancel, and how it is secured.
  policy: policyPresetInput.optional(),
  deposit: z
    .object({ kind: z.enum(["none", "first_night", "percent", "full"]), value: z.int().min(1).max(100).optional() })
    .optional(),
  balance: z
    .object({ when: z.enum(["at_property", "days_before"]), days: z.int().min(1).max(60).optional() })
    .optional(),
  guarantee: z.enum(["none", "card"]).optional(),
  derived: z
    .object({ from_plan_id: id, percent_off: z.int().min(1).max(90) })
    .nullable()
    .optional(),
});
export type UpsertRatePlanInput = z.infer<typeof upsertRatePlanInput>;

export const setRatesInput = z.object({
  rate_plan_id: id,
  room_type_id: id,
  /** Both empty: the base price; a range: a season. */
  from_date: z.union([date, z.literal("")]).default(""),
  to_date: z.union([date, z.literal("")]).default(""),
  /** Monday 1 … Sunday 64; 127 every day, 48 Friday and Saturday. */
  weekdays: z.int().min(1).max(127).default(127),
  nightly: z.int().min(0),
  base_guests: z.int().min(1).max(20).default(2),
  extra_adult: z.int().min(0).nullable().optional(),
  extra_child: z.int().min(0).nullable().optional(),
  min_nights: z.int().min(1).max(30).nullable().optional(),
  remove: z.boolean().optional(),
});
export type SetRatesInput = z.infer<typeof setRatesInput>;

export const stayFeeInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["tax", "fee"]),
  basis: z.enum(["per_stay", "per_night", "per_room_night", "per_person_night", "percent_of_room"]),
  amount: z.int().min(0).nullable().optional(),
  rate_bp: z.int().min(1).max(10_000).nullable().optional(),
  tiers: z
    .array(
      z.object({
        up_to_nightly: z.int().min(0).nullable(),
        amount: z.int().min(0).optional(),
        rate_bp: z.int().min(1).max(10_000).optional(),
      }),
    )
    .max(6)
    .nullable()
    .optional(),
  collected: z.enum(["with_booking", "at_property"]).default("with_booking"),
  child_exempt_under: z.int().min(0).max(17).nullable().optional(),
  max_nights: z.int().min(1).max(90).nullable().optional(),
  active: z.boolean().default(true),
});
export const setStayFeesInput = z.object({ property_id: id.optional(), fees: z.array(stayFeeInput).max(20) });
export type SetStayFeesInput = z.infer<typeof setStayFeesInput>;

export const upsertStayExtraInput = z.object({
  id: id.optional(),
  property_id: id.optional(),
  item: extraItemSchema,
  name: z.string().trim().min(1).max(80),
  price: z.int().min(0),
  basis: z.enum(["per_stay", "per_night", "per_person_night"]),
  active: z.boolean().default(true),
});

export const setAllotmentInput = z.object({
  room_type_id: id,
  from_date: date,
  to_date: date,
  weekdays: z.int().min(1).max(127).default(127),
  units: z.int().min(0).max(500),
  closed_elsewhere: z.literal(true).describe("These rooms are closed on the property's other channels: required."),
});

export const closeNightsInput = z.object({
  property_id: id.optional(),
  room_type_id: id.optional().describe("One room type; the whole property when left out."),
  from_date: date,
  to_date: date,
  note: z.string().max(200).optional(),
  reopen: z.boolean().optional(),
});

export const nightsInput = z.object({
  property_id: id.optional(),
  from: date.optional(),
  days: z.int().min(1).max(31).default(14),
});

export const draftQuoteInput = z.object({
  item_id: z.string().min(1),
  rooms: z
    .array(z.object({ index: z.int().min(0).max(8), room_type_id: id, rate_plan_id: id.optional() }))
    .max(9)
    .optional(),
  /** The owner's own price for the room nights, where the rates do not cover them. */
  price: moneySchema.optional(),
});

export const mapSystemInput = z.object({
  connector_id: id,
  external_property_id: z.string().min(1).max(120),
  property_id: id.optional(),
  rooms: z
    .array(z.object({ external_id: z.string().min(1).max(120), room_type_id: z.union([id, z.literal("new")]) }))
    .max(200),
});

export const sendQuoteInput = z.object({
  item_id: z.string().min(1),
  quote: stayQuoteSchema.optional(),
  from: z.literal("rates").optional(),
  valid_hours: z.int().min(1).max(168).optional(),
  note: z.string().max(2_000).optional(),
});

export const paymentRecordInput = z.object({
  item_id: z.string().min(1),
  payment_ref: z.string().min(1).max(200),
  amount: moneySchema.optional(),
  schedule_id: z.string().min(1).max(64).optional(),
});
