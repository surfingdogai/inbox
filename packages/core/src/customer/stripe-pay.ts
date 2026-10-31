import type { Money } from "../domain/types";
import { moneyIn, shortRef } from "./format";
import type { CustomerLang } from "./lang";

/**
 * Stripe Pay for an order (ADR-045): Stripe's business-to-business transfer, sent to the business's own Stripe
 * profile from the payer's Stripe Dashboard or by its AI agent with Stripe's own tools. The money goes from one Stripe
 * account to the other and never through the inbox, which cannot see it: the business records the payment on the
 * order once it arrives. What the status door offers, and the one sentence the customer reads, there and in the
 * emails about paying.
 */

/** Stripe Pay as the business set it: where a payer sends it, and the currencies it takes there. */
export interface StripePaySetting {
  readonly to: string;
  readonly currencies: readonly string[];
}

/**
 * Stripe Pay as the status door offers it for an order: to the business's Stripe profile, for exactly the order's
 * total in its currency, with the order's reference. Nothing between the payer and the business sees the transfer, so
 * nothing checks it: the business records the payment on the order when it arrives (`marked_paid_by`).
 */
export interface PayToOffer {
  readonly method: "stripe_pay";
  readonly label: string;
  /** The business's Stripe profile handle (`@acme`) or profile id (`profile_…`). */
  readonly to: string;
  /** Exactly what to send, in the order's own currency and its minor unit. */
  readonly amount: Money;
  /**
   * The order's six-character reference: added to the transfer if Stripe lets the payer add one, and given to the
   * business, either way, when the payer says it was sent.
   */
  readonly reference: string;
  /**
   * What the payer confirms with their person before sending, as Stripe's own guidance asks: the recipient, the
   * amount, the currency, and the Stripe financial account it is paid from (`from`).
   */
  readonly confirm: readonly ["to", "amount", "currency", "from"];
  readonly marked_paid_by: "business";
  /** What to tell the person, in the business's words and language. */
  readonly human: string;
}

/**
 * Stripe Pay is paid from a Stripe business account (a funded Stripe financial account), so the sentence says so:
 * most customers have none, and it is not for them.
 */
const WORDS: Readonly<Record<CustomerLang, (to: string, amount: string, reference: string) => string>> = {
  en: (to, amount, reference) =>
    `If you pay from a Stripe business account, you can pay with Stripe Pay to ${to}: ${amount}, reference ${reference}. We mark it paid once it reaches us.`,
  pt: (to, amount, reference) =>
    `Se pagar a partir de uma conta empresarial Stripe, pode pagar com Stripe Pay para ${to}: ${amount}, referência ${reference}. Marcamo-lo como pago assim que nos chegar.`,
};

/** The sentence a customer reads about paying an order by Stripe Pay, in their language. */
export function stripePayLine(lang: CustomerLang, to: string, amount: string, reference: string): string {
  return WORDS[lang](to, amount, reference);
}

/** Every sentence above, for the customer-copy check. */
export function stripePayWords(lang: CustomerLang): string[] {
  return [stripePayLine(lang, "@fjordbrod", "kr 189,00", "4F2K9Q")];
}

/**
 * Stripe Pay for an order, when the business set it and takes the order's currency there; null otherwise: never for a
 * test order (the transfer would be real money), nor for one that comes to nothing.
 */
export function stripePayOffer(
  order: { readonly id: string; readonly total: Money; readonly sandbox: boolean },
  setting: StripePaySetting | null | undefined,
  lang: CustomerLang,
): PayToOffer | null {
  if (!setting?.to || order.sandbox || order.total.value <= 0) return null;
  if (!setting.currencies.includes(order.total.currency.toUpperCase())) return null;
  const reference = shortRef(order.id);
  return {
    method: "stripe_pay",
    label: "Stripe Pay",
    to: setting.to,
    amount: order.total,
    reference,
    confirm: ["to", "amount", "currency", "from"],
    marked_paid_by: "business",
    human: stripePayLine(lang, setting.to, moneyIn(order.total, lang), reference),
  };
}
