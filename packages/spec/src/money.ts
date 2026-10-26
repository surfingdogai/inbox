/**
 * Money in every currency's own minor unit (spec 0.11, ADR-036).
 *
 * Every amount in these formats is an integer count of the currency's minor unit as ISO 4217 defines
 * it: 4500 is 45.00 in AUD or KES, 4500 is ¥4,500 in JPY (no minor unit), and 4500 is 4.500 in KWD
 * (thousandths). The exponent is the currency's, never a guess: a reader that does not know a
 * currency's exponent does not show or charge its amounts.
 *
 * The table is ISO 4217 list one (active codes) with the "minor unit" column, as published by the
 * ISO 4217 maintenance agency (SIX). A few codes withdrawn recently are kept, with the exponent they
 * had, so a price already held in one still reads: BGN, HRK, ANG, CUC, SLL, ZWL. Fund codes (BOV, CHE,
 * CHW, CLF, COU, MXV, USN, UYI, UYW) have an exponent and are marked as funds: nobody sets a price in
 * one. Metals, special drawing rights, testing and "no currency" (XAU, XAG, XPD, XPT, XBA–XBD, XDR, XSU,
 * XUA, XTS, XXX) have none and are not here.
 */

/** ISO 4217 code → its minor unit's exponent (0: none, 2: hundredths, 3: thousandths, 4: ten-thousandths). */
export const ISO_4217_MINOR_UNITS: Readonly<Record<string, number>> = {
  AED: 2,
  AFN: 2,
  ALL: 2,
  AMD: 2,
  ANG: 2,
  AOA: 2,
  ARS: 2,
  AUD: 2,
  AWG: 2,
  AZN: 2,
  BAM: 2,
  BBD: 2,
  BDT: 2,
  BGN: 2,
  BHD: 3,
  BIF: 0,
  BMD: 2,
  BND: 2,
  BOB: 2,
  BOV: 2,
  BRL: 2,
  BSD: 2,
  BTN: 2,
  BWP: 2,
  BYN: 2,
  BZD: 2,
  CAD: 2,
  CDF: 2,
  CHE: 2,
  CHF: 2,
  CHW: 2,
  CLF: 4,
  CLP: 0,
  CNY: 2,
  COP: 2,
  COU: 2,
  CRC: 2,
  CUC: 2,
  CUP: 2,
  CVE: 2,
  CZK: 2,
  DJF: 0,
  DKK: 2,
  DOP: 2,
  DZD: 2,
  EGP: 2,
  ERN: 2,
  ETB: 2,
  EUR: 2,
  FJD: 2,
  FKP: 2,
  GBP: 2,
  GEL: 2,
  GHS: 2,
  GIP: 2,
  GMD: 2,
  GNF: 0,
  GTQ: 2,
  GYD: 2,
  HKD: 2,
  HNL: 2,
  HRK: 2,
  HTG: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  IQD: 3,
  IRR: 2,
  ISK: 0,
  JMD: 2,
  JOD: 3,
  JPY: 0,
  KES: 2,
  KGS: 2,
  KHR: 2,
  KMF: 0,
  KPW: 2,
  KRW: 0,
  KWD: 3,
  KYD: 2,
  KZT: 2,
  LAK: 2,
  LBP: 2,
  LKR: 2,
  LRD: 2,
  LSL: 2,
  LYD: 3,
  MAD: 2,
  MDL: 2,
  MGA: 2,
  MKD: 2,
  MMK: 2,
  MNT: 2,
  MOP: 2,
  MRU: 2,
  MUR: 2,
  MVR: 2,
  MWK: 2,
  MXN: 2,
  MXV: 2,
  MYR: 2,
  MZN: 2,
  NAD: 2,
  NGN: 2,
  NIO: 2,
  NOK: 2,
  NPR: 2,
  NZD: 2,
  OMR: 3,
  PAB: 2,
  PEN: 2,
  PGK: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  PYG: 0,
  QAR: 2,
  RON: 2,
  RSD: 2,
  RUB: 2,
  RWF: 0,
  SAR: 2,
  SBD: 2,
  SCR: 2,
  SDG: 2,
  SEK: 2,
  SGD: 2,
  SHP: 2,
  SLE: 2,
  SLL: 2,
  SOS: 2,
  SRD: 2,
  SSP: 2,
  STN: 2,
  SVC: 2,
  SYP: 2,
  SZL: 2,
  THB: 2,
  TJS: 2,
  TMT: 2,
  TND: 3,
  TOP: 2,
  TRY: 2,
  TTD: 2,
  TWD: 2,
  TZS: 2,
  UAH: 2,
  UGX: 0,
  USD: 2,
  USN: 2,
  UYI: 0,
  UYU: 2,
  UYW: 4,
  UZS: 2,
  VED: 2,
  VES: 2,
  VND: 0,
  VUV: 0,
  WST: 2,
  XAF: 0,
  XCD: 2,
  XCG: 2,
  XOF: 0,
  XPF: 0,
  YER: 2,
  ZAR: 2,
  ZMW: 2,
  ZWG: 2,
  ZWL: 2,
};

