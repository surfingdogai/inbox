import { z } from "zod";
import vocabulary from "../vocab/payments.json" with { type: "json" };
import { STRIPE_PAY_CURRENCIES, stripePayRecipient } from "./stripe-pay";

export { isStripePayRecipient, STRIPE_PAY_CURRENCIES, stripePayRecipient } from "./stripe-pay";

/**
 * The payments vocabulary (`vocab/payments.json`, `docs/protocol/network.md` §4.10): the tokens a business's profile
 * may name (`profile.payments`), a network's listing shows (`accepts.pay`, `accepts.pay_with`) and a search asks for
 * (`accepts`). `methods` and `wallets` are how a person pays; `agent` the ways an AI agent can pay at a door. Every
 * token has an English label. `synonyms` read what a business writes (schema.org `paymentAccepted`, a registration),
 * ignoring capitals and accents; `marks`, `handlers` and `handlers_last` are a crawler's and a network's, for what
 * they see on a site: `handlers` match a UCP payment handler's name anywhere, word by word, and `handlers_last` only
 * as the whole of its last part, after its last dot (`dev.shopify.card` is a card, `pay_later_card` is not).
 */
export const PAYMENTS_VOCABULARY = vocabulary as unknown as {
  readonly version: number;
  readonly description: string;
  readonly methods: readonly string[];
  readonly wallets: readonly string[];
  readonly agent: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly synonyms: Readonly<Record<string, string>>;
  readonly marks: Readonly<Record<string, string>>;
  readonly handlers: readonly (readonly [string, string])[];
  readonly handlers_last: readonly (readonly [string, string])[];
};

/** The most payment tokens a profile names, a network reads and an inbox keeps: more than the vocabulary holds. */
export const MAX_PROFILE_PAYMENTS = 64;

/** Every token, in the vocabulary's order: methods, wallets, then the ways an agent pays. */
export const PAYMENT_TOKENS: readonly string[] = [
  ...PAYMENTS_VOCABULARY.methods,
  ...PAYMENTS_VOCABULARY.wallets,
  ...PAYMENTS_VOCABULARY.agent,
];

const known = new Set(PAYMENT_TOKENS);

/** Whether a string is a token of the vocabulary. */
export function isPaymentToken(s: string): boolean {
  return known.has(s);
}

/** A token's English name; the token itself for one the vocabulary does not know. */
export function paymentLabel(token: string): string {
  return PAYMENTS_VOCABULARY.labels[token] ?? token;
}

/**
 * How a network compares what a business writes with the synonyms (its foldTerm): lower case, accents off, every run
 * of anything but letters and digits one space, and the words "and" and "e" left out.
 */
const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "" && w !== "and" && w !== "e")
    .join(" ");

const synonyms = new Map(Object.entries(PAYMENTS_VOCABULARY.synonyms).map(([k, v]) => [fold(k), v]));

/** What a business wrote, as a token: a token, a synonym (any capitals and accents), or null. */
export function paymentToken(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (known.has(t)) return t;
  return synonyms.get(fold(s)) ?? null;
}

/** The card brands: each says a card is taken, so a reader that finds one finds `card` too. */
export const CARD_BRANDS: readonly string[] = ["visa", "mastercard", "amex"];

/**
 * How a business is paid as it publishes it: the tokens in the vocabulary's order, each once, unknown ones left out,
 * with `card` when a card brand is among them.
 */
export function publishedPayments(tokens: readonly string[]): string[] {
  const all = new Set(tokens);
  if (CARD_BRANDS.some((b) => all.has(b))) all.add("card");
  return sortPaymentTokens([...all]);
}

/** Tokens in the vocabulary's order, each once, unknown ones left out. */
export function sortPaymentTokens(tokens: readonly string[]): string[] {
  const set = new Set(tokens.filter((t) => known.has(t)));
  return PAYMENT_TOKENS.filter((t) => set.has(t));
}

/* --- paid to an address of the business's own (spec 0.13) ------------------------------------------------------ */

/**
 * The ways to pay that a payer sends to an address the business names (`profile.pay_to`): today only `stripe_pay`,
 * Stripe's business-to-business transfer to a Stripe profile. The money goes from the payer's Stripe account to the
 * business's; nothing between them sees it, so only the business can say it arrived.
 */
export const PAY_TO_METHODS: readonly string[] = ["stripe_pay"];

/** One way to pay sent to an address of the business's own: the token, the address, and the currencies it takes there. */
export const payToSchema = z.object({
  method: z
    .string()
    .regex(/^[a-z0-9_]{2,40}$/)
    .describe("A token of vocab/payments.json that is paid to an address (PAY_TO_METHODS): stripe_pay."),
  to: z
    .string()
    .min(1)
    .max(120)
    .describe("Where to send it: for stripe_pay, a Stripe profile handle (@acme) or profile network id (profile_…)."),
  currencies: z
    .array(z.string().regex(/^[A-Z]{3,4}$/))
    .min(1)
    .max(8)
    .describe("What it takes there: for stripe_pay, USD, GBP or USDC (same-currency transfers)."),
});
export type PayTo = z.infer<typeof payToSchema>;

/** The most `pay_to` entries a profile names, and a reader reads. */
export const MAX_PAY_TO = 8;

/**
 * What a reader keeps of a profile's `pay_to` (`vectors/profile.json`): an entry whose method it knows
 * (`PAY_TO_METHODS`) and the profile's `payments` name too, once per method, with its address in that method's shape
 * (`stripePayRecipient`) and the currencies of it the method takes (any capitals), in the method's order. An entry
 * with no such currency, or anything else, is dropped alone; nothing is read past the first eight.
 */
export function readPayTo(entries: unknown, payments: readonly string[] | undefined): PayTo[] {
  if (!Array.isArray(entries)) return [];
  const out: PayTo[] = [];
  for (const e of entries.slice(0, MAX_PAY_TO)) {
    if (typeof e !== "object" || e === null) continue;
    const { method, to, currencies } = e as Record<string, unknown>;
    if (typeof method !== "string" || !PAY_TO_METHODS.includes(method) || !payments?.includes(method)) continue;
    if (out.some((k) => k.method === method) || typeof to !== "string") continue;
    const address = stripePayRecipient(to);
    if (!address || !Array.isArray(currencies)) continue;
    const named = new Set(
      currencies.filter((c): c is string => typeof c === "string").map((c) => c.trim().toUpperCase()),
    );
    const kept = STRIPE_PAY_CURRENCIES.filter((c) => named.has(c));
    if (kept.length) out.push({ method, to: address, currencies: kept });
  }
  return out;
}
