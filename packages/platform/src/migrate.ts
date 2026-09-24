import { type SqliteClient, toDbError } from "./db";

/**
 * Forward-only migrations embedded in code (Workers cannot read files), versioned in the database,
 * applied lazily on first use and memoised per client. Each migration is one atomic batch that
 * also records itself, so a concurrent isolate either sees it applied or applies it first.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

/**
 * The version each client was brought to. Only a finished result is kept, never a run in progress:
 * on Workers a request's I/O belongs to that request, and a run another request started stops for
 * good when that request is cancelled (its client went away), so a promise shared with it could
 * leave every later request waiting for ever. Requests that meet a cold isolate together each check
 * for themselves, which costs a read or two; a migration two of them apply at once is handled below.
 */
const done = new WeakMap<SqliteClient, number>();

export async function ensureMigrated(client: SqliteClient, migrations: readonly Migration[]): Promise<number> {
  const known = done.get(client);
  if (known !== undefined) return known;
  const version = await runMigrations(client, migrations);
  done.set(client, version);
  return version;
}

/** Runs pending migrations without the memo (for tests and admin tools). Returns the current version. */
export async function runMigrations(client: SqliteClient, migrations: readonly Migration[]): Promise<number> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur && prev.version === cur.version) throw new Error(`duplicate migration version ${cur.version}`);
  }
  await client.query({
    sql: "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    method: "run",
  });
  const applied = await readApplied(client);
  let current = 0;
  for (const m of sorted) {
    const hash = await migrationHash(m);
    const seen = applied.get(m.version);
    if (seen !== undefined) {
      if (seen !== hash) {
        throw new Error(`migration ${m.version} (${m.name}) changed after it was applied; refusing to start`);
      }
      current = m.version;
      continue;
    }
    try {
      await client.batch([
        ...m.statements.map((sql) => ({ sql, method: "run" as const })),
        {
          sql: "INSERT INTO migrations (version, name, hash, applied_at) VALUES (?, ?, ?, ?)",
          params: [m.version, m.name, hash, Date.now()],
          method: "run",
        },
      ]);
    } catch (error) {
      const e = toDbError(error);
      // Another isolate or request applied it first (its table already exists, or its row does):
      // the batch rolled back whole, so re-read and carry on.
      if ((await readApplied(client).catch(() => new Map<number, string>())).get(m.version) === hash) {
        current = m.version;
        continue;
      }
      throw e;
    }
    current = m.version;
  }
  return current;
}

async function readApplied(client: SqliteClient): Promise<Map<number, string>> {
  const { rows } = await client.query({ sql: "SELECT version, hash FROM migrations ORDER BY version", method: "all" });
  return new Map(rows.map((r) => [Number(r[0]), String(r[1])]));
}

export async function migrationHash(m: Migration): Promise<string> {
  const text = m.statements.map((s) => s.trim()).join("\n;\n");
  return sha256Hex(new TextEncoder().encode(text));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
