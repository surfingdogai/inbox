import type { InboxOutcomeCode } from "@surfingdog/spec";
import { type ActorKind, CUSTOMER_ACTORS, type ItemType } from "../domain/types";

/**
 * Which outcome a transition records (ADR-017 §3, §3.1): one pure function of the item type, the
 * event, the state it leaves and who fired it, so every path through the machines can be checked
 * against the outcome table — and is, in `test/outcomes.test.ts` and `receipts-v2.json`.
 *
 * A promise is made when a booking is confirmed and when an order is accepted (or paid, for an
 * order whose promise predates `accepted`). Every transition that leaves the promise states closes
 * the promise with exactly one outcome; so do a failed payment, a charge-back, a lapse and a
 * correction, which record something about the customer without the promise moving. Everything
 * else — a request declined, expired or cancelled before anything was promised — closes nothing.
 */
export interface Outcome {
  readonly code: InboxOutcomeCode;
  /** 1 when nobody decided it: the system (the sweep) or a rule. The network presumes such a kept outcome. */
  readonly aut?: 1;
}

/** The states in which the business holds an open promise to the customer. */
export const PROMISE_STATES: Readonly<Record<"booking" | "order", readonly string[]>> = {
  booking: ["confirmed"],
  order: ["accepted", "awaiting_payment", "payment_failed", "paid", "fulfilling"],
};

/** Actors whose transition nobody decided in the moment: `aut: 1` on the outcome. */
const AUTOMATIC: ReadonlySet<ActorKind> = new Set(["system", "rule"]);

/**
 * The outcome a transition records, or null when it closes no promise. `actor` is the kind the
 * machines judge the caller as (the owner's AI and integration keys act as the owner).
 */
export function outcomeOf(type: ItemType, event: string, from: string, actor: ActorKind): Outcome | null {
  const code = codeOf(type, event, from, actor);
  if (!code) return null;
  return AUTOMATIC.has(actor) ? { code, aut: 1 } : { code };
}

function codeOf(type: ItemType, event: string, from: string, actor: ActorKind): InboxOutcomeCode | null {
  const customer = CUSTOMER_ACTORS.includes(actor);
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
