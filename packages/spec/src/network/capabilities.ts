import { z } from "zod";
import { timestampSchema } from "./common";
import { doorTypeSchema, levelNameSchema } from "./directory";

/**
 * Capabilities and the agentic score (`docs/protocol/network.md` §4.13, optional for a network): what an AI agent can
 * do with a business through doors the business published, capability by capability, and one score over the
 * capabilities that apply to its kind of business. The vocabulary is `vocab/capabilities.json`, the rules
 * `vocab/score-rules-v2.json` (in force from 7 October 2026; version 1, `vocab/score-rules-v1.json`, is retired, and a
 * network serves its own at `GET /v1/score-rules`), and `vectors/score.json` (`vectors/score-v1.json` for version 1)
 * pins the arithmetic. The score never changes a business's place in the directory's search order.
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
export const profileIdSchema = z.enum([
  "appointments",
  "food",
  "trades",
  "shop",
  "stay",
  "memberships",
  "venues",
  "general",
]);
export type ProfileId = z.infer<typeof profileIdSchema>;

export const scoreGroupIdSchema = z.enum(["core", "after", "state", "negotiate", "readable", "find", "unscored"]);
export type ScoreGroupId = z.infer<typeof scoreGroupIdSchema>;

export const gradeSchema = z.enum(["A", "B", "C", "D", "E"]);
export type Grade = z.infer<typeof gradeSchema>;

const fixHowSchema = z
  .string()
  .describe('"<door>" stands for " on your <door label> door at <url>" when the business has a live agent door.');
const fixTextSchema = z.object({
  title: z.string(),
  how: fixHowSchema,
  by_profile: z
    .partialRecord(profileIdSchema, z.object({ how: fixHowSchema }))
    .optional()
    .describe("Another how for a kind of business."),
  protocol: fixHowSchema
    .optional()
    .describe("The how when the business's preferred door is an agent commerce protocol (UCP, ACP)."),
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
      noun: z.string().describe('What "scored as" says: "a shop".'),
      applicable: z.array(capabilityIdSchema),
      either: z
        .array(z.array(capabilityIdSchema).min(2))
        .optional()
        .describe(
          "Version 2: sets of applicable capabilities of one group that count as one member of it, met by the best " +
            "state any of them has (book or order, for a business of a kind not known).",
        ),
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
  changelog: z.array(
    z.object({
      version: z.int().min(1),
      published: z.iso.date().optional().describe("The day a version was published."),
      amended: z.iso.date().optional().describe("The day a version was amended without a new number."),
      summary: z.string(),
    }),
  ),
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

/** The formula of rules version 2, word for word: version 1's, and either sets counted as one member. */
export const SCORE_FORMULA_V2 = [
  "For profile P: A_g = members(g) ∩ applicable(P), for each group g with weight > 0, where the capabilities of one of P's either sets count as one member of A_g, whose halves are the most any of them has. A group with A_g = ∅ is dropped.",
  "possible = Σ_{g: A_g≠∅} W_g",
  "N        = Σ_{g: A_g≠∅} W_g × s_g × (60 / |A_g|)      where s_g = Σ_{c∈A_g} halves(c)   (|A_g| ≤ 5; 60 = lcm(1..5))",
  "D        = 120 × possible",
  "score    = (100 × N + D/2) div D                       (round half up; 0..100)",
  "grade    = A ≥ 80, B ≥ 60, C ≥ 40, D ≥ 20, E < 20",
].join("\n");

/* --- the arithmetic (pure; the network's Go does the same, and vectors/score.json holds both to it) --------------- */

/** A profile by id, or any set of applicable capabilities (with either sets, version 2). */
export type ScoreProfile =
  | ProfileId
  | { readonly applicable: readonly CapabilityId[]; readonly either?: readonly (readonly CapabilityId[])[] };
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

interface Applying {
  readonly applicable: ReadonlySet<CapabilityId>;
  readonly either: readonly (readonly CapabilityId[])[];
}

function applyingOf(profile: ScoreProfile, rules: Pick<ScoreRules, "profiles">): Applying {
  if (typeof profile !== "string") return { applicable: new Set(profile.applicable), either: profile.either ?? [] };
  const p = rules.profiles.find((x) => x.id === profile);
  if (!p) throw new Error(`the rules have no profile ${profile}`);
  return { applicable: new Set(p.applicable), either: p.either ?? [] };
}

/**
 * Each scored group's slots, in the rules' group order: a slot is one applicable member, or the applicable members of
 * one either set together. A group nothing applies to is dropped.
 */
