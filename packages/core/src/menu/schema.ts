import { allergenCodeSchema, DIETARY_TAGS, daypartSchema, WEEKDAYS } from "@surfingdog/spec";
import { z } from "zod";

/**
 * The menu (ADR-036): what a product holds once it is on a menu (`products.menu`), and the menu's own
 * settings (`settings.menu`): its sections and dayparts. Everything here is the business's: prices and
 * what each option adds are its own, and allergens are what it states, confirmed only by a person at the
 * business (`menu/allergens.ts`).
 */

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "a short id: lower-case letters, digits, - and _")
  .describe("A short id of the business's own, unique on the item.");

/** What a choice adds to the allergens of the dish it is chosen on. */
export const choiceAllergensSchema = z.object({
  contains: z.array(allergenCodeSchema).max(46).default([]),
  mayContain: z.array(allergenCodeSchema).max(46).default([]),
});

export const menuChoiceSchema = z.object({
  id,
  name: z.string().min(1).max(120),
  /** What choosing it adds to the item's unit price, in minor units of the item's currency; 0 or absent: nothing. */
  priceDelta: z.number().int().min(0).max(100_000_000).optional(),
  /** What it adds for one half, where the group takes halves and it is cheaper there; absent: `priceDelta`. */
  halfDelta: z.number().int().min(0).max(100_000_000).optional(),
  default: z.boolean().optional(),
  allergens: choiceAllergensSchema.optional(),
  /** The option group this choice opens: a pizza's size opens its crust. One level only. */
  opens: id.optional(),
  /** For a deal: the product this choice is (two pizzas and a drink, each chosen from the menu). */
  productId: z.string().min(1).max(64).optional(),
  /** The till's or ordering system's own id for it, when the menu came from there (ADR-036). */
  externalId: z.string().min(1).max(100).optional(),
});
export type MenuChoice = z.infer<typeof menuChoiceSchema>;

export const optionGroupSchema = z
  .object({
    id,
    name: z.string().min(1).max(120),
    min: z.number().int().min(0).max(50).default(0),
    max: z.number().int().min(1).max(50).default(1),
    /** Its choices may go on one half: half-and-half. */
    halves: z.boolean().optional(),
    /** The till's own id for the group, when the menu came from there. */
    externalId: z.string().min(1).max(100).optional(),
    choices: z.array(menuChoiceSchema).min(1).max(60),
  })
  .refine((g) => g.min <= g.max, { message: "min is at most max", path: ["min"] })
  .refine((g) => new Set(g.choices.map((c) => c.id)).size === g.choices.length, {
    message: "each choice has an id of its own",
    path: ["choices"],
  });
export type OptionGroup = z.infer<typeof optionGroupSchema>;

/** A dish's allergens as stored: what it contains and may contain, and whether a person confirmed them. */
export const storedAllergensSchema = z.object({
  contains: z.array(allergenCodeSchema).max(46).default([]),
  mayContain: z.array(allergenCodeSchema).max(46).default([]),
  status: z.enum(["confirmed", "unconfirmed"]).default("unconfirmed"),
  /** When and by whom (owner or staff) it was confirmed, in person. */
  confirmedAt: z.iso.datetime({ offset: true }).optional(),
  confirmedBy: z.enum(["owner", "staff"]).optional(),
  /** Where the lists came from, when they were not typed here (`gloriafood`, `assistant`). */
  source: z.string().max(40).optional(),
});
export type StoredAllergens = z.infer<typeof storedAllergensSchema>;

export const briefSchema = z.object({
  servings: z
    .object({ min: z.number().int().min(1).max(500), max: z.number().int().min(1).max(500) })
    .refine((s) => s.min <= s.max, { message: "min is at most max" })
    .optional(),
  flavours: z.array(z.string().min(1).max(80)).max(20).optional(),
  /** How long the writing on it may be, in characters; absent: no writing. */
  messageMax: z.number().int().min(1).max(200).optional(),
  /** A picture of what it should look like may come with the request. */
  photo: z.boolean().optional(),
});
export type Brief = z.infer<typeof briefSchema>;

