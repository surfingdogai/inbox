import { z } from "zod";
import { moneySchema } from "./base";
import { shareOf } from "./money";

/**
 * Staff, add-ons and deposits (spec 0.11, ADR-035): what an agent reads of a salon, a barber or a
 * beauty studio before it books, and what a booking with a member of staff carries. A business that
 * has no staff publishes none of it, and books as before.
 */

/**
 * A member of staff as the public sees them: a first name (or the name they chose), a photo when the
 * business added one, and the services they give. Never a surname, an address, a phone number or hours.
 */
export const staffMemberSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(60).describe("A first name, or the name they work under. Never a full name."),
  photo_url: z.url().optional().describe("Their photo, when the business added one."),
  service_ids: z.array(z.string().min(1).max(64)).max(200).describe("The services they give."),
});
export type StaffMember = z.infer<typeof staffMemberSchema>;

/**
 * Something added to a service ("+ blow-dry, 15 min"): it makes the booking longer by `duration_min`
 * and, when it has a price, dearer by it. The business's own words and prices.
 */
export const serviceAddOnSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  duration_min: z.int().min(0).max(480),
  price: moneySchema.optional(),
});
export type ServiceAddOn = z.infer<typeof serviceAddOnSchema>;

/**
 * What a service asks to hold a booking: a share of its price (`percent`, 1–100) or a fixed amount
 * (minor units). Paid on the business's own payment platform; the rest is paid at the visit.
 */
export const depositRuleSchema = z.object({
  kind: z.enum(["percent", "amount"]),
  value: z.int().min(1).max(1_000_000_000_000),
});
export type DepositRule = z.infer<typeof depositRuleSchema>;

/** The deposit one booking asks, as it was confirmed: how much, by when, and whether a free cancel gives it back. */
export const bookingDepositSchema = z.object({
  amount: moneySchema,
  due_by: z.iso.datetime({ offset: true }).optional(),
  refundable: z.boolean(),
});
export type BookingDeposit = z.infer<typeof bookingDepositSchema>;

/**
 * The deposit for a booking whose price is `total`: a share rounded half up to the minor unit, or the
 * amount, never more than the total. Null when there is nothing to hold it with (no price, nothing due).
 */
export function depositFor(
  rule: DepositRule,
  total: { readonly value: number; readonly currency: string },
): { value: number; currency: string } | null {
  if (!(total.value > 0)) return null;
  const value =
    rule.kind === "percent" ? shareOf(total.value, Math.min(100, rule.value) * 100) : Math.min(total.value, rule.value);
  return value > 0 ? { value, currency: total.currency } : null;
}

/** A booking's add-ons as it keeps them: the business's names, lengths and prices at the time. */
export const bookedAddOnSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  durationMin: z.int().min(0).max(480),
  price: moneySchema.optional(),
});
export type BookedAddOn = z.infer<typeof bookedAddOnSchema>;
