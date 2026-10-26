import type { z } from "zod";
import type { ActorKind, ItemType } from "../domain/types";

/**
 * State machines as data. A transition names the event, the states it leaves, the state it
 * enters, who may perform it, the guards that must hold and the effects the write adds to its
 * batch. Nothing here runs code; the write algorithm interprets it.
 */
export type GuardId =
  | "slot_available"
  | "within_cancellation_window"
  /** The window has closed and the owner records late cancellations (`booking.lateCancellation`). */
  | "outside_cancellation_window"
  /** A no-show or a completion may be corrected once, until `booking.autoCompleteHours` after the end. */
  | "within_correction_window"
  /** Payment was requested `orders.payDays` ago or more, and the order has not lapsed yet. */
  | "payment_overdue"
  /** A charge-back on a completed order is recorded once. */
  | "not_charged_back"
  | "has_quote"
  | "customer_owns_item"
  | "proposal_present"
  /**
   * The time the transition books or proposes has not started, and (for anyone but a person at the
   * business) is at least the minimum notice away. For a quote, the time the booking it creates is for.
   */
  | "not_too_soon"
  /**
   * What the business put to the customer is open and still valid (its `valid_through`, checked in
   * the write whether or not the sweep has reached it); else `offer_expired`.
   */
  | "offer_open"
  /** The request waiting on the business, or on the customer's details, has lapsed (`request_expires_at`). */
  | "request_lapsed"
  /** What the business put to the customer has lapsed (the open offer's `valid_through`). */
  | "offer_lapsed"
  /** What the business proposed said it was subject to our confirmation: we may still withdraw it. */
  | "offer_non_binding"
  /** A quote adds up (its lines to its total, in one currency) and, when it creates a booking, names a service and a time. */
  | "quote_complete"
  /** The owner records a customer's cancellation: when they asked, the window was open (or late ones are refused). */
  | "asked_within_window"
  /** …when they asked, the window had closed, and the owner records late cancellations. */
  | "asked_outside_window"
  /**
   * A change the other side asked for is open, and still valid (its `valid_through`, checked in the
   * write): what an acceptance of a change needs. Else `no_offer`, or `offer_expired`.
   */
  | "change_open"
  /** A change the other side asked for is open, whatever its date: what a no to it needs. */
  | "change_theirs"
  /** A change the caller's own side asked for is open: what withdrawing it needs. */
  | "change_mine"
  /** The open change has lapsed (its `valid_through` has passed): what the sweep's expiry needs. */
  | "change_lapsed"
  /**
   * The promise can still take a change: fewer than `negotiation.changes.maxPerItem` accepted, and
   * none moving its due date, or a booking's end, more than `AMENDMENT_LIMITS.dueShiftDays` from
   * what was first agreed.
   */
  | "changes_left"
  /**
   * A change can be recorded without breaking the promise where it was reported: no network holds,
   * or will be sent, this promise under rules that do not know changes (ADR-018 §8, rules version 6).
   */
  | "amendments_live"
  /** The promise has not started: a booking's start is still ahead. */
  | "promise_ahead"
  /**
   * The owner's AI and rules act within the owner's limits on changes (`negotiation.ai`): they ask for
   * one only when the owner allows it, and take a customer's only before the cutoff, at our prices.
   */
  | "change_allowed"
  /**
   * The customer may withdraw from the contract now (ADR-018 §7): a consumer, nothing excepted, a
   * booking paid at a distance and not begun, within the period — judged, for a withdrawal the business
   * records, at the moment the customer told it.
   */
  | "withdrawal_open"
  /** The return is not a withdrawal within the period, which nobody may refuse. */
  | "not_withdrawal"
  /**
   * The refund pays at least what is owed, and no more than was paid: anything less needs the
   * customer's yes to a settlement, which a person agrees with them.
   */
  | "refund_amount"
  /**
   * The owner's AI and rules approve a return only inside the owner's policy (`returns.days`, nothing
   * excepted) with the goods coming back, and only while the owner lets them
   * (`negotiation.ai.mayAuthorizeReturnsInPolicy`); faulty goods always.
   */
  | "return_allowed"
  /** No return of this order is open already: one at a time, which the customer can add to. */
  | "no_open_return"
  /**
   * Goods are to come back on this return: only then can they arrive (and move the refund's date), or
   * the customer keep them by dropping it. A refund with nothing to send back is money owed, as it is.
   */
  | "goods_expected"
  // Stays (ADR-037), checked by the stays layer (`stays/transition.ts`) in the same write.
  /** The quote holds together: its lines and schedule add up to its total, its policy is dated before arrival. */
  | "stay_quote_complete"
  /** Each room holds its guests: adults, children and the total within the room type's capacity. */
  | "capacity_ok"
  /** Where the property's area requires a short-term rental registration number, it has one. */
  | "registration_ok"
  /** Arrival has not passed; a same-day arrival only until the property's same-day cutoff. */
  | "not_past"
  /** No requested night is one the property closed, or (connected) its system shows closed. */
  | "nights_open"
  /** Every night of every room has a unit free, counting the claims of every other stay. */
  | "nights_available"
  /** The quote the guest answers is open and still valid. */
  | "stay_quote_open"
  | "stay_quote_lapsed"
  | "stay_request_lapsed"
  /** The guest confirmed the terms they were shown: their `terms_sha` is this quote's. */
  | "terms_confirmed"
  /** Something is due now (a deposit, a card), or nothing is. */
  | "payment_due_now"
  | "nothing_due_now"
  /** Every amount due now is paid, and the card is saved where one was asked for. */
  | "payment_complete"
  /** The window to pay passed. */
  | "payment_lapsed"
  /** A payment that came late may still be taken: the stay lapsed only for want of it. */
  | "late_payment_open"
  /** The inbox cannot sell these nights twice: rooms kept for direct guests, or the property's fresh system. */
  | "instant_safe"
  /** The agent's hold is open, or has lapsed. */
  | "hold_open"
  | "hold_lapsed"
  /** The guest saw the cancellation fee and confirmed it (`fee_sha`). */
  | "fee_confirmed"
  /** A fee lower than the policy's is a person's to give. */
  | "fee_lowered_by_person"
  /** The stay has not begun. */
  | "stay_ahead"
  /** The new nights of a change are open and free. */
  | "change_nights_open"
  | "stay_change_open"
  | "stay_change_theirs"
  | "stay_change_mine"
  | "stay_change_lapsed"
  /** A change both sides agreed is being written to the property's own system, and waits for its answer. */
  | "stay_change_writing"
  /** Check-in day has come, in the property's zone. */
  | "checkin_day_reached"
  /** Check-out passed, and the hours after it the property waits before a stay counts as stayed. */
  | "stay_ended"
  /** The day of arrival ended, in the property's zone, with nobody there. */
  | "arrival_passed"
  /** A stayed or a no-show may be corrected once, until the hours after check-out end. */
  | "stay_correction_window";

