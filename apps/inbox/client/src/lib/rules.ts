import type { Action, Condition, RuleDefinition } from "./types";

/**
 * The rule editor's forms and how they become the JSON the engine runs. The forms cover one level
 * of conditions (all or any of a list of facts and field checks, each possibly negated); a rule
 * with nested groups is edited as JSON, which the editor also offers.
 */
export const OPS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "nin",
  "contains",
  "startsWith",
  "exists",
  "empty",
  "between",
] as const;
export type Op = (typeof OPS)[number];

export const OP_WORDS: Record<Op, string> = {
  eq: "is",
  neq: "is not",
  lt: "is under",
  lte: "is at most",
  gt: "is over",
  gte: "is at least",
  in: "is one of",
  nin: "is none of",
  contains: "contains",
  startsWith: "starts with",
  exists: "is present",
  empty: "is empty",
  between: "is between",
};

export const FNS = [
  "slot_is_free",
  "within_business_hours",
  "party_verified",
  "text_has_keywords",
  "is_sandbox",
  "person_trusted",
  "customer_known",
  "within_customer_limit",
] as const;
export type Fn = (typeof FNS)[number];

export const FN_WORDS: Record<Fn, string> = {
  slot_is_free: "the slot is free",
  within_business_hours: "it is inside opening hours",
  party_verified: "the sender is verified",
  text_has_keywords: "the text mentions…",
  is_sandbox: "it is a test",
  person_trusted: "the customer is trusted on a network",
  customer_known: "it is a customer you know",
  within_customer_limit: "the total is within the customer's limit",
};

/** Paths an owner is likely to want, with words; anything else can be typed. */
export const PATHS: readonly { readonly path: string; readonly label: string; readonly money?: boolean }[] = [
  { path: "item.type", label: "the type" },
  { path: "item.state", label: "the state" },
  { path: "item.payload.totalPrice.value", label: "the total", money: true },
  { path: "item.payload.totalPrice", label: "a total (present or not)" },
  { path: "item.payload.amount.value", label: "the refund amount", money: true },
  { path: "item.payload.startTime", label: "the start time" },
  { path: "item.flags.needsHuman", label: "the needs-you flag" },
  { path: "item.flags.priority", label: "the priority" },
  { path: "item.flags.sandbox", label: "the test flag" },
  { path: "party.kind", label: "the sender (customer_human, customer_agent)" },
  { path: "party.tier", label: "the sender's trust level" },
  { path: "person.tier", label: "the customer's best tier on a network (new, building, trusted)" },
  { path: "customer.match", label: "a customer you know (strong, weak, none)" },
  { path: "customer.completed", label: "the customer's completed visits and orders" },
  { path: "customer.no_shows", label: "the customer's no-shows" },
  { path: "customer.open_bookings", label: "the customer's open bookings" },
  { path: "customer.largest_paid", label: "the customer's largest paid order", money: true },
  { path: "agent.level", label: "how the agent signed (vouched, self, none)" },
  { path: "event.actorKind", label: "who acted" },
  { path: "event.event", label: "the event" },
  { path: "text", label: "the text" },
];

export const TRIGGER_EVENTS = [
  "confirm",
  "propose",
  "request_info",
  "provide_info",
  "accept",
  "decline",
  "cancel",
  "cancel_late",
  "cancel_by_business",
  "complete",
  "no_show",
  "quote",
  "request_payment",
  "record_payment",
  "payment_failed",
  "lapse",
  "start_fulfilment",
  "fulfil",
  "charge_back",
  "record_charge_back",
  "answer",
  "reopen",
  "close",
  "mark_spam",
  "unspam",
  "approve",
  "reject",
  "refund",
  "expire",
] as const;

export interface ConditionRow {
  readonly kind: "fact" | "field";
  readonly not: boolean;
  readonly fn: Fn;
  readonly keywords: string;
  readonly path: string;
  readonly op: Op;
  readonly value: string;
}

export interface ActionRow {
  readonly kind: Action["action"];
  readonly event: string;
  readonly reason: string;
  readonly needsHuman: "keep" | "flag" | "clear";
  readonly priority: "keep" | "0" | "1" | "2" | "3";
  readonly template: string;
  readonly internal: boolean;
  readonly job: string;
  readonly delayMin: string;
  readonly payload: string;
}

export interface RuleForm {
  readonly name: string;
  readonly priority: string;
  readonly enabled: boolean;
  readonly onCreated: boolean;
  readonly onInbound: boolean;
  readonly onTransitioned: boolean;
  readonly onEvents: readonly string[];
  readonly match: "all" | "any";
  readonly conditions: readonly ConditionRow[];
  readonly actions: readonly ActionRow[];
  readonly stop: boolean;
  readonly maxRuns: string;
}