const localDate = z.iso.date();

/** What a product holds once it is on a menu. */
export const menuFieldsSchema = z.object({
  section: id.default("menu").describe("The section it is in, by the section's id."),
  sort: z.number().int().min(0).max(10_000).default(0),
  optionGroups: z.array(optionGroupSchema).max(20).default([]),
  allergens: storedAllergensSchema.prefault({}),
  dietary: z.array(z.enum(DIETARY_TAGS)).max(DIETARY_TAGS.length).default([]),
  ageRestricted: z
    .union([z.literal(16), z.literal(18), z.literal(19), z.literal(20), z.literal(21)])
    .nullable()
    .default(null),
  /** The dayparts it is served in, by name; none: whenever the kitchen takes orders. */
  dayparts: z.array(z.string().min(1).max(40)).max(10).default([]),
  /** A deal: chosen through its option groups, whose choices name products. */
  combo: z.boolean().default(false),
  /** How long ahead it must be ordered, in minutes (a birthday cake: 2 days). */
  noticeMin: z
    .number()
    .int()
    .min(0)
    .max(90 * 24 * 60)
    .default(0),
  /** How many the inbox may take a day: what the business set aside. Null: no cap (and nothing set aside). */
  dailyCap: z.number().int().min(1).max(10_000).nullable().default(null),
  /** The days it is made; none: every day the kitchen is open. */
  availableDays: z.array(z.enum(WEEKDAYS)).max(7).default([]),
  /** Dates it is not made, YYYY-MM-DD in the business's zone. */
  blackout: z.array(localDate).max(100).default([]),
  /** Made for this customer (a custom cake): on request, and the `personalised` withdrawal exception. */
  madeToOrder: z.boolean().default(false),
  brief: briefSchema.nullable().default(null),
});
export type MenuFields = z.infer<typeof menuFieldsSchema>;

/**
 * Why a product's option groups cannot be ordered from: a choice opens a group that is not there, or a
 * group opened by a choice opens another (one level only). Null when they hold.
 */
export function optionGroupsProblem(groups: readonly OptionGroup[]): string | null {
  const ids = new Set(groups.map((g) => g.id));
  if (ids.size !== groups.length) return "each option group has an id of its own";
  const opened = new Set<string>();
  for (const g of groups) {
    for (const c of g.choices) {
      if (c.opens === undefined) continue;
      if (!ids.has(c.opens)) return `${g.name}: ${c.name} opens a group that is not there`;
      if (c.opens === g.id) return `${g.name}: a choice cannot open its own group`;
      opened.add(c.opens);
    }
  }
  for (const g of groups) {
    if (opened.has(g.id) && g.choices.some((c) => c.opens !== undefined)) {
      return `${g.name} is opened by a choice, so its own choices open nothing: one level only`;
    }
  }
  return null;
}

/** A product's menu, read from its stored JSON; null when it is not on a menu or does not read. */
export function menuOf(raw: unknown): MenuFields | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  const parsed = menuFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A menu's section, as the business names and orders them. */
export const menuSectionSchema = z.object({
  id,
  name: z.string().min(1).max(120),
  sort: z.number().int().min(0).max(10_000).default(0),
});
export type MenuSection = z.infer<typeof menuSectionSchema>;

/** Settings → Menu: the sections and the dayparts items are served in. */
export const menuSettingsSchema = z
  .object({
    sections: z
      .array(menuSectionSchema)
      .max(50)
      .default([])
      .refine((all) => new Set(all.map((s) => s.id)).size === all.length, { message: "each section has its own id" }),
    dayparts: z.array(daypartSchema).max(10).default([]),
  })
  .prefault({});
export type MenuSettings = z.infer<typeof menuSettingsSchema>;
