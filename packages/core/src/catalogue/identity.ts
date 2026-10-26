import { type GtinHint, normaliseGtin } from "@surfingdog/spec";
import { isPublicHost } from "../util/hosts";

/**
 * What a product is, beside its price (ADR-029), as a source states it and as `products` keeps it:
 * one writer for the feed import, and for every connector that brings a shop's catalogue in, so a
 * barcode from any of them is checked the same way (`normaliseGtin`, `vectors/gtin.json`).
 */

/**
 * The next position in the signed catalogue feed (`products.catalogue_seq`, migration 0026), as SQL:
 * every statement that inserts a product, or changes what the feed shows of one (its name,
 * description, price, stock, sale, sku, barcode, brand, part number, condition, links or `listed`),
 * sets `catalogue_seq` to it. Worked out inside the statement's own write, so it is higher than every
 * position any reader has seen; rows one statement writes share it, and come in id order.
 */
export const NEXT_CATALOGUE_SEQ = "(SELECT COALESCE(MAX(catalogue_seq), 0) + 1 FROM products)";

/** At most this long: a brand and a part number as Merchant Center takes them. */
export const BRAND_MAX = 70;
export const MPN_MAX = 70;
const LINK_MAX = 2048;
const GIVEN_MAX = 64;

export type ProductCondition = "new" | "used" | "refurbished";
export const PRODUCT_CONDITIONS: readonly ProductCondition[] = ["new", "used", "refurbished"];

/** What a source says of a product's identity: only what it gave, each field left out when it said nothing. */
export interface SourceIdentity {
  readonly gtin?: { readonly raw: string; readonly hint: GtinHint } | undefined;
  readonly brand?: string | undefined;
  readonly mpn?: string | undefined;
  readonly condition?: ProductCondition | undefined;
  readonly url?: string | null | undefined;
  readonly imageUrl?: string | null | undefined;
  readonly sourceCategory?: string | undefined;
}

/** The identity columns as `products` keeps them. */
export interface StoredIdentity {
  readonly gtin: string | null;
  readonly gtinGiven: string | null;
  readonly brand: string | null;
  readonly mpn: string | null;
  readonly condition: string;
  readonly url: string | null;
  readonly imageUrl: string | null;
  readonly sourceCategory: string | null;
}

export const NO_IDENTITY: StoredIdentity = {
  gtin: null,
  gtinGiven: null,
  brand: null,
  mpn: null,
  condition: "new",
  url: null,
  imageUrl: null,
  sourceCategory: null,
};

/**
 * A barcode as it is kept: its 14 digits when it passes the check and is a product's barcode, else
 * kept as it was given (`gtin_given`), for the owner to read and never public.
 */
export function storedBarcode(raw: string, hint: GtinHint): { gtin: string | null; gtinGiven: string | null } {
  const r = normaliseGtin(raw, hint);
  if ("ok" in r) return { gtin: r.ok.gtin14, gtinGiven: null };
  const given = raw.trim().slice(0, GIVEN_MAX);
  return { gtin: null, gtinGiven: given || null };
}

/** A link as it is kept: https on a public host, else none. A link to a picture is never fetched here. */
export function storedLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text.length > LINK_MAX) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || !isPublicHost(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The identity a write leaves: what the source gave, and what it left out kept as it was. A source
 * that says nothing of a product's barcode or brand has not said it lost them. A link the source gives
 * that cannot be kept (not https, or on a private host) clears the one it replaces, since the source
 * did say where the page is now.
 */
export function mergedIdentity(current: StoredIdentity | null, source: SourceIdentity): StoredIdentity {
  const was = current ?? NO_IDENTITY;
  const barcode = source.gtin ? storedBarcode(source.gtin.raw, source.gtin.hint) : null;
  return {
    gtin: barcode ? barcode.gtin : was.gtin,
    gtinGiven: barcode ? barcode.gtinGiven : was.gtinGiven,
    brand: source.brand?.trim() ? source.brand.trim().slice(0, BRAND_MAX) : was.brand,
    mpn: source.mpn?.trim() ? source.mpn.trim().slice(0, MPN_MAX) : was.mpn,
    condition: source.condition ?? was.condition,
    url: source.url ? storedLink(source.url) : was.url,
    imageUrl: source.imageUrl ? storedLink(source.imageUrl) : was.imageUrl,
    sourceCategory: source.sourceCategory?.trim() ? source.sourceCategory.trim().slice(0, 250) : was.sourceCategory,
  };
}

/** Whether two stored identities differ, so an unchanged row writes nothing. */
export function identityChanged(a: StoredIdentity, b: StoredIdentity): boolean {
  return (
    a.gtin !== b.gtin ||
    a.gtinGiven !== b.gtinGiven ||
    a.brand !== b.brand ||
    a.mpn !== b.mpn ||
    a.condition !== b.condition ||
    a.url !== b.url ||
    a.imageUrl !== b.imageUrl ||
    a.sourceCategory !== b.sourceCategory
  );
}
