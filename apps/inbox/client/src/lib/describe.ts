import type { Action, Condition, RuleDefinition } from "./types";

/**
 * A rule in one plain sentence, exactly as the server words it (packages/core/src/rules/describe.ts),
 * so the editor can read a rule back while it is being written, before anything is saved. The
 * test suite keeps the two in step.
 */
export function summarizeRule(def: RuleDefinition): string {
  const when = def.on.map(describeTrigger).join(" or ");
  const cond = describeCondition(def.if, true);
  const acts = def.actions.map(describeAction).filter(Boolean).join(", then ");
  return `When ${when}${cond ? ` and ${cond}` : ""}: ${acts || "do nothing"}${def.stop ? ". Stop there" : ""}.`;
}

const EVENT_WORDS: Record<string, string> = {
  confirm: "confirmed",
  cancel: "cancelled",
  decline: "declined",
  accept: "accepted",
  reject: "rejected",
  quote: "quoted",
  propose: "given a new time",
  answer: "answered",
  reopen: "reopened",
  record_payment: "paid",
  request_payment: "sent a payment request",
  complete: "completed",
  no_show: "marked as a no-show",
  ship: "shipped",
  refund: "refunded",
  mark_spam: "marked as spam",
};

const TYPE_WORDS: Record<string, string> = {
  booking: "a booking",
  order: "an order",
  quote_request: "a quote request",
  message: "a message",
  refund: "a refund",
};

export function describeTrigger(trigger: string): string {
  if (trigger === "item.created") return "a new item arrives";
  if (trigger === "thread.inbound") return "a message arrives on an item";
  if (trigger === "item.transitioned") return "an item changes state";
  const event = trigger.split(":")[1] ?? "";
  return `an item is ${EVENT_WORDS[event] ?? event.replace(/_/g, " ")}`;
}

export function describeCondition(c: Condition, top = false): string {
  if ("all" in c) {
    const parts = c.all.map((x) => describeCondition(x)).filter(Boolean);
    return parts.length <= 1 || top ? parts.join(" and ") : `(${parts.join(" and ")})`;
  }
  if ("any" in c) {
    const parts = c.any.map((x) => describeCondition(x)).filter(Boolean);
    return parts.length <= 1 ? parts.join("") : `(${parts.join(" or ")})`;
  }
  if ("not" in c) return `not ${describeCondition(c.not)}`;
  if ("fn" in c) {
    switch (c.fn) {
      case "slot_is_free":
        return "the slot is free";
      case "within_business_hours":
        return "it is inside opening hours";
      case "party_verified":
        return "the sender is verified";
      case "is_sandbox":
        return "it is a test";
      case "text_has_keywords": {
        const words = (c.args?.keywords as unknown[] | undefined) ?? [];
        return words.length
          ? `the text mentions ${words.map((w) => `"${String(w)}"`).join(", ")}`
          : "the text has the keywords";
      }
    }
  }
  return describePath(c.path, c.op, c.value);
}

function describePath(path: string, op: string, value: unknown): string {
  const subject = PATH_WORDS[path] ?? path.replace(/^item\.payload\./, "").replace(/^item\./, "its ");
  if (path === "item.type" && (op === "eq" || op === "neq")) {
    return `it is ${op === "neq" ? "not " : ""}${TYPE_WORDS[String(value)] ?? String(value)}`;
  }
  if (path === "item.flags.sandbox") return op === "eq" && value === true ? "it is a test" : "it is not a test";
  switch (op) {
    case "eq":
      return `${subject} is ${show(value)}`;
    case "neq":
      return `${subject} is not ${show(value)}`;
    case "lt":
      return `${subject} is under ${show(value, path)}`;
    case "lte":
      return `${subject} is at most ${show(value, path)}`;
    case "gt":
      return `${subject} is over ${show(value, path)}`;
    case "gte":
      return `${subject} is at least ${show(value, path)}`;
    case "in":
      return `${subject} is one of ${(Array.isArray(value) ? value : [value]).map((v) => show(v)).join(", ")}`;
    case "nin":
      return `${subject} is none of ${(Array.isArray(value) ? value : [value]).map((v) => show(v)).join(", ")}`;
    case "contains":
      return `${subject} contains ${show(value)}`;
    case "startsWith":
      return `${subject} starts with ${show(value)}`;
    case "exists":
      return `there is ${subject}`;
    case "empty":
      return `there is no ${subject}`;
    case "between": {
      const [a, b] = Array.isArray(value) ? value : [value, value];
      return `${subject} is between ${show(a, path)} and ${show(b, path)}`;
    }
    default:
      return `${subject} ${op} ${show(value)}`;
  }
}

const PATH_WORDS: Record<string, string> = {
  "item.state": "its state",
  "item.payload.totalPrice.value": "the total",
  "item.payload.totalPrice": "a total",
  "item.payload.total.value": "the total",
  "item.payload.total": "a total",
  "item.payload.amount.value": "the amount",
  "item.payload.startTime": "the start time",
  "party.kind": "the sender",
  "party.tier": "the sender's trust level",
  "event.actorKind": "who acted",
  text: "the text",
};

function show(value: unknown, path?: string): string {
  if (path?.endsWith(".value") && typeof value === "number") return (value / 100).toFixed(2);
  if (typeof value === "string") return `"${value}"`;
  if (value === undefined) return "nothing";
  return JSON.stringify(value);
}

export function describeAction(a: Action): string {
  switch (a.action) {
    case "transition":
      return a.event === "propose" ? "propose a new time" : `${a.event.replace(/_/g, " ")} it`;
    case "set_flags": {
      const parts: string[] = [];
      if (a.needsHuman === true) parts.push("flag it for a person");
      if (a.needsHuman === false) parts.push("clear the human flag");
      if (a.priority !== undefined) parts.push(`set priority ${a.priority}`);
      return parts.join(" and ") || "leave the flags";
    }
    case "reply": {
      const t = a.template.length > 70 ? `${a.template.slice(0, 67)}…` : a.template;
      return a.internal ? `add the note "${t}"` : `reply "${t}"`;
    }
    case "enqueue":
      return `schedule ${a.job}${a.delayMin ? ` in ${a.delayMin} min` : ""}`;
    case "stop":
      return "stop";
  }
}
