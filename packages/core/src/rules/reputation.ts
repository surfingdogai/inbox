import type { Action, Condition, RuleDefinition } from "./schema";

/**
 * Positive first (R25, ADR-017 §8.3): a rule that reads anything about a customer's standing — a
 * network's tier or score, the business's own history, how the agent signed, the trust tier — may
 * speed things up or ask a person, and nothing else. It may confirm, accept, request payment, set
 * flags or reply; it may never refuse, cancel, expire or record anything against the customer,
 * and it may not queue a job, whose effect nobody here can see.
 *
 * Refused when saved (`positive_only`); an older rule that does it anyway has those actions
 * skipped and logged when it runs. A rule that only reads what a reputation rule wrote into the
 * flags is caught best-effort: its refusing actions are skipped on items whose flags such a rule set.
 */
export const REPUTATION_FNS: ReadonlySet<string> = new Set([
  "person_trusted",
  "person_tier_on",
  "customer_known",
  "within_customer_limit",
  "party_verified",
]);

/** `person.*`, `customer.*`, `agent.*`, and the trust tier as the party or the event carries it. */
const REPUTATION_PATH = /^(?:person|customer|agent)(?:\.|$)|^(?:party|event)\.tier$/;

/**
 * Events a reputation may never fire: the ADR's `decline`, `cancel`, `cancel_by_business` and
 * `expire`, and with them every other event that refuses a customer, ends their item or records a
 * broken outcome against them (`close` ends a conversation, answered or not, as `mark_spam` does).
 */
export const NEGATIVE_EVENTS: ReadonlySet<string> = new Set([
  "decline",
  "reject",
  "cancel",
  "cancel_late",
  "cancel_by_business",
  "expire",
  "close",
  "mark_spam",
  "no_show",
  "payment_failed",
  "charge_back",
  "record_charge_back",
  "lapse",
]);

export function readsReputation(c: Condition): boolean {
  if ("all" in c) return c.all.some(readsReputation);
  if ("any" in c) return c.any.some(readsReputation);
  if ("not" in c) return readsReputation(c.not);
  if ("fn" in c) return REPUTATION_FNS.has(c.fn);
  return REPUTATION_PATH.test(c.path);
}

export function readsFlags(c: Condition): boolean {
  if ("all" in c) return c.all.some(readsFlags);
  if ("any" in c) return c.any.some(readsFlags);
  if ("not" in c) return readsFlags(c.not);
  if ("fn" in c) return false;
  return c.path === "item.flags" || c.path.startsWith("item.flags.");
}

/** An action a reputation may not take. */
export function isNegative(a: Action): boolean {
  return a.action === "enqueue" || (a.action === "transition" && NEGATIVE_EVENTS.has(a.event));
}

/** Why a rule may not be saved as it is, or null when it may. */
export function positiveOnlyProblem(def: RuleDefinition): string | null {
  if (!readsReputation(def.if)) return null;
  const bad = def.actions.filter(isNegative);
  if (bad.length === 0) return null;
  const what = bad.map((a) => (a.action === "transition" ? a.event : a.action)).join(", ");
  return `a rule that reads a customer's standing may confirm, accept, ask for payment, flag or reply, never ${what} (positive only)`;
}

/** What a held-back action would have done, in the owner's words. */
const WANTED: Readonly<Record<string, string>> = {
  decline: "decline this",
  reject: "reject this",
  cancel: "cancel this",
  cancel_late: "cancel this",
  cancel_by_business: "cancel this",
  expire: "let this expire",
  close: "close this",
  mark_spam: "mark this as spam",
  no_show: "mark this as a no-show",
  payment_failed: "mark the payment as failed",
  charge_back: "record a charge-back",
  record_charge_back: "record a charge-back",
  lapse: "lapse this",
};

/**
 * Why an action was held back, in plain words, for the item's history and a rule's test (ADR-017
 * §8.3): the rule read the customer's record itself (`reads`), or it acts on what a rule that did
 * decided — flags it set, a change it made (`follows`).
 */
export function skippedSentence(ruleName: string | undefined, action: Action, why: "reads" | "follows"): string {
  const wanted =
    action.action === "transition"
      ? (WANTED[action.event] ?? `${action.event.replaceAll("_", " ")} this`)
      : "start a background job on this";
  const rule = ruleName?.trim() ? `Rule '${ruleName.trim()}'` : "This rule";
  return why === "reads"
    ? `${rule} wanted to ${wanted}, but rules that read a customer's record can only help them`
    : `${rule} wanted to ${wanted}, but it follows from a rule that read the customer's record, and those can only help them`;
}
