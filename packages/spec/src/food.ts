import { z } from "zod";
import vocabulary from "../vocab/allergens.json" with { type: "json" };
import { moneySchema } from "./base";
import { postalPrefixSchema } from "./trades";

/**
 * Restaurants, takeaways, bakeries and cafés (spec 0.11, ADR-036): the menu, its allergens, ordering
 * for a time, and a kitchen's progress.
 *
 * - **Allergens.** `vocab/allergens.json` names the allergens the law makes a food business declare in
 *   the EU, the UK, the US, Canada, Australia, New Zealand and Japan, keyed by code, with labels in seven
 *   languages. A dish says what it `contains` and what it `may_contain`, and whether a person at the
 *   business `confirmed` it. Allergens are never inferred: what an import or an assistant filled in is
 *   `unconfirmed`, and an unconfirmed answer is "ask the business", never "free from".
 * - **Menu.** Sections of items with option groups (one level of nesting: a pizza's size opens its
 *   crust), halves for half-and-half, dietary tags, an age limit, the times of day an item is served
 *   (dayparts), the notice a made-to-order item needs, and whether it is sold out today.
 * - **Ordering for a time.** An order says how it is fulfilled (`fulfilSchema`): collected, delivered or
 *   eaten in, at a slot the kitchen offers (`list_order_slots`); the inbox adds the delivery zone and its
 *   fee. A tip, where the business takes one, goes on the business's own pay link.
 * - **Progress.** Inside fulfilling, the kitchen says preparing, ready or out for delivery, with when it
 *   expects it (`orderProgressSchema`): fields on the order, not states of it.
 */

/* --- the allergen vocabulary ---------------------------------------------------- */

export type AllergenLang = "en" | "es" | "fr" | "de" | "it" | "pt" | "ja";
export const JURISDICTIONS = ["EU", "GB", "US", "CA", "AU", "NZ", "JP"] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

export interface AllergenEntry {
  readonly code: string;
  /** What it is a part of: walnut of tree nuts, wheat of cereals with gluten. */
  readonly parent: string | null;
  readonly mandatory_in: readonly Jurisdiction[];
  readonly recommended_in: readonly Jurisdiction[];
  readonly labels: Readonly<Record<AllergenLang, string>>;
  readonly note?: string | undefined;
}

export const ALLERGENS_VOCABULARY = vocabulary as unknown as {
  readonly version: number;
  readonly as_of: string;
  readonly description: string;
  readonly languages: readonly AllergenLang[];
  readonly jurisdictions: Readonly<
    Record<Jurisdiction, { readonly name: string; readonly law: string; readonly source: string }>
  >;
  readonly allergens: readonly AllergenEntry[];
};

const BY_CODE = new Map(ALLERGENS_VOCABULARY.allergens.map((a) => [a.code, a]));
const ORDER = new Map(ALLERGENS_VOCABULARY.allergens.map((a, i) => [a.code, i]));

/** Every allergen code, in the vocabulary's order. */
export const ALLERGEN_CODES: readonly string[] = ALLERGENS_VOCABULARY.allergens.map((a) => a.code);

export function isAllergenCode(code: string): boolean {
  return BY_CODE.has(code);
}

export function allergenEntry(code: string): AllergenEntry | undefined {
  return BY_CODE.get(code);
}

/** An allergen's name in a language, English where the language is not one of the seven. */
export function allergenLabel(code: string, lang: string): string {
  const entry = BY_CODE.get(code);
  if (!entry) return code;
  const short = lang.toLowerCase().slice(0, 2) as AllergenLang;
  return entry.labels[short] ?? entry.labels.en;
}

/**
 * The codes with every one they are a part of, once each, in the vocabulary's order: a dish with walnut
 * contains tree nuts too, so a question about tree nuts finds it. Unknown codes are left out.
 */
export function expandAllergens(codes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const code of codes) {
    let at = BY_CODE.get(code);
    for (let depth = 0; at && depth < 4; depth++) {
      out.add(at.code);
      at = at.parent ? BY_CODE.get(at.parent) : undefined;
    }
  }
  return [...out].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

/** The codes a jurisdiction makes a business declare (its mandatory list). */
export function mandatoryAllergens(where: Jurisdiction): string[] {
  return ALLERGENS_VOCABULARY.allergens.filter((a) => a.mandatory_in.includes(where)).map((a) => a.code);
}

