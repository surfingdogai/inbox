/**
 * The SQLite-shaped database seam. Every runtime implements `SqliteClient`; core only ever sees
 * this interface, and never an interactive transaction: `batch` is the one atomic multi-statement
 * write (ADR-007, ADR-011).
 */
export type SqlMethod = "run" | "all" | "get" | "values";
export type SqlParam = string | number | bigint | null | Uint8Array;
/** What callers may pass; adapters normalise booleans, undefined and dates before binding. */
export type SqlInput = SqlParam | boolean | undefined | Date;

export interface Statement {
  readonly sql: string;
  readonly params?: readonly SqlInput[];
  /** `run` for writes (use `all` for writes with RETURNING), `all`/`values` for rows, `get` for one row. Default `all`. */
  readonly method?: SqlMethod;
}

export interface RawResult {
  /** Rows as arrays, in column order. Empty for `run`. */
  readonly rows: unknown[][];
  readonly changes: number;
  readonly lastRowId: number | null;
}

export type SqliteKind = "d1" | "do" | "node-sqlite" | "bun-sqlite";

export interface SqliteClient {
  readonly kind: SqliteKind;
  query(stmt: Statement): Promise<RawResult>;
  /** Atomic and sequential: every statement commits or none does; rejects with the first failure. */
  batch(stmts: readonly Statement[]): Promise<RawResult[]>;
}

export type DbErrorCode = "unique" | "constraint" | "busy" | "syntax" | "other";

export class DbError extends Error {
  readonly code: DbErrorCode;
  /** For `unique`/`constraint`: the `table.column` SQLite names, when it says. */
  readonly constraint: string | undefined;

  constructor(code: DbErrorCode, message: string, options: { cause?: unknown; constraint?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DbError";
    this.code = code;
    this.constraint = options.constraint;
  }
}

export function normalizeParams(params: readonly SqlInput[] | undefined): SqlParam[] {
  if (!params) return [];
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (p instanceof Date) return p.getTime();
    return p;
  });
}

/** Maps SQLite's error text (the one thing every runtime exposes) to a stable code. */
export function classifySqliteMessage(message: string): { code: DbErrorCode; constraint?: string } {
  const m = message.replace(/^D1_ERROR:\s*/, "").replace(/:\s*SQLITE_\w+$/, "");
  const unique = /^(?:UNIQUE|PRIMARY KEY) constraint failed:\s*([\w.]+)/.exec(m);
  if (unique?.[1]) return { code: "unique", constraint: unique[1] };
  const other = /^(NOT NULL|CHECK|FOREIGN KEY) constraint failed(?::\s*([\w.]+))?/.exec(m);
  if (other) return other[2] ? { code: "constraint", constraint: other[2] } : { code: "constraint" };
  if (/database is locked|database table is locked|SQLITE_BUSY/i.test(m)) return { code: "busy" };
  if (/syntax error|no such (?:table|column|function)|not authorized/i.test(m)) return { code: "syntax" };
  return { code: "other" };
}

export function toDbError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const { code, constraint } = classifySqliteMessage(message);
  return new DbError(code, message, constraint === undefined ? { cause: error } : { cause: error, constraint });
}
