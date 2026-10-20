import type { Db } from "../db";
import { SHOP_CHARGES_SKU } from "./catalogue";
import type { PayAmount, PostalAddress, ShopOrder, ShopOrderLine } from "./sdk";

/**
 * An order as the business's own shop needs it (ADR-026 §2): its lines at the prices the customer
 * accepted, the shop's own id for each product it sent in, and only the customer details fulfilling
 * needs. The shop is the business's own, the same controller: these go nowhere else.
 *
 * A line the inbox marked as the shop's own charges (`SHOP_CHARGES_SKU`: the tax or delivery the shop
 * adds, which the customer accepted with the shop's total) is not a line to write: the shop adds it
 * itself, so it is given as `charges` and counted in `total`.
 */
export async function shopOrderOf(
  db: Db,
  itemId: string,
  opts: { readonly source: string; readonly languages: readonly string[] },
): Promise<ShopOrder | null> {
  const { rows } = await db.client.query({
    sql: `SELECT i.payload, p.display_name, p.contact, p.locale, p.erased_at
            FROM items i LEFT JOIN parties p ON p.id = i.party_id
           WHERE i.id = ? AND i.type = 'order'`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  const payload = (parse(r[0]) ?? {}) as {
    orderedItem?: unknown;
    totalPrice?: { value?: unknown; currency?: unknown };
    delivery?: { method?: unknown; when?: unknown };
    shippingAddress?: unknown;
    billingAddress?: unknown;
    notes?: unknown;
  };
  const currency = String(payload.totalPrice?.currency ?? "").toUpperCase();
  const totalValue = Number(payload.totalPrice?.value ?? Number.NaN);
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isInteger(totalValue) || totalValue < 0) return null;
  const raw = Array.isArray(payload.orderedItem) ? (payload.orderedItem as Record<string, unknown>[]) : [];
  // The shop's own id for each product it sent in: only a product whose source is this shop.
  const ids = [...new Set(raw.map((l) => l.productId).filter((v): v is string => typeof v === "string" && v !== ""))];
  const external = new Map<string, string>();
  if (ids.length > 0) {
    const found = await db.client.query({
      sql: `SELECT id, external_id FROM products WHERE source = ? AND id IN (${ids.map(() => "?").join(", ")})`,
      params: [opts.source, ...ids],
      method: "all",
    });
    for (const row of found.rows)
      if (row[1] !== null && row[1] !== undefined) external.set(String(row[0]), String(row[1]));
  }
  const lines: ShopOrderLine[] = [];
  let charges = 0;
  for (const l of raw) {
    const quantity = Number(l.quantity);
    const price = l.price as { value?: unknown; currency?: unknown } | undefined;
    const unit = Number(price?.value);
    if (!Number.isInteger(quantity) || quantity < 1 || !Number.isInteger(unit) || unit < 0) continue;
    const sku = typeof l.sku === "string" && l.sku ? l.sku : null;
    const productId = typeof l.productId === "string" && l.productId ? l.productId : null;
    if (sku === SHOP_CHARGES_SKU && productId === null) {
      charges += unit * quantity;
      continue;
    }
    lines.push({
      externalId: productId ? (external.get(productId) ?? null) : null,
      sku,
      name: typeof l.name === "string" ? l.name.slice(0, 200) : "",
      quantity,
      unit: { value: unit, currency: String(price?.currency ?? currency).toUpperCase() },
    });
  }
  const erased = r[4] !== null && r[4] !== undefined;
  const contact = (parse(r[2]) ?? {}) as { name?: unknown; email?: unknown; phone?: unknown; locale?: unknown };
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const method = payload.delivery?.method;
  const total: PayAmount = { value: totalValue, currency };
  return {
    lines,
    charges: charges > 0 ? { value: charges, currency } : null,
    total,
    delivery: method === "pickup" || method === "delivery" || method === "digital" ? method : null,
    when: text(payload.delivery?.when, 40),
    // An erased customer is nobody now: the shop is told nothing about them.
    customer: {
      name: erased ? null : (text(contact.name, 200) ?? text(r[1], 200)),
      email: erased ? null : text(contact.email, 254),
      phone: erased ? null : text(contact.phone, 40),
      language: text(contact.locale, 12) ?? text(r[3], 12) ?? opts.languages[0] ?? "en",
    },
    shipping: erased ? null : address(payload.shippingAddress),
    billing: erased ? null : address(payload.billingAddress),
    note: erased ? null : text(payload.notes, 2_000),
  };
}

function address(raw: unknown): PostalAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"] as const) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim().slice(0, 200);
  }
  return Object.keys(out).length > 0 ? (out as PostalAddress) : null;
}

function parse(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
