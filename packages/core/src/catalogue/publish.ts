import {
  ageLabel,
  type CatalogueAvailabilityV2,
  type CatalogueItem,
  type CatalogueListedItemV2,
  catalogueItemV1Of,
  unitPriceOf,
} from "@surfingdog/spec";
import type { products } from "../schema/tables";
import {
  availabilityV2,
  catalogueItemV2,
  listableV2Why,
  type NotListedV2Why,
  productAge,
  publicGtin,
  publishableUrl,
  wasPriceRefusal,
} from "./v2";

/**
 * One public view of a product (ADR-029, catalogue version 2): what the business's own doors
 * (`GET /v1/products`, MCP `list_products`) and its signed catalogue feed (`GET /v1/catalogue/changes`)
 * say of it, made from the same helpers (`v2.ts`) so they never say different things.
 *
 * Never public: where it came from (`source`, which for a feed is its address, query string and any
 * key in it included), the source's own id, its location, a barcode that did not pass the check or
 * waits for the owner (`gtin_given`), what a source said its category was, its dates of creation,
 * its record of prices, the owner's few-left mark, and the owner's floors and rewards. The doors also
 * give its stock count and its order-time terms; the feed gives neither: a network is told whether it
 * can be had, never a count (D3).
 */

export type ProductRow = typeof products.$inferSelect;
export type ProductAvailability = CatalogueAvailabilityV2;

/** The domains the business's own site lives on: a product's page is published only on one of them. */
export interface CatalogueContext {
  readonly sites: readonly string[];
}

/** What the doors' view needs besides the row: the moment, the groups' titles, and the record of prices. */
export interface ProductDoorContext extends CatalogueContext {
  readonly now?: number | undefined;
  readonly groups?: ReadonlyMap<string, { readonly title: string }> | undefined;
  readonly history?:
    | ReadonlyMap<string, readonly { readonly at: number; readonly value: number; readonly currency: string }[]>
    | undefined;
}

/** A product at the public doors. Members past `negotiable` are given only when they say something. */
export interface PublicProduct {
  readonly id: string;
  readonly sku: string | null;
  readonly name: string;
  readonly description: string | null;
  /** The price; for `from` the lowest and for `range` the lowest; null for a price on request (`quote`). */
  readonly price: { readonly value: number; readonly currency: string } | null;
  readonly price_model: CatalogueListedItemV2["price_model"];
  readonly availability: ProductAvailability;
  readonly gtin: string | null;
  readonly no_gtin: boolean;
  readonly brand: string | null;
  readonly mpn: string | null;
  readonly condition: string;
  readonly url: string | null;
  readonly image_url: string | null;
  /** Pictures and videos, the main picture first; empty when there are none. */
  readonly media: CatalogueListedItemV2["media"];
  readonly updated_at: string;
  /** At the door only: what an order is held to, and never sent to a network. */
  readonly stock: number | null;
  readonly active: number;
  readonly withdrawal: string;
  readonly negotiable: number;
  readonly group?: { readonly id: string; readonly title: string; readonly position: number };
  readonly options?: CatalogueListedItemV2["options"];
  readonly price_max?: { readonly value: number; readonly currency: string };
  /** The "was" price, only while the 30-day rule holds by the inbox's own record of prices. */
  readonly list_price?: { readonly value: number; readonly currency: string };
  /** The net quantity sold, and the price per reference quantity worked out from the price. */
  readonly unit_price?: NonNullable<CatalogueListedItemV2["unit_price"]> & {
    readonly amount: { readonly value: number; readonly currency: string };
  };
  readonly tax_included?: boolean;
  readonly available_from?: string;
  readonly available_until?: string;
  readonly multipack?: number;
  readonly is_bundle?: boolean;
  /** Sold only above an age, ID checked at handover, with the words to show beside it. */
  readonly age_restricted?: Omit<NonNullable<CatalogueListedItemV2["age_restricted"]>, "kind"> & {
    /** Null for a menu's own age (ADR-040), until the owner says what kind of product it is. */
    readonly kind: string | null;
    readonly label: string;
  };
  readonly fulfil_methods?: readonly string[];
  readonly shipping_profile?: string;
  readonly weight?: { readonly value: number; readonly unit: string };
  readonly return_policy?: string;
}

/**
 * The business's own site, as domains: its profile's domain and its website's host, each without a
 * leading `www.`. A host is on the site when it is one of them or under one (`shop.loja.example`), the
 * crawler's `sameSite` rule.
 */
export function siteDomains(input: { readonly domain: string | null; readonly website: string }): string[] {
  const out = new Set<string>();
  const add = (host: string) => {
    const h = host
      .trim()
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
    if (h.includes(".")) out.add(h);
  };
  if (input.domain) add(input.domain);
  if (input.website) {
    try {
      add(new URL(input.website).hostname);
    } catch {
      // Not a URL: no site from it.
    }
  }
  return [...out];
}

function onSite(url: string | null, sites: readonly string[]): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    return sites.some((d) => host === d || host.endsWith(`.${d}`)) ? url : null;
  } catch {
    return null;
  }
}

