import type { SqliteClient } from "@surfingdog/platform";

/** A SqliteClient for whichever runtime the test runs on. */
export async function makeClient(): Promise<SqliteClient> {
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    const spec = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ spec)) as { env: { DB: unknown } };
    const { d1Client } = await import("@surfingdog/platform/cloudflare");
    return d1Client(env.DB as Parameters<typeof d1Client>[0]);
  }
  const { nodeSqliteClient } = await import("@surfingdog/platform/node");
  return nodeSqliteClient(":memory:");
}

/**
 * Empties every application table. Node tests get a fresh in-memory database per client, but D1
 * storage is isolated per test file, so tests in one file would otherwise see each other's rows.
 */
export async function resetTables(client: SqliteClient): Promise<void> {
  const { rows } = await client.query({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'search_fts%' AND name <> 'migrations'",
  });
  const tables = rows.map((r) => String(r[0]));
  await client.batch([
    { sql: "PRAGMA defer_foreign_keys = ON", method: "run" },
    ...tables.map((t) => ({ sql: `DELETE FROM "${t}"`, method: "run" as const })),
    { sql: "DELETE FROM search_fts", method: "run" },
  ]);
}
