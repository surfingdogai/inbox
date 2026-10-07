import { z } from "zod";
import { timestampSchema } from "./common";
import { doorTypeSchema, levelNameSchema } from "./directory";

/**
 * Capabilities and the agentic score (`docs/protocol/network.md` §4.13, optional for a network): what an AI agent can
 * do with a business through doors the business published, capability by capability, and one score over the
 * capabilities that apply to its kind of business. The vocabulary is `vocab/capabilities.json`, the rules
 * `vocab/score-rules-v1.json` (a network serves its own at `GET /v1/score-rules`), and `vectors/score.json` pins the
 * arithmetic. The score never changes a business's place in the directory's search order.
 */

/** The capabilities, in vocabulary order: that order breaks every tie. */
export const CAPABILITY_IDS = [
  "find",
  "catalogue",
  "availability",
  "message",
  "negotiate",
  "book",
  "order",
  "pay",
  "change",
  "cancel",
  "track",
  "return",
  "receipt",
  "feedback",
  "subscription",
  "vouchers",
  "waitlist",
  "support",
  "policies",
] as const;
export const capabilityIdSchema = z.enum(CAPABILITY_IDS);
export type CapabilityId = z.infer<typeof capabilityIdSchema>;

/** The five a result leads with: can an agent message, book, order, cancel or negotiate here? */
export const LEAD_CAPABILITIES = ["message", "book", "order", "cancel", "negotiate"] as const;
export const leadCapabilitySchema = z.enum(LEAD_CAPABILITIES);

