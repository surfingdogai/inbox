/**
 * Stripe Pay's addresses and currencies (spec 0.13, ADR-045). Free of any dependency (the owner app imports it as it
 * is), so the rules are written once.
 */

/**
 * What Stripe Pay moves, as Stripe documents it (https://docs.stripe.com/cli/pay, read 31 October 2026): same-currency
 * transfers in USD, GBP and USDC, in preview for eligible businesses in the US and the UK. USDC is a stablecoin, not
 * an ISO 4217 code: an order is never in it, so an order is offered Stripe Pay only in USD or GBP.
 */
export const STRIPE_PAY_CURRENCIES: readonly string[] = ["USD", "GBP", "USDC"];

/**
 * A Stripe profile handle as written: `@` and its name. Stripe has not published the rules for a handle; every one it
 * shows is lower-case letters and digits (`@neon`, `@youdotcom`). A handle is read in lower case, and may hold `_`, `.`
 * and `-` inside it, at most 50 characters after the `@`.
 */
const STRIPE_HANDLE = /^@[a-z0-9](?:[a-z0-9_.-]{0,48}[a-z0-9])?$/;
/** A Stripe profile's network id: `profile_…` (`profile_test_…` in a sandbox), as Stripe writes it. */
const STRIPE_PROFILE = /^profile_[A-Za-z0-9_]{1,100}$/;

/**
 * Where to send a Stripe Pay transfer, as a business wrote it: a handle (`@acme`, any capitals, the `@` added when it
 * was left off) or a profile network id (`profile_…`, kept as written). Null for anything else: a URL, a space, an
 * email address. Nothing is ever guessed from a business's name or website.
 */
export function stripePayRecipient(raw: string): string | null {
  const s = raw.trim();
  if (STRIPE_PROFILE.test(s)) return s;
  const handle = (s.startsWith("@") ? s : `@${s}`).toLowerCase();
  return STRIPE_HANDLE.test(handle) ? handle : null;
}

/** Whether a recipient is already in the shape `stripePayRecipient` gives. */
export function isStripePayRecipient(s: string): boolean {
  return stripePayRecipient(s) === s;
}
