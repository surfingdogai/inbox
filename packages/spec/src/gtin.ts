import placeholders from "../vocab/placeholder-titles.json" with { type: "json" };

/**
 * Barcodes (protocol §4.18, ADR-029): one check, in every language that reads a product, held to
 * `vectors/gtin.json`. An inbox runs it on every barcode a feed, a connector or a person gives it,
 * and a network runs the same vectors on what it reads, so a barcode that one side takes the other
 * takes too, and one that is a shop's own code or a coupon is never matched to anything.
 *
 * What it does, in order:
 *
 * 1. Trims, then reads a value a spreadsheet turned into a number (`4.00638E+12`) as
 *    `spreadsheet_number`: its last digits are gone and cannot come back. Spaces, hyphens and full
 *    stops are then removed, and so is a leading `(01)`, or the `01` of a 16-digit GS1-128 or
 *    DataMatrix scan.
 * 2. Reads an ISBN-10 whose own check holds (`X` allowed) as the book's barcode: `978`, its first
 *    nine digits and a new check digit.
 * 3. Refuses anything left that is not a digit (`not_digits`).
 * 4. Takes 8 digits as an EAN-8, or, from a field that said UPC (`hint: "upc"`) and starting 0 or 1,
 *    as a UPC-E, expanded to its UPC-A. Takes 11 digits only from a field that said barcode or UPC,
 *    as a UPC-A whose leading 0 a spreadsheet dropped. Takes 12, 13 and 14 as given. Refuses any other
 *    length (`length`).
 * 5. Checks GS1's mod-10 check digit, and refuses a wrong one with the digit it expected
 *    (`check_digit`): nothing is corrected and nothing is guessed.
 * 6. Pads to 14 digits, refuses all zeros (`all_zero`), and classifies by the GS1 prefix:
 *    a shop's own code, variable measure or a company's internal number (`restricted`), a coupon or
 *    a refund receipt (`coupon`), a magazine's issue (`serial`), a book or printed music (`book`), or
 *    a product's barcode (`global`). Indicator digits 1 to 8 are a case or pack of several (`case`).
 *
 * The prefix ranges are pinned in `vectors/gtin.json` (`prefixes`) from the GS1 General
 * Specifications, so a later edition that moves one changes the vectors and both sides at once.
 */

/** The field a value came from: a barcode column, a UPC one, an ISBN one, or none in particular. */
export type GtinHint = "barcode" | "upc" | "isbn" | "any";
export type GtinForm = "gtin8" | "gtin12" | "gtin13" | "gtin14";
/** A product's barcode (`global`), a book or printed music (`book`), or a magazine's issue (`serial`). */
export type GtinKind = "global" | "book" | "serial";
/** One unit, or a case or pack of several (indicator digits 1 to 8). */
export type GtinLevel = "unit" | "case";
/** What was put right on the way: a spreadsheet's lost leading 0, a UPC-E, an ISBN-10. */
export type GtinRepair = "leading_zero" | "upc_e" | "isbn10";
export type GtinProblem =
  | "empty"
  | "not_digits"
  | "spreadsheet_number"
  | "length"
  | "check_digit"
  | "all_zero"
  | "restricted"
  | "coupon";

export interface Gtin {
  /** Always 14 digits, left-padded with zeros: the one form two barcodes are compared in. */
  readonly gtin14: string;
  readonly form: GtinForm;
  readonly kind: GtinKind;
  readonly level: GtinLevel;
  readonly repaired?: GtinRepair;
}

export type GtinResult =
  | { readonly ok: Gtin }
  | {
      readonly problem: GtinProblem;
      /** For `check_digit`: the last digit the others add up to. */
      readonly expected?: number;
    };

/**
 * The GS1 prefixes, as classified here (`vectors/gtin.json` pins the same). Each is a prefix of the
 * 13 digits after the indicator digit; a GTIN-8 is classified on its own 8.
 */
export const GTIN_PREFIXES = {
  /** In-store, variable measure and company-internal numbers (GS1 General Specifications 1.4.2). */
  restricted: ["02", "04", "2"],
  /** Coupons and refund receipts. */
  coupon: ["05", "980", "981", "982", "983", "984", "99"],
  /** ISSN: a magazine or newspaper's issue. */
  serial: ["977"],
  /** ISBN and ISMN. */
  book: ["978", "979"],
  /** A GTIN-8 starting with these is a restricted circulation number (RCN-8). */
  restrictedGtin8: ["0", "2"],
  /** A GTIN-14 with this indicator digit is a variable-measure trade item. */
  restrictedIndicator: ["9"],
} as const;

/** GS1's check digit for the digits before it: weights 3 and 1 from the right, mod 10. */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * A UPC-E (8 digits: number system 0 or 1, six digits, the check digit) as the UPC-A it stands for,
 * by its sixth digit: 0 to 2, 3, 4, or 5 to 9. Null for anything that is not one.
 */
