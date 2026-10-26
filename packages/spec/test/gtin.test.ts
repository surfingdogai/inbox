import { describe, expect, it } from "vitest";
import { expandUpcE, GTIN_PREFIXES, type GtinHint, gtinCheckDigit, gtinDisplay, normaliseGtin } from "../src/index";
import vectors from "../vectors/gtin.json";

/**
 * Barcodes (protocol §4.18, ADR-029) against `vectors/gtin.json`, which the network's Go is held to
 * as well. Node and workerd.
 */

describe("vectors/gtin.json", () => {
  for (const c of vectors.cases) {
    it(`${c.name}: ${JSON.stringify(c.input)} (${c.hint})`, () => {
      expect(normaliseGtin(c.input, c.hint as GtinHint)).toEqual(c.expect);
    });
  }

  it("pins the prefixes the code reads by", () => {
    expect(vectors.prefixes.restricted).toEqual(GTIN_PREFIXES.restricted);
    expect(vectors.prefixes.coupon).toEqual(GTIN_PREFIXES.coupon);
    expect(vectors.prefixes.serial).toEqual(GTIN_PREFIXES.serial);
    expect(vectors.prefixes.book).toEqual(GTIN_PREFIXES.book);
    expect(vectors.prefixes.restricted_gtin8).toEqual(GTIN_PREFIXES.restrictedGtin8);
    expect(vectors.prefixes.restricted_indicator).toEqual(GTIN_PREFIXES.restrictedIndicator);
  });

  it("expands a UPC-E for each sixth digit, 0 to 9, to its UPC-A, and reads it from a UPC column", () => {
    expect(vectors.upc_e.map((v) => v.upc_e.charAt(6))).toEqual("0123456789".split(""));
    for (const v of vectors.upc_e) {
      expect(expandUpcE(v.upc_e), v.upc_e).toBe(v.upc_a);
      expect(normaliseGtin(v.upc_e, "upc")).toEqual({
        ok: { gtin14: v.upc_a.padStart(14, "0"), form: "gtin12", kind: "global", level: "unit", repaired: "upc_e" },
      });
    }
  });
});

describe("normaliseGtin", () => {
  const good = vectors.cases.flatMap((c) =>
    "ok" in c.expect && !c.expect.ok.repaired && /^(\d{8}|\d{12,14})$/.test(c.input) ? [c.input] : [],
  );

  it("refuses every barcode with any one digit changed, and says the digit it expected", () => {
    expect(good.length).toBeGreaterThan(8);
    for (const code of good) {
      for (let at = 0; at < code.length; at++) {
        const digit = Number(code[at]);
        for (const other of [1, 5, 9]) {
          const changed = `${code.slice(0, at)}${(digit + other) % 10}${code.slice(at + 1)}`;
          const r = normaliseGtin(changed, "barcode");
          expect(r, `${code} → ${changed}`).toMatchObject({ problem: "check_digit" });
          // A wrong last digit is told the right one; the others are told what their digits add up to.
          if (at === code.length - 1) expect(r).toEqual({ problem: "check_digit", expected: digit });
        }
      }
    }
  });

  it("gives spreadsheet_number for a number Excel or Sheets shortened, whatever its exponent", () => {
    for (const raw of ["4.00638E+12", "4.00638e+12", "4E+12", "9,78030E+12", "1.23456789012E13"]) {
      expect(normaliseGtin(raw)).toEqual({ problem: "spreadsheet_number" });
    }
  });

  it("never corrects or guesses: the same input reads the same, and a problem carries no barcode", () => {
    const r = normaliseGtin("4006381333932");
    expect(r).not.toHaveProperty("ok");
    expect(normaliseGtin("4006381333931")).toEqual(normaliseGtin("4006381333931"));
  });

  it("works out GS1's check digit, and prints a barcode in its shortest form", () => {
    expect(gtinCheckDigit("400638133393")).toBe(1);
    expect(gtinCheckDigit("0950600013435")).toBe(2);
    expect(gtinDisplay("04006381333931")).toBe("4006381333931");
    expect(gtinDisplay("00036000291452")).toBe("036000291452");
    expect(gtinDisplay("00000096385074")).toBe("96385074");
    expect(gtinDisplay("10616123456784")).toBe("10616123456784");
  });
});
