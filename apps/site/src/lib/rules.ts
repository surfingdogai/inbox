/**
 * The rules in force, in a sentence, from GET /v1/ranking: its version, its name, since when, and
 * the next version when one is announced. When the network cannot be read the fallback says what was
 * published when this was written (version 6 since 29 Sep 2026, version 7 announced for 23 Oct 2026),
 * and switches on that date by itself, so a build that cannot reach the network never says an old
 * version is in force.
 */
import { shortDate } from "./status";

export interface RulesLine {
  now: string;
  next: string;
}

const V7_AT = "2026-10-23T00:00:00Z";

export function rulesFallback(at: number = Date.now()): RulesLine {
  return at >= Date.parse(V7_AT)
    ? { now: `Version 7 (0.2.0), in force since ${shortDate(V7_AT)}.`, next: "" }
    : {
        now: "Version 6 (0.1.3), in force since 29 Sep 2026.",
        next: `Version 7 is announced, and takes effect on ${shortDate(V7_AT)}.`,
      };
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
