/**
 * Postal codes, country by country (ADR-034 §3): what a whole code looks like once it is normalised
 * (capitals, no spaces or dashes), what a prefix the owner may cover looks like, and how a code is
 * matched against one. Built from each country's published format; a country not here takes no postal
 * prefixes (a radius, or anywhere, works everywhere). Nothing is geocoded: a code is matched as text.
 */

export interface PostalRule {
  /** A whole code, normalised. */
  readonly code: RegExp;
  /** A prefix the owner may name, normalised. */
  readonly prefix: RegExp;
  /** How the owner writes one, for the chooser's placeholder: "0010", "SW1", "6000". */
  readonly example: string;
  /** A whole code the example covers, as it is written: "SW1A 1AA" under SW1, "04103" under 04. */
  readonly covers: string;
}

/** A numeric system of `n` digits: codes of exactly `n`, prefixes of 1 to `n`. */
const digits = (n: number, example: string): PostalRule => ({
  code: new RegExp(`^[0-9]{${n}}$`),
  prefix: new RegExp(`^[0-9]{1,${n}}$`),
  example,
  covers: `${example}${"1030000".slice(0, Math.max(0, n - example.length))}`,
});

/**
 * The countries whose codes are matched here. Numeric systems by their length; the few with letters
 * by their own shape (GB and its outward codes, CA's forward sortation areas, NL's four digits and two
 * letters, IE's routing keys, AR's CPA).
 */
export const POSTAL_RULES: Readonly<Record<string, PostalRule>> = {
  AR: {
    code: /^([A-Z][0-9]{4}[A-Z]{3}|[0-9]{4})$/,
    prefix: /^([A-Z][0-9]{0,4}|[0-9]{1,4})$/,
    example: "C1425",
    covers: "C1425DKB",
  },
  AT: digits(4, "1010"),
  AU: digits(4, "6000"),
  BE: digits(4, "1000"),
  BR: digits(8, "01310"),
  CA: {
    code: /^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$/,
    prefix: /^[A-Z]([0-9]([A-Z]([0-9]([A-Z][0-9]?)?)?)?)?$/,
    example: "M5V",
    covers: "M5V 3L9",
  },
  CH: digits(4, "8001"),
  CL: digits(7, "75"),
  CN: digits(6, "100"),
  CO: digits(6, "110"),
  CZ: digits(5, "110"),
  DE: digits(5, "04"),
  DK: digits(4, "2100"),
  EG: digits(5, "11"),
  ES: digits(5, "28"),
  FI: digits(5, "00100"),
  FR: digits(5, "75"),
  GB: {
    code: /^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$/,
    prefix: /^[A-Z]{1,2}([0-9][0-9A-Z]?([0-9]([A-Z]{1,2})?)?)?$/,
    example: "SW1",
    covers: "SW1A 1AA",
  },
  GR: digits(5, "54"),
  HU: digits(4, "1051"),
  ID: digits(5, "10"),
  IE: {
    code: /^[A-Z][0-9][0-9W][0-9A-Z]{4}$/,
    prefix: /^[A-Z]([0-9]([0-9W])?)?$/,
    example: "D02",
    covers: "D02 X285",
  },
  IL: digits(7, "61"),
  IN: digits(6, "560"),
  IT: digits(5, "20"),
  JP: digits(7, "060"),
  KE: digits(5, "00100"),
  KR: digits(5, "06"),
  MA: digits(5, "20"),
  MX: digits(5, "06"),
  MY: digits(5, "50"),
  NG: digits(6, "100"),
  NL: {
    code: /^[0-9]{4}[A-Z]{2}$/,
    prefix: /^([0-9]{1,4}|[0-9]{4}[A-Z]{1,2})$/,
    example: "1012",
    covers: "1012 AB",
  },
  NO: digits(4, "0150"),
  NZ: digits(4, "6011"),
  PE: digits(5, "15"),
  PH: digits(4, "1000"),
  PL: digits(5, "00"),
  PT: digits(7, "4000"),
  RO: digits(6, "01"),
  SE: digits(5, "111"),
  SG: digits(6, "01"),
  TH: digits(5, "10"),
  TR: digits(5, "34"),
  US: { code: /^[0-9]{5}([0-9]{4})?$/, prefix: /^[0-9]{1,5}$/, example: "941", covers: "94110" },
  VN: digits(6, "70"),
  ZA: digits(4, "8001"),
};

/** A postal code or prefix as it is matched: capitals, no spaces, dashes or dots. */
export function normalisePostal(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s.\-–—]/g, "")
    .trim();
}

/** How each country's codes are written, for the owner's chooser: its example start and a code under it. */
export function postalShapes(): Record<string, { example: string; covers: string }> {
  return Object.fromEntries(
    Object.entries(POSTAL_RULES).map(([country, r]) => [country, { example: r.example, covers: r.covers }]),
  );
}

/** The countries that take postal prefixes, for the owner's chooser. */
export const POSTAL_COUNTRIES: readonly string[] = Object.keys(POSTAL_RULES).sort();

/** Why a prefix cannot be covered in a country, or null when it can. */
export function postalPrefixProblem(country: string, prefix: string): string | null {
  const rule = POSTAL_RULES[country.toUpperCase()];
  if (!rule) return `Postal codes in ${country.toUpperCase()} are not matched here: use a radius instead.`;
  const p = normalisePostal(prefix);
  if (!p) return "Write the start of a postal code.";
  if (!rule.prefix.test(p))
    return `That is not the start of a postal code in ${country.toUpperCase()}, like ${rule.example}.`;
  return null;
}

/** Whether a whole code is one of the country's, once normalised; null when the country is not here. */
export function isPostalCode(country: string, code: string): boolean | null {
  const rule = POSTAL_RULES[country.toUpperCase()];
  if (!rule) return null;
  return rule.code.test(normalisePostal(code));
}

/**
 * Whether a whole code falls under a prefix. Most systems read left to right, so a prefix is the start
 * of the code; a British code is matched by its outward code, so that M1 covers M1 1AE and not M12 3AB,
 * and the letters alone (M, SW) cover their area and no other (S is not SW).
 */
export function postalMatches(country: string, code: string, prefix: string): boolean {
  const c = normalisePostal(code);
  const p = normalisePostal(prefix);
  if (!p) return false;
  if (country.toUpperCase() !== "GB") return c.startsWith(p);
  if (c.length < 5) return false;
  const outward = c.slice(0, -3);
  if (/^[A-Z]{1,2}$/.test(p)) return /^[A-Z]+/.exec(outward)?.[0] === p;
  if (p.length <= outward.length) return outward === p;
  return c.startsWith(p) && p.startsWith(outward);
}
