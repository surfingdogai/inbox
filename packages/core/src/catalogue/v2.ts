import type { Statement } from "@surfingdog/platform";
import {
  AGE_KINDS_OFF,
  ageKindOf,
  CATALOGUE_DESCRIPTION_MAX_V2,
  CATALOGUE_MEDIA_MAX,
  CATALOGUE_MULTIPACK_MAX,
  CATALOGUE_NAME_MAX,
  CATALOGUE_URL_PATTERN,
  type CatalogueAvailabilityV2,
  type CatalogueItemV2,
  type CatalogueListedItemV2,
  type CatalogueProblem,
  catalogueItemHash,
  catalogueWithdrawalSchema,
  cutText,
  isPlaceholderTitle,
  normaliseGtin,
  type PricePoint,
  readCatalogueItemV2,
  unitPriceOf,
  WEIGHT_UNITS,
  wasPriceOf,
} from "@surfingdog/spec";
import { inArray } from "drizzle-orm";
import type { Db } from "../db";
import { productPrices, type products } from "../schema/tables";
import { NEXT_CATALOGUE_SEQ } from "./identity";
import type { PoliciesState } from "./policies";

/**
 * A product as catalogue version 2 publishes it (protocol §4.18 as amended, ADR-047): the one place the
 * feed, its version 1 pages (`catalogueItemV1Of` of this) and the public doors take a product's v2 fields
 * from, so they never say different things.
 *
 * An inbox publishes only what a reader takes whole. Every item is read back through the spec's own
 * reader (`readCatalogueItemV2`) before it is served: one it would hold is served withdrawn, with the
 * code, for the owner's page (`CATALOGUE_V2_PROBLEMS`), and a member it would drop is left out. So a
 * network never holds or drops anything of an inbox's own feed, and the owner sees why in their words.
 */

type ProductRow = typeof products.$inferSelect;

const URL_RE = new RegExp(CATALOGUE_URL_PATTERN);
const iso = (ms: number) => new Date(ms).toISOString();

/** What building an item needs besides the row. */
export interface CatalogueV2Context {
  /** The business's own site, as domains: a product's page is published only on one of them. */
  readonly sites: readonly string[];
  /** The moment the page is for, in milliseconds. */
  readonly now: number;
  /** The business's policies, as a reader reads them; null checks no profile or policy the items name. */
  readonly policies: PoliciesState | null;
  /** The titles of the product groups the rows name. */
  readonly groups: ReadonlyMap<string, { readonly title: string }>;
  /** Each product's recorded prices, oldest first, for the "was" price rule. */
  readonly history: ReadonlyMap<
    string,
    readonly { readonly at: number; readonly value: number; readonly currency: string }[]
  >;
  /**
   * Whether the items say what the business says of the legal right to withdraw (`withdrawal`): only where
   * the inbox applies one, by its country (`lawOf` is not `other`, ADR-018 Amendment 7). Elsewhere an item
   * says nothing of it, and its return terms are its return policy's (`return_policy`), as published.
   */
  readonly withdrawal: boolean;
}

/** Whether a link is one version 2 publishes: https, on a host name, as RFC 3986 writes it. */
export function publishableUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && url.length <= 2048 && URL_RE.test(url);
}

/** On the business's own site, as the crawler's `sameSite` rule has it. */
function onSite(url: string | null, sites: readonly string[]): string | null {
  if (!publishableUrl(url)) return null;
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  return sites.some((d) => host === d || host.endsWith(`.${d}`)) ? url : null;
}

/**
 * Whether it can be had, never a count. As the owner set it where the stock cannot say it (made to order,
 * a pre-order until it comes out, a back-order while none is in), else as its stock says: on sale when it
 * is not counted, out of stock at none, few left (`limited`) at or below the owner's own mark, else in stock.
 */
