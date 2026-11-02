import type { Statement } from "@surfingdog/platform";
import { optionKeyOf } from "@surfingdog/spec";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  identityChanged,
  mergedIdentity,
  NEXT_CATALOGUE_SEQ,
  type SourceIdentity,
  type StoredIdentity,
} from "../catalogue/identity";
import { priceRecordStatement } from "../catalogue/v2";
import type { Db } from "../db";
import type { Money } from "../domain/types";
import { ulid } from "../ids";
import { productGroups, products } from "../schema/tables";

/**
 * The catalogue a feed or a shop sends in (ADR-015 §7.3, ADR-030 §3), written by one function so a
 * product feed and a shop connector keep the same rules:
 *
 * - **Upsert on `(source, external_id)`.** A source is the account the products come from (a feed's
 *   address, a shop's account), never a connection row: connecting the same shop again adopts its
 *   products instead of making a second copy of each.
 * - **The owner's fields are the owner's.** Withdrawal and negotiable are never written here.
 * - **Deactivated, never deleted**, when a complete pass no longer sees a product (`seen_at`): an
 *   order may point at it, and a deleted row takes that order's history with it.
 * - **A SKU already used by another product is dropped**, the product kept without it; a SKU the
 *   inbox keeps for itself (`RESERVED_SKUS`) is never written.
 * - **A missing price keeps the last one; with none at all the product is not on sale.** Never a
 *   currency guessed for it: a product with no price is kept inactive, in the business's own
 *   currency, until its source gives one.
 * - **Its barcode, brand, part number, condition and links (ADR-029) as the source gave them**,
 *   checked by `mergedIdentity`, and what it left out kept. A source never sets `no_gtin` or
 *   `listed`: those are the owner's.
 * - **Every write that changes what the signed catalogue feed shows moves `catalogue_seq`**
 *   (`NEXT_CATALOGUE_SEQ`); a product only marked seen keeps its place.
 * - **Variants stay variants** (catalogue version 2): rows that name one group (`variant.group`, a feed's
 *   `item_group_id`) are kept as one product group with each variant's options, never flattened, while
 *   the group holds as a reader reads it (`groupsThatHold`): every variant names the same option keys and
 *   no two are alike, at most 250. A group that does not hold comes in as products of their own. A batch
 *   that names no group at all leaves the groups as they are.
 */

/** One product as a source sends it in, with its identity (`SourceIdentity`) when the source gives one. */
export interface CatalogueRow extends SourceIdentity {
  readonly externalId: string;
  readonly name: string;
  readonly description: string | null;
  readonly sku: string | null;
  readonly price: Money | null;
  readonly stock: number | null;
  /** False takes it off sale; null when the source says nothing either way. */
  readonly available: boolean | null;
  /** The product group it is a variant of, and its options, when the source names one. */
  readonly variant?: {
    readonly group: string;
    readonly title?: string | undefined;
    readonly options: readonly { readonly key: string; readonly name: string; readonly value: string }[];
  };
}

/** A group of a batch, as it is kept: its id here, and each of its variants' place in it. */
interface KeptGroup {
  readonly id: string;
  readonly positions: ReadonlyMap<string, number>;
}

/** The longest run of whole words every name starts with: a group's title when the source gives none. */
function commonTitle(names: readonly string[]): string {
  const words = names.map((n) => n.split(/\s+/));
  const first = words[0] ?? [];
  let n = 0;
  while (n < first.length && words.every((w) => w[n] === first[n])) n++;
  const title = first
    .slice(0, n)
    .join(" ")
    .replace(/[\s,;:–—-]+$/, "")
    .trim();
  return (title || names[0] || "").slice(0, 150);
}

/**
 * The groups of a batch that hold as a reader of catalogue version 2 reads them (`readCatalogueGroups`):
 * every variant names the same option keys, each key by one name, no two variants alike, at most 250.
 */
function groupsThatHold(rows: readonly CatalogueRow[]): Map<string, CatalogueRow[]> {
  const byGroup = new Map<string, CatalogueRow[]>();
  for (const r of rows) {
    if (!r.variant) continue;
    const list = byGroup.get(r.variant.group) ?? [];
    list.push(r);
    byGroup.set(r.variant.group, list);
  }
  const keys = (r: CatalogueRow) =>
    (r.variant?.options ?? [])
      .map((o) => o.key)
      .sort()
      .join("\u0000");
  const values = (r: CatalogueRow) =>
    JSON.stringify(
      [...(r.variant?.options ?? [])].sort((a, b) => (a.key < b.key ? -1 : 1)).map((o) => [o.key, o.value]),
    );
  for (const [group, list] of byGroup) {
    const first = list[0] as CatalogueRow;
    const same = list.every((r) => keys(r) === keys(first));
    const distinct = new Set(list.map(values)).size === list.length;
    if (!same || !distinct || list.length > 250) byGroup.delete(group);
  }
  return byGroup;
}