export const EMPTY_CONDITION: ConditionRow = {
  kind: "field",
  not: false,
  fn: "slot_is_free",
  keywords: "",
  path: "item.type",
  op: "eq",
  value: "",
};

export const EMPTY_ACTION: ActionRow = {
  kind: "set_flags",
  event: "confirm",
  reason: "",
  needsHuman: "flag",
  priority: "keep",
  template: "",
  internal: false,
  job: "",
  delayMin: "",
  payload: "",
};

export const EMPTY_RULE: RuleForm = {
  name: "",
  priority: "0",
  enabled: true,
  onCreated: true,
  onInbound: false,
  onTransitioned: false,
  onEvents: [],
  match: "all",
  conditions: [],
  actions: [{ ...EMPTY_ACTION }],
  stop: false,
  maxRuns: "5",
};

export const isMoneyPath = (path: string): boolean => path.endsWith(".value");

/** What the owner types → what the engine compares. Money in major units, lists comma-separated. */
export function parseValue(text: string, op: Op, path: string): unknown {
  const t = text.trim();
  const one = (s: string): unknown => {
    const v = s.trim();
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null") return null;
    if (isMoneyPath(path) && /^-?\d+(?:[.,]\d{1,2})?$/.test(v)) return Math.round(Number(v.replace(",", ".")) * 100);
    if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1);
    return v;
  };
  if (op === "exists" || op === "empty") return undefined;
  if (op === "in" || op === "nin" || op === "between") {
    return t
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(one);
  }
  return one(t);
}

/** The reverse, for a definition being edited. */
export function showValue(value: unknown, path: string): string {
  const one = (v: unknown): string => {
    if (isMoneyPath(path) && typeof v === "number") return (v / 100).toFixed(2);
    if (typeof v === "string") return v;
    if (v === undefined) return "";
    return JSON.stringify(v);
  };
  return Array.isArray(value) ? value.map(one).join(", ") : one(value);
}

/** A definition as forms, when its conditions are one level deep; otherwise `simple` is false. */
export function toForm(
  def: RuleDefinition,
  meta: { name: string; priority: number; enabled: boolean },
): { form: RuleForm; simple: boolean } {
  const onEvents = def.on
    .filter((t) => t.startsWith("item.transitioned:"))
    .map((t) => t.slice("item.transitioned:".length));
  let match: "all" | "any" = "all";
  let leaves: Condition[] = [];
  let simple = true;
  if ("all" in def.if) leaves = def.if.all;
  else if ("any" in def.if) {
    match = "any";
    leaves = def.if.any;
  } else leaves = [def.if];
  const conditions: ConditionRow[] = [];
  for (const leaf of leaves) {
    const row = leafToRow(leaf);
    if (!row) {
      simple = false;
      break;
    }
    conditions.push(row);
  }
  const form: RuleForm = {
    name: meta.name,
    priority: String(meta.priority),
    enabled: meta.enabled,
    onCreated: def.on.includes("item.created"),
    onInbound: def.on.includes("thread.inbound"),
    onTransitioned: def.on.includes("item.transitioned"),
    onEvents,
    match,
    conditions: simple ? conditions : [],
    actions: def.actions.map(actionToRow),
    stop: def.stop,
    maxRuns: String(def.maxRunsPerItem),
  };
  return { form, simple };
}

function leafToRow(c: Condition): ConditionRow | null {
  let not = false;
  let leaf = c;
  if ("not" in leaf) {
    not = true;
    leaf = leaf.not;
  }
  if ("all" in leaf || "any" in leaf || "not" in leaf) return null;
  if ("fn" in leaf) {
    // A fact with arguments other than keywords is edited as JSON.
    if (leaf.fn === "person_tier_on") return null;
    const words = (leaf.args?.keywords as unknown[] | undefined) ?? [];
    return { ...EMPTY_CONDITION, kind: "fact", not, fn: leaf.fn, keywords: words.map(String).join(", ") };
  }
  return {
    ...EMPTY_CONDITION,
    kind: "field",
    not,
    path: leaf.path,
    op: leaf.op as Op,
    value: showValue(leaf.value, leaf.path),
  };
}

function actionToRow(a: Action): ActionRow {
  switch (a.action) {
    case "transition":
      return { ...EMPTY_ACTION, kind: "transition", event: a.event, reason: a.reason ?? "" };
    case "set_flags":
      return {
        ...EMPTY_ACTION,
        kind: "set_flags",
        needsHuman: a.needsHuman === true ? "flag" : a.needsHuman === false ? "clear" : "keep",
        priority: a.priority === undefined ? "keep" : (String(a.priority) as ActionRow["priority"]),
      };
    case "reply":
      return { ...EMPTY_ACTION, kind: "reply", template: a.template, internal: a.internal };
    case "enqueue":
      return {
        ...EMPTY_ACTION,
        kind: "enqueue",
        job: a.job,
        delayMin: a.delayMin === undefined ? "" : String(a.delayMin),
        payload: a.payload ? JSON.stringify(a.payload) : "",
      };
    case "stop":
      return { ...EMPTY_ACTION, kind: "stop" };
  }
}

