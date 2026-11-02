import {
  ageKindOf,
  CATALOGUE_GROUP_MAX,
  CATALOGUE_V2_PROBLEMS,
  type CatalogueOption,
  type CatalogueProblem,
  optionKeyOf,
  unitPriceOf,
} from "@surfingdog/spec";
import { and, eq, ne } from "drizzle-orm";
import type { UpdateProductInput } from "../capabilities/setup-types";
import type { Db } from "../db";
import { productGroups, products, returnPolicies, shippingProfiles } from "../schema/tables";
import { WriteError } from "../write/errors";
import { loadPolicies } from "./policies";
import { priceHistory, wasPriceRefusal } from "./v2";

/**
 * A product's catalogue version 2 fields as the owner writes them (`upsert_product`, `PATCH
 * /v1/owner/products/:id`): checked against the rest of the product as the write leaves it, so the inbox
 * stores only what its feed can publish whole, and refused otherwise with a code of `CATALOGUE_V2_PROBLEMS`
 * and its words. The money, age and policy fields are the owner's in person (`V2_OWNER_FIELDS`).
 */

type Row = typeof products.$inferSelect;

/**
 * The version 2 fields only the owner in person changes, never their AI and never a key handed to another
 * system: how a price is meant and what it is beside (money), the age (who may buy), how it reaches the
 * buyer and under which shipping and return terms (policy), and what is sold for the price.
 */
export const V2_OWNER_FIELDS = [
  "price_model",
  "price_max",
  "list_price",
  "unit_price",
  "tax_included",
  "availability",
  "available_from",
  "available_until",
  "few_left",
  "multipack",
  "is_bundle",
  "age_restricted",
  "fulfil_methods",
  "shipping_profile",
  "weight",
  "return_policy",
] as const;
type OwnerField = (typeof V2_OWNER_FIELDS)[number];

/** Each version 2 field's column, and how a value is kept. */
const COLUMN: Readonly<Record<OwnerField | "group_id" | "group_position" | "options" | "media", keyof Row>> = {
  group_id: "groupId",
  group_position: "groupPosition",
  options: "options",
  price_model: "priceModel",
  price_max: "priceMax",
  list_price: "listPrice",
  unit_price: "unitPrice",
  tax_included: "taxIncluded",
  availability: "availability",
  available_from: "availableFrom",
  available_until: "availableUntil",
  few_left: "fewLeft",
  multipack: "multipack",
  is_bundle: "isBundle",
  media: "media",
  age_restricted: "ageRestricted",
  fulfil_methods: "fulfilMethods",
  shipping_profile: "shippingProfileId",
  weight: "weight",
  return_policy: "returnPolicyId",
};

/** The SQL column of each (`patchRow` writes by column). */
const SQL_COLUMN: Readonly<Record<keyof typeof COLUMN, string>> = {
  group_id: "group_id",
  group_position: "group_position",
  options: "options",
  price_model: "price_model",
  price_max: "price_max",
  list_price: "list_price",
  unit_price: "unit_price",
  tax_included: "tax_included",
  availability: "availability",
  available_from: "available_from",
  available_until: "available_until",
  few_left: "few_left",
  multipack: "multipack",
  is_bundle: "is_bundle",
  media: "media",
  age_restricted: "age_restricted",
  fulfil_methods: "fulfil_methods",
  shipping_profile: "shipping_profile_id",
  weight: "weight",
  return_policy: "return_policy_id",
};

type V2Input = Pick<UpdateProductInput, keyof typeof COLUMN>;

/** A field's value as the row keeps it: times in milliseconds, booleans as 0 or 1, JSON as it is. */
function stored(key: keyof typeof COLUMN, value: unknown): unknown {
  if (value === null) return key === "is_bundle" ? 0 : key === "price_model" ? "fixed" : null;
  if (key === "available_from" || key === "available_until") return Date.parse(value as string);
  if (key === "tax_included" || key === "is_bundle") return value ? 1 : 0;
  if (key === "options") return (value as CatalogueOption[]).map((o) => ({ ...o, key: optionKeyOf(o.key) ?? o.key }));
  if (key === "fulfil_methods") return [...new Set(value as string[])].sort();
  if (key === "age_restricted") {
    const a = value as NonNullable<Row["ageRestricted"]>;
    return { ...a, kind: ageKindOf(a.kind) ?? a.kind };
  }
  if (key === "multipack") return (value as number) <= 1 ? null : value;
  return value;
}

