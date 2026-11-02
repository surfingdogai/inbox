import { z } from "zod";
import carriersVocab from "../../vocab/carriers.json" with { type: "json" };
import { type CatalogueWeight, catalogueIdV2Schema, catalogueMoneySchema } from "./catalogue-v2";

/**
 * The policies document (protocol §4.18, catalogue version 2): the one published shape of a business's
 * shipping profiles and return policies, which its offers name by id (`shipping_profile`,
 * `return_policy`). Served signed, like a feed page, at the address its manifest names under
 * `catalogue.policies`. The orders work refers to this shape and never defines a second one.
 *
 * Shipping v1 is the owner's own rate tables only: a flat rate (0 is free), a rate per item, by weight or
 * by order value, each with an optional `free_over`. The owner buys and prints their own labels; no
 * carrier is called. A return policy says what the business offers: it never takes away a right the law
 * gives the buyer where they live (in the EU and the UK, a distance purchase may be withdrawn from within
 * 14 days of delivery, as the law excepts), and faulty goods are always the business's.
 */

const currency = z.string().regex(/^[A-Z]{3}$/);
const isoTime = z.iso.datetime({ offset: true });
const hex16 = z.string().regex(/^[0-9a-f]{16}$/);
const name = z.string().min(1).max(80);

/** An amount a policy names: like a price, but 0 is allowed (a free rate, no fee). */
export const policyMoneySchema = z.object({ value: z.int().min(0).max(1_000_000_000_000_000), currency });
export type PolicyMoney = z.infer<typeof policyMoneySchema>;

/**
 * Places, by country, and within it by ISO 3166-2 region or by the start of a postcode. With neither, the
 * whole country; with both, a place in either.
 */
export const shippingDestinationSchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/),
  regions: z
    .array(z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/))
    .min(1)
    .max(100)
    .optional(),
  postal_prefixes: z
    .array(z.string().regex(/^[A-Z0-9]{1,10}$/, "upper case, no spaces"))
    .min(1)
    .max(500)
    .optional(),
});
export type ShippingDestination = z.infer<typeof shippingDestinationSchema>;

export const WEIGHT_UNITS = ["g", "kg", "oz", "lb"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

/** How a service's fee is worked out. The bands of `by_weight` and `by_order_value` rise; a `null` `up_to` (last) is "and above". */
export const shippingRateSchema = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("flat"), amount: policyMoneySchema }),
  z.object({
    basis: z.literal("per_item"),
    amount: policyMoneySchema.describe("For each unit ordered (a pack counts once)."),
  }),
  z.object({
    basis: z.literal("by_weight"),
    unit: z.enum(WEIGHT_UNITS),
    bands: z
      .array(z.object({ up_to: z.number().positive().max(1_000_000).nullable(), amount: policyMoneySchema }))
      .min(1)
      .max(20),
  }),
  z.object({
    basis: z.literal("by_order_value"),
    bands: z
      .array(z.object({ up_to: catalogueMoneySchema.nullable(), amount: policyMoneySchema }))
      .min(1)
      .max(20),
  }),
]);
export type ShippingRate = z.infer<typeof shippingRateSchema>;

/** One way a zone is shipped to: Standard, Express, Tracked 24. */
export const shippingServiceSchema = z.object({
  id: catalogueIdV2Schema,
  name,
  carrier: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional()
    .describe("An id of vocab/carriers.json, when the owner says which carrier takes it."),
  tracked: z.boolean(),
  id_check: z.boolean().describe("The owner marks this service as one whose carrier checks ID at handover."),
  transit_days: z.object({ min: z.int().min(0).max(90), max: z.int().min(0).max(90) }),
  rate: shippingRateSchema,
  free_over: catalogueMoneySchema.optional().describe("An order of goods worth at least this ships free by it."),
});
export type ShippingService = z.infer<typeof shippingServiceSchema>;

