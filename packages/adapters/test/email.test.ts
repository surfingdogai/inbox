import { type Caller, createRunner, schema, transitionItem } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AUTOMATIC_NOTE, ingestEmail, isAutomaticMail, isAutomaticReply, stripQuotedReply } from "../src/email";
import { freshDb } from "./db";

const mime = (h: Record<string, string>, body: string) =>
  `${Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

describe("email door", () => {
  it("turns a new email into a message item, dedupes on Message-ID, and threads the reply", async () => {
    const { db, caps } = await freshDb();
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
    const { db, caps } = await freshDb();
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

  it("keeps an out-of-office on the item it answers, and lets it answer nothing (ADR-018 N14)", async () => {
    const { db, caps } = await freshDb();
    const customer: Caller = {
      actor: { kind: "customer_agent", id: "agent:t", channel: "rest" },
      tier: "anonymous",
      sandbox: false,
    };
    const owner: Caller = {
      actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
      tier: "verified_principal",
      sandbox: false,
    };
    const q = await caps.requestQuote(customer, {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
      contact: { email: "rita@example.com" },
    });
    const id = q.view.item.id;
    await transitionItem(db, owner, { itemId: id, event: "request_info", input: { note: "How many spokes?" } });
    const state = async () =>
      (await db.orm.select({ s: schema.items.state }).from(schema.items).where(eq(schema.items.id, id)))[0]?.s;

    // Her mailbox answers by itself while she is away: kept as a note for the business, nobody is
    // told, nothing answers it, and it still waits on her.
    const jobsBefore = (await db.orm.select().from(schema.jobs)).length;
    const away = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: "hello@oficinamare.pt",
          Subject: `Automatic reply: [SDI-${id}] We need a detail`,
          "Message-ID": "<ooo1@x>",
          "Auto-Submitted": "auto-replied",
        },
        "I am away until Monday.",
      ),
    });
    expect(away).toEqual({ outcome: "noted", itemId: id });
    expect(await state()).toBe("needs_info");
    const entries = await db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, id));
    const note = entries.find((e) => e.bodyText.includes("I am away until Monday."));
    expect(note).toMatchObject({ direction: "note", actorKind: "system", messageId: "<ooo1@x>" });
    expect(note?.bodyText.startsWith(AUTOMATIC_NOTE)).toBe(true);
    expect((await db.orm.select().from(schema.jobs)).length).toBe(jobsBefore);
    // The same email delivered again is known for what it is.
    const twice = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: "hello@oficinamare.pt",
          Subject: `Automatic reply: [SDI-${id}] We need a detail`,
          "Message-ID": "<ooo1@x>",
          "Auto-Submitted": "auto-replied",
        },
        "I am away until Monday.",
      ),
    });
    expect(twice).toEqual({ outcome: "duplicate", itemId: id });

    // Her own answer moves it on.
    const answer = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: "hello@oficinamare.pt",
          Subject: `Re: [SDI-${id}] We need a detail`,
          "Message-ID": "<ans1@x>",
        },
        "28 spokes.",
      ),
    });
    expect(answer).toEqual({ outcome: "replied", itemId: id });
    expect(await state()).toBe("received");
  });

  it("never makes an item of an out-of-office or a returned email that answers none, and never answers one", async () => {
    const { db, caps } = await freshDb();
    const before = (await db.orm.select().from(schema.items)).length;
    const ooo = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: "hello@oficinamare.pt",
          Subject: "Out of office",
          "Message-ID": "<ooo2@x>",
          "Auto-Submitted": "auto-replied",
        },
        "I am away.",
      ),
    });
    expect(ooo).toEqual({ outcome: "dropped", reason: "automatic email that answers no item" });
    // A returned email: a delivery report from the mailer daemon, with an empty return path.
    const bounce = await ingestEmail(db, caps, {
      raw: [
        "From: Mail Delivery Subsystem <mailer-daemon@mail.example.com>",
        "To: hello@oficinamare.pt",
        "Subject: Undelivered Mail Returned to Sender",
        "Message-ID: <bounce1@mail.example.com>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "Your message could not be delivered.",
        "--b--",
        "",
      ].join("\r\n"),
      envelopeFrom: "",
    });
    expect(bounce.outcome).toBe("dropped");
    expect((await db.orm.select().from(schema.items)).length).toBe(before);
    expect(await db.orm.select().from(schema.jobs)).toEqual([]);
  });

  it("tells an email no person wrote from one a person did", () => {
    type Parsed = Parameters<typeof isAutomaticMail>[0];
    const from = (address: string) => ({ headers: [], from: { address, name: "" } }) as unknown as Parsed;
    const h = (key: string, value: string) =>
      ({ headers: [{ key, value }], from: { address: "rita@example.com", name: "" } }) as unknown as Parsed;
    expect(isAutomaticMail(h("x-failed-recipients", "rita@example.com"))).toBe(true);
    expect(isAutomaticMail(h("content-type", "multipart/report; report-type=delivery-status"))).toBe(true);
    expect(isAutomaticMail(h("return-path", "<>"))).toBe(true);
    expect(isAutomaticMail(from("MAILER-DAEMON@mail.example.com"))).toBe(true);
    expect(isAutomaticMail(from("postmaster@mail.example.com"))).toBe(true);
    expect(isAutomaticMail(h("subject", "Re: hello"), "<>")).toBe(true);
    expect(isAutomaticMail(h("subject", "Re: hello"), "rita@example.com")).toBe(false);
    expect(isAutomaticMail(h("content-type", "multipart/alternative"))).toBe(false);
  });

  it("lands a reply on the item our email was about, by the ids it names, and a detail moves it on", async () => {
    const { db, caps } = await freshDb();
    const T = Date.parse("2026-09-23T09:00:00Z");
    const customer: Caller = {
      actor: { kind: "customer_agent", id: "agent:t", channel: "rest" },
      tier: "anonymous",
      sandbox: false,
      now: () => T,
    };
    const owner: Caller = {
      actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
      tier: "verified_principal",
      sandbox: false,
      now: () => T,
    };
    await caps.updateSettings(owner, {
      doc: { business: { name: "Oficina Maré" }, email: { fromAddress: "hello@oficinamare.pt" } },
    });
    const mail = logMailOut();
    const runner = createRunner({ mailOut: mail });
    const drain = async () => {
      for (let i = 0; i < 10; i++) if ((await runner.runDue(db, { now: T + 60_000, limit: 50 })).claimed === 0) return;
    };
    const q = await caps.requestQuote(customer, {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel" },
      contact: { email: "rita@example.com" },
    });
    const id = q.view.item.id;
    await transitionItem(db, owner, { itemId: id, event: "request_info", input: { note: "How many spokes?" } });
    await drain();
    const asked = mail.sent.find((m) => m.to.includes("rita@example.com"));
    const anchor = asked?.headers?.References as string;
    expect(anchor).toMatch(/^<a\.[0-9a-z]{22}@oficinamare\.pt>$/);
    const state = async () =>
      (await db.orm.select({ s: schema.items.state }).from(schema.items).where(eq(schema.items.id, id)))[0]?.s;
    // No subject token, no plus address: only the References her client keeps, with others around it.
    const answer = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: "hello@oficinamare.pt",
          Subject: "Re: A question",
          "Message-ID": "<r1@mail.example.com>",
          References: `${anchor} <provider-generated-1@mail.example.net>`,
        },
        "28 spokes.",
      ),
    });
    expect(answer).toEqual({ outcome: "replied", itemId: id });
    expect(await state()).toBe("received");

    // The mail service's own id, written as a Message-ID's local part, finds it too.
    const [provider] = (
      await db.client.query({
        sql: "SELECT provider_id FROM outbound_mail WHERE item_id = ? AND recipient = 'customer'",
        params: [id],
        method: "all",
      })
    ).rows.map((r) => String(r[0]));
    const byProvider = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: "hello@oficinamare.pt",
          Subject: "Re: A question",
          "Message-ID": "<r2@mail.example.com>",
          "In-Reply-To": `<${provider}@smtp.provider.example>`,
        },
        "And a new rim, please.",
      ),
    });
    expect(byProvider).toEqual({ outcome: "replied", itemId: id });
    // Her own earlier email, named by a later one of hers.
    const byHers = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: "hello@oficinamare.pt",
          Subject: "Also",
          "Message-ID": "<r3@mail.example.com>",
          "In-Reply-To": "<r1@mail.example.com>",
        },
        "Black, if you have it.",
      ),
    });
    expect(byHers).toEqual({ outcome: "replied", itemId: id });

    // Free text never accepts: a reply to a quote stays a message on it.
    await transitionItem(db, owner, {
      itemId: id,
      event: "quote",
      input: {
        totalPrice: { value: 12000, currency: "EUR" },
        validThrough: "2026-09-28T18:00:00Z",
        lines: [{ name: "Rebuild", quantity: 1, price: { value: 12000, currency: "EUR" } }],
      },
    });
    const yes = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "rita@example.com",
          To: "hello@oficinamare.pt",
          Subject: "Re: Our quote",
          "Message-ID": "<r4@mail.example.com>",
          References: anchor,
        },
        "Yes, go ahead.",
      ),
    });
    expect(yes).toEqual({ outcome: "replied", itemId: id });
    expect(await state()).toBe("quoted");
    const bodies = (await db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, id))).map(
      (e) => e.bodyText,
    );
    expect(bodies).toEqual(
      expect.arrayContaining(["28 spokes.", "And a new rim, please.", "Black, if you have it.", "Yes, go ahead."]),
    );
    // An id nobody knows threads nothing: a new conversation.
    const stranger = await ingestEmail(db, caps, {
      raw: mime(
        {
          From: "joe@example.com",
          To: "hello@oficinamare.pt",
          Subject: "Hi",
          "Message-ID": "<j1@mail.example.com>",
          "In-Reply-To": "<a.zzzzzzzzzzzzzzzzzzzzzz@oficinamare.pt>",
        },
        "Hello",
      ),
    });
    expect(stranger.outcome).toBe("created");
  });

  it("knows an automatic reply by its headers", () => {
    const h = (key: string, value: string) => ({ headers: [{ key, originalKey: key, value }] });
    expect(isAutomaticReply(h("auto-submitted", "auto-replied"))).toBe(true);
    expect(isAutomaticReply(h("auto-submitted", "auto-generated"))).toBe(true);
    expect(isAutomaticReply(h("auto-submitted", "no"))).toBe(false);
    expect(isAutomaticReply(h("x-autoreply", "yes"))).toBe(true);
    expect(isAutomaticReply(h("precedence", "auto_reply"))).toBe(true);
    expect(isAutomaticReply(h("precedence", "bulk"))).toBe(true);
    expect(isAutomaticReply(h("subject", "Re: hello"))).toBe(false);
    expect(isAutomaticReply({ headers: [] })).toBe(false);
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
