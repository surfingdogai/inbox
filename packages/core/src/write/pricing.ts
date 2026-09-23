import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import type { Item, ItemType, Money, PayloadOf } from "../domain/types";
import { business, products, services } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { type FieldProblem, WriteError } from "./errors";

/** A customer's create, priced: the payload to store, and whether any of its price is not the business's. */
export interface Priced {
  readonly payload: Record<string, unknown>;
  /**
   * The request holds a price the business did not set — a line naming no product it has, a service
   * priced `from` or by `quote` with a price in it, a fixed-price service booked for longer than the
   * business sells it — so a person prices it first and no rule confirms or accepts it (ADR-018 §3.2).
   */
  readonly unpriced: boolean;
}

/**
 * The business sets its prices (ADR-018 §3.1, §3.2). A customer's booking of a fixed-price service, and
 * every order line that names a product in the catalogue (`productId`, else `sku`), is priced from
 * the business's own catalogue, and an order's total is its lines' prices times their quantities.
 * A different figure the request carried is kept beside the price as `customerStatedPrice`, for the
 * owner to read: it is never the item's price, and rules never see it (`withoutStatedPrices`). What
 * the catalogue prices, it also names: the service's and the product's own name (and sku) replace
 * the request's, so a cheap id under a dear name is the cheap thing, on every screen and receipt.
 *
 * What the catalogue does not price stays as the customer wrote it, for a person to price: a line
 * naming no product the business has, a service priced `from` or by `quote`, a quote request. Such
 * a create is `unpriced`, and no rule confirms or accepts it (`assertBusinessPriced`).
 */
export async function priceFromCatalogue(db: Db, type: ItemType, payload: Record<string, unknown>): Promise<Priced> {
  if (type === "booking") return priceBooking(db, payload as PayloadOf<"booking">);
  if (type === "order") return priceOrder(db, payload as PayloadOf<"order">);
  return { payload, unpriced: false };
}

async function priceBooking(db: Db, payload: PayloadOf<"booking">): Promise<Priced> {
  const { customerStatedPrice: _sent, ...asked } = payload;
  const [service] = await db.orm
    .select({ name: services.name, durationMin: services.durationMin, price: services.price })
    .from(services)
    .where(eq(services.id, asked.reservationFor.serviceId));
  if (!service) return { payload: asked, unpriced: asked.totalPrice !== undefined };
  const named = { ...asked, reservationFor: { ...asked.reservationFor, name: clip(service.name, 200) } };
  const price = service.price;
  if (price?.model !== "fixed" || typeof price.value !== "number") {
    return { payload: named, unpriced: named.totalPrice !== undefined };
  }
  const ours: Money = {
    value: price.value,
    currency: (price.currency ?? (await businessCurrency(db))).toUpperCase(),
  };
  const stated = asked.totalPrice;
  // The list price is for the service as long as the business sells it: longer is a person's to price.
  const longer = Date.parse(asked.endTime) - Date.parse(asked.startTime) > service.durationMin * 60_000;
  return {
    payload: {
      ...named,
      totalPrice: ours,
      ...(stated && !sameMoney(stated, ours) ? { customerStatedPrice: stated } : {}),
    },
    unpriced: longer,
  };
}

async function priceOrder(db: Db, payload: PayloadOf<"order">): Promise<Priced> {
  const { customerStatedPrice: _sent, ...asked } = payload;
  const lines = asked.orderedItem.map(({ customerStatedPrice: _line, ...line }) => line);
  const catalogue = await productsFor(db, lines);
  /** The currency of the business's prices here: its first catalogue line's. */
  let currency: string | undefined;
  let unpriced = false;
  const clash: FieldProblem[] = [];
  const orderedItem: PayloadOf<"order">["orderedItem"] = [];
  lines.forEach((line, i) => {
    const byId = line.productId !== undefined ? catalogue.byId.get(line.productId) : undefined;
    const bySku = line.sku !== undefined ? catalogue.bySku.get(line.sku) : undefined;
    if (byId && bySku && byId.id !== bySku.id) {
      clash.push({
        path: `payload.orderedItem.${i}.sku`,
        problem: "invalid",
        message: "names another product than productId",
      });
    }
    const product = byId ?? bySku;
    if (!product) {
      unpriced = true;
      orderedItem.push(line);
      return;
    }
    const ours: Money = { value: product.price.value, currency: product.price.currency.toUpperCase() };
    currency ??= ours.currency;
    const { sku: _sku, ...rest } = line;
    const sku = product.sku !== null && product.sku.length <= 100 ? { sku: product.sku } : {};
    const named = { ...rest, productId: product.id, ...sku, name: clip(product.name, 200) };
    orderedItem.push(sameMoney(line.price, ours) ? named : { ...named, price: ours, customerStatedPrice: line.price });
  });
  if (clash.length) {
    throw new WriteError("invalid_input", "A line names two different products: send its productId or its sku.", {
      fields: clash,
    });
  }
  // Nothing here is the catalogue's: every line is for a person to price, as the customer wrote it.
  if (currency === undefined) return { payload: { ...asked, orderedItem }, unpriced };

  const problems: FieldProblem[] = [];
  let total = 0;
  orderedItem.forEach((l, i) => {
    if (l.price.currency !== currency) {
      problems.push({
        path: `payload.orderedItem.${i}.price.currency`,
        problem: "invalid",
        message: `must be ${currency}, the currency of our prices`,
      });
      return;
    }
    total += l.price.value * l.quantity;
    // A total no one can write down exactly is no price: it would be stored and never read again.
    if (!Number.isSafeInteger(total) && !problems.some((p) => p.path.endsWith(".quantity"))) {
      problems.push({ path: `payload.orderedItem.${i}.quantity`, problem: "invalid", message: "too large" });
    }
  });
  if (problems.some((p) => p.path.endsWith(".currency"))) {
    throw new WriteError("invalid_input", `Every line of an order is in one currency: ${currency}.`, {
      fields: problems.filter((p) => p.path.endsWith(".currency")),
    });
  }
  if (problems.length) {
    throw new WriteError("invalid_input", "The order's total is too large: order fewer.", { fields: problems });
  }
  const ours: Money = { value: total, currency };
  const stated = asked.totalPrice;
  return {
    payload: {
      ...asked,
      orderedItem,
      totalPrice: ours,
      ...(sameMoney(stated, ours) ? {} : { customerStatedPrice: stated }),
    },
    unpriced,
  };
}