export const shippingZoneSchema = z.object({
  name,
  destinations: z.array(shippingDestinationSchema).min(1).max(250),
  excluded: z
    .array(shippingDestinationSchema)
    .max(250)
    .optional()
    .describe("Places inside the destinations it does not ship to."),
  services: z.array(shippingServiceSchema).min(1).max(10),
});
export type ShippingZone = z.infer<typeof shippingZoneSchema>;

/** A shipping profile: where it ships, how, and at what rates. One may be the default. */
export const shippingProfileSchema = z.object({
  id: catalogueIdV2Schema,
  name,
  default: z.boolean().optional(),
  zones: z.array(shippingZoneSchema).min(1).max(50).describe("In order: a place is in the first zone that has it."),
});
export type ShippingProfile = z.infer<typeof shippingProfileSchema>;

/**
 * A return policy: a window of days from delivery or collection (`window`), any time (`unlimited`), or
 * none (`not_accepted`: no returns for a change of mind; a faulty item is still the business's). Outside
 * the EU and the UK a business may offer no returns or a window under 14 days, and it is shown as it is;
 * the legal right of withdrawal still holds wherever the law gives one.
 */
export const returnPolicySchema = z.object({
  id: catalogueIdV2Schema,
  name,
  default: z.boolean().optional(),
  eligibility: z.enum(["window", "unlimited", "not_accepted"]),
  window_days: z.int().min(1).max(365).optional().describe("window only: days from delivery or collection."),
  resolutions: z
    .array(z.enum(["refund", "exchange", "store_credit"]))
    .max(3)
    .describe("What the buyer may have for a return; empty only when not_accepted."),
  methods: z
    .array(z.enum(["by_post", "in_store"]))
    .max(2)
    .describe("How it comes back; empty only when not_accepted."),
  return_postage: z.enum(["customer", "business"]).optional().describe("by_post: who pays to send it back."),
  restocking_fee: z
    .union([z.object({ percent: z.int().min(1).max(100) }), z.object({ amount: catalogueMoneySchema })])
    .optional()
    .describe("Never charged on a legal withdrawal or a faulty item."),
});
export type ReturnPolicy = z.infer<typeof returnPolicySchema>;

/** The policies document, `GET <catalogue.policies>`: `200`, signed in `Catalogue-Signature` as a page is. */
export const cataloguePoliciesSchema = z.object({
  version: z.literal(1),
  domain: z.string().min(1).max(253),
  as_of: isoTime,
  rev: hex16.describe("Changes whenever anything in the document changes; a page's catalogue.policies_rev names it."),
  shipping_profiles: z.array(shippingProfileSchema).max(50),
  return_policies: z.array(returnPolicySchema).max(50),
});
export type CataloguePolicies = z.infer<typeof cataloguePoliciesSchema>;

/* --- the carriers -------------------------------------------------------------------------------- */

export const carriersVocabSchema = z.object({
  description: z.string(),
  version: z.int().min(1),
  kinds: z.array(z.string()),
  s10_pattern: z.string(),
  carriers: z.array(
    z.object({
      id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
      name: z.string().min(1),
      countries: z.array(z.string().regex(/^[A-Z]{2}$/)),
      kind: z.enum(["post", "parcel", "express"]),
      s10: z.boolean(),
      tracking_url_template: z
        .string()
        .startsWith("https://")
        .refine((t) => t.split("{number}").length === 2, "names {number} once")
        .nullable(),
      domains: z.array(z.string().regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/)).min(1),
    }),
  ),
});
export type CarriersVocab = z.infer<typeof carriersVocabSchema>;
export type Carrier = CarriersVocab["carriers"][number];

/** `vocab/carriers.json`, read. */
export const CARRIERS: CarriersVocab = carriersVocabSchema.parse(carriersVocab);
const carrierById = new Map(CARRIERS.carriers.map((c) => [c.id, c]));

export function carrierOf(id: string): Carrier | null {
  return carrierById.get(id) ?? null;
}