export const allergenCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}$/)
  .refine(isAllergenCode, { message: "an allergen code from vocab/allergens.json" });

export const allergenStatusSchema = z
  .enum(["confirmed", "unconfirmed"])
  .describe("confirmed: a person at the business checked it. unconfirmed: ask the business before relying on it.");

/**
 * A dish's allergens as an agent is told them. Unconfirmed, the lists are what the business has
 * written so far and nothing more: relay "ask the business", never "free from".
 */
export const allergenInfoSchema = z.object({
  status: allergenStatusSchema,
  contains: z.array(allergenCodeSchema).max(ALLERGEN_CODES.length),
  may_contain: z.array(allergenCodeSchema).max(ALLERGEN_CODES.length),
});
export type AllergenInfo = z.infer<typeof allergenInfoSchema>;

/* --- the menu ------------------------------------------------------------------------- */

/**
 * What an item is for those who eat a certain way. `gluten_free`, `dairy_free` and `nut_free` are about
 * allergens, so they are answered with the item's allergen status.
 */
export const DIETARY_TAGS = [
  "vegan",
  "vegetarian",
  "gluten_free",
  "dairy_free",
  "nut_free",
  "halal",
  "kosher",
  "spicy",
] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];
/** The tags that say something about allergens: only as sure as the item's allergen status. */
export const ALLERGEN_CLAIMS: ReadonlySet<DietaryTag> = new Set(["gluten_free", "dairy_free", "nut_free"]);

/** The age a buyer must be, as the business sets it; it checks ID at the handover itself. */
export const AGE_LIMITS = [16, 18, 19, 20, 21] as const;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

/** A time of day an item is served: breakfast, lunch, late. */
export const daypartSchema = z.object({
  name: z.string().min(1).max(40),
  days: z.array(z.enum(WEEKDAYS)).min(1).max(7),
  from: hhmm,
  to: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "use HH:MM, or 24:00"),
});
export type Daypart = z.infer<typeof daypartSchema>;

/** Where a choice sits on an item made in halves: all of it, its left half or its right half. */
export const portionSchema = z.enum(["whole", "left", "right"]);
export type Portion = z.infer<typeof portionSchema>;

/** One choice of an option group, as an agent is told it. */
export const menuChoiceViewSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  price_delta: moneySchema.optional().describe("What choosing it adds to the item's price; absent, nothing."),
  default: z.boolean().optional(),
  allergens: z
    .object({ contains: z.array(allergenCodeSchema), may_contain: z.array(allergenCodeSchema) })
    .optional()
    .describe("What this choice adds to the item's allergens, as sure as the item's own status."),
  opens: z.string().min(1).max(64).optional().describe("The option group this choice opens (one level)."),
});

/** One option group of an item: size, crust, toppings, milk. */
export const menuGroupViewSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  min: z.number().int().min(0).max(50),
  max: z.number().int().min(1).max(50),
  halves: z.boolean().optional().describe("Its choices may go on one half (portion left or right): half-and-half."),
  /** Shown only once a choice of another group opens it (one level of nesting). */
  opened_by: z.object({ group_id: z.string(), choice_id: z.string() }).optional(),
  choices: z.array(menuChoiceViewSchema).min(1).max(60),
});

/** What a custom order (a cake) asks for, beyond its options. */
export const briefViewSchema = z.object({
  servings: z.object({ min: z.number().int().min(1), max: z.number().int().max(500) }).optional(),
  flavours: z.array(z.string().min(1).max(80)).max(20).optional(),
  message_max: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("How many characters the writing on it may have; absent, none."),
  photo: z.boolean().optional().describe("A picture of what it should look like may come with the request."),
});

export const menuItemViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  price: moneySchema,
  section: z.string(),
  options: z.array(menuGroupViewSchema).max(20),
  allergens: allergenInfoSchema,
  dietary: z.array(z.object({ tag: z.enum(DIETARY_TAGS), status: allergenStatusSchema.optional() })).max(8),
  age_restricted: z.union([z.literal(16), z.literal(18), z.literal(19), z.literal(20), z.literal(21)]).optional(),
  dayparts: z.array(z.string()).optional().describe("The dayparts it is served in; absent, whenever the kitchen is."),
  available_now: z.boolean(),
  sold_out_today: z.boolean(),
  notice_min: z.number().int().min(0).optional().describe("How long ahead it must be ordered, in minutes."),
  available_days: z.array(z.enum(WEEKDAYS)).optional(),
  made_to_order: z.boolean().optional().describe("Made for this customer: on request, and no right to withdraw."),
  brief: briefViewSchema.optional(),
  combo: z
    .array(z.object({ group: z.string(), quantity: z.number().int().min(1).max(20) }))
    .optional()
    .describe("A deal: so many of each group, chosen from the group's options."),
});
export type MenuItemView = z.infer<typeof menuItemViewSchema>;