export function expandUpcE(eight: string): string | null {
  if (!/^[01]\d{7}$/.test(eight)) return null;
  const s = eight[0] as string;
  const [d1, d2, d3, d4, d5, d6] = eight.slice(1, 7).split("") as [string, string, string, string, string, string];
  const check = eight[7] as string;
  let middle: string;
  if (d6 === "0" || d6 === "1" || d6 === "2") middle = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === "3") middle = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === "4") middle = `${d1}${d2}${d3}${d4}00000${d5}`;
  else middle = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${s}${middle}${check}`;
}

/** The shortest form a 14-digit barcode is printed in: 8, 12, 13 or 14 digits. */
export function gtinDisplay(gtin14: string): string {
  if (gtin14.startsWith("000000")) return gtin14.slice(6);
  if (gtin14.startsWith("00")) return gtin14.slice(2);
  if (gtin14.startsWith("0")) return gtin14.slice(1);
  return gtin14;
}

/** ISBN-10's own check: digits weighted 10 down to 1, `X` as 10 in the last place, mod 11. */
function isbn10Holds(ten: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = ten[i] as string;
    const value = c === "X" || c === "x" ? 10 : c.charCodeAt(0) - 48;
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

const SPREADSHEET = /^\d+(?:[.,]\d+)?[eE]\+?\d+$/;
/** Spaces (any), hyphens and dashes, and full stops: what people and printers put between digits. */
const SEPARATORS = /[\s\-‐-―.]/g;

/** Reads one barcode as `vectors/gtin.json` says, or says what is wrong with it. */
export function normaliseGtin(raw: string, hint: GtinHint = "any"): GtinResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { problem: "empty" };
  if (SPREADSHEET.test(trimmed)) return { problem: "spreadsheet_number" };
  let s = trimmed.replace(SEPARATORS, "");
  if (s.startsWith("(01)")) s = s.slice(4);
  else if (s.length === 16 && s.startsWith("01")) s = s.slice(2);
  if (s === "") return { problem: "empty" };

  let repaired: GtinRepair | undefined;
  if (/^\d{9}[\dXx]$/.test(s) && isbn10Holds(s)) {
    const body = `978${s.slice(0, 9)}`;
    s = `${body}${gtinCheckDigit(body)}`;
    repaired = "isbn10";
  }
  if (!/^\d+$/.test(s)) return { problem: "not_digits" };

  let form: GtinForm;
  if (s.length === 8 && hint === "upc" && (s[0] === "0" || s[0] === "1")) {
    s = expandUpcE(s) as string;
    form = "gtin12";
    repaired = "upc_e";
  } else if (s.length === 8) form = "gtin8";
  else if (s.length === 11 && (hint === "barcode" || hint === "upc")) {
    s = `0${s}`;
    form = "gtin12";
    repaired = "leading_zero";
  } else if (s.length === 12) form = "gtin12";
  else if (s.length === 13) form = "gtin13";
  else if (s.length === 14) form = "gtin14";
  else return { problem: "length" };

  const expected = gtinCheckDigit(s.slice(0, -1));
  if (expected !== s.charCodeAt(s.length - 1) - 48) return { problem: "check_digit", expected };

  const gtin14 = s.padStart(14, "0");
  if (/^0+$/.test(gtin14)) return { problem: "all_zero" };

  const starts = (body: string, prefixes: readonly string[]) => prefixes.some((p) => body.startsWith(p));
  const done = (kind: GtinKind, level: GtinLevel): GtinResult => ({
    ok: { gtin14, form, kind, level, ...(repaired ? { repaired } : {}) },
  });

  // Eight significant digits: a GTIN-8, however many zeros it came with.
  if (gtin14.startsWith("000000")) {
    return starts(gtin14.slice(6), GTIN_PREFIXES.restrictedGtin8) ? { problem: "restricted" } : done("global", "unit");
  }
  const indicator = gtin14.slice(0, 1);
  const body = gtin14.slice(1);
  if (starts(indicator, GTIN_PREFIXES.restrictedIndicator) || starts(body, GTIN_PREFIXES.restricted)) {
    return { problem: "restricted" };
  }
  if (starts(body, GTIN_PREFIXES.coupon)) return { problem: "coupon" };
  const level: GtinLevel = indicator === "0" ? "unit" : "case";
  if (starts(body, GTIN_PREFIXES.serial)) return done("serial", level);
  if (starts(body, GTIN_PREFIXES.book)) return done("book", level);
  return done("global", level);
}

/** `vocab/placeholder-titles.json`'s names, lower case, apostrophes straight. */
export const PLACEHOLDER_TITLES: readonly string[] = placeholders.titles;
const PLACEHOLDERS: ReadonlySet<string> = new Set(PLACEHOLDER_TITLES);

/**
 * Whether a product's name is a template's sample (`vocab/placeholder-titles.json`): lower case,
 * trimmed, a curly apostrophe made straight. Such a product is never listed on networks.
 */
export function isPlaceholderTitle(name: string): boolean {
  return PLACEHOLDERS.has(name.trim().toLowerCase().replaceAll("’", "'"));
}
