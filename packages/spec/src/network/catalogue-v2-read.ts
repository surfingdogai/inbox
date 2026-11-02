import { z } from "zod";
import { canonicalJson, sha256Text } from "../canonical";
import { minorUnits } from "../money";
import {
  CATALOGUE_DESCRIPTION_MAX,
  CATALOGUE_PAGE_MAX,
  type CatalogueItem,
  type CatalogueListedItem,
  catalogueItemSchema,
} from "./catalogue";
import { hasThreeDecimals, milli, type PoliciesRead, profileChecksId, WEIGHT_UNITS } from "./catalogue-policies";
import { CATALOGUE_V2_PROBLEMS, type CatalogueProblem, inRegistryOrder } from "./catalogue-problems";
import {
  AGE_KINDS_OFF,
  ageKindOf,
  CATALOGUE_GROUP_MAX,
  CATALOGUE_MEDIA_MAX,
  CATALOGUE_VERSIONS,
  type CatalogueListedItemV2,
  type CatalogueMoney,
  type CatalogueUnitPrice,
  catalogueListedItemV2Schema,
  catalogueMediaSchema,
  catalogueUrlSchema,
  catalogueWithdrawnItemV2Schema,
  optionKeyOf,
  WAS_PRICE_DAYS,
} from "./catalogue-v2";

/**
 * How a reader takes catalogue version 2 (protocol §4.18, as amended), the same on every side: what it
 * holds back, what it drops alone, how it reads a product group, a unit price and a "was" price, and the
 * version 1 page a producer still serves to a reader of version 1. The vectors decide any difference:
 * `vectors/catalogue-options.json`, `catalogue-prices.json`, `catalogue-checks.json` and
 * `catalogue-v1.json`. Every code is in `CATALOGUE_V2_PROBLEMS` (`catalogue-problems.ts`).
 */

/** One version 2 item as a reader takes it. */
export type CatalogueItemRead =
  | {
      readonly state: "listed";
      /**
       * The item as kept: each member a problem dropped left out (or set to its none), option keys and an
       * age's kind read through their vocabularies, `fulfil_methods` once each, its `hash` as it came.
       */
      readonly item: CatalogueListedItemV2;
      readonly dropped: readonly CatalogueProblem[];
    }
  | {
      readonly state: "held";
      readonly id: string | null;
      readonly problems: readonly CatalogueProblem[];
      /** With `unreadable`: a JSON Pointer (RFC 6901) to the first member that does not read. */
      readonly path?: string;
    }
  | { readonly state: "withdrawn"; readonly id: string; readonly why: "withdrawn" | "available_until_passed" };

export interface CatalogueReadContext {
  /** The page's `as_of`: what a date is compared to. */
  readonly as_of: string;
  /**
   * The policies document the reader holds for the source, as read (`readCataloguePolicies`), or null when
   * it holds none: then no profile or policy id is checked and no default applies, the offer's shipping
   * and returns are not known, and the reader checks the ids again when it reads one.
   */
  readonly policies?: PoliciesRead | null | undefined;
  /**
   * The registrable domains (by the Public Suffix List) of the business's own site: its member domain's
   * and its website's. An item's `url` on another host is dropped (`url_off_site`). Absent, not checked.
   */
  readonly site?: readonly string[] | undefined;
}

