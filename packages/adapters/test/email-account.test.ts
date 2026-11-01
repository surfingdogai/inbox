import {
  type Caller,
  createRunner,
  type JudgePort,
  type JudgeRequest,
  NO_MATCH,
  type SharedSpamPort,
  schema,
  ulid,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ingestEmail, isAccountNotice, LINKS_HEADING, linksOf } from "../src/email";
import { WEBHOOK_DELIVERY_KIND, WEBHOOK_FANOUT_KIND, webhookFanoutHandler } from "../src/webhooks/index";
import { freshDb } from "./db";

/**
 * A code, a sign-in link or a password reset for an account the business holds, from a sender that
 * takes no answer: the owner gets it whole, with the links its email carries (a sign-in button's link
 * is often only in the HTML part), and nothing else does. No rule answers it, no webhook carries it,
 * no AI reads it, and nothing of it goes to the host's shared list. Anyone else's email is as before.
 */

const INBOUND = "oficina-mare@in.example.net";
const OWNER = "rui@personal.example";
const T = Date.parse("2026-11-01T09:00:00Z");
const LINK = "https://app.acmecloud.example/magic-link#t0k3n-9f2c&s=1";

const owner: Caller = {
  actor: { kind: "owner", id: "user_owner", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T,
};

/** A message as a mail program sends it: headers, then one part or several. */
function raw(headers: Record<string, string>, parts: { type: string; body: string }[]): string {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  const [only] = parts;
  if (parts.length === 1 && only)
    return `${head}\r\nMIME-Version: 1.0\r\nContent-Type: ${only.type}; charset=utf-8\r\n\r\n${only.body}`;
  const body = parts.map((p) => `--alt\r\nContent-Type: ${p.type}; charset=utf-8\r\n\r\n${p.body}\r\n`).join("");
  return `${head}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="alt"\r\n\r\n${body}--alt--\r\n`;
}

/** The sign-in email as it came: its text says "the button below" and holds no link; the HTML has it. */
const SIGN_IN_TEXT = [
  "Your secure link to Acme is here",
  "",
  "Click the button below to sign in to Acme.",
  "",
  "This link expires in 1 hour and can only be used once.",
  "",
  "If you didn't ask for it, you can ignore this email.",
  "",
  "Acme Cloud",
  "1 Example Street",
  "Example City",
  "",
  "Privacy | Terms",
].join("\n");
const SIGN_IN_HTML = [
  "<html><head><style>.b{color:#fff}</style></head><body>",
  '<a href="https://acmecloud.example"><img src="https://acmecloud.example/logo.png" alt="Acme"></a>',
  "<p>Click the button below to sign in to Acme.</p>",
  `<a class="b" style="display:inline-block" href="${LINK.replace("&", "&amp;")}">Sign in to Acme</a>`,
  "<p>This link expires in 1 hour and can only be used once.</p>",
  '<p><a href="https://acmecloud.example/privacy">Privacy</a> | <a href="https://acmecloud.example/terms">Terms</a></p>',
  '<img src="https://t.acmecloud.example/open.gif?u=81" width="1" height="1">',
  "</body></html>",
].join("\n");

const signIn = (id: string) =>
  raw(
    {
      From: "Acme <no-reply-wJOazRuV1tbG@mail.acmecloud.example>",
      To: "support@oficinamare.example",
      Subject: "Your secure link to Acme is here",
      "Message-ID": `<${id}@mail.acmecloud.example>`,
      "List-Unsubscribe": "<https://mail.acmecloud.example/u/81>",
    },
    [
      { type: "text/plain", body: SIGN_IN_TEXT },
      { type: "text/html", body: SIGN_IN_HTML },
    ],
  );

/** A customer's email of fourteen lines: an alert quotes twelve of them, as it always has. */
const CUSTOMER_TEXT = [
  "Hello,",
  "",
  "My bicycle's rear wheel has two broken spokes and the rim is slightly bent after a pothole.",
  "Could you rebuild it this week? I can drop it off on Thursday morning before work.",
  "",
  "It is a 28-spoke wheel with a Shimano hub, and I would like to keep the hub if possible.",
  "",
  "Also, do you sell tubeless tape? I would like to set the new rim up tubeless.",
  "",
  "Thank you,",
  "Rita",
  "",
  "Rua das Flores 12",
  "Porto",
].join("\n");

/**
 * An inbox with its own address and an owner, the spam filter on with a model that records what it
 * is sent and a shared list that records what it is asked, a rule that answers every new message, a
 * webhook for everything, and a runner whose mail is kept.
 */
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
  const sent: JudgeRequest[] = [];
  const judge: JudgePort = {
    async judge(req) {
      sent.push(req);
      return { ok: false, why: "unavailable" };
    },
  };
  const shared = { lookups: 0, reports: 0 };
  const list: SharedSpamPort = {
    contributes: true,
    disputes: true,
    lookup() {
      shared.lookups++;
      return NO_MATCH;
    },
    report() {
      shared.reports++;
    },
    withdraw() {},
  };
  caps.spam.attach({ judge, shared: list });
  await caps.spam.setFilter(owner, { filter: "pitches", on: true }, T - 8 * 86_400_000);
  await db.client.query({ sql: "UPDATE spam_filter_spans SET learning_until = 0", method: "run" });
  await db.orm.insert(schema.rules).values({
    id: ulid(T),
    name: "Thank everyone",
    priority: 5,
    enabled: 1,
    definition: {
      on: ["item.created"],
      if: { path: "item.type", op: "eq", value: "message" },
      actions: [{ action: "reply", template: "Thank you, we will answer soon." }],
      stop: false,
      maxRunsPerItem: 1,
    },
    createdAt: T,
    updatedAt: T,
  });
  await db.client.query({
    sql: `INSERT INTO webhooks (id, url, events, secret_enc, active, created_at, updated_at)
          VALUES ('wh_1', 'https://hooks.oficinamare.example/in', '["*"]', 'sealed', 1, ?, ?)`,
    params: [T, T],
    method: "run",
  });
  const mail = logMailOut();
  caps.attachMail(mail);
  const runner = createRunner({ mailOut: mail, spam: caps.spam })
    .register(WEBHOOK_FANOUT_KIND, webhookFanoutHandler())
    // What a delivery would send is not under test here: only whether one was written.
    .register(WEBHOOK_DELIVERY_KIND, async () => ({ note: "kept" }));
  let clock = T;
  const drain = async (advance = 5 * 60_000) => {
    clock += advance;
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now: clock, limit: 50 })).claimed === 0) return;
  };
  const ingest = (message: string) =>
    ingestEmail(db, caps, { raw: message, envelopeTo: INBOUND }, { now: () => clock });
  const q = async (sql: string, params: string[] = []) => (await db.client.query({ sql, params, method: "all" })).rows;
  const entries = (itemId: string) =>
    db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.itemId, itemId));
  const deliveries = async (itemId: string) =>
    Number(
      (
        await q("SELECT count(*) FROM webhook_deliveries d JOIN events_v1 e ON e.id = d.event_id WHERE e.item_id = ?", [
          itemId,
        ])
      )[0]?.[0],
    );
  return { db, caps, mail, drain, ingest, q, entries, deliveries, sent, shared };
}

