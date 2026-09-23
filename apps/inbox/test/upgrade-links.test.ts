import { MIGRATIONS } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { makeClient } from "./harness";

/**
 * Links in the business's emails (ADR-018 §5, migration 0011), as a live instance meets them on
 * upgrade: the table it already had keeps its rows, gains the terms, the language and the email
 * they belong to, with their defaults, and its indexes; a second run changes nothing. Runs on Node
 * and in workerd.
 */
const T0 = Date.parse("2026-09-23T09:00:00Z");

describe("upgrading to the customer's links", () => {
  // First in the file: on workerd a file starts with an empty database, and this one needs it.
  it("keeps every row, adds the new columns with their defaults, and its indexes", async () => {
    const client = await makeClient();
    const before = MIGRATIONS.filter((m) => m.name < "0011_customer_links");
    expect(await runMigrations(client, before)).toBe(before.length);
    await client.batch([
      {
        sql: "INSERT INTO action_links (jti, item_id, action, expires_at, used_at, created_at) VALUES ('j1', 'i1', 'accept', ?, NULL, ?)",
        params: [T0 + 86_400_000, T0],
        method: "run",
      },
    ]);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);

    const { rows } = await client.query({
      sql: "SELECT jti, item_id, action, expires_at, used_at, terms_sha, lang, mail_key FROM action_links",
      method: "all",
    });
    expect(rows).toEqual([["j1", "i1", "accept", T0 + 86_400_000, null, "", "en", null]]);
    const indexes = (
      await client.query({
        sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'action_links'",
        method: "all",
      })
    ).rows.map((r) => String(r[0]));
    expect(indexes).toEqual(expect.arrayContaining(["action_links_item", "action_links_mail", "action_links_expires"]));
  });
});
