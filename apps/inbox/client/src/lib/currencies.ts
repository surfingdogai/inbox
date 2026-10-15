import { countryOfZone, currencyOfCountry } from "./geo";

/**
 * Currencies as the owner picks one: the common ones first, each with its symbol and its name
 * (`€ EUR — Euro`), then every other one prices here can be in. Every amount in this inbox is kept in
 * hundredths, so a currency counted otherwise is not offered: the server refuses the same list
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

/** Not counted in hundredths (none, thousandths, ten-thousandths), or not money a business prices in. */
export const NOT_HUNDREDTHS: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
  "CLF",
  "UYW",
  "XAG",
  "XAU",
  "XBA",
  "XBB",
  "XBC",
  "XBD",
  "XDR",
  "XPD",
  "XPT",
  "XSU",
  "XTS",
  "XUA",
  "XXX",
]);

export function knownCurrencies(): readonly string[] {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : COMMON_CURRENCIES;
  } catch {
    return COMMON_CURRENCIES;
  }
}

/** Whether prices here can be in `code`. */
export function offeredCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && !NOT_HUNDREDTHS.has(code);
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
  const all = new Set(knownCurrencies().filter((c) => offeredCurrency(c) && !common.includes(c)));
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