const idOf = (r: unknown) => (r as { itemId: string }).itemId;

describe("a code or a sign-in link for an account the business holds", () => {
  it("keeps the link only the HTML part carries, shows it whole in the owner's alert, and gives it to nothing else", async () => {
    const s = await setUp();
    const notice = await s.ingest(signIn("s1"));
    expect(notice.outcome).toBe("created");
    const customer = await s.ingest(
      raw(
        {
          From: "Rita Amaral <rita@example.com>",
          To: "support@oficinamare.example",
          Subject: "Wheel rebuild",
          "Message-ID": "<c1@example.com>",
        },
        [{ type: "text/plain", body: CUSTOMER_TEXT }],
      ),
    );
    expect(customer.outcome).toBe("created");
    await s.drain();
    await s.drain();

    // The item holds the email's words and, under them, the links it carries: the button's first.
    const [entry, ...more] = await s.entries(idOf(notice));
    expect(more).toEqual([]);
    expect(entry?.bodyText).toBe(
      `${SIGN_IN_TEXT}\n\n${LINKS_HEADING}\nhttps://acmecloud.example\n${LINK}\nhttps://acmecloud.example/privacy\nhttps://acmecloud.example/terms`,
    );
    expect(entry?.bodyText).not.toContain("open.gif");
    expect(entry?.bodyText).not.toContain("logo.png");
    const [row] = await s.db.orm
      .select()
      .from(schema.items)
      .where(eq(schema.items.id, idOf(notice)));
    expect(row?.flags).toMatchObject({ account: true });

    // The owner's alert quotes all of it, the link included; a customer's is cut as it always was.
    const alert = s.mail.sent.find((m) => m.to.includes(OWNER) && m.subject.includes("Your secure link"));
    expect(alert?.text).toContain(`> ${LINK}`);
    expect(alert?.text).toContain("> Privacy | Terms");
    expect(alert?.text).not.toContain("> …");
    const theirs = s.mail.sent.find((m) => m.to.includes(OWNER) && m.subject.includes("Wheel rebuild"));
    expect(theirs?.text).toContain("> Thank you,");
    expect(theirs?.text).toContain("> …");
    expect(theirs?.text).not.toContain("Porto");

    // Nothing goes back to the sender: the rule that thanks everyone thanked only the customer.
    expect(s.mail.sent.filter((m) => m.to.some((t) => t.includes("acmecloud")))).toEqual([]);
    expect(s.mail.sent.some((m) => m.to.includes("rita@example.com"))).toBe(true);
    expect((await s.entries(idOf(customer))).map((e) => e.direction)).toEqual(["in", "out"]);

    // No webhook carries it; the customer's message went.
    expect(await s.deliveries(idOf(notice))).toBe(0);
    expect(await s.deliveries(idOf(customer))).toBeGreaterThan(0);

    // The AI read the customer's email, never the account's; the shared list was asked of one email.
    expect(s.sent.length).toBeGreaterThan(0);
    expect(s.sent.every((r) => !r.user.includes("button below") && !r.user.includes("acmecloud"))).toBe(true);
    expect(s.shared.lookups).toBe(1);
    // The filter read it here, and let it through: a rule could have answered it, and none did.
    const [verdict] = await s.q("SELECT ai, verdict FROM spam_verdicts WHERE item_id = ?", [idOf(notice)]);
    expect(verdict).toEqual(["none", "deliver"]);

    // A person's Spam on it is never told to the shared list; on the customer's email it is.
    await s.caps.transitionItem(owner, { item_id: idOf(notice), event: "mark_spam" });
    await s.drain();
    expect(s.shared.reports).toBe(0);
    await s.caps.transitionItem(owner, { item_id: idOf(customer), event: "mark_spam" });
    await s.drain();
    expect(s.shared.reports).toBe(1);
  }, 30_000);

  it("keeps a link its text part writes, and finds the code and the link of an email with only HTML", async () => {
    const s = await setUp();
    const text = await s.ingest(
      raw(
        {
          From: "Bank <noreply@bank.example>",
          To: "support@oficinamare.example",
          Subject: "Reset your password",
          "Message-ID": "<p1@bank.example>",
        },
        [{ type: "text/plain", body: "Reset your password here:\nhttps://bank.example/reset?k=aa11.\n\nThe Bank" }],
      ),
    );
    const [kept] = await s.entries(idOf(text));
    expect(kept?.bodyText).toBe(
      `Reset your password here:\nhttps://bank.example/reset?k=aa11.\n\nThe Bank\n\n${LINKS_HEADING}\nhttps://bank.example/reset?k=aa11`,
    );
    // Only HTML, a subject that says nothing: the words in the HTML say what it is.
    const html = await s.ingest(
      raw(
        {
          From: "Shop <no-reply@shop.example>",
          To: "support@oficinamare.example",
          Subject: "Message",
          "Message-ID": "<h1@shop.example>",
          "List-Unsubscribe": "<https://shop.example/u>",
        },
        [
          {
            type: "text/html",
            body: '<p>Your verification code is <b>481516</b>.</p><p>Or <a href="https://shop.example/verify?c=481516">open this link</a>.</p>',
          },
        ],
      ),
    );
    expect(html.outcome).toBe("created");
    const [only] = await s.entries(idOf(html));
    expect(only?.bodyText).toContain("481516");
    expect(only?.bodyText).toContain(`${LINKS_HEADING}\nhttps://shop.example/verify?c=481516`);
    await s.drain();
    expect(s.mail.sent.filter((m) => m.to.some((t) => /bank|shop/.test(t)))).toEqual([]);
    expect(s.sent).toEqual([]);
  }, 30_000);

  it("is a person's email, answered as any, when a person writes the same words", async () => {
    const s = await setUp();
    const r = await s.ingest(
      raw(
        {
          From: "Rita Amaral <rita@example.com>",
          To: "support@oficinamare.example",
          Subject: "I can't sign in to book",
          "Message-ID": "<c2@example.com>",
        },
        [{ type: "text/plain", body: "The sign-in link you sent me does not open. Could you send it again?" }],
      ),
    );
    await s.drain();
    await s.drain();
    const thread = await s.entries(idOf(r));
    expect(thread.map((e) => e.direction)).toEqual(["in", "out"]);
    expect(thread[0]?.bodyText).not.toContain(LINKS_HEADING);
    const [row] = await s.db.orm
      .select()
      .from(schema.items)
      .where(eq(schema.items.id, idOf(r)));
    expect(row?.flags).not.toHaveProperty("account");
    expect(await s.deliveries(idOf(r))).toBeGreaterThan(0);
  }, 30_000);
});

