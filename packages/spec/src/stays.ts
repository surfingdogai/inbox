import { z } from "zod";
import vocabulary from "../vocab/lodging.json" with { type: "json" };
import { lodgingKindSchema, moneySchema } from "./base";
import { datedPolicySchema, type Policy, type PolicyFee } from "./policy";

/**
 * Stays (spec 0.11, ADR-037): a place to stay in its own inbox. The guest's assistant asks for dates,
 * rooms and guests; the property answers with its own total, its policy as dated steps, a payment
 * schedule and an expiry (a binding quote), or, where it cannot sell a room twice, confirms at once.
 * These are the shapes shared with agents and networks; the inbox keeps them on its `stay` items.
 *
 * Dates are the property's local dates (`YYYY-MM-DD`): a stay's nights are the date difference, never
 * minutes, so no change of clocks can shift one. Amounts are minor units of the property's currency.
 */

/** The vocabulary of `vocab/lodging.json`: kinds, beds, amenities, meals, house rules, fee bases, extras. */
export const LODGING_VOCABULARY = vocabulary as unknown as {
  readonly version: number;
  readonly kinds: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly beds: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly amenities: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly meals: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly house_rules: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly fee_bases: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly extras: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

const keys = (o: Readonly<Record<string, unknown>>) => Object.keys(o) as [string, ...string[]];
export const bedTypeSchema = z.enum(keys(LODGING_VOCABULARY.beds));
export const mealSchema = z.enum(keys(LODGING_VOCABULARY.meals));
export const extraItemSchema = z.enum(keys(LODGING_VOCABULARY.extras));
export const feeBasisSchema = z.enum(keys(LODGING_VOCABULARY.fee_bases));

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const isoDateTime = z.iso.datetime({ offset: true });
const currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 in capitals");

/** One line of a stay's price: what it is, its words, its amount and who collects it. */
export const stayQuoteLineSchema = z.object({
  type: z.enum(["subtotal", "extra", "fee", "tax", "discount"]),
  label: z.string().min(1).max(200).describe("Double room, 3 nights · City tax (paid at the property)"),
  amount: z.int().describe("Minor units of the quote's currency; a discount is negative."),
  collected: z.enum(["with_booking", "at_property"]),
  nights: z
    .array(z.object({ night: z.iso.date(), amount: z.int() }))
    .max(90)
    .optional()
    .describe("A room line's price night by night."),
});
export type StayQuoteLine = z.infer<typeof stayQuoteLineSchema>;

/** One entry of a stay's payment schedule: now, by a date, or at the property. */
export const stayScheduleEntrySchema = z.object({
  id: z.string().min(1).max(64).describe("deposit, balance, at_property, difference-1"),
  type: z.enum(["immediate", "deferred", "at_property"]),
  amount: moneySchema,
  dueAt: isoDateTime.optional(),
  label: z.string().min(1).max(200),
});
export type StayScheduleEntry = z.infer<typeof stayScheduleEntrySchema>;

/**
 * A property's quote for one stay: every line in its total (taxes and fees collected at the property
 * included), its rate plan, its cancellation policy dated for these dates, its payment schedule, and
 * until when it can be accepted. Its lines add up to its total, and so does its schedule.
 */
export const stayQuoteSchema = z.object({
  currency,
  lines: z.array(stayQuoteLineSchema).min(1).max(40),
  total: moneySchema,
  ratePlan: z.object({
    id: z.string().max(64).optional(),
    name: z.string().min(1).max(80),
    meal: mealSchema,
    refundable: z.boolean(),
  }),
  policy: datedPolicySchema,
  schedule: z.array(stayScheduleEntrySchema).min(1).max(4),
  guarantee: z.enum(["none", "card"]),
  includes: z.array(z.string().max(60)).max(10).default([]),
  validThrough: isoDateTime,
  source: z.enum(["person", "rates", "connected", "allotment"]),
  notes: z.string().max(2_000).optional(),
});
export type StayQuote = z.infer<typeof stayQuoteSchema>;

/** What a property's rates give for a stay before it answers: never binding, never an offer. */
export const stayEstimateSchema = stayQuoteSchema.extend({ binding: z.literal(false) });
export type StayEstimate = z.infer<typeof stayEstimateSchema>;

/**
 * Whether a quote holds together, as the inbox checks one before it is sent and an agent may check one
 * it is given: the lines add up to the total; the schedule does too; what is paid at the property
 * covers every line collected there; one currency throughout; every fee is at most the total; the
 * policy's steps are in order and before arrival; and it can still be accepted, until before arrival.
 * Empty when it does.
 */
export function checkStayTotals(
  quote: Pick<StayQuote, "currency" | "lines" | "total" | "schedule" | "policy" | "validThrough">,
  at: { readonly now?: number | undefined; readonly arrivalAt?: number | undefined } = {},
): string[] {
  const problems: string[] = [];
  const cur = quote.currency;
  const sum = quote.lines.reduce((a, l) => a + l.amount, 0);
  if (quote.total.currency !== cur) problems.push(`the total is in ${quote.total.currency}, the quote in ${cur}`);
  if (sum !== quote.total.value) problems.push(`the lines add up to ${sum}, not ${quote.total.value}`);
  if (quote.total.value < 0) problems.push("the total is below nothing");
  let scheduled = 0;
  let atProperty = 0;
  for (const s of quote.schedule) {
    if (s.amount.currency !== cur) problems.push(`schedule ${s.id} is in ${s.amount.currency}, the quote in ${cur}`);
    if (s.amount.value < 0) problems.push(`schedule ${s.id} is below nothing`);
    scheduled += s.amount.value;
    if (s.type === "at_property") atProperty += s.amount.value;
    if (s.type === "deferred" && !s.dueAt) problems.push(`schedule ${s.id} is deferred with no date`);
  }
  if (new Set(quote.schedule.map((s) => s.id)).size !== quote.schedule.length)
    problems.push("two schedules share an id");
  if (scheduled !== quote.total.value) problems.push(`the schedule adds up to ${scheduled}, not ${quote.total.value}`);
  const collectedThere = quote.lines.filter((l) => l.collected === "at_property").reduce((a, l) => a + l.amount, 0);
  if (atProperty < collectedThere) {
    problems.push(`${collectedThere} is collected at the property, but the schedule leaves ${atProperty} for it`);
  }
  const fees = [...quote.policy.steps.map((s) => s.fee), quote.policy.after, quote.policy.noShow];
  for (const f of fees) {
    if (f.currency !== cur) problems.push(`a cancellation fee is in ${f.currency}, the quote in ${cur}`);
    if (f.value > quote.total.value) problems.push(`a cancellation fee of ${f.value} is more than the total`);
  }
  let last = Number.NEGATIVE_INFINITY;
  for (const s of quote.policy.steps) {
    const until = Date.parse(s.until);
    if (!(until > last)) problems.push("the policy's steps are not in order");
    if (at.arrivalAt !== undefined && until > at.arrivalAt) problems.push("a policy step ends after arrival");
    last = until;
  }
  const valid = Date.parse(quote.validThrough);
  if (at.now !== undefined && !(valid > at.now)) problems.push("it can no longer be accepted");
  if (at.arrivalAt !== undefined && !(valid < at.arrivalAt)) problems.push("it can be accepted until after arrival");
  return problems;
}

/** A preset cancellation policy, as an owner chooses one (S6), as policy data. */
export type StayPolicyPreset =
  | {
      readonly preset: "free_until";
      readonly days: number;
      readonly after: "first_night" | "half" | "full";
      readonly noShow: "first_night" | "full";
    }
  | { readonly preset: "non_refundable" }
  | {
      readonly preset: "custom";
      readonly steps: readonly { readonly daysBefore: number; readonly fee: PolicyFee }[];
      readonly after: PolicyFee;
      readonly noShow: PolicyFee;
    };

const FEE: Readonly<Record<"first_night" | "half" | "full", PolicyFee>> = {
  first_night: { kind: "units", value: 1 },
  half: { kind: "percent", value: 50 },
  full: { kind: "full" },
};

/** A preset as the steps it stands for: "free until 3 days before, then the first night". */
export function stayPolicySteps(p: StayPolicyPreset): Policy {
  if (p.preset === "non_refundable") return { steps: [], after: { kind: "full" }, noShow: { kind: "full" } };
  if (p.preset === "free_until") {
    return {
      steps: [{ before: { days: p.days }, fee: { kind: "none" } }],
      after: FEE[p.after],
      noShow: FEE[p.noShow],
    };
  }
  return {
    steps: [...p.steps]
      .sort((a, b) => b.daysBefore - a.daysBefore)
      .slice(0, 4)
      .map((s) => ({ before: { days: s.daysBefore }, fee: s.fee })),
    after: p.after,
    noShow: p.noShow,
  };
}

/** The variables a stay's deep link may carry, and nothing else. */
export const STAY_TEMPLATE_VARIABLES = ["check_in", "check_out", "adults", "children", "rooms"] as const;

/**
 * A booking engine's deep link for a stay (`doors_elsewhere[].url_template`): each known variable
 * filled in, URL-encoded; any other `{…}` dropped. Null when what is left is not an https address on a
 * named host with no user or password, as a door elsewhere must be.
 */
export function fillStayTemplate(
  template: string,
  values: {
    readonly check_in: string;
    readonly check_out: string;
    readonly adults: number;
    readonly children?: number | undefined;
    readonly rooms?: number | undefined;
  },
): string | null {
  if (template.length > 2048) return null;
  const filled = template.replace(/\{([a-z_]{1,20})\}/g, (_m, name: string) => {
    const v = (values as Record<string, unknown>)[name];
    if (!(STAY_TEMPLATE_VARIABLES as readonly string[]).includes(name) || v === undefined) return "";
    return encodeURIComponent(String(v));
  });
  let url: URL;
  try {
    url = new URL(filled);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const labels = url.hostname.replace(/\.$/, "").split(".");
  if (labels.length < 2 || !/^[a-z]/i.test(labels[labels.length - 1] ?? "")) return null;
  return filled;
}

/** What `check_stay_availability` answers for one room type and rate plan. */
export const stayOptionSchema = z.object({
  room_type: z.object({
    id: z.string(),
    name: z.string(),
    capacity: z.object({ adults: z.int(), children: z.int(), total: z.int() }),
  }),
  rate_plan: z
    .object({ id: z.string(), name: z.string(), meal: mealSchema, refundable: z.boolean() })
    .optional()
    .describe("Absent when the property gives no price ahead: it answers with its own."),
  status: z.enum(["instant", "on_request", "unavailable"]),
  likely_taken: z.boolean().optional().describe("Another calendar of the property's shows these nights as taken."),
  reason: z.string().max(200).optional(),
  offer: z
    .object({ offer_id: z.string(), valid_through: isoDateTime, quote: stayQuoteSchema })
    .optional()
    .describe("Instant only: a signed offer to hold or book, until valid_through."),
  estimate: stayEstimateSchema.optional().describe("On request: the property's rates for these dates, never binding."),
});

export const stayAvailabilitySchema = z.object({
  property: z.object({ id: z.string(), name: z.string() }),
  check_in: z.iso.date(),
  check_out: z.iso.date(),
  nights: z.int().min(1),
  currency,
  options: z.array(stayOptionSchema).max(60),
  answers_within_h: z.int().min(1).max(168),
  confirmation: z.enum(["request", "instant_some", "instant"]),
});
export type StayAvailability = z.infer<typeof stayAvailabilitySchema>;

/** A property as `get_property` shows it to agents: never its private arrival details. */
export const propertyPublicSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: lodgingKindSchema,
  currency,
  timezone: z.string(),
  check_in_from: hhmm,
  check_in_until: hhmm.nullable(),
  check_out_until: hhmm,
  rooms: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        capacity: z.object({ adults: z.int(), children: z.int(), total: z.int() }),
        beds: z.array(z.object({ type: bedTypeSchema, count: z.int().min(1) })),
        size_m2: z.int().nullable(),
        amenities: z.array(z.string()),
        accessible: z.boolean(),
        photos: z.array(z.url()).max(8),
      }),
    )
    .max(100),
  rate_plans: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        meal: mealSchema,
        refundable: z.boolean(),
        secure: z.enum(["at_property", "deposit", "card"]),
        policy: z.string().describe("The cancellation policy in words, before any dates."),
        min_nights: z.int().min(1),
      }),
    )
    .max(40),
  extras: z
    .array(z.object({ id: z.string(), item: extraItemSchema, name: z.string(), price: moneySchema, basis: z.string() }))
    .max(40),
  taxes_and_fees: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(["tax", "fee"]),
        basis: feeBasisSchema,
        collected: z.enum(["with_booking", "at_property"]),
      }),
    )
    .max(40),
  children: z.object({
    welcome: z.boolean(),
    from_age: z.int().optional(),
    free_under: z.int().optional(),
    cots: z.boolean().optional(),
  }),
  pets: z.enum(["no", "yes", "ask"]),
  house_rules: z.object({
    chips: z.array(z.string()),
    quiet: z.tuple([hhmm, hhmm]).optional(),
    text: z.string().optional(),
  }),
  how_to_find_us: z.string().nullable(),
  payments: z.array(z.string()).describe("How guests can pay: tokens of vocab/payments.json."),
  confirmation: z.string().describe("The property's own sentence on how it confirms stays."),
  answers_within_h: z.int(),
  registration: z
    .string()
    .nullable()
    .describe("The property's short-term rental registration number, where one is required."),
});
export type PropertyPublic = z.infer<typeof propertyPublicSchema>;
