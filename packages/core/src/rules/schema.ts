import { z } from "zod";

/**
 * Rules are plain JSON conditions and actions, evaluated deterministically after each committed
 * event. No DSL, no regex, no I/O during evaluation: everything a condition may read is fetched
 * into a frozen context first.
 */
export const triggerSchema = z.union([
  z.enum(["item.created", "item.transitioned", "thread.inbound"]),
  z.string().regex(/^item\.transitioned:[a-z_]+$/),
]);

export const opSchema = z.enum([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "nin",
  "contains",
  "startsWith",
  "exists",
  "empty",
  "between",
]);

/**
 * The functions a condition may call. The last four read a customer's standing (ADR-017 §8.3):
 * `person_trusted` (the best tier across the networks is `trusted`), `person_tier_on {network, min}`
 * (at least `min` on one network), `customer_known` (a strong match with a completed item here),
 * `within_customer_limit` (the total is within twice the largest paid order, or 40000 for a
 * trusted person). A rule that reads them, or `party_verified`, is positive only (reputation.ts).
 */
export const FN_NAMES = [
  "slot_is_free",
  "within_business_hours",
  "party_verified",
  "text_has_keywords",
  "is_sandbox",
  "person_trusted",
  "person_tier_on",
  "customer_known",
  "within_customer_limit",
] as const;
export type FnName = (typeof FN_NAMES)[number];

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { path: string; op: z.infer<typeof opSchema>; value?: unknown }
  | { fn: FnName; args?: Record<string, unknown> };

const conditionUnion = () =>
  z.union([
    z.object({ all: z.array(conditionSchema).max(20) }),
    z.object({ any: z.array(conditionSchema).max(20) }),
    z.object({ not: conditionSchema }),
    z.object({ path: z.string().min(1).max(120), op: opSchema, value: z.unknown().optional() }),
    z.object({ fn: z.enum(FN_NAMES), args: z.record(z.string(), z.unknown()).optional() }),
  ]);
// The recursive union infers the same shape as Condition; the cast only bridges exactOptionalPropertyTypes.
export const conditionSchema = z.lazy(conditionUnion) as unknown as z.ZodType<Condition>;

export const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("transition"),
    event: z.string().min(1).max(60),
    input: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal("set_flags"),
    needsHuman: z.boolean().optional(),
    priority: z.number().int().min(0).max(3).optional(),
  }),
  z.object({
    action: z.literal("reply"),
    template: z.string().min(1).max(4_000),
    internal: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("enqueue"),
    job: z.string().min(1).max(60),
    payload: z.record(z.string(), z.unknown()).optional(),
    delayMin: z
      .number()
      .int()
      .min(0)
      .max(60 * 24 * 30)
      .optional(),
  }),
  z.object({ action: z.literal("stop") }),
]);
export type Action = z.infer<typeof actionSchema>;

export const ruleDefinitionSchema = z.object({
  on: z.array(triggerSchema).min(1).max(10),
  if: conditionSchema,
  actions: z.array(actionSchema).min(1).max(10),
  stop: z.boolean().default(false),
  maxRunsPerItem: z.number().int().min(1).max(50).default(5),
});
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

export interface Rule extends RuleDefinition {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly enabled: boolean;
}

export const MAX_RULES_PER_EVENT = 20;
export const MAX_DEPTH = 3;
