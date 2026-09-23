import { MIGRATIONS } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { makeClient } from "./harness";

/**
 * The mail log and the ids a reply names (migration 0012), as a live instance meets them on upgrade:
 * the links it had keep their rows, the two new tables and their indexes appear, one email per job,
 * one item per id, and a second run changes nothing. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-23T09:00:00Z");

describe("upgrading to the mail log", () => {
  // First in the file: on workerd a file starts with an empty database, and this one needs it.
  it("adds the tables and their indexes, keeps what was there, and runs once", async () => {
    const client = await makeClient();
    const before = MIGRATIONS.filter((m) => m.name < "0012_customer_mail");
    expect(await runMigrations(client, before)).toBe(before.length);
    await client.batch([
      {
        sql: "INSERT INTO action_links (jti, item_id, action, expires_at, used_at, created_at, terms_sha, lang, mail_key) VALUES ('j1', 'i1', 'accept_time', ?, NULL, ?, 's', 'pt', 'job1')",
        params: [T0 + 86_400_000, T0],
        method: "run",
      },
    ]);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);

    const { rows: links } = await client.query({ sql: "SELECT jti, lang, mail_key FROM action_links", method: "all" });
    expect(links).toEqual([["j1", "pt", "job1"]]);
    const indexes = (
      await client.query({
        sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('outbound_mail', 'mail_refs')",
        method: "all",
      })
    ).rows.map((r) => String(r[0]));
    expect(indexes).toEqual(
      expect.arrayContaining(["outbound_mail_job", "outbound_mail_item", "outbound_mail_status", "mail_refs_item"]),
    );

    const mail = (jobKey: string) => ({
      sql: `INSERT INTO outbound_mail (id, item_id, job_key, recipient, template, lang, subject, body_text, message_ref, created_at, updated_at)
            VALUES (?, 'i1', ?, 'customer', 'ack.booking', 'en', 's', 'b', '<m.1@x>', ?, ?)`,
      params: [`m-${jobKey}-${Math.random()}`, jobKey, T0, T0],
      method: "run" as const,
    });
    await client.batch([mail("job1")]);
    const { rows } = await client.query({
      sql: "SELECT status, attempts, skip_reason, sent_at FROM outbound_mail",
      method: "all",
    });
    expect(rows).toEqual([["queued", 0, null, null]]);
    // One email per job, and one item per id a reply may name.
    await expect(client.batch([mail("job1")])).rejects.toThrow();
    await client.batch([
      {
        sql: "INSERT INTO mail_refs (ref, item_id, kind, created_at) VALUES ('<a.1@x>', 'i1', 'anchor', ?)",
        params: [T0],
        method: "run",
      },
    ]);
    await expect(
      client.batch([
        {
          sql: "INSERT INTO mail_refs (ref, item_id, kind, created_at) VALUES ('<a.1@x>', 'i2', 'anchor', ?)",
          params: [T0],
          method: "run",
        },
      ]),
    ).rejects.toThrow();
  });
});
