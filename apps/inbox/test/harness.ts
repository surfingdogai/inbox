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

/**
 * A request as a customer's assistant sends it once its person confirmed the summary (ADR-018 §5): a
 * priced booking or order answered `409 confirm_terms` is sent again, as it was, with the fingerprint
 * it was given. Anything else is answered as it is.
 */
export async function confirmed(
  send: (request: Request) => Response | Promise<Response>,
  request: Request,
): Promise<Response> {
  // Only a create: an acceptance's confirm step is each test's own to answer.
  const create = request.method === "POST" && /\/v1\/(bookings|orders)\/?$/.test(new URL(request.url).pathname);
  const body = create ? await request.clone().text() : "";
  const first = await send(request);
  if (first.status !== 409 || !body) return first;
  const problem = (await first
    .clone()
    .json()
    .catch(() => null)) as { code?: string; details?: { terms_sha?: unknown } } | null;
  const sha = problem?.code === "confirm_terms" ? problem.details?.terms_sha : undefined;
  if (typeof sha !== "string") return first;
  const json = JSON.parse(body) as Record<string, unknown>;
  return send(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ ...json, terms_sha: sha }),
    }),
  );
}

/**
 * A tool call as an assistant makes it once its person confirmed: a priced create answered with the
 * summary to confirm (`structuredContent.confirm`) is called again with its `terms_sha`.
 */
export async function confirmedTool<R>(
  call: (params: { name: string; arguments: Record<string, unknown> }) => Promise<R>,
  params: { name: string; arguments: Record<string, unknown> },
): Promise<R> {
  const first = await call(params);
  const sha = (first as { structuredContent?: { confirm?: { terms_sha?: unknown } } }).structuredContent?.confirm
    ?.terms_sha;
  if (typeof sha !== "string") return first;
  return call({ ...params, arguments: { ...params.arguments, terms_sha: sha } });
}
