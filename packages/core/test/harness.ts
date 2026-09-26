import type { SqliteClient } from "@surfingdog/platform";
import type { Capabilities } from "../src/capabilities/service";
import type { Caller } from "../src/write/caller";
import { WriteError } from "../src/write/errors";

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

/**
 * Capabilities whose customers say yes at the confirm step (ADR-018 §5): a priced booking or order
 * asked for without `terms_sha` is sent again with the fingerprint its `confirm_terms` answer gave,
 * as an assistant does once its person confirmed the summary. For tests about something else; the
 * confirm step's own tests use the capabilities as they are.
 */
export function confirming<C extends Capabilities>(caps: C): C {
  const again =
    <I extends { terms_sha?: string | undefined }, R>(fn: (caller: Caller, input: I) => Promise<R>) =>
    async (caller: Caller, input: I): Promise<R> => {
      try {
        return await fn(caller, input);
      } catch (error) {
        const sha = (error as WriteError).details?.terms_sha;
        if (
          !(error instanceof WriteError) ||
          error.code !== "confirm_terms" ||
          input.terms_sha ||
          typeof sha !== "string"
        ) {
          throw error;
        }
        return fn(caller, { ...input, terms_sha: sha });
      }
    };
  caps.createBooking = again(caps.createBooking.bind(caps));
  caps.createOrder = again(caps.createOrder.bind(caps));
  return caps;
}
