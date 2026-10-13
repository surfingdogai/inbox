import { type FieldProblem, fromZod, setupPlanSchema, validTimezone } from "@surfingdog/core";

/**
 * Whether a setup plan would be taken, without an inbox to take it: the plan's own schema and its
 * time zone, as applying checks them first. The control plane asks before it sends anyone a code.
 */
export function validatePlan(input: unknown): { ok: true } | { ok: false; fields: readonly FieldProblem[] } {
  const parsed = setupPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fields: fromZod(parsed.error, "plan").fields ?? [] };
  const tz = parsed.data.profile?.timezone;
  if (tz !== undefined && !validTimezone(tz)) {
    return {
      ok: false,
      fields: [{ path: "plan.profile.timezone", problem: "invalid", message: "use an IANA name like Europe/Lisbon" }],
    };
  }
  return { ok: true };
}
