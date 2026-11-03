import type { Statement } from "@surfingdog/platform";
import {
  CATALOGUE_V2_PROBLEMS,
  type CataloguePolicies,
  type PoliciesRead,
  type QuoteDestination,
  type QuotedService,
  quoteShipping,
  type ReturnPolicy,
  readCataloguePolicies,
  returnPolicySchema,
  type ShippingProfile,
  shippingProfileSchema,
  shippingZoneSchema,
} from "@surfingdog/spec";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import { products, returnPolicies, shippingProfiles } from "../schema/tables";
import { readSettings, type Settings } from "../settings/schema";
import { canonicalJson, hashText } from "../util/canonical";
import { WriteError } from "../write/errors";
import { NEXT_CATALOGUE_SEQ } from "./identity";
import { productAge } from "./v2";

/**
 * The business's shipping profiles and return policies (catalogue version 2; protocol §4.18 as amended,
 * `schemas/catalogue-policies.json`): the one published shape, kept in two tables and served signed at
 * `GET /v1/catalogue/policies`. Products name a profile and a policy by id; with none, the default.
 *
 * Shipping v1 is the owner's own rate tables (the founder, 2 November 2026): flat, per item, by weight, by
 * order value, free over a value. The owner buys and prints their own labels; no carrier is called.
 *
 * A return policy says what the business offers on top of the law. In the EU, the EEA and the United
 * Kingdom, and wherever the business has not said which country's law it sells under, it is at least the
 * 14 days the law gives a buyer to withdraw: a window of 14 days or more, or unlimited. Elsewhere an owner
 * may offer no returns, or a window under 14 days, and it is shown as it is. The legal right to withdraw is
 * enforced by the inbox's own returns either way (`settings.returns`, never under 14 days).
 *
 * Only the owner in person writes any of it: never the owner's AI, never a key handed to another system.
 * A write is checked as a network reads the document (`readCataloguePolicies`): one a reader would drop
 * any part of is refused with that part's code, so the document an inbox serves always reads whole.
 */

/** The countries whose law gives a buyer 14 days to withdraw from a distance purchase: the EU, the EEA, the UK. */
export const WITHDRAWAL_14_COUNTRIES: readonly string[] = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "GB",
];

/** The id a policy the migration made of the settings' returns has, and one an empty table stands in for. */
export const STANDARD_RETURN_POLICY = "standard";

/** An id an owner gives a profile or a policy: lower case, short, the same in every reader's records. */
export const policyIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lower case letters, digits, - and _, at most 64")
  .describe("Its id, as products name it: standard, chilled, express.");

/** The owner's shipping profile, as the policies document gives it. */
export const shippingProfileInput = z.object({
  id: policyIdSchema,
  name: z.string().trim().min(1).max(80),
  default: z.boolean().optional().describe("The profile every shipped product without one of its own uses."),
  zones: z.array(shippingZoneSchema).min(1).max(50).describe("In order: a place is in the first zone that has it."),
});
export type ShippingProfileInput = z.infer<typeof shippingProfileInput>;

/** The owner's return policy, as the policies document gives it. */
export const returnPolicyInput = returnPolicySchema.extend({
  id: policyIdSchema,
  name: z.string().trim().min(1).max(80),
});
export type ReturnPolicyInput = z.infer<typeof returnPolicyInput>;

/** What the policies are, without the moment and the domain a document is served for. */
export interface PoliciesState {
  readonly shipping_profiles: readonly ShippingProfile[];
  readonly return_policies: readonly ReturnPolicy[];
  /** The first 16 hex digits of SHA-256 over their canonical JSON: moves whenever anything in them does. */
  readonly rev: string;
  /** As a network reads them (`readCataloguePolicies`), for checking the items that name them. */
  readonly read: PoliciesRead;
}

/** The policy `follows_settings` stands for: a window of the settings' days, by post, a refund. */
function standardTerms(s: Settings): Omit<ReturnPolicy, "id" | "name" | "default"> {
  return {
    eligibility: "window",
    window_days: s.returns.days,
    resolutions: ["refund"],
    methods: ["by_post"],
    return_postage: s.returns.postage,
  };
}

