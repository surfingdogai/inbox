/** An amount in minor units as a business writes it to a person: `€100.00`, `£9.50`. */
export function moneyText(m: { readonly value: number; readonly currency: string }): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: m.currency }).format(m.value / 100);
  } catch {
    return `${(m.value / 100).toFixed(2)} ${m.currency}`;
  }
}
