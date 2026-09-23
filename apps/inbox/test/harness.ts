import { createDb, type Db, MIGRATIONS } from "@surfingdog/core";
import { runMigrations, type SqliteClient } from "@surfingdog/platform";

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

/** A migrated, empty database for one test. */
export async function freshDb(): Promise<Db> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  const { rows } = await db.client.query({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'search_fts%' AND name <> 'migrations'",
  });
  await db.client.batch([
    { sql: "PRAGMA defer_foreign_keys = ON", method: "run" },
    ...rows.map((r) => ({ sql: `DELETE FROM "${String(r[0])}"`, method: "run" as const })),
    { sql: "DELETE FROM search_fts", method: "run" },
  ]);
  return db;
}

/**
 * A weekday (Monday to Friday, UTC) at least `daysAhead` days from now, as YYYY-MM-DD. The inbox
 * never books a time that has passed, so a test that books through a door with the real clock books
 * in the future, on a day the default opening hours cover.
 */
export function futureDay(daysAhead = 7): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The day after a YYYY-MM-DD, as YYYY-MM-DD. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
