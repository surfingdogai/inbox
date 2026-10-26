import { stayQuoteSchema } from "@surfingdog/spec";
import { z } from "zod";
import { BUSINESS_ACTORS, CUSTOMER_ACTORS, isoDateTime, moneySchema, stayRoomSchema } from "../domain/types";
import type { Machine, Transition } from "./machine";

/**
 * A stay's state machine (ADR-037), as data: the write algorithm interprets it, and the stays layer
 * (`stays/transition.ts`) checks its guards and writes its effects in the same batch. Fourteen states:
 * a request the property answers with a quote, or a hold an agent books at once where the inbox cannot
 * sell a room twice; `booking` while a write to the property's own system is in flight, which never
 * lapses on a timeout before the write is looked for; and the ends. Every move into a wait (a deposit, a
 * write) keeps the stay's nights claimed until that wait ends, never on the clock of the hold before it.
 *
 * Where one event can lead to two states (an acceptance with a deposit due, or with nothing due), the
 * stays layer fires the right one of two events: the one with nothing due is listed, its twin unlisted.
 */
export type StayState =
  | "requested"
  | "needs_info"
  | "quoted"
  | "held"
  | "booking"
  | "awaiting_payment"
  | "confirmed"
  | "checked_in"
  | "completed"
  | "no_show"
  | "cancelled_by_guest"
  | "cancelled_by_property"
  | "declined"
  | "expired";

export const STAY_STATES: readonly StayState[] = [
  "requested",
  "needs_info",
  "quoted",
  "held",
  "booking",
  "awaiting_payment",
  "confirmed",
  "checked_in",
  "completed",
  "no_show",
  "cancelled_by_guest",
  "cancelled_by_property",
  "declined",
  "expired",
];

const owners = BUSINESS_ACTORS;
const customers = CUSTOMER_ACTORS;
/** A person at the property, or its AI, who writes down what a guest said (a cancellation by phone). */
const recorders = ["owner", "staff", "owner_ai"] as const;
/** The property's own system, or the inbox's own jobs. */
const machinery = ["system", "connector"] as const;

const note = z.string().max(2_000).optional();
export const stayNoteInput = z.object({ note });
export const stayDetailsInput = z.object({ note: z.string().max(20_000).optional() });
/** A note a guest reads, required: why the property cancels. */
export const stayPropertyCancelInput = z.object({
  note: z.string().trim().min(1, "say why, for the guest").max(2_000),
});

/**
 * A quote the property sends: the whole quote (from the composer), or `from: rates` to quote from its
 * rates; which room type and rate plan each room is, when the request left that to the property.
 */
export const stayQuoteInput = z.object({
  quote: stayQuoteSchema.optional(),
  from: z.literal("rates").optional(),
  rooms: z
    .array(
      z.object({
        index: z.number().int().min(0).max(8),
        roomTypeId: z.string().min(1).max(64),
        ratePlanId: z.string().min(1).max(64).optional(),
      }),
    )
    .max(9)
    .optional(),
  /** How many hours the quote holds: 2, 12, 24, 48 (the property's default when left out). */
  validHours: z.number().int().min(1).max(168).optional(),
  /**
   * A person's own price for the stay's room nights, where the rates do not cover them: the property's
   * taxes and fees are added, on its plan for the rooms or the standard terms. Never automation's.
   */
  price: moneySchema.optional(),
  note,
});

/** The guest asks for other dates or rooms: back to the property to quote. */
export const stayCounterInput = z.object({
  checkIn: z.iso.date().optional(),
  checkOut: z.iso.date().optional(),
  rooms: z.array(stayRoomSchema).min(1).max(9).optional(),
  note,
});

/** The guest's yes to the terms they were shown: their fingerprint. */
export const stayTermsInput = z.object({
  terms_sha: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  note,
});