/** The row as the write leaves it, for checking: what it sends over what is stored. */
export function mergedRow(base: Row, input: V2Input & { price?: Row["price"] | undefined }): Row {
  const out: Record<string, unknown> = { ...base };
  if (input.price !== undefined) out.price = input.price;
  for (const key of Object.keys(COLUMN) as (keyof typeof COLUMN)[]) {
    const v = input[key];
    if (v !== undefined) out[COLUMN[key]] = stored(key, v);
  }
  return out as Row;
}

/** The fields a write sets, by SQL column, for `patchRow`: undefined leaves one as it is. */
export function v2PatchColumns(input: V2Input): Record<string, string | number | null | undefined> {
  const out: Record<string, string | number | null | undefined> = {};
  for (const key of Object.keys(SQL_COLUMN) as (keyof typeof SQL_COLUMN)[]) {
    const v = input[key];
    if (v === undefined) continue;
    const s = stored(key, v);
    out[SQL_COLUMN[key]] = s === null ? null : typeof s === "object" ? JSON.stringify(s) : (s as string | number);
  }
  return out;
}

/** The same, as the ORM inserts them. */
export function v2InsertValues(input: V2Input): Partial<typeof products.$inferInsert> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(COLUMN) as (keyof typeof COLUMN)[]) {
    const v = input[key];
    if (v !== undefined) out[COLUMN[key]] = stored(key, v);
  }
  return out as Partial<typeof products.$inferInsert>;
}

/** The refusal of a version 2 field from anyone but the owner in person. */
export function v2Owners(path: string): WriteError {
  return new WriteError(
    "not_allowed",
    "How a price is meant, a 'was' or unit price, an age, how it reaches the buyer and its shipping and return terms are the owner's to set, signed in to the owner app. Tell the owner in a note (reply with internal: true) what you suggest.",
    {
      fields: [{ path, problem: "invalid", message: "only the owner in person changes this" }],
      details: { reason: "owner_in_person", ask_owner: true, where: "Products", draft_for_owner: true },
    },
  );
}

/** The owner-only fields a write from someone else would change: the first, or null. Writing one back as it is changes nothing. */
export function changedOwnerField(input: V2Input, base: Row | null): OwnerField | null {
  for (const key of V2_OWNER_FIELDS) {
    const v = input[key];
    if (v === undefined) continue;
    const want = stored(key, v);
    const was = base ? base[COLUMN[key]] : stored(key, null);
    if (JSON.stringify(want ?? null) !== JSON.stringify(was ?? null)) return key;
  }
  return null;
}

function refuse(code: CatalogueProblem | string, path: string, words?: string): never {
  const message = words ?? (CATALOGUE_V2_PROBLEMS as Record<string, { words: string }>)[code]?.words ?? code;
  throw new WriteError("invalid_input", message, {
    fields: [{ path, problem: "invalid", message: code }],
    details: { code },
  });
}

/**
 * Checks a product as the write leaves it, and answers the group position to keep, when it joins a group
 * without one. Each refusal names the code a network would hold or drop it for, so the inbox never stores
 * what its own feed would have to leave out: a price that does not hold together, a "was" price the 30-day
 * rule refuses by the inbox's own record, a unit price in units that do not convert, a pre-order with no
 * date, dates the wrong way round, a bundle that is also a pack, an age kind the vocabulary does not know,
 * a shipping profile or return policy there is none of, or a variant its group's other variants do not
 * agree with (`readCatalogueGroups`).
 */