export function availabilityV2(
  row: Pick<ProductRow, "stock" | "availability" | "availableFrom" | "fewLeft">,
  now: number,
): CatalogueAvailabilityV2 {
  if (row.availability === "made_to_order") return "made_to_order";
  if (row.availability === "preorder" && row.availableFrom !== null && row.availableFrom > now) return "preorder";
  const counted = row.stock !== null && row.stock !== undefined;
  if (row.availability === "backorder" && (!counted || (row.stock as number) <= 0)) return "backorder";
  if (!counted) return "on_sale";
  const stock = row.stock as number;
  if (stock <= 0) return "out_of_stock";
  return row.fewLeft !== null && row.fewLeft !== undefined && stock <= row.fewLeft ? "limited" : "in_stock";
}

/** The ages a menu may sell above (ADR-040, `menu.ageRestricted`). */
const MENU_AGES: readonly number[] = [16, 18, 19, 20, 21];

/**
 * A menu's own age (ADR-040: a beer at 18), or null: what the kitchen's menu says of a dish or a drink,
 * which names no kind of product. Until the owner gives the product an age restriction of its own, with
 * its kind, it is sold at the business's doors with "ID checked at handover" and kept off networks
 * (`age_kind_unknown`): a network lists an age only with its kind, and a guess would list a shisha as a drink.
 */
export function menuAgeOf(menu: unknown): number | null {
  let m = menu;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m) as unknown;
    } catch {
      return null;
    }
  }
  const age = m && typeof m === "object" ? (m as { ageRestricted?: unknown }).ageRestricted : null;
  return typeof age === "number" && MENU_AGES.includes(age) ? age : null;
}

/** The age a product is sold above, its own or else its menu's: with its kind, or null for a menu's. */
export function productAge(
  row: Pick<ProductRow, "ageRestricted"> & Partial<Pick<ProductRow, "menu">>,
): { readonly min_age: number; readonly kind: string | null } | null {
  if (row.ageRestricted) return row.ageRestricted;
  const menu = menuAgeOf(row.menu);
  return menu === null ? null : { min_age: menu, kind: null };
}

/** Why a product is not listed in version 2, or null: version 1's reasons, and what version 2 adds. */
export type NotListedV2Why =
  | "off_sale"
  | "kept_off"
  | "price_zero"
  | "currency"
  | "sample_name"
  | "available_until_passed"
  | "age_kind_off"
  | "age_kind_unknown";

export function listableV2Why(
  row: Pick<ProductRow, "active" | "listed" | "price" | "name" | "priceModel" | "availableUntil" | "ageRestricted"> &
    Partial<Pick<ProductRow, "menu">>,
  now: number,
): NotListedV2Why | null {
  if (row.active !== 1) return "off_sale";
  if (row.listed !== 1) return "kept_off";
  // A price on request has none: the price kept beside it is never published.
  if (row.priceModel !== "quote") {
    if (!(row.price.value > 0)) return "price_zero";
    if (!/^[A-Z]{3}$/.test(row.price.currency)) return "currency";
  }
  if (isPlaceholderTitle(row.name)) return "sample_name";
  if (row.availableUntil !== null && row.availableUntil <= now) return "available_until_passed";
  const age = productAge(row);
  if (age) {
    const kind = age.kind === null ? null : ageKindOf(age.kind);
    if (kind === null) return "age_kind_unknown";
    if (AGE_KINDS_OFF.includes(kind)) return "age_kind_off";
  }
  return null;
}

/**
 * Whether its "was" price may be published, by the inbox's own record of its prices (`wasPriceOf`, the
 * EU's 30-day rule applied everywhere): the price now is below it, and the product was at or above it for
 * the whole of the 30 days before its price first went below it. Null when it may; else the code.
 */
export function wasPriceRefusal(
  row: Pick<ProductRow, "price" | "listPrice" | "priceModel" | "updatedAt">,
  points: readonly { readonly at: number; readonly value: number; readonly currency: string }[],
): CatalogueProblem | null {
  const lp = row.listPrice;
  if (!lp) return null;
  if (row.priceModel !== "fixed") return "list_price_not_fixed";
  const currency = row.price.currency.toUpperCase();
  if (lp.currency.toUpperCase() !== currency) return "list_price_currency";
  const history: PricePoint[] = points
    .filter((p) => p.currency === currency)
    .map((p) => ({ at: iso(p.at), value: p.value }));
  // The price now is the last of the record, even before the record has caught up with it.
  if (history.at(-1)?.value !== row.price.value) history.push({ at: iso(row.updatedAt), value: row.price.value });
  const r = wasPriceOf({ list_price: lp.value, history });
  return r.shown ? null : r.why;
}

