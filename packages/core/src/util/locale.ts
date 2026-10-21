/**
 * Currencies and languages as the business names them: checked here once, for every door that takes
 * one (the profile, a service's price, a product's price), so the owner app's choosers and an owner's
 * AI are held to the same answer.
 */

import { currencyCodeProblem, minorUnits } from "@surfingdog/spec";

/**
 * Every amount in this inbox is an integer count of its currency's own ISO 4217 minor unit
 * (ADR-032): 4500 is 45.00 KES, ¥4,500 JPY, 4.500 KWD. The exponent comes from one table
 * (`minorUnits` in `@surfingdog/spec`), which the owner app's money formatting, the feeds' prices and
 * every pay-link platform's conversion read, so a currency is never counted a hundred times wrong.
 */

/**
 * Whether `code` is a currency a price here can be in: three capital letters, an ISO 4217 currency
 * whose exponent is known, not a fund code.
 */
export function isMoneyCurrency(code: string): boolean {
  return currencyCodeProblem(code) === null;
}

/**
 * Whether `code` is a currency counted in hundredths. Kept for the few places that still need to
 * know (a platform that writes amounts as hundredths); everything else asks `minorUnits`.
 */
export function isHundredthsCurrency(code: string): boolean {
  return isMoneyCurrency(code) && minorUnits(code) === 2;
}

/** Why a currency is refused, for the field that named it. */
export function currencyProblem(code: string): string | null {
  return currencyCodeProblem(code);
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
