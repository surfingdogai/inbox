/**
 * Currencies and languages as the business names them: checked here once, for every door that takes
 * one (the profile, a service's price, a product's price), so the owner app's choosers and an owner's
 * AI are held to the same answer.
 */

/**
 * ISO 4217 currencies whose minor unit is not a hundredth: none (JPY, KRW, ISK, …), a thousandth
 * (BHD, KWD, JOD, …) or a ten-thousandth (CLF, UYW), and the funds and metals with no minor unit at
 * all. Every amount in this inbox is kept in hundredths (`moneyText`, the owner app's `formatMoney`):
 * a price in one of these would be shown a hundred or ten times wrong, so none is taken until money
 * knows other exponents.
 */
const NOT_HUNDREDTHS: ReadonlySet<string> = new Set([
  // No minor unit.
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
  // Thousandths.
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
  // Ten-thousandths.
  "CLF",
  "UYW",
  // Funds, metals, testing and "no currency": not money a business prices in.
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

/** The currencies this runtime knows, when it can say; null when it cannot (then any three letters do). */
function knownCurrencies(): ReadonlySet<string> | null {
  try {
    return typeof Intl.supportedValuesOf === "function" ? new Set(Intl.supportedValuesOf("currency")) : null;
  } catch {
    return null;
  }
}
const KNOWN = knownCurrencies();

/**
 * Whether `code` is a currency a price here can be in: three capital letters, an ISO 4217 code the
 * runtime knows (when it can say), counted in hundredths.
 */
export function isHundredthsCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code) || NOT_HUNDREDTHS.has(code)) return false;
  return KNOWN === null || KNOWN.has(code);
}

/**
 * ISO 4217 currencies with no minor unit at all (yen, won, dong, Chilean pesos…). Kept in hundredths
 * here like every other amount (¥1,500 is 150000), which is exact, and written out as a decimal a
 * shop takes in its own currency ("1500.00"). Only a shop that takes such a decimal makes links in
 * them (ADR-027); a payment platform that counts in minor units does not.
 */
const NO_MINOR_UNIT: ReadonlySet<string> = new Set([
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
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/** Whether `code` is a currency with no minor unit (JPY, KRW, VND…), which a shop prices in whole units. */
export function isWholeUnitCurrency(code: string): boolean {
  if (!NO_MINOR_UNIT.has(code)) return false;
  return KNOWN === null || KNOWN.has(code);
}

/** Why a currency is refused, for the field that named it. */
export function currencyProblem(code: string): string | null {
  if (!/^[A-Z]{3}$/.test(code)) return "a three-letter ISO 4217 code, like EUR";
  if (NOT_HUNDREDTHS.has(code)) return `${code} is not counted in hundredths, which prices here are; pick another`;
  if (KNOWN !== null && !KNOWN.has(code)) return `${code} is not an ISO 4217 currency`;
  return null;
}

/**
 * Language tags as a business lists them: each one canonical BCP 47 (`PT-br` is `pt-BR`), once, in
 * the order given; null when one is not a language tag at all.
 */
export function canonicalLanguages(tags: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const raw of tags) {
    let tag: string | undefined;
    try {
      tag = Intl.getCanonicalLocales(raw.trim())[0];
    } catch {
      return null;
    }
    // A language, maybe with a script and a region: never a private-use or grandfathered oddity.
    if (!tag || !/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/.test(tag)) return null;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}
