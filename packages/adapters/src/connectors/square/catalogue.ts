import type { CatalogueProduct, CatalogueReader, RunContext } from "@surfingdog/core";
import { isAt, locationOf, presenceOf } from "./account";
import { arr, fromSquare, iso, obj, type SquareApi, str } from "./api";

/**
 * Square's items into the inbox's catalogue (ADR-030 §3, ADR-034): each variation of an item is one
 * product, keyed on its catalogue id, priced at the chosen location (its own price there when it has
 * one), in stock as Square counts it there, on sale while it is sold there and not archived, sold out
 * or hidden from Square Online. Services are bookings, not products, and are left out.
 *
 * A full pass reads every item (`SearchCatalogObjects`); a pass of what changed reads the items and
 * the variations changed since (`begin_time`, deleted ones too, each variation with its item), so a
 * variation taken off an item comes off sale within minutes; then the stock counts that changed since
 * (`updated_after`), whose variations are read back by id: a count that changes never changes the
 * catalogue's own version.
 *
 * - https://developer.squareup.com/docs/catalog-api/search-catalog-objects
 * - https://developer.squareup.com/reference/square/catalog-api/batch-retrieve-catalog-objects
 * - https://developer.squareup.com/reference/square/inventory-api/batch-retrieve-inventory-counts
 *
 * Prices are Square's in the currency's smallest unit, kept here in hundredths (`fromSquare`): exact
 * for a currency counted in hundredths and for one with no minor unit (¥12,800 is 1280000). One counted
 * in thousandths comes in with no price, and is kept off sale.
 *
 * What it is (ADR-029), each only when Square has it: its barcode from the variation's `upc` (the
 * dashboard's GTIN field, 12 to 14 digits), checked when it is stored; the link to its first picture,
 * the variation's own or else its item's (`image_ids`, read from the `CatalogImage` objects Square
 * sends beside them); and its page on Square Online (`ecom_uri`, deprecated and still answered).
 */

/** Items asked for in a page: fifty, each with every variation, its descriptions and its prices at each location. */
const ITEMS_PER_PAGE = 50;
/**
 * A page of items with many variations (sizes and colours) or many locations can pass the client's
 * usual 2 MB: read up to 8 MB, so a large catalogue never stops on one page.
 */
const PAGE_BYTES = 8 * 1024 * 1024;
/** Product types an agent can order; services, gift cards, donations and events are not. */
const ORDERABLE = new Set(["REGULAR", "FOOD_AND_BEV", "DIGITAL"]);
/** Square Online's own "not here" (`ecom_visibility`): the seller chose not to sell it online. */
const HIDDEN_ONLINE = new Set(["HIDDEN", "UNAVAILABLE"]);

type Obj = Record<string, unknown>;

export function catalogueReader(apiOf: (ctx: RunContext) => Promise<SquareApi>): CatalogueReader {
  return {
    async page(ctx, p) {
      const api = await apiOf(ctx);
      const location = locationOf(ctx);
      const phase = p.cursor?.startsWith("i:") ? "inventory" : "items";
      if (phase === "items") {
        const at = p.cursor?.startsWith("c:") ? p.cursor.slice(2) : null;
        const changed = p.since !== null;
        const read = await api.must(
          "POST",
          "/v2/catalog/search",
          "read your items",
          {
            // What changed: variations too, each with its item, since one taken off an item leaves no trace on it.
            object_types: changed ? ["ITEM", "ITEM_VARIATION"] : ["ITEM"],
            limit: ITEMS_PER_PAGE,
            // The objects the page names come too: a variation's item, and the pictures of both.
            include_related_objects: true,
            ...(changed ? { begin_time: iso(p.since ?? 0), include_deleted_objects: true } : {}),
            ...(at ? { cursor: at } : {}),
          },
          { maxBytes: PAGE_BYTES },
        );
        const objects = arr(read.objects);
        const items = objects.filter((o) => o.type === "ITEM");
        const parents = new Map(
          [...arr(read.related_objects), ...items]
            .filter((o) => o.type === "ITEM" && typeof o.id === "string")
            .map((o) => [String(o.id), o] as const),
        );
        // One product per variation: one read on its own (deleted, say) is newer than its item's list.
        const byId = new Map<string, { item: Obj; variation: Obj }>();
        for (const item of items) {
          for (const variation of arr(obj(item.item_data).variations))
            byId.set(String(variation.id), { item, variation });
        }
        for (const variation of objects.filter((o) => o.type === "ITEM_VARIATION")) {
          const item = parents.get(String(obj(variation.item_variation_data).item_id));
          if (item) byId.set(String(variation.id), { item, variation });
        }
        const products = await productsOf(api, [...byId.values()], location, imagesOf(read));
        const next = str(read.cursor);
        // A pass of what changed goes on to the stock counts that changed.
        return { products, cursor: next ? `c:${next}` : p.since !== null ? "i:" : null };
      }
      if (p.since === null) return { products: [], cursor: null };
      const at = p.cursor?.slice(2) || null;
      const counts = await api.must("POST", "/v2/inventory/counts/batch-retrieve", "read your stock", {
        location_ids: [location],
        updated_after: iso(p.since),
        states: ["IN_STOCK"],
        limit: ITEMS_PER_PAGE,
        ...(at ? { cursor: at } : {}),
      });
      const ids = [
        ...new Set(
          arr(counts.counts)
            .map((c) => str(c.catalog_object_id))
            .filter((x): x is string => x !== null),
        ),
      ];
      const next = str(counts.cursor);
      if (ids.length === 0) return { products: [], cursor: next ? `i:${next}` : null };
      const got = await api.must(
        "POST",
        "/v2/catalog/batch-retrieve",
        "read your items",
        { object_ids: ids, include_related_objects: true },
        { maxBytes: PAGE_BYTES },
      );
      const items = new Map(
        [...arr(got.related_objects), ...arr(got.objects)]
          .filter((o) => o.type === "ITEM" && typeof o.id === "string")
          .map((o) => [String(o.id), o] as const),
      );
      const pairs = arr(got.objects)
        .filter((o) => o.type === "ITEM_VARIATION")
        .map((variation) => ({ item: items.get(String(obj(variation.item_variation_data).item_id)), variation }))
        .filter((x): x is { item: Obj; variation: Obj } => x.item !== undefined);
      return { products: await productsOf(api, pairs, location, imagesOf(got)), cursor: next ? `i:${next}` : null };
    },
  };
}

