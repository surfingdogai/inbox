import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import type { Item, ItemType, Money, PayloadOf, Personalised } from "../domain/types";
import { floorsFor } from "../negotiation/catalogue";
import { type Reward, rewardFor, rewardPrice, type Standing } from "../negotiation/rewards";
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
export async function priceFromCatalogue(
  db: Db,
  type: ItemType,
  payload: Record<string, unknown>,
  pricing?: PricingFor,
): Promise<Priced> {
  if (type === "booking") return priceBooking(db, payload as PayloadOf<"booking">, pricing);
  if (type === "order") return priceOrder(db, payload as PayloadOf<"order">, pricing);
  return { payload, unpriced: false };
}

/**
 * Who the price is for (ADR-018 §4, Q3): the owner's rewards and the customer's standing, so a
 * catalogue line is priced at the customer's price P — the list price, or the owner's reward for their
 * record, never below the owner's floor. Absent, every price is the list price.
 */
export interface PricingFor {
  readonly rewards: readonly Reward[];
  readonly standing: Standing;
}

/** What the catalogue says of one service for this customer, for one booking of `partySize`. */
export interface ServicePricing {
  readonly name: string;
  readonly durationMin: number;
  readonly negotiable: boolean;
  /** Its list price for this booking; null when the catalogue does not price it (`from`, by quote). */
  readonly list: Money | null;
  /** The customer's price P for it: the list price, or the owner's reward for them. */
  readonly customer: Money | null;
  /** The owner's floor for this booking, when set. */
  readonly floor: number | null;
  /** The reward that made P, when it is below the list price. */
  readonly reward: Reward | null;
}

export async function servicePricing(
  db: Db,
  serviceId: string,
  partySize: number | undefined,
  pricing?: PricingFor,
): Promise<ServicePricing | null> {
  const [service] = await db.orm
    .select({
      name: services.name,
      durationMin: services.durationMin,
      price: services.price,
      negotiable: services.negotiable,
    })
    .from(services)
    .where(eq(services.id, serviceId));
  if (!service) return null;
  const list = await serviceTotal(db, service.price, partySize);
  const base = { name: service.name, durationMin: service.durationMin, negotiable: service.negotiable !== 0 };
  if (!list) return { ...base, list: null, customer: null, floor: null, reward: null };
  const per = (await floorsFor(db, "service", [serviceId])).get(serviceId);
  const places = service.price?.per === "person" ? (partySize ?? 1) : 1;
  const floor = per === undefined || !Number.isSafeInteger(per * places) ? null : per * places;
  const reward = pricing ? rewardFor(pricing.rewards, pricing.standing, serviceId) : null;
  const value = reward ? rewardPrice(list.value, floor, reward.pct) : list.value;
  return {
    ...base,
    list,
    customer: { value, currency: list.currency },
    floor,
    reward: value < list.value ? reward : null,
  };
}

/** What the catalogue says of one order line's product for this customer, per unit. */
export interface LinePricing {
  readonly productId: string;
  readonly sku: string | null;
  readonly name: string;
  readonly negotiable: boolean;
  readonly list: Money;
  readonly customer: Money;
  readonly floor: number | null;
  readonly reward: Reward | null;
}

/** For each line, what the catalogue says of its product (by `productId`, else `sku`); null for a line naming none. */
export async function linePricing(
  db: Db,
  lines: readonly { productId?: string | undefined; sku?: string | undefined }[],
  pricing?: PricingFor,
): Promise<(LinePricing | null)[]> {
  const catalogue = await productsFor(db, lines);
  const found = lines.map((l) =>
    l.productId !== undefined
      ? catalogue.byId.get(l.productId)
      : l.sku !== undefined
        ? catalogue.bySku.get(l.sku)
        : undefined,
  );
  const floors = await floorsFor(
    db,
    "product",
    found.flatMap((p) => (p ? [p.id] : [])),
  );
  return found.map((p) => {
    if (!p) return null;
    const list: Money = { value: p.price.value, currency: p.price.currency.toUpperCase() };
    const floor = floors.get(p.id) ?? null;
    const reward = pricing ? rewardFor(pricing.rewards, pricing.standing, p.id) : null;
    const value = reward ? rewardPrice(list.value, floor, reward.pct) : list.value;
    return {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      negotiable: p.negotiable !== 0,
      list,
      customer: { value, currency: list.currency },
      floor,
      reward: value < list.value ? reward : null,
    };
  });
}

/**
 * The notice an order's total carries when a line's price is the customer's own (`listPrice` set): the
 * list total beside it, and the owner's line for them. Undefined when every line is at the list price.
 */
export function orderPersonalised(
  lines: readonly { readonly quantity: number; readonly price: Money; readonly listPrice?: Money | undefined }[],
  says?: string | undefined,
): Personalised | undefined {
  if (!lines.some((l) => l.listPrice !== undefined)) return undefined;
  let value = 0;
  for (const l of lines) value += (l.listPrice ?? l.price).value * l.quantity;
  const currency = (lines[0]?.listPrice ?? lines[0]?.price)?.currency ?? "EUR";
  if (!Number.isSafeInteger(value)) return undefined;
  return { listPrice: { value, currency }, ...(says ? { says } : {}) };
}

