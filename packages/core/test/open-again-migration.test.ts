import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { machines } from "../src/machine/tables";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { items, parties } from "../src/schema/tables";
import { makeClient } from "./harness";

const T = Date.parse("2026-11-01T10:00:00Z");
const PLAIN = { needsHuman: false, sandbox: false, priority: 0 };

/**
 * Migration 0036, open again, against every state of every kind of item, on both runtimes. A message
 * reopened, or a message or a quote request brought back with Not spam, kept the time it was closed
 * while open again: the repair clears that time on those items, and changes no other row or column.
 * apps/inbox/test/upgrade-open-again.test.ts follows a live inbox through the same upgrade.
 */
describe("migration 0036 — open again, against every state of every kind of item", () => {
  it("clears the time on the open messages and quote requests left with one, once, and on nothing else", async () => {
    const repair = MIGRATIONS.find((m) => m.name === "0036_open_again");
    if (!repair) throw new Error("no migration 0036_open_again");
    const db = createDb(await makeClient());
    // The database as it was before the repair, which the runner applies below as it would on upgrade.
    await runMigrations(
      db.client,
      MIGRATIONS.filter((m) => m.version < repair.version),
    );
    const applied = async () =>
      (
        await db.client.query({
          sql: "SELECT version FROM migrations WHERE version = ?",
          params: [repair.version],
          method: "all",
        })
      ).rows.length;
    expect(await applied()).toBe(0);

    const partyId = ulid();
    await db.orm.insert(parties).values({ id: partyId, kind: "human", createdAt: T, updatedAt: T });
    const row = (type: string, state: string, closedAt: number | null, flags: Record<string, unknown> = PLAIN) => ({
      id: ulid(),
      type,
      state,
      version: 3,
      partyId,
      channel: "email",
      payload: {},
      flags,
      createdAt: T,
      updatedAt: T + 1,
      closedAt,
    });
    // Every state of every kind of item, with the time it holds there when nothing went wrong: set in
    // a state a `close` effect leads to, none in any other.
    const kept = Object.entries(machines).flatMap(([type, m]) => {
      const closing = new Set(m.transitions.filter((t) => t.effects?.includes("close")).map((t) => t.to));
      return m.states.map((state) => row(type, state, closing.has(state) ? T + 2 : null));
    });
    // States of the same names on other kinds of item, with a time: not this repair's to touch.
    kept.push(row("order", "received", T + 2), row("order", "needs_info", T + 2), row("booking", "needs_info", T + 2));
    // What a reopen or Not spam left: open again, with the time it was closed.
    const left = [
      row("message", "open", T + 2),
      row("message", "answered", T + 2),
      row("message", "open", T + 2, { ...PLAIN, notice: true }),
      row("quote_request", "received", T + 2),
      row("quote_request", "needs_info", T + 2),
      row("quote_request", "quoted", T + 2),
    ];
    // One at a time: D1 takes at most 100 values bound to one statement.
    for (const r of [...kept, ...left]) await db.orm.insert(items).values(r);

    const before = await snapshot(db);
    expect(before.size).toBe(kept.length + left.length);
    expect(await runMigrations(db.client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await applied()).toBe(1);
    const after = await snapshot(db);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    const stuck = new Set(left.map((r) => r.id));
    for (const [id, was] of before) {
      // Only the time changes: the state, the version, when it was last updated, and its flags (the
      // notice is still a notice, listed under Notices until a person moves it) all stay as they were.
      expect(after.get(id), `${String(was.type)} ${String(was.state)}`).toEqual(
        stuck.has(id) ? { ...was, closed_at: null } : was,
      );
    }

    // Run again, nothing changes.
    await db.client.batch(repair.statements.map((sql) => ({ sql, method: "run" as const })));
    expect(await snapshot(db)).toEqual(after);
  });
});

/** Every stored column of every item, by its id. */
async function snapshot(db: Db): Promise<Map<string, Record<string, unknown>>> {
  const columns = (await db.client.query({ sql: "PRAGMA table_info(items)", method: "all" })).rows.map((r) =>
    String(r[1]),
  );
  const { rows } = await db.client.query({
    sql: `SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM items`,
    method: "all",
  });
  const at = columns.indexOf("id");
  return new Map(rows.map((r) => [String(r[at]), Object.fromEntries(columns.map((c, i) => [c, r[i]]))]));
}