/** A payment recorded on a stay: by the platform, or by a person at the property. */
export const stayPaymentInput = z.object({
  paymentRef: z.string().min(1).max(200),
  amount: moneySchema.optional(),
  method: z.string().min(1).max(40).optional(),
  /** Which schedule entry it pays: the first one due when left out. */
  scheduleId: z.string().min(1).max(64).optional(),
});

/** The guest cancels a confirmed stay, having seen the fee: its fingerprint. */
export const stayCancelInput = z.object({
  fee_sha: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  note,
});

/** The property records a guest's own cancellation: what they said, when they asked, and a lower fee. */
export const stayRecordCancelInput = z.object({
  note: z.string().trim().min(1, "say what the guest said").max(2_000),
  askedAt: isoDateTime.optional(),
  /** A fee lower than the policy's, which only a person at the property gives. */
  fee: moneySchema.optional(),
});

/** A change to a confirmed stay: new dates or rooms, with the property's new quote when it asks for one. */
export const stayChangeInput = z.object({
  checkIn: z.iso.date(),
  checkOut: z.iso.date(),
  rooms: z.array(stayRoomSchema).min(1).max(9).optional(),
  quote: stayQuoteSchema.optional(),
  terms_sha: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  note,
});

/** A system's word that it wrote the stay: its booking id. */
export const stayWrittenInput = z.object({
  connectorId: z.string().min(1).max(64),
  externalId: z.string().min(1).max(200),
  status: z.string().max(40).optional(),
});

const acceptGuards = ["customer_owns_item", "stay_quote_open", "terms_confirmed", "nights_available"] as const;

