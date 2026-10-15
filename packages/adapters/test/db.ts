import { Capabilities, createDb, MIGRATIONS } from "@surfingdog/core";
import { runMigrations, type SqliteClient } from "@surfingdog/platform";

async function makeClient(): Promise<SqliteClient> {
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    const spec = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ spec)) as { env: { DB: unknown } };
    const { d1Client } = await import("@surfingdog/platform/cloudflare");
    return d1Client(env.DB as Parameters<typeof d1Client>[0]);
  }
  const { nodeSqliteClient } = await import("@surfingdog/platform/node");
  return nodeSqliteClient(":memory:");
}

/** A migrated, empty database plus capabilities, on whichever runtime the test runs in. */
export async function freshDb() {
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
  return { db, caps: new Capabilities(db) };
}

/**
 * Opening hours, Monday to Friday 09:00 to 18:00, for the whole business: hours nobody set are no
 * hours (nothing is offered or booked in them), so a test that books opens the business first.
 */
export async function openWeekdays(db: { client: SqliteClient }): Promise<void> {
  const day = [["09:00", "18:00"]];
  await db.client.query({
    sql: "INSERT INTO availability_rules (id, service_id, kind, weekly, created_at) VALUES (?, NULL, 'open', ?, ?)",
    params: [
      `hours${Math.random().toString(36).slice(2, 12)}`,
      JSON.stringify({ mon: day, tue: day, wed: day, thu: day, fri: day }),
      Date.now(),
    ],
    method: "run",
  });
}
