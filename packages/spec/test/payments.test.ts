import { describe, expect, it } from "vitest";
import {
  isPaymentToken,
  MAX_PROFILE_PAYMENTS,
  PAY_TO_METHODS,
  PAYMENT_TOKENS,
  PAYMENTS_VOCABULARY,
  paymentLabel,
  paymentToken,
  profileSchema,
  readPayTo,
  STRIPE_PAY_CURRENCIES,
  sortPaymentTokens,
  stripePayRecipient,
} from "../src/index";
import vocab from "../vocab/payments.json";

/**
 * vocab/payments.json (§4.10): every token named in English, once; every synonym, mark and handler names a token;
 * a handler is words as a network reads a handler's name; and what a business writes reads as the network reads it.
 */
describe("the payments vocabulary", () => {
  it("is well formed", () => {
    expect(PAYMENTS_VOCABULARY.version).toBe(3);
    expect(new Set(PAYMENT_TOKENS).size).toBe(PAYMENT_TOKENS.length);
    for (const t of PAYMENT_TOKENS) {
      expect(t, t).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
      expect(vocab.labels[t as keyof typeof vocab.labels], `${t}'s label`).toBeTruthy();
    }
    expect(Object.keys(vocab.labels).sort()).toEqual([...PAYMENT_TOKENS].sort());
    for (const [s, t] of Object.entries(vocab.synonyms)) expect(isPaymentToken(t), `synonym ${s}`).toBe(true);
    for (const [m, t] of Object.entries(vocab.marks)) expect(isPaymentToken(t), `mark ${m}`).toBe(true);
    for (const [words, t] of [...vocab.handlers, ...vocab.handlers_last]) {
      expect(isPaymentToken(t as string), `handler ${words}`).toBe(true);
      expect(words, `handler ${words} is lower-case words`).toMatch(/^[a-z0-9]+( [a-z0-9]+)*$/);
    }
    // A profile may name every token.
    expect(PAYMENT_TOKENS.length).toBeLessThanOrEqual(MAX_PROFILE_PAYMENTS);
    // A brand's token is read only from words that name the brand: never a bare "agent pay", nor "bar".
    expect(Object.keys(vocab.synonyms)).not.toContain("agent pay");
    expect(Object.keys(vocab.synonyms)).not.toContain("bar");
    expect(vocab.handlers.map(([w]) => w)).not.toContain("agent pay");
    expect(vocab.handlers.map(([w]) => w)).not.toContain("card");
  });

  it("reads what a business writes, as a network reads it", () => {
    expect(paymentToken("Apple Pay")).toBe("apple_pay");
    expect(paymentToken("  apple_pay ")).toBe("apple_pay");
    expect(paymentToken("Cartão de crédito")).toBe("card");
    expect(paymentToken("Überweisung")).toBe("bank_transfer");
    expect(paymentToken("SEPA Direct Debit")).toBe("sepa");
    expect(paymentToken("Visa Intelligent Commerce")).toBe("visa_intelligent_commerce");
    expect(paymentToken("Link")).toBeNull();
    expect(paymentLabel("stripe_link")).toBe("Stripe Link");
    expect(paymentToken("M-Pesa")).toBe("mpesa");
    expect(paymentToken("Cash App")).toBe("cash_app");
    expect(paymentToken("Mercado Pago")).toBe("mercado_pago");
    expect(paymentToken("Zahlung in bar")).toBe("cash");
    expect(paymentToken("bar")).toBeNull();
    expect(paymentToken("agent pay")).toBeNull();
    expect(paymentLabel("mb_way")).toBe("MB WAY");
    expect(paymentLabel("unknown")).toBe("unknown");
    expect(sortPaymentTokens(["x402", "apple_pay", "nope", "card", "card"])).toEqual(["card", "apple_pay", "x402"]);
  });
});

/**
 * Stripe Pay (spec 0.13): a transfer to a Stripe profile, which the business names in its profile's `pay_to`. Only the
 * business's own word declares it: no mark, no handler, and a handle is never made up from anything else.
 */
