import { z } from "zod";
import { moneySchema } from "../domain/types";

/**
 * Settings → Work (ADR-034 §4): how a trade takes work. Each is a choice, never a typed code:
 *
 * - `callOutFee`: what coming out costs, and whether accepting the quote takes it off;
 * - `outOfHours`: what a visit outside the opening hours (Settings → Availability) adds, as an amount
 *   or a percentage;
 * - `emergency`: whether agents may ask for an emergency job at all, only while open, or at any hour,
 *   always only inside the area;
 * - `freeEstimates`: said in the business's public profile (`free_estimates`);
 * - `visitServiceId`: the service a site visit is booked as, so a visit can be tied to its request;
 * - `jobTool`: which requests go into the owner's job tool (ServiceM8, Housecall Pro, Fergus): every
 *   one, only the ones the owner takes on (quoted, or sent by hand), or none. Default "only ones I take
 *   on": a job tool full of requests nobody looked at is how a tradesperson stops using it.
 *
 * Money and where requests go are the owner's: only the owner in person changes these (`guard.ts`).
 */

export const surchargeSchema = z.union([
  z.object({ kind: z.literal("amount"), amount: moneySchema }),
  z.object({ kind: z.literal("percent"), percent: z.number().int().min(1).max(300) }),
]);
export type Surcharge = z.infer<typeof surchargeSchema>;

export const JOB_TOOL_MODES = ["every", "accepted", "never"] as const;
export type JobToolMode = (typeof JOB_TOOL_MODES)[number];

export const workSettingsSchema = z
  .object({
    callOutFee: z
      .object({ amount: moneySchema, creditedIfAccepted: z.boolean().default(false) })
      .nullable()
      .default(null)
      .describe("What coming out costs, and whether accepting the quote takes it off."),
    outOfHours: z
      .object({ surcharge: surchargeSchema })
      .nullable()
      .default(null)
      .describe("What a visit outside your opening hours adds."),
    emergency: z
      .enum(["off", "opening_hours", "always"])
      .default("off")
      .describe("Emergency jobs from agents: not taken, only while you are open, or at any hour (inside your area)."),
    freeEstimates: z.boolean().default(false).describe("You give estimates for free: said in your public profile."),
    visitServiceId: z.string().max(64).nullable().default(null).describe("The service a site visit is booked as."),
    jobTool: z
      .enum(JOB_TOOL_MODES)
      .default("accepted")
      .describe("Which requests go into your job tool: every one, only the ones you take on (quote or send), or none."),
  })
  .prefault({});
export type WorkSettings = z.infer<typeof workSettingsSchema>;
