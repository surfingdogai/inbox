import type { HandleKind, Signal } from "../types";

/**
 * What an agent's request tells (ADR-041 §4.4, §5.2): a network pass presented, a platform that
 * vouches for its key, and how many new conversations its handles started today. Only lifts come
 * from who someone is (R25): a pass or a vouched key takes points off and widens budgets; nothing
 * about a person's standing anywhere ever adds one.
 */
export function agentSignals(input: {
  readonly pass: boolean;
  readonly vouched: boolean;
  readonly over: { readonly kind: HandleKind; readonly count: number } | null;
}): Signal[] {
  const out: Signal[] = [];
  if (input.pass) out.push({ c: "pass", w: -3, f: "basic" });
  if (input.vouched) out.push({ c: "vouched", w: -1, f: "basic" });
  if (input.over) out.push({ c: "many_new", w: 6, f: "basic", x: 1, v: input.over.count });
  return out;
}