function groupsOf(a: Applying, rules: Pick<ScoreRules, "groups">) {
  return rules.groups
    .filter((g) => g.weight > 0)
    .map((g) => {
      const slots: CapabilityId[][] = [];
      const counted = new Set<CapabilityId>();
      for (const c of g.members) {
        if (!a.applicable.has(c) || counted.has(c)) continue;
        const set = a.either.find((s) => s.includes(c)) ?? [c];
        const slot = set.filter((x) => a.applicable.has(x));
        for (const x of slot) counted.add(x);
        slots.push(slot);
      }
      return { id: g.id, weight: g.weight, slots };
    })
    .filter((g) => g.slots.length > 0);
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
  const groups = groupsOf(applyingOf(profile, rules), rules);
  let possible = 0;
  let n = 0;
  for (const g of groups) {
    const s = g.slots.reduce((sum, slot) => sum + Math.max(...slot.map((c) => HALVES[states[c] ?? "no"])), 0);
    possible += g.weight;
    n += g.weight * s * (60 / g.slots.length);
  }
  if (possible === 0) return { score: 0, grade: gradeOf(0, rules), n: 0, possible: 0 };
  const d = 120 * possible;
  const score = Math.floor((100 * n + d / 2) / d);
  return { score, grade: gradeOf(score, rules), n, possible };
}

/**
 * What would raise the score most: each applicable, weighted capability that is not yet "yes", scored again as "yes"
 * (each member of an either set on its own). Fixes worth nothing are left out. By points, then group order, then
 * vocabulary order.
 */
export function fixesOf(
  profile: ScoreProfile,
  states: CapabilityStates,
  rules: Pick<ScoreRules, "groups" | "profiles" | "grades" | "capabilities">,
): Fix[] {
  const groups = groupsOf(applyingOf(profile, rules), rules);
  const base = scoreOf(profile, states, rules).score;
  const groupAt = new Map(rules.groups.map((g, i) => [g.id, i]));
  const vocabAt = new Map(rules.capabilities.map((c, i) => [c.id, i]));
  const fixes: (Fix & { g: number; v: number })[] = [];
  for (const g of groups) {
    for (const c of g.slots.flat()) {
      if ((states[c] ?? "no") === "yes") continue;
      const points = scoreOf(profile, { ...states, [c]: "yes" }, rules).score - base;
      if (points > 0) fixes.push({ capability: c, points, g: groupAt.get(g.id) ?? 99, v: vocabAt.get(c) ?? 99 });
    }
  }
  fixes.sort((a, b) => b.points - a.points || a.g - b.g || a.v - b.v);
  return fixes.map(({ capability, points }) => ({ capability, points }));
}

/**
 * A capability's displayed weight, W_g / |A_g| to one decimal place (an either set counted once, each of its members
 * showing the set's weight); 0 when it is not scored or does not apply.
 */
export function capabilityWeightOf(
  profile: ScoreProfile,
  capability: CapabilityId,
  rules: Pick<ScoreRules, "groups" | "profiles">,
): number {
  const g = groupsOf(applyingOf(profile, rules), rules).find((x) => x.slots.some((slot) => slot.includes(capability)));
  return g ? Math.round((g.weight / g.slots.length) * 10) / 10 : 0;
}

/* --- names to capabilities (the door registry's capability_rules) ---------------------------------------------------- */

/**
 * What `capsOfName` reads from a door registry: its capability rules, the words an HTTP method adds, the words that
 * say a name only reads, and the capabilities such a name may meet.
 */
export interface CapabilityRules {
  readonly capability_rules: readonly {
    readonly cap: string;
    readonly all: readonly (readonly string[])[];
    readonly none?: readonly string[];
    readonly alone?: readonly string[];
  }[];
  readonly method_words: Readonly<Record<string, readonly string[]>>;
  readonly read_words?: readonly string[];
  readonly read_only_caps?: readonly string[];
}

/** A name's words: split on anything not a letter or digit and on lower-to-upper camelCase, lower-cased. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Whether each list shares a word with `words`, no word meeting two lists. */
function listsMet(
  lists: readonly (readonly string[])[],
  words: readonly string[],
  used: readonly string[] = [],
): boolean {
  const [first, ...rest] = lists;
  if (!first) return true;
  return words.some((w) => first.includes(w) && !used.includes(w) && listsMet(rest, words, [...used, w]));
}

/**
 * The capabilities a tool, skill or operation name maps to: a rule holds when each of its `all` lists shares a word of
 * its own with the name (or one of its `alone` words is there) and none of its `none` words is. `method` (an
 * operation's) adds the registry's words for it. A name that only reads (one of its words is a read word, an operation
 * by GET, or a tool its server marks read-only: `readOnly`) meets only the registry's read-only capabilities.
 */
export function capsOfName(rules: CapabilityRules, name: string, method?: string, readOnly = false): CapabilityId[] {
  const words = [...new Set([...wordsOf(name), ...(method ? (rules.method_words[method.toUpperCase()] ?? []) : [])])];
  const reads = readOnly || words.some((w) => (rules.read_words ?? []).includes(w));
  const out: CapabilityId[] = [];
  for (const r of rules.capability_rules) {
    const cap = capabilityIdSchema.safeParse(r.cap);
    if (!cap.success || out.includes(cap.data)) continue;
    if (reads && !(rules.read_only_caps ?? []).includes(cap.data)) continue;
    if ((r.none ?? []).some((w) => words.includes(w))) continue;
    if (!(r.alone ?? []).some((w) => words.includes(w)) && !listsMet(r.all, words)) continue;
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
