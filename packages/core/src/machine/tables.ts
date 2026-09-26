import { z } from "zod";
import {
  BUSINESS_ACTORS,
  CUSTOMER_ACTORS,
  type ItemType,
  isoDateTime,
  moneySchema,
  returnLinesSchema,
  returnReasonSchema,
} from "../domain/types";
import type { Machine, Transition } from "./machine";

const owners = BUSINESS_ACTORS;
const customers = CUSTOMER_ACTORS;
const ownersAndSystem = [...BUSINESS_ACTORS, "system"] as const;
/** Who records what a customer told the business (a cancellation by phone): its people and its AI, never a rule. */
const recorders = ["owner", "staff", "owner_ai"] as const;

export const proposeInput = z.object({
  startTime: isoDateTime,
  endTime: isoDateTime,
  totalPrice: moneySchema.optional(),
  /** A word for the customer with the new time; it goes with the email and on the page. */
  note: z.string().max(2_000).optional(),
});
/** Why the customer answered as they did, in ACP's `intent_trace` codes (ADR-018 §1). */
export const reasonCodeSchema = z
  .enum(["price_sensitivity", "timing_deferred", "quantity", "delivery", "returns_policy", "other"])
  .describe("Why: price_sensitivity, timing_deferred, quantity, delivery, returns_policy or other.");

export const quoteInput = z.object({
  totalPrice: moneySchema,
  /** Until when it can be accepted; `negotiation.offerValidHours` from now when left out. */
  validThrough: isoDateTime.optional(),
  lines: z
    .array(z.object({ name: z.string().max(200), quantity: z.number().int().min(1), price: moneySchema }))
    .max(100)
    .default([]),
  notes: z.string().max(2_000).optional(),
  creates: z.enum(["booking", "order"]).default("order"),
  /** For a quote that creates a booking: the time it is for (else the request's `requestedFor`). */
  startTime: isoDateTime.optional(),
  /** Defaults to the start plus the service's duration. */
  endTime: isoDateTime.optional(),
});
export const paymentInput = z.object({ paymentRef: z.string().min(1).max(200), amount: moneySchema.optional() });
export const paymentRequestInput = z.object({ paymentUrl: z.url().optional() });
export const noteInput = z.object({
  note: z.string().max(2_000).optional(),
  /** Why the customer said no (a decline), in ACP's codes: kept on what they declined. */
  reasonCode: reasonCodeSchema.optional(),
});
/** The customer's details, as long as an email reply can be. */
export const detailsInput = z.object({ note: z.string().max(20_000).optional() });
/**
 * The customer asks for another time than the one we proposed; the end follows the service's duration.
 * While price counters are on (ADR-018 Q1), with a price of their own: the door sends it only then.
 */
export const counterInput = z.object({
  startTime: isoDateTime,
  totalPrice: moneySchema.optional(),
  note: z.string().max(2_000).optional(),
  reasonCode: reasonCodeSchema.optional(),
});
/** An order line as the business proposes it: a catalogue product (productId or sku), or a line of its own. */
const proposedLine = z.object({
  productId: z.string().max(64).optional(),
  sku: z.string().max(100).optional(),
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(1),
  price: moneySchema,
});
/**
 * The changes the business suggests to an order (ADR-018 §3.2): its lines as they would be (a
 * quantity it can make, a price of its own), when it would be delivered, and until when the
 * customer can accept. The total is the lines' prices times their quantities.
 */
export const orderProposeInput = z.object({
  orderedItem: z.array(proposedLine).min(1).max(200),
  delivery: z.object({ method: z.enum(["pickup", "delivery", "digital"]), when: isoDateTime.optional() }).optional(),
  validThrough: isoDateTime.optional(),
  note: z.string().max(2_000).optional(),
});
/**
 * The customer's answer to the changes we suggested to an order: other quantities (by the line's
 * index in what we suggested; 0 drops it) or another delivery date. A unit price of their own only
 * while price counters are on (ADR-018 §4, Q1): the door sends one only then, else it is a message to
 * a person.
 */
export const orderCounterInput = z.object({
  lines: z
    .array(
      z.object({
        index: z.number().int().min(0).max(199),
        quantity: z.number().int().min(0).max(1_000_000),
        unitPrice: moneySchema.optional(),
      }),
    )
    .max(200)
    .optional(),
  deliveryWhen: isoDateTime.optional(),
  note: z.string().max(2_000).optional(),
  reasonCode: reasonCodeSchema.optional(),
});
/** The customer's answer to a quote: how many, or for when. Never a price (Q1): that goes to a person. */
export const quoteCounterInput = z.object({
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  startTime: isoDateTime.optional(),
  note: z.string().max(2_000).optional(),
  reasonCode: reasonCodeSchema.optional(),
});
/**
 * A change we ask for to a confirmed booking (ADR-018 §3.1): the new start, its end (the booking's
 * own length when left out), a price of the owner's, until when the customer can answer, a word
 * with it. Declined or lapsed, the booking stays as it is.
 */
export const changeTimeInput = z.object({
  startTime: isoDateTime,
  endTime: isoDateTime.optional(),
  totalPrice: moneySchema.optional(),
  validThrough: isoDateTime.optional(),
  note: z.string().max(2_000).optional(),
});
/** The customer asks to move their confirmed booking: another start, one we would offer; the end keeps its length. */
export const customerChangeTimeInput = z.object({
  startTime: isoDateTime,
  note: z.string().max(2_000).optional(),
  reasonCode: reasonCodeSchema.optional(),
});
/**
 * A change we ask for to an accepted order (ADR-018 §3.2): its lines as they would be (the order's
 * own when left out), another delivery date, until when the customer can answer. Once payment was
 * asked for or made, the total stays as it is.
 */
