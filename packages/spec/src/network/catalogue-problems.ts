/**
 * Every problem a reader of catalogue version 2 names (protocol §4.18, as amended): in one item
 * (`readCatalogueItemV2`), in a business's product group (`readCatalogueGroups`), and in a policies
 * document (`readCataloguePolicies`). One registry, so a network answers by these codes (the ping's
 * `held[].code`, and `check_catalogue`'s `{id, held}` for each item) and a producer reads them by machine,
 * every side alike. A code is never removed or renamed.
 *
 * - `scope`: what it is found in: one item, a product group, or the policies document.
 * - `effect`: `hold` (the offer is not listed), `drop` (the members in `fields` are dropped or, where
 *   `words` says so, set to their none: `null`, `false`, `[]`; for the policies document, the part at
 *   the problem's path), `withdrawn` (read as withdrawn), `ungroup` (each variant of the group is read
 *   as an offer of its own, none held) or `warn` (nothing changes; it is only told).
 * - `words`: why, in words for the owner.
 *
 * A reader lists an item's problems, and what it dropped, each once, in the order this registry
 * lists them.
 */

export type CatalogueProblemScope = "item" | "group" | "policies";
export type CatalogueProblemEffect = "hold" | "drop" | "withdrawn" | "ungroup" | "warn";

interface Entry {
  readonly scope: CatalogueProblemScope;
  readonly effect: CatalogueProblemEffect;
  readonly fields: readonly string[];
  readonly words: string;
}

const hold = (words: string): Entry => ({ scope: "item", effect: "hold", fields: [], words });
const drop = (fields: readonly string[], words: string): Entry => ({ scope: "item", effect: "drop", fields, words });
const part = (words: string): Entry => ({ scope: "policies", effect: "drop", fields: [], words });

