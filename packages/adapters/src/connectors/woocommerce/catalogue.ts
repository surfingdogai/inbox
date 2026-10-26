import { type CatalogueProduct, type CatalogueReader, ConnectorError, type RunContext } from "@surfingdog/core";
import { call, currencyRefusal, minorOf, plain } from "./api";
import { keysOf, storeOf } from "./state";

/**
 * A store's products into the inbox's catalogue (ADR-030 §3, ADR-032 §3), one request per page so a
 * run stays within its budget however the store is built:
 *
 * - **Simple products** are one sellable unit each (`p:<id>`); a **variable** product is not, its
 *   variations are (`v:<id>`), read after the page that listed it, named "Parent – option, option".
 *   Grouped and external products are not sold by this shop's checkout, so they are not brought in.
 * - **On sale** means published and purchasable (a variation, of a published parent); anything else
 *   comes in off sale, so a product made private or a draft in WooCommerce is never offered.
 * - **Stock** is WooCommerce's count where it counts (`manage_stock`, the parent's for a variation
 *   managed there), 0 when it says out of stock without counting, and unknown otherwise.
 * - **Prices** are the store's active price (`price`: the sale price while a sale is on), in the
 *   store's currency, in its own minor unit (ADR-036). A product with no price comes in with none, and the shared upsert
 *   keeps it off sale.
 * - **What changed** is read with `modified_after` in GMT (WooCommerce saves a product's modified time
 *   on every save, a stock change included); a variable product changed has all its variations read,
 *   and products moved to the bin since are read too, and come in off sale (a full pass takes off sale
 *   whatever it no longer sees, the bin and products deleted for good alike). A variable product moved
 *   to the bin has its variations read too, and they come in off sale.
 * - **A page is small enough to read** whatever a store writes in its descriptions: 25 products a
 *   page (a page builder's description can be tens of kilobytes each), read up to 8 MB.
 * - **What it is** (ADR-029): its barcode from `global_unique_id` (WooCommerce's GTIN, UPC, EAN or
 *   ISBN field, since 9.2), checked when it is stored; its page (`permalink`); and the link to its
 *   first picture, a variation's own or else its product's. Each only when the store gives it.
 *
 * Endpoints: https://woocommerce.github.io/woocommerce-rest-api-docs/#list-all-products and
 * https://woocommerce.github.io/woocommerce-rest-api-docs/#list-all-product-variations (`per_page` at most 100).
 */

/** Products a page: a page builder's descriptions can be 100 KB each, and a page is read whole. */
export const PAGE_SIZE = 25;
/** Variations a page (WooCommerce's most): a variation's own description is short when it has one. */
const VARIATION_PAGE_SIZE = 100;
/** The most a page of products or variations is read up to. */
const PAGE_MAX_BYTES = 8 * 1024 * 1024;

const PRODUCT_FIELDS =
  "id,name,type,status,purchasable,sku,price,manage_stock,stock_quantity,stock_status,short_description,description,global_unique_id,permalink,images";
const VARIATION_FIELDS =
  "id,name,status,purchasable,sku,price,manage_stock,stock_quantity,stock_status,attributes,description,global_unique_id,permalink,image";

/** The longest link kept in a cursor: a product's picture, for its variations that have none of their own. */
const LINK_MAX = 2048;

/** Where a reading of the catalogue is: the next page of products, and the variable products still to read. */
interface Cursor {
  /** `all`: every product but the bin; `trash`: the bin, for a reading of what changed only. */
  readonly phase: "all" | "trash";
  /** The next page of products, or null once they are all listed. */
  readonly page: number | null;
  /**
   * Variable products whose variations are still to read: id, name, whether it is published, and the
   * link to its first picture when it has one.
   */
  readonly parents: readonly Parent[];
  /** The next page of the first parent's variations. */
  readonly vpage: number;
}

type Parent = readonly [number, string, 0 | 1] | readonly [number, string, 0 | 1, string];

const START: Cursor = { phase: "all", page: 1, parents: [], vpage: 1 };