/** An item and what the inbox's own read of it found: the codes it is withdrawn for, or the members left out. */
export interface BuiltItem {
  readonly item: CatalogueItemV2;
  /** Why it is withdrawn though it is on sale and listed (`hold` codes), or what was left out of it (`drop`). */
  readonly problems: readonly CatalogueProblem[];
}

/** A product's version 2 item, read back as a network reads it (`readCatalogueItemV2`) before it is served. */
export async function catalogueItemV2(row: ProductRow, ctx: CatalogueV2Context): Promise<BuiltItem> {
  const withdrawn = (problems: readonly CatalogueProblem[] = []): BuiltItem => ({
    item: { id: row.id, state: "withdrawn", updated_at: iso(row.updatedAt) },
    problems,
  });
  const not = listableV2Why(row, ctx.now);
  if (not !== null) return withdrawn(not === "age_kind_off" || not === "age_kind_unknown" ? [not] : []);

  const fixed = row.priceModel === "fixed";
  const price = row.priceModel === "quote" ? null : { value: row.price.value, currency: row.price.currency };
  const group = row.groupId ? ctx.groups.get(row.groupId) : undefined;
  const options = row.options?.length ? row.options : null;
  const grouped = group && options;
  const media = [
    ...(publishableUrl(row.imageUrl) ? [{ type: "image" as const, url: row.imageUrl }] : []),
    ...(row.media ?? []).filter((m) => publishableUrl(m.url)),
  ].slice(0, CATALOGUE_MEDIA_MAX);
  const methods = row.fulfilMethods?.length ? [...new Set(row.fulfilMethods)] : null;
  const ships = methods === null || methods.includes("shipping");
  const availability = availabilityV2(row, ctx.now);
  const age = row.ageRestricted;
  const ageKind = age ? (ageKindOf(age.kind) ?? age.kind) : null;
  const withdrawal = catalogueWithdrawalSchema.safeParse(row.withdrawal);
  const unit =
    fixed && row.unitPrice && price && !("problem" in unitPriceOf(price, row.unitPrice)) ? row.unitPrice : null;
  const was =
    fixed && row.listPrice && wasPriceRefusal(row, ctx.history.get(row.id) ?? []) === null ? row.listPrice : null;
  // Given whenever the owner set it for this product, whatever the catalogue says: so a change to the
  // catalogue's never changes an item without giving it a new position.
  const taxOwn = row.taxIncluded !== null ? { tax_included: row.taxIncluded === 1 } : {};
  const weight =
    row.weight && (WEIGHT_UNITS as readonly string[]).includes(row.weight.unit) && row.weight.value > 0
      ? row.weight
      : null;

  const body: Omit<CatalogueListedItemV2, "updated_at" | "hash"> = {
    id: row.id,
    state: "listed",
    sku: row.sku !== null && row.sku.length <= 64 ? row.sku : null,
    name: cutText(row.name, CATALOGUE_NAME_MAX),
    description: row.description === null ? null : cutText(row.description, CATALOGUE_DESCRIPTION_MAX_V2),
    ...(grouped && row.groupId
      ? {
          group: { id: row.groupId, title: cutText(group.title, CATALOGUE_NAME_MAX), position: row.groupPosition ?? 1 },
          options,
        }
      : {}),
    price_model: row.priceModel as CatalogueListedItemV2["price_model"],
    price,
    ...(row.priceModel === "range" && row.priceMax ? { price_max: row.priceMax } : {}),
    ...(was ? { list_price: was } : {}),
    ...(unit ? { unit_price: unit } : {}),
    ...taxOwn,
    availability,
    ...((availability === "preorder" || availability === "backorder") && row.availableFrom !== null
      ? { available_from: iso(row.availableFrom) }
      : {}),
    ...(row.availableUntil !== null ? { available_until: iso(row.availableUntil) } : {}),
    gtin: publicGtin(row.gtin),
    no_gtin: row.noGtin === 1 && !publicGtin(row.gtin),
    ...(row.multipack !== null && row.multipack >= 2 && row.multipack <= CATALOGUE_MULTIPACK_MAX
      ? { multipack: row.multipack }
      : {}),
    ...(row.isBundle === 1 ? { is_bundle: true } : {}),
    brand: row.brand !== null ? cutText(row.brand, 70) : null,
    mpn: row.mpn !== null ? cutText(row.mpn, 70) : null,
    condition: (["new", "used", "refurbished"].includes(row.condition)
      ? row.condition
      : "new") as CatalogueListedItemV2["condition"],
    url: onSite(row.url, ctx.sites),
    media,
    ...(age && ageKind
      ? {
          age_restricted: {
            min_age: age.min_age,
            kind: ageKind,
            ...(age.by_country && Object.keys(age.by_country).length ? { by_country: age.by_country } : {}),
            check: "id_at_handover" as const,
          },
        }
      : {}),
    ...(methods ? { fulfil_methods: methods as CatalogueListedItemV2["fulfil_methods"] } : {}),
    ...(ships && row.shippingProfileId ? { shipping_profile: row.shippingProfileId } : {}),
    ...(weight ? { weight } : {}),
    // A policy kept but not published (the standard one under another country's law) is not named.
    ...(row.returnPolicyId && !ctx.policies?.unpublished.includes(row.returnPolicyId)
      ? { return_policy: row.returnPolicyId }
      : {}),
    ...(ctx.withdrawal && withdrawal.success ? { withdrawal: withdrawal.data } : {}),
  };
  const item: CatalogueListedItemV2 = {
    ...body,
    updated_at: iso(row.updatedAt),
    hash: await catalogueItemHash(body),
  };
  const read = readCatalogueItemV2(item, {
    as_of: iso(ctx.now),
    policies: ctx.policies?.read ?? null,
    site: ctx.sites,
  });
  if (read.state === "held") return withdrawn(read.problems);
  if (read.state === "withdrawn") return withdrawn();
  if (!read.dropped.length) return { item, problems: [] };
  // What a reader would leave out is left out here, and the hash taken again over what is served.
  const kept: Record<string, unknown> = { ...read.item };
  for (const k of Object.keys(kept)) if (kept[k] === undefined) delete kept[k];
  const { updated_at: _u, hash: _h, ...rest } = kept;
  return {
    item: {
      ...(rest as Omit<CatalogueListedItemV2, "updated_at" | "hash">),
      updated_at: item.updated_at,
      hash: await catalogueItemHash(rest),
    },
    problems: read.dropped,
  };
}

