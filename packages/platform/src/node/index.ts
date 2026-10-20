import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
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

/**
 * A backup of a `node:sqlite` database: everything it holds, the sealed secrets and the receipt
 * signing keys included, unlike `nodeSnapshot`'s copy for the owner to take away. `VACUUM INTO`
 * writes it while the inbox keeps serving, beside `target` under a `.partial` name of this process's
 * own, so a backup that stopped halfway is never taken for one that finished, and two backups at once
 * never share one. The copy is put in the rollback journal so it is one file, checked, readable by
 * this user only (it holds every customer's details), and only then linked to `target`, which fails
 * when a file is there already: it never overwrites one, even one that appeared meanwhile. And it
 * never migrates anything: a backup taken before an update is the database exactly as the running
 * version left it.
 */
export function backupDatabase(client: NodeSqliteClient, target: string): DatabaseReport {
  const exists = () => new Error(`${target} exists already, and a backup never overwrites a file`);
  if (existsSync(target)) throw exists();
  const partial = `${target}.${process.pid}.${Date.now()}.partial`;
  try {
    client.raw.prepare("VACUUM INTO ?").run(partial);
    chmodSync(partial, 0o600);
    const copy = new DatabaseSync(partial);
    try {
      copy.exec("PRAGMA journal_mode = DELETE");
    } finally {
      copy.close();
    }
    const report = inspectDatabase(partial);
    if (!report.ok) throw new Error(`the copy failed its check: ${report.problem}`);
    try {
      linkSync(partial, target);
      rmSync(partial, { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw exists();
      // A file system without hard links: a rename, after one more look.
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV") throw error;
      if (existsSync(target)) throw exists();
      renameSync(partial, target);
    }
    return report;
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

/** What a database file is: an inbox's, sound, and how far it was migrated. */
export interface DatabaseReport {
  /** True when the file is a sound SQLite database that an inbox made. */
  readonly ok: boolean;
  /** Why it is not, in a few words; null when it is. */
  readonly problem: string | null;
  readonly bytes: number;
  /** The newest migration applied to it, or null when it has none. */
  readonly migration: number | null;
  /** How many requests it holds, and whether anyone has signed in to it. */
  readonly items: number | null;
  readonly owner: boolean | null;
}

/**
 * Looks at a database file before anything is restored from it: that it is SQLite at all (its first
 * sixteen bytes), sound (`PRAGMA quick_check`), and an inbox's (its `migrations` table). The file is
 * opened, so a database in the write-ahead log may gain and then lose its `-wal` and `-shm` files
 * beside it; nothing in it is changed.
 */
export function inspectDatabase(file: string): DatabaseReport {
  const none = { migration: null, items: null, owner: null } as const;
  if (!existsSync(file)) return { ok: false, problem: "there is no such file", bytes: 0, ...none };
  const bytes = statSync(file).size;
  const head = Buffer.alloc(16);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  if (head.toString("latin1") !== "SQLite format 3\u0000") {
    return { ok: false, problem: "it is not an SQLite database", bytes, ...none };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error), bytes, ...none };
  }
  try {
    const check = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    const problems = check.map((r) => r.quick_check).filter((r) => r !== "ok");
    if (problems.length > 0) return { ok: false, problem: `it is damaged: ${problems[0]}`, bytes, ...none };
    const has = (name: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    if (!has("migrations")) return { ok: false, problem: "it is not an inbox's database", bytes, ...none };
    const top = db.prepare("SELECT max(version) AS v FROM migrations").get() as { v: number | null } | undefined;
    const count = (name: string) =>
      has(name) ? Number((db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n) : null;
    const users = count("users");
    return {
      ok: true,
      problem: null,
      bytes,
      migration: top?.v ?? null,
      items: count("items"),
      owner: users === null ? null : users > 0,
    };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error), bytes, ...none };
  } finally {
    db.close();
  }
}
