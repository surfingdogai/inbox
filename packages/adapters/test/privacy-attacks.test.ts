import type { Caller } from "@surfingdog/core";
import type { SqlInput } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { ingestEmail } from "../src/email";
import { freshDb } from "./db";

/**
 * Attacks on one customer's erasure through the email door (Tiago, 23 September 2026): a customer
 * who wrote by email is named by their address in more places than the one they typed it in.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "session", id: "s1", name: "owner", scopes: ["*"], userId: "u1" },
});

const mime = (h: Record<string, string>, body: string) =>
  `${Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

async function everything(db: Awaited<ReturnType<typeof freshDb>>["db"]): Promise<Record<string, string>> {
  const q = async (sql: string, params: SqlInput[] = []) =>
    (await db.client.query({ sql, params, method: "all" })).rows.map((r) => [...r]);
  const tables = (
    await q(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'search_fts_%'",
    )
  ).map((r) => String(r[0]));
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = JSON.stringify(await q(`SELECT * FROM "${t}"`));
  // The search index's own pages too: a word deleted from it stays in its older segments until merged.
  const blocks = await q("SELECT block FROM search_fts_data");
  out.search_fts_data = blocks
    .map((r) => (r[0] instanceof Uint8Array || r[0] instanceof ArrayBuffer ? latin1(r[0]) : String(r[0])))
    .join("|");
  return out;
}

function latin1(v: Uint8Array | ArrayBuffer): string {
  const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

describe("erasing a customer who wrote by email", () => {
  it("leaves their address nowhere: not in who wrote each event and entry, nor in a stored answer's scope", async () => {
    const { db, caps } = await freshDb();
    const first = await ingestEmail(
      db,
      caps,
      {
        raw: mime(
          {
            From: "Rita Carvalho <rita.carvalho@example.com>",
            To: "hello@oficinamare.pt",
            Subject: "My helmet",
            "Message-ID": "<r1@example.com>",
          },
          "Did I leave my helmet there?",
        ),
      },
      { now: () => T0 },
    );
    expect(first.outcome).toBe("created");
    const itemId = (first as { itemId: string }).itemId;
    const again = await ingestEmail(
      db,
      caps,
      {
        raw: mime(
          {
            From: "rita.carvalho@example.com",
            To: "hello@oficinamare.pt",
            Subject: "Re: My helmet",
            "Message-ID": "<r2@example.com>",
            "In-Reply-To": "<r1@example.com>",
          },
          "It is a blue one.",
        ),
      },
      { now: () => T0 + 60_000 },
    );
    expect(again).toEqual({ outcome: "replied", itemId });
    const party = String(
      (await db.client.query({ sql: "SELECT party_id FROM items WHERE id = ?", params: [itemId], method: "all" }))
        .rows[0]?.[0],
    );
    const asked = await caps.customers.erase(owner(), { party_id: party }).catch((e) => e);
    await caps.customers.erase(owner(), { party_id: party, confirm: asked.details.confirm });
    for (const [table, text] of Object.entries(await everything(db))) {
      expect(text.toLowerCase(), `her address in ${table}`).not.toContain("rita.carvalho@example.com");
      expect(text.toLowerCase(), `her name in ${table}`).not.toContain("rita carvalho");
      expect(text.toLowerCase(), `her words in ${table}`).not.toContain("helmet");
    }
  });
});

describe("a customer who writes again after being erased", () => {
  it("starts a new conversation the business can answer; an out-of-office to an old email is dropped", async () => {
    const { db, caps } = await freshDb();
    const first = await ingestEmail(
      db,
      caps,
      {
        raw: mime(
          {
            From: "Rita Carvalho <rita.carvalho@example.com>",
            To: "hello@oficinamare.pt",
            Subject: "My helmet",
            "Message-ID": "<e1@example.com>",
          },
          "Did I leave my helmet there?",
        ),
      },
      { now: () => T0 },
    );
    const itemId = (first as { itemId: string }).itemId;
    const q = async (sql: string, params: SqlInput[] = []) =>
      (await db.client.query({ sql, params, method: "all" })).rows.map((r) => [...r]);
    const party = String((await q("SELECT party_id FROM items WHERE id = ?", [itemId]))[0]?.[0]);
    const asked = await caps.customers.erase(owner(), { party_id: party }).catch((e) => e);
    await caps.customers.erase(owner(), { party_id: party, confirm: asked.details.confirm });
    const entries = async () => (await q("SELECT COUNT(*) FROM thread_entries WHERE item_id = ?", [itemId]))[0]?.[0];
    const before = await entries();

    // Her mailbox answers an old email of ours by itself: nothing of it is kept on the erased item.
    const away = await ingestEmail(
      db,
      caps,
      {
        raw: mime(
          {
            From: "Rita Carvalho <rita.carvalho@example.com>",
            To: "hello@oficinamare.pt",
            Subject: `Automatic reply: [SDI-${itemId}]`,
            "Message-ID": "<e2@example.com>",
            "Auto-Submitted": "auto-replied",
          },
          "I am away until Monday. Rita Carvalho, Rua das Flores 12.",
        ),
      },
      { now: () => T0 + 60 * 60_000 },
    );
    expect(away.outcome).toBe("dropped");
    // She writes to it herself: a new item, from her, that the business can answer by email.
    const again = await ingestEmail(
      db,
      caps,
      {
        raw: mime(
          {
            From: "Rita Carvalho <rita.carvalho@example.com>",
            To: "hello@oficinamare.pt",
            Subject: `Re: [SDI-${itemId}] My helmet`,
            "Message-ID": "<e3@example.com>",
          },
          "Hello again, I found it.",
        ),
      },
      { now: () => T0 + 2 * 60 * 60_000 },
    );
    expect(again.outcome).toBe("created");
    expect((again as { itemId: string }).itemId).not.toBe(itemId);
    expect(await entries()).toBe(before);
    const detail = await caps.getItem(owner(), { item_id: (again as { itemId: string }).itemId });
    expect(detail.party).toMatchObject({ email: "rita.carvalho@example.com" });
  });
});
