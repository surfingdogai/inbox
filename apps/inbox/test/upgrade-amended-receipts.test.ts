import { MIGRATIONS } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { makeClient } from "./harness";

/**
 * Rules version 6's receipts (ADR-017 Amendment 3, migration 0017), as a live instance meets them on
 * upgrade: every receipt already issued keeps its row, unchanged and still one of its kind; an item
 * may now hold one `amended` receipt per change both sides agreed, and still only one of every other
 * kind and outcome. Run twice, the migration changes nothing more. Runs on Node and in workerd.
 */
describe("upgrading to amended receipts", () => {
  it("keeps every receipt as it was, and lets an item hold one amendment per agreed change", async () => {
    const client = await makeClient();
    const before = MIGRATIONS.filter((m) => m.name < "0017_amended_receipts");
    expect(await runMigrations(client, before)).toBe(before.length);
    const now = Date.now();
    const receipt = (id: string, kind: string, outcome = "") => ({
      sql: "INSERT INTO receipts (id, item_id, kind, outcome, jws, payload, kid, subject_hash, issued_at) VALUES (?, 'item_1', ?, ?, 'a.b.c', '{}', 'kid_1', 'sub', ?)",
      params: [id, kind, outcome, now],
      method: "run" as const,
    });
    await client.batch([
      {
        sql: "INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('party_1', 'human', ?, ?)",
        params: [now, now],
        method: "run",
      },
      {
        sql: `INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at)
              VALUES ('item_1', 'booking', 'completed', 3, 'party_1', 'form', '{}', '{}', ?, ?)`,
        params: [now, now],
        method: "run",
      },
      receipt("r_promise", "confirmed"),
      receipt("r_outcome", "outcome", "booking.completed"),
    ]);

    // Twice: the second run finds nothing more to do.
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);

    const { rows } = await client.query({
      sql: "SELECT id, kind, outcome, offer_id FROM receipts ORDER BY id",
      method: "all",
    });
    expect(rows.map((r) => r.map(String))).toEqual([
      ["r_outcome", "outcome", "booking.completed", ""],
      ["r_promise", "confirmed", "", ""],
    ]);
    const indexes = await client.query({
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'receipts' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      method: "all",
    });
    expect(indexes.rows.map((r) => String(r[0]))).toEqual(["receipts_item_kind_outcome_offer", "receipts_sha"]);

    // Two amendments of one item, each naming its change; a second of the same change, or a second
    // promise of one kind, is refused by the index.
    const amended = (id: string, offer: string) => ({
      sql: "INSERT INTO receipts (id, item_id, kind, outcome, offer_id, jws, payload, kid, subject_hash, issued_at) VALUES (?, 'item_1', 'amended', '', ?, 'a.b.c', '{}', 'kid_1', 'sub', ?)",
      params: [id, offer, now],
      method: "run" as const,
    });
    await client.batch([amended("r_amended_1", "offer_1"), amended("r_amended_2", "offer_2")]);
    await expect(client.batch([amended("r_amended_3", "offer_1")])).rejects.toThrow();
    await expect(client.batch([receipt("r_promise_2", "confirmed")])).rejects.toThrow();
  });
});
