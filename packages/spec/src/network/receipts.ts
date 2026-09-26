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
 * claims a network needs to date, match and weigh them. A v2 receipt is about a booking or an order,
 * or, since rules version 6, a refund: quotes and messages promise nothing.
 *
 * Rules version 6 (ADR-017 Amendment 3) adds values and claims and renames none: the kind `amended`
 * (a change to a promise both sides agreed), `typ: "refund"` with its three outcomes, and the
 * optional claims `trm` (the fingerprint of the terms both sides agreed, bound under a key the
 * business discloses only in a dispute) and `acc` (who accepted a change). A reader on older rules refuses the new values and ignores the new claims
 * (`parseReceiptClaims`).
 *
 * **These claim names are frozen**, like v1's: a receipt outlives the software that wrote it.
 */

/** The rules version that reads agreed changes and refunds (ADR-017 Amendment 3). */
export const RULES_V6 = 6;

/** The kinds v2 claims name: every kind an inbox issues (`receiptKindSchema`). */
export const receiptKindV2Schema = receiptKindSchema;
export type ReceiptKindV2 = z.infer<typeof receiptKindV2Schema>;

/** The promise kinds: every v2 kind but `outcome` and `amended`, which follow a promise. */
export const PROMISE_KINDS = ["confirmed", "paid", "accepted"] as const;

/**
 * What a network honours of changes to one promise that no verified acknowledgement backs (ADR-017
 * Amendment 3, A3.1): at most `unverified` amendments, each moving `due`, and the date R30 reads (a
 * booking's `end`, else `due`), at most `dueShiftDays` either way from the earliest promise's. An
 * amendment beyond them is stored and changes nothing. An inbox may hold its owners to less, never
 * to more.
 */
export const AMENDMENT_LIMITS = { unverified: 3, dueShiftDays: 90 } as const;

/**
 * Every outcome §3 defines, in its order: which side each writes a row on (`kept`, `broken`, or
 * none), its weight `o`, and who records it. Only the `inbox` ones travel in receipts; the `report`
 * outcomes come from a customer's agent (§3.4) and `promise.unclosed` from the network itself
 * (R30). A row with `since` first counts under that rules version (a network on older rules refuses
 * it); the others have counted since version 3. No row added since has a customer's side.
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
  // Rules version 6 (ADR-017 Amendment 3): refunds, on an item of their own, and a lawful claim refused.
  { code: "refund.honoured", typ: "refund", business: "kept", customer: null, o: 1, by: "inbox", since: 6 },
  { code: "refund.late", typ: "refund", business: "broken", customer: null, o: 1, by: "inbox", since: 6 },
  {
    code: "refund.cancelled_by_customer",
    typ: "refund",
    business: null,
    customer: null,
    o: null,
    by: "inbox",
    since: 6,
  },
  { code: "order.refund_refused", typ: "order", business: "broken", customer: null, o: 1, by: "report", since: 6 },
] as const;

/** The rules version from which an outcome counts: 3 for the first table, else its `since`. */
export function outcomeSince(code: string): number | null {
  const o = OUTCOMES.find((x) => x.code === code);
  return o ? ("since" in o ? o.since : 3) : null;
}

export type OutcomeCode = (typeof OUTCOMES)[number]["code"];
type InboxOutcome = Extract<(typeof OUTCOMES)[number], { by: "inbox" }>;
export type InboxOutcomeCode = InboxOutcome["code"];

export const outcomeCodeSchema = z.enum(OUTCOMES.map((o) => o.code) as [OutcomeCode, ...OutcomeCode[]]);

/** The outcomes an inbox records and signs: eleven since rules version 3, three more since version 6. */
export const inboxOutcomeCodeSchema = z.enum(
  OUTCOMES.filter((o) => o.by === "inbox").map((o) => o.code) as [InboxOutcomeCode, ...InboxOutcomeCode[]],
);

/** The item type an inbox outcome belongs to. */
export function outcomeItemType(code: string): "booking" | "order" | "refund" | null {
  const o = OUTCOMES.find((x) => x.code === code);
  return o && o.by === "inbox" ? (o.typ as "booking" | "order" | "refund") : null;
}

