import { canonicalJson, sha256Text } from "../canonical";
import { minorUnits } from "../money";
import {
  CATALOGUE_DESCRIPTION_MAX,
  CATALOGUE_PAGE_MAX,
  type CatalogueItem,
  type CatalogueListedItem,
  catalogueItemSchema,
} from "./catalogue";
import { hasThreeDecimals, milli, type PoliciesRead, WEIGHT_UNITS } from "./catalogue-policies";
import {
  ageKindIsOff,
  CATALOGUE_GROUP_MAX,
  CATALOGUE_VERSIONS,
  type CatalogueListedItemV2,
  type CatalogueMoney,
  type CatalogueUnitPrice,
  catalogueListedItemV2Schema,
  catalogueWithdrawnItemV2Schema,
  WAS_PRICE_DAYS,
} from "./catalogue-v2";

/**
 * How a reader takes catalogue version 2 (protocol §4.18, as amended), the same on every side: what it
 * holds back, what it drops alone, how it reads a product group, a unit price and a "was" price, and the
 * version 1 page an inbox still serves to a reader of version 1. The vectors decide any difference:
 * `vectors/catalogue-options.json`, `catalogue-prices.json`, `catalogue-checks.json` and
 * `catalogue-v1.json`.
 */

/** What a problem does to the offer: hold it back, drop one or two of its fields, or read it as withdrawn. */
export type CatalogueProblemEffect = "hold" | "drop" | "withdrawn";

/**
 * Every problem a reader finds in one version 2 item: the code a network answers by (and a producer
 * reads), what it does, the fields it drops, and why, in words for the owner.
 */
export const CATALOGUE_V2_PROBLEMS = {
  unreadable: {
    effect: "hold",
    fields: [],
    words: "It does not read as catalogue version 2: a field is missing or not as the spec has it.",
  },
  currency_unknown: { effect: "hold", fields: [], words: "Its price is not in an ISO 4217 currency." },
  price_missing: { effect: "hold", fields: [], words: "It has no price, and its price is not on request." },
  price_with_quote: { effect: "hold", fields: [], words: "Its price is on request, yet it gives a price." },
  price_max_missing: { effect: "hold", fields: [], words: "Its price is a range with no top." },
  price_max_not_range: { effect: "hold", fields: [], words: "It gives a top price, and its price is not a range." },
  price_max_not_above: { effect: "hold", fields: [], words: "The top of its price range is not above the bottom." },
  currency_mismatch: { effect: "hold", fields: [], words: "The top of its price range is in another currency." },
  preorder_without_date: { effect: "hold", fields: [], words: "It is for pre-order with no date it comes out." },
  preorder_date_passed: {
    effect: "hold",
    fields: [],
    words: "It is for pre-order, and the date it comes out has passed.",
  },
  available_dates_order: { effect: "hold", fields: [], words: "It stops being available before it starts." },
  bundle_multipack: {
    effect: "hold",
    fields: [],
    words: "It is a bundle of different items and also a pack of identical ones.",
  },
  age_kind_off: {
    effect: "hold",
    fields: [],
    words: "Tobacco and nicotine, cannabis and weapons are kept off the network, ID check or not.",
  },
  available_until_passed: { effect: "withdrawn", fields: [], words: "The last day it could be ordered has passed." },
  list_price_not_fixed: {
    effect: "drop",
    fields: ["list_price"],
    words: "A 'was' price is shown only beside a fixed price.",
  },
  list_price_currency: { effect: "drop", fields: ["list_price"], words: "Its 'was' price is in another currency." },
  list_price_not_above: { effect: "drop", fields: ["list_price"], words: "Its 'was' price is not above its price." },
  unit_price_not_fixed: {
    effect: "drop",
    fields: ["unit_price"],
    words: "A unit price is given only beside a fixed price.",
  },
  unit_unknown: {
    effect: "drop",
    fields: ["unit_price"],
    words: "Its unit price names a unit the spec does not know.",
  },
  unit_mismatch: {
    effect: "drop",
    fields: ["unit_price"],
    words: "Its unit price measures in one kind of unit and prices per another.",
  },
  unit_measure: { effect: "drop", fields: ["unit_price"], words: "Its net quantity has more than three decimals." },
  available_from_unused: {
    effect: "drop",
    fields: ["available_from"],
    words: "A date it is available from is read only for a pre-order or a back-order.",
  },
  gtin_and_no_gtin: {
    effect: "drop",
    fields: ["no_gtin"],
    words: "It gives a barcode and says it has none: the barcode is kept.",
  },
  options_without_group: { effect: "drop", fields: ["options"], words: "It names options and no product group." },
  group_without_options: { effect: "drop", fields: ["group"], words: "It names a product group and no options." },
  option_key_twice: { effect: "drop", fields: ["group", "options"], words: "It names one option twice." },
  shipping_profile_unused: {
    effect: "drop",
    fields: ["shipping_profile"],
    words: "It names a shipping profile, and shipping is not one of the ways it reaches the buyer.",
  },
  shipping_profile_unknown: {
    effect: "drop",
    fields: ["shipping_profile"],
    words: "It names a shipping profile the policies document does not have.",
  },
  return_policy_unknown: {
    effect: "drop",
    fields: ["return_policy"],
    words: "It names a return policy the policies document does not have.",
  },
  weight_unit: {
    effect: "drop",
    fields: ["weight"],
    words: "Its weight is not in g, kg, oz or lb, or has more than three decimals.",
  },
} as const satisfies Record<string, { effect: CatalogueProblemEffect; fields: readonly string[]; words: string }>;
export type CatalogueProblem = keyof typeof CATALOGUE_V2_PROBLEMS;