type ReturnTerms = Omit<ReturnPolicy, "id" | "name" | "default">;

/** The policies as the tables keep them, read and checked as a network would. */
export async function loadPolicies(db: Db, settings?: Settings): Promise<PoliciesState> {
  const [s, ship, ret] = await Promise.all([
    settings ?? readSettings(db),
    db.orm.select().from(shippingProfiles).orderBy(asc(shippingProfiles.createdAt), asc(shippingProfiles.id)),
    db.orm.select().from(returnPolicies).orderBy(asc(returnPolicies.createdAt), asc(returnPolicies.id)),
  ]);
  const shipping_profiles: ShippingProfile[] = ship.map((r) => ({
    id: r.id,
    name: r.name,
    ...(r.isDefault === 1 ? { default: true } : {}),
    zones: r.zones as ShippingProfile["zones"],
  }));
  // An inbox whose table is empty (a database made before its rows were) publishes its settings' returns.
  const rows = ret.length
    ? ret
    : [{ id: STANDARD_RETURN_POLICY, name: "Standard", isDefault: 1, terms: standardTerms(s), followsSettings: 1 }];
  const return_policies: ReturnPolicy[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    ...(r.isDefault === 1 ? { default: true } : {}),
    ...(r.followsSettings === 1 ? standardTerms(s) : (r.terms as ReturnTerms)),
  }));
  const content = { shipping_profiles, return_policies };
  const rev = (await hashText(canonicalJson(content))).slice(0, 16);
  // Written through `putShippingProfile` and `putReturnPolicy`, which refuse what a reader would drop, so
  // this reads whole; were a row put in by hand not to read, the reader's own rules leave it out here too.
  const read = readCataloguePolicies(envelope(rev, content)) ?? {
    doc: envelope(rev, { shipping_profiles: [], return_policies: [] }),
    default_shipping_profile: null,
    default_return_policy: null,
    problems: [],
  };
  return { shipping_profiles, return_policies, rev, read };
}

/** The document as served: the policies, for this domain at this moment. */
export function policiesDocument(state: PoliciesState, domain: string, asOf: string): CataloguePolicies {
  return {
    version: 1,
    domain,
    as_of: asOf,
    rev: state.rev,
    shipping_profiles: [...state.shipping_profiles],
    return_policies: [...state.return_policies],
  };
}

/** The refusal of a policy write from anyone but the owner in person. */
export function policyOwners(path: string): WriteError {
  return new WriteError(
    "not_allowed",
    "Shipping rates and return policies are the owner's to set, signed in to the owner app. Tell the owner in a note what you suggest.",
    {
      fields: [{ path, problem: "invalid", message: "only the owner in person changes this" }],
      details: { reason: "owner_in_person", ask_owner: true, where: "Shipping and returns" },
    },
  );
}

/**
 * Why a return policy cannot be offered where the business sells, or null: in the EU, the EEA and the UK,
 * and where the owner has not said which country's law applies, it is at least the 14 days to withdraw.
 */
export function returnPolicyTooShort(
  policy: Pick<ReturnPolicy, "eligibility" | "window_days">,
  country: string | null | undefined,
): string | null {
  const strict = !country || WITHDRAWAL_14_COUNTRIES.includes(country.toUpperCase());
  if (!strict) return null;
  if (policy.eligibility === "not_accepted")
    return "Where you sell, the law gives a buyer 14 days to withdraw from a distance purchase: a policy cannot be no returns. Set your country in Settings if you sell under another country's law.";
  if (policy.eligibility === "window" && (policy.window_days ?? 0) < 14)
    return "Where you sell, the law gives a buyer 14 days to withdraw from a distance purchase: the window is 14 days or more. Set your country in Settings if you sell under another country's law.";
  return null;
}

