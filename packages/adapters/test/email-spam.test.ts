import { type Caller, schema } from "@surfingdog/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ingestEmail } from "../src/email";
import { freshDb } from "./db";

/**
 * The email door and the spam filter (ADR-029 §4.3, §5): what a server the email passed through said
 * of it, what the receiving server found of its sender, a display name that names someone else, the
 * business's own name used from outside, a look-alike of its domain, answers that would go elsewhere.
 * A sender the business knows is only ever labelled; a reply on a thread is never screened; and what
 * is put aside keeps its files shut. Runs on Node and in workerd.
 */

const T0 = Date.parse("2026-10-26T09:00:00Z");
const INBOUND = "hei@fjordkaffe.example";
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup() {
  const { db, caps } = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Fjord Kaffe",
    domain: "fjordkaffe.example",
    timezone: "Europe/Oslo",
    currency: "NOK",
    languages: ["nb", "en"],
    createdAt: T0,
    updatedAt: T0,
  });
  let n = 0;
  const ingest = (
    headers: Record<string, string>,
    body: string,
    more: { auth?: { dmarc?: string; dkim?: string[] }; authenticated?: boolean; parts?: string } = {},
  ) => {
    n++;
    const head = { To: INBOUND, "Message-ID": `<m${n}@mail.example>`, ...headers };
    const raw = more.parts
      ? `${Object.entries(head)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\nMIME-Version: 1.0\r\n${more.parts.replace("{BODY}", body)}`
      : `${Object.entries(head)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
    return ingestEmail(
      db,
      caps,
      {
        raw,
        envelopeTo: INBOUND,
        ...(more.auth ? { auth: more.auth } : {}),
        ...(more.authenticated ? { authenticated: true } : {}),
      },
      { now: () => T0 + n * 1_000 },
    );
  };
  const verdictOf = async (id: string) => {
    const { rows } = await db.client.query({
      sql: "SELECT i.state, i.screen, v.verdict, v.cause, v.signals FROM items i LEFT JOIN spam_verdicts v ON v.item_id = i.id WHERE i.id = ?",
      params: [id],
      method: "all",
    });
    const r = rows[0] ?? [];
    return {
      state: r[0],
      screen: r[1],
      verdict: r[2] ?? null,
      cause: r[3] ?? null,
      signals: r[4] ? (JSON.parse(String(r[4])) as { c: string }[]).map((s) => s.c) : [],
    };
  };
  return { db, caps, ingest, verdictOf };
}

const idOf = (r: unknown) => (r as { itemId: string }).itemId;
/** Each customer's own words: the same words from several senders is a wave, which is not under test here. */
const ASKS = [
  "Hei! Do you still sell the Ethiopian beans in 1 kg bags, and could I pick some up on Friday afternoon?",
  "Hello, is the café open on the public holiday next Monday? We are a group of six.",
  "Could you grind 500 g of the house blend for a moka pot? I'll come by after work.",
  "Do you deliver to offices in the city centre? We'd like a monthly order for about twenty people.",
  "My espresso machine needs descaling, do you sell the tablets or only the liquid?",
  "Is there oat milk for the flat whites? My daughter can't have dairy.",
  "I left my scarf at the corner table yesterday, a green wool one. Did anyone find it?",
  "Can I book the back room for a small birthday on the 14th, around 3 pm?",
  "Do you have decaf beans that are not too dark? Something for the evening.",
  "What time do you close on Saturdays? I'd like to come with my parents.",
  "Are your paper cups compostable? Our school wants to buy for a fair.",
  "Hi, could I pay the invoice for last month's office order by bank transfer instead of card?",
];
let asked = 0;
const ask = () => ASKS[asked++ % ASKS.length] as string;

const withFile = (b: string) =>
  [
    `Content-Type: multipart/mixed; boundary="${b}"`,
    ``,
    `--${b}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `{BODY}`,
    `--${b}`,
    `Content-Type: application/pdf; name="faktura.pdf"`,
    `Content-Disposition: attachment; filename="faktura.pdf"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    btoa("%PDF-1.4 an invoice"),
    `--${b}--`,
    ``,
  ].join("\r\n");

describe("a server's mark", () => {
  it("puts a stranger's email aside as it arrives, keeping none of its files", async () => {
    const s = await setup();
    const r = await s.ingest(
      { From: "Deals <deals@bulk.example>", Subject: "Invoice", "X-Spam-Flag": "YES" },
      "Pay now.",
      { parts: withFile("b1") },
    );
    expect(r.outcome).toBe("spam");
    expect(await s.verdictOf(idOf(r))).toMatchObject({
      state: "spam",
      screen: "aside",
      verdict: "aside",
      cause: "server_marked",
    });
    const [entry] = await s.db.orm
      .select()
      .from(schema.threadEntries)
      .where(eq(schema.threadEntries.itemId, idOf(r)));
    expect(entry?.attachments ?? []).toEqual([]);
  });

  it("only labels an email from a sender the business has answered", async () => {
    const s = await setup();
    // The receiving server verified it came from her domain, so it is known to be hers: a strong
    // match (ADR-017 §8.2), and only a strong match makes anyone known.
    const hers = { authenticated: true, auth: { dmarc: "pass", dkim: ["example.no"] } };
    const first = await s.ingest({ From: "Ingrid Dahl <ingrid@example.no>", Subject: "Beans" }, ask(), hers);
    expect(first.outcome).toBe("created");
    await s.caps.reply(owner, { item_id: idOf(first), body: "Ja, we have them. See you Friday!", internal: false });
    const marked = await s.ingest(
      { From: "Ingrid Dahl <ingrid@example.no>", Subject: "New order", "X-Spam-Status": "Yes, score=7.1" },
      "Two more bags please.",
      hers,
    );
    expect(marked.outcome).toBe("created");
    expect(await s.verdictOf(idOf(marked))).toMatchObject({
      state: "open",
      screen: "warned",
      verdict: "warn",
      cause: "server_marked",
    });
  });

  it("lends nobody a known customer's standing by writing their address in From", async () => {
    const s = await setup();
    const hers = { authenticated: true, auth: { dmarc: "pass", dkim: ["example.no"] } };
    const first = await s.ingest({ From: "Ingrid Dahl <ingrid@example.no>", Subject: "Beans" }, ask(), hers);
    await s.caps.reply(owner, { item_id: idOf(first), body: "Ja, see you Friday!", internal: false });
    const forged = await s.ingest(
      { From: "Ingrid Dahl <ingrid@example.no>", Subject: "Invoice", "X-Spam-Flag": "YES" },
      "New bank details for my invoice.",
      {
        auth: { dmarc: "fail" },
      },
    );
    expect(forged.outcome).toBe("spam");
  });
});

describe("what the receiving server found", () => {
  it("takes a point off for a signed sender, never waves one through, and counts a failed check", async () => {
    const s = await setup();
    const signed = await s.ingest({ From: "Ola Nordmann <ola@example.no>", Subject: "Beans" }, ask(), {
      auth: { dmarc: "pass", dkim: ["example.no"] },
    });
    expect(await s.verdictOf(idOf(signed))).toMatchObject({
      screen: "delivered",
      verdict: "deliver",
      signals: ["aligned"],
    });
    const failed = await s.ingest({ From: "Ola Nordmann <ola@example.org>", Subject: "Beans" }, ask(), {
      auth: { dmarc: "fail" },
    });
    expect(await s.verdictOf(idOf(failed))).toMatchObject({ screen: "delivered", signals: ["dmarc_fail"] });
    // A failed check and a display name that names another company: a label, not a verdict.
    const both = await s.ingest(
      { From: '"payments@bigbank.example" <notice@example.net>', Subject: "Account" },
      ask(),
      { auth: { dmarc: "fail" } },
    );
    expect(await s.verdictOf(idOf(both))).toMatchObject({ screen: "warned", verdict: "warn" });
    expect((await s.verdictOf(idOf(both))).signals.sort()).toEqual(["display_other", "dmarc_fail"]);
  });
});

describe("who the email says it is", () => {
  it("labels the business's own name used from outside, and a look-alike of its domain", async () => {
    const s = await setup();
    const poses = await s.ingest(
      { From: "Fjord Kaffe <fjordkaffe.billing@freemail.example>", Subject: "Your account" },
      ask(),
    );
    expect((await s.verdictOf(idOf(poses))).signals).toContain("poses_as_us");
    const look = await s.ingest({ From: "Accounts <accounts@fjordkaffee.example>", Subject: "Your account" }, ask());
    expect((await s.verdictOf(idOf(look))).signals).toContain("lookalike");
    expect((await s.verdictOf(idOf(look))).verdict).toBe("warn");
    // A customer whose name shares a word with the business is just a customer.
    const fjord = await s.ingest({ From: "Kari Fjord <kari.fjord@example.no>", Subject: "Beans" }, ask());
    expect(await s.verdictOf(idOf(fjord))).toMatchObject({ screen: "delivered", signals: [] });
  });

  it("labels answers that would go somewhere else", async () => {
    const s = await setup();
    const r = await s.ingest(
      { From: "Sales <sales@roastery-supplies.example>", "Reply-To": "roastery.deals@gmail.com", Subject: "Beans" },
      ask(),
    );
    expect((await s.verdictOf(idOf(r))).signals).toContain("reply_elsewhere");
    // A Reply-To on the sender's own domain is how mailing tools work.
    const own = await s.ingest(
      { From: "Sales <sales@roastery.example>", "Reply-To": "orders@roastery.example", Subject: "Beans" },
      ask(),
    );
    expect((await s.verdictOf(idOf(own))).signals).not.toContain("reply_elsewhere");
  });
});

describe("a thread", () => {
  it("is never screened once it has begun, whatever a server says of a reply", async () => {
    const s = await setup();
    const first = await s.ingest(
      { From: "Ingrid Dahl <ingrid@example.no>", Subject: "Beans", "Message-ID": "<t1@example.no>" },
      ask(),
    );
    const reply = await s.ingest(
      {
        From: "Ingrid Dahl <ingrid@example.no>",
        Subject: "Re: Beans",
        "In-Reply-To": "<t1@example.no>",
        "X-Spam-Flag": "YES",
      },
      "Friday at 3 works.",
    );
    expect(reply).toEqual({ outcome: "replied", itemId: idOf(first) });
    const { rows } = await s.db.client.query({ sql: "SELECT COUNT(*) FROM spam_verdicts", method: "all" });
    expect(Number(rows[0]?.[0])).toBe(1);
  });
});

describe("the files of what is put aside", () => {
  it("stay shut until a person brings the message back", async () => {
    const s = await setup();
    const r = await s.ingest({ From: "Ola Nordmann <ola@example.no>", Subject: "Beans" }, ask(), {
      parts: withFile("b2"),
    });
    expect(r.outcome).toBe("created");
    const [entry] = await s.db.orm
      .select()
      .from(schema.threadEntries)
      .where(eq(schema.threadEntries.itemId, idOf(r)));
    const [file] = (entry?.attachments ?? []) as { id: string; state: string }[];
    expect(file?.state).toBe("kept");
    expect((await s.caps.email.attachment(owner, file?.id as string)).filename).toBe("faktura.pdf");
    await s.caps.transitionItem(owner, { item_id: idOf(r), event: "mark_spam" });
    await expect(s.caps.email.attachment(owner, file?.id as string)).rejects.toMatchObject({
      code: "not_allowed",
      details: { reason: "spam" },
    });
  });
});
