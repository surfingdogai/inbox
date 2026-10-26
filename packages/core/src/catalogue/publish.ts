import { sha256Hex } from "@surfingdog/platform";
import {
  CATALOGUE_DESCRIPTION_MAX,
  CATALOGUE_NAME_MAX,
  type CatalogueItem,
  type CatalogueListedItem,
  isPlaceholderTitle,
  normaliseGtin,
} from "@surfingdog/spec";
import type { products } from "../schema/tables";
import { canonicalJson } from "../util/canonical";

/**
 * One public view of a product (ADR-029): what the business's own doors (`GET /v1/products`, MCP
 * `list_products`) and its signed catalogue feed (`GET /v1/catalogue/changes`) say of it, made in
 * one place so they never say different things.
 *
 * Never public: where it came from (`source`, which for a feed is its address, query string and any
 * key in it included), the source's own id, its location, a barcode that did not pass the check or
 * waits for the owner (`gtin_given`), what a source said its category was, its dates of creation,
 * and the owner's floors and rewards. The doors also give its stock count and its order-time terms;
 * the feed gives neither: a network is told in stock, out of stock or on sale, never a count (D3).
 */

export type ProductRow = typeof products.$inferSelect;
export type ProductAvailability = CatalogueListedItem["availability"];

/** The domains the business's own site lives on: a product's page is published only on one of them. */
export interface CatalogueContext {
  readonly sites: readonly string[];
}

/** A product at the public doors. */
export interface PublicProduct {
  readonly id: string;
  readonly sku: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly price: { readonly value: number; readonly currency: string };
  readonly availability: ProductAvailability;
  readonly gtin: string | null;
  readonly no_gtin: boolean;
  readonly brand: string | null;
  readonly mpn: string | null;
  readonly condition: string;
  readonly url: string | null;
  readonly image_url: string | null;
  readonly updated_at: string;
  /** At the door only: what an order is held to, and never sent to a network. */
  readonly stock: number | null;
  readonly active: number;
  readonly withdrawal: string;
  readonly negotiable: number;
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

/** In stock (counted, above 0), out of stock (counted, 0), or on sale with no count kept. */
export function availabilityOf(row: Pick<ProductRow, "stock">): ProductAvailability {
  if (row.stock === null || row.stock === undefined) return "on_sale";
  return row.stock > 0 ? "in_stock" : "out_of_stock";
}

/** The barcode as published: the stored one, read again by the same check, or none. */
function publicGtin(gtin: string | null): string | null {
  if (!gtin) return null;
  const r = normaliseGtin(gtin, "barcode");
  return "ok" in r ? r.ok.gtin14 : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function publicProduct(row: ProductRow, ctx: CatalogueContext): PublicProduct {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    price: { value: row.price.value, currency: row.price.currency },
    availability: availabilityOf(row),
    gtin: publicGtin(row.gtin),
    no_gtin: row.noGtin === 1,
    brand: row.brand,
    mpn: row.mpn,
    condition: row.condition,
    url: onSite(row.url, ctx.sites),
    image_url: row.imageUrl,
    updated_at: iso(row.updatedAt),
    stock: row.stock,
    active: row.active,
    withdrawal: row.withdrawal,
    negotiable: row.negotiable,
  };
}

/**
 * Why a product is not listed on networks, or null when it is: off sale, kept off networks by the
 * owner, priced at nothing, in something that is no ISO currency, or named as a template's sample.
 */
export type NotListedWhy = "off_sale" | "kept_off" | "price_zero" | "currency" | "sample_name";

export function listableWhy(row: Pick<ProductRow, "active" | "listed" | "price" | "name">): NotListedWhy | null {
  if (row.active !== 1) return "off_sale";
  if (row.listed !== 1) return "kept_off";
  if (!(row.price.value > 0)) return "price_zero";
  if (!/^[A-Z]{3}$/.test(row.price.currency)) return "currency";
  if (isPlaceholderTitle(row.name)) return "sample_name";
  return null;
}

/**
 * The SQL twin of `listableWhy() === null`, for the counts a ping and a page carry without reading
 * every row. `vocab/placeholder-titles.json`'s names are compared as `isPlaceholderTitle` does.
 */
export function listableSql(placeholders: readonly string[]): { sql: string; params: string[] } {
  return {
    sql: `active = 1 AND listed = 1 AND json_extract(price, '$.value') > 0
          AND length(json_extract(price, '$.currency')) = 3
          AND replace(lower(trim(name)), '’', '''') NOT IN (${placeholders.map(() => "?").join(", ")})`,
    params: [...placeholders],
  };
}

/** What a network may list of one product, or that it is withdrawn. */
export async function catalogueItem(row: ProductRow, ctx: CatalogueContext): Promise<CatalogueItem> {
  if (listableWhy(row) !== null) return { id: row.id, state: "withdrawn", updated_at: iso(row.updatedAt) };
  const p = publicProduct(row, ctx);
  const body = {
    id: p.id,
    state: "listed" as const,
    sku: p.sku,
    name: p.name.slice(0, CATALOGUE_NAME_MAX),
    description: p.description === null ? null : p.description.slice(0, CATALOGUE_DESCRIPTION_MAX),
    price: p.price,
    availability: p.availability,
    gtin: p.gtin,
    no_gtin: p.no_gtin,
    brand: p.brand,
    mpn: p.mpn,
    condition: (["new", "used", "refurbished"].includes(p.condition)
      ? p.condition
      : "new") as CatalogueListedItem["condition"],
    url: p.url,
    image_url: p.image_url?.startsWith("https://") ? p.image_url : null,
  };
  const hash = (await sha256Hex(new TextEncoder().encode(canonicalJson(body)))).slice(0, 16);
  return { ...body, updated_at: p.updated_at, hash };
}