async function priceBooking(db: Db, payload: PayloadOf<"booking">, pricing?: PricingFor): Promise<Priced> {
  const { customerStatedPrice: _sent, personalised: _chosen, ...asked } = payload;
  const service = await servicePricing(db, asked.reservationFor.serviceId, asked.partySize, pricing);
  if (!service) return { payload: asked, unpriced: asked.totalPrice !== undefined };
  const named = { ...asked, reservationFor: { ...asked.reservationFor, name: clip(service.name, 200) } };
  if (!service.list || !service.customer) return { payload: named, unpriced: named.totalPrice !== undefined };
  const stated = asked.totalPrice;
  const ours = service.customer;
  // The list price is for the service as long as the business sells it: longer is a person's to price.
  const longer = Date.parse(asked.endTime) - Date.parse(asked.startTime) > service.durationMin * 60_000;
  // An assistant that wrote the list price for a rewarded service has not asked for another price:
  // its customer pays theirs, and reads it before anything binds.
  const differs = stated && !sameMoney(stated, ours) && !sameMoney(stated, service.list);
  return {
    payload: {
      ...named,
      totalPrice: ours,
      ...(differs ? { customerStatedPrice: stated } : {}),
      ...(service.reward
        ? { personalised: { listPrice: service.list, ...(service.reward.says ? { says: service.reward.says } : {}) } }
        : {}),
    },
    unpriced: longer,
  };
}

/** A service's price as the catalogue holds it: fixed, from, or by quote; per booking unless it says per person. */
type ServicePrice = (typeof services.$inferSelect)["price"];

/**
 * What the catalogue charges for one booking of a service: its fixed price, times the party for a
 * service priced per person (the founder, 23 September 2026). Null when the catalogue does not price it:
 * a service priced `from` or by quote, or with no price.
 */
async function serviceTotal(db: Db, price: ServicePrice, partySize: number | undefined): Promise<Money | null> {
  if (price?.model !== "fixed" || typeof price.value !== "number") return null;
  const places = price.per === "person" ? (partySize ?? 1) : 1;
  const value = price.value * places;
  // A total no one can write down exactly is no price: it would be stored and never read again.
  if (!Number.isSafeInteger(value)) {
    throw new WriteError("invalid_input", "The booking's total is too large: book for fewer people.", {
      fields: [{ path: "payload.partySize", problem: "invalid", message: "too large" }],
    });
  }
  return { value, currency: (price.currency ?? (await businessCurrency(db))).toUpperCase() };
}

async function priceOrder(db: Db, payload: PayloadOf<"order">, pricing?: PricingFor): Promise<Priced> {
  const { customerStatedPrice: _sent, personalised: _chosen, ...asked } = payload;
  const lines = asked.orderedItem.map(({ customerStatedPrice: _line, listPrice: _list, ...line }) => line);
  const catalogue = await productsFor(db, lines);
  const priced = await linePricing(db, lines, pricing);
  /** The owner's line for the customer, from the first reward that priced a line. */
  let says: string | undefined;
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
    const list: Money = { value: product.price.value, currency: product.price.currency.toUpperCase() };
    const p = priced[i];
    // The customer's price: the list price, or the owner's reward for them (never below the floor).
    const ours: Money = p && p.productId === product.id ? p.customer : list;
    const rewarded = p?.productId === product.id && p.reward !== null && ours.value < list.value;
    if (rewarded) says ??= p?.reward?.says;
    currency ??= ours.currency;
    const { sku: _sku, ...rest } = line;
    const sku = product.sku !== null && product.sku.length <= 100 ? { sku: product.sku } : {};
    const named = {
      ...rest,
      productId: product.id,
      ...sku,
      name: clip(product.name, 200),
      price: ours,
      ...(rewarded ? { listPrice: list } : {}),
    };
    // A line the assistant wrote at the list price is not a price of the customer's: they pay theirs.
    orderedItem.push(
      sameMoney(line.price, ours) || sameMoney(line.price, list)
        ? named
        : { ...named, customerStatedPrice: line.price },
    );
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
  const personalised = orderPersonalised(orderedItem, says);
  return {
    payload: {
      ...asked,
      orderedItem,
      totalPrice: ours,
      ...(sameMoney(stated, ours) || (personalised && sameMoney(stated, personalised.listPrice))
        ? {}
        : { customerStatedPrice: stated }),
      ...(personalised ? { personalised } : {}),
    },
    unpriced,
  };
}

/**
 * No rule confirms a booking or accepts an order whose create held a price the business did not set
 * (ADR-018 §3.2): a person prices it first, or the €1 order is back under another name. A rule is
 * held here; the owner's AI is held the same way in `transition.ts` (time yes, money no); the owner
 * in person and their other tools are the business, and answer to ADR-018 §4.
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

export const sameMoney = (a: Money, b: Money) =>
  a.value === b.value && a.currency.toUpperCase() === b.currency.toUpperCase();

/** A catalogue name as an item holds it: the payload schemas cap a name's length, a feed does not. */
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** At most this many values in one `IN (…)`: D1 binds at most 100 parameters to a statement. */
const CHUNK = 90;

interface CatalogueProduct {
  readonly id: string;
  readonly sku: string | null;
  readonly name: string;
  readonly price: Money;
  readonly negotiable: number;
}

async function productsFor(db: Db, lines: readonly { productId?: string | undefined; sku?: string | undefined }[]) {
  const ids = [...new Set(lines.flatMap((l) => (l.productId !== undefined ? [l.productId] : [])))];
  const skus = [...new Set(lines.flatMap((l) => (l.sku !== undefined ? [l.sku] : [])))];
  const byId = new Map<string, CatalogueProduct>();
  const bySku = new Map<string, CatalogueProduct>();
  const columns = {
    id: products.id,
    sku: products.sku,
    name: products.name,
    price: products.price,
    negotiable: products.negotiable,
  };
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
