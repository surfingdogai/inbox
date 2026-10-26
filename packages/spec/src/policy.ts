import { z } from "zod";
import { moneySchema } from "./base";

/**
 * Cancellation policies and payment schedules as data (spec 0.10, ADR-032). A business states its
 * policy once, as steps before the start of what it sells (an arrival date, an appointment's time);
 * for each booking the inbox turns them into dated steps in the business's own zone, which agents and
 * customers read and confirm before they are bound. Nothing here is stored by the spec: each item type
 * keeps the policy it applies.
 */

/**
 * What cancelling costs at one step: nothing, a share of the total (`percent`, 0–100), a fixed amount
 * (`amount`, minor units), the first N units of what was booked (`units`: nights, sessions), or all of it.
 */
export const policyFeeSchema = z.object({
  kind: z.enum(["none", "percent", "amount", "units", "full"]),
  value: z.int().min(0).max(1_000_000_000_000).optional(),
});
export type PolicyFee = z.infer<typeof policyFeeSchema>;

/**
 * One step: until `days` before the start (for what starts on a date, the end of that local day) or
 * `hours` before it (for what starts at a time), cancelling costs `fee`. Steps run from the farthest
 * out to the nearest.
 */
export const policyStepSchema = z
  .object({
    before: z
      .object({ days: z.int().min(0).max(365).optional(), hours: z.int().min(0).max(8_760).optional() })
      .refine((b) => (b.days === undefined) !== (b.hours === undefined), "days or hours, one of them"),
    fee: policyFeeSchema,
  })
  .describe("Until this long before the start, cancelling costs this much.");

/** A business's cancellation policy, as it states it once. */
export const policySchema = z.object({
  steps: z.array(policyStepSchema).max(6),
  /** What cancelling costs once every step has passed, until the start. */
  after: policyFeeSchema,
  /** What not coming costs. */
  noShow: policyFeeSchema,
  /** Whether a deposit is given back with a free cancellation; when not, it is kept whatever the step. */
  deposit: z.object({ refundable: z.boolean() }).optional(),
});
export type Policy = z.infer<typeof policySchema>;

/** A policy for one booking: the fee if cancelled before each `until`, in the business's zone. */
export const datedPolicySchema = z.object({
  steps: z
    .array(z.object({ until: z.iso.datetime({ offset: true }), fee: moneySchema }))
    .max(6)
    .describe("Cancelling before `until` costs `fee`; the steps are in order."),
  after: moneySchema.describe("The fee after the last step, until the start."),
  noShow: moneySchema,
  zone: z.string().min(1).max(64).describe("The IANA zone the steps were dated in: the business's."),
});
export type DatedPolicy = z.infer<typeof datedPolicySchema>;