function parseCursor(raw: string | null): Cursor {
  if (!raw) return START;
  try {
    const c = JSON.parse(raw) as Partial<Cursor>;
    const page = c.page === null ? null : Number(c.page);
    const parents = Array.isArray(c.parents)
      ? c.parents
          .filter((p) => Array.isArray(p) && Number.isInteger(p[0]) && typeof p[1] === "string")
          .map(
            (p): Parent =>
              typeof p[3] === "string" && p[3] && p[3].length <= LINK_MAX
                ? [Number(p[0]), String(p[1]).slice(0, 120), p[2] === 1 ? 1 : 0, p[3]]
                : [Number(p[0]), String(p[1]).slice(0, 120), p[2] === 1 ? 1 : 0],
          )
      : [];
    const vpage = Number(c.vpage);
    return {
      phase: c.phase === "trash" ? "trash" : "all",
      page: page === null || (Number.isInteger(page) && page >= 1) ? page : 1,
      parents,
      vpage: Number.isInteger(vpage) && vpage >= 1 ? vpage : 1,
    };
  } catch {
    return START;
  }
}

function encode(c: Cursor): string | null {
  return c.page === null && c.parents.length === 0 ? null : JSON.stringify(c);
}

type Raw = Record<string, unknown>;

function stockOf(p: Raw): number | null {
  const counted = p.manage_stock === true || p.manage_stock === "parent";
  if (counted && typeof p.stock_quantity === "number" && Number.isFinite(p.stock_quantity)) return p.stock_quantity;
  return p.stock_status === "outofstock" ? 0 : null;
}

function describe(p: Raw): string | null {
  const short = typeof p.short_description === "string" ? plain(p.short_description) : "";
  const long = typeof p.description === "string" ? plain(p.description) : "";
  const text = short || long;
  return text ? text.slice(0, 1_000) : null;
}

function priceOf(p: Raw, currency: string | null) {
  // A currency this inbox cannot take from a shop is never read: no price, so never on sale here.
  if (!currency || currencyRefusal(currency)) return null;
  const value = p.price === "" || p.price === null ? null : minorOf(p.price, currency);
  return value === null || value < 0 ? null : { value, currency };
}