/** A write a reader of the document would not take whole: refused with the code of what it would drop. */
function refuseProblems(read: PoliciesRead | null, path: string): void {
  if (!read) {
    throw new WriteError("invalid_input", CATALOGUE_V2_PROBLEMS.policies_document_unreadable.words, {
      fields: [{ path, problem: "invalid", message: "policies_document_unreadable" }],
      details: { code: "policies_document_unreadable" },
    });
  }
  const p = read.problems[0];
  if (!p) return;
  throw new WriteError("invalid_input", CATALOGUE_V2_PROBLEMS[p.code].words, {
    fields: [{ path: `${path}${p.path.replace(/^[a-z_]+\[\d+\]/, "")}`, problem: "invalid", message: p.code }],
    details: { code: p.code },
  });
}

type Content = Pick<CataloguePolicies, "shipping_profiles" | "return_policies">;

/** A document around the policies, for reading them as a network does: its domain and moment are not read. */
function envelope(rev: string, content: Content): CataloguePolicies {
  return { version: 1, domain: "policies.example", as_of: new Date(0).toISOString(), rev, ...content };
}

function check(state: PoliciesState, content: Content, path: string) {
  refuseProblems(readCataloguePolicies(envelope(state.rev, content)), path);
}

/** Writes one shipping profile, the owner's in person. A profile made the default stops any other being it. */
export async function putShippingProfile(db: Db, input: ShippingProfileInput, now: number): Promise<PoliciesState> {
  const profile = shippingProfileSchema.parse(input);
  const state = await loadPolicies(db);
  const others = state.shipping_profiles
    .filter((p) => p.id !== profile.id)
    .map((p) => (profile.default ? { ...p, default: undefined } : p));
  check(state, { shipping_profiles: [...others, profile], return_policies: [...state.return_policies] }, "zones");
  await db.batch([
    ...(profile.default
      ? [
          {
            sql: "UPDATE shipping_profiles SET is_default = 0, updated_at = ? WHERE is_default = 1 AND id <> ?",
            params: [now, profile.id],
            method: "run" as const,
          },
        ]
      : []),
    {
      sql: `INSERT INTO shipping_profiles (id, name, is_default, zones, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, is_default = excluded.is_default, zones = excluded.zones,
                                           updated_at = excluded.updated_at`,
      params: [profile.id, profile.name, profile.default ? 1 : 0, JSON.stringify(profile.zones), now, now],
      method: "run",
    },
  ]);
  return loadPolicies(db);
}

/** Writes one return policy, the owner's in person: its terms are its own from then on, never the settings'. */
export async function putReturnPolicy(db: Db, input: ReturnPolicyInput, now: number): Promise<PoliciesState> {
  const policy = returnPolicySchema.parse(input);
  const settings = await readSettings(db);
  const short = returnPolicyTooShort(policy, settings.commerce.legal.country);
  if (short) {
    throw new WriteError("invalid_input", short, {
      fields: [
        {
          path: policy.eligibility === "window" ? "window_days" : "eligibility",
          problem: "invalid",
          message: "under the 14 days the law gives",
        },
      ],
      details: { code: "withdrawal_14_days" },
    });
  }
  const state = await loadPolicies(db, settings);
  const others = state.return_policies
    .filter((p) => p.id !== policy.id)
    .map((p) => (policy.default ? { ...p, default: undefined } : p));
  check(state, { shipping_profiles: [...state.shipping_profiles], return_policies: [...others, policy] }, "terms");
  const { id, name, default: isDefault, ...terms } = policy;
  const [existing] = await db.orm.select({ id: returnPolicies.id }).from(returnPolicies).limit(1);
  await db.batch([
    // The first write to an inbox whose table is empty keeps the standard policy it stood in for.
    ...(!existing && id !== STANDARD_RETURN_POLICY
      ? [
          {
            sql: `INSERT OR IGNORE INTO return_policies (id, name, is_default, terms, follows_settings, created_at, updated_at)
                  VALUES (?, 'Standard', ?, ?, 1, ?, ?)`,
            params: [
              STANDARD_RETURN_POLICY,
              isDefault ? 0 : 1,
              JSON.stringify(standardTerms(settings)),
              now - 1,
              now - 1,
            ],
            method: "run" as const,
          },
        ]
      : []),
    ...(isDefault
      ? [
          {
            sql: "UPDATE return_policies SET is_default = 0, updated_at = ? WHERE is_default = 1 AND id <> ?",
            params: [now, id],
            method: "run" as const,
          },
        ]
      : []),
    {
      sql: `INSERT INTO return_policies (id, name, is_default, terms, follows_settings, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, is_default = excluded.is_default, terms = excluded.terms,
                                           follows_settings = 0, updated_at = excluded.updated_at`,
      params: [id, name, isDefault ? 1 : 0, JSON.stringify(terms), now, now],
      method: "run",
    },
  ]);
  return loadPolicies(db, settings);
}

