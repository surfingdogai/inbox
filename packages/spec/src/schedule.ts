import { z } from "zod";
import { moneySchema } from "./base";

/**
 * When an amount is paid, in the shape of UCP's `payment.terms[].schedules[]`: `immediate` (now, to
 * book), `deferred` (by `due_at`) or `at_property` (on the day, where the business is). Every schedule
 * of a quote adds up to its total.
 */
export const paymentScheduleSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["immediate", "deferred", "at_property"]),
  amount: moneySchema,
  due_at: z.iso.datetime({ offset: true }).optional(),
  label: z.string().max(200).optional(),
});
export type PaymentSchedule = z.infer<typeof paymentScheduleSchema>;

/** A payment's terms: its schedules, which add up to the total they are for. */
export const paymentTermsSchema = z.object({ schedules: z.array(paymentScheduleSchema).min(1).max(4) });
export type PaymentTerms = z.infer<typeof paymentTermsSchema>;

/**
 * Whether the schedules add up to `total`, in its currency, each amount at least zero: the invariant a
 * quote is never sent without. Null when they do; otherwise what is wrong.
 */
export function scheduleProblem(
  schedules: readonly { readonly amount: { readonly value: number; readonly currency: string } }[],
  total: { readonly value: number; readonly currency: string },
): string | null {
  if (schedules.length === 0) return "no schedule";
  let sum = 0;
  for (const s of schedules) {
    if (s.amount.currency !== total.currency)
      return `a schedule in ${s.amount.currency}, the total in ${total.currency}`;
    if (!Number.isSafeInteger(s.amount.value) || s.amount.value < 0) return "a schedule's amount is not a whole count";
    sum += s.amount.value;
  }
  return sum === total.value ? null : `the schedules add up to ${sum}, not ${total.value}`;
}