/**
 * A tracking link for a parcel: the carrier's template filled in, or the business's own link when it is
 * https on one of the carrier's domains. Anything else is null: never a link to somewhere else.
 */
export function trackingUrl(carrierId: string, number: string, given?: string | null): string | null {
  const c = carrierOf(carrierId);
  if (!c) return null;
  if (given) {
    try {
      const u = new URL(given);
      const host = u.hostname.toLowerCase().replace(/\.$/, "");
      if (u.protocol === "https:" && c.domains.some((d) => host === d || host.endsWith(`.${d}`))) return given;
    } catch {
      // not a URL: fall through to the template
    }
  }
  const n = number.trim();
  if (!c.tracking_url_template || !/^[A-Za-z0-9-]{4,40}$/.test(n)) return null;
  return c.tracking_url_template.replace("{number}", encodeURIComponent(n));
}

/* --- reading a document -------------------------------------------------------------------------- */

/** What a reader found in a policies document, at a path, and dropped. */
export type PoliciesProblemCode =
  | "unreadable"
  | "id_twice"
  | "default_twice"
  | "currency_mixed"
  | "band_order"
  | "transit_order"
  | "carrier_unknown"
  | "zone_empty"
  | "profile_empty"
  | "window_days_missing"
  | "window_days_unused"
  | "terms_missing"
  | "postage_missing"
  | "not_accepted_terms";

export interface PoliciesProblem {
  readonly path: string;
  readonly code: PoliciesProblemCode;
}

/** A policies document as a reader keeps it: every part that read, the defaults, and what it dropped. */
export interface PoliciesRead {
  readonly doc: CataloguePolicies;
  readonly default_shipping_profile: string | null;
  readonly default_return_policy: string | null;
  readonly problems: readonly PoliciesProblem[];
}

const envelopeSchema = cataloguePoliciesSchema.extend({
  shipping_profiles: z.array(z.unknown()).max(50),
  return_policies: z.array(z.unknown()).max(50),
});

function moneyOf(rate: ShippingRate): PolicyMoney[] {
  switch (rate.basis) {
    case "flat":
    case "per_item":
      return [rate.amount];
    case "by_weight":
      return rate.bands.map((b) => b.amount);
    case "by_order_value":
      return rate.bands.flatMap((b) => (b.up_to ? [b.amount, b.up_to] : [b.amount]));
  }
}

function bandsRise(rate: ShippingRate): boolean {
  if (rate.basis !== "by_weight" && rate.basis !== "by_order_value") return true;
  if (rate.bands.some((b) => typeof b.up_to === "number" && !hasThreeDecimals(b.up_to))) return false;
  const tops = rate.bands.map((b) =>
    b.up_to === null ? null : typeof b.up_to === "number" ? milli(b.up_to) : BigInt(b.up_to.value),
  );
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i];
    if (t === undefined) continue;
    if (t === null) {
      if (i !== tops.length - 1) return false;
      continue;
    }
    const prev = i > 0 ? tops[i - 1] : undefined;
    if (prev !== undefined && prev !== null && t <= prev) return false;
  }
  return true;
}

/**
 * Reads a policies document part by part, as a reader keeps it (`vectors/catalogue-policies.json`). The
 * document as a whole must read; then each profile and policy is read alone, and a part that does not
 * read or does not hold is dropped with what was wrong, the rest kept:
 * - an id a profile (or policy) already used: the later one dropped (`id_twice`);
 * - a second `default`: the first in the document stays the default (`default_twice`);
 * - a service whose amounts are in more than one currency (`currency_mixed`), whose bands do not rise or
 *   whose open band is not last, or a weight band with more than three decimals (`band_order`), or whose `transit_days.max` is below its `min`
 *   (`transit_order`): dropped; a `carrier` the vocabulary does not know: the carrier alone
 *   (`carrier_unknown`); a zone left with no service (`zone_empty`), a profile with no zone
 *   (`profile_empty`);
 * - a return policy: a `window` with no `window_days` (`window_days_missing`), one that takes returns
 *   with no resolution or no method (`terms_missing`) or by post with no `return_postage`
 *   (`postage_missing`): dropped; `window_days` beside another eligibility (`window_days_unused`) and the
 *   terms of a `not_accepted` policy (`not_accepted_terms`): the member alone.
 * Returns null when the document itself does not read.
 */
