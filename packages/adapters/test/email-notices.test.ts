import { type Caller, createRunner, LINKS_HEADING, schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AUTOMATIC_NOTICE, type IngestResult, ingestEmail, noticeBucket, OWN_NOTE } from "../src/email";
import { consume } from "../src/limits";
import { freshDb } from "./db";

/**
 * Nothing that arrives is thrown away (the founder, 1 November 2026: "don't throw any e-mail away, we keep
 * everything"). An email from a system that answers no conversation — D&B's resolved inquiry, an AWS case
 * reply, a newsletter, an out-of-office, a returned email, this inbox's own email come back — is kept as a
 * notice: the owner's alone, alerting nobody, answered by nothing, not even by a rule that answers every
 * message. Past a day's worth from one domain, one is still kept, with the least work.
 */

const INBOUND = "oficina-mare@in.example.net";
const OWNER = "rui@personal.example";
const T = Date.parse("2026-11-01T09:00:00Z");

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

/** An inbox with its own address, an owner who signs in, and a rule that answers every new message. */
async function setUp() {
  const { db, caps } = await freshDb();
  await db.client.query({
    sql: "INSERT INTO users (id, email, role, created_at) VALUES ('user_owner', ?, 'owner', ?)",
    params: [OWNER, T],
    method: "run",
  });
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      email: { fromAddress: "hello@oficinamare.example", inboundAddress: INBOUND },
    },
  });
  await db.orm.insert(schema.rules).values({
    id: ulid(),
    name: "Answer every message",
    priority: 5,
    enabled: 1,
    definition: {
      on: ["item.created", "item.updated"],
      if: { path: "item.type", op: "eq", value: "message" },
      actions: [{ action: "reply", template: "Thanks, we read every message within a day." }],
      stop: false,
      maxRunsPerItem: 5,
    },
    createdAt: T,
    updatedAt: T,
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
    ingestEmail(db, caps, { raw: mime(headers, body), envelopeTo: INBOUND, ...extra }, { now: () => clock });
  const item = async (id: string) => {
    const [row] = await db.orm.select().from(schema.items).where(eq(schema.items.id, id));
    return row;
  };
  const entries = (id: string) => db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, id));
  /** The jobs an item started: none of them an alert, a rule or a webhook, for a notice. */
  const jobsFor = async (id: string) =>
    (
      await db.client.query({
        sql: "SELECT kind FROM jobs WHERE json_extract(payload, '$.itemId') = ?",
        params: [id],
        method: "all",
      })
    ).rows.map((r) => String(r[0]));
  return { db, caps, mail, drain, ingest, item, entries, jobsFor, at: () => clock };
}

const idOf = (r: IngestResult): string => {
  if (!("itemId" in r) || !r.itemId) throw new Error(`no item: ${JSON.stringify(r)}`);
  return r.itemId;
};

/** A notice, as kept: a message, the owner's alone, open, with nothing started for it. */
async function expectNotice(s: Awaited<ReturnType<typeof setUp>>, r: IngestResult) {
  expect(r.outcome).toBe("notice");
  const id = idOf(r);
  const row = await s.item(id);
  expect(row?.type).toBe("message");
  expect(row?.state).toBe("open");
  expect(row?.flags).toMatchObject({ notice: true });
  expect(await s.jobsFor(id)).toEqual([]);
  return id;
}

