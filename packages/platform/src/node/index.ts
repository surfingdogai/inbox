import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  DbError,
  normalizeParams,
  type RawResult,
  type Snapshot,
  type SqliteClient,
  type SqliteSnapshot,
  type Statement,
  toDbError,
} from "../db";

export * from "./outbound";

/**
 * SqliteClient over Node's built-in `node:sqlite` (Node 22.16+ for FTS5). Synchronous underneath,
 * so `batch` is a real BEGIN IMMEDIATE … COMMIT. No native module to compile.
 */
export interface NodeSqliteOptions {
  /**
   * Extra PRAGMA statements run after open. WAL, NORMAL sync, foreign keys, a 5 s busy timeout and
   * secure delete are always set.
   */
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
  // Secure delete: what a delete removes is overwritten, not left in free pages for whoever reads the
  // file (an erased customer's photos, ADR-034 §2).
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;",
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

/**
 * A copy of a `node:sqlite` database for its owner to take away (`SqliteSnapshot`). `VACUUM INTO`
 * writes a consistent copy while the inbox keeps serving; the copy is opened on its own, in the
 * rollback journal so it stays one file, `strip` runs on it, and `VACUUM` rebuilds it so what was
 * removed is gone from its pages too. Until `strip` has run the copy holds everything the database
 * does, so it is made in a directory of its own that only this process's user can open, under `dir`
 * (the system's temporary directory unless the host names another: the database's own directory has
 * room for a copy, where a tmpfs in memory may not), and removed whatever happens.
 */
export function nodeSnapshot(client: NodeSqliteClient, dir: string = tmpdir()): SqliteSnapshot {
  return async (strip): Promise<Snapshot> => {
    const own = mkdtempSync(join(dir, "inbox-copy-"));
    const file = join(own, "inbox.db");
    try {
      client.raw.prepare("VACUUM INTO ?").run(file);
      const copy = new DatabaseSync(file);
      let tables: { name: string; rows: number }[];
      try {
        copy.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = OFF;");
        copy.exec("BEGIN IMMEDIATE");
        try {
          for (const sql of strip) copy.exec(sql);
          copy.exec("COMMIT");
        } catch (error) {
          copy.exec("ROLLBACK");
          throw error;
        }
        copy.exec("VACUUM");
        const names = copy
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as { name: string }[];
        tables = names.map(({ name }) => ({
          name,
          rows: Number(
            (copy.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n,
          ),
        }));
      } finally {
        copy.close();
      }
      return { bytes: new Uint8Array(readFileSync(file)), tables };
    } catch (error) {
      throw toDbError(error);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  };
}
