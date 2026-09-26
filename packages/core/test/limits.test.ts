import { describe, expect, it } from "vitest";
import { amountsHeld, amountsIn, discountIn, minorOf } from "../src/negotiation/amounts";
import {
  BREACHES,
  checkAccept,
  checkOffer,
  effectiveFloor,
  type LimitLine,
  refundWithinLimit,
} from "../src/negotiation/limits";
import { DEFAULT_SETTINGS } from "../src/settings/schema";

/**
 * The owner's limits, as a pure function (ADR-018 §4): every breach at its bound, just inside and just
 * outside it. What automation offers outside them becomes a draft; what it would accept is refused.
 * Runs on Node and in workerd.
 */
const base = DEFAULT_SETTINGS.negotiation;
const limits = (ai: Partial<typeof base.ai> = {}, maxRounds = base.maxRounds) => ({
  maxRounds,
  ai: { ...base.ai, ...ai },
});
const line = (price: number, over: Partial<LimitLine> = {}): LimitLine => ({
  price,
  quantity: 1,
  list: 5_000,
  customer: 5_000,
  floor: null,
  ...over,
});
const offer = (lines: LimitLine[], over: Partial<Parameters<typeof checkOffer>[0]> = {}) => ({
  lines,
  round: 2,
  ...over,
});

describe("the floor automation may go to", () => {
  it("is the customer's price out of the box: no discount at all", () => {
    expect(effectiveFloor(line(5_000), 0)).toBe(5_000);
  });

  it("is the higher of the owner's floor and the customer's price less the discount allowed", () => {
    // 10% off 50.00 is 45.00; a floor of 46.00 is higher, so it holds.
    expect(effectiveFloor(line(5_000, { floor: 4_600 }), 10)).toBe(4_600);
    expect(effectiveFloor(line(5_000, { floor: 4_000 }), 10)).toBe(4_500);
  });

  it("counts from the customer's price P, a reward included, and rounds up", () => {
    // A reward made P 47.50; 10% off that is 42.75. On 9.99, 10% off is 8.991: never under 8.99 by rounding.
    expect(effectiveFloor(line(4_750, { customer: 4_750 }), 10)).toBe(4_275);
    expect(effectiveFloor(line(999, { list: 999, customer: 999 }), 10)).toBe(900);
  });

  it("does not exist for what the catalogue does not price", () => {
    expect(effectiveFloor(line(100, { list: null, customer: null }), 10)).toBeNull();
  });

  it("is never above the customer's price: a list price the owner lowered under its floor may still be offered", () => {
    expect(effectiveFloor(line(4_000, { list: 4_000, customer: 4_000, floor: 4_500 }), 0)).toBe(4_000);
    expect(checkOffer(offer([line(4_000, { list: 4_000, customer: 4_000, floor: 4_500 })]), limits())).toEqual([]);
  });
});

describe("amounts of money in words", () => {
  it("are numbers beside a currency, in minor units, however they are written", () => {
    expect(amountsIn("Our lowest is €30, or 27,50 € if you pay now")).toEqual([3_000, 2_750]);
    expect(amountsIn("EUR 1.850,00 or 1,850.00 GBP, £12.5 and 40 euros")).toEqual([185_000, 1_250, 4_000]);
    expect(amountsIn("R$ 99,90 e 10 libras")).toEqual([9_990, 1_000]);
  });

  it("are never a time, a date, a party size, a phone number or a bare number", () => {
    expect(amountsIn("See you at 14:00 on 22/09, a table for 4. Call 912 345 678; order 1234.")).toEqual([]);
  });

  it("read written numbers as people write them", () => {
    expect(minorOf("18")).toBe(1_800);
    expect(minorOf("18,5")).toBe(1_850);
    expect(minorOf("1.850")).toBe(185_000);
    expect(minorOf("1 850,00")).toBe(185_000);
    expect(minorOf("abc")).toBeNull();
  });

  it("include something taken off a price, in either language, and not a percentage alone", () => {
    expect(discountIn("I can do 40% off for you")).toBe(true);
    expect(discountIn("Fazemos 10 % de desconto")).toBe(true);
    expect(discountIn("Your booking is 100% confirmed")).toBe(false);
  });

  it("that an item's terms hold: each amount, and each line's total", () => {
    const held = amountsHeld({
      totalPrice: { value: 3_700, currency: "EUR" },
      orderedItem: [{ name: "Chain", quantity: 2, price: { value: 1_850, currency: "EUR" } }],
    });
    expect([...held].sort()).toEqual([1_850, 3_700]);
  });
});

