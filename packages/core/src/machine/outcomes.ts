import type { InboxOutcomeCode } from "@surfingdog/spec";
import { type ActorKind, CUSTOMER_ACTORS, type ItemType } from "../domain/types";

/**
 * Which outcome a transition records (ADR-017 §3, §3.1): one pure function of the item type, the
 * event, the state it leaves and who fired it, so every path through the machines can be checked
 * against the outcome table — and is, in `test/outcomes.test.ts` and `receipts-v2.json`.
 *
 * A promise is made when a booking is confirmed and when an order is accepted (or paid, for an
 * order whose promise predates `accepted`), and — since rules version 6 (ADR-017 Amendment 3) — when
 * a refund's date is fixed. Every transition that leaves the promise states closes the promise with
 * exactly one outcome; so do a failed payment, a charge-back, a lapse and a correction, which record
 * something about the customer without the promise moving. Everything else — a request declined,
 * expired or cancelled before anything was promised, a change both sides agreed — closes nothing.
 */
export interface Outcome {
  readonly code: InboxOutcomeCode;
  /** 1 when nobody decided it: the system (the sweep) or a rule. The network presumes such a kept outcome. */
  readonly aut?: 1;
}

/**
 * The states in which the business holds an open promise to the customer. A refund's is made when
 * its date is fixed (ADR-018 §8): at once when nothing has to come back, else when the goods do;
 * an approved return still waiting for its goods has none yet (`OutcomeContext.due`).
 */
export const PROMISE_STATES: Readonly<Record<"booking" | "order" | "refund", readonly string[]>> = {
  booking: ["confirmed"],
  order: ["accepted", "awaiting_payment", "payment_failed", "paid", "fulfilling"],
  refund: ["approved", "goods_received"],
};

/**
 * What an outcome may depend on beyond the transition, still as plain values: when the refund was
 * due (Unix ms), if its date was fixed, and when it was paid or dropped.
 */
export interface OutcomeContext {
  /**
   * When the refund must be paid by: null when nothing fixed it (goods still to come back), so no
   * promise was made; absent when the caller does not say, as over the machines' paths.
   */
  readonly due?: number | null | undefined;
  /** When the transition happened. */
  readonly now?: number | undefined;
}

/** Actors whose transition nobody decided in the moment: `aut: 1` on the outcome. */
const AUTOMATIC: ReadonlySet<ActorKind> = new Set(["system", "rule"]);

/**
 * The outcome a transition records, or null when it closes no promise. `actor` is the kind the
 * machines judge the caller as (the owner's AI and integration keys act as the owner).
 */
export function outcomeOf(
  type: ItemType,
  event: string,
  from: string,
  actor: ActorKind,
  ctx: OutcomeContext = {},
): Outcome | null {
  const code = codeOf(type, event, from, actor, ctx);
  if (!code) return null;
  return AUTOMATIC.has(actor) ? { code, aut: 1 } : { code };
}

/** Whole seconds, as the receipts carry them, so what the inbox decides is what a network can read. */
const seconds = (ms: number) => Math.floor(ms / 1000);

function codeOf(
  type: ItemType,
  event: string,
  from: string,
  actor: ActorKind,
  ctx: OutcomeContext,
): InboxOutcomeCode | null {
  const customer = CUSTOMER_ACTORS.includes(actor);
  if (type === "refund") {
    if (!PROMISE_STATES.refund.includes(from)) return null;
    switch (event) {
      // Paid by its date is kept; after it, broken. Paid before any date was fixed is on time.
      case "refund":
        return ctx.due != null && ctx.now !== undefined && seconds(ctx.now) > seconds(ctx.due)
          ? "refund.late"
          : "refund.honoured";
      // The customer drops the return (or a person records that they did): neutral. Before its date was
      // fixed nothing was promised, so nothing closes.
      case "cancel":
      case "record_cancel":
        return ctx.due === null ? null : "refund.cancelled_by_customer";
      default:
        return null;
    }
  }
  if (type === "booking") {
    switch (event) {
      case "complete":
        return from === "confirmed" || from === "no_show" ? "booking.completed" : null;
      case "no_show":
        return from === "confirmed" || from === "completed" ? "booking.no_show_customer" : null;
      case "cancel_by_business":
        return from === "confirmed" ? "booking.cancelled_by_business" : null;
      case "cancel":
        return from === "confirmed" && customer ? "booking.cancelled_by_customer" : null;
      case "cancel_late":
        return from === "confirmed" && customer ? "booking.cancelled_late_by_customer" : null;
      // The business records the customer's own cancellation: it is the customer's, whoever typed it.
      case "record_cancel":
        return from === "confirmed" ? "booking.cancelled_by_customer" : null;
      case "record_cancel_late":
        return from === "confirmed" ? "booking.cancelled_late_by_customer" : null;
      // A withdrawal within the legal period is the customer's own choice, and never late (ADR-018 §8).
      case "withdraw":
      case "record_withdrawal":
        return from === "confirmed" ? "booking.cancelled_by_customer" : null;
      default:
        return null;
    }
  }
  if (type === "order") {
    const open = PROMISE_STATES.order.includes(from);
    switch (event) {
      case "fulfil":
        return open ? "order.fulfilled" : null;
      case "cancel":
        if (!open) return null;
        return customer ? "order.cancelled_by_customer" : "order.not_fulfilled";
      case "record_cancel":
        return open ? "order.cancelled_by_customer" : null;
      // Before the goods went out a withdrawal ends the order, neutrally; after, the order was kept and
      // the goods come back as a return, which records nothing on it (ADR-018 §8).
      case "withdraw":
      case "record_withdrawal":
        return open ? "order.cancelled_by_customer" : null;
      case "payment_failed":
        return from === "awaiting_payment" ? "order.payment_failed" : null;
      case "charge_back":
        return from === "paid" || from === "fulfilling" || from === "fulfilled" ? "order.charged_back" : null;
      case "record_charge_back":
        return from === "completed" ? "order.charged_back" : null;
      case "lapse":
        return from === "awaiting_payment" || from === "payment_failed" ? "order.lapsed" : null;
      default:
        return null;
    }
  }
  return null;
}