describe("the links an email carries", () => {
  it("are its anchors' and its text's http(s) links, each once, at most ten, none too long, no image", () => {
    const many = Array.from({ length: 12 }, (_, i) => `<a href='https://example.com/${i}'>${i}</a>`).join("");
    const links = linksOf({
      html: `<img src="https://t.example/p.gif"><a\nhref="https://example.com/0">again</a><a href="javascript:alert(1)">x</a><a href="mailto:help@example.com">help</a><a href=https://example.com/${"a".repeat(2_100)}>long</a>${many}`,
      text: "See https://example.com/0, or (https://example.com/text).",
    });
    expect(links).toHaveLength(10);
    expect(links[0]).toBe("https://example.com/0");
    expect(
      links.some(
        (l) => l.includes("p.gif") || l.startsWith("javascript") || l.startsWith("mailto") || l.length > 2_000,
      ),
    ).toBe(false);
    expect(new Set(links).size).toBe(links.length);
    expect(linksOf({ text: "See https://example.com/0, or (https://example.com/text)." })).toEqual([
      "https://example.com/0",
      "https://example.com/text",
    ]);
  });

  it("are read only of a notice: a code from a sender that takes no answer or with a list's headers", () => {
    const code = { subject: "Your verification code", text: "Use 481516." };
    expect(isAccountNotice({ ...code, headers: [] }, "noreply@bank.example")).toBe(true);
    expect(
      isAccountNotice(
        { ...code, headers: [{ key: "list-id", originalKey: "List-Id", value: "<x>" }] },
        "accounts@bank.example",
      ),
    ).toBe(true);
    expect(isAccountNotice({ ...code, headers: [] }, "rita@example.com")).toBe(false);
    expect(isAccountNotice({ subject: "20% off", text: "Use code SAVE20.", headers: [] }, "noreply@shop.example")).toBe(
      false,
    );
  });
});