/**
 * No rule confirms a booking or accepts an order whose create held a price the business did not set
 * (ADR-018 §3.2): a person prices it first, or the €1 order is back under another name. Only a
 * rule is held here; the owner and their tools are the business, and answer to ADR-018 §4.
 */
export async function assertBusinessPriced(db: Db, item: Item, event: string): Promise<void> {
  if (!(await heldForPrice(db, item, event))) return;
  throw new WriteError("guard_failed", "a person prices this first: the request holds a price that is not ours", {
    details: { guard: "business_priced" },
  });
}

/** Whether a rule's `event` would make a promise on a price the business did not set (above). */
export async function heldForPrice(db: Db, item: Pick<Item, "id" | "type">, event: string): Promise<boolean> {
  const promise = (item.type === "booking" && event === "confirm") || (item.type === "order" && event === "accept");
  if (!promise) return false;
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM item_events WHERE item_id = ? AND seq = 1 AND json_extract(meta, '$.unpriced') = 1 LIMIT 1",
    params: [item.id],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * The item as a rule reads it: the price the customer's request stated is not there, so no rule
 * can confirm, accept or answer on it — only on the business's price, which is `totalPrice`.
 */
export function withoutStatedPrices(item: Item): Item {
  if (item.type === "booking") {
    const { customerStatedPrice: _stated, ...payload } = item.payload;
    return { ...item, payload };
  }
  if (item.type === "order") {
    const { customerStatedPrice: _stated, orderedItem, ...payload } = item.payload;
    return { ...item, payload: { ...payload, orderedItem: orderedItem.map(({ customerStatedPrice: _s, ...l }) => l) } };
  }
  return item;
}

const sameMoney = (a: Money, b: Money) => a.value === b.value && a.currency.toUpperCase() === b.currency.toUpperCase();

/** A catalogue name as an item holds it: the payload schemas cap a name's length, a feed does not. */
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** At most this many values in one `IN (…)`: D1 binds at most 100 parameters to a statement. */
const CHUNK = 90;

interface CatalogueProduct {
  readonly id: string;
  readonly sku: string | null;
  readonly name: string;
  readonly price: Money;
}

async function productsFor(db: Db, lines: readonly { productId?: string | undefined; sku?: string | undefined }[]) {
  const ids = [...new Set(lines.flatMap((l) => (l.productId !== undefined ? [l.productId] : [])))];
  const skus = [...new Set(lines.flatMap((l) => (l.sku !== undefined ? [l.sku] : [])))];
  const byId = new Map<string, CatalogueProduct>();
  const bySku = new Map<string, CatalogueProduct>();
  const columns = { id: products.id, sku: products.sku, name: products.name, price: products.price };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db.orm
      .select(columns)
      .from(products)
      .where(inArray(products.id, ids.slice(i, i + CHUNK)));
    for (const r of rows) byId.set(r.id, r);
  }
  for (let i = 0; i < skus.length; i += CHUNK) {
    const rows = await db.orm
      .select(columns)
      .from(products)
      .where(inArray(products.sku, skus.slice(i, i + CHUNK)));
    for (const r of rows) if (r.sku !== null) bySku.set(r.sku, r);
  }
  return { byId, bySku };
}

/** The currency a price without one is in: the business's, as its profile gives it. */
async function businessCurrency(db: Db): Promise<string> {
  const [row] = await db.orm.select({ currency: business.currency }).from(business).limit(1);
  return row?.currency || (await readSettings(db)).business.currency;
}
