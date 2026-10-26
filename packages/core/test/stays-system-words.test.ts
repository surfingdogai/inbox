import { describe, expect, it } from "vitest";
import { type AriCell, cachedNights } from "../src/property/ari";
import { confirmationSentence } from "../src/stays/public";
import type { PropertySetup } from "../src/stays/store";

/**
 * A place to stay connected to its own system (ADR-037 §4.1, §6.1): guests read how it confirms in the
 * business's own words, never the name of the software behind it; and a stay priced from the system's
 * calendar is priced on one of its prices every night, never one night on one and the next on another.
 */

function setup(instant: boolean): PropertySetup {
  return {
    property: { mode: "connected", instant, answerHours: 4, connectorId: "conn_1" },
    rates: [],
    allotments: [],
    rooms: [],
  } as unknown as PropertySetup;
}

function cell(night: string, prices: Record<string, number>): AriCell {
  return {
    roomExtId: "512031",
    night,
    units: 2,
    closed: false,
    minStay: null,
    maxStay: null,
    noArrival: false,
    noDeparture: false,
    prices,
    fetchedAt: 0,
    stale: false,
    source: "poll",
  };
}

describe("A connected place to stay, in its own words", () => {
  it("never names its system to guests, and names it to the owner", () => {
    expect(confirmationSentence(setup(true), "Beds24", "guest")).toBe(
      "Free rooms confirm at once. Anything else is on request; I answer within 4 hours.",
    );
    expect(confirmationSentence(setup(false), "Beds24", "guest")).toBe("I confirm each stay within 4 hours.");
    expect(confirmationSentence(setup(false), "Beds24")).toMatch(/Beds24/);
  });

  it("prices a stay on one of the calendar's prices every night, or not at all", () => {
    const nights = ["2027-05-01", "2027-05-02", "2027-05-03"];
    const cells = [
      cell("2027-05-01", { price2: 900, price1: 980 }),
      cell("2027-05-02", { price1: 1_020, price2: 940 }),
      cell("2027-05-03", { price1: 1_020, price2: 940 }),
    ];
    // price1 before price2 whatever order the night lists them in.
    expect(cachedNights(cells, "512031", null, nights)?.map((n) => n.amount)).toEqual([980, 1_020, 1_020]);
    expect(cachedNights(cells, "512031", "price2", nights)?.map((n) => n.amount)).toEqual([900, 940, 940]);
    // A night without that price: no quote from the cache, never a mix of two prices.
    const mixed = [cell("2027-05-01", { price1: 980 }), cell("2027-05-02", { price2: 940 }), cells[2] as AriCell];
    expect(cachedNights(mixed, "512031", null, nights)).toBeNull();
    // A price10 is not taken before price2.
    expect(cachedNights([cell("2027-05-01", { price10: 5, price2: 7 })], "512031", null, ["2027-05-01"])).toEqual([
      { night: "2027-05-01", amount: 7 },
    ]);
  });
});