export const orderChangeInput = z.object({
  orderedItem: z.array(proposedLine).min(1).max(200).optional(),
  delivery: z.object({ method: z.enum(["pickup", "delivery", "digital"]), when: isoDateTime.optional() }).optional(),
  validThrough: isoDateTime.optional(),
  note: z.string().max(2_000).optional(),
});
/** The customer asks to change their accepted order: other quantities (by line, 0 drops one) or another delivery date. Never a price. */
export const customerOrderChangeInput = z.object({
  lines: z
    .array(z.object({ index: z.number().int().min(0).max(199), quantity: z.number().int().min(0).max(1_000_000) }))
    .max(200)
    .optional(),
  deliveryWhen: isoDateTime.optional(),
  note: z.string().max(2_000).optional(),
  reasonCode: reasonCodeSchema.optional(),
});

/** The owner records a customer's own cancellation: what they said, and when they asked (default now). */
export const recordCancelInput = z.object({
  note: z.string().trim().min(1, "say what the customer said").max(2_000),
  askedAt: isoDateTime.optional(),
});

/**
 * The customer withdraws from the contract (ADR-018 §7): a word for the business, and, once the goods
 * reached them, which lines come back (all of them when none are named).
 */
export const withdrawEventInput = z.object({
  note: z.string().max(2_000).optional(),
  lines: returnLinesSchema.optional(),
});
/**
 * The business records a withdrawal the customer told it of (by email, by phone): what they said, and
 * when — the arrival of their message when `entryId` names it, which is what the owner's AI must do.
 */
export const recordWithdrawalInput = z.object({
  note: z.string().trim().min(1, "say what the customer said").max(2_000),
  askedAt: isoDateTime.optional(),
  /** The customer's message in which they withdrew (a thread entry of this item): its arrival dates it. */
  entryId: z.string().min(1).max(64).optional(),
  lines: returnLinesSchema.optional(),
});
/** The customer asks to send goods back (ADR-018 §3.4): why, which lines, what they would like. */
export const returnInput = z.object({
  reasonCode: returnReasonSchema,
  lines: returnLinesSchema.optional(),
  wants: z.enum(["refund", "exchange", "credit"]).optional(),
  note: z.string().max(2_000).optional(),
});
/**
 * The business records a return the customer asked for by email or phone: judged, as a withdrawal is,
 * when they asked — their message on the item (`entryId`), or the moment a person types.
 */
export const openReturnEventInput = returnInput.extend({
  note: z.string().trim().min(1, "say what the customer asked").max(2_000),
  askedAt: isoDateTime.optional(),
  entryId: z.string().min(1).max(64).optional(),
});
/**
 * The business agrees to a return: whether the goods come back (else it refunds with nothing to
 * return), by when, and how.
 */
export const approveReturnInput = z.object({
  goodsBack: z.boolean().optional(),
  returnBy: isoDateTime.optional(),
  instructions: z
    .object({
      method: z.enum(["post", "drop_off", "collection"]),
      address: z.string().max(500).optional(),
      note: z.string().max(2_000).optional(),
    })
    .optional(),
  note: z.string().max(2_000).optional(),
});
/** Why a return is refused, in words for the customer. */
export const rejectReturnInput = z.object({ note: z.string().trim().min(1, "say why, for the customer").max(2_000) });
/** The goods, or proof of sending them, arrived: when (default now). */
export const goodsBackInput = z.object({ receivedAt: isoDateTime.optional(), note: z.string().max(2_000).optional() });
/** What came back is not what was sold, in words for the customer. */
export const disputeGoodsInput = z.object({
  note: z.string().trim().min(1, "say what came back, for the customer").max(2_000),
});
/** The money went back: the payment's reference, and how much (what is owed when left out). */
export const refundInput = z.object({
  paymentRef: z.string().min(1).max(200),
  amount: moneySchema.optional(),
  note: z.string().max(2_000).optional(),
});
/** When the goods reached the customer (default now): their withdrawal period runs from it. */
export const deliveryInput = z.object({ deliveredAt: isoDateTime.optional(), note: z.string().max(2_000).optional() });
/** An order marked fulfilled, with when the goods reached the customer when that is known. */
export const fulfilInput = noteInput.extend({ deliveredAt: isoDateTime.optional() });

/**
 * Changes to a promise (ADR-018 §3.1, §3.2): either side asks for one, and the other accepts it or
 * says no; the one who asked may withdraw it, and it lapses at its date. The promise stays in its
 * state throughout, and declined, withdrawn or lapsed, it stays as it was. One entry per state, since
 * each leaves the item where it was.
 */
