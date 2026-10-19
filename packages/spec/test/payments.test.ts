import { describe, expect, it } from "vitest";
import {
  isPaymentToken,
  MAX_PROFILE_PAYMENTS,
  PAYMENT_TOKENS,
  PAYMENTS_VOCABULARY,
  paymentLabel,
  paymentToken,
  sortPaymentTokens,
} from "../src/index";
import vocab from "../vocab/payments.json";

/**
 * vocab/payments.json (§4.10): every token named in English, once; every synonym, mark and handler names a token;
 * a handler is words as a network reads a handler's name; and what a business writes reads as the network reads it.
 */
describe("the payments vocabulary", () => {
  it("is well formed", () => {
    expect(PAYMENTS_VOCABULARY.version).toBe(2);
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