export function readCataloguePolicies(raw: unknown): PoliciesRead | null {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) return null;
  const problems: PoliciesProblem[] = [];
  const profiles: ShippingProfile[] = [];
  let defaultShipping: string | null = null;
  for (const [pi, rawProfile] of env.data.shipping_profiles.entries()) {
    const path = `shipping_profiles[${pi}]`;
    const p = shippingProfileSchema.safeParse(rawProfile);
    if (!p.success) {
      problems.push({ path, code: "unreadable" });
      continue;
    }
    if (profiles.some((q) => q.id === p.data.id)) {
      problems.push({ path, code: "id_twice" });
      continue;
    }
    const zones: ShippingZone[] = [];
    for (const [zi, zone] of p.data.zones.entries()) {
      const services: ShippingService[] = [];
      for (const [si, svc] of zone.services.entries()) {
        const at = `${path}.zones[${zi}].services[${si}]`;
        const currencies = new Set(
          [...moneyOf(svc.rate), ...(svc.free_over ? [svc.free_over] : [])].map((m) => m.currency),
        );
        const why: PoliciesProblemCode | null = services.some((s) => s.id === svc.id)
          ? "id_twice"
          : currencies.size > 1
            ? "currency_mixed"
            : !bandsRise(svc.rate)
              ? "band_order"
              : svc.transit_days.max < svc.transit_days.min
                ? "transit_order"
                : null;
        if (why) {
          problems.push({ path: at, code: why });
          continue;
        }
        if (svc.carrier !== undefined && !carrierOf(svc.carrier)) {
          problems.push({ path: `${at}.carrier`, code: "carrier_unknown" });
          const { carrier: _c, ...rest } = svc;
          services.push(rest);
          continue;
        }
        services.push(svc);
      }
      if (services.length === 0) problems.push({ path: `${path}.zones[${zi}]`, code: "zone_empty" });
      else zones.push({ ...zone, services });
    }
    if (zones.length === 0) {
      problems.push({ path, code: "profile_empty" });
      continue;
    }
    let profile: ShippingProfile = { ...p.data, zones };
    if (profile.default) {
      if (defaultShipping === null) defaultShipping = profile.id;
      else {
        problems.push({ path: `${path}.default`, code: "default_twice" });
        const { default: _d, ...rest } = profile;
        profile = rest;
      }
    }
    profiles.push(profile);
  }

  const policies: ReturnPolicy[] = [];
  let defaultReturns: string | null = null;
  for (const [ri, rawPolicy] of env.data.return_policies.entries()) {
    const path = `return_policies[${ri}]`;
    const r = returnPolicySchema.safeParse(rawPolicy);
    if (!r.success) {
      problems.push({ path, code: "unreadable" });
      continue;
    }
    if (policies.some((q) => q.id === r.data.id)) {
      problems.push({ path, code: "id_twice" });
      continue;
    }
    let policy: ReturnPolicy = r.data;
    if (policy.eligibility === "not_accepted") {
      if (
        policy.resolutions.length ||
        policy.methods.length ||
        policy.return_postage !== undefined ||
        policy.restocking_fee !== undefined
      ) {
        problems.push({ path, code: "not_accepted_terms" });
        const { return_postage: _p, restocking_fee: _f, ...rest } = policy;
        policy = { ...rest, resolutions: [], methods: [] };
      }
    } else {
      const why: PoliciesProblemCode | null =
        policy.eligibility === "window" && policy.window_days === undefined
          ? "window_days_missing"
          : !policy.resolutions.length || !policy.methods.length
            ? "terms_missing"
            : policy.methods.includes("by_post") && policy.return_postage === undefined
              ? "postage_missing"
              : null;
      if (why) {
        problems.push({ path, code: why });
        continue;
      }
    }
    if (policy.eligibility !== "window" && policy.window_days !== undefined) {
      problems.push({ path: `${path}.window_days`, code: "window_days_unused" });
      const { window_days: _w, ...rest } = policy;
      policy = rest;
    }
    if (policy.default) {
      if (defaultReturns === null) defaultReturns = policy.id;
      else {
        problems.push({ path: `${path}.default`, code: "default_twice" });
        const { default: _d, ...rest } = policy;
        policy = rest;
      }
    }
    policies.push(policy);
  }

  return {
    doc: { ...env.data, shipping_profiles: profiles, return_policies: policies },
    default_shipping_profile: defaultShipping,
    default_return_policy: defaultReturns,
    problems,
  };
}

