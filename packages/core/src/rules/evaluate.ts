import type { Condition } from "./schema";

export type Tier = "new" | "building" | "trusted";
const TIER_RANK: Record<string, number> = { new: 0, building: 1, trusted: 2 };
export const tierRank = (tier: unknown): number => TIER_RANK[String(tier)] ?? 0;

/**
 * The customer as the networks present them (ADR-017 §8.3): the best tier and score across the
 * enabled networks that presented the person for this item, each network's own, and the limit a
 * trusted person earns (40000 minor units; 0 otherwise).
 */
export interface PersonContext {
  readonly present: boolean;
  readonly tier: Tier;
  readonly score: number;
  readonly networks: readonly {
    readonly network: string;
    readonly tier: Tier;
    readonly score: number;
    readonly kept: number;
    readonly broken: number;
  }[];
  readonly limit_minor: number;
}

/** The business's own history with the customer (§8.2), and how sure it is that this is them. */
export interface CustomerContext {
  readonly match: "strong" | "weak" | "none";
  /** A strong match with earlier items here. */
  readonly known: boolean;
  readonly completed: number;
  readonly paid: number;
  readonly no_shows: number;
  readonly late_cancellations: number;
  readonly payment_failed: number;
  readonly charged_back: number;
  readonly largest_paid: number;
  /** Twice the largest paid order. */
  readonly limit_minor: number;
  /** Unix ms of the first earlier item; null without one. */
  readonly first_seen: number | null;
  /** Open bookings, this one included. */
  readonly open_bookings: number;
}

/** How the agent that made the item signed (§2.4). */
export interface AgentContext {
  readonly level: "vouched" | "self" | "none";
  readonly platform: string | null;
}

export const NO_PERSON: PersonContext = { present: false, tier: "new", score: 0, networks: [], limit_minor: 0 };
export const NO_CUSTOMER: CustomerContext = {
  match: "none",
  known: false,
  completed: 0,
  paid: 0,
  no_shows: 0,
  late_cancellations: 0,
  payment_failed: 0,
  charged_back: 0,
  largest_paid: 0,
  limit_minor: 0,
  first_seen: null,
  open_bookings: 0,
};
export const NO_AGENT_CONTEXT: AgentContext = { level: "none", platform: null };

/** Everything a condition may read. Built once per event; evaluation is pure. */
export interface RuleContext {
  readonly item: Record<string, unknown>;
  readonly event: {
    readonly event: string;
    readonly from: string | null;
    readonly to: string;
    readonly actorKind: string;
    readonly tier?: string | undefined;
    readonly depth: number;
  };
  readonly party: { readonly kind: string; readonly tier: string };
  readonly person: PersonContext;
  readonly customer: CustomerContext;
  readonly agent: AgentContext;
  readonly settings: Record<string, unknown>;
  readonly now: number;
  readonly text: string;
  readonly facts: { readonly slotIsFree: boolean | null; readonly withinBusinessHours: boolean | null };
}

export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function evaluate(condition: Condition, ctx: RuleContext): boolean {
  if ("all" in condition) return condition.all.every((c) => evaluate(c, ctx));
  if ("any" in condition) return condition.any.some((c) => evaluate(c, ctx));
  if ("not" in condition) return !evaluate(condition.not, ctx);
  if ("fn" in condition) return evaluateFn(condition.fn, condition.args ?? {}, ctx);
  const actual = getPath(ctx, condition.path);
  const expected = condition.value;
  switch (condition.op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "nin":
      return Array.isArray(expected) && !expected.includes(actual);
    case "contains":
      if (typeof actual === "string" && typeof expected === "string")
        return actual.toLowerCase().includes(expected.toLowerCase());
      return Array.isArray(actual) && actual.includes(expected);
    case "startsWith":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLowerCase().startsWith(expected.toLowerCase())
      );
    case "exists":
      return actual !== undefined && actual !== null;
    case "empty":
      return actual === undefined || actual === null || actual === "" || (Array.isArray(actual) && actual.length === 0);
    case "between": {
      if (typeof actual !== "number" || !Array.isArray(expected)) return false;
      const [lo, hi] = expected as [unknown, unknown];
      return typeof lo === "number" && typeof hi === "number" && actual >= lo && actual <= hi;
    }
  }
}

function evaluateFn(fn: string, args: Record<string, unknown>, ctx: RuleContext): boolean {
  switch (fn) {
    case "slot_is_free":
      return ctx.facts.slotIsFree === true;
    case "within_business_hours":
      return ctx.facts.withinBusinessHours === true;
    case "party_verified":
      // A key the owner issued or authenticated mail, as before (R18); and, only through a platform
      // a network this inbox reports to recognises (§4, §8.3), a trusted person carried by its agent
      // or the agent itself. A platform nobody recognises is the agent's own key: `self`, never this.
      return (
        ctx.party.tier === "verified_principal" ||
        ctx.party.tier === "reputed_principal" ||
        (ctx.party.tier === "signed_agent" && ctx.agent.level === "vouched")
      );
    case "person_trusted":
      return ctx.person.tier === "trusted";
    case "person_tier_on": {
      const network = typeof args.network === "string" ? args.network.toLowerCase().replace(/\/+$/, "") : "";
      const min = tierRank(args.min ?? "building");
      return ctx.person.networks.some(
        (n) => (n.network === network || n.network === `https://${network}`) && tierRank(n.tier) >= min,
      );
    }
    case "customer_known":
      return ctx.customer.match === "strong" && ctx.customer.completed >= 1;
    case "within_customer_limit": {
      const total = getPath(ctx, "item.payload.totalPrice.value");
      const limit = Math.max(ctx.customer.limit_minor, ctx.person.limit_minor);
      return typeof total === "number" && limit > 0 && total <= limit;
    }
    case "is_sandbox":
      return getPath(ctx, "item.flags.sandbox") === true;
    case "text_has_keywords": {
      const keywords = Array.isArray(args.keywords)
        ? (args.keywords as unknown[]).filter((k): k is string => typeof k === "string")
        : [];
      const text = ctx.text.toLowerCase();
      return keywords.some((k) => k.length > 0 && text.includes(k.toLowerCase()));
    }
    default:
      return false;
  }
}

/** `{{path}}` placeholders resolved against the context; unknown paths become empty. */
export function renderTemplate(template: string, ctx: RuleContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = getPath(ctx, path);
    return v === undefined || v === null ? "" : String(v);
  });
}