describe("an email from a system that answers no conversation", () => {
  it("is kept as a notice, D&B's and AWS's alike: the owner's alone, alerting nobody, answered by nothing", async () => {
    const s = await setUp();
    const dnb = await s.ingest(
      {
        From: "D&B <donotreply@iresearch.dnb.com>",
        To: "support@oficinamare.example",
        Subject: "Resolved Inquiry # 11086202 (Case # 11144730)",
        "Message-ID": "<case11144730@iresearch.dnb.com>",
        "Auto-Submitted": "auto-generated",
      },
      "Your inquiry is resolved. Your D-U-N-S Number is 123456789. Details: https://iresearch.dnb.com/case/11144730",
    );
    const dnbId = await expectNotice(s, dnb);
    const aws = await s.ingest(
      {
        From: "Amazon Web Services <no-reply-aws@amazon.com>",
        To: "support@oficinamare.example",
        Subject: "[Case 177001234500] New correspondence added",
        "Message-ID": "<case177001234500.1@email.amazonses.com>",
      },
      "Dear customer, we have updated your case. https://console.aws.amazon.com/support/home#/case/?displayId=177001234500",
    );
    const awsId = await expectNotice(s, aws);
    // What it says is kept whole, its links under its words, for the owner to read.
    const [said] = await s.entries(dnbId);
    expect(said?.bodyText).toContain("Your D-U-N-S Number is 123456789.");
    expect(said?.bodyText).toContain(LINKS_HEADING);
    expect(said?.messageId).toBe("<case11144730@iresearch.dnb.com>");
    expect((await s.item(awsId))?.subject).toBe("[Case 177001234500] New correspondence added");
    // The same email delivered again is the one kept.
    const again = await s.ingest(
      {
        From: "D&B <donotreply@iresearch.dnb.com>",
        To: "support@oficinamare.example",
        Subject: "Resolved Inquiry # 11086202 (Case # 11144730)",
        "Message-ID": "<case11144730@iresearch.dnb.com>",
        "Auto-Submitted": "auto-generated",
      },
      "Your inquiry is resolved.",
    );
    expect(again).toEqual({ outcome: "duplicate", itemId: dnbId });
    await s.drain(10 * 60_000);
    // No alert to the owner, and the rule that answers every message answered neither.
    expect(s.mail.sent).toEqual([]);
    for (const id of [dnbId, awsId]) expect((await s.entries(id)).map((e) => e.direction)).toEqual(["in"]);
  });

  it("is a notice when it is a newsletter", async () => {
    const s = await setUp();
    const news = await s.ingest(
      {
        From: "Shop News <news@supplier.example>",
        To: "support@oficinamare.example",
        Subject: "October offers",
        "Message-ID": "<n1@supplier.example>",
        "List-Unsubscribe": "<https://supplier.example/u>",
      },
      "Big sale this week.",
    );
    expect(news).toMatchObject({ reason: "a mailing or a notice that answers no conversation" });
    await expectNotice(s, news);
    await s.drain();
    expect(s.mail.sent).toEqual([]);
  });

  it("is a notice when it is an out-of-office or a returned email answering nothing, and neither is ever answered", async () => {
    const s = await setUp();
    const away = await s.ingest(
      {
        From: "Rita <rita@example.com>",
        To: "support@oficinamare.example",
        Subject: "Out of office",
        "Message-ID": "<ooo@example.com>",
        "Auto-Submitted": "auto-replied",
      },
      "I am away until Monday.",
    );
    const awayId = await expectNotice(s, away);
    expect((await s.entries(awayId))[0]?.bodyText.startsWith(AUTOMATIC_NOTICE)).toBe(true);
    const bounce = await ingestEmail(
      s.db,
      s.caps,
      {
        raw: [
          "From: Mail Delivery Subsystem <mailer-daemon@mail.example.com>",
          `To: ${INBOUND}`,
          "Subject: Undelivered Mail Returned to Sender",
          "Message-ID: <bounce@mail.example.com>",
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
        envelopeTo: INBOUND,
      },
      { now: s.at },
    );
    await expectNotice(s, bounce);
    await s.drain(10 * 60_000);
    expect(s.mail.sent).toEqual([]);
    expect((await s.entries(awayId)).map((e) => e.direction)).toEqual(["in"]);
  });

  it("is a notice when it is this inbox's own email come back, and it is never answered", async () => {
    const s = await setUp();
    await s.caps.requestQuote(agent, {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes" },
      contact: { name: "Rita Amaral", email: "rita@example.com" },
    });
    await s.drain(10 * 60_000);
    const ack = s.mail.sent.find((m) => m.to.includes("rita@example.com"));
    expect(ack?.headers?.["X-Inbox-Loop"]).toBeTruthy();
    const sent = s.mail.sent.length;
    const back = await s.ingest(
      {
        From: "hello@oficinamare.example",
        To: INBOUND,
        Subject: ack?.subject ?? "",
        "Message-ID": "<loop@x>",
        "X-Inbox-Loop": String(ack?.headers?.["X-Inbox-Loop"]),
      },
      ack?.text ?? "",
    );
    expect(back).toMatchObject({ reason: "this inbox's own email came back" });
    const id = await expectNotice(s, back);
    expect((await s.entries(id))[0]?.bodyText.startsWith(OWN_NOTE)).toBe(true);
    await s.drain(10 * 60_000);
    expect(s.mail.sent.length).toBe(sent);
  });

  it("is kept when it names no sender at all", async () => {
    const s = await setUp();
    const r = await ingestEmail(
      s.db,
      s.caps,
      { raw: mime({ To: INBOUND, Subject: "x", "Message-ID": "<nobody@x>" }, "y") },
      { now: s.at },
    );
    expect(r).toMatchObject({ reason: "an email with no sender" });
    await expectNotice(s, r);
  });
});

describe("a conversation", () => {
  it("takes a reply on it as before, and a system's later email threads onto its notice, silently", async () => {
    const s = await setUp();
    const q = await s.caps.requestQuote(agent, {
      payload: { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes" },
      contact: { name: "Rita Amaral", email: "rita@example.com" },
    });
    await s.drain(10 * 60_000);
    const ack = s.mail.sent.find((m) => m.to.includes("rita@example.com"));
    const reply = await s.ingest(
      { From: "Rita <rita@example.com>", To: ack?.replyTo ?? "", Subject: "Re: your quote", "Message-ID": "<r1@x>" },
      "Thursday works.",
      { envelopeTo: ack?.replyTo },
    );
    expect(reply).toEqual({ outcome: "replied", itemId: q.view.item.id });
    await s.drain(10 * 60_000);
    const sent = s.mail.sent.length;

    // AWS answers its own case: the second email names the first, and lands on its notice.
    const first = await s.ingest(
      {
        From: "Amazon Web Services <no-reply-aws@amazon.com>",
        To: "support@oficinamare.example",
        Subject: "[Case 1] New correspondence added",
        "Message-ID": "<case1.1@amazonses.com>",
      },
      "We are looking into it.",
    );
    const id = await expectNotice(s, first);
    const second = await s.ingest(
      {
        From: "Amazon Web Services <no-reply-aws@amazon.com>",
        To: "support@oficinamare.example",
        Subject: "Re: [Case 1] New correspondence added",
        "Message-ID": "<case1.2@amazonses.com>",
        "In-Reply-To": "<case1.1@amazonses.com>",
      },
      "Your case is resolved.",
    );
    expect(second).toEqual({ outcome: "replied", itemId: id });
    await s.drain(10 * 60_000);
    // Neither an alert nor the rule's answer.
    expect(s.mail.sent.length).toBe(sent);
    expect((await s.entries(id)).map((e) => e.direction)).toEqual(["in", "in"]);
  });
});

describe("a flood of notices from one domain", () => {
  it("is kept, every one, past a day's worth: unscreened, found by the ids it names only, and counted", async () => {
    const s = await setUp();
    const usual = await s.ingest(
      { From: "no-reply-1@flood.example", To: INBOUND, Subject: "Notice 1", "Message-ID": "<f1@flood.example>" },
      "Your report is ready.",
    );
    const usualId = await expectNotice(s, usual);
    // The rest of the day's two hundred, spent.
    const bucket = await noticeBucket("anyone@flood.example");
    for (let i = 0; i < 200; i++) await consume(s.db, "notices", bucket, s.at());
    const past = await s.ingest(
      { From: "no-reply-2@flood.example", To: INBOUND, Subject: "Notice 202", "Message-ID": "<f202@flood.example>" },
      "Your report is ready. https://flood.example/report",
    );
    const pastId = await expectNotice(s, past);
    expect(pastId).not.toBe(usualId);
    expect((await s.entries(pastId))[0]?.bodyText).not.toContain(LINKS_HEADING);
    const verdicts = async (id: string) =>
      (await s.db.client.query({ sql: "SELECT 1 FROM spam_verdicts WHERE item_id = ?", params: [id], method: "all" }))
        .rows.length;
    expect(await verdicts(usualId)).toBe(1);
    expect(await verdicts(pastId)).toBe(0);
    const { rows } = await s.db.client.query({
      sql: "SELECT n FROM spam_days WHERE key = 'notice_flood'",
      params: [],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(1);
    // Another domain is counted on its own.
    await expectNotice(
      s,
      await s.ingest(
        { From: "no-reply@other.example", To: INBOUND, Subject: "Hello", "Message-ID": "<o1@other.example>" },
        "A receipt. https://other.example/r",
      ),
    );
  });
});