/* --- a shipping quote ---------------------------------------------------------------------------- */

/** Where the buyer is: a country, and a region or a postcode when they are known. */
export interface QuoteDestination {
  readonly country: string;
  readonly region?: string | null | undefined;
  readonly postal_code?: string | null | undefined;
}

/** One line of a basket: an offer's price, how many, and its weight when it has one. */
export interface QuoteLine {
  readonly price: { readonly value: number; readonly currency: string };
  readonly quantity: number;
  readonly weight?: CatalogueWeight | null | undefined;
}

export interface QuotedService {
  readonly id: string;
  readonly name: string;
  readonly carrier: string | null;
  readonly tracked: boolean;
  readonly id_check: boolean;
  readonly transit_days: { readonly min: number; readonly max: number };
  /** The fee, or null when this service cannot take the basket, with why. */
  readonly fee: PolicyMoney | null;
  readonly why?: "currency" | "weight_missing" | "weight_unit" | "too_heavy" | "over_bands";
}

export interface ShippingQuote {
  readonly profile: string | null;
  readonly zone: string | null;
  readonly services: readonly QuotedService[];
  readonly why?: "no_profile" | "not_shipped_there";
}

/** A number of at most three decimals as an exact count of thousandths; it throws for any other. */
export function milli(n: number): bigint {
  const s = String(n);
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new RangeError(`${s}: more than three decimals`);
  return BigInt(m[1] as string) * 1000n + BigInt((m[2] ?? "").padEnd(3, "0"));
}

/** Whether a number has at most three decimals (and is written without an exponent). */
export function hasThreeDecimals(n: number): boolean {
  return Number.isFinite(n) && /^\d+(?:\.\d{1,3})?$/.test(String(n));
}

/** Nanograms in one of each weight unit: exact (an avoirdupois pound is 0.45359237 kg). */
const NANOGRAMS: Readonly<Record<WeightUnit, bigint>> = {
  g: 1_000_000_000n,
  kg: 1_000_000_000_000n,
  oz: 28_349_523_125n,
  lb: 453_592_370_000n,
};

function weightUnit(u: string): WeightUnit | null {
  return (WEIGHT_UNITS as readonly string[]).includes(u) ? (u as WeightUnit) : null;
}

function postcode(p: string): string {
  return p.toUpperCase().replace(/[\s-]/g, "");
}

function placeIn(d: QuoteDestination, entry: ShippingDestination): boolean {
  if (d.country.toUpperCase() !== entry.country) return false;
  if (!entry.regions && !entry.postal_prefixes) return true;
  const region = d.region?.toUpperCase();
  if (region && entry.regions?.includes(region)) return true;
  const pc = d.postal_code ? postcode(d.postal_code) : "";
  return pc !== "" && (entry.postal_prefixes ?? []).some((p) => pc.startsWith(p));
}

