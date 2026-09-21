import type { Condition } from "./schema";

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
      return ctx.party.tier === "verified_principal" || ctx.party.tier === "reputed_principal";
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