/** One network's presentation for the item: `n` the network's host, `p` the presentation id it returned. */
export const perEntrySchema = z.object({ n: networkHostSchema, p: presentationIdSchema });

/** 2^37 s, a date far beyond any booking: bounds `due` and `end` so no reader overflows. */
export const MAX_RECEIPT_TIME = 2 ** 37;
const unixSeconds = z.int().min(1).max(MAX_RECEIPT_TIME);
const fingerprint = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

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
    typ: z
      .enum(["booking", "order", "refund"])
      .describe("A booking or an order; a refund (a return or a withdrawal of one) since rules version 6."),
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
      .describe("With an outcome or an amendment: the nonce of the item's earliest promise."),
    due: unixSeconds.describe(
      "A booking's start; an order's payload.delivery.when, else iat + 30 days; the date a refund must be paid by. An amendment names the new one; outcomes copy the latest amendment's, else their promise's.",
    ),
    end: unixSeconds.optional().describe("A booking's end."),
    trm: fingerprint
      .optional()
      .describe(
        "Rules version 6: base64url(HMAC-SHA-256(k, terms_sha)), the terms both sides agreed (their offer's terms_sha) under a key k the business derives for that offer and discloses only to settle a dispute, so nobody can test guessed terms against it. On a promise or an amendment; never scored.",
      ),
    acc: z
      .enum(["customer", "business"])
      .optional()
      .describe("Rules version 6, with an amendment: who accepted the change."),
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
      if (r.trm !== undefined) issue("trm belongs to a promise or an amendment", "trm");
    } else if (r.knd === "amended") {
      if (r.typ === "refund") issue("a refund is not amended: a new one is made", "typ");
      if (r.out !== undefined) issue("out belongs to an outcome", "out");
      if (r.ref === undefined) issue("an amendment names the nonce of the item's earliest promise", "ref");
      if (r.trm === undefined) issue("an amendment names the fingerprint of the terms agreed", "trm");
      if (r.acc === undefined) issue("an amendment says who accepted it", "acc");
    } else {
      if (r.out !== undefined) issue("out belongs to an outcome", "out");
      if (r.ref !== undefined) issue("ref belongs to an outcome or an amendment", "ref");
    }
    if (r.acc !== undefined && r.knd !== "amended") issue("acc belongs to an amendment", "acc");
    // A refund's promise is the date it must be paid by; confirmations and payments are a booking's or an order's.
    if (r.typ === "refund" && r.knd !== "accepted" && r.knd !== "outcome") {
      issue("a refund's receipts are its promise (accepted) and its outcome", "knd");
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
 *
 * `rules` is the version the reader takes: the rules it applies, or the next it has announced (a
 * network stores what announced rules add from the day it announces them, and scores it once they
 * are in force). Below 6, `typ: "refund"`, `knd: "amended"` and the refund outcomes are refused, and
 * `trm` and `acc` are dropped before the claims are read, as any claim a reader does not know is
 * ignored, however it looks: a promise with a malformed `trm`, or `acc`, and an outcome with `trm`,
 * are taken without them. The default is the latest rules, 6.
 */
export function parseReceiptClaims(
  payload: unknown,
  opts: { readonly rules?: number } = {},
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
    if ((opts.rules ?? RULES_V6) >= RULES_V6) {
      const r = receiptPayloadV2Schema.safeParse(payload);
      return r.success ? { version: 2, claims: r.data } : null;
    }
    // Older rules: `trm` and `acc` are not claims they know, so they are ignored however they look
    // (on an outcome, malformed, `acc` on a promise), before anything is checked; and what version 6
    // added — a refund, an amendment, a refund's outcome — is refused.
    const { trm: _trm, acc: _acc, ...known } = payload as Record<string, unknown>;
    const r = receiptPayloadV2Schema.safeParse(known);
    if (!r.success) return null;
    if (r.data.typ === "refund" || r.data.knd === "amended") return null;
    if (r.data.out !== undefined && (outcomeSince(r.data.out) ?? 0) >= RULES_V6) return null;
    return { version: 2, claims: r.data };
  }
  return null;
}
