import { Capabilities, createDb, MIGRATIONS, schema } from "@surfingdog/core";
import { runMigrations, type SqliteClient } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ingestEmail, stripQuotedReply } from "../src/email";

async function makeClient(): Promise<SqliteClient> {
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    const spec = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ spec)) as { env: { DB: unknown } };
    const { d1Client } = await import("@surfingdog/platform/cloudflare");
    return d1Client(env.DB as Parameters<typeof d1Client>[0]);
  }
  const { nodeSqliteClient } = await import("@surfingdog/platform/node");
  return nodeSqliteClient(":memory:");
}

async function setup() {
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
  return { db, caps: new Capabilities(db) };
}

const mime = (h: Record<string, string>, body: string) =>
  `${Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

describe("email door", () => {
  it("turns a new email into a message item, dedupes on Message-ID, and threads the reply", async () => {
    const { db, caps } = await setup();
    const first = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "Tomás Pereira <tomas@example.com>",
          To: "hello@oficinamare.pt",
          Subject: "E-bike battery",
          "Message-ID": "<a1@example.com>",
        },
        "Do you fix e-bike batteries?\n\n-- \nTomás",
      ),
    });
    expect(first.outcome).toBe("created");
    const itemId = (first as { itemId: string }).itemId;
    const [item] = await db.orm.select().from(schema.items).where(eq(schema.items.id, itemId));
    expect(item).toMatchObject({ type: "message", state: "open", channel: "email", subject: "E-bike battery" });
    const [party] = await db.orm
      .select()
      .from(schema.parties)
      .where(eq(schema.parties.id, item?.partyId ?? ""));
    expect(party?.displayName).toBe("Tomás Pereira");
    expect((party?.contact as { email?: string } | undefined)?.email).toBe("tomas@example.com");
    const entries = await db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, itemId));
    expect(entries.map((e) => [e.direction, e.bodyText, e.messageId])).toEqual([
      ["in", "Do you fix e-bike batteries?", "<a1@example.com>"],
    ]);

    const again = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "tomas@example.com",
          To: "hello@oficinamare.pt",
          Subject: "E-bike battery",
          "Message-ID": "<a1@example.com>",
        },
        "Do you fix e-bike batteries?",
      ),
    });
    expect(again).toEqual({ outcome: "duplicate", itemId });

    const reply = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "tomas@example.com",
          To: "hello@oficinamare.pt",
          Subject: "Re: E-bike battery",
          "Message-ID": "<a2@example.com>",
          "In-Reply-To": "<a1@example.com>",
        },
        "Great, Thursday then.\n\nOn Mon, Sep 21, 2026 at 10:00 Oficina Maré <hello@oficinamare.pt> wrote:\n> Yes we do, bring it in.",
      ),
    });
    expect(reply).toEqual({ outcome: "replied", itemId });
    const after = await db.orm
      .select()
      .from(schema.threadEntries)
      .where(eq(schema.threadEntries.itemId, itemId))
      .orderBy(schema.threadEntries.createdAt, schema.threadEntries.id);
    expect(after.map((e) => e.bodyText)).toEqual(["Do you fix e-bike batteries?", "Great, Thursday then."]);
  });

  it("routes by plus address and subject token, and rejects mail without a sender", async () => {
    const { db, caps } = await setup();
    const first = await ingestEmail(db, caps, {
      raw: mime(
        { From: "rita@example.com", To: "hello@oficinamare.pt", Subject: "Hello", "Message-ID": "<b1@x>" },
        "First",
      ),
    });
    const itemId = (first as { itemId: string }).itemId;
    const viaPlus = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: `inbox+${itemId}@oficinamare.pt`,
          Subject: "Hello again",
          "Message-ID": "<b2@x>",
        },
        "Second",
      ),
      envelopeTo: `inbox+${itemId}@oficinamare.pt`,
    });
    expect(viaPlus).toEqual({ outcome: "replied", itemId });
    const viaToken = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: "hello@oficinamare.pt",
          Subject: `Re: [SDI-${itemId}] Hello`,
          "Message-ID": "<b3@x>",
        },
        "Third",
      ),
    });
    expect(viaToken).toEqual({ outcome: "replied", itemId });
    const noSender = await ingestEmail(db, caps, { raw: mime({ To: "hello@oficinamare.pt", Subject: "x" }, "y") });
    expect(noSender.outcome).toBe("rejected");
  });

  it("strips quoted history and signatures", () => {
    expect(stripQuotedReply("Yes please.\n\nOn Mon, Sep 21, 2026, Rita wrote:\n> Can we?\n> Thanks")).toBe(
      "Yes please.",
    );
    expect(stripQuotedReply("Sim, obrigado.\n\nEm seg., 21 de set. de 2026, Rita escreveu:\n> Podemos?")).toBe(
      "Sim, obrigado.",
    );
    expect(stripQuotedReply("Fine.\n-- \nTomás\n+351 900 000 000")).toBe("Fine.");
  });
});