export const getMenuInputSchema = z.object({
  daypart: z.string().max(40).optional().describe("Only what is served in this daypart."),
  section: z.string().max(120).optional().describe("Only this section, by its id or name."),
  at: z.iso.datetime({ offset: true }).optional().describe("What is available at this instant; default now."),
});
export type GetMenuInput = z.infer<typeof getMenuInputSchema>;

/* --- ordering for a time ---------------------------------------------------------------- */

export const fulfilMethodSchema = z.enum(["pickup", "delivery", "dine_in"]);
export type FulfilMethod = z.infer<typeof fulfilMethodSchema>;

const isoDateTime = z.iso.datetime({ offset: true });

/** A slot an order is collected or delivered in. */
export const orderSlotSchema = z.object({ start: isoDateTime, end: isoDateTime });

/** The kitchen's word on how far an order is, inside fulfilling: never a state of its own. */
export const orderProgressSchema = z.object({
  stage: z.enum(["preparing", "ready", "out_for_delivery"]),
  at: isoDateTime,
  etaAt: isoDateTime.optional().describe("When it expects it ready, or at the door."),
});
export type OrderProgress = z.infer<typeof orderProgressSchema>;

export const listOrderSlotsInputSchema = z
  .object({
    date: z.iso.date().describe("The day, YYYY-MM-DD in the business's time zone."),
    method: fulfilMethodSchema.default("pickup"),
    postal_code: z.string().min(1).max(20).optional().describe("For delivery: the address's postal code."),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe("With a postal code: its country, ISO 3166-1 alpha-2."),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: "lat and lng together", path: ["lng"] });
export type ListOrderSlotsInput = z.infer<typeof listOrderSlotsInputSchema>;

/** A delivery zone as agents are told it: a radius in km or postal prefixes, never the kitchen's point. */
export const zoneViewSchema = z.object({
  name: z.string(),
  radius_km: z.number().optional(),
  postal: z.array(postalPrefixSchema).optional(),
  fee: moneySchema.optional(),
  minimum_order: moneySchema.optional(),
  eta_min: z.number().int().optional(),
});

export const listOrderSlotsOutputSchema = z.object({
  date: z.iso.date(),
  method: fulfilMethodSchema,
  answer: z
    .enum(["open", "closed", "paused", "outside", "no_delivery", "on_request"])
    .describe(
      "open: slots below. closed: none that day. paused: not taking orders until paused_until. outside: no delivery there. no_delivery: the business does not deliver. on_request: the address could not be placed; the business decides.",
    ),
  earliest: isoDateTime.optional().describe("The first slot an order placed now can have."),
  slots: z.array(z.object({ start: isoDateTime, end: isoDateTime, left: z.number().int().min(0) })).max(200),
  zone: zoneViewSchema.optional(),
  paused_until: isoDateTime.optional(),
  words: z.string().max(500).describe("What to tell your person, in the business's words."),
});
export type ListOrderSlotsOutput = z.infer<typeof listOrderSlotsOutputSchema>;

/** How the business takes orders, as `get_business_profile`'s `kitchen` says it. */
export const kitchenProfileSchema = z.object({
  methods: z.array(fulfilMethodSchema).max(3),
  prep_min: z.number().int().min(0).max(1440),
  slot_min: z.number().int().min(5).max(240),
  confirms: z
    .enum(["on_request", "within_caps"])
    .describe(
      "on_request: a person accepts each order. within_caps: orders inside what the kitchen set aside confirm at once.",
    ),
  paused_until: isoDateTime.optional(),
  tips: z.object({ choices: z.array(z.number().int().min(0).max(50)).max(6) }).optional(),
  delivery: z.object({ zones: z.array(zoneViewSchema).max(10) }).optional(),
  tables: z
    .object({
      max_party: z.number().int().min(1),
      quote_above: z.number().int().min(1).optional(),
      confirms: z.enum(["on_request", "set_aside"]),
    })
    .optional(),
  allergens: z
    .string()
    .max(300)
    .describe("How allergens are answered: a status per dish, and ask the business when it is not confirmed."),
});
export type KitchenProfile = z.infer<typeof kitchenProfileSchema>;