export type Built = { ok: true; definition: RuleDefinition } | { ok: false; problem: string };

/** Forms → definition, or the sentence that says what is missing. */
export function toDefinition(form: RuleForm): Built {
  const on: string[] = [];
  if (form.onCreated) on.push("item.created");
  if (form.onInbound) on.push("thread.inbound");
  if (form.onTransitioned) on.push("item.transitioned");
  for (const e of form.onEvents) if (e.trim()) on.push(`item.transitioned:${e.trim()}`);
  if (on.length === 0) return { ok: false, problem: "Pick at least one moment for the rule to run." };

  const leaves: Condition[] = [];
  for (const row of form.conditions) {
    let leaf: Condition;
    if (row.kind === "fact") {
      const keywords = row.keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (row.fn === "text_has_keywords" && keywords.length === 0) {
        return { ok: false, problem: "Add the words to look for, separated by commas." };
      }
      leaf = row.fn === "text_has_keywords" ? { fn: row.fn, args: { keywords } } : { fn: row.fn };
    } else {
      if (!row.path.trim()) return { ok: false, problem: "Every condition needs a field to look at." };
      const value = parseValue(row.value, row.op, row.path);
      if (row.op !== "exists" && row.op !== "empty" && row.value.trim() === "") {
        return { ok: false, problem: `Give a value for "${row.path}" to compare with.` };
      }
      if (row.op === "between" && (!Array.isArray(value) || value.length !== 2)) {
        return { ok: false, problem: "Between needs two numbers, like 20 and 50." };
      }
      leaf = value === undefined ? { path: row.path.trim(), op: row.op } : { path: row.path.trim(), op: row.op, value };
    }
    leaves.push(row.not ? { not: leaf } : leaf);
  }
  const condition: Condition = leaves.length === 1 && leaves[0] ? leaves[0] : ({ [form.match]: leaves } as Condition);

  const actions: Action[] = [];
  for (const row of form.actions) {
    switch (row.kind) {
      case "transition":
        if (!row.event.trim()) return { ok: false, problem: "Choose what the item should become." };
        actions.push({
          action: "transition",
          event: row.event.trim(),
          ...(row.reason.trim() ? { reason: row.reason.trim() } : {}),
        });
        break;
      case "set_flags": {
        if (row.needsHuman === "keep" && row.priority === "keep") {
          return { ok: false, problem: "A flag action must change the needs-you flag, the priority, or both." };
        }
        actions.push({
          action: "set_flags",
          ...(row.needsHuman === "keep" ? {} : { needsHuman: row.needsHuman === "flag" }),
          ...(row.priority === "keep" ? {} : { priority: Number(row.priority) }),
        });
        break;
      }
      case "reply":
        if (!row.template.trim()) return { ok: false, problem: "Write the reply the rule should send." };
        actions.push({ action: "reply", template: row.template.trim(), internal: row.internal });
        break;
      case "enqueue": {
        if (!row.job.trim()) return { ok: false, problem: "Name the job to schedule." };
        let payload: Record<string, unknown> | undefined;
        if (row.payload.trim()) {
          try {
            payload = JSON.parse(row.payload) as Record<string, unknown>;
          } catch {
            return { ok: false, problem: 'The job payload must be JSON, like {"kind": "reminder"}.' };
          }
        }
        const delay = row.delayMin.trim() ? Number(row.delayMin) : undefined;
        if (delay !== undefined && (!Number.isInteger(delay) || delay < 0)) {
          return { ok: false, problem: "The delay is a whole number of minutes." };
        }
        actions.push({
          action: "enqueue",
          job: row.job.trim(),
          ...(payload ? { payload } : {}),
          ...(delay !== undefined ? { delayMin: delay } : {}),
        });
        break;
      }
      case "stop":
        actions.push({ action: "stop" });
        break;
    }
  }
  if (actions.length === 0) return { ok: false, problem: "Add at least one thing for the rule to do." };
  const maxRuns = Number(form.maxRuns);
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 50) {
    return { ok: false, problem: "Runs per item is a whole number from 1 to 50." };
  }
  return { ok: true, definition: { on, if: condition, actions, stop: form.stop, maxRunsPerItem: maxRuns } };
}

export function parsePriority(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= -1000 && n <= 1000 ? n : null;
}