/**
 * Takes a profile or a policy away. Refused while a product names it, since a product that names one the
 * document does not have is held by every reader, and never shown the default's instead; and refused for
 * the default return policy, which every product without one of its own is sold under. A shipping profile
 * gone moves every age-restricted product in the feed, as one written does (`ageRestrictedMoved`): whether
 * one may ship depends on its profile, and the default may be the one that went.
 */
export async function deletePolicy(
  db: Db,
  kind: "shipping" | "returns",
  id: string,
  now: number,
): Promise<PoliciesState> {
  const column = kind === "shipping" ? products.shippingProfileId : products.returnPolicyId;
  const [used] = await db.orm.select({ id: products.id }).from(products).where(eq(column, id)).limit(1);
  if (used) {
    throw new WriteError("wrong_state", "Products still name it: give them another first.", {
      fields: [{ path: "id", problem: "invalid", message: "in use" }],
      details: { code: "in_use", product_id: used.id },
    });
  }
  if (kind === "returns") {
    const state = await loadPolicies(db);
    if (state.return_policies.find((p) => p.id === id)?.default) {
      throw new WriteError("wrong_state", "This is your default return policy: make another the default first.", {
        fields: [{ path: "id", problem: "invalid", message: "the default" }],
        details: { code: "default_policy" },
      });
    }
  }
  const table = kind === "shipping" ? "shipping_profiles" : "return_policies";
  const r = await db.client.query({ sql: `DELETE FROM ${table} WHERE id = ?`, params: [id], method: "run" });
  if (r.changes !== 1) {
    throw new WriteError("not_found", "There is no such one.", {
      fields: [{ path: "id", problem: "invalid", message: "unknown" }],
    });
  }
  if (kind === "shipping") await db.batch([ageRestrictedMoved(now)]);
  return loadPolicies(db);
}

/**
 * Every age-restricted product to a new position in the feed: run when a shipping profile is written or
 * taken away, since whether an age-restricted product may ship (a service that checks ID at handover)
 * is read from its profile, or the default, and the item changes with it without a write of its own.
 */
export function ageRestrictedMoved(now: number): Statement {
  return {
    sql: `UPDATE products SET catalogue_seq = ${NEXT_CATALOGUE_SEQ}, updated_at = ? WHERE age_restricted IS NOT NULL`,
    params: [now],
    method: "run",
  };
}

/* --- a shipping quote ---------------------------------------------------------------------------- */

/** One line of a basket a customer's assistant asks a shipping quote for. */
export const quoteShippingInput = z.object({
  lines: z
    .array(
      z.object({
        product_id: z.string().min(1).max(256),
        quantity: z.number().int().min(1).max(10_000),
      }),
    )
    .min(1)
    .max(50),
  destination: z.object({
    country: z.string().regex(/^[A-Za-z]{2}$/, "a two-letter country code"),
    region: z
      .string()
      .regex(/^[A-Za-z]{2}-[A-Za-z0-9]{1,3}$/)
      .optional()
      .describe("ISO 3166-2, when a rate depends on it: PT-20 (the Azores)."),
    postal_code: z.string().trim().min(1).max(16).optional(),
  }),
});
export type QuoteShippingInput = z.infer<typeof quoteShippingInput>;

