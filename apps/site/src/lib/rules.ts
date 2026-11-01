/**
 * The rules in force, in a sentence, from GET /v1/ranking: its version, its name, since when, and
 * the next version when one is announced. When the network cannot be read the fallback says what is
 * in force once the network publishes version 11 (rules 0.2.4, in force the day it is published, 1 Nov
 * 2026, with nothing announced). It cannot know of a later version: once one is announced, update it,
 * or a build that cannot reach the network will name version 11 after it is out of date.
 */
import { shortDate } from "./status";

export interface RulesLine {
  now: string;
  next: string;
}

const V11_AT = "2026-11-01T00:00:00Z";

export function rulesFallback(): RulesLine {
  return { now: `Version 11 (0.2.4), in force since ${shortDate(V11_AT)}.`, next: "" };
}

/** The sentence, from the endpoint's answer; null when the answer is not one. */
export function rulesLine(ranking: unknown): RulesLine | null {
  if (!ranking || typeof ranking !== "object") return null;
  const r = ranking as Record<string, unknown>;
  if (typeof r.version !== "number" || r.status !== "in_force") return null;
  const name = typeof r.rules === "string" && r.rules ? ` (${r.rules})` : "";
  const since =
    typeof r.effective_at === "string" && !Number.isNaN(Date.parse(r.effective_at))
      ? `, in force since ${shortDate(r.effective_at)}`
      : ", in force";
  let next = "";
  const n = r.next as Record<string, unknown> | null | undefined;
  if (
    n &&
    typeof n.version === "number" &&
    typeof n.effective_at === "string" &&
    !Number.isNaN(Date.parse(n.effective_at))
  ) {
    next = `Version ${n.version} is announced, and takes effect on ${shortDate(n.effective_at)}.`;
  }
  return { now: `Version ${r.version}${name}${since}.`, next };
}