/** Fund codes: an exponent, and nobody sets a price in one. */
export const ISO_4217_FUNDS: ReadonlySet<string> = new Set([
  "BOV",
  "CHE",
  "CHW",
  "CLF",
  "COU",
  "MXV",
  "USN",
  "UYI",
  "UYW",
]);

/** The exponent of `code`'s minor unit (JPY 0, EUR 2, KWD 3), or null for a code this table does not know. */
export function minorUnits(code: string): number | null {
  const e = ISO_4217_MINOR_UNITS[code.toUpperCase()];
  return e === undefined ? null : e;
}

/** Why a price cannot be in `code`, or null when it can: a known ISO 4217 currency that is not a fund code. */
export function currencyCodeProblem(code: string): string | null {
  if (!/^[A-Z]{3}$/.test(code)) return "a three-letter ISO 4217 code in capitals, like KES or JPY";
  if (minorUnits(code) === null) return `${code} is not an ISO 4217 currency`;
  if (ISO_4217_FUNDS.has(code)) return `${code} is a fund code, not a currency prices are set in`;
  return null;
}

/**
 * An amount in minor units as a plain decimal string in the currency's own exponent, with a dot:
 * 4500 EUR is "45.00", 4500 JPY is "4500", 4500 KWD is "4.500". Null for a currency it does not know.
 */
export function decimalOf(value: number, currency: string): string | null {
  const e = minorUnits(currency);
  if (e === null || !Number.isSafeInteger(value)) return null;
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(value));
  if (e === 0) return `${sign}${digits}`;
  const padded = digits.padStart(e + 1, "0");
  return `${sign}${padded.slice(0, -e)}.${padded.slice(-e)}`;
}

/**
 * A decimal string back to minor units in the currency's own exponent ("45.5" EUR → 4550, "4500"
 * JPY → 4500, "4.5" KWD → 4500). Null when it is not a plain decimal, or names a part smaller than
 * the minor unit that is not zero ("12.345" EUR), or the currency is not known.
 */
export function parseDecimal(text: string, currency: string): number | null {
  const e = minorUnits(currency);
  if (e === null) return null;
  const m = /^(-)?(\d{1,15})(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!m) return null;
  const fraction = m[3] ?? "";
  if (/[1-9]/.test(fraction.slice(e))) return null;
  const whole = Number(m[2]) * 10 ** e;
  const part = e === 0 ? 0 : Number(fraction.padEnd(e, "0").slice(0, e));
  const value = whole + part;
  if (!Number.isSafeInteger(value)) return null;
  return m[1] ? -value : value;
}

/**
 * A share of an amount in minor units, rounded half away from zero to the minor unit: `basisPoints`
 * of 10 000 (1000 is 10%). Integer arithmetic, so no float drift for any amount below 9e11.
 */
export function shareOf(value: number, basisPoints: number): number {
  const product = Math.abs(value) * basisPoints;
  const rounded = Math.floor((product + 5_000) / 10_000);
  return value < 0 ? -rounded : rounded;
}
