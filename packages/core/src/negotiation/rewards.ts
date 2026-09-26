import { z } from "zod";
import { forbiddenWordIn } from "../customer/words";
import {
  type CustomerContext,
  evaluate,
  NO_AGENT_CONTEXT,
  NO_CUSTOMER,
  NO_PERSON,
  type PersonContext,
  type RuleContext,
} from "../rules/evaluate";
import { type Condition, conditionSchema } from "../rules/schema";
import type { FieldProblem } from "../write/errors";

/**
 * Rewards for good customers (ADR-018 §4, Q3): a better price the owner gives a customer whose record
 * earned it, set by the owner's own rules and applied by the inbox — never chosen by the AI, never
 * below the owner's floor, never above the list price. Pure: the conditions read the customer's
 * standing as the rules do, and nothing else.
 *
 * Who qualifies is written in the rules' own conditions, limited to a record the customer earned: the
 * business's own history with them (`customer_known`, `customer.*`) and their standing as their
 * assistant presented it (`person_trusted`, `person_tier_on`, `person.*`). Anything else, `not`
 * included, is refused when saved, so a reward never reads who or where someone is — and only ever
 * lifts: a customer with no record pays the list price like everyone else.
 */

/** A reward's id, as the owner names it. */
export const REWARD_ID = /^[a-z0-9_-]{1,40}$/;
export const MAX_REWARDS = 20;

/** The functions a reward's condition may call: the customer's own record, and nothing about who they are. */
export const REWARD_FNS: ReadonlySet<string> = new Set(["customer_known", "person_trusted", "person_tier_on"]);
const REWARD_PATH = /^(?:customer|person)\.[a-z_]+(?:\.[a-z0-9_]+)*$/;
/** How sure we are who they are, and what they have open now: neither is something they did here. */
const NOT_A_RECORD = /^customer\.(?:match|open_bookings)(?:\.|$)/;

export const rewardSchema = z.strictObject({
  /** Who earns it: a condition on the customer's record, as the rules write one. */
  if: conditionSchema,
  /** Percent off the list price, 1 to 50. */
  pct: z.number().min(1).max(50),
  /** The products and services it covers, by id; null for every one. */
  only: z.array(z.string().min(1).max(64)).min(1).max(200).nullable().default(null),
  /** A line of the owner's for the customer, after the notice: "Thank you for coming back." */
  says: z.string().trim().min(1).max(200).optional(),
});

export interface Reward extends z.infer<typeof rewardSchema> {
  readonly id: string;
}

/** The customer's standing, as a reward reads it. */
export interface Standing {
  readonly customer: CustomerContext;
  readonly person: PersonContext;
}

export const NO_STANDING: Standing = { customer: NO_CUSTOMER, person: NO_PERSON };

/** Why a condition may not decide a reward, or null when it may. */
export function rewardConditionProblem(c: Condition): string | null {
  if ("all" in c || "any" in c) {
    const group = "all" in c ? c.all : c.any;
    if (group.length === 0) return "say who earns it: an empty group is everyone, which is a price, not a reward";
    for (const inner of group) {
      const problem = rewardConditionProblem(inner);
      if (problem) return problem;
    }
    return null;
  }
  if ("not" in c) return "a reward reads what a customer earned, never what they are not";
  if ("fn" in c) {
    return REWARD_FNS.has(c.fn)
      ? null
      : `${c.fn} is not the customer's record: use customer_known, person_trusted or person_tier_on`;
  }
  if (NOT_A_RECORD.test(c.path)) {
    return `${c.path} is not what the customer did here: a reward reads what they completed, paid and kept`;
  }
  return REWARD_PATH.test(c.path)
    ? null
    : `${c.path} is not the customer's record: a reward reads customer.* and person.* only`;
}

/**
 * Customers with no record here, however they came: nobody known, an address we could not be sure of,
 * a customer we recognise with nothing done yet, a person their assistant presented with nothing to
 * show. A reward only ever lifts (Q3): whoever has no record pays the list price like everyone else, so
 * a condition any of them meets — "no no-shows", "not trusted", "not presented" — is not a reward but a
 * price for everyone except those with something against them, which counts against a customer as
 * ADR-017 never lets a price do.
 */
const NO_RECORD: readonly Standing[] = [
  NO_STANDING,
  { customer: { ...NO_CUSTOMER, match: "weak" }, person: NO_PERSON },
  { customer: { ...NO_CUSTOMER, match: "strong", open_bookings: 1 }, person: NO_PERSON },
  {
    customer: NO_CUSTOMER,
    person: { ...NO_PERSON, present: true, networks: [{ network: "", tier: "new", score: 0, kept: 0, broken: 0 }] },
  },
];