/** What it costs to ship a basket to a place, by the business's own rate tables. */
export interface ShippingQuoteAnswer {
  /** One for each shipping profile the basket's products are under, with the products it covers. */
  readonly quotes: readonly {
    readonly profile: string | null;
    readonly zone: string | null;
    readonly product_ids: readonly string[];
    readonly services: readonly QuotedService[];
    readonly why?: "no_profile" | "not_shipped_there";
  }[];
  /** Lines that are not shipped at all, or have no price to work a rate from, with why. */
  readonly unquoted: readonly {
    readonly product_id: string;
    readonly why: "unknown_product" | "not_on_sale" | "not_shipped" | "not_priced";
  }[];
  /** The words to show beside an age-restricted line: ID checked at handover. */
  readonly notes: readonly string[];
}

/**
 * The shipping quote, a pure read (`quoteShipping`, `vectors/catalogue-policies.json`): each line's
 * product as the catalogue has it (its price, its weight, whether it is age-restricted), grouped by the
 * profile it ships under, each group quoted by that profile. A product whose ways to reach the buyer
 * leave out shipping, or whose price is not fixed, is not quoted. Nothing is written.
 */
export async function quoteBasket(db: Db, input: QuoteShippingInput): Promise<ShippingQuoteAnswer> {
  const state = await loadPolicies(db);
  const ids = [...new Set(input.lines.map((l) => l.product_id))];
  // At most 50 lines: one IN, well under the 100 values D1 binds to a statement.
  const rows = ids.length ? await db.orm.select().from(products).where(inArray(products.id, ids)) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const unquoted: { product_id: string; why: ShippingQuoteAnswer["unquoted"][number]["why"] }[] = [];
  const groups = new Map<
    string,
    { profile: string | null; lines: { id: string; line: Parameters<typeof quoteShipping>[1]["lines"][number] }[] }
  >();
  let aged = false;
  for (const l of input.lines) {
    const p = byId.get(l.product_id);
    if (!p) {
      unquoted.push({ product_id: l.product_id, why: "unknown_product" });
      continue;
    }
    if (p.active !== 1) {
      unquoted.push({ product_id: p.id, why: "not_on_sale" });
      continue;
    }
    const methods = p.fulfilMethods ?? null;
    if (methods && !methods.includes("shipping")) {
      unquoted.push({ product_id: p.id, why: "not_shipped" });
      continue;
    }
    if (p.priceModel !== "fixed" || !(p.price.value > 0)) {
      unquoted.push({ product_id: p.id, why: "not_priced" });
      continue;
    }
    // A menu's own age too (ADR-040): a beer goes only by a service that checks ID.
    const age = productAge(p) !== null;
    if (age) aged = true;
    // By the profile it ships under, as a reader resolves it: one that names the default and one that
    // names none are one basket, charged once and free over its value together.
    const profile = p.shippingProfileId ?? state.read.default_shipping_profile;
    const key = profile ?? "";
    const g = groups.get(key) ?? { profile, lines: [] };
    g.lines.push({
      id: p.id,
      line: {
        price: { value: p.price.value, currency: p.price.currency.toUpperCase() },
        quantity: l.quantity,
        weight: p.weight ?? null,
        age_restricted: age,
      },
    });
    groups.set(key, g);
  }
  const destination: QuoteDestination = {
    country: input.destination.country.toUpperCase(),
    region: input.destination.region?.toUpperCase() ?? null,
    postal_code: input.destination.postal_code ?? null,
  };
  const quotes = [...groups.values()].map((g) => {
    const q = quoteShipping(state.read, {
      shipping_profile: g.profile,
      lines: g.lines.map((x) => x.line),
      destination,
    });
    return { ...q, product_ids: [...new Set(g.lines.map((x) => x.id))] };
  });
  return {
    quotes,
    unquoted,
    notes: aged ? ["An age-restricted product goes only by a service whose carrier checks ID at handover."] : [],
  };
}