/** Whether it can be had, never a count: as `availabilityV2` says at this moment. */
export function availabilityOf(
  row: Pick<ProductRow, "stock"> & Partial<Pick<ProductRow, "availability" | "availableFrom" | "fewLeft">>,
  now = Date.now(),
): ProductAvailability {
  return availabilityV2(
    {
      stock: row.stock,
      availability: row.availability ?? null,
      availableFrom: row.availableFrom ?? null,
      fewLeft: row.fewLeft ?? null,
    },
    now,
  );
}

const iso = (ms: number) => new Date(ms).toISOString();

export function publicProduct(row: ProductRow, ctx: ProductDoorContext): PublicProduct {
  const now = ctx.now ?? Date.now();
  const fixed = row.priceModel === "fixed";
  const price = row.priceModel === "quote" ? null : { value: row.price.value, currency: row.price.currency };
  const group = row.groupId ? ctx.groups?.get(row.groupId) : undefined;
  const unit =
    fixed && price && row.unitPrice
      ? unitPriceOf({ value: Math.max(1, price.value), currency: price.currency }, row.unitPrice)
      : null;
  const availability = availabilityOf(row, now);
  const was =
    fixed && row.listPrice && ctx.history && wasPriceRefusal(row, ctx.history.get(row.id) ?? []) === null
      ? row.listPrice
      : null;
  const own = row.ageRestricted;
  const age = productAge(row);
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    price,
    price_model: row.priceModel as PublicProduct["price_model"],
    availability,
    gtin: publicGtin(row.gtin),
    no_gtin: row.noGtin === 1,
    brand: row.brand,
    mpn: row.mpn,
    condition: row.condition,
    url: onSite(row.url, ctx.sites),
    image_url: row.imageUrl,
    media: [
      ...(publishableUrl(row.imageUrl) ? [{ type: "image" as const, url: row.imageUrl }] : []),
      ...(row.media ?? []).filter((m) => publishableUrl(m.url)),
    ].slice(0, 10),
    updated_at: iso(row.updatedAt),
    stock: row.stock,
    active: row.active,
    withdrawal: row.withdrawal,
    negotiable: row.negotiable,
    ...(group && row.groupId && row.options?.length
      ? { group: { id: row.groupId, title: group.title, position: row.groupPosition ?? 1 }, options: row.options }
      : {}),
    ...(row.priceModel === "range" && row.priceMax ? { price_max: row.priceMax } : {}),
    ...(was ? { list_price: was } : {}),
    ...(unit && row.unitPrice && !("problem" in unit)
      ? { unit_price: { ...row.unitPrice, amount: { value: unit.amount, currency: unit.currency } } }
      : {}),
    ...(row.taxIncluded !== null ? { tax_included: row.taxIncluded === 1 } : {}),
    ...((availability === "preorder" || availability === "backorder") && row.availableFrom !== null
      ? { available_from: iso(row.availableFrom) }
      : {}),
    ...(row.availableUntil !== null ? { available_until: iso(row.availableUntil) } : {}),
    ...(row.multipack !== null && row.multipack >= 2 ? { multipack: row.multipack } : {}),
    ...(row.isBundle === 1 ? { is_bundle: true } : {}),
    ...(age
      ? {
          age_restricted: {
            min_age: age.min_age,
            kind: age.kind,
            ...(own?.by_country && Object.keys(own.by_country).length ? { by_country: own.by_country } : {}),
            check: "id_at_handover" as const,
            label: ageLabel(age.min_age),
          },
        }
      : {}),
    ...(row.fulfilMethods?.length ? { fulfil_methods: row.fulfilMethods } : {}),
    ...(row.shippingProfileId ? { shipping_profile: row.shippingProfileId } : {}),
    ...(row.weight ? { weight: row.weight } : {}),
    ...(row.returnPolicyId ? { return_policy: row.returnPolicyId } : {}),
  };
}

/**
 * Why a product is not listed on networks, or null when it is: off sale, kept off networks by the
 * owner, priced at nothing (a price on request has none, and is listed), in something that is no ISO
 * currency, named as a template's sample, past the last day it could be ordered, or of a kind networks
 * keep off (tobacco and nicotine, cannabis, weapons) or that the vocabulary does not know.
 */
export type NotListedWhy = NotListedV2Why;

export function listableWhy(
  row: Pick<ProductRow, "active" | "listed" | "price" | "name"> &
    Partial<Pick<ProductRow, "priceModel" | "availableUntil" | "ageRestricted" | "menu">>,
  now = Date.now(),
): NotListedWhy | null {
  return listableV2Why(
    {
      ...row,
      priceModel: row.priceModel ?? "fixed",
      availableUntil: row.availableUntil ?? null,
      ageRestricted: row.ageRestricted ?? null,
    },
    now,
  );
}

/**
 * What a version 1 reader is given of one product: its version 2 item as version 1 says it
 * (`catalogueItemV1Of`), without the business's policies or groups, which version 1 does not carry.
 */
export async function catalogueItem(row: ProductRow, ctx: CatalogueContext, now = Date.now()): Promise<CatalogueItem> {
  const built = await catalogueItemV2(row, {
    sites: ctx.sites,
    now,
    policies: null,
    groups: new Map(),
    history: new Map(),
  });
  const v1 = await catalogueItemV1Of(built.item, { as_of: iso(now) });
  return v1 ?? { id: row.id, state: "withdrawn", updated_at: iso(row.updatedAt) };
}
