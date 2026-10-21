import type { Weekly } from "../capabilities/availability";
import { type Closure, readClosures } from "../capabilities/closures";
import type { Db } from "../db";
import { type MenuFields, menuOf } from "../menu/schema";
import { readSettings, type Settings } from "../settings/schema";
import { premisesOf } from "../trades/job";

/**
 * What every kitchen read starts from (ADR-036): the business's zone, currency, name and opening hours,
 * its closures, its settings, and where its premises are (the base delivery rings are measured from,
 * never published).
 */
export interface KitchenContext {
  readonly settings: Settings;
  readonly timezone: string;
  readonly currency: string;
  readonly name: string;
  readonly language: string;
  /** The business's weekly hours: orders are taken for slots inside them. None set: no slots. */
  readonly weekly: Weekly;
  readonly closures: readonly Closure[];
  readonly premises: { lat: number; lng: number } | null;
}

export async function kitchenContext(db: Db): Promise<KitchenContext> {
  const settings = await readSettings(db);
  const { rows } = await db.client.query({
    sql: "SELECT name, timezone, currency, languages FROM business LIMIT 1",
    params: [],
    method: "all",
  });
  const r = rows[0];
  const hours = await db.client.query({
    sql: "SELECT weekly FROM availability_rules WHERE kind = 'open' AND service_id IS NULL LIMIT 1",
    params: [],
    method: "all",
  });
  const languages = parse(r?.[3]);
  return {
    settings,
    timezone: String(r?.[1] ?? settings.business.timezone ?? "UTC") || "UTC",
    currency: String(r?.[2] ?? settings.business.currency ?? "EUR").toUpperCase(),
    name: String(r?.[0] ?? "").trim() || settings.business.name.trim() || "The business",
    language: Array.isArray(languages) && typeof languages[0] === "string" ? languages[0] : "en",
    weekly: (parse(hours.rows[0]?.[0]) ?? {}) as Weekly,
    closures: await readClosures(db),
    premises: premisesOf(settings),
  };
}

function parse(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}

/** A product on the menu, as the kitchen reads it. */
export interface MenuProduct {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly sku: string | null;
  readonly price: { readonly value: number; readonly currency: string };
  readonly stock: number | null;
  readonly active: boolean;
  readonly withdrawal: string;
  readonly menu: MenuFields | null;
  /** The business's local date it was marked sold out for. */
  readonly soldOutOn: string | null;
  readonly source: string;
  readonly externalId: string | null;
}

const PRODUCT_COLUMNS =
  "id, name, description, sku, price, stock, active, withdrawal, menu, sold_out_on, source, external_id";

function productOf(r: readonly unknown[]): MenuProduct {
  const price = parse(r[4]) as { value?: unknown; currency?: unknown } | null;
  return {
    id: String(r[0]),
    name: String(r[1]),
    description: r[2] === null || r[2] === undefined ? null : String(r[2]),
    sku: r[3] === null || r[3] === undefined ? null : String(r[3]),
    price: { value: Number(price?.value ?? 0), currency: String(price?.currency ?? "").toUpperCase() },
    stock: r[5] === null || r[5] === undefined ? null : Number(r[5]),
    active: Number(r[6]) === 1,
    withdrawal: String(r[7] ?? "standard"),
    menu: menuOf(r[8]),
    soldOutOn: r[9] === null || r[9] === undefined ? null : String(r[9]),
    source: String(r[10] ?? "builtin"),
    externalId: r[11] === null || r[11] === undefined ? null : String(r[11]),
  };
}

/** Every product on the menu (or every product, with `all`), in the menu's order. */
export async function menuProducts(db: Db, opts: { readonly all?: boolean } = {}): Promise<MenuProduct[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${PRODUCT_COLUMNS} FROM products ${opts.all ? "" : "WHERE menu IS NOT NULL"}
           ORDER BY CAST(json_extract(menu, '$.sort') AS INTEGER), name, id`,
    params: [],
    method: "all",
  });
  return rows.map(productOf);
}

/** Products by id, menu or not: what an order's lines name. */
export async function productsById(db: Db, ids: readonly string[]): Promise<Map<string, MenuProduct>> {
  const unique = [...new Set(ids)].slice(0, 200);
  if (unique.length === 0) return new Map();
  const { rows } = await db.client.query({
    sql: `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id IN (${unique.map(() => "?").join(", ")})`,
    params: unique,
    method: "all",
  });
  return new Map(rows.map((r) => [String(r[0]), productOf(r)]));
}

/** Products by sku, for lines that name one instead. */
export async function productsBySku(db: Db, skus: readonly string[]): Promise<Map<string, MenuProduct>> {
  const unique = [...new Set(skus)].slice(0, 200);
  if (unique.length === 0) return new Map();
  const { rows } = await db.client.query({
    sql: `SELECT ${PRODUCT_COLUMNS} FROM products WHERE sku IN (${unique.map(() => "?").join(", ")})`,
    params: unique,
    method: "all",
  });
  return new Map(rows.map((r) => [String(r[3]), productOf(r)]));
}

/** Whether this inbox has anything on a menu: the menu doors are offered then. */
export async function hasMenu(db: Db): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM products WHERE menu IS NOT NULL AND active = 1 LIMIT 1",
    params: [],
    method: "all",
  });
  return rows.length > 0;
}
