/**
 * An amount in minor units as a business writes it to a person: `€100.00`, `£9.50`, `HUF 2,500.50`.
 * Always two places, as every amount here is kept: a locale's own display digits drop the forint's
 * fillér and the rupiah's sen, and a price the inbox holds is written as it holds it.
 */
export function moneyText(m: { readonly value: number; readonly currency: string }): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: m.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(m.value / 100);
  } catch {
    return `${(m.value / 100).toFixed(2)} ${m.currency}`;
  }
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