/** Why a condition may not decide a reward because a customer with no record would earn it, or null. */
function everyoneProblem(c: Condition): string | null {
  return NO_RECORD.some((standing) => evaluate(c, contextOf(standing)))
    ? "a customer with no record here would earn it, so it is a price for everyone but those with something against them: say what a customer did to earn it"
    : null;
}

/**
 * What is wrong with `raw`, the rewards as a settings write would leave them, as field problems under
 * `prefix` (`doc.negotiation.rewards`). Empty when they may be saved.
 */
export function rewardProblems(raw: unknown, prefix: string): FieldProblem[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return [{ path: prefix, problem: "invalid", message: "rewards are an object keyed by a name of yours" }];
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  const problems: FieldProblem[] = [];
  if (entries.length > MAX_REWARDS) {
    problems.push({ path: prefix, problem: "invalid", message: `at most ${MAX_REWARDS} rewards` });
  }
  for (const [id, value] of entries) {
    const at = `${prefix}.${id}`;
    if (!REWARD_ID.test(id)) {
      problems.push({ path: at, problem: "invalid", message: "a name of lower-case letters, digits, - and _" });
      continue;
    }
    const parsed = rewardSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = [at, ...issue.path.map(String)].join(".");
        problems.push({ path, problem: issue.code === "invalid_type" ? "missing" : "invalid", message: issue.message });
      }
      continue;
    }
    const why = rewardConditionProblem(parsed.data.if) ?? everyoneProblem(parsed.data.if);
    if (why) problems.push({ path: `${at}.if`, problem: "invalid", message: why });
    const word = parsed.data.says ? forbiddenWordIn(parsed.data.says) : null;
    if (word) {
      problems.push({
        path: `${at}.says`,
        problem: "invalid",
        message: `"${word}" is not a word to say to a customer: they only ever hear from you`,
      });
    }
  }
  return problems;
}

/** The rewards the owner saved, as the inbox applies them: one that does not check out is never applied. */
export function rewardsOf(raw: unknown): Reward[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const out: Reward[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_REWARDS)) {
    if (!REWARD_ID.test(id)) continue;
    const parsed = rewardSchema.safeParse(value);
    if (!parsed.success || rewardConditionProblem(parsed.data.if) || everyoneProblem(parsed.data.if)) continue;
    const says = parsed.data.says && !forbiddenWordIn(parsed.data.says) ? parsed.data.says : undefined;
    out.push({ ...parsed.data, id, ...(says ? { says } : { says: undefined }) });
  }
  return out;
}

/** The context a reward's condition is evaluated in: the customer's standing, and nothing else. */
function contextOf(standing: Standing): RuleContext {
  return {
    item: {},
    event: { event: "", from: null, to: "", actorKind: "", depth: 0 },
    party: { kind: "unknown", tier: "anonymous" },
    person: standing.person,
    customer: standing.customer,
    agent: NO_AGENT_CONTEXT,
    settings: {},
    now: 0,
    text: "",
    facts: { slotIsFree: null, withinBusinessHours: null },
  };
}

/**
 * The reward this customer earns on the product or service `ref` (its id), or null: the best of those
 * that match — the largest percentage, the first by name on a tie — never several added up.
 */
export function rewardFor(rewards: readonly Reward[], standing: Standing, ref: string): Reward | null {
  const ctx = contextOf(standing);
  let best: Reward | null = null;
  for (const r of [...rewards].sort((a, b) => a.id.localeCompare(b.id))) {
    if (r.only !== null && !r.only.includes(ref)) continue;
    if (!evaluate(r.if, ctx)) continue;
    if (!best || r.pct > best.pct) best = r;
  }
  return best;
}

/**
 * The customer's price P for a list price `list` (minor units) under a reward of `pct` percent:
 * `list × (1 − pct/100)` rounded down to the minor unit, in the customer's favour, never below the
 * owner's floor and never above the list price.
 */
export function rewardPrice(list: number, floor: number | null, pct: number): number {
  const basis = Math.round(pct * 100);
  const cut = list * (10_000 - basis);
  if (!Number.isSafeInteger(cut) || basis <= 0) return list;
  const reduced = Math.floor(cut / 10_000);
  return Math.min(list, Math.max(reduced, floor ?? 0));
}