/** Each group of the batch that holds, made or found under the source by its own id. */
async function keepGroups(
  db: Db,
  source: string,
  holding: ReadonlyMap<string, readonly CatalogueRow[]>,
  now: number,
): Promise<Map<string, KeptGroup>> {
  const out = new Map<string, KeptGroup>();
  if (!holding.size) return out;
  const existing = await db.orm
    .select({ id: productGroups.id, externalId: productGroups.externalId, title: productGroups.title })
    .from(productGroups)
    .where(eq(productGroups.source, source));
  const byExternal = new Map(existing.map((g) => [g.externalId, g]));
  const statements: Statement[] = [];
  for (const [group, list] of holding) {
    const title = list.find((r) => r.variant?.title)?.variant?.title ?? commonTitle(list.map((r) => r.name));
    const found = byExternal.get(group);
    const id = found?.id ?? ulid(now);
    if (!found) {
      statements.push({
        sql: `INSERT INTO product_groups (id, title, source, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (source, external_id) DO NOTHING`,
        params: [id, title, source, group, now, now],
        method: "run",
      });
    } else if (found.title !== title) {
      // A new title moves each variant in the feed, since each carries it.
      statements.push(
        {
          sql: "UPDATE product_groups SET title = ?, updated_at = ? WHERE id = ?",
          params: [title, now, id],
          method: "run",
        },
        {
          sql: `UPDATE products SET catalogue_seq = ${NEXT_CATALOGUE_SEQ}, updated_at = ? WHERE group_id = ?`,
          params: [now, id],
          method: "run",
        },
      );
    }
    out.set(group, { id, positions: new Map(list.map((r, i) => [r.externalId, i + 1])) });
  }
  for (const slice of chunks(statements, 40)) await db.batch(slice);
  // Two reads of one source at once: the group the other made is the one kept.
  const again = await db.orm
    .select({ id: productGroups.id, externalId: productGroups.externalId })
    .from(productGroups)
    .where(eq(productGroups.source, source));
  for (const g of again) {
    const kept = g.externalId ? out.get(g.externalId) : undefined;
    if (kept && g.externalId) out.set(g.externalId, { ...kept, id: g.id });
  }
  return out;
}

export interface CatalogueWrite {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Products kept off sale because their source gave no price, now or ever. */
  readonly priceless: number;
}

/** At most this many products come in from one connection; past it the owner is told once. */
export const MAX_CATALOGUE = 5_000;

/**
 * The SKU the inbox puts on an order line that is the shop's own charges (tax, delivery as the shop
 * counts them), which the customer accepted with the shop's total (ADR-030 §2). No source writes it.
 */
export const SHOP_CHARGES_SKU = "_shop_charges";

const RESERVED_SKUS: ReadonlySet<string> = new Set([SHOP_CHARGES_SKU]);

/** Where a connection's products come from: its kind and its account, so a reconnect adopts them. */
export function connectorSource(kind: string, externalId: string): string {
  return `connector:${kind}:${externalId}`;
}

/**
 * Writes one batch of products from a source: new ones inserted, changed ones updated, and every one
 * marked seen at `seenAt`, so a pass that ends can deactivate what it did not see (`deactivateUnseen`).
 * `currency` is the business's own, for a product that has never had a price.
 */
