import { z } from "zod";
import { nextRulesSchema, timestampSchema } from "./common";
import { outcomeCodeSchema } from "./receipts";

/**
 * `GET /v1/ranking` (ADR-017 §7.3, §11, §14): the machine-readable rules. Without `version` it is the
 * version in force; `?version=N` answers any version ever published, for ever. A version is
 * announced at least 15 days before it takes effect, in `next` here and in `next_rules` on signed
 * pings. Every number a network may choose is published under these names.
 */

const days = z.int().min(0);

export const rankingOrderSchema = z.object({
  listed: z.string(),
  answering: z.string(),
  answering_hours: z.int().min(1),
  not_answering_since: z.string(),
  snapshot: z.string(),
  rank_score_int: z.string(),
  ranked_from: z.number(),
  ranked_from_int: z.int(),
  rank_shuffle: z.string(),
  rank_pos: z.string(),
  near: z.object({
    parameter: z.string(),
    radius_km: z.number().positive(),
    radius_km_max: z.number().positive(),
    order: z.string(),
    distance: z.string(),
  }),
  cursor: z.string(),
});

export const rankingScoreSchema = z.object({
  method: z.string(),
  formula: z.string(),
  z: z.number().positive(),
  z2: z.number().positive(),
  share: z.string(),
  confidence_business: z.string(),
  confidence_person: z.string(),
  word_cap_units: z.number().positive(),
  stored_decimals: z.int(),
  compared_as: z.string(),
  computed: z.string(),
  perfect_record: z.string(),
  counterparty_snapshot: z.string(),
});

export const rankingWeightsSchema = z.object({
  piece: z.string(),
  outcomes: z.array(
    z.object({
      code: outcomeCodeSchema,
      business: z.string().optional(),
      customer: z.string().optional(),
      o: z.number().nullable(),
      o_with_notice: z.number().optional(),
      by: z.string(),
    }),
  ),
  presumed: z.number(),
  presumed_when: z.string(),
  time: z.array(z.object({ up_to_days: z.int().nullable(), t: z.number().positive() })),
  time_from: z.string(),
  source: z.object({
    verified: z.number(),
    counterparty: z.string(),
    counterparty_full_at: z.number(),
    u: z.string(),
  }),
  repeat: z.object({
    formula: z.string(),
    cap: z.number(),
    step: z.number(),
    customer_broken_cap: z.number(),
    pair: z.string(),
  }),
  dispute: z.number(),
  never_counts: z.array(z.string()),
  which_outcome_stands: z.string(),
  report_weighs: z.string(),
  contest_weighs: z.string(),
});

export const rankingTimingSchema = z.object({
  hold_days: days,
  release_units_per_month: z.int().min(0),
  release_month_days: days,
  release_until_day: days,
  unclosed_after_days: days,
  business_notice_hours: z.int().min(0),
  late_customer_cancel_hours: z.int().min(0),
  late_promise_hours: z.int().min(0),
  broken_dated_arrival_hours: z.int().min(0),
  auto_complete_hours: z.int().min(0),
  order_lapse_days: days,
  order_due_days: days,
  report_opens_hours: z.int().min(0),
  report_window_days: days,
  dispute_days: days,
  future_iat_seconds: z.int().min(0),
  rules_notice_days: days,
  nightly: z.string(),
  rank_snapshot: z.string(),
  shuffle: z.string(),
});

export const rankingVerifiedSchema = z.object({
  routes: z.array(z.string()),
  recognised_platforms: z.array(z.string()).describe("Platforms whose Web Bot Auth directory vouches a key (§4)."),
  established: z.object({
    tier: z.string(),
    unrelated_businesses: z.int(),
    each_trusted_when_issued: z.boolean(),
    span_days: days,
    email: z.string(),
  }),
  related: z.array(z.string()),
  mutually_unrelated: z.string(),
  psl_snapshot: z.string().describe("The date of the embedded Public Suffix List."),
  private_suffixes: z.array(z.string()),
  egress_ignored: z.array(z.string()),
  customers_one_domain: z.string(),
  not_observed: z.array(z.string()).optional(),
});

const tierRuleSchema = z.object({
  min_score: z.number(),
  distinct_customers: z.int().optional(),
  unrelated_businesses: z.int().optional(),
});
const tierSetSchema = z.object({ trusted: tierRuleSchema, building: tierRuleSchema, new: z.string() });

export const rankingTiersSchema = z.object({
  business: tierSetSchema,
  person: tierSetSchema,
  distinct_customer: z.string(),
  ranked: z.string(),
});