/**
 * The barcode as published, by the feed and the doors alike: the stored one read again by today's check
 * (`normaliseGtin`, its check digit, and no shop's own code or coupon), or none. A barcode stored before a
 * check that now refuses it is never joined with another shop's product by it.
 */
export function publicGtin(gtin: string | null): string | null {
  if (!gtin) return null;
  const r = normaliseGtin(gtin, "barcode");
  return "ok" in r ? r.ok.gtin14 : null;
}

/* --- the record of prices ------------------------------------------------------------------------ */

/** At most this many values in one `IN (…)`: D1 binds at most 100 to a statement. */
const CHUNK = 90;

/** Each product's recorded prices, oldest first (`product_prices`). */
export async function priceHistory(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, { at: number; value: number; currency: string }[]>> {
  const out = new Map<string, { at: number; value: number; currency: string }[]>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db.orm
      .select()
      .from(productPrices)
      .where(inArray(productPrices.productId, ids.slice(i, i + CHUNK)));
    for (const r of rows) {
      const list = out.get(r.productId) ?? [];
      list.push({ at: r.at, value: r.value, currency: r.currency });
      out.set(r.productId, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * Adds to the record of prices (`product_prices`) the price of each product a write just touched
 * (`updated_at` at or after `since`, or the one `id`), when it is not the last one recorded: one
 * statement, put in the same batch as the write, after it. Never a trigger: on D1 a trigger's writes
 * count in a statement's `changes`.
 */
export function priceRecordStatement(
  now: number,
  scope: { readonly id: string } | { readonly since: number },
): Statement {
  const where = "id" in scope ? "p.id = ?" : "p.updated_at >= ?";
  return {
    sql: `INSERT INTO product_prices (product_id, at, value, currency)
          SELECT p.id, ?, json_extract(p.price, '$.value'), upper(json_extract(p.price, '$.currency'))
            FROM products p
           WHERE ${where} AND json_extract(p.price, '$.value') > 0
             AND NOT EXISTS (
               SELECT 1 FROM product_prices pp
                WHERE pp.product_id = p.id
                  AND pp.at = (SELECT MAX(x.at) FROM product_prices x WHERE x.product_id = p.id)
                  AND pp.value = json_extract(p.price, '$.value')
                  AND pp.currency = upper(json_extract(p.price, '$.currency')))`,
    params: [now, "id" in scope ? scope.id : scope.since],
    method: "run",
  };
}

/** Where the feed keeps whether its items last said the legal right to withdraw (`instance_meta`). */
const WITHDRAWAL_SAID_KEY = "catalogue_withdrawal";

/**
 * Whether the items say the legal right to withdraw is a change too (ADR-018 Amendment 7): they say it only
 * while the inbox applies one there (`CatalogueV2Context.withdrawal`), so when that turns, every
 * product takes a new position once, `rev` moves, and a network reads each item again. Items said it before
 * this was kept, so with nothing kept they said it. Run before a page is read: while nothing turned, only
 * the mark is read. Two reads that both see it turn move each product once, by the guard in the update.
 */
export async function catalogueWithdrawalStatements(db: Db, says: boolean, now: number): Promise<Statement[]> {
  const said = says ? "said" : "unsaid";
  const { rows } = await db.client.query({
    sql: "SELECT value FROM instance_meta WHERE key = ?",
    params: [WITHDRAWAL_SAID_KEY],
    method: "all",
  });
  if ((rows[0]?.[0] ?? "said") === said) return [];
  return [
    {
      sql: `UPDATE products SET catalogue_seq = ${NEXT_CATALOGUE_SEQ}, updated_at = MAX(updated_at, ?)
             WHERE COALESCE((SELECT value FROM instance_meta WHERE key = ?), 'said') <> ?`,
      params: [now, WITHDRAWAL_SAID_KEY, said],
      method: "run",
    },
    {
      sql: `INSERT INTO instance_meta (key, value, created_at) VALUES (?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`,
      params: [WITHDRAWAL_SAID_KEY, said, now],
      method: "run",
    },
  ];
}

/**
 * Time is a change (protocol §4.18 as amended): at a product's `available_until`, and at a pre-order's
 * `available_from`, the feed gives it a new position and `rev` moves, though nobody wrote anything. Each
 * once (`timed_at`), its `updated_at` the moment it changed. Run before a page is read, and by the sweep.
 */
export function catalogueClockStatements(now: number): Statement[] {
  return [
    {
      sql: `UPDATE products SET catalogue_seq = ${NEXT_CATALOGUE_SEQ}, timed_at = available_until,
                                updated_at = MAX(updated_at, available_until)
             WHERE available_until IS NOT NULL AND available_until <= ? AND timed_at < available_until`,
      params: [now],
      method: "run",
    },
    {
      sql: `UPDATE products SET catalogue_seq = ${NEXT_CATALOGUE_SEQ}, timed_at = available_from,
                                updated_at = MAX(updated_at, available_from)
             WHERE availability = 'preorder' AND available_from IS NOT NULL AND available_from <= ?
               AND timed_at < available_from`,
      params: [now],
      method: "run",
    },
  ];
}
