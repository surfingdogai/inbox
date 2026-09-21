import { normalizeParams, type RawResult, type SqliteClient, type Statement, toDbError } from "../db";

/**
 * SqliteClient over Cloudflare D1. Structural types so this package needs no Workers type
 * package; `env.DB` satisfies `D1Like`. D1 is auto-commit; `batch` is its only transaction.
 */
export interface D1ResultLike {
  readonly results?: unknown[];
  readonly meta?: { readonly changes?: number; readonly last_row_id?: number };
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<D1ResultLike>;
  raw<T = unknown[]>(): Promise<T[]>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1ResultLike[]>;
}

export function d1Client(db: D1Like): SqliteClient {
  const bind = (stmt: Statement) => db.prepare(stmt.sql).bind(...normalizeParams(stmt.params));
  return {
    kind: "d1",
    async query(stmt) {
      try {
        const prepared = bind(stmt);
        switch (stmt.method ?? "all") {
          case "run": {
            const r = await prepared.run();
            return { rows: [], changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? null };
          }
          case "get": {
            const rows = await prepared.raw<unknown[]>();
            return { rows: rows.length ? [rows[0] as unknown[]] : [], changes: 0, lastRowId: null };
          }
          default:
            return { rows: await prepared.raw<unknown[]>(), changes: 0, lastRowId: null };
        }
      } catch (error) {
        throw toDbError(error);
      }
    },
    async batch(stmts) {
      try {
        const results = await db.batch(stmts.map(bind));
        return results.map(
          (r): RawResult => ({
            // D1's batch returns object rows; column order follows the statement, so values() is stable.
            rows: (r.results ?? []).map((row) => Object.values(row as Record<string, unknown>)),
            changes: r.meta?.changes ?? 0,
            lastRowId: r.meta?.last_row_id ?? null,
          }),
        );
      } catch (error) {
        throw toDbError(error);
      }
    },
  };
}
