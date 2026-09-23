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
  | "proposal_present";

export type EffectId =
  | "claim_slot"
  | "release_slot"
  | "apply_proposal"
  | "issue_receipt:confirmed"
  | "issue_receipt:paid"
  | "issue_receipt:accepted"
  /** The outcome that closes the item's promise (ADR-017 §3), named by `outcomeOf` in `outcomes.ts`. */
  | "issue_receipt:outcome"
  | "link_item"
  | "review_fact"
  | "notify_customer"
  | "notify_owner"
  | "close";

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
