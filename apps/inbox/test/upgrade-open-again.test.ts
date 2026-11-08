import { createApiKey, type IngestResult, ingestEmail } from "@surfingdog/adapters";
import { type Caller, createDb, MIGRATIONS } from "@surfingdog/core";
import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { makeClient } from "./harness";

/**
 * Open again, as listed (migration 0036), as a live inbox meets it on upgrade. Before a reopen cleared
 * the time an item was closed, a conversation a customer's reply opened again, and a message or a notice
 * brought back with Not spam, kept it: open, yet listed under Done and out of what is open, and a notice
 * moved to the inbox went to Done. On upgrade each is open again where the owner looks, and nothing
 * closed is touched. Runs on Node and in workerd.
 */
const INBOX = "https://inbox.example.com";
const T0 = Date.parse("2026-11-01T09:00:00Z");

const raw = (headers: Record<string, string>, text: string) =>
  `${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;

const owner: Caller = {
  actor: { kind: "owner", id: "user_owner", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0 + 60_000,
};

const idOf = (r: IngestResult) => ("itemId" in r ? (r.itemId ?? "") : "");

describe("upgrading to open again", () => {
  // First in the file: on workerd a file starts with an empty database, and this one needs it.
  it("lists each item opened again with what is open, a notice brought back too, and leaves what is closed", async () => {
    const client = await makeClient();
    const before = MIGRATIONS.filter((m) => m.name < "0036_open_again");
    expect(before).toHaveLength(MIGRATIONS.length - 1);
    expect(await runMigrations(client, before)).toBe(before.length);
    const db = createDb(client);
    const inbox = createInbox({
      db,
      secretKey: "2f8c1d0a6b4e37925c8f01ad6e3b47f0",
      baseUrl: INBOX,
      mailOut: logMailOut(),
      eventSettleMs: 0,
      background: () => undefined,
    });
    const ingest = async (headers: Record<string, string>, text: string) =>
      idOf(
        await ingestEmail(
          db,
          inbox.caps,
          {
            raw: raw({ To: "support@oficinamare.example", ...headers }, text),
            envelopeTo: "oficina-mare@in.example.net",
            auth: { dmarc: "pass" },
          },
          { now: () => T0 },
        ),
      );

    // As the release before this one left them, each as it was then: closed, then written to again.
    const reopened = await ingest(
      { From: "Rita <rita@example.com>", Subject: "Wheel", "Message-ID": "<c1@example.com>" },
      "Could you rebuild my rear wheel?",
    );
    await inbox.caps.transitionItem(owner, { item_id: reopened, event: "close" });
    await ingest(
      {
        From: "Rita <rita@example.com>",
        Subject: "Re: Wheel",
        "Message-ID": "<c2@example.com>",
        "In-Reply-To": "<c1@example.com>",
      },
      "And the front one?",
    );
    // A customer's message a mail server marked as spam, and a registrar's notice: Not spam on each.
    const unspammed = await ingest(
      { From: "Ines <ines@example.net>", Subject: "Front", "Message-ID": "<w1@example.net>", "X-Spam-Flag": "YES" },
      "Could you true my front wheel?",
    );
    const notice = await ingest(
      {
        From: "Registrar <no-reply@registrar.example>",
        Subject: "Invoice 118",
        "Message-ID": "<i118@registrar.example>",
        "Auto-Submitted": "auto-generated",
        "X-Spam-Flag": "YES",
      },
      "Your invoice 118 is ready.",
    );
    for (const id of [unspammed, notice]) await inbox.caps.transitionItem(owner, { item_id: id, event: "unspam" });
    // And what stays closed: a conversation closed, and one put in Spam.
    const closed = await ingest(
      { From: "Ana <ana@example.org>", Subject: "Thanks", "Message-ID": "<a1@example.org>" },
      "Thanks, all good.",
    );
    await inbox.caps.transitionItem(owner, { item_id: closed, event: "close" });
    const spam = await ingest(
      { From: "Win <win@prize.example>", Subject: "Prize", "Message-ID": "<p1@prize.example>", "X-Spam-Flag": "YES" },
      "Claim your prize.",
    );
    // What the release before left on each: the time it was closed, and a notice still under Notices.
    const was = T0 + 30_000;
    await client.batch([
      {
        sql: `UPDATE items SET closed_at = ? WHERE id IN (?, ?, ?)`,
        params: [was, reopened, unspammed, notice],
        method: "run",
      },
      { sql: "UPDATE items SET flags = json_remove(flags, '$.inInbox') WHERE id = ?", params: [notice], method: "run" },
    ]);
    const states = async () => {
      const { rows } = await client.query({
        sql: "SELECT id, state, closed_at FROM items ORDER BY id",
        method: "all",
      });
      return new Map(rows.map((r) => [String(r[0]), { state: String(r[1]), closed: r[2] !== null }]));
    };
    expect([...(await states()).entries()].filter(([, s]) => s.state === "open" && s.closed)).toHaveLength(3);
    const open = await inbox.caps.listItems(owner, { limit: 50, open_only: true, sandbox: false });
    for (const id of [reopened, unspammed]) expect(open.items.map((v) => v.item.id)).not.toContain(id);

    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);

    const after = await states();
    for (const id of [reopened, unspammed, notice]) expect(after.get(id), id).toEqual({ state: "open", closed: false });
    expect(after.get(closed)).toEqual({ state: "closed", closed: true });
    expect(after.get(spam)).toEqual({ state: "spam", closed: true });
    // Where the owner looks: what is open, Notices, and once moved, the inbox; Done keeps what is closed.
    const key = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
    const list = async (query: string) => {
      const res = await inbox.app.request(new Request(`${INBOX}/v1/owner/items?limit=100${query}`, { headers: key }));
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { items: { item: { id: string; closedAt: string | null } }[] }).items;
    };
    const ids = (rows: { item: { id: string } }[]) => rows.map((r) => r.item.id);
    expect(ids(await list(""))).toEqual(expect.arrayContaining([reopened, unspammed]));
    expect(ids(await list(""))).not.toContain(closed);
    expect(ids(await list("&notices=true&open_only=false"))).toContain(notice);
    const moved = await inbox.app.request(
      new Request(`${INBOX}/v1/owner/items/${notice}/move-to-inbox`, { method: "POST", headers: key }),
    );
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(ids(await list(""))).toContain(notice);
    const done = (await list("&open_only=false")).filter((r) => r.item.closedAt !== null);
    expect(ids(done)).toEqual([closed]);
  });
});
