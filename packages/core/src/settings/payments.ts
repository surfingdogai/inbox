import { type PayTo, publishedPayments, STRIPE_PAY_CURRENCIES } from "@surfingdog/spec";
import type { Settings } from "./schema";

/**
 * How the business is paid, as it publishes it (Settings → Payments): the ways ticked, with `stripe_pay` while a
 * Stripe Pay address is set (ADR-045), in the vocabulary's order and with card for a card brand
 * (`publishedPayments`). What the manifest's `profile.payments`, the business profile and its own page name.
 */
export function settingsPayments(payments: Settings["payments"]): string[] {
  return publishedPayments([...payments.accepted, ...(stripePayOf(payments) ? ["stripe_pay"] : [])]);
}

/** Where a payer sends what is paid to an address of the business's own (`profile.pay_to`, spec 0.13): Stripe Pay. */
export function settingsPayTo(payments: Settings["payments"]): PayTo[] {
  const s = stripePayOf(payments);
  return s ? [{ method: "stripe_pay", to: s.to, currencies: [...s.currencies] }] : [];
}

/** Stripe Pay as the owner set it, its currencies in Stripe Pay's order; null while it is off (no address, or no currency). */
export function stripePayOf(
  payments: Settings["payments"] | undefined,
): { readonly to: string; readonly currencies: readonly string[] } | null {
  const s = payments?.stripePay;
  if (!s?.to || !s.currencies.length) return null;
  return { to: s.to, currencies: STRIPE_PAY_CURRENCIES.filter((c) => s.currencies.includes(c)) };
}
