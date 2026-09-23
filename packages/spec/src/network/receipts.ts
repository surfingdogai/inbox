import { z } from "zod";
import {
  moneySchema,
  type ReceiptPayload,
  receiptAckPayloadSchema,
  receiptKindSchema,
  receiptPayloadSchema,
} from "../base";
import { networkHostSchema, passRefSchema, presentationIdSchema } from "./common";

/**
 * Receipt claims v2 (ADR-017 §3.2). The JOSE header and every v1 claim are unchanged (ADR-016);
 * `ver: 2` adds the promise kind `accepted`, the `outcome` kind that closes a promise, and the
 * claims a network needs to date, match and weigh them. A v2 receipt is always about a booking or
 * an order: quotes and messages promise nothing.
 *
 * **These claim names are frozen**, like v1's: a receipt outlives the software that wrote it.
 */

/** The kinds v2 claims name: every kind an inbox issues (`receiptKindSchema`). */
export const receiptKindV2Schema = receiptKindSchema;
export type ReceiptKindV2 = z.infer<typeof receiptKindV2Schema>;

/** The promise kinds: every v2 kind but `outcome`. */
export const PROMISE_KINDS = ["confirmed", "paid", "accepted"] as const;

/**
 * Every outcome §3 defines, in its order: which side each writes a row on (`kept`, `broken`, or
 * none), its weight `o`, and who records it. Only the `inbox` ones travel in receipts; the two
 * `report` outcomes come from a customer's agent (§3.4) and `promise.unclosed` from the network
 * itself (R30).
 */
export const OUTCOMES = [
  { code: "booking.completed", typ: "booking", business: "kept", customer: "kept", o: 1, by: "inbox" },
  { code: "order.fulfilled", typ: "order", business: "kept", customer: "kept_if_paid_or_free", o: 1, by: "inbox" },
  {
    code: "booking.cancelled_by_business",
    typ: "booking",
    business: "broken",
    customer: null,
    o: 1,
    o_with_notice: 0.5,
    by: "inbox",
  },
  { code: "order.not_fulfilled", typ: "order", business: "broken", customer: null, o: 1, by: "inbox" },
  { code: "booking.no_show_business", typ: "booking", business: "broken", customer: null, o: 1, by: "report" },
  { code: "order.not_received", typ: "order", business: "broken", customer: null, o: 1, by: "report" },
  { code: "promise.unclosed", typ: null, business: "broken", customer: null, o: 1, by: "network" },
  { code: "booking.no_show_customer", typ: "booking", business: null, customer: "broken", o: 1, by: "inbox" },
  {
    code: "booking.cancelled_late_by_customer",
    typ: "booking",
    business: null,
    customer: "broken",
    o: 0.5,
    by: "inbox",
  },
  { code: "order.payment_failed", typ: "order", business: null, customer: "broken", o: 0.5, by: "inbox" },
  { code: "order.charged_back", typ: "order", business: null, customer: "broken", o: 1, by: "inbox" },
  { code: "booking.cancelled_by_customer", typ: "booking", business: null, customer: null, o: null, by: "inbox" },
  { code: "order.cancelled_by_customer", typ: "order", business: null, customer: null, o: null, by: "inbox" },
  { code: "order.lapsed", typ: "order", business: null, customer: null, o: null, by: "inbox" },
] as const;

export type OutcomeCode = (typeof OUTCOMES)[number]["code"];
type InboxOutcome = Extract<(typeof OUTCOMES)[number], { by: "inbox" }>;
export type InboxOutcomeCode = InboxOutcome["code"];

export const outcomeCodeSchema = z.enum(OUTCOMES.map((o) => o.code) as [OutcomeCode, ...OutcomeCode[]]);

/** The eleven outcomes an inbox records and signs. */
export const inboxOutcomeCodeSchema = z.enum(
  OUTCOMES.filter((o) => o.by === "inbox").map((o) => o.code) as [InboxOutcomeCode, ...InboxOutcomeCode[]],
);