/** yes; partial (behind a customer account, or payment only described); no; na (does not apply to this kind). */
export const capabilityStateSchema = z.enum(["yes", "partial", "no", "na"]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

/**
 * How we know: `declared`, the business's own site or door says so; `tested`, a probe tried it; `proven`, agents
 * reported using it. A network produces `declared` first; the others are later steps of the same ladder.
 */
export const evidenceSchema = z.enum(["declared", "tested", "proven"]);
export type Evidence = z.infer<typeof evidenceSchema>;

export const journeySchema = z.enum(["before", "doing", "after", "ongoing", "policies"]);

/** `vocab/capabilities.json`. */
export const capabilitiesVocabSchema = z.object({
  version: z.int().min(1),
  name: z.string(),
  states: z.array(capabilityStateSchema),
  evidence: z.array(evidenceSchema),
  produced: z.array(evidenceSchema),
  lead: z.array(capabilityIdSchema),
  journeys: z.array(journeySchema),
  capabilities: z.array(
    z.object({ id: capabilityIdSchema, journey: journeySchema, label: z.string(), question: z.string() }),
  ),
});
export type CapabilitiesVocab = z.infer<typeof capabilitiesVocabSchema>;

/** The kind of business a score is computed for: only the capabilities that apply to it count. */
export const profileIdSchema = z.enum(["appointments", "food", "trades", "shop", "stay", "memberships", "general"]);
export type ProfileId = z.infer<typeof profileIdSchema>;

export const scoreGroupIdSchema = z.enum(["core", "after", "state", "negotiate", "readable", "find", "unscored"]);
export type ScoreGroupId = z.infer<typeof scoreGroupIdSchema>;

export const gradeSchema = z.enum(["A", "B", "C", "D", "E"]);
export type Grade = z.infer<typeof gradeSchema>;

const fixTextSchema = z.object({
  title: z.string(),
  how: z
    .string()
    .describe('"<door>" stands for " on your <door label> door at <url>" when the business has a live agent door.'),
});

/** `GET /v1/score-rules[?version=N]`: the score's published rules, versioned like the directory's own. */
export const scoreRulesSchema = z.object({
  version: z.int().min(1),
  name: z.string(),
  status: z.enum(["in_force", "announced", "retired"]),
  published_at: timestampSchema,
  effective_at: timestampSchema,
  summary: z.string(),
  vocabulary: z.string(),
  capabilities: z.array(
    z.object({
      id: capabilityIdSchema,
      journey: journeySchema,
      label: z.string(),
      question: z.string(),
      group: scoreGroupIdSchema,
    }),
  ),
  groups: z.array(
    z.object({ id: scoreGroupIdSchema, weight: z.int().min(0).max(100), members: z.array(capabilityIdSchema) }),
  ),
  profiles: z.array(
    z.object({
      id: profileIdSchema,
      label: z.string(),
      applicable: z.array(capabilityIdSchema),
      groups: z.array(z.string()).describe("The directory's category groups this profile covers."),
    }),
  ),
  credit: z.object({ yes: z.number(), partial: z.number(), no: z.number() }),
  evidence: z.object({
    declared: z.number(),
    tested: z.number(),
    proven: z.number(),
    produced: z.array(evidenceSchema),
  }),
  formula: z.string(),
  grades: z.array(z.object({ grade: gradeSchema, min: z.int().min(0).max(100) })),
  rank: z.string(),
  named: z.string(),
  directory: z.string(),
  not_certification: z.string(),
  fixes: z.partialRecord(capabilityIdSchema, fixTextSchema),
  changelog: z.array(z.object({ version: z.int().min(1), summary: z.string() })),
});
export type ScoreRules = z.infer<typeof scoreRulesSchema>;

/** The formula of rules version 1, word for word as the rules document carries it. */
export const SCORE_FORMULA_V1 = [
  "For profile P: A_g = members(g) ∩ applicable(P), for each group g with weight > 0. A group with A_g = ∅ is dropped.",
  "possible = Σ_{g: A_g≠∅} W_g",
  "N        = Σ_{g: A_g≠∅} W_g × s_g × (60 / |A_g|)      where s_g = Σ_{c∈A_g} halves(c)   (|A_g| ≤ 5; 60 = lcm(1..5))",
  "D        = 120 × possible",
  "score    = (100 × N + D/2) div D                       (round half up; 0..100)",
  "grade    = A ≥ 80, B ≥ 60, C ≥ 40, D ≥ 20, E < 20",
].join("\n");

/* --- the arithmetic (pure; the network's Go does the same, and vectors/score.json holds both to it) --------------- */

/** A profile by id, or any set of applicable capabilities. */
export type ScoreProfile = ProfileId | { readonly applicable: readonly CapabilityId[] };
export type CapabilityStates = Partial<Record<CapabilityId, CapabilityState>>;

export interface Score {
  readonly score: number;
  readonly grade: Grade;
  /** The numerator, an integer: the exact arithmetic two implementations compare. */
  readonly n: number;
  /** The sum of the weights of the groups that apply. */
  readonly possible: number;
}

export interface Fix {
  readonly capability: CapabilityId;
  readonly points: number;
}

const HALVES: Record<CapabilityState, number> = { yes: 2, partial: 1, no: 0, na: 0 };

function applicableOf(profile: ScoreProfile, rules: Pick<ScoreRules, "profiles">): ReadonlySet<CapabilityId> {
  if (typeof profile !== "string") return new Set(profile.applicable);
  const p = rules.profiles.find((x) => x.id === profile);
  if (!p) throw new Error(`the rules have no profile ${profile}`);
  return new Set(p.applicable);
}

/** Each scored group's applicable members, in the rules' group order; a group nothing applies to is dropped. */
function groupsOf(applicable: ReadonlySet<CapabilityId>, rules: Pick<ScoreRules, "groups">) {
  return rules.groups
    .filter((g) => g.weight > 0)
    .map((g) => ({ id: g.id, weight: g.weight, members: g.members.filter((c) => applicable.has(c)) }))
    .filter((g) => g.members.length > 0);
}

export function gradeOf(score: number, rules?: Pick<ScoreRules, "grades">): Grade {
  const grades = [...(rules?.grades ?? DEFAULT_GRADES)].sort((a, b) => b.min - a.min);
  return grades.find((g) => score >= g.min)?.grade ?? "E";
}
const DEFAULT_GRADES: { grade: Grade; min: number }[] = [
  { grade: "A", min: 80 },
  { grade: "B", min: 60 },
  { grade: "C", min: 40 },
  { grade: "D", min: 20 },
  { grade: "E", min: 0 },
];

/** The agentic score of one business, by the rules' integer formula. */
export function scoreOf(
  profile: ScoreProfile,
  states: CapabilityStates,
  rules: Pick<ScoreRules, "groups" | "profiles" | "grades">,
): Score {
  const groups = groupsOf(applicableOf(profile, rules), rules);
  let possible = 0;
  let n = 0;
  for (const g of groups) {
    const s = g.members.reduce((sum, c) => sum + HALVES[states[c] ?? "no"], 0);
    possible += g.weight;
    n += g.weight * s * (60 / g.members.length);
  }
  if (possible === 0) return { score: 0, grade: gradeOf(0, rules), n: 0, possible: 0 };
  const d = 120 * possible;
  const score = Math.floor((100 * n + d / 2) / d);
  return { score, grade: gradeOf(score, rules), n, possible };
}

/**
 * What would raise the score most: each applicable, weighted capability that is not yet "yes", scored again as "yes".
 * Fixes worth nothing are left out. By points, then group order, then vocabulary order.
 */
export function fixesOf(
  profile: ScoreProfile,
  states: CapabilityStates,
  rules: Pick<ScoreRules, "groups" | "profiles" | "grades" | "capabilities">,
): Fix[] {
  const groups = groupsOf(applicableOf(profile, rules), rules);
  const base = scoreOf(profile, states, rules).score;
  const groupAt = new Map(rules.groups.map((g, i) => [g.id, i]));
  const vocabAt = new Map(rules.capabilities.map((c, i) => [c.id, i]));
  const fixes: (Fix & { g: number; v: number })[] = [];
  for (const g of groups) {
    for (const c of g.members) {
      if ((states[c] ?? "no") === "yes") continue;
      const points = scoreOf(profile, { ...states, [c]: "yes" }, rules).score - base;
      if (points > 0) fixes.push({ capability: c, points, g: groupAt.get(g.id) ?? 99, v: vocabAt.get(c) ?? 99 });
    }
  }
  fixes.sort((a, b) => b.points - a.points || a.g - b.g || a.v - b.v);
  return fixes.map(({ capability, points }) => ({ capability, points }));
}

/** A capability's displayed weight, W_g / |A_g| to one decimal place; 0 when it is not scored or does not apply. */
export function capabilityWeightOf(
  profile: ScoreProfile,
  capability: CapabilityId,
  rules: Pick<ScoreRules, "groups" | "profiles">,
): number {
  const g = groupsOf(applicableOf(profile, rules), rules).find((x) => x.members.includes(capability));
  return g ? Math.round((g.weight / g.members.length) * 10) / 10 : 0;
}

/* --- names to capabilities (the door registry's capability_rules) ---------------------------------------------------- */

/** What `capsOfName` reads from a door registry: its capability rules and the words an HTTP method adds. */
export interface CapabilityRules {
  readonly capability_rules: readonly {
    readonly cap: string;
    readonly all: readonly (readonly string[])[];
    readonly none?: readonly string[];
  }[];
  readonly method_words: Readonly<Record<string, readonly string[]>>;
}

/** A name's words: split on anything not a letter or digit and on lower-to-upper camelCase, lower-cased. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * The capabilities a tool, skill or operation name maps to: a rule holds when each of its `all` lists shares a word
 * with the name and none of its `none` words is there. `method` (an operation's) adds the registry's words for it.
 */
export function capsOfName(rules: CapabilityRules, name: string, method?: string): CapabilityId[] {
  const words = new Set(wordsOf(name));
  for (const w of method ? (rules.method_words[method.toUpperCase()] ?? []) : []) words.add(w);
  const out: CapabilityId[] = [];
  for (const r of rules.capability_rules) {
    const cap = capabilityIdSchema.safeParse(r.cap);
    if (!cap.success || out.includes(cap.data)) continue;
    if (!r.all.every((list) => list.some((w) => words.has(w)))) continue;
    if ((r.none ?? []).some((w) => words.has(w))) continue;
    out.push(cap.data);
  }
  return out;
}

/** An OpenAPI operation as a door lists it, `"POST /bookings createBooking"`: its method adds words. */
export function capsOfOperation(rules: CapabilityRules, operation: string): CapabilityId[] {
  const [method = "", ...rest] = operation.trim().split(/\s+/);
  return /^(GET|POST|PUT|PATCH|DELETE)$/i.test(method)
    ? capsOfName(rules, rest.join(" "), method)
    : capsOfName(rules, operation);
}

/* --- the checker's answers ------------------------------------------------------------------------------------------ */

/** A door a capability was met through. `webmcp` is experimental: it counts for the score, never for a level. */
export const capabilityDoorSchema = z.object({
  type: doorTypeSchema.or(z.literal("webmcp")),
  url: z.url(),
});

export const leadAnswerSchema = z.enum(["yes", "partly", "no", "not_applicable"]);

export const checkStateSchema = z.enum([
  "not_checked",
  "queued",
  "checking",
  "scoring",
  "done",
  "blocked",
  "failed",
  "hidden",
  "not_checkable",
]);
export type CheckState = z.infer<typeof checkStateSchema>;

export const capabilityBasisSchema = z.enum([
  "tool_name",
  "skill",
  "operation",
  "item_types",
  "protocol",
  "structured_data",
  "page",
  "manifest",
]);

const rulesRef = z.object({ version: z.int().min(1), url: z.url() });

/** `GET /b/<domain>.json` and `check_business`: what a check found, and the score when it is done. */
export const checkResultSchema = z.object({
  domain: z.string().max(253),
  site: z.url().optional().describe("The business's own site."),
  url: z.url().describe("Its result page."),
  state: checkStateSchema,
  queue: z
    .object({
      position: z.int().min(0),
      budget: z.enum(["open", "spent", "paused"]),
      retry_after_s: z.int().min(0),
    })
    .optional()
    .describe("Only while queued, checking or scoring."),
  checked_at: timestampSchema.optional(),
  scored_at: timestampSchema.optional(),
  rules: rulesRef.optional().describe("The score rules applied (GET /v1/score-rules?version=N)."),
  agentic_score: z.int().min(0).max(100).optional(),
  grade: gradeSchema.optional(),
  profile: z
    .object({
      id: profileIdSchema,
      label: z.string(),
      from: z.enum(["category", "signals", "default"]),
      category: z.object({ group: z.string(), id: z.string(), label: z.string() }).optional(),
    })
    .optional(),
  level: levelNameSchema.optional(),
  answers: z
    .array(
      z.object({
        capability: leadCapabilitySchema,
        answer: leadAnswerSchema,
        door: capabilityDoorSchema.nullable().optional(),
        how: z.string().optional(),
        checked_at: timestampSchema.optional(),
      }),
    )
    .optional()
    .describe("Message, book, order, cancel and negotiate, in that order."),
  capabilities: z
    .array(
      z.object({
        id: capabilityIdSchema,
        group: scoreGroupIdSchema,
        state: capabilityStateSchema,
        evidence: evidenceSchema.nullable(),
        basis: capabilityBasisSchema.nullable().optional(),
        via: z.string().optional().describe("The tool, skill, operation or field it was read from."),
        door: capabilityDoorSchema.nullable().optional(),
        source_url: z.url().optional(),
        checked_at: timestampSchema.optional(),
        weight: z.number().min(0),
        points: z.number().min(0),
        note: z.string().optional(),
        experimental: z.boolean().optional(),
      }),
    )
    .optional(),
  fixes: z
    .array(z.object({ capability: capabilityIdSchema, points: z.int().min(1), title: z.string(), how: z.string() }))
    .optional(),
  web_person_message: z.string().optional(),
  rank: z
    .object({
      text: z.string(),
      scope: z.object({ group: z.string().optional(), country: z.string().optional(), place: z.string().optional() }),
      position: z.int().min(1),
      of: z.int().min(1),
      overall: z.object({ position: z.int().min(1), of: z.int().min(1) }),
    })
    .optional()
    .describe("Only when done, not hidden and of a kind the directory ranks."),
  indexable: z.boolean(),
  excluded: z.string().optional(),
  not_certification: z.string().optional(),
  badge: z.object({ svg: z.url(), snippet: z.string() }).optional(),
  owner: z.object({ claim: z.string(), hide: z.string(), opt_out: z.string() }).optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

/** `GET /leaderboard.json`: ordered by agentic score, and separate from the directory's search order. */
export const leaderboardSchema = z.object({
  scope: z.object({ category: z.string().optional(), country: z.string().optional(), place: z.string().optional() }),
  rules: rulesRef,
  order: z.string(),
  not_search_order: z.string(),
  total: z.int().min(0),
  unnamed: z.int().min(0),
  page: z.int().min(1),
  next_page: z.int().min(2).nullable(),
  named: z.array(
    z.object({
      position: z.int().min(1),
      domain: z.string(),
      name: z.string(),
      score: z.int().min(0).max(100),
      grade: gradeSchema,
      answers: z.partialRecord(leadCapabilitySchema, leadAnswerSchema),
      checked_at: timestampSchema,
      result_url: z.url(),
    }),
  ),
});
export type Leaderboard = z.infer<typeof leaderboardSchema>;

/** `/.well-known/ai-catalog.json` (ARD), read loosely: what an agent needs to find the doors it lists. */
export const aiCatalogSchema = z.looseObject({
  specVersion: z.string(),
  host: z.looseObject({ displayName: z.string().optional(), identifier: z.string().optional() }),
  entries: z.array(
    z.looseObject({
      identifier: z.string(),
      displayName: z.string(),
      type: z.string(),
      url: z.url(),
    }),
  ),
});
export type AiCatalog = z.infer<typeof aiCatalogSchema>;
