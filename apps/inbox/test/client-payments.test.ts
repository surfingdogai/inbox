import { PAYMENT_TOKENS, PAYMENTS_VOCABULARY, paymentLabel, settingsSchema } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  CARD_BRANDS,
  localPayments,
  PAYMENT_GROUPS,
  PAYMENT_ORDER,
  paymentGroupsFor,
  paymentName,
  samePayments,
  togglePayment,
  withCard,
} from "../client/src/lib/payments";

/**
 * Settings → Payments, the owner app's side: every way a person pays of the vocabulary is offered once, by the name
 * the network shows; a business's local ways are out beside the everyday ones; card brands sit under Card; and a
 * press saves the list in the order the manifest publishes it. Node and workerd.
 */
describe("the ways to pay the owner picks from", () => {
  it("offer every way a person pays, once each, and no agent's way", () => {
    const offered = PAYMENT_GROUPS.flatMap((g) => g.tokens);
    expect(new Set(offered).size).toBe(offered.length);
    const person = [...PAYMENTS_VOCABULARY.methods, ...PAYMENTS_VOCABULARY.wallets];
    expect([...offered].sort()).toEqual([...person].sort());
    for (const t of PAYMENTS_VOCABULARY.agent) expect(offered, t).not.toContain(t);
    expect(PAYMENT_ORDER).toEqual(PAYMENT_TOKENS);
    for (const t of offered) expect(paymentName(t), t).toBe(paymentLabel(t));
    expect(paymentName("stripe_link")).toBe("Stripe Link");
    // The settings take every one of them at once.
    expect(settingsSchema.parse({ payments: { accepted: offered } }).payments.accepted).toHaveLength(offered.length);
  });

  it("show a business's own local ways open, in every region, and fold the rest", () => {
    expect(localPayments("PT")).toEqual(["mb_way", "multibanco", "sepa"]);
    expect(localPayments("br")).toEqual(["pix", "mercado_pago"]);
    expect(localPayments("KE")).toEqual(["mpesa"]);
    expect(localPayments("US")).toEqual(["venmo", "cash_app", "zelle"]);
    expect(localPayments("JP")).toEqual(["paypay"]);
    expect(localPayments("DE")).toEqual(["sepa"]);
    expect(localPayments("GB")).toEqual([]);
    expect(localPayments(null)).toEqual([]);
    const pt = paymentGroupsFor("PT");
    expect(pt.shown.map((g) => g.title)).toEqual(["Cards", "Wallets", "In person and by bank", "Local"]);
    expect(pt.shown.at(-1)?.tokens).toEqual(["mb_way", "multibanco", "sepa"]);
    expect(pt.more.map((g) => g.title)).toEqual(["Elsewhere", "Pay later", "Other"]);
    const folded = pt.more.flatMap((g) => g.tokens);
    expect(folded).not.toContain("mb_way");
    expect(folded).toContain("pix");
    // A Gulf business's pay-later ways are its local ones.
    expect(paymentGroupsFor("AE").more.find((g) => g.id === "later")?.tokens).toEqual(["klarna", "afterpay", "affirm"]);
    // Nowhere known: nothing local open, everything still offered once.
    const none = paymentGroupsFor(undefined);
    expect(none.shown.map((g) => g.id)).toEqual(["cards", "wallets", "everyday"]);
    expect(none.more.map((g) => g.title)).toEqual(["Local", "Pay later", "Other"]);
    expect([...none.shown, ...none.more].flatMap((g) => g.tokens)).toHaveLength(
      PAYMENT_GROUPS.flatMap((g) => g.tokens).length,
    );
  });

  it("save a press as the list in the vocabulary's order, a brand with Card", () => {
    let accepted = togglePayment([], "apple_pay", true);
    accepted = togglePayment(accepted, "card", true);
    accepted = togglePayment(accepted, "mb_way", true);
    expect(accepted).toEqual(["card", "mb_way", "apple_pay"]);
    expect(togglePayment(accepted, "card", true)).toEqual(accepted);
    expect(togglePayment(accepted, "mb_way", false)).toEqual(["card", "apple_pay"]);
    expect(settingsSchema.parse({ payments: { accepted } }).payments.accepted).toEqual(accepted);
    // A brand ticks Card; Card unticked takes the brands with it.
    expect(togglePayment([], "visa", true)).toEqual(["card", "visa"]);
    const brands = togglePayment(togglePayment(["card"], "visa", true), "amex", true);
    expect(brands).toEqual(["card", "visa", "amex"]);
    expect(togglePayment(brands, "card", false)).toEqual([]);
    expect(withCard(["mastercard", "cash"])).toEqual(["card", "mastercard", "cash"]);
    expect(CARD_BRANDS.every((b) => PAYMENT_GROUPS[0]?.tokens.includes(b))).toBe(true);
    // Anything the tab does not show stays as it was.
    expect(togglePayment(["x402"], "cash", true)).toEqual(["cash", "x402"]);
    expect(samePayments(["card", "cash"], ["cash", "card"])).toBe(true);
    expect(samePayments(["card"], ["card", "cash"])).toBe(false);
  });
});