/** The item type an inbox outcome belongs to. */
export function outcomeItemType(code: string): "booking" | "order" | null {
  const o = OUTCOMES.find((x) => x.code === code);
  return o && o.by === "inbox" ? (o.typ as "booking" | "order") : null;
}

/** One network's presentation for the item: `n` the network's host, `p` the presentation id it returned. */
export const perEntrySchema = z.object({ n: networkHostSchema, p: presentationIdSchema });

/** 2^37 s, a date far beyond any booking: bounds `due` and `end` so no reader overflows. */
export const MAX_RECEIPT_TIME = 2 ** 37;
const unixSeconds = z.int().min(1).max(MAX_RECEIPT_TIME);

export const receiptPayloadV2Schema = z
  .object({
    iss: z
      .url()
      .regex(/^https:\/\//)
      .describe("The issuing instance, an https origin with no trailing slash."),
    sub: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,64}$/)
      .describe("base64url(HMAC-SHA-256(instance pepper, identity)): the customer, pseudonymously."),
    itm: z.string().min(1).max(64).describe("The item's id on the issuing instance."),
    typ: z.enum(["booking", "order"]),
    knd: receiptKindV2Schema,
    iat: z.int().positive().describe("Issued at, Unix seconds: the causing event's time."),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    amt: moneySchema.extend({ value: z.int().min(0) }).optional(),
    pay: z.string().max(40).optional(),
    ver: z.literal(2),
    out: inboxOutcomeCodeSchema.optional().describe("The outcome, exactly when knd is outcome."),
    ref: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe("With an outcome: the nonce of the item's earliest promise."),
    due: unixSeconds.describe(
      "A booking's start; an order's payload.delivery.when, else iat + 30 days. Outcomes copy their promise's.",
    ),
    end: unixSeconds.optional().describe("A booking's end."),
    aut: z.literal(1).optional().describe("1 when the system fired the transition, not a person."),
    per: z
      .array(perEntrySchema)
      .max(8)
      .optional()
      .describe("One entry per network holding a presentation for the item; each network reads only its own."),
  })
  .superRefine((r, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (r.knd === "outcome") {
      if (r.out === undefined) issue("an outcome names its code", "out");
      else if (outcomeItemType(r.out) !== r.typ) issue(`${r.out} is not an outcome of a ${r.typ}`, "out");
      if (r.ref === undefined) issue("an outcome names the nonce of the item's earliest promise", "ref");
    } else {
      if (r.out !== undefined) issue("out belongs to an outcome", "out");
      if (r.ref !== undefined) issue("ref belongs to an outcome", "ref");
    }
    if (r.end !== undefined) {
      if (r.typ !== "booking") issue("end is a booking's end", "end");
      else if (r.end < r.due) issue("end must not be before due", "end");
    }
  });
export type ReceiptPayloadV2 = z.infer<typeof receiptPayloadV2Schema>;

/** An acknowledgement may name the person's pass by reference (§3.4); it never carries a secret. */
export const receiptAckPayloadV2Schema = receiptAckPayloadSchema.extend({
  pas: passRefSchema.optional().describe("A pass reference of the acknowledging person."),
});
export type ReceiptAckPayloadV2 = z.infer<typeof receiptAckPayloadV2Schema>;

/**
 * A receipt's claims by version, as a network reads them: `ver` absent or 1 is v1 (ADR-016, `knd`
 * confirmed or paid), 2 is v2, anything else is refused. Null when the claims are refused
 * (`422 bad_payload`); an `iat` more than 300 s ahead is the caller's check (`422 not_yet`).
 */
export function parseReceiptClaims(
  payload: unknown,
):
  | { readonly version: 1; readonly claims: ReceiptPayload }
  | { readonly version: 2; readonly claims: ReceiptPayloadV2 }
  | null {
  const ver = (payload as { ver?: unknown } | null)?.ver;
  if (ver === undefined || ver === 1) {
    const r = receiptPayloadSchema.safeParse(payload);
    return r.success ? { version: 1, claims: r.data } : null;
  }
  if (ver === 2) {
    const r = receiptPayloadV2Schema.safeParse(payload);
    return r.success ? { version: 2, claims: r.data } : null;
  }
  return null;
}