export const getMenuOutputSchema = z.object({
  currency: z.string().length(3),
  sections: z
    .array(z.object({ id: z.string(), name: z.string(), items: z.array(menuItemViewSchema).max(500) }))
    .max(50),
  dayparts: z.array(daypartSchema).max(10),
  kitchen: kitchenProfileSchema.optional(),
  words: z
    .string()
    .max(500)
    .describe("What to tell your person about allergens and ordering, in the business's words."),
});
export type GetMenuOutput = z.infer<typeof getMenuOutputSchema>;

/* --- orders -------------------------------------------------------------------------------- */

/** One option chosen on an order line, by its group and choice. The name and price are the business's. */
export const lineOptionSchema = z.object({
  groupId: z.string().min(1).max(64),
  choiceId: z.string().min(1).max(64),
  portion: portionSchema.optional().describe("On an item made in halves: whole, left or right."),
  /** Written by the inbox from the menu: the choice's name and what it adds per unit. */
  name: z.string().max(120).optional(),
  priceDelta: moneySchema.optional(),
});
export type LineOption = z.infer<typeof lineOptionSchema>;

/** A custom order's brief: how many it serves, its flavour, the writing on it. */
export const lineBriefSchema = z.object({
  servings: z.number().int().min(1).max(500).optional(),
  flavour: z.string().min(1).max(80).optional(),
  message: z.string().min(1).max(200).optional().describe("The writing on it, within the length the business allows."),
});
export type LineBrief = z.infer<typeof lineBriefSchema>;

/**
 * How an order is fulfilled. The customer sends the method, the slot's start and, for delivery, the
 * address (the order's shippingAddress) and its point when they have one; the inbox writes the slot's
 * end, the zone it falls in, its fee and the time it takes.
 */
export const fulfilSchema = z.object({
  method: fulfilMethodSchema,
  slot: z.object({ start: isoDateTime, end: isoDateTime.optional() }).optional(),
  geo: z
    .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .optional()
    .describe("The delivery address's point, when you have it: a ring zone is checked against it."),
  /** The inbox's: the zone the address fell in, what delivering there costs, and the time it takes. */
  zone: z.object({ name: z.string().max(60) }).optional(),
  fee: moneySchema.optional(),
  etaMin: z.number().int().min(0).max(1440).optional(),
});
export type Fulfil = z.infer<typeof fulfilSchema>;

/** A tip the customer adds, as a share of the food or an amount; the inbox works out the amount. */
export const tipSchema = z
  .object({
    percent: z.number().int().min(0).max(50).optional(),
    amount: moneySchema.optional(),
  })
  .refine((t) => t.percent !== undefined || t.amount !== undefined, { message: "a percent or an amount" });
export type Tip = z.infer<typeof tipSchema>;

/**
 * Why an order waits for a person: an allergen nobody confirmed, more than the kitchen set aside, made
 * to order, a kitchen that accepts each order by hand, or a slot that could not be held.
 */
export const KITCHEN_HOLDS = ["allergens_unconfirmed", "over_cap", "made_to_order", "owner_accepts"] as const;
export type KitchenHold = (typeof KITCHEN_HOLDS)[number];

/** What the inbox wrote on an order as it took it: whether it may confirm at once, and if not why. */
export const kitchenMarkSchema = z.object({
  instant: z.boolean(),
  hold: z.array(z.enum(KITCHEN_HOLDS)).max(KITCHEN_HOLDS.length),
});
export type KitchenMark = z.infer<typeof kitchenMarkSchema>;

/* --- tables ------------------------------------------------------------------------------ */

/**
 * A table service's own rules: the largest party booked here, the size above which a request becomes a
 * request for a price (events, a private room), a deposit for each person from a party size, and the
 * covers a sitting keeps for direct bookings, which confirm at once (none set aside: every table is on
 * request).
 */
export const tableRulesSchema = z.object({
  maxParty: z.number().int().min(1).max(200),
  quoteAbove: z.number().int().min(1).max(500).optional(),
  deposit: z.object({ perPerson: moneySchema, fromParty: z.number().int().min(1).max(200) }).optional(),
  setAside: z.number().int().min(1).max(1000).optional(),
});
export type TableRules = z.infer<typeof tableRulesSchema>;
