import type { DatedPolicy, Policy, PolicyFee } from "@surfingdog/spec";
import { shareOf } from "@surfingdog/spec";
import type { Money } from "../domain/types";
import { addDays, dateIn, instantOf, isoIn } from "../util/zoned";

export { type PolicyLang, policyLang, policySentence } from "./words";

/**
 * Cancellation policies as data (ADR-036): a business's steps before the start of what it sells,
 * dated for one booking in the business's own zone, the fee at any moment, and what is owed back.
 * Pure: nothing here reads or writes storage. Stays keep theirs on their rate plans, appointments on
 * their services; each applies it here.
 */

/** What a policy is applied to: when it starts, in which zone, and what it costs. */
export interface PolicyContext {
  /**
   * When what was booked starts: a local date with its wall time (a stay's arrival on its check-in
   * date at check-in time), or an instant (an appointment).
   */
  readonly start: { readonly date: string; readonly time: string } | { readonly at: number };
  /** The business's IANA zone: every step is dated in it. */
  readonly zone: string;
  readonly total: Money;
  /** What each unit costs, in order (each night of a stay): a `units` fee is the first N of them. */
  readonly units?: readonly number[] | undefined;
  /** When it is booked: a step already past by then says nothing, and is left out. */
  readonly bookedAt?: number | undefined;
}

/** The instant what was booked starts. */
export function startInstant(ctx: Pick<PolicyContext, "start" | "zone">): number {
  return "at" in ctx.start ? ctx.start.at : instantOf(ctx.start.date, ctx.start.time, ctx.zone);
}

/** One fee of a policy, as money for this booking: never more than it costs, never below nothing. */
export function feeOf(fee: PolicyFee, ctx: Pick<PolicyContext, "total" | "units">): Money {
  const total = ctx.total;
  let value: number;
  switch (fee.kind) {
    case "none":
      value = 0;
      break;
    case "full":
      value = total.value;
      break;
    case "amount":
      value = fee.value ?? 0;
      break;
    case "percent":
      // Percent of the total, rounded half up to the minor unit.
      value = shareOf(total.value, Math.min(100, fee.value ?? 0) * 100);
      break;
    case "units": {
      const units = ctx.units ?? [];
      const n = Math.max(0, fee.value ?? 1);
      // With no unit prices given, what was booked is one unit: the whole of it, from one unit up.
      value = units.length > 0 ? units.slice(0, n).reduce((a, b) => a + b, 0) : n > 0 ? total.value : 0;
      break;
    }
  }
  return { value: Math.max(0, Math.min(total.value, Math.trunc(value))), currency: total.currency };
}

/**
 * The policy dated for one booking: for each step, the instant until which its fee applies — the end of
 * the local day `days` before the start's date (23:59:59 in the business's zone, whatever the clocks do
 * that day), or `hours` before the start — in order, with steps already past at booking left out.
 */
export function datePolicy(policy: Policy, ctx: PolicyContext): DatedPolicy {
  const start = startInstant(ctx);
  const startDate = "at" in ctx.start ? dateIn(ctx.start.at, ctx.zone) : ctx.start.date;
  const steps = policy.steps
    .map((s) => {
      const until =
        s.before.days !== undefined
          ? instantOf(addDays(startDate, -s.before.days), "23:59:59", ctx.zone)
          : start - (s.before.hours ?? 0) * 3_600_000;
      return { until: Math.min(until, start), fee: feeOf(s.fee, ctx) };
    })
    .filter((s) => ctx.bookedAt === undefined || s.until > ctx.bookedAt)
    .sort((a, b) => a.until - b.until);
  // Two steps on one instant: the earlier-stated (the farther out) one is kept.
  const unique = steps.filter((s, i) => i === 0 || s.until !== steps[i - 1]?.until);
  return {
    steps: unique.map((s) => ({ until: isoIn(s.until, ctx.zone), fee: s.fee })),
    after: feeOf(policy.after, ctx),
    noShow: feeOf(policy.noShow, ctx),
    zone: ctx.zone,
  };
}

/**
 * What cancelling costs at `at`: the fee of the first step still ahead, else the fee after the last
 * one; at least what is kept whatever the step (a deposit given as not refundable), and never more than
 * the total.
 */
export function feeAt(
  dated: DatedPolicy,
  at: number,
  opts: { readonly total?: Money | undefined; readonly keep?: Money | undefined } = {},
): Money {
  // A step's `until` is its last moment: "free until 9 Dec, 23:59:59" is free at 23:59:59 too.
  const step = dated.steps.find((s) => Date.parse(s.until) >= at);
  const fee = step ? step.fee : dated.after;
  const kept = opts.keep && opts.keep.currency === fee.currency ? opts.keep.value : 0;
  const cap = opts.total && opts.total.currency === fee.currency ? opts.total.value : Number.POSITIVE_INFINITY;
  return { value: Math.min(cap, Math.max(fee.value, kept)), currency: fee.currency };
}

/** Until when cancelling costs nothing, when it does at first: the free steps' last `until`, else null. */
export function freeUntil(dated: DatedPolicy): string | null {
  let last: string | null = null;
  for (const s of dated.steps) {
    if (s.fee.value !== 0) break;
    last = s.until;
  }
  return last;
}

/** What is owed back after a cancellation: what was paid less the fee, never below nothing. */
export function refundOwed(paid: Money, fee: Money): Money {
  if (paid.currency !== fee.currency) return { value: 0, currency: paid.currency };
  return { value: Math.max(0, paid.value - fee.value), currency: paid.currency };
}

/** Whether a policy charges nothing before the start at any step, as non-refundable ones do not. */
export function refundable(policy: Policy): boolean {
  return policy.steps.some((s) => s.fee.kind === "none") || policy.after.kind === "none";
}