/** The pictures an answer carries (`CatalogImage`), by id: the link to each. */
function imagesOf(answer: Obj): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const o of [...arr(answer.objects), ...arr(answer.related_objects)]) {
    const url = o.type === "IMAGE" && typeof o.id === "string" ? str(obj(o.image_data).url) : null;
    if (url) out.set(String(o.id), url);
  }
  return out;
}

/** The link to the first of `ids` the answer carries a picture for. */
function firstImage(ids: unknown, images: ReadonlyMap<string, string>): string | null {
  for (const id of Array.isArray(ids) ? ids : []) {
    const url = typeof id === "string" ? images.get(id) : undefined;
    if (url) return url;
  }
  return null;
}

/** Products for a page of item variations, their stock read at the location in one call. */
async function productsOf(
  api: SquareApi,
  pairs: readonly { readonly item: Obj; readonly variation: Obj }[],
  location: string,
  images: ReadonlyMap<string, string>,
): Promise<CatalogueProduct[]> {
  const kept = pairs.filter(({ item }) => {
    const type = str(obj(item.item_data).product_type);
    return type === null || ORDERABLE.has(type);
  });
  const tracked = kept
    .filter(({ variation }) => tracks(variation, location))
    .map(({ variation }) => String(variation.id));
  const stock = tracked.length > 0 ? await countsOf(api, tracked, location) : new Map<string, number>();
  const out: CatalogueProduct[] = [];
  for (const { item, variation } of kept) {
    const id = str(variation.id);
    if (!id) continue;
    const data = obj(item.item_data);
    const vd = obj(variation.item_variation_data);
    const siblings = arr(data.variations).filter((v) => v.is_deleted !== true).length;
    const itemName = str(data.name) ?? "Item";
    const variationName = str(vd.name);
    const name =
      variationName && (siblings > 1 || variationName.toLowerCase() !== "regular")
        ? `${itemName} · ${variationName}`
        : itemName;
    const here = overrideAt(vd, location);
    const price = priceOf(here.pricing_type ?? vd.pricing_type, here.price_money ?? vd.price_money);
    const visibility = str(data.ecom_visibility);
    const available =
      item.is_deleted !== true &&
      variation.is_deleted !== true &&
      data.is_archived !== true &&
      vd.sellable !== false &&
      here.sold_out !== true &&
      !(visibility && HIDDEN_ONLINE.has(visibility)) &&
      isAt(presenceOf(item, variation), location);
    const upc = str(vd.upc)?.trim();
    const imageUrl = firstImage(vd.image_ids, images) ?? firstImage(data.image_ids, images);
    const url = str(data.ecom_uri)?.trim();
    out.push({
      externalId: id,
      name: name.slice(0, 200),
      description: (str(data.description_plaintext) ?? plain(str(data.description)))?.slice(0, 5_000) ?? null,
      sku: str(vd.sku)?.slice(0, 100) ?? null,
      price,
      stock: tracks(variation, location) ? (stock.get(id) ?? 0) : null,
      available,
      ...(upc ? { gtin: { raw: upc, hint: "upc" as const } } : {}),
      ...(url ? { url } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    });
  }
  return out;
}

/** A variation's own settings at one location (`location_overrides`), or none. */
function overrideAt(vd: Obj, location: string): Obj {
  return arr(vd.location_overrides).find((o) => o.location_id === location) ?? {};
}

/** Whether Square counts this variation's stock at the location. */
function tracks(variation: Obj, location: string): boolean {
  const vd = obj(variation.item_variation_data);
  const here = overrideAt(vd, location);
  return (here.track_inventory ?? vd.track_inventory) === true;
}

/** A fixed price in hundredths, or none: a variable price is asked at the till, never guessed. */
function priceOf(pricing: unknown, money: unknown): CatalogueProduct["price"] {
  if (pricing === "VARIABLE_PRICING") return null;
  const m = obj(money);
  const currency = str(m.currency)?.toUpperCase();
  const value = currency ? fromSquare(m.amount, currency) : null;
  return currency && value !== null ? { value, currency } : null;
}

/** How many of each variation Square has in stock at the location (`IN_STOCK`), whole units. */
async function countsOf(api: SquareApi, ids: readonly string[], location: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const a = await api.must("POST", "/v2/inventory/counts/batch-retrieve", "read your stock", {
      catalog_object_ids: ids,
      location_ids: [location],
      states: ["IN_STOCK"],
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of arr(a.counts)) {
      const id = str(c.catalog_object_id);
      const n = Number(c.quantity);
      if (id && Number.isFinite(n)) out.set(id, Math.max(0, Math.floor(n)));
    }
    cursor = str(a.cursor);
    if (!cursor) break;
  }
  return out;
}

/** An item's description without its markup, for one written in Square's editor. */
function plain(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