/** One version 2 item as a reader takes it. */
export type CatalogueItemRead =
  | {
      readonly state: "listed";
      /** The item as kept: every field a problem dropped left out, its `hash` as it came. */
      readonly item: CatalogueListedItemV2;
      readonly dropped: readonly CatalogueProblem[];
    }
  | { readonly state: "held"; readonly id: string | null; readonly problems: readonly CatalogueProblem[] }
  | { readonly state: "withdrawn"; readonly id: string; readonly why: "withdrawn" | "available_until_passed" };

export interface CatalogueReadContext {
  /** The page's `as_of`: what a date is compared to. */
  readonly as_of: string;
  /** The policies document as read, when the manifest names one and it read; its ids are checked. */
  readonly policies?: PoliciesRead | null | undefined;
}

const ms = (iso: string) => Date.parse(iso);

/**
 * Reads one item of a version 2 page alone (`vectors/catalogue-checks.json`, `catalogue-prices.json`,
 * `catalogue-options.json`). A withdrawn item is withdrawn. A listed one that does not read is held
 * (`unreadable`); one past its `available_until` reads as withdrawn; one any `hold` problem of
 * `CATALOGUE_V2_PROBLEMS` finds is held, with every such problem named; otherwise it is listed, with
 * each field a `drop` problem names left out. Duplicate `fulfil_methods` are kept once.
 */
