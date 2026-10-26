import { countryOfZone, currencyOfCountry } from "./geo";

/**
 * Currencies as the owner picks one: the common ones first, each with its symbol and its name
 * (`€ EUR — Euro`), then every other one prices here can be in: every ISO 4217 currency whose minor
 * unit is known, each kept in that unit (ADR-032). The server takes the same list
 * (`packages/core/src/util/locale.ts`; a test holds the two together).
 */

/** The ones most businesses here use, in this order. */
export const COMMON_CURRENCIES: readonly string[] = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "CAD",
  "AUD",
  "BRL",
  "PLN",
  "SEK",
  "NOK",
  "DKK",
  "CZK",
  "MXN",
  "INR",
  "ZAR",
  "NZD",
  "SGD",
];

/**
 * Each currency's minor unit, as ISO 4217 gives it (0: none, like JPY; 2: hundredths; 3: thousandths,
 * like KWD): the server's own table (`ISO_4217_MINOR_UNITS` in `@surfingdog/spec`, ADR-032), which a
 * test holds this to. Every amount is kept in this unit, and shown and typed in it.
 */
export const MINOR_UNITS: Readonly<Record<string, number>> = {
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

/** Fund codes: an exponent, and nobody sets a price in one (the server refuses them too). */
export const FUND_CODES: ReadonlySet<string> = new Set(["BOV", "CHE", "CHW", "CLF", "COU", "MXV", "USN", "UYI", "UYW"]);

/** How many places a currency's amounts have: 2 for one this table does not know (shown, never stored). */
export function minorUnitsOf(code: string): number {
  return MINOR_UNITS[code.toUpperCase()] ?? 2;
}

export function knownCurrencies(): readonly string[] {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : COMMON_CURRENCIES;
  } catch {
    return COMMON_CURRENCIES;
  }
}

/** Whether prices here can be in `code`: an ISO 4217 currency whose minor unit is known, not a fund code. */
export function offeredCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && MINOR_UNITS[code] !== undefined && !FUND_CODES.has(code);
}

/** The narrow symbol a currency is written with (`€`, `$`, `£`), or the code when it has none of its own. */
export function currencySymbol(code: string, locale?: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    return part?.value ?? code;
  } catch {
    return code;
  }
}

/** Whether the symbol goes after the amount where this browser writes money (`12,00 €`), or before (`€12.00`). */
export function symbolAfter(code: string, locale?: string): boolean {
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(1);
    const at = parts.findIndex((p) => p.type === "currency");
    const num = parts.findIndex((p) => p.type === "integer");
    return at > num;
  } catch {
    return false;
  }
}

/** The currency's name in words (`Euro`), or "" when the browser cannot say. */
export function currencyName(code: string, locale = "en"): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "currency" }).of(code);
    return name && name !== code ? name : "";
  } catch {
    return "";
  }
}

/** `€ EUR — Euro`; a currency whose symbol is its code reads `CHF — Swiss Franc`. */
export function currencyLabel(code: string, locale?: string): string {
  const symbol = currencySymbol(code, locale);
  const name = currencyName(code);
  const head = symbol && symbol !== code ? `${symbol} ${code}` : code;
  return name ? `${head} — ${name}` : head;
}

export interface CurrencyGroups {
  readonly common: readonly string[];
  readonly all: readonly string[];
}

/**
 * The choice: the common currencies, then every other one this browser knows that prices can be in,
 * alphabetical by code. `keep` (the stored one) is always there, even one the server would now refuse,
 * so the field never shows blank.
 */
export function currencyGroups(keep?: string): CurrencyGroups {
  const common = [...COMMON_CURRENCIES];
  const all = new Set(
    [...knownCurrencies(), ...Object.keys(MINOR_UNITS)].filter((c) => offeredCurrency(c) && !common.includes(c)),
  );
  if (keep && !common.includes(keep)) all.add(keep);
  return { common, all: [...all].sort() };
}

/**
 * The line under the currency, when prices need a look: those kept in another currency, and that a
 * change converts nothing. Null when there is nothing to say.
 */
export function currencyNote(
  selected: string,
  saved: string,
  prices: readonly { readonly currency?: string | undefined }[],
): string | null {
  const other = new Map<string, number>();
  for (const p of prices) {
    if (p.currency && p.currency.toUpperCase() !== selected) {
      other.set(p.currency.toUpperCase(), (other.get(p.currency.toUpperCase()) ?? 0) + 1);
    }
  }
  if (other.size) {
    const words = [...other.entries()].map(([c, n]) => `${n} ${n === 1 ? "price is" : "prices are"} in ${c}`);
    return `${words.join(", ")}: changing the currency converts nothing.`;
  }
  if (selected !== saved && prices.length) return "Changing the currency converts nothing: each amount stays as it is.";
  return null;
}

/**
 * The currency to start from: the money of the country the business's time zone is in (Europe/Lisbon
 * → EUR, whatever language the browser speaks), else of this browser's own region (`pt-PT` → EUR,
 * `en-GB` → GBP), else EUR. Only one prices here can be in.
 */
export function guessCurrency(languages: readonly string[], zone?: string | null): string {
  const fromZone = currencyOfCountry(countryOfZone(zone));
  if (fromZone && offeredCurrency(fromZone)) return fromZone;
  for (const tag of languages) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      const money = currencyOfCountry(region);
      if (money && offeredCurrency(money)) return money;
    } catch {
      // Not a tag this browser reads: the next one.
    }
  }
  return "EUR";
}
