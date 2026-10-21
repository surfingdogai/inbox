import { decimalOf, ISO_4217_MINOR_UNITS, minorUnits, parseDecimal, shareOf } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { moneyIn } from "../src/customer/format";
import { amountsIn, minorOf } from "../src/negotiation/amounts";
import { currencyProblem, isMoneyCurrency } from "../src/util/locale";
import { formatMinor, moneyText } from "../src/util/money";

/**
 * Money in every currency's own minor unit (ADR-032): the ten currencies the plan names, from no
 * minor unit to thousandths, each taken, counted, written and read back in its own places.
 */
const CASES = [
  { code: "JPY", e: 0, minor: 90_540, decimal: "90540", number: "90,540" },
  { code: "KRW", e: 0, minor: 120_000, decimal: "120000", number: "120,000" },
  { code: "VND", e: 0, minor: 2_500_000, decimal: "2500000", number: "2,500,000" },
  { code: "CLP", e: 0, minor: 45_000, decimal: "45000", number: "45,000" },
  { code: "ISK", e: 0, minor: 18_900, decimal: "18900", number: "18,900" },
  { code: "KWD", e: 3, minor: 42_750, decimal: "42.750", number: "42.750" },
  { code: "BHD", e: 3, minor: 9_125, decimal: "9.125", number: "9.125" },
  { code: "INR", e: 2, minor: 1_250_050, decimal: "12500.50", number: "12,500.50" },
  { code: "MXN", e: 2, minor: 189_900, decimal: "1899.00", number: "1,899.00" },
  { code: "KES", e: 2, minor: 450_000, decimal: "4500.00", number: "4,500.00" },
] as const;

describe("money in each currency's own minor unit", () => {
  it("knows the ISO 4217 exponent of each, and takes every one for a price", () => {
    for (const c of CASES) {
      expect(minorUnits(c.code), c.code).toBe(c.e);
      expect(isMoneyCurrency(c.code), c.code).toBe(true);
      expect(currencyProblem(c.code), c.code).toBeNull();
    }
    // Fund codes, metals, testing and made-up codes are not money anyone prices in.
    for (const bad of ["CLF", "UYW", "XAU", "XTS", "XXX", "ABC", "jpy"]) expect(isMoneyCurrency(bad), bad).toBe(false);
    expect(Object.values(ISO_4217_MINOR_UNITS).every((e) => [0, 2, 3, 4].includes(e))).toBe(true);
  });

  it("writes and reads each amount as a decimal in its own places", () => {
    for (const c of CASES) {
      expect(decimalOf(c.minor, c.code), c.code).toBe(c.decimal);
      expect(parseDecimal(c.decimal, c.code), c.code).toBe(c.minor);
    }
    // A part smaller than the minor unit is not an amount of it; zeros past it are.
    expect(parseDecimal("4500.5", "JPY")).toBeNull();
    expect(parseDecimal("4500.00", "JPY")).toBe(4_500);
    expect(parseDecimal("1.2345", "KWD")).toBeNull();
    expect(parseDecimal("12.3", "EUR")).toBe(1_230);
    expect(decimalOf(5, "EUR")).toBe("0.05");
    expect(decimalOf(5, "KWD")).toBe("0.005");
    expect(decimalOf(1, "XXX")).toBeNull();
  });

  it("shows each amount in its own places, never a hundred times wrong", () => {
    // The number exactly; the sign as the runtime's own locale data writes it (¥, JP¥, KES, Ksh).
    for (const c of CASES) {
      const text = moneyText({ value: c.minor, currency: c.code });
      expect(text.replace(/[^\d.,]/g, "").replace(/^[.,]+|[.,]+$/g, ""), c.code).toBe(c.number);
    }
    expect(moneyIn({ value: 90_540, currency: "JPY" }, "en")).toMatch(/90,540$/);
    expect(moneyIn({ value: 42_750, currency: "KWD" }, "pt")).toMatch(/42,750/);
    expect(formatMinor({ value: 4_500, currency: "XYZ" }, "en")).toBe("4500 XYZ");
  });

  it("takes a share of an amount, rounded half away from zero to the minor unit", () => {
    expect(shareOf(77_400, 1_000)).toBe(7_740);
    expect(shareOf(25, 1_000)).toBe(3);
    expect(shareOf(-25, 1_000)).toBe(-3);
    expect(shareOf(14, 5_000)).toBe(7);
    expect(shareOf(15, 5_000)).toBe(8);
  });

  it("reads amounts in a reply in the currency they are written in", () => {
    expect(amountsIn("It comes to ¥90,540 in all", 20, "JPY")).toEqual([90_540]);
    expect(amountsIn("A deposit of KSh 4,500 holds it", 20, "KES")).toEqual([450_000]);
    expect(amountsIn("That is KWD 42.750", 20, "KWD")).toEqual([42_750]);
    // A dollar sign is pesos in Santiago, with no minor unit, and cents in Toronto.
    expect(amountsIn("$45.000 por noche", 20, "CLP")).toEqual([45_000]);
    expect(amountsIn("$45.00 a night", 20, "CAD")).toEqual([4_500]);
    expect(minorOf("4.500", 3)).toBe(4_500);
    expect(minorOf("4.5", 0)).toBeNull();
    // Never a word that is also a code: "all 30 rooms" names no money.
    expect(amountsIn("We have all 30 rooms ready")).toEqual([]);
  });
});