export const rankingLimitsSchema = z.object({
  issuance_per_business_per_day: z.int(),
  passes_per_key_per_day: z.int(),
  instance_calls_per_minute: z.int(),
  presentations_per_person_per_business_per_day: z.int(),
  pass_strings: z.int(),
  pass_string_chars: z.int(),
  per_entries: z.int(),
  promises_per_business_per_day: z.int(),
  unusual_use_businesses_per_24h: z.int(),
  signature_seconds: z.int(),
  signature_skew_seconds: z.int(),
  code_digits: z.int(),
  code_minutes: z.int(),
  code_tries: z.int(),
  codes_per_hour_per_address: z.int(),
  session_hours: z.int(),
  issuance_replay_days: z.int(),
  networks_per_inbox: z.int(),
  listing_limit_max: z.int(),
  unusual_use_signing_keys: z.int(),
});

export const rankingChangeSchema = z.object({
  version: z.int().min(1),
  rules: z.string().optional(),
  published_at: timestampSchema,
  effective_at: timestampSchema,
  summary: z.string(),
  url: z.url(),
});

/** Version 3: network rules 0.1 (ADR-017). */
export const rankingV3Schema = z.object({
  version: z.literal(3),
  rules: z.string().describe('The rules name, "0.1".'),
  status: z.enum(["announced", "in_force", "retired"]),
  published_at: timestampSchema,
  effective_at: timestampSchema,
  summary: z.string(),
  order: rankingOrderSchema,
  score: rankingScoreSchema,
  weights: rankingWeightsSchema,
  timing: rankingTimingSchema,
  verified: rankingVerifiedSchema,
  tiers: rankingTiersSchema,
  limits: rankingLimitsSchema,
  never_used: z
    .array(z.string())
    .describe("What the order never reads: advertising, money, amounts, who is searching…"),
  changelog: z.array(rankingChangeSchema),
  next: nextRulesSchema.nullable(),
  customer_scoring: z
    .string()
    .optional()
    .describe(
      "Present, on every version from 3 a network serves, while it scores no customer: what that changes (ADR-017 A2.10).",
    ),
});
export type RankingV3 = z.infer<typeof rankingV3Schema>;

/**
 * Version 4: network rules 0.1.1 (ADR-017 Amendment 1, 23 September 2026). The same shape and numbers
 * as version 3; its text says what changed: only a real counter-signature verifies, signed pings only
 * once an inbox signs, no contact-email relation, one mailbox is one customer, and a customer's broken
 * promise counts only once their email is proven.
 */
export const rankingV4Schema = rankingV3Schema.extend({
  version: z.literal(4),
  rules: z.string().describe('The rules name, "0.1.1".'),
});
export type RankingV4 = z.infer<typeof rankingV4Schema>;

/**
 * Version 5: network rules 0.1.2 (ADR-017 Amendment 2, accepted 26 September 2026). Version 4's shape and
 * numbers, with: `order.member` (who may call the network and is scored), `order.listed` now the directory's
 * own predicate, `order.leaving` and `order.set_aside`; `timing.dormant_days`, `timing.dormant_notice_days`
 * and `timing.contest_days`; `limits.listing_changes_per_day`; `weights.stand_ins`, how a customer who
 * stopped a business or erased their record counts there; `weights.contest_weighs`, now what a contest does
 * (A2.9); and `order.filters`, what a search may ask (A2.5, A2.6). In force the moment a network publishes
 * it when no more than one business is a member of it then, otherwise at 00:00 UTC on the sixteenth day after.
 */
export const rankingV5Schema = rankingV4Schema.extend({
  version: z.literal(5),
  rules: z.string().describe('The rules name, "0.1.2".'),
  order: rankingOrderSchema.extend({
    member: z.string(),
    leaving: z.string(),
    set_aside: z.string(),
    filters: z
      .string()
      .optional()
      .describe(
        "What a search may ask, all of which only leaves businesses out, and the words q ignores (A2.5, A2.6).",
      ),
  }),
  timing: rankingTimingSchema.extend({
    dormant_days: days.describe(
      "Silence (no ping that counts, no good manifest fetch) before a business is set aside.",
    ),
    dormant_notice_days: days.describe("The least time between the warning to its contact and being set aside."),
    contest_days: days.describe(
      "How long the business has to dispute a customer's contest; left unanswered, it is upheld (A2.9).",
    ),
  }),
  limits: rankingLimitsSchema.extend({ listing_changes_per_day: z.int() }),
  weights: rankingWeightsSchema.extend({ stand_ins: z.string() }),
});
export type RankingV5 = z.infer<typeof rankingV5Schema>;

