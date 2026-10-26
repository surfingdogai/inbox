import { decimalOf, minorUnits } from "@surfingdog/spec";

/**
 * An amount in minor units as a business writes it, in the currency's own exponent (ADR-032):
 * `KSh 4,500.00`, `¥4,500`, `KWD 4.500`, in the given locale's way. A currency whose exponent is not
 * known is written as its minor units and code, never guessed into a decimal.
 */
export function formatMinor(m: { readonly value: number; readonly currency: string }, locale: string): string {
  const e = minorUnits(m.currency);
  if (e === null) return `${m.value} ${m.currency}`;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: m.currency,
      minimumFractionDigits: e,
      maximumFractionDigits: e,
    }).format(m.value / 10 ** e);
  } catch {
    return `${decimalOf(m.value, m.currency) ?? m.value} ${m.currency}`;
  }
}

/**
 * An amount in minor units as a business writes it to a person: `€100.00`, `¥4,500`, `KWD 4.500`,
 * `HUF 2,500.50`. Always in the exponent's places, never a locale's display digits, which drop the
 * forint's fillér and the rupiah's sen: a price the inbox holds is written as it holds it.
 */
export function moneyText(m: { readonly value: number; readonly currency: string }): string {
  return formatMinor(m, "en-GB");
}

/**
 * A service's price as the business states it: `€45.00`, `€20.00 per person`, `from €45.00`,
 * `priced by quote`. Null when it has none. A price without a currency is in `currency`, the
 * business's.
 */
export function servicePriceText(
  price:
    | {
        readonly model: string;
        readonly value?: number | undefined;
        readonly currency?: string | undefined;
        readonly per?: string | undefined;
      }
    | null
    | undefined,
  currency: string,
): string | null {
  if (!price) return null;
  if (price.model === "quote" || typeof price.value !== "number") return "priced by quote";
  const money = moneyText({ value: price.value, currency: price.currency ?? currency });
  const each = price.per === "person" ? `${money} per person` : money;
  return price.model === "from" ? `from ${each}` : each;
}
