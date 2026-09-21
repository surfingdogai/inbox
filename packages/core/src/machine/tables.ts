import { z } from "zod";
import { BUSINESS_ACTORS, CUSTOMER_ACTORS, type ItemType, isoDateTime, moneySchema } from "../domain/types";
import type { Machine } from "./machine";

const owners = BUSINESS_ACTORS;
const customers = CUSTOMER_ACTORS;
const ownersAndSystem = [...BUSINESS_ACTORS, "system"] as const;

export const proposeInput = z.object({
  startTime: isoDateTime,
  endTime: isoDateTime,
  totalPrice: moneySchema.optional(),
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
});
export const paymentInput = z.object({ paymentRef: z.string().min(1).max(200), amount: moneySchema.optional() });
export const paymentRequestInput = z.object({ paymentUrl: z.url().optional() });
export const noteInput = z.object({ note: z.string().max(2_000).optional() });

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
      effects: ["notify_owner"],
    },
    {
      event: "propose",
      label: "Propose another time",
      from: ["requested", "needs_info"],
      to: "proposed",
      by: owners,
      input: proposeInput,
      effects: ["notify_customer"],
    },
    {
      event: "accept",
      label: "Accept the proposed time",
      from: ["proposed"],
      to: "confirmed",
      by: customers,
      guards: ["proposal_present", "slot_available"],
      effects: ["apply_proposal", "claim_slot", "issue_receipt:confirmed", "notify_owner"],
    },
    {
      event: "confirm",
      label: "Confirm booking",
      from: ["requested", "proposed"],
      to: "confirmed",
      by: owners,
      guards: ["slot_available"],
      effects: ["claim_slot", "issue_receipt:confirmed", "notify_customer"],
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
    {
      event: "cancel",
      label: "Cancel booking",
      from: ["requested", "needs_info", "proposed", "confirmed"],
      to: "cancelled_by_customer",
      by: customers,
      guards: ["customer_owns_item", "within_cancellation_window"],
      input: noteInput,
      effects: ["release_slot", "notify_owner", "close"],
    },
    {
      event: "cancel_by_business",
      label: "Cancel booking",
      from: ["requested", "needs_info", "proposed", "confirmed"],
      to: "cancelled_by_business",
      by: owners,
      input: noteInput,
      effects: ["release_slot", "notify_customer", "close"],
    },
    {
      event: "complete",
      label: "Mark completed",
      from: ["confirmed"],
      to: "completed",
      by: ownersAndSystem,
      effects: ["review_fact", "close"],
    },
    {
      event: "no_show",
      label: "Mark no-show",
      from: ["confirmed"],
      to: "no_show",
      by: ["owner", "staff"],
      effects: ["review_fact", "close"],
    },
  ],
};

export type OrderState =
  | "received"
  | "needs_info"
  | "accepted"
  | "awaiting_payment"
  | "paid"
  | "fulfilling"
  | "fulfilled"
  | "completed"
  | "declined"
  | "cancelled";

export const orderMachine: Machine<OrderState> = {
  type: "order",
  initial: "received",
  states: [
    "received",
    "needs_info",
    "accepted",
    "awaiting_payment",
    "paid",
    "fulfilling",
    "fulfilled",
    "completed",
    "declined",
    "cancelled",
  ],
  terminal: ["completed", "declined", "cancelled"],
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
      effects: ["notify_owner"],
    },
    {
      event: "accept",
      label: "Accept order",
      from: ["received", "needs_info"],
      to: "accepted",
      by: owners,
      effects: ["notify_customer"],
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
      from: ["accepted", "awaiting_payment"],
      to: "paid",
      by: ["connector", "owner", "staff", "system"],
      input: paymentInput,
      effects: ["issue_receipt:paid", "notify_customer"],
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
      effects: ["notify_customer"],
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
    {
      event: "cancel",
      label: "Cancel order",
      from: ["received", "needs_info", "accepted", "awaiting_payment"],
      to: "cancelled",
      by: [...customers, ...owners],
      guards: ["customer_owns_item"],
      input: noteInput,
      effects: ["notify_owner", "notify_customer", "close"],
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
      effects: ["notify_owner"],
    },
    {
      event: "quote",
      label: "Send quote",
      from: ["received", "needs_info"],
      to: "quoted",
      by: owners,
      input: quoteInput,
      effects: ["notify_customer"],
    },
    {
      event: "accept",
      label: "Accept quote",
      from: ["quoted"],
      to: "accepted",
      by: customers,
      guards: ["customer_owns_item", "has_quote"],
      effects: ["link_item", "notify_owner", "close"],
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