export type EffectId =
  | "claim_slot"
  | "release_slot"
  | "apply_proposal"
  /** The customer's other time becomes the requested one (`counter`); what we proposed is gone. */
  | "apply_counter"
  /** The changes we suggested to an order become the order (`accept`). */
  | "apply_offer"
  /** The change one side asked for and the other accepted becomes the booking or the order. */
  | "apply_change"
  /** A time we held for the customer while they answered is let go; an agreed booking's claim is not touched. */
  | "release_hold"
  | "issue_receipt:confirmed"
  | "issue_receipt:paid"
  | "issue_receipt:accepted"
  /** The outcome that closes the item's promise (ADR-017 §3), named by `outcomeOf` in `outcomes.ts`. */
  | "issue_receipt:outcome"
  /** A change both sides agreed to the promise: the `amended` receipt of rules version 6 (ADR-017 Amendment 3). */
  | "issue_receipt:amended"
  | "link_item"
  /**
   * The return or refund this transition makes, created in its batch as a `refund` item linked to the
   * order or booking (ADR-018 §3.4): a withdrawal, a return asked for, a paid order cancelled.
   */
  | "link_refund"
  | "review_fact"
  | "notify_customer"
  | "notify_owner"
  | "close"
  // Stays (ADR-037), written by the stays layer in the same batch.
  /** The stay's nights claimed for good, or held until a deposit or a write settles. */
  | "claim_nights"
  | "claim_nights:hold"
  /** A quote's nights held while it is open, where the property cannot sell them twice. */
  | "hold_nights"
  /** Held nights become the stay's for good. */
  | "promote_claims"
  | "release_nights"
  /** A change's new nights claimed and the old ones let go. */
  | "reclaim_nights"
  /** The stay is written to the property's own system, first (a job). */
  | "write_stay"
  /** The stay is taken off the property's own system again. */
  | "cancel_stay_write"
  /** The nights after a no-show's first let go on the property's own system, never by cancelling the stay. */
  | "release_stay_write"
  /** A change's new nights held beside the old ones while it is written to the property's own system. */
  | "hold_change_nights"
  /** The deposit or balance links the schedule wants, made or closed (the pay-link job). */
  | "queue_pay_links"
  | "close_pay_links"
  /** The policy's fee as of now (or when the guest asked), on the stay. */
  | "cancellation_fee"
  /** What was paid less the fee, owed back: a refund for the property to make in its own dashboard. */
  | "refund_owed"
  /** The pre-arrival messages, queued for their times. */
  | "schedule_messages"
  /** The guest's other dates or rooms become the request. */
  | "stay_counter"
  /** The change both sides agreed becomes the stay. */
  | "apply_stay_change"
  /** The change not made goes; the stay stays as agreed. */
  | "drop_change";