/**
 * What shipping a basket to a place costs under one profile (`vectors/catalogue-policies.json`): the
 * profile named, else the document's default; the first zone that has the place and does not exclude
 * it; and for each of its services, the fee, or null with why. A region or postcode the buyer did not
 * give matches no entry that names regions or postcodes.
 *
 * For each service, in this order: every line priced in the service's currency (`currency`: no amount is
 * ever converted); for `by_weight`, every line with a weight (`weight_missing`), in a unit it knows
 * (`weight_unit`), and the basket no heavier than its last band (`too_heavy`); then goods worth at least
 * `free_over` ship free; else `flat` is its amount, `per_item` its amount for each unit, `by_weight` and
 * `by_order_value` the first band whose `up_to` is at least the basket's (`over_bands` past the last).
 * The goods' worth is each line's price times its quantity; the weight, each line's weight times its
 * quantity, worked out exactly.
 */
export function quoteShipping(
  read: PoliciesRead,
  input: {
    readonly shipping_profile?: string | null;
    readonly lines: readonly QuoteLine[];
    readonly destination: QuoteDestination;
  },
): ShippingQuote {
  const id = input.shipping_profile ?? read.default_shipping_profile;
  const profile = id ? read.doc.shipping_profiles.find((p) => p.id === id) : undefined;
  if (!profile) return { profile: null, zone: null, services: [], why: "no_profile" };
  const zone = profile.zones.find(
    (z) =>
      z.destinations.some((e) => placeIn(input.destination, e)) &&
      !(z.excluded ?? []).some((e) => placeIn(input.destination, e)),
  );
  if (!zone) return { profile: profile.id, zone: null, services: [], why: "not_shipped_there" };
  return { profile: profile.id, zone: zone.name, services: zone.services.map((s) => quoteService(s, input.lines)) };
}

function quoteService(s: ShippingService, lines: readonly QuoteLine[]): QuotedService {
  const base = {
    id: s.id,
    name: s.name,
    carrier: s.carrier ?? null,
    tracked: s.tracked,
    id_check: s.id_check,
    transit_days: s.transit_days,
  };
  const cur = moneyOf(s.rate)[0]?.currency ?? s.free_over?.currency ?? "";
  const no = (why: NonNullable<QuotedService["why"]>): QuotedService => ({ ...base, fee: null, why });
  const fee = (value: bigint): QuotedService => ({ ...base, fee: { value: Number(value), currency: cur } });
  if (lines.some((l) => l.price.currency !== cur)) return no("currency");
  const worth = lines.reduce((sum, l) => sum + BigInt(l.price.value) * BigInt(l.quantity), 0n);
  const units = lines.reduce((sum, l) => sum + BigInt(l.quantity), 0n);
  let weightBand: PolicyMoney | null = null;
  if (s.rate.basis === "by_weight") {
    const bandUnit = NANOGRAMS[s.rate.unit];
    let total = 0n; // thousandths of a nanogram
    for (const l of lines) {
      if (!l.weight) return no("weight_missing");
      const u = weightUnit(l.weight.unit);
      if (!u || !hasThreeDecimals(l.weight.value)) return no("weight_unit");
      total += milli(l.weight.value) * NANOGRAMS[u] * BigInt(l.quantity);
    }
    const band = s.rate.bands.find((b) => b.up_to === null || total <= milli(b.up_to) * bandUnit);
    if (!band) return no("too_heavy");
    weightBand = band.amount;
  }
  if (s.free_over && worth >= BigInt(s.free_over.value)) return fee(0n);
  switch (s.rate.basis) {
    case "flat":
      return fee(BigInt(s.rate.amount.value));
    case "per_item":
      return fee(BigInt(s.rate.amount.value) * units);
    case "by_weight":
      return fee(BigInt((weightBand as PolicyMoney).value));
    case "by_order_value": {
      const band = s.rate.bands.find((b) => b.up_to === null || worth <= BigInt(b.up_to.value));
      return band ? fee(BigInt(band.amount.value)) : no("over_bands");
    }
  }
}