/**
 * Version 6: network rules 0.1.3 (ADR-017 Amendment 3, accepted 29 Sep 2026). Version 5's shape and numbers, and what agreed
 * changes and refunds add: the kind `amended` and how far unverified amendments may move a promise, refunds on
 * items of their own with `refund.honoured`, `refund.late` and `refund.cancelled_by_customer`, the report
 * `order.refund_refused` and its window, and `trm` on promises, never scored. In force the moment a network
 * publishes it when no more than one business is a member of it then, otherwise at 00:00 UTC on the sixteenth
 * day after (as version 5's N1).
 */
export const rankingAmendmentsSchema = z.object({
  unverified_max: z.int().min(0).describe("Amendments per item honoured without a verified acknowledgement."),
  due_shift_days_max: days.describe(
    "How far each may move due, and the date R30 reads (a booking's end, else due), either way from the earliest promise's.",
  ),
  dates_from: z.string().describe("Which amendment sets due and end: the latest, by iat then nonce."),
});

export const rankingRefundsSchema = z.object({
  promise: z.string().describe("When a refund's promise is issued, and what its due and amt are."),
  honoured_o: z.number().describe("Weight of refund.honoured, kept for the business."),
  late_o: z.number().describe("Weight of refund.late, broken for the business."),
  report_window_days: days.describe("order.refund_refused may be reported from due + 1 h for this many days."),
});

export const rankingV6Schema = rankingV5Schema.extend({
  version: z.literal(6),
  rules: z.string().describe('The rules name, "0.1.3".'),
  amendments: rankingAmendmentsSchema,
  refunds: rankingRefundsSchema,
});
export type RankingV6 = z.infer<typeof rankingV6Schema>;

/**
 * Version 7: network rules 0.2.0 (protocol 0.2, October 2026). Version 6's shape and numbers, with an order that lists
 * agent-ready businesses with their doors (§4.8, §4.9): `order.rule` (the rule in one paragraph), `order.bands` (a
 * search's words or category put name, categories and services before description), `order.reach` (an inbox that
 * answers, then other live doors by level, then the rest), `order.within_reach`, `order.newcomers` (every 5th place),
 * `order.one_place`, `order.nearest`, `order.found_tier` (entries the network found, and how they stand until version 7
 * takes effect), `order.sources` (which values count in a filter) and `order.filters`. Published with 15 days' notice.
 */
export const rankingOrderV7Schema = rankingV6Schema.shape.order.extend({
  rule: z.string(),
  bands: z.object({ "1": z.string(), "2": z.string(), computed: z.string() }),
  reach: z.object({ "1": z.string(), "2": z.string(), "3": z.string() }),
  within_reach: z.string(),
  newcomers: z.object({ every: z.literal(5), who: z.string(), how: z.string(), days: z.int() }),
  one_place: z.string(),
  nearest: z.string(),
  found_tier: z.string(),
  filters: z.string(),
  sources: z.string(),
});

export const rankingV7Schema = rankingV6Schema.extend({
  version: z.literal(7),
  rules: z.literal("0.2.0").describe('The rules name, "0.2.0".'),
  order: rankingOrderV7Schema,
});
export type RankingV7 = z.infer<typeof rankingV7Schema>;

/** Version 2: the neutral order during the redesign (22 September 2026). */
export const rankingV2Schema = z.object({
  version: z.literal(2),
  status: z.enum(["in_force", "retired"]),
  effective_at: timestampSchema,
  summary: z.string(),
  order: z.object({ default: z.string(), near: z.string() }),
  never_used: z.array(z.string()),
  next: nextRulesSchema.nullable(),
});
export type RankingV2 = z.infer<typeof rankingV2Schema>;

/** Version 1, published and withdrawn on 22 September 2026; kept so `?version=1` answers for ever. */
export const rankingV1Schema = z.looseObject({ version: z.literal(1), status: z.literal("withdrawn") });

export const rankingDocumentSchema = z.discriminatedUnion("version", [
  rankingV7Schema,
  rankingV6Schema,
  rankingV5Schema,
  rankingV4Schema,
  rankingV3Schema,
  rankingV2Schema,
  rankingV1Schema,
]);
export type RankingDocument = z.infer<typeof rankingDocumentSchema>;

/**
 * A version newer than any this package knows (§4.4): a reader takes what every version has, `version`, `status`,
 * `effective_at`, `summary` and `next`, and reads the receipt claims as `claimsFromVersion` says.
 */
