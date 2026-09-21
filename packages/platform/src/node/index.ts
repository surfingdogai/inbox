import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DbError, normalizeParams, type RawResult, type SqliteClient, type Statement, toDbError } from "../db";

/**
 * SqliteClient over Node's built-in `node:sqlite` (Node 22.16+ for FTS5). Synchronous underneath,
 * so `batch` is a real BEGIN IMMEDIATE … COMMIT. No native module to compile.
 */
export interface NodeSqliteOptions {
  /** Extra PRAGMA statements run after open. WAL, NORMAL sync, foreign keys and a 5 s busy timeout are always set. */
  readonly pragmas?: readonly string[];
  /** Prepared statements kept warm. Default 256. */
  readonly statementCache?: number;
}

export interface NodeSqliteClient extends SqliteClient {
  readonly raw: DatabaseSync;
  close(): void;
}

export function nodeSqliteClient(path: string, options: NodeSqliteOptions = {}): NodeSqliteClient {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
  );
  for (const pragma of options.pragmas ?? []) db.exec(pragma);
  const fts5 = db
    .prepare("SELECT count(*) AS c FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'")
    .get() as { c: number } | undefined;
  if (!fts5 || fts5.c < 1) {
    throw new DbError("other", "this Node build's SQLite lacks FTS5; Surfing Dog Inbox needs Node 22.16 or newer");
  }

  const cap = options.statementCache ?? 256;
  const cache = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    const hit = cache.get(sql);
    if (hit) return hit;
    const st = db.prepare(sql);
    st.setReturnArrays(true);
    if (cache.size >= cap) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(sql, st);
    return st;
  };

  const exec = (stmt: Statement): RawResult => {
    const st = prepare(stmt.sql);
    const params = normalizeParams(stmt.params) as (string | number | bigint | null | Uint8Array)[];
    switch (stmt.method ?? "all") {
      case "run": {
        const r = st.run(...params);
        return {
          rows: [],
          changes: Number(r.changes),
          lastRowId: r.lastInsertRowid === undefined ? null : Number(r.lastInsertRowid),
        };
      }
      case "get": {
        const row = st.get(...params) as unknown[] | undefined;
        return { rows: row ? [row] : [], changes: 0, lastRowId: null };
      }
      default:
        return { rows: st.all(...params) as unknown as unknown[][], changes: 0, lastRowId: null };
    }
  };

  return {
    kind: "node-sqlite",
    raw: db,
    async query(stmt) {
      try {
        return exec(stmt);
      } catch (error) {
        throw toDbError(error);
      }
    },
    async batch(stmts) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = stmts.map(exec);
        db.exec("COMMIT");
        return results;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back by SQLite
        }
        throw toDbError(error);
      }
    },
    close() {
      cache.clear();
      db.close();
    },
  };
}
