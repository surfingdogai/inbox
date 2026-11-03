import { describe, expect, it } from "vitest";
import { orderableProduct } from "../src/probe";

/**
 * The order probe's product: the first on sale at a fixed price. A price on request has none, and a
 * `from` or `range` price is only where it starts, which a person quotes: ordering one would report a
 * healthy order door as failing.
 */
describe("the order probe", () => {
  it("orders the first product on sale at a fixed price, never a quote, a from or a range", () => {
    const items = [
      { id: "cake", name: "Wedding cake", price: null, price_model: "quote", active: 1 },
      { id: "box", name: "Gift box", price: { value: 2500, currency: "EUR" }, price_model: "from", active: 1 },
      { id: "old", name: "Old mug", price: { value: 900, currency: "EUR" }, price_model: "fixed", active: 0 },
      { id: "mug", name: "Mug", price: { value: 900, currency: "EUR" }, price_model: "fixed", active: 1 },
    ];
    expect(orderableProduct(items)).toMatchObject({ id: "mug" });
    // An inbox from before catalogue version 2 says no price model: a fixed price.
    expect(
      orderableProduct([{ id: "tea", name: "Tea", price: { value: 300, currency: "EUR" }, active: 1 }]),
    ).toMatchObject({
      id: "tea",
    });
  });

  it("says why there is nothing to order", () => {
    expect(orderableProduct([])).toEqual({ none: "no product to order" });
    expect(orderableProduct([{ id: "cake", name: "Cake", price: null, price_model: "quote", active: 1 }])).toEqual({
      none: "no fixed-price product to order",
    });
  });
});