describe("Stripe Pay", () => {
  it("is a way a person pays, named only by the business", () => {
    expect(PAYMENTS_VOCABULARY.methods).toContain("stripe_pay");
    expect(paymentLabel("stripe_pay")).toBe("Stripe Pay");
    expect(paymentToken("Stripe Pay")).toBe("stripe_pay");
    expect(paymentToken("stripe_pay")).toBe("stripe_pay");
    // Stripe alone is a card provider, never Stripe Pay; no mark or handler reads it from a site.
    expect(paymentToken("Stripe")).toBeNull();
    expect(Object.values(vocab.marks)).not.toContain("stripe_pay");
    expect(vocab.handlers.map(([, t]) => t)).not.toContain("stripe_pay");
    expect(PAY_TO_METHODS).toEqual(["stripe_pay"]);
    expect(STRIPE_PAY_CURRENCIES).toEqual(["USD", "GBP", "USDC"]);
  });

  it("reads a handle or a profile id, and nothing else", () => {
    expect(stripePayRecipient("@acme")).toBe("@acme");
    expect(stripePayRecipient("  @Acme_Bakery ")).toBe("@acme_bakery");
    expect(stripePayRecipient("acme")).toBe("@acme");
    expect(stripePayRecipient("@a")).toBe("@a");
    expect(stripePayRecipient("@acme.co-uk")).toBe("@acme.co-uk");
    expect(stripePayRecipient("profile_61TpVxQ2bC")).toBe("profile_61TpVxQ2bC");
    expect(stripePayRecipient("profile_test_61Tp")).toBe("profile_test_61Tp");
    for (const bad of [
      "",
      "@",
      "@-acme",
      "@acme-",
      "@ac me",
      "@acme!",
      "https://stripe.com/@acme",
      "ana@acme.example",
    ]) {
      expect(stripePayRecipient(bad), bad).toBeNull();
    }
    expect(stripePayRecipient(`@${"a".repeat(50)}`)).toBe(`@${"a".repeat(50)}`);
    expect(stripePayRecipient(`@${"a".repeat(51)}`)).toBeNull();
    expect(stripePayRecipient("profile_")).toBeNull();
  });

  it("keeps a profile's pay_to as a network reads it: each entry alone", () => {
    const payments = ["card", "stripe_pay"];
    expect(
      readPayTo([{ method: "stripe_pay", to: "@Acme", currencies: ["gbp", "usd", "eur", "USDC"] }], payments),
    ).toEqual([{ method: "stripe_pay", to: "@acme", currencies: ["USD", "GBP", "USDC"] }]);
    // Not named by payments, an unknown method, a bad address, no currency it takes there, a second entry: dropped.
    expect(readPayTo([{ method: "stripe_pay", to: "@acme", currencies: ["GBP"] }], ["card"])).toEqual([]);
    expect(readPayTo([{ method: "venmo", to: "@acme", currencies: ["USD"] }], ["venmo"])).toEqual([]);
    expect(readPayTo([{ method: "stripe_pay", to: "acme bakery", currencies: ["GBP"] }], payments)).toEqual([]);
    expect(readPayTo([{ method: "stripe_pay", to: "@acme", currencies: ["EUR"] }], payments)).toEqual([]);
    expect(
      readPayTo(
        [
          { method: "stripe_pay", to: "@nope!", currencies: ["GBP"] },
          { method: "stripe_pay", to: "@acme", currencies: ["GBP"] },
          { method: "stripe_pay", to: "@other", currencies: ["USD"] },
        ],
        payments,
      ),
    ).toEqual([{ method: "stripe_pay", to: "@acme", currencies: ["GBP"] }]);
    expect(readPayTo("@acme", payments)).toEqual([]);
    expect(readPayTo(undefined, payments)).toEqual([]);
    // The profile may carry it; a profile without it reads as before.
    expect(
      profileSchema.safeParse({
        name: "Acme",
        payments,
        pay_to: [{ method: "stripe_pay", to: "@acme", currencies: ["GBP"] }],
      }).success,
    ).toBe(true);
    expect(profileSchema.safeParse({ name: "Acme", payments }).success).toBe(true);
  });
});
