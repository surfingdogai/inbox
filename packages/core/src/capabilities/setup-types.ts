import { z } from "zod";
import { ruleDefinitionSchema } from "../rules/schema";

/** Inputs of the owner's setup operations: profile, services, products, opening hours, rules. */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const range = z.tuple([hhmm, hhmm]).refine(([a, b]) => a < b, { message: "closing time must be after opening time" });
const day = z.array(range).max(6);
export const weeklySchema = z
  .object({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day })
  .partial()
  .describe(
    'Opening windows per weekday, e.g. {"mon": [["09:00","13:00"],["14:00","18:00"]]}. Missing days are closed.',
  );

export const closureSchema = z
  .object({
    from: z.iso.date().describe("First closed day, YYYY-MM-DD in the business time zone."),
    to: z.iso.date().describe("Last closed day, inclusive."),
    reason: z.string().max(200).optional(),
  })
  .refine((c) => c.to >= c.from, { message: "to must not be before from", path: ["to"] });

export const profileInput = z.object({
  name: z.string().min(1).max(200).optional(),
  domain: z
    .string()
    .max(253)
    .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i, "a hostname like shop.example.com")
    .nullable()
    .optional(),
  timezone: z.string().min(1).max(64).optional().describe("IANA name, e.g. Europe/Lisbon"),
  currency: z.string().length(3).toUpperCase().optional(),
  languages: z.array(z.string().min(2).max(12)).min(1).max(10).optional(),
});

export const priceSchema = z.object({
  model: z
    .enum(["fixed", "from", "quote"])
    .describe("fixed = this price; from = starting at; quote = priced per request"),
  value: z.number().int().min(0).optional().describe("Minor units (cents)."),
  currency: z.string().length(3).optional(),
});

export const serviceInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  duration_min: z.number().int().min(5).max(1440).default(60),
  buffer_before_min: z.number().int().min(0).max(240).default(0),
  buffer_after_min: z.number().int().min(0).max(240).default(0),
  capacity: z.number().int().min(1).max(100).default(1).describe("How many bookings can share one slot."),
  granularity_min: z.number().int().min(5).max(240).default(15).describe("Slots start every N minutes."),
  price: priceSchema.optional(),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(10_000).default(0),
});
export const updateServiceInput = serviceInput.partial().extend({ service_id: z.string().min(1) });
export const serviceIdInput = z.object({ service_id: z.string().min(1) });

export const productInput = z.object({
  sku: z.string().max(64).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  price: z.object({ value: z.number().int().min(0), currency: z.string().length(3) }),
  stock: z.number().int().min(0).nullable().optional().describe("null = not tracked"),
  active: z.boolean().default(true),
});
export const updateProductInput = productInput.partial().extend({ product_id: z.string().min(1) });
export const productIdInput = z.object({ product_id: z.string().min(1) });

export const setWeeklyInput = z.object({
  weekly: weeklySchema,
  service_id: z.string().min(1).optional().describe("Override the hours for one service; omit for the whole business."),
});
export const setClosuresInput = z.object({ closures: z.array(closureSchema).max(100) });

export const ruleInput = z.object({
  name: z.string().min(1).max(160),
  priority: z.number().int().min(-1000).max(1000).default(0).describe("Higher runs first."),
  enabled: z.boolean().default(true),
  definition: ruleDefinitionSchema,
});
export const updateRuleInput = ruleInput
  .partial()
  .extend({ rule_id: z.string().min(1), expected_version: z.number().int().min(1).optional() });
export const ruleIdInput = z.object({ rule_id: z.string().min(1) });
export const presetKeySchema = z.enum(["appointments", "trades", "shop"]);
export const applyPresetInput = z.object({
  preset: presetKeySchema,
  replace: z.boolean().default(false).describe("Remove the existing rules first."),
});
export const testRuleInput = z.object({
  definition: ruleDefinitionSchema,
  item_id: z.string().min(1).describe("An existing item to evaluate the conditions against; nothing is changed."),
});

export type WeeklyHours = z.infer<typeof weeklySchema>;
export type ProfileInput = z.infer<typeof profileInput>;
export type ServiceInput = z.infer<typeof serviceInput>;
export type UpdateServiceInput = z.infer<typeof updateServiceInput>;
export type ProductInput = z.infer<typeof productInput>;
export type UpdateProductInput = z.infer<typeof updateProductInput>;
export type SetWeeklyInput = z.infer<typeof setWeeklyInput>;
export type SetClosuresInput = z.infer<typeof setClosuresInput>;
export type RuleInput = z.infer<typeof ruleInput>;
export type UpdateRuleInput = z.infer<typeof updateRuleInput>;
export type ApplyPresetInput = z.infer<typeof applyPresetInput>;
export type TestRuleInput = z.infer<typeof testRuleInput>;