function changeTransitions<S extends string>(
  states: readonly S[],
  o: { readonly business: z.ZodType; readonly customer: z.ZodType; readonly proposeLabel: string },
): Transition<S>[] {
  return states.flatMap((state): Transition<S>[] => [
    {
      event: "propose_change",
      label: o.proposeLabel,
      from: [state],
      to: state,
      by: owners,
      guards: ["promise_ahead", "change_allowed", "not_too_soon", "changes_left", "amendments_live"],
      input: o.business,
      offer: "make",
      change: true,
      effects: ["notify_customer"],
    },
    {
      event: "propose_change",
      label: "Ask for a change",
      from: [state],
      to: state,
      by: customers,
      guards: ["customer_owns_item", "promise_ahead", "not_too_soon", "changes_left", "amendments_live"],
      input: o.customer,
      offer: "make",
      change: true,
      effects: ["notify_owner", "notify_customer"],
    },
    {
      event: "accept_change",
      label: "Accept the change",
      from: [state],
      to: state,
      by: customers,
      guards: [
        "customer_owns_item",
        "change_open",
        "promise_ahead",
        "not_too_soon",
        "slot_available",
        "amendments_live",
      ],
      offer: "take",
      change: true,
      effects: ["apply_change", "claim_slot", "issue_receipt:amended", "notify_owner", "notify_customer"],
    },
    {
      event: "accept_change",
      label: "Accept the change",
      from: [state],
      to: state,
      by: owners,
      guards: ["change_open", "change_allowed", "promise_ahead", "not_too_soon", "slot_available", "amendments_live"],
      offer: "take",
      change: true,
      effects: ["apply_change", "claim_slot", "issue_receipt:amended", "notify_customer"],
    },
    {
      // The customer keeps what was agreed: the change we asked for goes, and so does its hold.
      event: "decline_change",
      label: "Keep it as it is",
      from: [state],
      to: state,
      by: customers,
      guards: ["customer_owns_item", "change_theirs"],
      input: noteInput,
      offer: "keep",
      change: true,
      effects: ["release_hold", "notify_owner", "notify_customer"],
    },
    {
      event: "decline_change",
      label: "Decline the change",
      from: [state],
      to: state,
      by: owners,
      guards: ["change_theirs"],
      input: noteInput,
      offer: "keep",
      change: true,
      effects: ["notify_customer"],
    },
    {
      event: "retract_change",
      label: "Withdraw my change",
      from: [state],
      to: state,
      by: customers,
      guards: ["customer_owns_item", "change_mine"],
      input: noteInput,
      offer: "keep",
      change: true,
      effects: ["notify_owner", "notify_customer"],
    },
    {
      // Only what we said was subject to our confirmation (`negotiation.binding` off).
      event: "retract_change",
      label: "Withdraw the change",
      from: [state],
      to: state,
      by: owners,
      guards: ["change_mine", "offer_non_binding"],
      input: noteInput,
      offer: "keep",
      change: true,
      effects: ["release_hold", "notify_customer"],
    },
    {
      event: "expire_change",
      label: "Expire the change",
      from: [state],
      to: state,
      by: ["system"],
      guards: ["change_lapsed"],
      offer: "keep",
      change: true,
      effects: ["release_hold", "notify_customer"],
    },
  ]);
}

export type BookingState =
  | "requested"
  | "needs_info"
  | "proposed"
  | "confirmed"
  | "completed"
  | "no_show"
  | "cancelled_by_customer"
  | "cancelled_by_business"
  | "declined"
  | "expired";