export function readCatalogueItemV2(raw: unknown, ctx: CatalogueReadContext): CatalogueItemRead {
  const gone = catalogueWithdrawnItemV2Schema.safeParse(raw);
  if (gone.success) return { state: "withdrawn", id: gone.data.id, why: "withdrawn" };
  const parsed = catalogueListedItemV2Schema.safeParse(raw);
  if (!parsed.success) {
    const id =
      raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
        ? (raw as { id: string }).id
        : null;
    return { state: "held", id, problems: ["unreadable"] };
  }
  const it = parsed.data;
  const asOf = ms(ctx.as_of);
  if (it.available_until !== undefined && ms(it.available_until) <= asOf)
    return { state: "withdrawn", id: it.id, why: "available_until_passed" };

  const hold: CatalogueProblem[] = [];
  if (it.price && minorUnits(it.price.currency) === null) hold.push("currency_unknown");
  if (it.price_model === "quote") {
    if (it.price !== null) hold.push("price_with_quote");
  } else if (it.price === null) hold.push("price_missing");
  if (it.price_max !== undefined && it.price_model !== "range") hold.push("price_max_not_range");
  if (it.price_model === "range") {
    if (it.price_max === undefined) hold.push("price_max_missing");
    else if (it.price && it.price_max.currency !== it.price.currency) hold.push("currency_mismatch");
    else if (it.price && it.price_max.value <= it.price.value) hold.push("price_max_not_above");
  }
  if (it.availability === "preorder") {
    if (it.available_from === undefined) hold.push("preorder_without_date");
    else if (ms(it.available_from) <= asOf) hold.push("preorder_date_passed");
  }
  if (
    it.available_from !== undefined &&
    it.available_until !== undefined &&
    ms(it.available_until) <= ms(it.available_from)
  )
    hold.push("available_dates_order");
  if (it.is_bundle && (it.multipack ?? 1) > 1) hold.push("bundle_multipack");
  if (it.age_restricted && ageKindIsOff(it.age_restricted.kind)) hold.push("age_kind_off");
  if (hold.length) return { state: "held", id: it.id, problems: hold };

  const dropped: CatalogueProblem[] = [];
  const out: Record<string, unknown> = { ...it };
  const drop = (code: CatalogueProblem) => {
    dropped.push(code);
    for (const f of CATALOGUE_V2_PROBLEMS[code].fields) {
      if (f === "no_gtin") out.no_gtin = false;
      else delete out[f];
    }
  };
  if (it.list_price !== undefined) {
    if (it.price_model !== "fixed" || !it.price) drop("list_price_not_fixed");
    else if (it.list_price.currency !== it.price.currency) drop("list_price_currency");
    else if (it.list_price.value <= it.price.value) drop("list_price_not_above");
  }
  if (it.unit_price !== undefined) {
    if (it.price_model !== "fixed" || !it.price) drop("unit_price_not_fixed");
    else {
      const u = unitPriceOf(it.price, it.unit_price);
      if ("problem" in u) drop(u.problem);
    }
  }
  if (it.available_from !== undefined && it.availability !== "preorder" && it.availability !== "backorder")
    drop("available_from_unused");
  if (it.gtin !== null && it.no_gtin) drop("gtin_and_no_gtin");
  if (it.options && !it.group) drop("options_without_group");
  else if (it.group && !it.options) drop("group_without_options");
  else if (it.options && new Set(it.options.map((o) => o.key)).size !== it.options.length) drop("option_key_twice");
  if (it.fulfil_methods) out.fulfil_methods = [...new Set(it.fulfil_methods)];
  if (it.shipping_profile !== undefined) {
    if (it.fulfil_methods && !it.fulfil_methods.includes("shipping")) drop("shipping_profile_unused");
    else if (ctx.policies && !ctx.policies.doc.shipping_profiles.some((p) => p.id === it.shipping_profile))
      drop("shipping_profile_unknown");
  }
  if (
    it.return_policy !== undefined &&
    ctx.policies &&
    !ctx.policies.doc.return_policies.some((p) => p.id === it.return_policy)
  )
    drop("return_policy_unknown");
  if (
    it.weight &&
    (!(WEIGHT_UNITS as readonly string[]).includes(it.weight.unit) || !hasThreeDecimals(it.weight.value))
  )
    drop("weight_unit");
  return { state: "listed", item: out as CatalogueListedItemV2, dropped };
}

/* --- product groups ------------------------------------------------------------------------------ */

export type CatalogueGroupProblem =
  | "group_title_differs"
  | "group_options_differ"
  | "group_option_name_differs"
  | "group_duplicate_variant"
  | "group_too_large";

