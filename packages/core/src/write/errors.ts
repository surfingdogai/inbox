import type { z } from "zod";

export type WriteErrorCode =
  | "invalid_input"
  | "not_found"
  | "not_allowed"
  | "wrong_state"
  | "unknown_event"
  | "guard_failed"
  | "slot_taken"
  | "version_conflict"
  | "idempotency_mismatch"
  /** ADR-017 §8.2: a one-time code for a customer the business knows. */
  | "nothing_to_verify"
  | "already_verified"
  | "bad_code"
  | "code_expired"
  | "too_many_attempts"
  /** ADR-017 §8.3: a rule that reads a reputation may only speed things up or ask a person. */
  | "positive_only"
  /** ADR-017 §2.4: the same signed request, again, without the idempotency key that would replay it. */
  | "replayed_signature"
  /**
   * ADR-018 §5, the confirm step: an acceptance that would bind the customer, sent without the
   * fingerprint of the terms they were shown. Nothing is written; the answer carries the terms.
   */
  | "confirm_terms"
  /** The terms the customer was shown are not the ones open now; the answer carries the current ones. */
  | "offer_changed"
  /** The quote being accepted is no longer valid. */
  | "offer_expired"
  /** Nothing is waiting for the customer's answer on this item. */
  | "no_offer"
  /**
   * Erasing a customer cannot be undone: without the `confirm` its preview gave (or with one that no
   * longer matches, because the customer has changed since), nothing is erased; the answer says what would be.
   */
  | "confirm_erase"
  /**
   * ADR-018 §7, the withdrawal's two steps (CRD art. 11a): a withdrawal sent without
   * `confirm_withdrawal`. Nothing is sent; the answer carries the statement to show the customer.
   */
  | "confirm_withdrawal"
  /**
   * ADR-018 §4: what automation would accept is outside the limits the owner set (a price under the
   * floor, an order above the value the owner takes in person). `details.breaches` names them as codes,
   * never a number; a person decides.
   */
  | "outside_limits"
  /** The draft was made on the item as it stood, and the item has moved since: the owner offers afresh. */
  | "draft_stale"
  /** ADR-018 §4: a rule that reads where a customer lives or comes from may not set a price or terms. */
  | "geo_terms"
  /**
   * ADR-041 §4.4: one sender started more new conversations today than any person does; the answer
   * says when to come back (`details.retry_after_s`), never why.
   */
  | "too_many_requests"
  /** Something the inbox depends on did not answer just now (an owner's own AI provider): try again later. */
  | "unavailable"
  /**
   * ADR-042, an assistant paying an order directly: the business takes no payment from assistants for
   * it (`details.reason`: off, no_connection, currency, zero_total, connection, refused).
   */
  | "agent_pay_unavailable"
  /** The order is not accepted yet: nothing is charged before it is (`details.retry_after_s` or `waiting_on`). */
  | "not_accepted_yet"
  | "already_paid"
  /** A change to the order waits for an answer: what it comes to is not settled. */
  | "change_pending"
  /** The terms the customer confirmed are not the order's now: `details` carries the current fingerprint. */
  | "terms_changed"
  /** Another payment for the order is on its way: retry with the same idempotency key. */
  | "in_progress"
  /** The token is not for this business, this mode, or this inbox's platform. */
  | "token_invalid"
  | "token_expired"
  /** The token was spent, or revoked by the customer or their platform. */
  | "token_used"
  /** The token's limit is below the order's total, or in another currency. */
  | "token_limit"
  /** The card was declined: nothing was charged. */
  | "payment_declined"
  /** The card asks its holder to confirm the payment themselves: `details.payment_url` when there is one. */
  | "authentication_required"
  /** The payment platform could not be reached: retry with the same idempotency key; nothing is charged twice. */
  | "platform_unavailable"
  | "internal";

export interface FieldProblem {
  readonly path: string;
  readonly problem: "missing" | "invalid";
  readonly message: string;
}

const STATUS: Record<WriteErrorCode, number> = {
  invalid_input: 422,
  not_found: 404,
  not_allowed: 403,
  wrong_state: 409,
  unknown_event: 400,
  guard_failed: 409,
  slot_taken: 409,
  version_conflict: 409,
  idempotency_mismatch: 422,
  nothing_to_verify: 409,
  already_verified: 409,
  bad_code: 422,
  code_expired: 422,
  too_many_attempts: 429,
  positive_only: 422,
  replayed_signature: 401,
  confirm_terms: 409,
  offer_changed: 409,
  offer_expired: 410,
  no_offer: 409,
  confirm_erase: 409,
  confirm_withdrawal: 409,
  outside_limits: 422,
  draft_stale: 409,
  geo_terms: 422,
  too_many_requests: 429,
  unavailable: 503,
  agent_pay_unavailable: 409,
  not_accepted_yet: 409,
  already_paid: 409,
  change_pending: 409,
  terms_changed: 409,
  in_progress: 409,
  token_invalid: 422,
  token_expired: 422,
  token_used: 422,
  token_limit: 422,
  payment_declined: 402,
  authentication_required: 402,
  platform_unavailable: 503,
  internal: 500,
};

/** A refused write. `fields`, where the refusal is about the request, names what to fix to retry in one step. */
export class WriteError extends Error {
  readonly code: WriteErrorCode;
  readonly status: number;
  readonly fields: readonly FieldProblem[] | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: WriteErrorCode,
    message: string,
    extra: { fields?: readonly FieldProblem[]; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "WriteError";
    this.code = code;
    this.status = STATUS[code];
    this.fields = extra.fields;
    this.details = extra.details;
  }

  toJSON() {
    return { error: this.code, message: this.message, fields: this.fields, details: this.details };
  }
}

/**
 * The refusal of a customer's read or write on an item that is not theirs as far as the request shows.
 * When no token and no party came at all, it says where the token goes: the item may well be theirs,
 * and the token was only sent where the door does not look.
 */
export function notYoursError(caller: {
  readonly accessToken?: string | undefined;
  readonly actor: { readonly partyId?: string | undefined };
}): WriteError {
  if (!caller.accessToken && !caller.actor.partyId) {
    return new WriteError(
      "not_allowed",
      "No access token came with this request. Send the token the item was created with as access_token (an argument on MCP; on REST in the body, the query, or best the X-Access-Token header), or a pass the item recognises.",
      { details: { reason: "no_access_token" } },
    );
  }
  return new WriteError("not_allowed", "this item belongs to someone else");
}

export function fromZod(error: z.ZodError, prefix = ""): WriteError {
  const fields: FieldProblem[] = error.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].filter(Boolean).join("."),
    problem: i.code === "invalid_type" && /received undefined/i.test(i.message) ? "missing" : "invalid",
    message: i.message,
  }));
  const missing = fields.filter((f) => f.problem === "missing").map((f) => f.path);
  const message = missing.length
    ? `Missing: ${missing.join(", ")}. Add them and retry with the same idempotency key.`
    : `Invalid input: ${fields.map((f) => `${f.path} ${f.message}`).join("; ")}`;
  return new WriteError("invalid_input", message, { fields });
}
