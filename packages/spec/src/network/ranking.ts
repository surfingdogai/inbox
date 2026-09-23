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
  rankingV4Schema,
  rankingV3Schema,
  rankingV2Schema,
  rankingV1Schema,
]);
export type RankingDocument = z.infer<typeof rankingDocumentSchema>;

/**
 * The rules a network applies now, and the next ones it has announced: what an inbox reads daily
 * to decide what to send (v2 receipts go to networks at version 3 or later, §2.5).
 */
export function rulesOf(doc: RankingDocument): { inForce: number; next: z.infer<typeof nextRulesSchema> | null } {
  if (doc.version === 1) return { inForce: 1, next: null };
  return { inForce: doc.version, next: doc.next };
}