function totalPages(headers: Headers): number {
  const n = Number(headers.get("x-wp-totalpages") ?? "");
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** One page of the store's catalogue: products, or the variations of the next variable product. */
async function page(
  ctx: RunContext,
  p: { readonly cursor: string | null; readonly since: number | null },
): Promise<{ readonly products: readonly CatalogueProduct[]; readonly cursor: string | null }> {
  const store = storeOf(ctx);
  const keys = keysOf(ctx);
  const currency = typeof ctx.extra.currency === "string" ? ctx.extra.currency : null;
  const c = parseCursor(p.cursor);
  const [parent, ...rest] = c.parents;
  if (parent) {
    const [id, parentName, published, parentImage] = parent;
    let answer: Awaited<ReturnType<typeof call>>;
    try {
      answer = await call(ctx.http, store, keys, "GET", `/wc/v3/products/${id}/variations`, {
        query: { per_page: VARIATION_PAGE_SIZE, page: c.vpage, orderby: "id", order: "asc", _fields: VARIATION_FIELDS },
        maxBytes: PAGE_MAX_BYTES,
      });
    } catch (error) {
      // Deleted for good since it was listed: its variations go off sale at the next full pass.
      if (error instanceof ConnectorError && error.code === "not_found") {
        return { products: [], cursor: encode({ ...c, parents: rest, vpage: 1 }) };
      }
      throw error;
    }
    const list = Array.isArray(answer.json) ? (answer.json as Raw[]) : [];
    const products = list
      .filter((v) => Number.isInteger(v.id))
      .map((v) => variationOf(v, parentName, published, currency, parentImage ?? null));
    const more = c.vpage < totalPages(answer.headers) && list.length > 0;
    const next: Cursor = more ? { ...c, vpage: c.vpage + 1 } : { ...c, parents: rest, vpage: 1 };
    return { products, cursor: encode(next) };
  }
  if (c.page === null) return { products: [], cursor: null };
  const trash = c.phase === "trash";
  let answer: Awaited<ReturnType<typeof call>>;
  try {
    answer = await call(ctx.http, store, keys, "GET", "/wc/v3/products", {
      query: {
        per_page: PAGE_SIZE,
        page: c.page,
        status: trash ? "trash" : "any",
        orderby: "id",
        order: "asc",
        _fields: PRODUCT_FIELDS,
        ...(p.since !== null ? { modified_after: isoGmt(p.since), dates_are_gmt: "true" } : {}),
      },
      maxBytes: PAGE_MAX_BYTES,
    });
  } catch (error) {
    // A store that will not list its bin is read without it: a full pass takes those off sale anyway.
    if (trash && error instanceof ConnectorError && error.code === "refused") return { products: [], cursor: null };
    throw error;
  }
  const list = Array.isArray(answer.json) ? (answer.json as Raw[]) : [];
  const products: CatalogueProduct[] = [];
  const parents: Parent[] = [...c.parents];
  for (const item of list) {
    if (!Number.isInteger(item.id)) continue;
    if (trash) {
      // In the bin: off sale, whatever it was; a variable one's variations are read next, off sale too.
      if (item.type === "variable") {
        const name = typeof item.name === "string" ? plain(item.name).slice(0, 120) : "";
        parents.push(parentOf(item, name, 0));
      } else if (item.type !== "grouped" && item.type !== "external") {
        products.push({ ...simpleOf(item, currency), available: false });
      }
      continue;
    }
    if (item.type === "variable") {
      const name = typeof item.name === "string" ? plain(item.name).slice(0, 120) : "";
      parents.push(parentOf(item, name, item.status === "publish" ? 1 : 0));
      continue;
    }
    // Grouped products are only a list of others, and external ones are sold elsewhere.
    if (item.type === "grouped" || item.type === "external") continue;
    products.push(simpleOf(item, currency));
  }
  const nextPage = c.page < totalPages(answer.headers) && list.length > 0 ? c.page + 1 : null;
  if (nextPage === null && !trash && p.since !== null) {
    // What changed: the bin next, once the variations still to read are read.
    return { products, cursor: encode({ phase: "trash", page: 1, parents, vpage: 1 }) };
  }
  return { products, cursor: encode({ phase: c.phase, page: nextPage, parents, vpage: 1 }) };
}

function simpleOf(p: Raw, currency: string | null): CatalogueProduct {
  const name = typeof p.name === "string" ? plain(p.name) : "";
  return {
    externalId: `p:${p.id}`,
    name: name || `Product ${p.id}`,
    description: describe(p),
    sku: typeof p.sku === "string" && p.sku.trim() ? p.sku.trim().slice(0, 100) : null,
    price: priceOf(p, currency),
    stock: stockOf(p),
    available: p.status === "publish" && p.purchasable === true,
    ...identityOf(p, firstImage(p)),
  };
}

/** A variable product as its variations are read after it: with its picture, for those that have none. */
function parentOf(p: Raw, name: string, published: 0 | 1): Parent {
  const image = firstImage(p);
  return image && image.length <= LINK_MAX ? [Number(p.id), name, published, image] : [Number(p.id), name, published];
}

/** The link to a product's first picture (`images[0].src`), when it has one. */
function firstImage(p: Raw): string | null {
  const [first] = Array.isArray(p.images) ? (p.images as { src?: unknown }[]) : [];
  return textOf(first?.src);
}

/** Its barcode, its page and its picture's link, each only when the store gives it. */
function identityOf(p: Raw, image: string | null): Pick<CatalogueProduct, "gtin" | "url" | "imageUrl"> {
  const barcode = textOf(p.global_unique_id);
  const url = textOf(p.permalink);
  return {
    ...(barcode ? { gtin: { raw: barcode, hint: "barcode" as const } } : {}),
    ...(url ? { url } : {}),
    ...(image ? { imageUrl: image } : {}),
  };
}

function textOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function variationOf(
  v: Raw,
  parentName: string,
  published: 0 | 1,
  currency: string | null,
  parentImage: string | null,
): CatalogueProduct {
  const options = Array.isArray(v.attributes)
    ? (v.attributes as { option?: unknown }[])
        .map((a) => (typeof a?.option === "string" ? plain(a.option) : ""))
        .filter(Boolean)
    : [];
  const own = typeof v.name === "string" ? plain(v.name) : "";
  const name = options.length > 0 ? `${parentName || own} – ${options.join(", ")}` : own || parentName;
  return {
    externalId: `v:${v.id}`,
    name: name || `Product ${v.id}`,
    description: describe(v),
    sku: typeof v.sku === "string" && v.sku.trim() ? v.sku.trim().slice(0, 100) : null,
    price: priceOf(v, currency),
    stock: stockOf(v),
    available: published === 1 && v.status === "publish" && v.purchasable === true,
    ...identityOf(v, textOf((v.image as { src?: unknown } | null | undefined)?.src) ?? parentImage),
  };
}

/** An instant as WooCommerce takes a GMT date: `2026-10-20T08:15:00`. */
export function isoGmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

export const catalogue: CatalogueReader = { page };