describe("an offer by automation", () => {
  it("at the customer's price, the time they asked, within the rounds: inside every limit", () => {
    expect(checkOffer(offer([line(5_000)], { timeShiftMin: 0, delayDays: 0 }), limits())).toEqual([]);
  });

  it("below_floor: one cent under the floor, not at it", () => {
    const s = limits({ maxDiscountPct: 10 });
    expect(checkOffer(offer([line(4_500)]), s)).toEqual([]);
    expect(checkOffer(offer([line(4_499)]), s)).toEqual(["below_floor"]);
    expect(checkOffer(offer([line(4_999)]), limits())).toEqual(["below_floor"]);
  });

  it("above_list: one cent over the customer's price, a reward held back included", () => {
    expect(checkOffer(offer([line(5_001)]), limits())).toEqual(["above_list"]);
    // A customer whose reward made their price 47.50 is not offered 50.00 by automation.
    expect(checkOffer(offer([line(5_000, { customer: 4_750 })]), limits())).toEqual(["above_list"]);
    expect(checkOffer(offer([line(4_750, { customer: 4_750 })]), limits())).toEqual([]);
  });

  it("counter_priced: answering a customer's own price with another; taking it is not a counter", () => {
    const s = limits({ maxDiscountPct: 20 });
    expect(checkOffer(offer([line(4_200, { countered: 4_000 })]), s)).toEqual(["counter_priced"]);
    expect(checkOffer(offer([line(4_000, { countered: 4_000 })]), s)).toEqual([]);
    // Taking one under the floor is still under the floor.
    expect(checkOffer(offer([line(3_000, { countered: 3_000 })]), s)).toEqual(["below_floor"]);
  });

  it("custom_line: a price the catalogue does not give, unless the owner allows it; a customer's own, never", () => {
    const custom = offer([line(123, { list: null, customer: null })]);
    expect(checkOffer(custom, limits())).toEqual(["custom_line"]);
    expect(checkOffer(custom, limits({ mayPriceCustom: true }))).toEqual([]);
    expect(checkOffer(offer([], { custom: true }), limits())).toEqual(["custom_line"]);
    expect(checkOffer(offer([], { custom: true }), limits({ mayPriceCustom: true }))).toEqual([]);
    expect(checkOffer(offer([], { customerPriced: true }), limits({ mayPriceCustom: true }))).toEqual(["custom_line"]);
  });

  it("time_moved: a minute past the shift allowed, not at it", () => {
    const s = limits({ maxTimeShiftMin: 60 });
    expect(checkOffer(offer([], { timeShiftMin: 60 }), s)).toEqual([]);
    expect(checkOffer(offer([], { timeShiftMin: 61 }), s)).toEqual(["time_moved"]);
    // Out of the box: a week either way.
    expect(checkOffer(offer([], { timeShiftMin: 10_080 }), limits())).toEqual([]);
    expect(checkOffer(offer([], { timeShiftMin: 10_081 }), limits())).toEqual(["time_moved"]);
  });

  it("delivery_later: any later delivery out of the box; within the days the owner allows", () => {
    expect(checkOffer(offer([], { delayDays: 0 }), limits())).toEqual([]);
    expect(checkOffer(offer([], { delayDays: 0.5 }), limits())).toEqual(["delivery_later"]);
    expect(checkOffer(offer([], { delayDays: 2 }), limits({ maxDelayDays: 2 }))).toEqual([]);
    expect(checkOffer(offer([], { delayDays: 2.01 }), limits({ maxDelayDays: 2 }))).toEqual(["delivery_later"]);
  });

  it("worse_than_before and rounds_exhausted", () => {
    expect(checkOffer(offer([], { worseThanBefore: true }), limits())).toEqual(["worse_than_before"]);
    expect(checkOffer(offer([], { round: 3 }), limits({}, 3))).toEqual([]);
    expect(checkOffer(offer([], { round: 4 }), limits({}, 3))).toEqual(["rounds_exhausted"]);
  });

  it("change_not_allowed: a change to what was agreed, until the owner lets automation ask for one", () => {
    expect(checkOffer(offer([], { change: true }), limits())).toEqual(["change_not_allowed"]);
    expect(checkOffer(offer([], { change: true }), limits({ mayProposeChanges: true }))).toEqual([]);
  });

  it("names every limit it is outside, once, in one order, and never a number", () => {
    const all = checkOffer(
      offer([line(6_000), line(10, { list: null, customer: null }), line(1)], {
        round: 9,
        worseThanBefore: true,
        timeShiftMin: 99_999,
        delayDays: 99,
        change: true,
      }),
      limits(),
    );
    expect(all).toEqual([
      "below_floor",
      "above_list",
      "custom_line",
      "time_moved",
      "delivery_later",
      "worse_than_before",
      "rounds_exhausted",
      "change_not_allowed",
    ]);
    for (const b of all) expect(BREACHES).toContain(b);
    expect(JSON.stringify(all)).not.toMatch(/\d/);
  });
});

describe("an acceptance by automation", () => {
  it("takes a customer's price at or above the floor, never under it", () => {
    const s = limits({ maxDiscountPct: 10 });
    expect(checkAccept({ lines: [line(4_500)] }, s)).toEqual([]);
    expect(checkAccept({ lines: [line(4_499)] }, s)).toEqual(["below_floor"]);
    expect(checkAccept({ lines: [line(4_999)] }, limits())).toEqual(["below_floor"]);
  });

  it("over_approval_value: above the value the owner accepts in person, when they set one", () => {
    expect(checkAccept({ lines: [], total: 20_000, approvalMax: 0 }, limits())).toEqual([]);
    expect(checkAccept({ lines: [], total: 20_000, approvalMax: 20_000 }, limits())).toEqual([]);
    expect(checkAccept({ lines: [], total: 20_001, approvalMax: 20_000 }, limits())).toEqual(["over_approval_value"]);
  });
});

describe("a refund with nothing to send back", () => {
  it("is never automation's out of the box, and only up to the amount the owner allows", () => {
    expect(refundWithinLimit(1, limits())).toBe(false);
    expect(refundWithinLimit(2_000, limits({ maxRefundMinor: 2_000 }))).toBe(true);
    expect(refundWithinLimit(2_001, limits({ maxRefundMinor: 2_000 }))).toBe(false);
  });
});