/**
 * What a transition does to the item's offers (ADR-018 §2), which the write path carries out in its
 * batch (`write/offers.ts`):
 *
 * - `make`: the caller's side makes a new open offer — the business's time, quote or changes, the
 *   customer's other time or quantity. It answers the other side's open offer (`countered`) or
 *   replaces the caller's own (`superseded`).
 * - `take`: the open offer is accepted; the promise is made on its terms.
 * - `withdraw`: the caller's side takes back its own open offer (`retracted`); the other side's
 *   request stands again. A question asked of the other side's open offer leaves it open.
 * - `end`: the negotiation ends with the item: the open offer is declined by the other side,
 *   retracted by its own, or expired by the system.
 * - `keep`: a change to a promise is not made: declined by the other side, withdrawn by its own or
 *   lapsed. The promise stays as agreed, and so does the offer the payload points to.
 */
export type OfferAction = "make" | "take" | "withdraw" | "end" | "keep";

export interface Transition<S extends string = string> {
  readonly event: string;
  readonly from: readonly S[];
  readonly to: S;
  readonly by: readonly ActorKind[];
  readonly guards?: readonly GuardId[];
  readonly effects?: readonly EffectId[];
  /** Per-event input, validated before anything else. */
  readonly input?: z.ZodType;
  /** Shown to owners as the button label; the confirmation uses the same words. */
  readonly label: string;
  /**
   * A record made after the item closed — a corrected no-show, a charge-back on a completed order
   * — which leaves it closed: the only kind of transition out of a terminal state.
   */
  readonly amends?: true;
  /**
   * Never offered as a next step: the inbox fires it itself on the caller's behalf (`cancel_item`
   * fires `cancel_late` once the cancellation window has closed).
   */
  readonly unlisted?: true;
  /**
   * Only a person at the business may do it — the owner or staff, not their AI, not a rule and not a
   * key handed to another system — because it records something the customer said to a person
   * (that they agreed to the time we proposed).
   */
  readonly byPerson?: true;
  /**
   * The note written with it is for the business, never sent to the customer: what the customer
   * said when they cancelled, how they agreed.
   */
  readonly internalNote?: true;
  /** What it does to the item's offers; nothing when absent. */
  readonly offer?: OfferAction;
  /** The offers it makes or closes are changes to a promise (`kind: change`), not offers before one. */
  readonly change?: true;
  /**
   * It leaves a terminal state for an open one, so the item opens again (a stay a late payment confirmed
   * after it lapsed, while its nights were still free). Only the inbox's own jobs fire one.
   */
  readonly reopens?: true;
}

export interface Machine<S extends string = string> {
  readonly type: ItemType;
  readonly initial: S;
  readonly states: readonly S[];
  readonly terminal: readonly S[];
  readonly transitions: readonly Transition<S>[];
}

export type MachineError =
  | { code: "unknown_event" }
  | { code: "wrong_state"; from: readonly string[] }
  | { code: "not_allowed"; by: readonly ActorKind[] };

/** Finds the transition for an event from a state, or says precisely why there is none. */
export function resolveTransition<S extends string>(
  machine: Machine<S>,
  state: S,
  event: string,
  actor: ActorKind,
): { ok: true; transition: Transition<S> } | { ok: false; error: MachineError } {
  const candidates = machine.transitions.filter((t) => t.event === event);
  if (candidates.length === 0) return { ok: false, error: { code: "unknown_event" } };
  const fromHere = candidates.filter((t) => t.from.includes(state));
  if (fromHere.length === 0) {
    return { ok: false, error: { code: "wrong_state", from: [...new Set(candidates.flatMap((t) => t.from))] } };
  }
  const allowed = fromHere.find((t) => t.by.includes(actor));
  if (!allowed) return { ok: false, error: { code: "not_allowed", by: [...new Set(fromHere.flatMap((t) => t.by))] } };
  return { ok: true, transition: allowed };
}

/** The events an actor may fire from a state: what the UI shows as primary buttons. */
export function availableTransitions<S extends string>(
  machine: Machine<S>,
  state: S,
  actor: ActorKind,
): Transition<S>[] {
  const seen = new Set<string>();
  return machine.transitions.filter((t) => {
    if (t.unlisted || !t.from.includes(state) || !t.by.includes(actor) || seen.has(t.event)) return false;
    seen.add(t.event);
    return true;
  });
}

export function isTerminal<S extends string>(machine: Machine<S>, state: S): boolean {
  return machine.terminal.includes(state);
}
