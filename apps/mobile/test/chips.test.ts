import { describe, expect, it } from "vitest";
import {
  chipLang,
  chipLangs,
  DEFAULT_CHIPS,
  MAX_PRICE_CHIPS,
  type PublicService,
  priceChips,
  priceOffer,
  replyChips,
} from "../src/lib/chips";
import type { QuickReply } from "../src/lib/replies";

/**
 * One-tap answers (ADR-028 Amendment 5): chips only from the inbox's public services and the owner's
 * saved replies, never from anything else; the default ones only in English or Portuguese, and only
 * for a business that speaks it.
 */
const service = (id: string, name: string, price: PublicService["price"]): PublicService => ({ id, name, price });
const SERVICES: PublicService[] = [
  service("lunch", "Lunch for one", { model: "fixed", value: 3500, currency: "EUR" }),
  service("tasting", "Tasting menu", { model: "fixed", value: 1200, currency: "EUR", per: "person" }),
  service("cake", "Celebration cake", { model: "from", value: 2800, currency: "EUR" }),
  service("catering", "Catering", { model: "quote" }),
  service("free", "Tap water", { model: "fixed", value: 0, currency: "EUR" }),
];
const saved = (...texts: string[]): QuickReply[] => texts.map((text, i) => ({ id: `r${i}`, text, at: i }));

describe("the chips on a message", () => {
  it("are in the business's language only when it is one we write for customers", () => {
    expect(chipLang(["en"])).toBe("en");
    expect(chipLang(["pt-PT", "en"])).toBe("pt");
    expect(chipLang(["de", "pt", "en"])).toBe("pt");
    expect(chipLang(["EN-gb"])).toBe("en");
    expect(chipLang(["de", "fr"])).toBeNull();
    expect(chipLang([])).toBeNull();
  });

  it("are the owner's own words first, then the default ones in that language", () => {
    expect(replyChips(saved("Come by any time before six."), ["en"])).toEqual([
      { text: "Come by any time before six.", saved: true },
      { text: "Yes, we can.", saved: false },
      { text: "Sorry, not that day.", saved: false },
    ]);
    expect(replyChips([], ["pt"]).map((c) => c.text)).toEqual([...DEFAULT_CHIPS.pt]);
  });

  it("are only the owner's words for a business that speaks neither language", () => {
    expect(replyChips(saved("Ja, gerne."), ["de"])).toEqual([{ text: "Ja, gerne.", saved: true }]);
    expect(replyChips([], ["de"])).toEqual([]);
    // Not known (offline, never read): no default ones either.
    expect(replyChips([], [])).toEqual([]);
  });

  it("are in the customer's language when the business speaks it, and both when it speaks both and theirs is not known", () => {
    expect(chipLangs(["pt", "en"], "en-GB")).toEqual(["en"]);
    expect(chipLangs(["en", "pt"], "pt-PT")).toEqual(["pt"]);
    expect(chipLangs(["pt", "en"], null)).toEqual(["pt", "en"]);
    // A language the business does not speak: its own.
    expect(chipLangs(["en"], "pt")).toEqual(["en"]);
    expect(chipLangs(["de"], "en")).toEqual([]);
    expect(replyChips([], ["pt", "en"], "en").map((c) => c.text)).toEqual([...DEFAULT_CHIPS.en]);
    expect(replyChips([], ["pt", "en"]).map((c) => c.text)).toEqual([...DEFAULT_CHIPS.pt, ...DEFAULT_CHIPS.en]);
  });

  it("never say the same words twice", () => {
    expect(replyChips(saved("yes, we  can."), ["en"]).map((c) => c.text)).toEqual([
      "yes, we  can.",
      "Sorry, not that day.",
    ]);
  });
});

describe("the chips on a request for a price", () => {
  it("are the matching prices from the public list, as it states them", () => {
    expect(priceChips({ itemOffered: { name: "Lunch for one" } }, SERVICES, "EUR")).toEqual([
      {
        serviceId: "lunch",
        label: "€35 · Lunch for one",
        amount: { value: 3500, currency: "EUR" },
        service: "Lunch for one",
      },
    ]);
    expect(priceChips({ itemOffered: { name: "A celebration cake" } }, SERVICES, "EUR")).toEqual([
      {
        serviceId: "cake",
        label: "From €28 · Celebration cake",
        amount: { value: 2800, currency: "EUR" },
        service: "Celebration cake",
        from: true,
      },
    ]);
  });

  it("price every one asked for, whatever the price is for", () => {
    expect(priceChips({ itemOffered: { name: "Lunch for one" }, quantity: 3 }, SERVICES, "EUR")).toEqual([
      {
        serviceId: "lunch",
        label: "€35 · Lunch for one",
        amount: { value: 10500, currency: "EUR" },
        service: "Lunch for one",
        each: { quantity: 3, price: { value: 3500, currency: "EUR" } },
      },
    ]);
  });

  it("price one per person for the people asked for", () => {
    expect(priceChips({ itemOffered: { name: "Tasting menu" }, quantity: 4 }, SERVICES, "EUR")).toEqual([
      {
        serviceId: "tasting",
        label: "€12 a person · Tasting menu",
        amount: { value: 4800, currency: "EUR" },
        service: "Tasting menu",
        each: { quantity: 4, price: { value: 1200, currency: "EUR" } },
      },
    ]);
  });

  it("are only the service a request names, when it names one", () => {
    const named = priceChips({ itemOffered: { name: "Lunch for one", serviceId: "cake" } }, SERVICES, "EUR");
    expect(named.map((c) => c.service)).toEqual(["Celebration cake"]);
    // A service priced on request has no price to offer, and nothing else stands in for it.
    expect(priceChips({ itemOffered: { name: "Catering", serviceId: "catering" } }, SERVICES, "EUR")).toEqual([]);
  });

  it("are none when nothing matches, nor for a price of nothing", () => {
    expect(priceChips({ itemOffered: { name: "Wedding flowers" } }, SERVICES, "EUR")).toEqual([]);
    expect(priceChips({ itemOffered: { name: "Tap water" } }, SERVICES, "EUR")).toEqual([]);
    // A word in common is not a match: one whole name within the other is.
    expect(priceChips({ itemOffered: { name: "Lunch menu" } }, SERVICES, "EUR")).toEqual([]);
    expect(priceChips({ itemOffered: { name: "Lunch" } }, SERVICES, "EUR").map((c) => c.service)).toEqual([
      "Lunch for one",
    ]);
  });

  it("are a few at most, in the business's currency when a price names none", () => {
    const many = Array.from({ length: 6 }, (_, i) => service(`s${i}`, "Repair", { model: "fixed", value: 1000 + i }));
    const chips = priceChips({ itemOffered: { name: "Repair" } }, many, "GBP");
    expect(chips).toHaveLength(MAX_PRICE_CHIPS);
    expect(chips[0]?.amount.currency).toBe("GBP");
  });

  it("send the inbox's own offer for a price: a total, and the note when there is one", () => {
    expect(priceOffer({ value: 8000, currency: "EUR" }, "  About two hours. ")).toEqual({
      totalPrice: { value: 8000, currency: "EUR" },
      notes: "About two hours.",
    });
    expect(priceOffer({ value: 8000, currency: "EUR" }, " ")).toEqual({ totalPrice: { value: 8000, currency: "EUR" } });
  });
});
