import { z } from "zod";
import { BUSINESS_ACTORS, CUSTOMER_ACTORS, type ItemType, isoDateTime, moneySchema } from "../domain/types";
import type { Machine } from "./machine";

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
export const quoteInput = z.object({
  totalPrice: moneySchema,
  validThrough: isoDateTime,
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
export const noteInput = z.object({ note: z.string().max(2_000).optional() });
/** The customer's details, as long as an email reply can be. */
export const detailsInput = z.object({ note: z.string().max(20_000).optional() });
/** The customer asks for another time than the one we proposed. The end follows the service's duration. */
export const counterInput = z.object({ startTime: isoDateTime, note: z.string().max(2_000).optional() });
/** The owner records a customer's own cancellation: what they said, and when they asked (default now). */
export const recordCancelInput = z.object({
  note: z.string().trim().min(1, "say what the customer said").max(2_000),
  askedAt: isoDateTime.optional(),
});

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
      event: "request_info",
      label: "Ask for details",
      from: ["requested", "proposed"],
      to: "needs_info",
      by: owners,
      input: noteInput,
      effects: ["notify_customer"],
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
      event: "propose",
      label: "Propose another time",
      from: ["requested", "needs_info"],
      to: "proposed",
      by: owners,
      guards: ["not_too_soon"],
      input: proposeInput,
      effects: ["notify_customer"],
    },
    {
      event: "accept",
      label: "Accept the proposed time",
      from: ["proposed"],
      to: "confirmed",
      by: customers,
      guards: ["proposal_present", "slot_available", "not_too_soon"],
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
      effects: ["apply_counter", "notify_owner", "notify_customer"],
    },
    {
      event: "decline",
      label: "Decline",
      from: ["requested", "needs_info", "proposed"],
      to: "declined",
      by: owners,
      input: noteInput,
      effects: ["release_slot", "notify_customer", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["requested", "needs_info", "proposed"],
      to: "expired",
      by: ["rule", "system"],
      effects: ["release_slot", "close"],
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
      effects: ["release_slot", "notify_customer", "close"],
    },
    {
      event: "cancel_by_business",
      label: "Cancel booking",
      from: ["confirmed"],
      to: "cancelled_by_business",
      by: owners,
      input: noteInput,
      effects: ["release_slot", "issue_receipt:outcome", "notify_customer", "close"],
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
  | "accepted"
  | "awaiting_payment"
  | "payment_failed"
  | "paid"
  | "fulfilling"
  | "fulfilled"
  | "completed"
  | "declined"
  | "cancelled"
  | "charged_back";

/** Who records payments and their reversals: the payment connector, the owner, staff. */
const payers = ["connector", "owner", "staff"] as const;

export const orderMachine: Machine<OrderState> = {
  type: "order",
  initial: "received",
  states: [
    "received",
    "needs_info",
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
  ],
  terminal: ["completed", "declined", "cancelled", "charged_back"],
  transitions: [
    {
      event: "request_info",
      label: "Ask for details",
      from: ["received"],
      to: "needs_info",
      by: owners,
      input: noteInput,
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
      event: "accept",
      label: "Accept order",
      from: ["received", "needs_info"],
      to: "accepted",
      by: owners,
      effects: ["issue_receipt:accepted", "notify_customer"],
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
      effects: ["issue_receipt:outcome", "notify_customer"],
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
      from: ["received", "needs_info"],
      to: "declined",
      by: owners,
      input: noteInput,
      effects: ["notify_customer", "close"],
    },
    // ADR-017 §3.1: before the order is accepted a cancel promises nothing and closes nothing;
    // after it, the owners' cancel is a promise not kept and the customer's is a neutral close.
    {
      event: "cancel",
      label: "Cancel order",
      from: ["received", "needs_info"],
      to: "cancelled",
      by: [...customers, ...owners],
      guards: ["customer_owns_item"],
      input: noteInput,
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
    // The customer asked the business to cancel and the business records it: their cancellation,
    // not a promise the business broke (ADR-017 §3.1). A paid order is refunded instead.
    {
      event: "record_cancel",
      label: "Customer cancelled",
      from: ["received", "needs_info"],
      to: "cancelled",
      by: recorders,
      internalNote: true,
      input: recordCancelInput,
      effects: ["notify_customer", "close"],
    },
    {
      event: "record_cancel",
      label: "Customer cancelled",
      from: ["accepted", "awaiting_payment", "payment_failed"],
      to: "cancelled",
      by: recorders,
      internalNote: true,
      input: recordCancelInput,
      effects: ["issue_receipt:outcome", "notify_customer", "close"],
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
      guards: ["customer_owns_item", "has_quote", "quote_valid", "not_too_soon", "slot_available"],
      effects: ["link_item", "notify_owner", "notify_customer", "close"],
    },
    {
      event: "decline",
      label: "Decline",
      from: ["received", "needs_info", "quoted"],
      to: "declined",
      by: [...owners, ...customers],
      input: noteInput,
      effects: ["notify_customer", "notify_owner", "close"],
    },
    { event: "expire", label: "Expire", from: ["quoted"], to: "expired", by: ["rule", "system"], effects: ["close"] },
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

export type RefundState = "requested" | "approved" | "rejected" | "refunded";

export const refundMachine: Machine<RefundState> = {
  type: "refund",
  initial: "requested",
  states: ["requested", "approved", "rejected", "refunded"],
  terminal: ["rejected", "refunded"],
  transitions: [
    {
      event: "approve",
      label: "Approve refund",
      from: ["requested"],
      to: "approved",
      by: ["owner", "staff", "owner_ai"],
      effects: ["notify_customer"],
    },
    {
      event: "reject",
      label: "Reject refund",
      from: ["requested"],
      to: "rejected",
      by: owners,
      input: noteInput,
      effects: ["notify_customer", "close"],
    },
    {
      event: "refund",
      label: "Mark refunded",
      from: ["approved"],
      to: "refunded",
      by: ["connector", "owner", "staff"],
      input: paymentInput,
      effects: ["review_fact", "notify_customer", "close"],
    },
  ],
};

export const machines: Record<ItemType, Machine> = {
  message: messageMachine as Machine,
  quote_request: quoteMachine as Machine,
  booking: bookingMachine as Machine,
  order: orderMachine as Machine,
  refund: refundMachine as Machine,
};
