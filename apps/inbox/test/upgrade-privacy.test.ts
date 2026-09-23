import { MIGRATIONS } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { makeClient } from "./harness";

/**
 * A customer who stops the booking network, and who wrote a reply (migration 0013), as a live
 * instance meets them on upgrade: the parties and entries it had keep their rows, every one starts
 * with networks on and its writer judged by who sent it, the fingerprints' table appears, and a
 * second run changes nothing. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-23T09:00:00Z");

describe("upgrading to customers who can stop the networks", () => {
  // First in the file: on workerd a file starts with an empty database, and this one needs it.
  it("adds the columns and the table, keeps what was there, and runs once", async () => {
    const client = await makeClient();
    const before = MIGRATIONS.filter((m) => m.name < "0013_customer_privacy");
    expect(await runMigrations(client, before)).toBe(before.length);
    await client.batch([
      {
        sql: "INSERT INTO parties (id, kind, display_name, contact, created_at, updated_at) VALUES ('p1', 'human', 'Rita', ?, ?, ?)",
        params: [JSON.stringify({ email: "rita@example.com" }), T0, T0],
        method: "run",
      },
      {
        sql: `INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at)
              VALUES ('i1', 'message', 'open', 1, 'p1', 'email', '{"text":"hi"}', '{}', ?, ?)`,
        params: [T0, T0],
        method: "run",
      },
      {
        sql: `INSERT INTO thread_entries (id, item_id, direction, channel, actor_kind, body_text, created_at)
              VALUES ('e1', 'i1', 'out', 'rest', 'integration', 'Hello', ?)`,
        params: [T0],
        method: "run",
      },
    ]);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);

    const party = await client.query({ sql: "SELECT display_name, networks_off_at FROM parties", method: "all" });
    expect(party.rows).toEqual([["Rita", null]]);
    const entry = await client.query({ sql: "SELECT body_text, written_by FROM thread_entries", method: "all" });
    expect(entry.rows).toEqual([["Hello", null]]);
    const columns = (await client.query({ sql: "PRAGMA table_info(network_stops)", method: "all" })).rows.map((r) =>
      String(r[1]),
    );
    expect(columns).toEqual(["hash", "via", "created_at"]);
    const stop = (hash: string) => ({
      sql: "INSERT INTO network_stops (hash, via, created_at) VALUES (?, 'customer', ?)",
      params: [hash, T0],
      method: "run" as const,
    });
    await client.batch([stop("a".repeat(64))]);
    // One row per fingerprint.
    await expect(client.batch([stop("a".repeat(64))])).rejects.toThrow();
  });
});