const ms = (iso: string) => Date.parse(iso);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A path of zod's as a JSON Pointer (RFC 6901): `["media", 3, "url"]` is `/media/3/url`. */
function pointer(path: readonly PropertyKey[]): string {
  return path.map((seg) => `/${String(seg).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/**
 * The members that only add to an offer: one that does not read is dropped alone (set to its none where the
 * schema needs it), with its code, and the offer is listed. Every other member is the offer's core: one of
 * those that does not read holds the offer (`unreadable`, with its path).
 */
const NULLABLE: ReadonlyArray<readonly [string, z.ZodType, CatalogueProblem]> = [
  ["sku", catalogueListedItemV2Schema.shape.sku, "sku_dropped"],
  ["description", catalogueListedItemV2Schema.shape.description, "description_dropped"],
  ["gtin", catalogueListedItemV2Schema.shape.gtin, "gtin_dropped"],
  ["brand", catalogueListedItemV2Schema.shape.brand, "brand_dropped"],
  ["mpn", catalogueListedItemV2Schema.shape.mpn, "mpn_dropped"],
  ["url", catalogueUrlSchema.nullable(), "url_dropped"],
];
const OPTIONAL: ReadonlyArray<readonly [string, z.ZodType, CatalogueProblem]> = [
  ["list_price", catalogueListedItemV2Schema.shape.list_price, "list_price_dropped"],
  ["unit_price", catalogueListedItemV2Schema.shape.unit_price, "unit_price_dropped"],
  ["weight", catalogueListedItemV2Schema.shape.weight, "weight_dropped"],
  ["withdrawal", catalogueListedItemV2Schema.shape.withdrawal, "withdrawal_dropped"],
];
const LENIENT = [...NULLABLE, ...OPTIONAL].map(([k]) => k).concat(["no_gtin", "media", "group", "options"]);
const coreSchema = catalogueListedItemV2Schema.extend(
  Object.fromEntries(LENIENT.map((k) => [k, z.unknown().optional()])),
);
const groupSchema = catalogueListedItemV2Schema.shape.group;
const optionsSchema = catalogueListedItemV2Schema.shape.options;

function onSite(url: string, site: readonly string[]): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return site.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Reads one item of a version 2 page alone (`vectors/catalogue-checks.json`, `catalogue-prices.json`,
 * `catalogue-options.json`). A withdrawn item is withdrawn. A listed one whose core does not read is held
 * (`unreadable`, with a JSON Pointer to the first member that does not, in the order the schema lists
 * them); one past its `available_until` reads as withdrawn; one any `hold` problem finds is held, with
 * every such problem named; otherwise it is listed, each member a `drop` problem names left out or set to
 * its none, option keys and an age's kind read through their vocabularies (`colour` is `color`, `vape` is
 * `tobacco_nicotine`), and `fulfil_methods` once each. Problems and drops come each once, in the order
 * `CATALOGUE_V2_PROBLEMS` lists them.
 */
export function readCatalogueItemV2(raw: unknown, ctx: CatalogueReadContext): CatalogueItemRead {
  const rawId = isObject(raw) && typeof raw.id === "string" ? raw.id : null;
  const unreadable = (path: readonly PropertyKey[]): CatalogueItemRead => ({
    state: "held",
    id: rawId,
    problems: ["unreadable"],
    path: pointer(path),
  });
  if (!isObject(raw)) return unreadable([]);
  if (raw.state === "withdrawn") {
    const gone = catalogueWithdrawnItemV2Schema.safeParse(raw);
    if (!gone.success) return unreadable(gone.error.issues[0]?.path ?? []);
    return { state: "withdrawn", id: gone.data.id, why: "withdrawn" };
  }
  const core = coreSchema.safeParse(raw);
  if (!core.success) return unreadable(core.error.issues[0]?.path ?? []);
  const asOf = ms(ctx.as_of);
  const c = core.data as unknown as CatalogueListedItemV2;
  if (c.available_until !== undefined && ms(c.available_until) <= asOf)
    return { state: "withdrawn", id: c.id, why: "available_until_passed" };

  const dropped: CatalogueProblem[] = [];
  const out: Record<string, unknown> = { ...core.data };
  for (const [key, schema, code] of NULLABLE) {
    const r = schema.safeParse(raw[key]);
    if (r.success) out[key] = r.data;
    else {
      out[key] = null;
      dropped.push(code);
    }
  }
  for (const [key, schema, code] of OPTIONAL) {
    delete out[key];
    if (raw[key] === undefined) continue;
    const r = schema.safeParse(raw[key]);
    if (r.success) out[key] = r.data;
    else {
      delete out[key];
      dropped.push(code);
    }
  }
  if (typeof raw.no_gtin === "boolean") out.no_gtin = raw.no_gtin;
  else {
    out.no_gtin = false;
    dropped.push("no_gtin_dropped");
  }
  if (!Array.isArray(raw.media)) {
    out.media = [];
    dropped.push("media_dropped");
  } else {
    const media: unknown[] = [];
    for (const m of raw.media) {
      const r = catalogueMediaSchema.safeParse(m);
      if (r.success) media.push(r.data);
      else {
        const bare =
          isObject(m) && m.alt !== undefined ? catalogueMediaSchema.safeParse({ ...m, alt: undefined }) : null;
        if (bare?.success) {
          const { alt: _a, ...rest } = bare.data;
          media.push(rest);
          dropped.push("media_alt_dropped");
        } else dropped.push("media_entry_dropped");
      }
    }
    if (media.length > CATALOGUE_MEDIA_MAX) dropped.push("media_entry_dropped");
    out.media = media.slice(0, CATALOGUE_MEDIA_MAX);
  }
  const group = raw.group === undefined ? null : groupSchema.safeParse(raw.group);
  const options = raw.options === undefined ? null : optionsSchema.safeParse(raw.options);
  delete out.group;
  delete out.options;
  if ((group && !group.success) || (options && !options.success)) dropped.push("group_dropped");
  else {
    if (group?.success && group.data) out.group = group.data;
    if (options?.success && options.data)
      out.options = options.data.map((o) => ({ ...o, key: optionKeyOf(o.key) ?? o.key }));
  }
  const it = out as CatalogueListedItemV2;

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
  const methods = it.fulfil_methods ? [...new Set(it.fulfil_methods)] : undefined;
  const ships = methods === undefined || methods.includes("shipping");
  if (it.age_restricted) {
    const kind = ageKindOf(it.age_restricted.kind);
    if (kind === null) hold.push("age_kind_unknown");
    else if (AGE_KINDS_OFF.includes(kind)) hold.push("age_kind_off");
    else out.age_restricted = { ...it.age_restricted, kind };
  }
  const doc = ctx.policies ?? null;
  const profile =
    doc && ships
      ? doc.doc.shipping_profiles.find((p) => p.id === (it.shipping_profile ?? doc.default_shipping_profile))
      : undefined;
  if (doc && ships && it.shipping_profile !== undefined && !profile) hold.push("shipping_profile_unknown");
  if (doc && it.return_policy !== undefined && !doc.doc.return_policies.some((p) => p.id === it.return_policy))
    hold.push("return_policy_unknown");
  const ageUnchecked =
    it.age_restricted !== undefined && methods?.includes("shipping") && profile && !profileChecksId(profile);
  if (ageUnchecked && methods?.length === 1) hold.push("age_shipping_only_unchecked");
  if (hold.length) return { state: "held", id: it.id, problems: inRegistryOrder(hold) };

  const dropMembers = (code: CatalogueProblem) => {
    dropped.push(code);
    for (const f of CATALOGUE_V2_PROBLEMS[code].fields) delete out[f];
  };
  if (it.list_price !== undefined) {
    if (it.price_model !== "fixed" || !it.price) dropMembers("list_price_not_fixed");
    else if (it.list_price.currency !== it.price.currency) dropMembers("list_price_currency");
    else if (it.list_price.value <= it.price.value) dropMembers("list_price_not_above");
  }
  if (it.unit_price !== undefined) {
    if (it.price_model !== "fixed" || !it.price) dropMembers("unit_price_not_fixed");
    else {
      const u = unitPriceOf(it.price, it.unit_price);
      if ("problem" in u) dropMembers(u.problem);
    }
  }
  if (it.available_from !== undefined && it.availability !== "preorder" && it.availability !== "backorder")
    dropMembers("available_from_unused");
  if (it.gtin !== null && it.no_gtin) {
    dropped.push("gtin_and_no_gtin");
    out.no_gtin = false;
  }
  if (it.options && !it.group) dropMembers("options_without_group");
  else if (it.group && !it.options) dropMembers("group_without_options");
  else if (it.options && new Set(it.options.map((o) => o.key)).size !== it.options.length)
    dropMembers("option_key_twice");
  if (it.url && ctx.site && !onSite(it.url, ctx.site)) {
    dropped.push("url_off_site");
    out.url = null;
  }
  if (methods) out.fulfil_methods = methods;
  if (it.shipping_profile !== undefined && methods && !methods.includes("shipping"))
    dropMembers("shipping_profile_unused");
  if (ageUnchecked) {
    dropped.push("age_shipping_unchecked");
    delete out.shipping_profile;
    out.fulfil_methods = (methods ?? []).filter((m) => m !== "shipping");
  }
  if (
    it.weight &&
    (!(WEIGHT_UNITS as readonly string[]).includes(it.weight.unit) || !hasThreeDecimals(it.weight.value))
  )
    dropMembers("weight_unit");
  return { state: "listed", item: out as CatalogueListedItemV2, dropped: inRegistryOrder(dropped) };
}

/* --- product groups ------------------------------------------------------------------------------ */

/** A product group's problems: the `group_` codes of `CATALOGUE_V2_PROBLEMS`. */
export type CatalogueGroupProblem = Extract<
  CatalogueProblem,
  | "group_title_differs"
  | "group_options_differ"
  | "group_option_name_differs"
  | "group_duplicate_variant"
  | "group_too_large"
>;

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
 * `readCatalogueItemV2`, option keys read through `vocab/option-keys.json` (`vectors/catalogue-options.json`).
 * Every variant of a group must give the
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

/** Why a "was" price is not shown: the code a reader drops `list_price` with. */
export type WasPriceWhy = Extract<
  CatalogueProblem,
  "list_price_not_above" | "list_price_never_seen" | "list_price_history_short" | "list_price_sold_below"
>;

/**
 * Whether a "was" price may be shown (`vectors/catalogue-prices.json` `was_price`), the EU's rule applied
 * everywhere: the offer's price now is below it, and for the whole of the 30 days before its price first
 * went below it (the start of the reduction, `since`), the offer was at or above it. `history` is every
 * price the reader recorded, in its currency, the price now last. When it is not shown, `why` is the code
 * a reader drops `list_price` with:
 * - `list_price_not_above`: the price now is not below the "was" price;
 * - `list_price_never_seen`: the record holds no price at or above it (none at all, or a reduction already
 *   running when the record began, or a price it never had): the start of this reduction is not known;
 * - `list_price_history_short`: the record begins less than 30 days before the reduction began;
 * - `list_price_sold_below`: within those 30 days, the offer was below it.
 * None of the last three passes with time: the reduction's start and the record's are fixed, so it is
 * shown only for a later reduction, from a price held at or above it for 30 days. A further cut, the price
 * still below it, keeps the reduction's start. A reader shows it only when its own record says so, and a
 * producer publishes it only when its own record does.
 */
export function wasPriceOf(input: {
  readonly list_price: number;
  readonly history: readonly PricePoint[];
}): { readonly shown: true; readonly since: string } | { readonly shown: false; readonly why: WasPriceWhy } {
  const h = input.history.slice().sort((a, b) => ms(a.at) - ms(b.at));
  const last = h.at(-1);
  if (!last) return { shown: false, why: "list_price_never_seen" };
  if (last.value >= input.list_price) return { shown: false, why: "list_price_not_above" };
  let k = h.length - 1;
  while (k > 0 && (h[k - 1] as PricePoint).value < input.list_price) k--;
  if (k === 0) return { shown: false, why: "list_price_never_seen" };
  const start = h[k] as PricePoint;
  const windowStart = ms(start.at) - WAS_PRICE_DAYS * DAY_MS;
  if (ms((h[0] as PricePoint).at) > windowStart) return { shown: false, why: "list_price_history_short" };
  for (let i = 0; i < k; i++) {
    const next = h[i + 1] as PricePoint;
    if (ms(next.at) > windowStart && (h[i] as PricePoint).value < input.list_price)
      return { shown: false, why: "list_price_sold_below" };
  }
  return { shown: true, since: start.at };
}

/* --- the hash ------------------------------------------------------------------------------------ */

/**
 * An item's `hash`: the first 16 hex digits of SHA-256 over its canonical JSON (`canonicalJson`), every
 * member it carries but `updated_at` and `hash`, members it does not carry absent. A reader that checks it
 * takes it over the item as it came (parsed: numbers by their value), members it does not know included.
 * A reader never holds an item for its hash: one that does not match is told (`hash_mismatch`, a warning),
 * and the reader keeps its own for knowing what changed.
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

/** A text cut to at most `max` characters: Unicode code points, as every limit counts them, never half of one. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/**
 * The version 1 item a producer serves a reader of version 1 for a version 2 item (`vectors/catalogue-v1.json`),
 * for 12 months from the day it first serves version 2, when it served version 1 before. Version 1 says
 * only what it can say truly:
 * - an id over 64 characters has no version 1 item at all (null): it is left out of version 1 pages;
 * - withdrawn stays withdrawn;
 * - a listed item is withdrawn in version 1 when its price is not `fixed`, it is `preorder`,
 *   `backorder` or `made_to_order`, it is age-restricted, it gives its own `tax_included` (whatever the
 *   catalogue says, so a change to the catalogue's never changes it), or its `available_until` has passed
 *   (the producer gives the item a new position at that moment, so a version 1 reader reads it again);
 * - otherwise it is listed with version 1's members: `limited` as `in_stock`, the description cut to
 *   1,000 characters (`cutText`), `image_url` the first image of `media` (else null), `multipack` as it
 *   is, and its `hash` taken again over the version 1 item. Groups, options, the "was" and unit prices,
 *   shipping, returns and `withdrawal` are not in version 1: each variant is an offer of its own, by its own
 *   name.
 */
export async function catalogueItemV1Of(
  item: CatalogueListedItemV2 | { readonly id: string; readonly state: "withdrawn"; readonly updated_at: string },
  ctx: { readonly as_of: string },
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
    item.tax_included !== undefined ||
    (item.available_until !== undefined && ms(item.available_until) <= ms(ctx.as_of))
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

/**
 * The value of `ids=` for products by id, as a reader writes it and a producer signs it as received: each
 * id percent-encoded but for RFC 3986's unreserved characters (`A–Z a–z 0–9 - . _ ~`), the hex in upper
 * case, the ids joined by a literal comma. `gid://shop/ProductVariant/4471` is
 * `gid%3A%2F%2Fshop%2FProductVariant%2F4471`; `O'Neill` is `O%27Neill`.
 */
export function catalogueIdsParam(ids: readonly string[]): string {
  return ids
    .map((id) => encodeURIComponent(id).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`))
    .join(",");
}
