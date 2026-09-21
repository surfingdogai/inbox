import type { RawResult, SqliteClient, Statement } from "@surfingdog/platform";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema/tables";

export type Orm = SqliteRemoteDatabase<typeof schema>;

/** Typed queries plus the raw client. There is no `transaction()`: batch is the only atomic write (ADR-007). */
export interface Db {
  readonly orm: Orm;
  readonly client: SqliteClient;
  batch(stmts: readonly Statement[]): Promise<RawResult[]>;
}

type ProxyRow = { rows: unknown };

export function createDb(client: SqliteClient): Db {
  const shape = (method: string, r: RawResult): ProxyRow => (method === "get" ? { rows: r.rows[0] } : { rows: r.rows });
  const orm = drizzle(
    async (sql, params, method) => shape(method, await client.query({ sql, params, method })) as { rows: unknown[] },
    async (queries) => {
      const results = await client.batch(queries.map((q) => ({ sql: q.sql, params: q.params, method: q.method })));
      return results.map((r, i) => shape(queries[i]?.method ?? "all", r) as { rows: unknown[] });
    },
    { schema },
  );
  Object.defineProperty(orm, "transaction", {
    value: () => {
      throw new Error("db.transaction() is not available: use batch() with constraints (ADR-007)");
    },
  });
  return { orm, client, batch: (stmts) => client.batch(stmts) };
}

export { schema };