export async function upsertCatalogue(
  db: Db,
  p: {
    readonly source: string;
    readonly products: readonly CatalogueRow[];
    readonly now: number;
    readonly seenAt: number;
    readonly currency: string;
  },
): Promise<CatalogueWrite> {
  // The last word on a product within one batch wins: a source that lists it twice is not two products.
  const incoming = new Map<string, CatalogueRow>();
  for (const product of p.products) {
    if (product.externalId) incoming.set(product.externalId, product);
  }
  if (incoming.size === 0) return { created: 0, updated: 0, unchanged: 0, priceless: 0 };
  // Variants (catalogue version 2): only a batch that names a group says anything of groups.
  const managesGroups = [...incoming.values()].some((r) => r.variant);
  const groups = managesGroups
    ? await keepGroups(db, p.source, groupsThatHold([...incoming.values()]), p.now)
    : new Map();
  const placeOf = (r: CatalogueRow): { groupId: string | null; position: number | null; options: string | null } => {
    const g = r.variant ? groups.get(r.variant.group) : undefined;
    if (!g || !r.variant) return { groupId: null, position: null, options: null };
    const options = r.variant.options.map((o) => ({ key: optionKeyOf(o.key) ?? o.key, name: o.name, value: o.value }));
    return { groupId: g.id, position: g.positions.get(r.externalId) ?? null, options: JSON.stringify(options) };
  };
  const existing = await db.orm
    .select({
      id: products.id,
      externalId: products.externalId,
      name: products.name,
      description: products.description,
      price: products.price,
      stock: products.stock,
      active: products.active,
      sku: products.sku,
      gtin: products.gtin,
      gtinGiven: products.gtinGiven,
      brand: products.brand,
      mpn: products.mpn,
      condition: products.condition,
      url: products.url,
      imageUrl: products.imageUrl,
      sourceCategory: products.sourceCategory,
      groupId: products.groupId,
      groupPosition: products.groupPosition,
      options: products.options,
    })
    .from(products)
    .where(eq(products.source, p.source));
  const byExternal = new Map<string, (typeof existing)[number]>();
  for (const row of existing) if (row.externalId) byExternal.set(row.externalId, row);

  // A SKU is unique across the whole catalogue, so one spoken for by a product this source does not
  // own is not written: the product still comes in, without it.
  const takenSku = new Map<string, string>();
  const skuRows = await db.orm
    .select({ id: products.id, sku: products.sku })
    .from(products)
    .where(isNotNull(products.sku));
  for (const row of skuRows) if (row.sku) takenSku.set(row.sku, row.id);

  const statements: Statement[] = [];
  const seenOnly: string[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let priceless = 0;

  for (const product of incoming.values()) {
    const current = byExternal.get(product.externalId);
    const id = current?.id ?? ulid(p.now);
    const sku = skuFor(product.sku, id, takenSku);
    // Kept from the last time it had one: a source that leaves a price out has not made it free. A
    // stored price of nothing is the mark of a product that never had one, not a price.
    const kept = current?.price && current.price.value > 0 ? current.price : null;
    const price = product.price ?? kept;
    const active = product.available === false || price === null ? 0 : 1;
    if (price === null) priceless++;
    const stored = price ?? { value: 0, currency: (current?.price?.currency ?? p.currency).toUpperCase() };
    // What this read gives of its identity, and what it leaves out kept.
    const ident = mergedIdentity(current ?? null, product);

    if (!current) {
      statements.push({
        // ON CONFLICT, not a plain INSERT: two reads of one source at the same time both see an empty
        // catalogue; the unique index (migration 5) is what the loser updates against.
        sql: `INSERT INTO products (id, sku, name, description, price, stock, source, external_id, active,
                                    gtin, gtin_given, brand, mpn, condition, url, image_url, source_category,
                                    group_id, group_position, options,
                                    catalogue_seq, seen_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_CATALOGUE_SEQ}, ?, ?, ?)
              ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
              DO UPDATE SET name = excluded.name, description = excluded.description,
                            price = excluded.price, stock = excluded.stock, active = excluded.active,
                            gtin = excluded.gtin, gtin_given = excluded.gtin_given, brand = excluded.brand,
                            mpn = excluded.mpn, condition = excluded.condition, url = excluded.url,
                            image_url = excluded.image_url, source_category = excluded.source_category,
                            group_id = excluded.group_id, group_position = excluded.group_position,
                            options = excluded.options,
                            catalogue_seq = excluded.catalogue_seq, seen_at = excluded.seen_at,
                            updated_at = excluded.updated_at`,
        params: [
          id,
          sku,
          product.name,
          product.description,
          JSON.stringify(stored),
          product.stock,
          p.source,
          product.externalId,
          active,
          ...identityParams(ident),
          ...(() => {
            const place = placeOf(product);
            return [place.groupId, place.position, place.options];
          })(),
          p.seenAt,
          p.now,
          p.now,
        ],
        method: "run",
      });
      if (sku) takenSku.set(sku, id);
      created++;
      continue;
    }
    const place = managesGroups ? placeOf(product) : null;
    const moved =
      place !== null &&
      (place.groupId !== current.groupId ||
        place.position !== current.groupPosition ||
        place.options !== (current.options ? JSON.stringify(current.options) : null));
    if (!changed(current, product, stored, active, sku) && !identityChanged(current, ident) && !moved) {
      unchanged++;
      seenOnly.push(current.id);
      continue;
    }
    statements.push({
      sql: `UPDATE products SET sku = ?, name = ?, description = ?, price = ?, stock = ?, active = ?,
              gtin = ?, gtin_given = ?, brand = ?, mpn = ?, condition = ?, url = ?, image_url = ?, source_category = ?,
              ${place ? "group_id = ?, group_position = ?, options = ?," : ""}
              catalogue_seq = ${NEXT_CATALOGUE_SEQ}, seen_at = ?, updated_at = ?
             WHERE id = ?`,
      params: [
        sku,
        product.name,
        product.description,
        JSON.stringify(stored),
        product.stock,
        active,
        ...identityParams(ident),
        ...(place ? [place.groupId, place.position, place.options] : []),
        p.seenAt,
        p.now,
        id,
      ],
      method: "run",
    });
    if (sku) takenSku.set(sku, id);
    updated++;
  }
  // Seen and unchanged: only the mark moves, so the product is not taken for gone at the end of a pass.
  // Nothing the catalogue feed shows changed, so its place in that feed (`catalogue_seq`) stays.
  for (const chunk of chunks(seenOnly, 50)) {
    statements.push({
      sql: `UPDATE products SET seen_at = ? WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      params: [p.seenAt, ...chunk],
      method: "run",
    });
  }
  // D1 counts every statement of a batch against one invocation's budget: the writes go in slices.
  for (const slice of chunks(statements, 40)) await db.batch(slice);
  // The record of prices a "was" price is checked against: each price this batch wrote that is new.
  if (created + updated > 0) await db.batch([priceRecordStatement(p.now, { since: p.now })]);
  return { created, updated, unchanged, priceless };
}

/**
 * The end of a complete pass: what the source has that the pass did not see (marked seen before it
 * began, or never) is taken off sale. Answers how many. Never called after a pass that stopped short
 * (a feed cut at its size, a shop past `MAX_CATALOGUE`): not seen is not gone then.
 */
export async function deactivateUnseen(db: Db, source: string, before: number, now: number): Promise<number> {
  const r = await db.client.query({
    sql: `UPDATE products SET active = 0, catalogue_seq = ${NEXT_CATALOGUE_SEQ}, updated_at = ?
          WHERE source = ? AND active = 1 AND (seen_at IS NULL OR seen_at < ?)`,
    params: [now, source, before],
    method: "run",
  });
  return r.changes;
}

/** A source disconnected: every product it sent in is taken off sale, and kept for the orders that name it. */
export async function deactivateSource(db: Db, source: string, now: number): Promise<number> {
  const r = await db.client.query({
    sql: `UPDATE products SET active = 0, catalogue_seq = ${NEXT_CATALOGUE_SEQ}, updated_at = ? WHERE source = ? AND active = 1`,
    params: [now, source],
    method: "run",
  });
  return r.changes;
}

/** Products a source has on sale now. Through the ORM, so the count comes back as a number. */
export async function activeProducts(db: Db, source: string): Promise<number> {
  if (source === "") return 0;
  const [row] = await db.orm
    .select({ n: sql<number>`count(*)` })
    .from(products)
    .where(and(eq(products.source, source), eq(products.active, 1)));
  const n = Number(row?.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function skuFor(raw: string | null, id: string, taken: Map<string, string>): string | null {
  const sku = raw?.trim() ?? "";
  if (!sku || sku.length > 100 || RESERVED_SKUS.has(sku)) return null;
  const owner = taken.get(sku);
  return owner === undefined || owner === id ? sku : null;
}

function changed(
  current: {
    name: string;
    description: string | null;
    price: unknown;
    stock: number | null;
    active: number;
    sku: string | null;
  },
  product: CatalogueRow,
  price: unknown,
  active: number,
  sku: string | null,
): boolean {
  return (
    (current.sku ?? null) !== sku ||
    current.name !== product.name ||
    (current.description ?? null) !== product.description ||
    JSON.stringify(current.price ?? null) !== JSON.stringify(price ?? null) ||
    (current.stock ?? null) !== product.stock ||
    current.active !== active
  );
}

/** The identity columns in the order the statements above name them. */
function identityParams(i: StoredIdentity): (string | null)[] {
  return [i.gtin, i.gtinGiven, i.brand, i.mpn, i.condition, i.url, i.imageUrl, i.sourceCategory];
}

function* chunks<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}