/** One business's product group as a reader takes it. */
export interface CatalogueGroupRead {
  readonly id: string;
  /** The product's title: every variant's `group.title`, when they agree; else the first variant's. */
  readonly title: string;
  /** `grouped`: one product with these variants. `ungrouped`: each variant is a product of its own. */
  readonly state: "grouped" | "ungrouped";
  readonly problems: readonly CatalogueGroupProblem[];
  /** The variants in order (`position`, then id), at most `CATALOGUE_GROUP_MAX`. */
  readonly members: readonly string[];
  /** Variants past the 250th, held back (`group_too_large`). */
  readonly held: readonly string[];
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reads a business's product groups from its listed items, as a reader keeps them after
 * `readCatalogueItemV2` (`vectors/catalogue-options.json`). Every variant of a group must give the
 * same `group.title` (`group_title_differs`), name the same option keys (`group_options_differ`), give
 * each key the same name (`group_option_name_differs`) and differ from every other variant in at least
 * one value, compared exactly (`group_duplicate_variant`). A group with any of these is `ungrouped`:
 * each variant is read as a product of its own, and none is held. A group that holds is `grouped`, its
 * variants in order of `position` then id; past the 250th they are held (`group_too_large`). Groups come
 * in order of id.
 */
export function readCatalogueGroups(items: readonly CatalogueListedItemV2[]): CatalogueGroupRead[] {
  const groups = new Map<string, CatalogueListedItemV2[]>();
  for (const it of items) {
    if (!it.group || !it.options) continue;
    const list = groups.get(it.group.id) ?? [];
    list.push(it);
    groups.set(it.group.id, list);
  }
  const out: CatalogueGroupRead[] = [];
  for (const id of [...groups.keys()].sort(byCodeUnits)) {
    const list = (groups.get(id) as CatalogueListedItemV2[])
      .slice()
      .sort((a, b) => (a.group?.position ?? 0) - (b.group?.position ?? 0) || byCodeUnits(a.id, b.id));
    const first = list[0] as CatalogueListedItemV2;
    const problems: CatalogueGroupProblem[] = [];
    if (list.some((it) => it.group?.title !== first.group?.title)) problems.push("group_title_differs");
    const keysOf = (it: CatalogueListedItemV2) =>
      (it.options ?? [])
        .map((o) => o.key)
        .sort(byCodeUnits)
        .join("\u0000");
    if (list.some((it) => keysOf(it) !== keysOf(first))) problems.push("group_options_differ");
    else {
      const names = new Map<string, string>();
      let differs = false;
      for (const it of list)
        for (const o of it.options ?? []) {
          const n = names.get(o.key);
          if (n === undefined) names.set(o.key, o.name);
          else if (n !== o.name) differs = true;
        }
      if (differs) problems.push("group_option_name_differs");
      const seen = new Set<string>();
      for (const it of list) {
        const sig = JSON.stringify(
          (it.options ?? [])
            .slice()
            .sort((a, b) => byCodeUnits(a.key, b.key))
            .map((o) => [o.key, o.value]),
        );
        if (seen.has(sig)) {
          problems.push("group_duplicate_variant");
          break;
        }
        seen.add(sig);
      }
    }
    const title = first.group?.title ?? "";
    if (problems.length) {
      out.push({ id, title, state: "ungrouped", problems, members: list.map((it) => it.id), held: [] });
      continue;
    }
    const members = list.slice(0, CATALOGUE_GROUP_MAX).map((it) => it.id);
    const held = list.slice(CATALOGUE_GROUP_MAX).map((it) => it.id);
    out.push({ id, title, state: "grouped", problems: held.length ? ["group_too_large"] : [], members, held });
  }
  return out;
}

/* --- unit prices --------------------------------------------------------------------------------- */

/**
 * The units a unit price may name, each with its dimension and its size in that dimension's smallest
 * unit. A measure and its reference are in one dimension: metric and imperial are never mixed, so every
 * conversion is exact.
 */
export const UNIT_PRICE_UNITS: Readonly<Record<string, { readonly dimension: string; readonly factor: number }>> = {
  mg: { dimension: "mass_metric", factor: 1 },
  g: { dimension: "mass_metric", factor: 1000 },
  kg: { dimension: "mass_metric", factor: 1_000_000 },
  oz: { dimension: "mass_imperial", factor: 1 },
  lb: { dimension: "mass_imperial", factor: 16 },
  ml: { dimension: "volume_metric", factor: 1 },
  cl: { dimension: "volume_metric", factor: 10 },
  l: { dimension: "volume_metric", factor: 1000 },
  cbm: { dimension: "volume_metric", factor: 1_000_000 },
  cm: { dimension: "length_metric", factor: 1 },
  m: { dimension: "length_metric", factor: 100 },
  in: { dimension: "length_imperial", factor: 1 },
  ft: { dimension: "length_imperial", factor: 12 },
  yd: { dimension: "length_imperial", factor: 36 },
  sqm: { dimension: "area_metric", factor: 1 },
  sqft: { dimension: "area_imperial", factor: 1 },
  ct: { dimension: "count", factor: 1 },
};

/**
 * The price per reference quantity, in minor units of the price's currency (`vectors/catalogue-prices.json`
 * `unit_price`): price × reference ÷ measure, both in their dimension's smallest unit, rounded to the
 * nearest minor unit, a half up. 450 for 500 g is 900 per 1 kg; 199 for 330 ml is 603 per 1 l. The measure
 * is the whole offer as sold, so a pack of six 330 ml cans is 1980 ml.
 */
export function unitPriceOf(
  price: CatalogueMoney,
  up: CatalogueUnitPrice,
):
  | { readonly amount: number; readonly currency: string }
  | { readonly problem: "unit_unknown" | "unit_mismatch" | "unit_measure" } {
  const m = UNIT_PRICE_UNITS[up.measure.unit];
  const r = UNIT_PRICE_UNITS[up.reference.unit];
  if (!m || !r) return { problem: "unit_unknown" };
  if (m.dimension !== r.dimension) return { problem: "unit_mismatch" };
  if (!hasThreeDecimals(up.measure.value)) return { problem: "unit_measure" };
  const num = BigInt(price.value) * BigInt(up.reference.value) * BigInt(r.factor) * 1000n;
  const den = milli(up.measure.value) * BigInt(m.factor);
  return { amount: Number((2n * num + den) / (2n * den)), currency: price.currency };
}

/* --- "was" prices -------------------------------------------------------------------------------- */

/** One price an offer had, from `at` until the next one (the last, until now). */
export interface PricePoint {
  readonly at: string;
  readonly value: number;
}

const DAY_MS = 86_400_000;

/**
 * Whether a "was" price may be shown (`vectors/catalogue-prices.json` `was_price`), the EU's rule applied
 * everywhere: the offer's price now is below it, and for the whole of the 30 days before its price first
 * went below it (the start of the reduction, `since`), the offer was at or above it. `history` is every
 * price the reader recorded, in its currency, the price now last.
 * - `not_lower`: the price now is not below the "was" price;
 * - `history_short`: the record does not reach back 30 days before the reduction began;
 * - `sold_below`: within those 30 days, the offer was below it.
 * A further cut, the price still below it, keeps the reduction's start. A reader shows it only when its
 * own record says so, and a producer publishes it only when its own record does.
 */
export function wasPriceOf(input: {
  readonly list_price: number;
  readonly history: readonly PricePoint[];
}):
  | { readonly shown: true; readonly since: string }
  | { readonly shown: false; readonly why: "not_lower" | "history_short" | "sold_below" } {
  const h = input.history.slice().sort((a, b) => ms(a.at) - ms(b.at));
  const last = h.at(-1);
  if (!last || last.value >= input.list_price) return { shown: false, why: "not_lower" };
  let k = h.length - 1;
  while (k > 0 && (h[k - 1] as PricePoint).value < input.list_price) k--;
  const start = h[k] as PricePoint;
  const windowStart = ms(start.at) - WAS_PRICE_DAYS * DAY_MS;
  if (ms((h[0] as PricePoint).at) > windowStart) return { shown: false, why: "history_short" };
  for (let i = 0; i < k; i++) {
    const next = h[i + 1] as PricePoint;
    if (ms(next.at) > windowStart && (h[i] as PricePoint).value < input.list_price)
      return { shown: false, why: "sold_below" };
  }
  return { shown: true, since: start.at };
}

/* --- the hash ------------------------------------------------------------------------------------ */

/**
 * An item's `hash`: the first 16 hex digits of SHA-256 over its canonical JSON (`canonicalJson`), every
 * member it carries but `updated_at` and `hash`, members it does not carry absent. A reader that checks it
 * takes it over the item as it came, members it does not know included.
 */
export async function catalogueItemHash(item: Readonly<Record<string, unknown>>): Promise<string> {
  const { updated_at: _u, hash: _h, ...body } = item;
  return (await sha256Text(canonicalJson(body))).slice(0, 16);
}

/* --- version 1, from version 2 ------------------------------------------------------------------- */

const V1_AVAILABILITY: Readonly<Record<string, CatalogueListedItem["availability"]>> = {
  in_stock: "in_stock",
  limited: "in_stock",
  out_of_stock: "out_of_stock",
  on_sale: "on_sale",
};

/** A text cut to at most `max` UTF-16 code units, never through a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The version 1 item an inbox serves a reader of version 1 for a version 2 item (`vectors/catalogue-v1.json`),
 * for 12 months from the day it first serves version 2. Version 1 says only what it can say truly:
 * - an id over 64 characters has no version 1 item at all (null): it is left out of version 1 pages;
 * - withdrawn stays withdrawn;
 * - a listed item is withdrawn in version 1 when its price is not `fixed`, it is `preorder`,
 *   `backorder` or `made_to_order`, it is age-restricted, its `available_until` has passed, or its own
 *   `tax_included` differs from the catalogue's (when the catalogue says);
 * - otherwise it is listed with version 1's members: `limited` as `in_stock`, the description cut to
 *   1,000, `image_url` the first image of `media` (else null), `multipack` as it is, and its `hash` taken
 *   again over the version 1 item. Groups, options, the "was" and unit prices, shipping and returns are
 *   not in version 1: each variant is an offer of its own, by its own name.
 */
export async function catalogueItemV1Of(
  item: CatalogueListedItemV2 | { readonly id: string; readonly state: "withdrawn"; readonly updated_at: string },
  ctx: { readonly as_of: string; readonly tax_included: boolean | null },
): Promise<CatalogueItem | null> {
  if (item.id.length > 64) return null;
  const withdrawn = { id: item.id, state: "withdrawn" as const, updated_at: item.updated_at };
  if (item.state === "withdrawn") return withdrawn;
  const availability = V1_AVAILABILITY[item.availability];
  if (
    item.price_model !== "fixed" ||
    !item.price ||
    !availability ||
    item.age_restricted !== undefined ||
    (item.available_until !== undefined && ms(item.available_until) <= ms(ctx.as_of)) ||
    (item.tax_included !== undefined && ctx.tax_included !== null && item.tax_included !== ctx.tax_included)
  )
    return withdrawn;
  const image = item.media.find((m) => m.type === "image");
  const body: Omit<CatalogueListedItem, "updated_at" | "hash"> = {
    id: item.id,
    state: "listed",
    sku: item.sku,
    name: item.name,
    description: item.description === null ? null : cutText(item.description, CATALOGUE_DESCRIPTION_MAX),
    price: { value: item.price.value, currency: item.price.currency },
    availability,
    gtin: item.gtin,
    no_gtin: item.no_gtin,
    ...(item.multipack !== undefined ? { multipack: item.multipack } : {}),
    brand: item.brand,
    mpn: item.mpn,
    condition: item.condition,
    url: item.url,
    image_url: image ? image.url : null,
  };
  const v1 = { ...body, updated_at: item.updated_at, hash: await catalogueItemHash(body) };
  return catalogueItemSchema.parse(v1);
}

/* --- versions ------------------------------------------------------------------------------------ */

/** The catalogue versions a manifest's `catalogue` serves: its `versions`, else `[1]`. */
export function catalogueVersionsOf(
  catalogue: { readonly versions?: readonly number[] | undefined } | null | undefined,
): number[] {
  if (!catalogue) return [];
  const v = catalogue.versions?.length ? catalogue.versions : [1];
  return [...new Set(v)].sort((a, b) => a - b);
}

/**
 * The version a reader asks for: the highest it reads that the manifest lists, or null when they share
 * none. A reader always names it (`version=N`); a producer that lists only `[2]` answers a read without
 * one `422 version_required`.
 */
export function catalogueVersionToRead(
  catalogue: { readonly versions?: readonly number[] | undefined } | null | undefined,
  reads: readonly number[] = CATALOGUE_VERSIONS,
): number | null {
  const served = catalogueVersionsOf(catalogue);
  const both = served.filter((v) => reads.includes(v));
  return both.length ? (both.at(-1) as number) : null;
}

/** One page size: a reader asks `limit=500`; a producer gives at most that, and may give fewer on any page. */
export const CATALOGUE_PAGE_SIZE = CATALOGUE_PAGE_MAX;
