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