export const CATALOGUE_V2_PROBLEMS = {
  /* --- one item: held ------------------------------------------------------------------------- */
  unreadable: hold(
    "It does not read as catalogue version 2: the member at the path given is missing or not as the spec has it.",
  ),
  currency_unknown: hold("Its price is not in an ISO 4217 currency."),
  price_missing: hold("It has no price, and its price is not on request."),
  price_with_quote: hold("Its price is on request, yet it gives a price."),
  price_max_missing: hold("Its price is a range with no top."),
  price_max_not_range: hold("It gives a top price, and its price is not a range."),
  price_max_not_above: hold("The top of its price range is not above the bottom."),
  currency_mismatch: hold("The top of its price range is in another currency."),
  preorder_without_date: hold("It is for pre-order with no date it comes out."),
  preorder_date_passed: hold("It is for pre-order, and the date it comes out has passed: say how it is available now."),
  available_dates_order: hold("It stops being available before it starts."),
  bundle_multipack: hold("It is a bundle of different items and also a pack of identical ones."),
  age_kind_unknown: hold(
    "Its age restriction names a kind we do not know: pick what kind of product it is from the list of kinds.",
  ),
  age_kind_off: hold("Tobacco and nicotine, cannabis and weapons are kept off the network, ID check or not."),
  age_shipping_only_unchecked: hold(
    "It is age-restricted and reaches the buyer only by shipping, and no service of its shipping profile checks ID at handover.",
  ),
  shipping_profile_unknown: hold(
    "It names a shipping profile your policies document does not have, so its delivery cannot be shown.",
  ),
  return_policy_unknown: hold(
    "It names a return policy your policies document does not have, so its returns cannot be shown.",
  ),
  /* --- one item: withdrawn -------------------------------------------------------------------- */
  available_until_passed: {
    scope: "item",
    effect: "withdrawn",
    fields: [],
    words: "The last day it could be ordered has passed.",
  },
  /* --- one item: a member dropped alone, the offer listed ------------------------------------ */
  sku_dropped: drop(["sku"], "Its SKU does not read (at most 64 characters), so it is left out (null)."),
  description_dropped: drop(
    ["description"],
    "Its description does not read (at most 5,000 characters), so it is left out (null).",
  ),
  group_dropped: drop(
    ["group", "options"],
    "Its product group or its options do not read, so it is shown as a product of its own.",
  ),
  options_without_group: drop(["options"], "It names options and no product group."),
  group_without_options: drop(["group"], "It names a product group and no options."),
  option_key_twice: drop(["group", "options"], "It names one option twice."),
  list_price_dropped: drop(["list_price"], "Its 'was' price does not read."),
  list_price_not_fixed: drop(["list_price"], "A 'was' price is shown only beside a fixed price."),
  list_price_currency: drop(["list_price"], "Its 'was' price is in another currency."),
  list_price_not_above: drop(["list_price"], "Its 'was' price is not above its price."),
  list_price_never_seen: drop(
    ["list_price"],
    "Its 'was' price is not shown: we never saw it sold at or above that price. It is shown for a later reduction, once we have seen that price for 30 days first.",
  ),
  list_price_history_short: drop(
    ["list_price"],
    "Its 'was' price is not shown for this reduction: we saw it at that price for less than the 30 days before the reduction began.",
  ),
  list_price_sold_below: drop(
    ["list_price"],
    "Its 'was' price is not shown: within the 30 days before the reduction began it sold below that price.",
  ),
  unit_price_dropped: drop(["unit_price"], "Its unit price does not read."),
  unit_price_not_fixed: drop(["unit_price"], "A unit price is given only beside a fixed price."),
  unit_unknown: drop(["unit_price"], "Its unit price names a unit the spec does not know."),
  unit_mismatch: drop(["unit_price"], "Its unit price measures in one kind of unit and prices per another."),
  unit_measure: drop(["unit_price"], "Its net quantity has more than three decimals."),
  available_from_unused: drop(
    ["available_from"],
    "A date it is available from is read only for a pre-order or a back-order.",
  ),
  gtin_dropped: drop(["gtin"], "Its barcode is not 14 digits, so it is left out (null)."),
  no_gtin_dropped: drop(["no_gtin"], "Whether it has a barcode does not read (true or false), so it reads as false."),
  gtin_and_no_gtin: drop(["no_gtin"], "It gives a barcode and says it has none: the barcode is kept."),
  brand_dropped: drop(["brand"], "Its brand does not read (at most 70 characters), so it is left out (null)."),
  mpn_dropped: drop(["mpn"], "Its part number does not read (at most 70 characters), so it is left out (null)."),
  url_dropped: drop(["url"], "Its page is not an https address the spec takes, so it is left out (null)."),
  url_off_site: drop(["url"], "Its page is not on your own site, so it is left out (null)."),
  media_dropped: drop(["media"], "Its pictures do not read as a list, so it is shown with none."),
  media_entry_dropped: drop(
    ["media"],
    "A picture or video does not read (an https address the spec takes), or is past the tenth: it is left out, the rest kept.",
  ),
  media_alt_dropped: drop(
    ["media"],
    "A picture's description does not read (at most 200 characters): the picture is kept without it.",
  ),
  shipping_profile_unused: drop(
    ["shipping_profile"],
    "It names a shipping profile, and shipping is not one of the ways it reaches the buyer.",
  ),
  age_shipping_unchecked: drop(
    ["shipping_profile", "fulfil_methods"],
    "It is age-restricted, and no service of its shipping profile checks ID at handover: it is shown for its other ways, shipping taken out.",
  ),
  weight_dropped: drop(["weight"], "Its weight does not read."),
  weight_unit: drop(["weight"], "Its weight is not in g, kg, oz or lb, or has more than three decimals."),
  withdrawal_dropped: drop(["withdrawal"], "What it says of the legal right to withdraw does not read."),
  /* --- one item: told only --------------------------------------------------------------------- */
  hash_mismatch: {
    scope: "item",
    effect: "warn",
    fields: [],
    words: "Its hash is not the one its members give: check how your system writes canonical JSON.",
  },
  /* --- a product group ------------------------------------------------------------------------- */
  group_title_differs: {
    scope: "group",
    effect: "ungroup",
    fields: [],
    words: "Its variants give the product different titles, so each is shown as a product of its own.",
  },
  group_options_differ: {
    scope: "group",
    effect: "ungroup",
    fields: [],
    words: "Its variants do not all name the same options, so each is shown as a product of its own.",
  },
  group_option_name_differs: {
    scope: "group",
    effect: "ungroup",
    fields: [],
    words: "Its variants call one option by different names, so each is shown as a product of its own.",
  },
  group_duplicate_variant: {
    scope: "group",
    effect: "ungroup",
    fields: [],
    words: "Two of its variants are alike in every option, so each is shown as a product of its own.",
  },
  group_too_large: {
    scope: "group",
    effect: "hold",
    fields: [],
    words: "A product shows at most 250 variants: those past the 250th are held back.",
  },
  /* --- the policies document ------------------------------------------------------------------- */
  policies_document_unreadable: part(
    "Your policies document does not read, so no offer's delivery or returns can be shown until it does.",
  ),
  policies_unreadable: part("A shipping profile or return policy does not read, so it is left out."),
  policies_id_twice: part(
    "A shipping profile, return policy or service uses an id already used: the later is left out.",
  ),
  policies_default_twice: part("More than one is marked as the default: the first stays the default."),
  policies_currency_mixed: part("A shipping service gives amounts in more than one currency, so it is left out."),
  policies_band_order: part(
    "A shipping service's bands do not rise, its open band is not last, or a weight has more than three decimals: it is left out.",
  ),
  policies_transit_order: part("A shipping service's longest time is below its shortest, so it is left out."),
  policies_carrier_unknown: part("A shipping service names a carrier we do not know: the service is kept without it."),
  policies_zone_empty: part("A zone is left with no shipping service, so it is left out."),
  policies_profile_empty: part("A shipping profile is left with no zone, so it is left out."),
  policies_window_days_missing: part("A return policy with a window gives no number of days, so it is left out."),
  policies_window_days_unused: part("A return policy gives days beside no window: the days are left out."),
  policies_terms_missing: part(
    "A return policy that takes returns says no way to settle or send them, so it is left out.",
  ),
  policies_postage_missing: part("A return policy by post does not say who pays the postage, so it is left out."),
  policies_not_accepted_terms: part("A no-returns policy gives terms for returns: the terms are left out."),
} as const satisfies Record<string, Entry>;

export type CatalogueProblem = keyof typeof CATALOGUE_V2_PROBLEMS;

const ORDER: ReadonlyMap<string, number> = new Map(Object.keys(CATALOGUE_V2_PROBLEMS).map((k, i) => [k, i]));

/** Codes each once, in the order the registry lists them. */
export function inRegistryOrder<T extends string>(codes: Iterable<T>): T[] {
  return [...new Set(codes)].sort((a, b) => (ORDER.get(a) ?? 1e9) - (ORDER.get(b) ?? 1e9));
}