export const stayMachine: Machine<StayState> = {
  type: "stay",
  initial: "requested",
  states: STAY_STATES,
  terminal: ["completed", "no_show", "cancelled_by_guest", "cancelled_by_property", "declined", "expired"],
  transitions: [
    {
      event: "request_info",
      label: "Ask for details",
      from: ["requested", "quoted"],
      to: "needs_info",
      by: owners,
      input: stayNoteInput,
      effects: ["release_nights", "notify_customer"],
    },
    {
      event: "provide_info",
      label: "Send details",
      from: ["needs_info"],
      to: "requested",
      by: [...customers, "connector"],
      input: stayDetailsInput,
      effects: ["notify_owner"],
    },
    {
      // A new quote on a quoted stay replaces the one before.
      event: "quote",
      label: "Send quote",
      from: ["requested", "needs_info", "quoted"],
      to: "quoted",
      by: owners,
      guards: ["stay_quote_complete", "capacity_ok", "registration_ok", "not_past", "nights_open"],
      input: stayQuoteInput,
      effects: ["hold_nights", "notify_customer"],
    },
    {
      event: "counter",
      label: "Ask for other dates or rooms",
      from: ["quoted"],
      to: "requested",
      by: customers,
      guards: ["customer_owns_item"],
      input: stayCounterInput,
      effects: ["stay_counter", "release_nights", "notify_owner"],
    },
    // The guest's yes to the quote: confirmed when nothing is due now, waiting for the deposit when it
    // is, and written to the property's own system first when it has one.
    {
      event: "accept",
      label: "Accept quote",
      from: ["quoted"],
      to: "confirmed",
      by: customers,
      guards: [...acceptGuards, "nothing_due_now"],
      input: stayTermsInput,
      effects: ["claim_nights", "schedule_messages", "issue_receipt:confirmed", "notify_owner", "notify_customer"],
    },
    {
      event: "accept_pay",
      label: "Accept quote",
      from: ["quoted"],
      to: "awaiting_payment",
      by: customers,
      guards: [...acceptGuards, "payment_due_now"],
      input: stayTermsInput,
      effects: ["claim_nights:hold", "queue_pay_links", "notify_owner", "notify_customer"],
      unlisted: true,
    },
    {
      event: "accept_write",
      label: "Accept quote",
      from: ["quoted"],
      to: "booking",
      by: customers,
      guards: acceptGuards,
      input: stayTermsInput,
      effects: ["claim_nights:hold", "write_stay"],
      unlisted: true,
    },
    // The guest said yes by phone or email: only a person records a yes a person heard.
    {
      event: "record_accept",
      label: "The guest said yes",
      from: ["quoted"],
      to: "confirmed",
      by: owners,
      byPerson: true,
      internalNote: true,
      guards: ["stay_quote_open", "nights_available", "nothing_due_now"],
      input: stayNoteInput,
      effects: ["claim_nights", "schedule_messages", "issue_receipt:confirmed", "notify_customer"],
    },
    {
      event: "record_accept_pay",
      label: "The guest said yes",
      from: ["quoted"],
      to: "awaiting_payment",
      by: owners,
      byPerson: true,
      internalNote: true,
      guards: ["stay_quote_open", "nights_available", "payment_due_now"],
      input: stayNoteInput,
      effects: ["claim_nights:hold", "queue_pay_links", "notify_customer"],
      unlisted: true,
    },
    {
      event: "record_accept_write",
      label: "The guest said yes",
      from: ["quoted"],
      to: "booking",
      by: owners,
      byPerson: true,
      internalNote: true,
      guards: ["stay_quote_open", "nights_available"],
      input: stayNoteInput,
      effects: ["claim_nights:hold", "write_stay"],
      unlisted: true,
    },
    // An agent's hold, where the inbox cannot sell a room twice: kept for the direct guests the owner
    // set aside, or a fresh look at the property's own system.
    {
      event: "hold",
      label: "Hold",
      from: ["requested"],
      to: "held",
      by: ["system"],
      guards: ["instant_safe", "nights_available", "capacity_ok", "registration_ok", "not_past"],
      effects: ["claim_nights:hold"],
      unlisted: true,
    },
    {
      event: "book",
      label: "Book",
      from: ["held"],
      to: "confirmed",
      by: customers,
      guards: ["customer_owns_item", "hold_open", "terms_confirmed", "nothing_due_now"],
      input: stayTermsInput,
      effects: ["promote_claims", "schedule_messages", "issue_receipt:confirmed", "notify_owner", "notify_customer"],
    },
    {
      event: "book_pay",
      label: "Book",
      from: ["held"],
      to: "awaiting_payment",
      by: customers,
      guards: ["customer_owns_item", "hold_open", "terms_confirmed", "payment_due_now"],
      input: stayTermsInput,
      // The hold's nights kept until the pay window closes, not the hold's own end.
      effects: ["claim_nights:hold", "queue_pay_links", "notify_owner", "notify_customer"],
      unlisted: true,
    },
    {
      event: "book_write",
      label: "Book",
      from: ["held"],
      to: "booking",
      by: customers,
      guards: ["customer_owns_item", "hold_open", "terms_confirmed"],
      input: stayTermsInput,
      // The nights kept while the write is in flight, not on the hold's clock.
      effects: ["claim_nights:hold", "write_stay"],
      unlisted: true,
    },
    // The property's system answered the write with its booking id.
    {
      event: "written",
      label: "Written to the property's system",
      from: ["booking"],
      to: "confirmed",
      by: machinery,
      guards: ["nothing_due_now"],
      input: stayWrittenInput,
      effects: ["promote_claims", "schedule_messages", "issue_receipt:confirmed", "notify_owner", "notify_customer"],
      unlisted: true,
    },
    {
      event: "written_pay",
      label: "Written to the property's system",
      from: ["booking"],
      to: "awaiting_payment",
      by: machinery,
      guards: ["payment_due_now"],
      input: stayWrittenInput,
      effects: ["claim_nights:hold", "queue_pay_links", "notify_owner", "notify_customer"],
      unlisted: true,
    },
    {
      // Only once the system refused, or a look for the write proved nothing was written.
      event: "write_refused",
      label: "Not written",
      from: ["booking"],
      to: "expired",
      by: machinery,
      input: stayNoteInput,
      // A late payment's stay the system would not take again: what was paid is owed back.
      effects: ["release_nights", "refund_owed", "notify_customer", "close"],
      unlisted: true,
    },
    {
      event: "release",
      label: "Let the hold go",
      from: ["held"],
      to: "expired",
      by: customers,
      guards: ["customer_owns_item"],
      effects: ["release_nights", "cancel_stay_write", "close"],
    },
    {
      event: "record_payment",
      label: "Record payment",
      from: ["awaiting_payment"],
      to: "confirmed",
      by: ["connector", "owner", "staff"],
      guards: ["payment_complete"],
      input: stayPaymentInput,
      // On a connected property, the stay written there as confirmed, with its guest.
      effects: [
        "promote_claims",
        "write_stay",
        "schedule_messages",
        "issue_receipt:paid",
        "issue_receipt:confirmed",
        "notify_owner",
        "notify_customer",
      ],
    },
    {
      // A part paid while more is due now: recorded, and the stay waits for the rest.
      event: "record_part_payment",
      label: "Record payment",
      from: ["awaiting_payment"],
      to: "awaiting_payment",
      by: ["connector", "owner", "staff"],
      input: stayPaymentInput,
      effects: ["queue_pay_links", "notify_customer"],
      unlisted: true,
    },
    {
      event: "record_payment",
      label: "Record payment",
      from: ["confirmed", "checked_in"],
      to: "confirmed",
      by: ["connector", "owner", "staff"],
      input: stayPaymentInput,
      effects: ["queue_pay_links", "notify_customer"],
    },
    {
      // A payment that landed after the window closed: the stay confirmed after all only where the inbox
      // cannot sell its nights twice (rooms kept for direct guests, still inside them). Anywhere else the
      // property may have sold the nights since, so it is owed back for the property to refund.
      event: "late_payment",
      label: "Late payment",
      from: ["expired"],
      to: "confirmed",
      by: ["system", "connector"],
      guards: ["late_payment_open", "instant_safe", "nights_available"],
      input: stayPaymentInput,
      effects: [
        "claim_nights",
        "schedule_messages",
        "issue_receipt:paid",
        "issue_receipt:confirmed",
        "notify_owner",
        "notify_customer",
      ],
      reopens: true,
      unlisted: true,
    },
    {
      // The same on a connected property: written to its system again first, under a key of its own.
      event: "late_payment_write",
      label: "Late payment",
      from: ["expired"],
      to: "booking",
      by: ["system", "connector"],
      guards: ["late_payment_open", "nights_available"],
      input: stayPaymentInput,
      effects: ["claim_nights:hold", "write_stay", "issue_receipt:paid"],
      reopens: true,
      unlisted: true,
    },
    {
      event: "payment_failed",
      label: "Payment failed",
      from: ["awaiting_payment"],
      to: "awaiting_payment",
      by: ["connector"],
      input: stayNoteInput,
      effects: ["queue_pay_links", "notify_customer"],
      unlisted: true,
    },
    {
      event: "waive_payment",
      label: "Let them pay on arrival",
      from: ["awaiting_payment"],
      to: "confirmed",
      by: owners,
      byPerson: true,
      input: stayNoteInput,
      effects: [
        "promote_claims",
        "write_stay",
        "close_pay_links",
        "schedule_messages",
        "issue_receipt:confirmed",
        "notify_customer",
      ],
    },
    {
      event: "decline",
      label: "Decline",
      from: ["requested", "needs_info", "quoted"],
      to: "declined",
      by: [...owners, ...customers],
      input: stayNoteInput,
      effects: ["release_nights", "notify_customer", "notify_owner", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["quoted"],
      to: "expired",
      by: ["system", "rule"],
      guards: ["stay_quote_lapsed"],
      effects: ["release_nights", "notify_customer", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["requested", "needs_info"],
      to: "expired",
      by: ["system"],
      guards: ["stay_request_lapsed"],
      effects: ["notify_customer", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["held"],
      to: "expired",
      by: ["system"],
      guards: ["hold_lapsed"],
      effects: ["release_nights", "cancel_stay_write", "close"],
    },
    {
      event: "expire",
      label: "Expire",
      from: ["awaiting_payment"],
      to: "expired",
      by: ["system"],
      guards: ["payment_lapsed"],
      // A part paid before the window closed is owed back.
      effects: ["release_nights", "cancel_stay_write", "close_pay_links", "refund_owed", "notify_customer", "close"],
    },
    {
      event: "cancel",
      label: "Cancel stay",
      from: ["requested", "needs_info", "quoted", "awaiting_payment"],
      to: "cancelled_by_guest",
      by: customers,
      guards: ["customer_owns_item"],
      input: stayCancelInput,
      effects: [
        "release_nights",
        "cancel_stay_write",
        "close_pay_links",
        "refund_owed",
        "notify_owner",
        "notify_customer",
        "close",
      ],
    },
    {
      // A confirmed stay: the fee as the policy dates it now, seen and confirmed first (`fee_sha`).
      event: "cancel",
      label: "Cancel stay",
      from: ["confirmed"],
      to: "cancelled_by_guest",
      by: customers,
      guards: ["customer_owns_item", "fee_confirmed"],
      input: stayCancelInput,
      effects: [
        "cancellation_fee",
        "release_nights",
        "cancel_stay_write",
        "close_pay_links",
        "refund_owed",
        "notify_owner",
        "notify_customer",
        "close",
      ],
    },
    {
      event: "record_cancel",
      label: "Guest cancelled",
      from: ["requested", "needs_info", "quoted", "awaiting_payment"],
      to: "cancelled_by_guest",
      by: recorders,
      internalNote: true,
      input: stayRecordCancelInput,
      effects: ["release_nights", "cancel_stay_write", "close_pay_links", "refund_owed", "notify_customer", "close"],
    },
    {
      // Judged as of when they asked, which can only lower the fee; a lower fee still is a person's.
      event: "record_cancel",
      label: "Guest cancelled",
      from: ["confirmed"],
      to: "cancelled_by_guest",
      by: recorders,
      internalNote: true,
      guards: ["fee_lowered_by_person"],
      input: stayRecordCancelInput,
      effects: [
        "cancellation_fee",
        "release_nights",
        "cancel_stay_write",
        "close_pay_links",
        "refund_owed",
        "notify_customer",
        "close",
      ],
    },
    {
      event: "cancel_by_property",
      label: "Cancel and tell the guest",
      from: ["requested", "needs_info", "quoted", "held", "awaiting_payment"],
      to: "cancelled_by_property",
      by: owners,
      input: stayPropertyCancelInput,
      effects: ["release_nights", "cancel_stay_write", "close_pay_links", "refund_owed", "notify_customer", "close"],
    },
    {
      // A promise the property breaks: a person decides, and everything paid is owed back.
      event: "cancel_by_property",
      label: "Cancel and tell the guest",
      from: ["confirmed"],
      to: "cancelled_by_property",
      by: ["owner", "staff"],
      byPerson: true,
      input: stayPropertyCancelInput,
      effects: ["release_nights", "cancel_stay_write", "close_pay_links", "refund_owed", "notify_customer", "close"],
    },
    // Changes to a confirmed stay: one side asks, the other says yes or no; the stay stays as agreed
    // until a yes. Changes cost nothing while cancellation is free and the new nights are open.
    {
      event: "propose_change",
      label: "Change dates or rooms",
      from: ["confirmed"],
      to: "confirmed",
      by: [...owners, ...customers],
      guards: ["stay_ahead", "change_nights_open"],
      input: stayChangeInput,
      effects: ["notify_owner", "notify_customer"],
    },
    {
      event: "accept_change",
      label: "Accept the change",
      from: ["confirmed"],
      to: "confirmed",
      by: [...owners, ...customers],
      guards: ["stay_change_open", "stay_ahead", "change_nights_open"],
      input: stayTermsInput,
      effects: [
        "apply_stay_change",
        "reclaim_nights",
        "write_stay",
        "queue_pay_links",
        "notify_owner",
        "notify_customer",
      ],
    },
    {
      // On a connected property: the change written to its system first; the stay keeps its dates, and
      // both sets of nights, until the system answers.
      event: "accept_change_write",
      label: "Accept the change",
      from: ["confirmed"],
      to: "confirmed",
      by: [...owners, ...customers],
      guards: ["stay_change_open", "stay_ahead", "change_nights_open"],
      input: stayTermsInput,
      effects: ["hold_change_nights", "write_stay"],
      unlisted: true,
    },
    {
      // The system took the change: now it is the stay.
      event: "change_written",
      label: "Change written to the property's system",
      from: ["confirmed"],
      to: "confirmed",
      by: machinery,
      guards: ["stay_change_writing"],
      effects: ["apply_stay_change", "reclaim_nights", "queue_pay_links", "notify_owner", "notify_customer"],
      unlisted: true,
    },
    {
      // The system did not take it: the stay stays as agreed, and both sides hear so.
      event: "change_refused",
      label: "Change not written",
      from: ["confirmed"],
      to: "confirmed",
      by: machinery,
      guards: ["stay_change_writing"],
      input: stayNoteInput,
      effects: ["drop_change", "reclaim_nights", "notify_owner", "notify_customer"],
      unlisted: true,
    },
    {
      event: "decline_change",
      label: "Keep it as it is",
      from: ["confirmed"],
      to: "confirmed",
      by: [...owners, ...customers],
      guards: ["stay_change_theirs"],
      input: stayNoteInput,
      effects: ["drop_change", "notify_owner", "notify_customer"],
    },
    {
      event: "retract_change",
      label: "Withdraw my change",
      from: ["confirmed"],
      to: "confirmed",
      by: [...owners, ...customers],
      guards: ["stay_change_mine"],
      input: stayNoteInput,
      effects: ["drop_change", "notify_owner", "notify_customer"],
    },
    {
      event: "expire_change",
      label: "Expire the change",
      from: ["confirmed"],
      to: "confirmed",
      by: ["system"],
      guards: ["stay_change_lapsed"],
      effects: ["drop_change", "notify_customer"],
      unlisted: true,
    },
    {
      event: "check_in",
      label: "Check in",
      from: ["confirmed"],
      to: "checked_in",
      by: ["owner", "staff", "connector"],
      guards: ["checkin_day_reached"],
    },
    {
      event: "check_out",
      label: "Check out",
      from: ["checked_in"],
      to: "completed",
      by: ["owner", "staff", "connector", "system"],
      effects: ["close"],
    },
    {
      event: "complete",
      label: "Mark stayed",
      from: ["confirmed"],
      to: "completed",
      by: ["system"],
      guards: ["stay_ended"],
      effects: ["close"],
    },
    {
      event: "no_show",
      label: "Mark no-show",
      from: ["confirmed"],
      to: "no_show",
      by: ["owner", "staff", "connector"],
      guards: ["arrival_passed"],
      // The nights after the first let go on the property's system too; the stay itself stays a no-show there.
      effects: ["release_nights", "release_stay_write", "notify_customer", "close"],
    },
    {
      event: "complete",
      label: "Correct: they stayed",
      from: ["no_show"],
      to: "completed",
      by: ["owner", "staff"],
      guards: ["stay_correction_window"],
      effects: ["close"],
      amends: true,
    },
    {
      event: "no_show",
      label: "Correct: no-show",
      from: ["completed"],
      to: "no_show",
      by: ["owner", "staff"],
      guards: ["stay_correction_window"],
      effects: ["close"],
      amends: true,
    },
  ] satisfies readonly Transition<StayState>[],
};