export const bookingMachine: Machine<BookingState> = {
  type: "booking",
  initial: "requested",
  states: [
    "requested",
    "needs_info",
    "proposed",
    "confirmed",
    "completed",
    "no_show",
    "cancelled_by_customer",
    "cancelled_by_business",
    "declined",
    "expired",
  ],
  terminal: ["completed", "no_show", "cancelled_by_customer", "cancelled_by_business", "declined", "expired"],
  transitions: [
    {
      // A question instead of the time we proposed withdraws it; the customer's request stands.
      event: "request_info",
      label: "Ask for details",
      from: ["requested", "proposed"],
      to: "needs_info",
      by: owners,
      input: noteInput,
      offer: "withdraw",
      effects: ["release_hold", "notify_customer"],
    },
    {
      event: "provide_info",
      label: "Send details",
      from: ["needs_info"],
      to: "requested",
      by: [...customers, "connector"],
      input: detailsInput,
      effects: ["notify_owner"],
    },
    {
      // From `proposed`, another time replaces the one we proposed (ADR-018 §3.5).
      event: "propose",
      label: "Propose another time",
      from: ["requested", "needs_info", "proposed"],
      to: "proposed",
      by: owners,
      guards: ["not_too_soon"],
      input: proposeInput,
      offer: "make",
      effects: ["notify_customer"],
    },
    {
      event: "accept",
      label: "Accept the proposed time",
      from: ["proposed"],
      to: "confirmed",
      by: customers,
      guards: ["proposal_present", "slot_available", "not_too_soon", "offer_open"],
      offer: "take",
      effects: ["apply_proposal", "claim_slot", "issue_receipt:confirmed", "notify_owner", "notify_customer"],
    },
    {
      // From `needs_info` too: the owner has what they need, however it came (ADR-018 N14).
      event: "confirm",
      label: "Confirm booking",
      from: ["requested", "needs_info"],
      to: "confirmed",
      by: owners,
      guards: ["slot_available", "not_too_soon"],
      offer: "take",
      effects: ["claim_slot", "issue_receipt:confirmed", "notify_customer"],
    },
    {
      // The customer said yes to the time we proposed, by phone, email or in person: it books that
      // time (ADR-018 N13). Only a person records a yes a person heard.
      event: "confirm",
      label: "Confirm the proposed time",
      from: ["proposed"],
      to: "confirmed",
      by: owners,
      byPerson: true,
      internalNote: true,
      guards: ["proposal_present", "slot_available", "not_too_soon"],
      offer: "take",
      effects: ["apply_proposal", "claim_slot", "issue_receipt:confirmed", "notify_customer"],
    },
    {
      // The customer's own other time: back to the business to confirm, with nothing held.
      event: "counter",
      label: "Pick another time",
      from: ["proposed"],
      to: "requested",
      by: customers,
      guards: ["customer_owns_item", "not_too_soon"],
      input: counterInput,
      offer: "make",
      effects: ["apply_counter", "release_hold", "notify_owner", "notify_customer"],
    },
    {
      // A time we proposed "subject to our confirmation" (`negotiation.binding` off), withdrawn
      // before the customer answered: their request stands, with us.
      event: "retract",
      label: "Withdraw the proposed time",
      from: ["proposed"],
      to: "requested",
      by: owners,
      guards: ["offer_non_binding"],
      input: noteInput,
      offer: "withdraw",
      effects: ["release_hold", "notify_customer"],
    },
    {
      event: "decline",
      label: "Decline",
      from: ["requested", "needs_info", "proposed"],
      to: "declined",
      by: owners,
      input: noteInput,
      offer: "end",
      effects: ["release_slot", "notify_customer", "close"],
    },
    // A rule may let a request go as it always could, and a time we proposed once it has lapsed
    // (it binds us until then); the system does when its time has come: a request nobody answered
    // (`booking.autoExpireHours`), or a time we proposed past its validity.
    {
      event: "expire",
      label: "Expire",
      from: ["requested", "needs_info"],
      to: "expired",
      by: ["rule"],
      offer: "end",
      effects: ["release_slot", "notify_customer", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["proposed"],
      to: "expired",
      by: ["rule"],
      guards: ["offer_lapsed"],
      offer: "end",
      effects: ["release_slot", "notify_customer", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["requested", "needs_info"],
      to: "expired",
      by: ["system"],
      guards: ["request_lapsed"],
      offer: "end",
      effects: ["release_slot", "notify_customer", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["proposed"],
      to: "expired",
      by: ["system"],
      guards: ["offer_lapsed"],
      offer: "end",
      effects: ["release_slot", "notify_customer", "close"],
    },
    // ADR-017 §3.1: an event that differs by from-state or actor is several entries of the same
    // name. Only the entries that leave a promise (`confirmed`) close it with an outcome.
    {
      event: "cancel",
      label: "Cancel booking",
      from: ["requested", "needs_info", "proposed"],
      to: "cancelled_by_customer",
      by: customers,
      guards: ["customer_owns_item"],
      input: noteInput,
      offer: "end",
      effects: ["release_slot", "notify_owner", "notify_customer", "close"],
    },
    {
      event: "cancel",
      label: "Cancel booking",
      from: ["confirmed"],
      to: "cancelled_by_customer",
      by: customers,
      guards: ["customer_owns_item", "within_cancellation_window"],
      input: noteInput,
      effects: ["release_slot", "issue_receipt:outcome", "notify_owner", "notify_customer", "close"],
    },
    {
      // Fired by `cancel_item` once the window has closed, when the owner records late cancellations.
      event: "cancel_late",
      label: "Cancel booking late",
      from: ["confirmed"],
      to: "cancelled_by_customer",
      by: customers,
      guards: ["customer_owns_item", "outside_cancellation_window"],
      input: noteInput,
      effects: ["release_slot", "issue_receipt:outcome", "notify_owner", "notify_customer", "close"],
      unlisted: true,
    },
    {
      event: "cancel_by_business",
      label: "Cancel booking",
      from: ["requested", "needs_info", "proposed"],
      to: "cancelled_by_business",
      by: owners,
      input: noteInput,
      offer: "end",
      effects: ["release_slot", "notify_customer", "close"],
    },
    {
      // Once paid for, what was paid is owed back by a date, and only a person cancels it (ADR-018 §3.2).
      event: "cancel_by_business",
      label: "Cancel booking",
      from: ["confirmed"],
      to: "cancelled_by_business",
      by: owners,
      input: noteInput,
      effects: ["release_slot", "issue_receipt:outcome", "link_refund", "notify_customer", "close"],
    },
    // The customer asked the business to cancel (by phone, email, in person) and the business
    // records it: the customer's cancellation, never the business's, judged at the moment they
    // asked as the customer's own door would have judged it (ADR-017 §3.1).
    {
      event: "record_cancel",
      label: "Customer cancelled",
      from: ["requested", "needs_info", "proposed"],
      to: "cancelled_by_customer",
      by: recorders,
      internalNote: true,
      input: recordCancelInput,
      offer: "end",
      effects: ["release_slot", "notify_customer", "close"],
    },
    {
      event: "record_cancel",
      label: "Customer cancelled",
      from: ["confirmed"],
      to: "cancelled_by_customer",
      by: recorders,
      internalNote: true,
      guards: ["asked_within_window"],
      input: recordCancelInput,
      effects: ["release_slot", "issue_receipt:outcome", "notify_customer", "close"],
    },
    {
      // Fired by the owner door once `record_cancel` found the window closed when the customer asked,
      // where the owner records late cancellations.
      event: "record_cancel_late",
      label: "Customer cancelled late",
      from: ["confirmed"],
      to: "cancelled_by_customer",
      by: recorders,
      internalNote: true,
      guards: ["asked_outside_window"],
      input: recordCancelInput,
      effects: ["release_slot", "issue_receipt:outcome", "notify_customer", "close"],
      unlisted: true,
    },
    // A payment or deposit for the booking: it gates nothing, but makes the booking a paid contract
    // made at a distance, which the customer may withdraw from (ADR-018 §3.1, §7).
    {
      event: "record_payment",
      label: "Record payment",
      from: ["confirmed"],
      to: "confirmed",
      by: ["connector", "owner", "staff"],
      input: paymentInput,
      effects: ["notify_customer"],
    },
    // The customer withdraws from a booking they paid for at a distance (ADR-018 §7): never late, and
    // what they paid comes back. Fired by the withdrawal door; the business records one it was told of.
    {
      event: "withdraw",
      label: "Withdraw from contract",
      from: ["confirmed"],
      to: "cancelled_by_customer",
      by: customers,
      guards: ["customer_owns_item", "withdrawal_open"],
      input: withdrawEventInput,
      effects: ["release_slot", "issue_receipt:outcome", "link_refund", "notify_owner", "notify_customer", "close"],
      unlisted: true,
    },
    {
      event: "record_withdrawal",
      label: "Customer withdrew",
      from: ["confirmed"],
      to: "cancelled_by_customer",
      by: recorders,
      internalNote: true,
      guards: ["withdrawal_open"],
      input: recordWithdrawalInput,
      effects: ["release_slot", "issue_receipt:outcome", "link_refund", "notify_customer", "close"],
    },
    ...changeTransitions<BookingState>(["confirmed"], {
      business: changeTimeInput,
      customer: customerChangeTimeInput,
      proposeLabel: "Suggest another time",
    }),
    {
      event: "complete",
      label: "Mark completed",
      from: ["confirmed"],
      to: "completed",
      by: ownersAndSystem,
      effects: ["issue_receipt:outcome", "review_fact", "close"],
    },
    {
      event: "no_show",
      label: "Mark no-show",
      from: ["confirmed"],
      to: "no_show",
      by: ["owner", "staff"],
      effects: ["issue_receipt:outcome", "review_fact", "close"],
    },
    // Corrections: a no-show recorded by mistake, or a completion that was one. Once each item,
    // until `booking.autoCompleteHours` after the end; the later outcome is the one that stands on
    // the customer's side (§3.3), and the business's side is unchanged by either.
    {
      event: "complete",
      label: "Correct: it happened",
      from: ["no_show"],
      to: "completed",
      by: ["owner", "staff"],
      guards: ["within_correction_window"],
      effects: ["issue_receipt:outcome", "close"],
      amends: true,
    },
    {
      event: "no_show",
      label: "Correct: no-show",
      from: ["completed"],
      to: "no_show",
      by: ["owner", "staff"],
      guards: ["within_correction_window"],
      effects: ["issue_receipt:outcome", "close"],
      amends: true,
    },
  ],
};

export type OrderState =
  | "received"
  | "needs_info"
  /** We suggested changes (a quantity, a price, a delivery date) and wait for the customer's answer. */
  | "proposed"
  | "accepted"
  | "awaiting_payment"
  | "payment_failed"
  | "paid"
  | "fulfilling"
  | "fulfilled"
  | "completed"
  | "declined"
  | "cancelled"
  | "charged_back"
  /** Nobody answered in time: the order was never promised. */
  | "expired";

/** Who records payments and their reversals: the payment connector, the owner, staff. */
const payers = ["connector", "owner", "staff"] as const;

export const orderMachine: Machine<OrderState> = {
  type: "order",
  initial: "received",
  states: [
    "received",
    "needs_info",
    "proposed",
    "accepted",
    "awaiting_payment",
    "payment_failed",
    "paid",
    "fulfilling",
    "fulfilled",
    "completed",
    "declined",
    "cancelled",
    "charged_back",
    "expired",
  ],
  terminal: ["completed", "declined", "cancelled", "charged_back", "expired"],
  transitions: [
    {
      event: "request_info",
      label: "Ask for details",
      from: ["received", "proposed"],
      to: "needs_info",
      by: owners,
      input: noteInput,
      offer: "withdraw",
      effects: ["notify_customer"],
    },
    {
      event: "provide_info",
      label: "Send details",
      from: ["needs_info"],
      to: "received",
      by: [...customers, "connector"],
      input: detailsInput,
      effects: ["notify_owner"],
    },
    {
      // What we can do instead (ADR-018 §3.2): other quantities, another price, a delivery date.
      // From `proposed`, it replaces what we suggested before.
      event: "propose",
      label: "Suggest changes",
      from: ["received", "needs_info", "proposed"],
      to: "proposed",
      by: owners,
      input: orderProposeInput,
      offer: "make",
      effects: ["notify_customer"],
    },
    {
      event: "accept",
      label: "Accept order",
      from: ["received", "needs_info"],
      to: "accepted",
      by: owners,
      offer: "take",
      effects: ["issue_receipt:accepted", "notify_customer"],
    },
    {
      // The customer takes the changes we suggested: the order is accepted on them.
      event: "accept",
      label: "Accept the changes",
      from: ["proposed"],
      to: "accepted",
      by: customers,
      guards: ["customer_owns_item", "proposal_present", "offer_open"],
      offer: "take",
      effects: ["apply_offer", "issue_receipt:accepted", "notify_owner", "notify_customer"],
    },
    {
      // The customer said yes to our changes by phone, email or in person. Only a person records it.
      event: "accept",
      label: "Customer accepted the changes",
      from: ["proposed"],
      to: "accepted",
      by: owners,
      byPerson: true,
      internalNote: true,
      guards: ["proposal_present"],
      offer: "take",
      effects: ["apply_offer", "issue_receipt:accepted", "notify_customer"],
    },
    {
      // The customer's own quantities or delivery date: back to us to accept.
      event: "counter",
      label: "Suggest a change",
      from: ["proposed"],
      to: "received",
      by: customers,
      guards: ["customer_owns_item", "proposal_present"],
      input: orderCounterInput,
      offer: "make",
      effects: ["apply_counter", "notify_owner", "notify_customer"],
    },
    {
      event: "retract",
      label: "Withdraw the changes",
      from: ["proposed"],
      to: "received",
      by: owners,
      guards: ["offer_non_binding"],
      input: noteInput,
      offer: "withdraw",
      effects: ["notify_customer"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["received", "needs_info"],
      to: "expired",
      by: ["system"],
      guards: ["request_lapsed"],
      offer: "end",
      effects: ["notify_customer", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["proposed"],
      to: "expired",
      by: ["system"],
      guards: ["offer_lapsed"],
      offer: "end",
      effects: ["notify_customer", "close"],
    },
    {
      event: "request_payment",
      label: "Request payment",
      from: ["accepted"],
      to: "awaiting_payment",
      by: owners,
      input: paymentRequestInput,
      effects: ["notify_customer"],
    },
    {
      event: "record_payment",
      label: "Record payment",
      from: ["accepted", "awaiting_payment", "payment_failed"],
      to: "paid",
      by: [...payers, "system"],
      input: paymentInput,
      effects: ["issue_receipt:paid", "notify_customer"],
    },
    {
      event: "payment_failed",
      label: "Payment failed",
      from: ["awaiting_payment"],
      to: "payment_failed",
      by: [...payers, "system"],
      input: noteInput,
      effects: ["issue_receipt:outcome", "notify_customer"],
    },
    {
      event: "start_fulfilment",
      label: "Start fulfilment",
      from: ["accepted", "paid"],
      to: "fulfilling",
      by: [...owners, "connector"],
      effects: [],
    },
    {
      event: "fulfil",
      label: "Mark fulfilled",
      from: ["accepted", "paid", "fulfilling"],
      to: "fulfilled",
      by: [...owners, "connector"],
      input: fulfilInput,
      effects: ["issue_receipt:outcome", "notify_customer"],
    },
    // When the goods reached the customer: their withdrawal period runs from it (ADR-018 §7).
    {
      event: "record_delivery",
      label: "Record delivery",
      from: ["fulfilled"],
      to: "fulfilled",
      by: ["owner", "staff", "connector"],
      input: deliveryInput,
      effects: [],
    },
    {
      event: "record_delivery",
      label: "Record delivery",
      from: ["completed"],
      to: "completed",
      by: ["owner", "staff", "connector"],
      input: deliveryInput,
      effects: [],
      amends: true,
    },
    {
      event: "complete",
      label: "Mark completed",
      from: ["fulfilled"],
      to: "completed",
      by: ownersAndSystem,
      effects: ["review_fact", "close"],
    },
    {
      event: "decline",
      label: "Decline",
      from: ["received", "needs_info", "proposed"],
      to: "declined",
      by: owners,
      input: noteInput,
      offer: "end",
      effects: ["notify_customer", "close"],
    },
    // ADR-017 §3.1: before the order is accepted a cancel promises nothing and closes nothing;
    // after it, the owners' cancel is a promise not kept and the customer's is a neutral close.
    // The customer's cancel of changes we suggested is their no to them.
    {
      event: "cancel",
      label: "Cancel order",
      from: ["received", "needs_info", "proposed"],
      to: "cancelled",
      by: [...customers, ...owners],
      guards: ["customer_owns_item"],
      input: noteInput,
      offer: "end",
      effects: ["notify_owner", "notify_customer", "close"],
    },
    {
      event: "cancel",
      label: "Cancel order",
      from: ["accepted", "awaiting_payment", "payment_failed"],
      to: "cancelled",
      by: customers,
      guards: ["customer_owns_item"],
      input: noteInput,
      // Both sides are told, as they were before the split.
      effects: ["issue_receipt:outcome", "notify_owner", "notify_customer", "close"],
    },
    {
      event: "cancel",
      label: "Cancel order",
      from: ["accepted", "awaiting_payment", "payment_failed"],
      to: "cancelled",
      by: owners,
      input: noteInput,
      effects: ["issue_receipt:outcome", "notify_owner", "notify_customer", "close"],
    },
    // A paid order the business cannot fulfil: cancelled by a person, never by its AI or a rule, and
    // what was paid is owed back at once (ADR-018 §3.2).
    {
      event: "cancel",
      label: "Cancel and refund",
      from: ["paid", "fulfilling"],
      to: "cancelled",
      by: owners,
      byPerson: true,
      input: noteInput,
      effects: ["issue_receipt:outcome", "link_refund", "notify_customer", "close"],
    },
    // The customer asked the business to cancel and the business records it: their cancellation,
    // not a promise the business broke (ADR-017 §3.1). A paid order is refunded instead.
    {
      event: "record_cancel",
      label: "Customer cancelled",
      from: ["received", "needs_info", "proposed"],
      to: "cancelled",
      by: recorders,
      internalNote: true,
      input: recordCancelInput,
      offer: "end",
      effects: ["notify_customer", "close"],
    },
    {
      event: "record_cancel",
      label: "Customer cancelled",
      from: ["accepted", "awaiting_payment", "payment_failed", "paid", "fulfilling"],
      to: "cancelled",
      by: recorders,
      internalNote: true,
      input: recordCancelInput,
      // Once paid, what they paid is theirs to ask back: a refund request, for the business to settle.
      effects: ["issue_receipt:outcome", "link_refund", "notify_customer", "close"],
    },
    // The customer withdraws from the order (ADR-018 §7): before the goods go out it ends the order,
    // neutrally, and what was paid comes back; after, the order stands (it was fulfilled) and the goods
    // come back as a return. Fired by the withdrawal door; the business records one it was told of.
    {
      event: "withdraw",
      label: "Withdraw from contract",
      from: ["accepted", "awaiting_payment", "payment_failed", "paid", "fulfilling"],
      to: "cancelled",
      by: customers,
      guards: ["customer_owns_item", "withdrawal_open"],
      input: withdrawEventInput,
      effects: ["issue_receipt:outcome", "link_refund", "notify_owner", "notify_customer", "close"],
      unlisted: true,
    },
    {
      event: "withdraw",
      label: "Withdraw from contract",
      from: ["fulfilled"],
      to: "fulfilled",
      by: customers,
      guards: ["customer_owns_item", "withdrawal_open", "no_open_return"],
      input: withdrawEventInput,
      effects: ["link_refund", "notify_owner"],
      unlisted: true,
    },
    {
      event: "withdraw",
      label: "Withdraw from contract",
      from: ["completed"],
      to: "completed",
      by: customers,
      guards: ["customer_owns_item", "withdrawal_open", "no_open_return"],
      input: withdrawEventInput,
      effects: ["link_refund", "notify_owner"],
      unlisted: true,
      amends: true,
    },
    {
      event: "record_withdrawal",
      label: "Customer withdrew",
      from: ["accepted", "awaiting_payment", "payment_failed", "paid", "fulfilling"],
      to: "cancelled",
      by: recorders,
      internalNote: true,
      guards: ["withdrawal_open"],
      input: recordWithdrawalInput,
      effects: ["issue_receipt:outcome", "link_refund", "notify_customer", "close"],
    },
    {
      event: "record_withdrawal",
      label: "Customer withdrew",
      from: ["fulfilled"],
      to: "fulfilled",
      by: recorders,
      internalNote: true,
      guards: ["withdrawal_open", "no_open_return"],
      input: recordWithdrawalInput,
      effects: ["link_refund"],
    },
    {
      event: "record_withdrawal",
      label: "Customer withdrew",
      from: ["completed"],
      to: "completed",
      by: recorders,
      internalNote: true,
      guards: ["withdrawal_open", "no_open_return"],
      input: recordWithdrawalInput,
      effects: ["link_refund"],
      amends: true,
    },
    // A return the customer asks for once the goods reached them (ADR-018 §3.4): faulty goods, a
    // withdrawal within the period, or the business's own policy; the order stands as fulfilled.
    {
      event: "request_return",
      label: "Send it back",
      from: ["fulfilled"],
      to: "fulfilled",
      by: customers,
      guards: ["customer_owns_item", "no_open_return"],
      input: returnInput,
      effects: ["link_refund", "notify_owner"],
      unlisted: true,
    },
    {
      event: "request_return",
      label: "Send it back",
      from: ["completed"],
      to: "completed",
      by: customers,
      guards: ["customer_owns_item", "no_open_return"],
      input: returnInput,
      effects: ["link_refund", "notify_owner"],
      unlisted: true,
      amends: true,
    },
    // …or one they asked for by email or phone, which the business writes down; it answers it later.
    {
      event: "open_return",
      label: "Open a return",
      from: ["fulfilled"],
      to: "fulfilled",
      by: recorders,
      internalNote: true,
      guards: ["no_open_return"],
      input: openReturnEventInput,
      effects: ["link_refund"],
    },
    {
      event: "open_return",
      label: "Open a return",
      from: ["completed"],
      to: "completed",
      by: recorders,
      internalNote: true,
      guards: ["no_open_return"],
      input: openReturnEventInput,
      effects: ["link_refund"],
      amends: true,
    },
    {
      event: "charge_back",
      label: "Record a charge-back",
      from: ["paid", "fulfilling", "fulfilled"],
      to: "charged_back",
      by: payers,
      input: noteInput,
      effects: ["issue_receipt:outcome", "close"],
    },
    {
      event: "record_charge_back",
      label: "Record a charge-back",
      from: ["completed"],
      to: "completed",
      by: payers,
      guards: ["not_charged_back"],
      input: noteInput,
      effects: ["issue_receipt:outcome"],
      amends: true,
    },
    // The system's neutral close of a payment nobody made (`orders.payDays` after it was
    // requested). The order stays as it is, so a late payment is still taken.
    {
      event: "lapse",
      label: "Lapse",
      from: ["awaiting_payment"],
      to: "awaiting_payment",
      by: ["system"],
      guards: ["payment_overdue"],
      effects: ["issue_receipt:outcome"],
    },
    {
      event: "lapse",
      label: "Lapse",
      from: ["payment_failed"],
      to: "payment_failed",
      by: ["system"],
      guards: ["payment_overdue"],
      effects: ["issue_receipt:outcome"],
    },
    ...changeTransitions<OrderState>(["accepted", "awaiting_payment", "payment_failed", "paid", "fulfilling"], {
      business: orderChangeInput,
      customer: customerOrderChangeInput,
      proposeLabel: "Suggest changes",
    }),
  ],
};

export type QuoteState = "received" | "needs_info" | "quoted" | "accepted" | "declined" | "expired";

export const quoteMachine: Machine<QuoteState> = {
  type: "quote_request",
  initial: "received",
  states: ["received", "needs_info", "quoted", "accepted", "declined", "expired"],
  terminal: ["accepted", "declined", "expired"],
  transitions: [
    {
      event: "request_info",
      label: "Ask for details",
      from: ["received"],
      to: "needs_info",
      by: owners,
      input: noteInput,
      offer: "withdraw",
      effects: ["notify_customer"],
    },
    {
      event: "provide_info",
      label: "Send details",
      from: ["needs_info"],
      to: "received",
      by: [...customers, "connector"],
      input: detailsInput,
      effects: ["notify_owner"],
    },
    {
      // A new quote on a quoted request replaces the one before (ADR-018 §3.3).
      event: "quote",
      label: "Send quote",
      from: ["received", "needs_info", "quoted"],
      to: "quoted",
      by: owners,
      guards: ["quote_complete"],
      input: quoteInput,
      offer: "make",
      effects: ["notify_customer"],
    },
    {
      // Accepting creates the promise, in the same batch: the booking confirmed with its slot
      // claimed, or the order accepted (ADR-018 §3.3).
      event: "accept",
      label: "Accept quote",
      from: ["quoted"],
      to: "accepted",
      by: customers,
      guards: ["customer_owns_item", "has_quote", "offer_open", "not_too_soon", "slot_available"],
      offer: "take",
      effects: ["link_item", "notify_owner", "notify_customer", "close"],
    },
    {
      // The customer asks for the quote again for another quantity or time: back to us to quote.
      event: "counter",
      label: "Ask for another quote",
      from: ["quoted"],
      to: "received",
      by: customers,
      guards: ["customer_owns_item", "has_quote"],
      input: quoteCounterInput,
      offer: "make",
      effects: ["apply_counter", "notify_owner", "notify_customer"],
    },
    {
      event: "retract",
      label: "Withdraw the quote",
      from: ["quoted"],
      to: "received",
      by: owners,
      guards: ["offer_non_binding"],
      input: noteInput,
      offer: "withdraw",
      effects: ["notify_customer"],
    },
    {
      event: "decline",
      label: "Decline",
      from: ["received", "needs_info", "quoted"],
      to: "declined",
      by: [...owners, ...customers],
      input: noteInput,
      offer: "end",
      effects: ["notify_customer", "notify_owner", "close"],
    },
    {
      // A quote binds us until its date: a rule lets it go only once that has passed.
      event: "expire",
      label: "Expire",
      from: ["quoted"],
      to: "expired",
      by: ["rule"],
      guards: ["offer_lapsed"],
      offer: "end",
      effects: ["notify_customer", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["quoted"],
      to: "expired",
      by: ["system"],
      guards: ["offer_lapsed"],
      offer: "end",
      effects: ["notify_customer", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["received", "needs_info"],
      to: "expired",
      by: ["system"],
      guards: ["request_lapsed"],
      offer: "end",
      effects: ["notify_customer", "close"],
    },
  ],
};

export type MessageState = "open" | "answered" | "closed" | "spam";

export const messageMachine: Machine<MessageState> = {
  type: "message",
  initial: "open",
  states: ["open", "answered", "closed", "spam"],
  terminal: [],
  transitions: [
    { event: "answer", label: "Reply", from: ["open"], to: "answered", by: owners, effects: ["notify_customer"] },
    {
      event: "reopen",
      label: "Reopen",
      from: ["answered", "closed"],
      to: "open",
      by: [...customers, ...owners, "system"],
      // A customer's reply reopens it, however long they write.
      input: detailsInput,
      effects: ["notify_owner"],
    },
    { event: "close", label: "Close", from: ["open", "answered"], to: "closed", by: owners, effects: ["close"] },
    {
      event: "mark_spam",
      label: "Mark as spam",
      from: ["open", "answered"],
      to: "spam",
      by: owners,
      effects: ["close"],
    },
    { event: "unspam", label: "Not spam", from: ["spam"], to: "open", by: ["owner", "staff"], effects: [] },
  ],
};

/**
 * A return or a refund (ADR-018 §3.4): asked for (`requested`), agreed (`approved`, with what has to
 * come back and by when), the goods back (`goods_received`), and settled (`refunded`); or refused
 * (`rejected`, never a withdrawal within the period), or dropped by the customer (`cancelled`). A
 * withdrawal, and a paid order the business cancelled, start agreed.
 */
export type RefundState = "requested" | "approved" | "goods_received" | "refunded" | "rejected" | "cancelled";

export const refundMachine: Machine<RefundState> = {
  type: "refund",
  initial: "requested",
  states: ["requested", "approved", "goods_received", "refunded", "rejected", "cancelled"],
  terminal: ["rejected", "refunded", "cancelled"],
  transitions: [
    {
      event: "approve",
      label: "Approve the return",
      from: ["requested"],
      to: "approved",
      by: ["owner", "staff", "owner_ai", "rule"],
      guards: ["return_allowed"],
      input: approveReturnInput,
      // With nothing to come back, its date is fixed here, and so is the promise (ADR-018 §8).
      effects: ["notify_customer", "issue_receipt:accepted"],
    },
    {
      // A person, with the reason the customer reads; never a withdrawal within the period.
      event: "reject",
      label: "Refuse the return",
      from: ["requested"],
      to: "rejected",
      by: ["owner", "staff"],
      byPerson: true,
      guards: ["not_withdrawal"],
      input: rejectReturnInput,
      effects: ["notify_customer", "close"],
    },
    {
      event: "goods_back",
      label: "Goods received",
      from: ["approved"],
      to: "goods_received",
      by: ["owner", "staff", "connector"],
      guards: ["goods_expected"],
      input: goodsBackInput,
      // The goods are back: the date the refund is due is fixed, and it is promised.
      effects: ["notify_customer", "issue_receipt:accepted"],
    },
    {
      // What came back is not what was sold: the refund waits while a person sorts it out with them.
      event: "dispute_goods",
      label: "Not what we sold",
      from: ["goods_received"],
      to: "goods_received",
      by: ["owner", "staff"],
      byPerson: true,
      input: disputeGoodsInput,
      effects: ["notify_customer"],
    },
    {
      event: "refund",
      label: "Mark refunded",
      from: ["approved", "goods_received"],
      to: "refunded",
      by: ["connector", "owner", "staff"],
      guards: ["refund_amount"],
      input: refundInput,
      // Paid by its date or after it (ADR-017 Amendment 3); paid before any date was fixed, the promise
      // is made and kept at once.
      effects: ["review_fact", "issue_receipt:outcome", "notify_customer", "close"],
    },
    // The customer keeps the goods; money owed with nothing to send back is not theirs to drop by a
    // click, and nor is money owed for goods the business already has back (they could not keep
    // them): a person records that. Before anything was agreed nothing was promised; after, dropping
    // it closes the promise.
    ...(["requested", "agreed"] as const).map(
      (when): Transition<RefundState> => ({
        event: "cancel",
        label: "Cancel the return",
        from: when === "requested" ? ["requested"] : ["approved"],
        to: "cancelled",
        by: customers,
        guards: ["customer_owns_item", "goods_expected"],
        input: noteInput,
        effects:
          when === "requested"
            ? ["notify_owner", "notify_customer", "close"]
            : ["issue_receipt:outcome", "notify_owner", "notify_customer", "close"],
      }),
    ),
    // Dropping what we owe back is a person's, as refusing it is: never the owner's AI's (ADR-018 §4).
    ...(["requested", "agreed"] as const).map(
      (when): Transition<RefundState> => ({
        event: "record_cancel",
        label: "Customer dropped it",
        from: when === "requested" ? ["requested"] : ["approved", "goods_received"],
        to: "cancelled",
        by: recorders,
        byPerson: true,
        internalNote: true,
        input: recordCancelInput,
        effects:
          when === "requested" ? ["notify_customer", "close"] : ["issue_receipt:outcome", "notify_customer", "close"],
      }),
    ),
  ],
};

export const machines: Record<ItemType, Machine> = {
  message: messageMachine as Machine,
  quote_request: quoteMachine as Machine,
  booking: bookingMachine as Machine,
  order: orderMachine as Machine,
  refund: refundMachine as Machine,
};
