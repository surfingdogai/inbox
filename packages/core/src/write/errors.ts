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