export async function checkProductV2(
  db: Db,
  row: Row,
  now: number,
  input: V2Input & { price?: unknown },
): Promise<{ groupPosition?: number }> {
  const model = row.priceModel;
  if (!["fixed", "from", "range", "quote"].includes(model)) refuse("unreadable", "price_model");
  if (model !== "quote" && !(row.price.value > 0)) {
    refuse(
      "price_missing",
      "price",
      "A listed price is at least 1 minor unit: price it, or make its price on request (price_model quote).",
    );
  }
  if (model === "range") {
    if (!row.priceMax) refuse("price_max_missing", "price_max");
    if (row.priceMax.currency.toUpperCase() !== row.price.currency.toUpperCase())
      refuse("currency_mismatch", "price_max");
    if (row.priceMax.value <= row.price.value) refuse("price_max_not_above", "price_max");
  } else if (row.priceMax && input.price_max !== undefined) refuse("price_max_not_range", "price_max");
  if (
    row.listPrice &&
    (input.list_price !== undefined || input.price !== undefined || input.price_model !== undefined)
  ) {
    const history = (await priceHistory(db, [row.id])).get(row.id) ?? [];
    const why = wasPriceRefusal({ ...row, updatedAt: now }, history);
    // A price that rises back to its "was" price leaves the "was" price unshown, never refuses the price.
    if (why && !(why === "list_price_not_above" && input.list_price === undefined)) refuse(why, "list_price");
  }
  if (row.unitPrice && input.unit_price !== undefined) {
    if (model !== "fixed") refuse("unit_price_not_fixed", "unit_price");
    const u = unitPriceOf({ value: Math.max(1, row.price.value), currency: row.price.currency }, row.unitPrice);
    if ("problem" in u) refuse(u.problem, "unit_price");
  }
  if (row.availability !== null && !["preorder", "backorder", "made_to_order"].includes(row.availability)) {
    refuse("unreadable", "availability");
  }
  if (row.availability === "preorder" && (input.availability !== undefined || input.available_from !== undefined)) {
    if (row.availableFrom === null) refuse("preorder_without_date", "available_from");
    if (row.availableFrom <= now) refuse("preorder_date_passed", "available_from");
  }
  if (row.availableFrom !== null && row.availableUntil !== null && row.availableUntil <= row.availableFrom) {
    refuse("available_dates_order", "available_until");
  }
  if (row.isBundle === 1 && (row.multipack ?? 1) > 1) refuse("bundle_multipack", "is_bundle");
  if (row.ageRestricted && ageKindOf(row.ageRestricted.kind) === null)
    refuse("age_kind_unknown", "age_restricted.kind");
  if (row.shippingProfileId && input.shipping_profile !== undefined) {
    const [p] = await db.orm
      .select({ id: shippingProfiles.id })
      .from(shippingProfiles)
      .where(eq(shippingProfiles.id, row.shippingProfileId));
    if (!p) refuse("shipping_profile_unknown", "shipping_profile");
  }
  if (row.returnPolicyId && input.return_policy !== undefined) {
    const [p] = await db.orm
      .select({ id: returnPolicies.id })
      .from(returnPolicies)
      .where(eq(returnPolicies.id, row.returnPolicyId));
    // An inbox whose table is empty has the standard policy all the same.
    const known = p || (await loadPolicies(db)).return_policies.some((r) => r.id === row.returnPolicyId);
    if (!known) refuse("return_policy_unknown", "return_policy");
  }
  return checkGroup(db, row, input);
}

/** A variant against its group's other variants: the same option keys, each by one name, and no two alike. */
async function checkGroup(db: Db, row: Row, input: V2Input): Promise<{ groupPosition?: number }> {
  const touched = input.group_id !== undefined || input.options !== undefined || input.group_position !== undefined;
  if (!touched || !row.groupId) return {};
  const [group] = await db.orm
    .select({ id: productGroups.id })
    .from(productGroups)
    .where(eq(productGroups.id, row.groupId));
  if (!group)
    refuse("group_unknown", "group_id", "There is no such product group: make it first (upsert_product_group).");
  if (!row.options?.length) refuse("group_without_options", "options");
  const keys = row.options.map((o) => o.key);
  if (new Set(keys).size !== keys.length) refuse("option_key_twice", "options");
  const others = await db.orm
    .select({ options: products.options, position: products.groupPosition })
    .from(products)
    .where(and(eq(products.groupId, row.groupId), ne(products.id, row.id), eq(products.active, 1)));
  if (others.length >= CATALOGUE_GROUP_MAX) refuse("group_too_large", "group_id");
  const sig = (o: readonly CatalogueOption[]) =>
    JSON.stringify([...o].sort((a, b) => (a.key < b.key ? -1 : 1)).map((x) => x.key));
  const values = (o: readonly CatalogueOption[]) =>
    JSON.stringify([...o].sort((a, b) => (a.key < b.key ? -1 : 1)).map((x) => [x.key, x.value]));
  for (const other of others) {
    const o = other.options ?? [];
    if (sig(o) !== sig(row.options)) refuse("group_options_differ", "options");
    for (const opt of o) {
      const mine = row.options.find((x) => x.key === opt.key);
      if (mine && mine.name !== opt.name) refuse("group_option_name_differs", `options`);
    }
    if (values(o) === values(row.options)) refuse("group_duplicate_variant", "options");
  }
  // A position the owner gives, or one it already has, is kept; one joining with none comes in last.
  if (input.group_position !== undefined || row.groupPosition !== null) return {};
  const next = Math.max(0, ...others.map((o) => o.position ?? 0)) + 1;
  return { groupPosition: next };
}
