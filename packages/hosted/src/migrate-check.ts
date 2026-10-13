import { MIGRATIONS } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { nodeSqliteClient } from "@surfingdog/platform/node";

/**
 * Brings one inbox file to this release's schema and checks it: the dry run a deploy makes on a copy
 * of every inbox's file before any shard runs the release (never on a live file). Throws when a
 * migration fails or the file does not hold together, so the deploy stops with nothing restarted.
 */
export async function migrateCheck(path: string): Promise<{ readonly from: number; readonly to: number }> {
  const client = nodeSqliteClient(path);
  try {
    const first = async (sql: string): Promise<unknown> =>
      (await client.query({ sql, method: "get" })).rows[0]?.[0] ?? null;
    const from = Number(await first("SELECT max(version) FROM migrations").catch(() => 0)) || 0;
    const to = await runMigrations(client, MIGRATIONS);
    const integrity = await first("PRAGMA integrity_check");
    if (integrity !== "ok") throw new Error(`integrity check: ${String(integrity)}`);
    return { from, to };
  } finally {
    client.close();
  }
}
