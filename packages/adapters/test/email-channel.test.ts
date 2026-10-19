import { type Caller, createRunner, findMailToken, listForwards, readAttachment, schema } from "@surfingdog/core";
import { logMailOut, pinnedMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ingestEmail, parseMailAuth, returnedReason, spamVerdict } from "../src/email";
import { freshDb } from "./db";

/**
 * The email channel (ADR-026): every email carries its conversation's own address, customers'
 * replies land back on their item whatever their mail program keeps, the owner answers an alert by
 * email, the business's existing address is forwarded and checked, and nothing loops.
 */

const INBOUND = "oficina-mare@in.example.net";
const OWNER = "rui@personal.example";
const T = Date.parse("2026-10-19T09:00:00Z");

const mime = (h: Record<string, string>, body: string) =>
  `${Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

const owner: Caller = {
  actor: { kind: "owner", id: "user_owner", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T,
};
const agent: Caller = {
  actor: { kind: "customer_agent", id: "agent:t", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => T,
};

/** An inbox with its own address, an owner who signs in, and a runner whose mail is kept. */
async function setUp(opts: { inbound?: string | null } = {}) {
  const { db, caps } = await freshDb();
  await db.client.query({
    sql: "INSERT INTO users (id, email, role, created_at) VALUES ('user_owner', ?, 'owner', ?)",
    params: [OWNER, T],
    method: "run",
  });
  const inbound = opts.inbound === undefined ? INBOUND : opts.inbound;
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      email: { fromAddress: "hello@oficinamare.example", ...(inbound ? { inboundAddress: inbound } : {}) },
    },
  });
  const mail = logMailOut();
  caps.attachMail(mail);
  const runner = createRunner({ mailOut: mail });
  let clock = T;
  const drain = async (advance = 60_000) => {
    clock += advance;
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now: clock, limit: 50 })).claimed === 0) return;
  };
  const ingest = (headers: Record<string, string>, body: string, extra: Record<string, unknown> = {}) =>
    ingestEmail(db, caps, { raw: mime(headers, body), ...extra }, { now: () => clock });
  return { db, caps, mail, drain, ingest };
}

async function quote(caps: Awaited<ReturnType<typeof setUp>>["caps"], email = "rita@example.com") {
  const q = await caps.requestQuote(agent, {
    payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes" },
    contact: { name: "Rita Amaral", email },
  });
  return q.view.item.id;
}

describe("a conversation's own address", () => {
  it("is the Reply-To of every email to the customer, and her reply lands on the item with no headers kept", async () => {
    const { db, caps, mail, drain, ingest } = await setUp();
    const id = await quote(caps);
    await drain(10 * 60_000);
    const ack = mail.sent.find((m) => m.to.includes("rita@example.com"));
    expect(ack?.replyTo).toMatch(/^oficina-mare\+t[a-z2-7]{16}@in\.example\.net$/);
    // Every email carries this inbox's mark.
    expect(ack?.headers?.["X-Inbox-Loop"]).toMatch(/^sdi\.[0-9a-f]{20}$/);
    // It asks for a reply: one reaches the business.
    expect(ack?.text).not.toContain("do not reply");
    const token = /\+(t[a-z2-7]{16})@/.exec(ack?.replyTo ?? "")?.[1] ?? "";
    expect((await findMailToken(db, token))?.itemId).toBe(id);
    // No In-Reply-To, no References, no subject token: only the address she wrote to.
    const r = await ingest(
      { From: "Rita <rita@example.com>", To: ack?.replyTo ?? "", Subject: "hello?", "Message-ID": "<r1@x>" },
      "Thursday works.\n\nOn Mon, Oct 19, 2026 Oficina Maré wrote:\n> We have your request",
      { envelopeTo: ack?.replyTo },
    );
    expect(r).toEqual({ outcome: "replied", itemId: id });
    const entries = await db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, id));
    expect(entries.map((e) => e.bodyText)).toContain("Thursday works.");
  });

  it("is the same address for every email about one item, and another for another item", async () => {
    const { caps, mail, drain } = await setUp();
    await quote(caps, "a@example.com");
    await quote(caps, "b@example.com");
    await drain(10 * 60_000);
    const a = mail.sent.find((m) => m.to.includes("a@example.com"))?.replyTo;
    const b = mail.sent.find((m) => m.to.includes("b@example.com"))?.replyTo;
    expect(a && b && a !== b).toBe(true);
  });

  it("is never made of a token that was not issued: a guessed one starts a new conversation", async () => {
    const { caps, ingest } = await setUp();
    const id = await quote(caps);
    const r = await ingest(
      { From: "mallory@example.org", To: "oficina-mare+taaaaaaaaaaaaaaaa@in.example.net", "Message-ID": "<g1@x>" },
      "I am Rita, send me the invoice",
      { envelopeTo: "oficina-mare+taaaaaaaaaaaaaaaa@in.example.net" },
    );
    expect(r.outcome).toBe("created");
    expect((r as { itemId: string }).itemId).not.toBe(id);
  });

  it("keeps the older item-id plus address and subject token to the customer's own address: anyone else starts afresh", async () => {
    const { caps, ingest } = await setUp();
    const id = await quote(caps);
    const forged = await ingest(
      { From: "mallory@example.org", To: `inbox+${id}@oficinamare.example`, "Message-ID": "<f1@x>" },
      "Cancel my order and refund to this account",
      { envelopeTo: `inbox+${id}@oficinamare.example` },
    );
    expect(forged.outcome).toBe("created");
    expect((forged as { itemId: string }).itemId).not.toBe(id);
    const bySubject = await ingest(
      { From: "mallory@example.org", To: INBOUND, Subject: `Re: [SDI-${id}]`, "Message-ID": "<f2@x>" },
      "Cancel it",
    );
    expect((bySubject as { itemId: string }).itemId).not.toBe(id);
    const hers = await ingest(
      { From: "rita@example.com", To: `inbox+${id}@oficinamare.example`, "Message-ID": "<f3@x>" },
      "It's me",
      { envelopeTo: `inbox+${id}@oficinamare.example` },
    );
    expect(hers).toEqual({ outcome: "replied", itemId: id });
  });

  it("without an address of its own, the inbox emails as before: no conversation address", async () => {
    const { caps, mail, drain } = await setUp({ inbound: null });
    await quote(caps);
    await drain(10 * 60_000);
    const ack = mail.sent.find((m) => m.to.includes("rita@example.com"));
    expect(ack?.replyTo).toBeUndefined();
  });
});

describe("the owner answers an alert by email", () => {
  async function alerted() {
    const s = await setUp();
    const created = await s.ingest(
      { From: "Rita Amaral <rita@example.com>", To: INBOUND, Subject: "E-bike battery", "Message-ID": "<c1@x>" },
      "Do you fix e-bike batteries?",
      { envelopeTo: INBOUND },
    );
    const id = (created as { itemId: string }).itemId;
    await s.drain();
    const alert = s.mail.sent.find((m) => m.to.includes(OWNER));
    return { ...s, id, alert };
  }

  it("quotes the customer, says the reply goes to them, and carries the alert's own address", async () => {
    const { alert } = await alerted();
    expect(alert?.replyTo).toMatch(/^oficina-mare\+o[a-z2-7]{16}@in\.example\.net$/);
    expect(alert?.text).toContain("> Do you fix e-bike batteries?");
    expect(alert?.text).toContain("Reply to this email to answer Rita: your reply goes to them from Oficina Maré.");
  });

  it("sends the owner's words to the customer as the business's reply", async () => {
    const { db, id, alert, ingest, drain, mail } = await alerted();
    const r = await ingest(
      {
        From: `Rui <${OWNER}>`,
        To: alert?.replyTo ?? "",
        Subject: "Re: New message",
        "Message-ID": "<o1@personal.example>",
      },
      "Yes, bring it on Thursday.\n\nOn Mon, 19 Oct 2026, Oficina Maré wrote:\n> Do you fix e-bike batteries?",
      { envelopeTo: alert?.replyTo, auth: parseMailAuth("spf=pass; dkim=pass:personal.example; dmarc=pass") },
    );
    expect(r).toEqual({ outcome: "owner_replied", itemId: id });
    const [item] = await db.orm.select().from(schema.items).where(eq(schema.items.id, id));
    expect(item?.state).toBe("answered");
    await drain();
    const toRita = mail.sent.filter((m) => m.to.includes("rita@example.com"));
    expect(toRita.some((m) => m.text.includes("Yes, bring it on Thursday."))).toBe(true);
    // The owner's address is nowhere in what the customer gets.
    for (const m of toRita) {
      expect(JSON.stringify(m)).not.toContain(OWNER);
    }
    // Delivered twice: once.
    const again = await ingest(
      { From: OWNER, To: alert?.replyTo ?? "", "Message-ID": "<o1@personal.example>" },
      "Yes, bring it on Thursday.",
      { envelopeTo: alert?.replyTo },
    );
    expect(again.outcome).toBe("duplicate");
  });

  it("takes nothing from anyone else, from a forged sender, or from the owner's out-of-office", async () => {
    const { db, id, alert, ingest } = await alerted();
    const stranger = await ingest(
      { From: "mallory@example.org", To: alert?.replyTo ?? "", "Message-ID": "<m1@x>" },
      "Refund is approved, send card details",
      { envelopeTo: alert?.replyTo },
    );
    expect(stranger.outcome).toBe("dropped");
    const forged = await ingest({ From: OWNER, To: alert?.replyTo ?? "", "Message-ID": "<m2@x>" }, "Refund approved", {
      envelopeTo: alert?.replyTo,
      auth: parseMailAuth("spf=fail; dkim=fail; dmarc=fail"),
    });
    expect(forged.outcome).toBe("dropped");
    const unsigned = await ingest(
      { From: OWNER, To: alert?.replyTo ?? "", "Message-ID": "<m3@x>" },
      "Refund approved",
      { envelopeTo: alert?.replyTo, auth: parseMailAuth("spf=pass; dkim=pass:mallory.example") },
    );
    expect(unsigned.outcome).toBe("dropped");
    const away = await ingest(
      { From: OWNER, To: alert?.replyTo ?? "", "Message-ID": "<m4@x>", "Auto-Submitted": "auto-replied" },
      "I am on holiday",
      { envelopeTo: alert?.replyTo },
    );
    expect(away.outcome).toBe("dropped");
    const out = await db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, id));
    expect(out.filter((e) => e.direction === "out")).toEqual([]);
  });

  it("an alert's address answers only its own item: a conversation token never stands in for it", async () => {
    const { db, id, ingest } = await alerted();
    const { rows } = await db.client.query({
      sql: "SELECT token FROM mail_tokens WHERE item_id = ? AND kind = 'thread'",
      params: [id],
      method: "all",
    });
    // The customer's conversation address, written to by the owner, is the customer's thread: no reply goes out.
    const threadAddress = rows[0] ? `oficina-mare+${String(rows[0][0])}@in.example.net` : INBOUND;
    const r = await ingest({ From: OWNER, To: threadAddress, "Message-ID": "<w1@x>" }, "Note to self", {
      envelopeTo: threadAddress,
    });
    expect(r.outcome).not.toBe("owner_replied");
  });
});

describe("loops", () => {
  it("drops this inbox's own email when it comes back, and one that went through too many servers", async () => {
    const { caps, mail, drain, ingest } = await setUp();
    await quote(caps);
    await drain(10 * 60_000);
    const ack = mail.sent.find((m) => m.to.includes("rita@example.com"));
    const back = await ingest(
      {
        From: "hello@oficinamare.example",
        To: INBOUND,
        "Message-ID": "<loop1@x>",
        "X-Inbox-Loop": String(ack?.headers?.["X-Inbox-Loop"]),
      },
      ack?.text ?? "",
      { envelopeTo: INBOUND },
    );
    expect(back).toEqual({ outcome: "dropped", reason: "this inbox's own email came back" });
    const hops = Array.from({ length: 45 }, (_, i) => `Received: from relay${i}.example by mx${i}.example`);
    const looped = await ingest(Object.fromEntries([]), "", {
      raw: `${hops.join("\r\n")}\r\nFrom: someone@example.org\r\nTo: ${INBOUND}\r\nMessage-ID: <hop@x>\r\n\r\nhi`,
      envelopeTo: INBOUND,
    });
    expect(looped).toEqual({ outcome: "dropped", reason: "too many hops: a mail loop" });
  });

  it("never answers an out-of-office with an alert to the owner loop", async () => {
    const { ingest, drain, mail } = await setUp();
    const r = await ingest(
      { From: "someone@example.org", To: INBOUND, "Message-ID": "<oo@x>", "Auto-Submitted": "auto-replied" },
      "Away",
      { envelopeTo: INBOUND },
    );
    expect(r.outcome).toBe("dropped");
    await drain();
    expect(mail.sent).toEqual([]);
  });
});

describe("forwarding the business's existing address", () => {
  it("shows Gmail's confirmation on the forward waiting for it, and acts on nothing", async () => {
    const { db, caps, ingest } = await setUp();
    await caps.email.addForward(owner, { address: "Support@OficinaMare.example", provider: "google_workspace" });
    const r = await ingest(
      {
        From: "Gmail Team <forwarding-noreply@google.com>",
        To: INBOUND,
        Subject: "(#712045390) Gmail Forwarding Confirmation - Receive Mail from support@oficinamare.example",
        "Message-ID": "<gc1@google.com>",
      },
      [
        `support@oficinamare.example has requested to automatically forward mail to your email address ${INBOUND}.`,
        "Confirmation code: 712045390",
        "To allow support@oficinamare.example to automatically forward mail to your address, please click the link below to confirm the request:",
        "https://mail-settings.google.com/mail/vf-%5BANGjdJ8%5D-abc123",
        "If you click the link and it appears to be broken, please copy and paste it into a new browser window.",
        "http://phish.example/steal",
      ].join("\n"),
      { envelopeTo: INBOUND },
    );
    expect(r.outcome).toBe("forwarding");
    const [f] = await listForwards(db);
    expect(f).toMatchObject({ address: "support@oficinamare.example", state: "confirm" });
    expect(f?.confirmation).toMatchObject({
      from: "forwarding-noreply@google.com",
      code: "712045390",
      url: "https://mail-settings.google.com/mail/vf-%5BANGjdJ8%5D-abc123",
    });
    // No item: a confirmation is not a customer.
    expect((await db.orm.select().from(schema.items)).length).toBe(0);
  });

  it("puts no link in front of the owner when no forward is waiting for one", async () => {
    const { db, ingest } = await setUp();
    const r = await ingest(
      {
        From: "security@paypa1.example",
        To: INBOUND,
        Subject: "Confirm your forwarding",
        "Message-ID": "<ph1@x>",
      },
      "Verify forwarding now: code 123456 https://paypa1.example/login",
      { envelopeTo: INBOUND },
    );
    // An email like any other: the owner reads it as a message, not as a confirmation from their provider.
    expect(r.outcome).toBe("created");
    expect(await listForwards(db)).toEqual([]);
  });

  it("checks the forward live: the check goes to the plus address, comes back, and plus addresses then carry conversations", async () => {
    const { db, caps, mail, drain, ingest } = await setUp();
    const f = await caps.email.addForward(owner, { address: "support@oficinamare.example", provider: "gmail" });
    await caps.email.checkForward(owner, f.id);
    await drain(1_000);
    const check = mail.sent.find((m) => m.to[0]?.startsWith("support+c"));
    expect(check?.to[0]).toMatch(/^support\+c[a-z2-7]{16}@oficinamare\.example$/);
    expect(check?.subject).toMatch(/^Forwarding check c[a-z2-7]{16}$/);
    // The provider forwards it, headers and all, to the inbox's own address.
    const back = await ingest(
      {
        From: String(check?.from.address),
        To: check?.to[0] ?? "",
        Subject: check?.subject ?? "",
        "Message-ID": "<chk@x>",
        "X-Inbox-Loop": String(check?.headers?.["X-Inbox-Loop"]),
        "X-Inbox-Check": String(check?.headers?.["X-Inbox-Check"]),
      },
      check?.text ?? "",
      { envelopeTo: INBOUND },
    );
    expect(back).toEqual({ outcome: "forwarding", forwardId: f.id, what: "check" });
    const [now] = await listForwards(db);
    expect(now).toMatchObject({ state: "working", plusOk: true });
    // From now on a customer's conversation address is the business's own.
    await quote(caps);
    await drain(10 * 60_000);
    const ack = mail.sent.find((m) => m.to.includes("rita@example.com"));
    expect(ack?.replyTo).toMatch(/^support\+t[a-z2-7]{16}@oficinamare\.example$/);
    // And the customer's reply to it, forwarded by the business's provider, finds the item.
    const reply = await ingest({ From: "rita@example.com", To: ack?.replyTo ?? "", "Message-ID": "<rr@x>" }, "Thanks", {
      envelopeTo: INBOUND,
    });
    expect(reply.outcome).toBe("replied");
  });

  it("tries the address itself when the plus address does not come back, then says not yet", async () => {
    const { db, caps, mail, drain } = await setUp();
    const f = await caps.email.addForward(owner, { address: "info@oficinamare.example", provider: "ionos" });
    await caps.email.checkForward(owner, f.id);
    await drain(1_000);
    await drain(4 * 60_000);
    await drain(1_000);
    const plain = mail.sent.find((m) => m.to[0] === "info@oficinamare.example");
    expect(plain?.headers?.["X-Inbox-Check"]).toMatch(/^c[a-z2-7]{16}$/);
    await drain(4 * 60_000);
    const [after] = await listForwards(db);
    expect(after?.state).toBe("not_yet");
  });

  it("refuses the inbox's own address, and is the owner's in person", async () => {
    const { caps } = await setUp();
    await expect(caps.email.addForward(owner, { address: INBOUND, provider: "other" })).rejects.toThrow(/own address/);
    const ai: Caller = { ...owner, actor: { ...owner.actor, channel: "mcp_owner" }, actsAs: "owner" };
    await expect(
      caps.email.addForward(
        { ...ai, principal: { via: "oauth", id: "c", name: "AI", scopes: ["*"], userId: "user_owner" } },
        { address: "x@oficinamare.example", provider: "other" },
      ),
    ).rejects.toThrow();
  });
});

describe("spam, attachments and returned email", () => {
  it("puts aside what arrives marked as spam, and tells nobody", async () => {
    const { db, ingest, drain, mail } = await setUp();
    const r = await ingest(
      { From: "deals@seo.example", To: INBOUND, "Message-ID": "<s1@x>", "X-Spam-Flag": "YES" },
      "Rank #1 on Google",
      { envelopeTo: INBOUND },
    );
    expect(r.outcome).toBe("spam");
    const [item] = await db.orm.select().from(schema.items);
    expect(item?.state).toBe("spam");
    await drain(10 * 60_000);
    expect(mail.sent).toEqual([]);
    expect(spamVerdict({ headers: [] }, { dmarc: "fail" })).toMatch(/DMARC/);
    expect(
      spamVerdict({ headers: [{ key: "x-spam-status", originalKey: "X-Spam-Status", value: "No, score=0" }] }),
    ).toBe(null);
  });

  it("keeps what is attached within limits, never a file that runs", async () => {
    const { db, ingest } = await setUp();
    const b = "----b";
    const pdf = btoa("%PDF-1.4 a small invoice");
    const raw = [
      `From: rita@example.com`,
      `To: ${INBOUND}`,
      `Message-ID: <att@x>`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${b}"`,
      ``,
      `--${b}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Photo of the wheel and the invoice.`,
      `--${b}`,
      `Content-Type: application/pdf; name="invoice.pdf"`,
      `Content-Disposition: attachment; filename="invoice.pdf"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      pdf,
      `--${b}`,
      `Content-Type: application/octet-stream; name="setup.exe"`,
      `Content-Disposition: attachment; filename="setup.exe"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      btoa("MZ"),
      `--${b}--`,
      ``,
    ].join("\r\n");
    const made = await ingest({}, "", { raw, envelopeTo: INBOUND });
    const id = (made as { itemId: string }).itemId;
    const [entry] = await db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, id));
    const files = entry?.attachments as { id: string; filename: string; state: string }[];
    expect(files.map((f) => [f.filename, f.state])).toEqual([
      ["invoice.pdf", "kept"],
      ["setup.exe", "refused"],
    ]);
    const kept = await readAttachment(db, files[0]?.id ?? "");
    expect(new TextDecoder().decode(kept?.bytes)).toBe("%PDF-1.4 a small invoice");
    expect(await readAttachment(db, files[1]?.id ?? "")).toBeNull();
  });

  it("marks the email a customer's server returned as not delivered, and asks for a person", async () => {
    const { db, caps, mail, drain, ingest } = await setUp();
    const id = await quote(caps);
    await drain(10 * 60_000);
    const ack = mail.sent.find((m) => m.to.includes("rita@example.com"));
    const r = await ingest(
      {
        From: "Mail Delivery System <MAILER-DAEMON@mx.example.com>",
        To: ack?.replyTo ?? "",
        Subject: "Undelivered Mail Returned to Sender",
        "Message-ID": "<dsn1@mx.example.com>",
        "Auto-Submitted": "auto-replied",
      },
      "This is the mail system at host mx.example.com.\n\nFinal-Recipient: rfc822; rita@example.com\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown",
      { envelopeTo: ack?.replyTo, envelopeFrom: "" },
    );
    expect(r).toEqual({ outcome: "noted", itemId: id });
    const rows = await db.orm.select().from(schema.outboundMail).where(eq(schema.outboundMail.itemId, id));
    expect(rows.find((m) => m.recipient === "customer")).toMatchObject({ status: "failed" });
    expect(rows.find((m) => m.recipient === "customer")?.lastError).toContain("5.1.1");
    const [item] = await db.orm.select().from(schema.items).where(eq(schema.items.id, id));
    expect((item?.flags as { needsHuman?: boolean } | null)?.needsHuman ?? item?.needsHuman).toBeTruthy();
    expect(
      returnedReason({
        headers: [{ key: "auto-submitted", originalKey: "Auto-Submitted", value: "auto-replied" }],
        from: { name: "", address: "rita@example.com" },
        attachments: [],
        text: "I am away",
      }),
    ).toBeNull();
  });
});

describe("a hosted sender", () => {
  it("keeps a conversation's address as Reply-To, and nothing else a message names", async () => {
    const inner = logMailOut();
    const pinned = pinnedMailOut(inner, {
      from: { address: "oficina-mare@mail.example.net", name: "Oficina Maré" },
      replyDomains: ["in.example.net", "oficinamare.example"],
    });
    expect(pinned.replies).toBe(true);
    const send = (replyTo: string) =>
      pinned.send({ from: { address: "x@y.example" }, to: ["rita@example.com"], subject: "s", text: "t", replyTo });
    await send("oficina-mare+tabcdefghijklmnop@in.example.net");
    await send("support+tabcdefghijklmnop@oficinamare.example");
    await send("owner@personal.example");
    await send("evil+tabcdefghijklmnop@elsewhere.example");
    expect(inner.sent.map((m) => m.replyTo)).toEqual([
      "oficina-mare+tabcdefghijklmnop@in.example.net",
      "support+tabcdefghijklmnop@oficinamare.example",
      undefined,
      undefined,
    ]);
  });
});