export const rankingFutureSchema = z.looseObject({
  version: z.int().min(8),
  status: z.enum(["announced", "in_force", "retired"]),
  effective_at: timestampSchema,
  summary: z.string(),
  next: nextRulesSchema.nullable(),
});
export type RankingFuture = z.infer<typeof rankingFutureSchema>;

/** A rules document as a reader takes it: a version it knows, whole, or a newer one, leniently. */
export type RankingRead =
  | { readonly ok: true; readonly known: true; readonly document: RankingDocument }
  | { readonly ok: true; readonly known: false; readonly document: RankingFuture }
  | { readonly ok: false; readonly error: z.ZodError };

/**
 * Reads a rules document (§4.4): a version this package knows must match its schema whole; a newer one is read by
 * what every version has, so a reader never breaks when a network moves on.
 */
export function readRankingDocument(doc: unknown): RankingRead {
  const known = rankingDocumentSchema.safeParse(doc);
  if (known.success) return { ok: true, known: true, document: known.data };
  const future = rankingFutureSchema.safeParse(doc);
  if (future.success) return { ok: true, known: false, document: future.data };
  return { ok: false, error: known.error };
}

/* --- levels (protocol §10) ------------------------------------------------------------------ */

/**
 * What a network offers. `directory`: it lists businesses and keeps their receipts, and offers none
 * of §5 (persons, passes, reports, contests, unlinks), which it answers `404`; `full`: all of it.
 */
export const networkLevelSchema = z.enum(["directory", "full"]);
export type NetworkLevel = z.infer<typeof networkLevelSchema>;

/**
 * The receipt claims a network takes (§4.4, §6): `1`, the promises `confirmed` and `paid` as
 * ADR-016 wrote them; `2`, every promise, acceptance and outcome (§6); `6`, also agreed changes and
 * refunds (§6.1).
 */
export const receiptClaimsSchema = z.union([z.literal(1), z.literal(2), z.literal(6)]);
export type ReceiptClaimsVersion = z.infer<typeof receiptClaimsSchema>;

/** `protocol` in a rules document (§10): what the network offers, said outright. */
export const networkProtocolSchema = z.object({
  level: networkLevelSchema,
  claims: receiptClaimsSchema,
});
export type NetworkProtocol = z.infer<typeof networkProtocolSchema>;

/**
 * The rules document of a network that publishes its own rules rather than ADR-017's (§10): the
 * members every rules document has, and `protocol`. Its order is its own, said in `summary`; a
 * version is announced in `next` before it takes effect, as §4.4 says. Unknown members are allowed.
 */
export const directoryRulesSchema = z.looseObject({
  version: z.int().min(1),
  status: z.enum(["announced", "in_force", "retired"]),
  effective_at: timestampSchema,
  summary: z.string().min(1).describe("How this network orders its directory, in plain words."),
  next: nextRulesSchema.nullable(),
  protocol: networkProtocolSchema,
});
export type DirectoryRules = z.infer<typeof directoryRulesSchema>;

/**
 * The claims a network that says nothing of them takes, from its rules version alone: how every
 * network was read before levels existed (§4.4). The Surfing Dog network's versions 3 to 5 take
 * claims 2, and from version 6 claims 6.
 */
export function claimsFromVersion(version: number): ReceiptClaimsVersion {
  return version >= 6 ? 6 : version >= 3 ? 2 : 1;
}

/**
 * What a rules document says the network offers, read leniently: its `protocol` when it has a good
 * one; otherwise `full`, with the claims its version implies. Null when it is not a rules document.
 */
export function protocolOf(doc: unknown): NetworkProtocol | null {
  const d = doc as { version?: unknown; protocol?: unknown } | null;
  if (typeof d !== "object" || d === null) return null;
  const said = networkProtocolSchema.safeParse(d.protocol);
  if (said.success) return said.data;
  if (typeof d.version !== "number" || !Number.isInteger(d.version) || d.version < 1) return null;
  return { level: "full", claims: claimsFromVersion(d.version) };
}

/**
 * The rules a network applies now, and the next ones it has announced: what an inbox reads daily
 * to decide what to send (v2 receipts go to networks at version 3 or later, §2.5; agreed changes
 * and refunds to those at version 6 or later, Amendment 3).
 */
export function rulesOf(doc: RankingDocument | RankingFuture): {
  inForce: number;
  next: z.infer<typeof nextRulesSchema> | null;
} {
  if (doc.version === 1) return { inForce: 1, next: null };
  return { inForce: doc.version, next: (doc as { next: z.infer<typeof nextRulesSchema> | null }).next };
}
