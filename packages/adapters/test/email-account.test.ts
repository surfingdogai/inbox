import {
  type Caller,
  createRunner,
  type JudgePort,
  type JudgeRequest,
  LINKS_HEADING,
  NO_MATCH,
  type SharedSpamPort,
  schema,
  ulid,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ingestEmail, isAccountNotice, linksOf, type MailAuth } from "../src/email";
import { WEBHOOK_DELIVERY_KIND, WEBHOOK_FANOUT_KIND, webhookFanoutHandler } from "../src/webhooks/index";
import { freshDb } from "./db";

/**
 * A code, a sign-in link or a password reset for an account the business holds, from a sender that
 * takes no answer, on the domain the receiving server vouched for: the owner gets it, with the links
 * its email carries (a sign-in button's link is often only in the HTML part), and nothing else does.
 * No rule answers it, no webhook carries it, no AI reads it, its alert's copy in the mail log holds
 * neither code nor link, and a person's Spam on it is never told to the host's shared list. A
 * look-alike nothing vouched for, and anyone else's email, is as before.
 */

const INBOUND = "oficina-mare@in.example.net";
const OWNER = "rui@personal.example";
const T = Date.parse("2026-11-01T09:00:00Z");
const LINK = "https://app.acmecloud.example/magic-link#t0k3n-9f2c&s=1";
/** What the receiving server found of a sender that is who it says: DMARC passed. */
const VOUCHED: MailAuth = { spf: "pass", dkim: ["mail.acmecloud.example"], dmarc: "pass" };

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

const signIn = (id: string, local = "no-reply-wJOazRuV1tbG") =>
  raw(
    {
      From: `Acme <${local}@mail.acmecloud.example>`,
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
  /** As the receiving server found its sender: `null` when it said nothing. */
  const ingest = (message: string, auth: MailAuth | null = VOUCHED) =>
    ingestEmail(db, caps, { raw: message, envelopeTo: INBOUND, ...(auth ? { auth } : {}) }, { now: () => clock });
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
  const flags = async (itemId: string) =>
    (await db.orm.select().from(schema.items).where(eq(schema.items.id, itemId)))[0]?.flags;
  const alerts = (subject: string) => mail.sent.filter((m) => m.to.includes(OWNER) && m.subject.includes(subject));
  return { db, caps, mail, drain, ingest, q, entries, deliveries, flags, alerts, sent, shared };
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
    expect(await s.flags(idOf(notice))).toMatchObject({ account: true });

    // The owner's alert quotes all of it, the link included; a customer's is cut as it always was.
    const [alert] = s.alerts("Your secure link");
    expect(alert?.text).toContain("> Privacy | Terms");
    expect(alert?.text).toContain(`>\n> ${LINKS_HEADING}\n> https://acmecloud.example\n> ${LINK}\n`);
    expect(alert?.text).not.toContain("> …");
    const [theirs] = s.alerts("Wheel rebuild");
    expect(theirs?.text).toContain("> Thank you,");
    expect(theirs?.text).toContain("> …");
    expect(theirs?.text).not.toContain("Porto");
    // The mail log's copy of that alert holds neither the link nor the words: the item does.
    const logged = await s.q("SELECT body_text FROM outbound_mail WHERE item_id = ? AND recipient = 'owner'", [
      idOf(notice),
    ]);
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).not.toContain("magic-link");
    expect(String(logged[0]?.[0])).not.toContain("button below");
    expect(String(logged[0]?.[0])).toContain("kept on the item only");

    // Nothing goes back to the sender: the rule that thanks everyone thanked only the customer.
    expect(s.mail.sent.filter((m) => m.to.some((t) => t.includes("acmecloud")))).toEqual([]);
    expect(s.mail.sent.some((m) => m.to.includes("rita@example.com"))).toBe(true);
    expect((await s.entries(idOf(customer))).map((e) => e.direction)).toEqual(["in", "out"]);

    // No webhook carries it; the customer's message went.
    expect(await s.deliveries(idOf(notice))).toBe(0);
    expect(await s.deliveries(idOf(customer))).toBeGreaterThan(0);

    // The AI read the customer's email, never the account's; the shared list was asked of both, by
    // a fingerprint that holds no word.
    expect(s.sent.length).toBeGreaterThan(0);
    expect(s.sent.every((r) => !r.user.includes("button below") && !r.user.includes("acmecloud"))).toBe(true);
    expect(s.shared.lookups).toBe(2);
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
    expect(await s.flags(idOf(r))).not.toHaveProperty("account");
    expect(await s.deliveries(idOf(r))).toBeGreaterThan(0);
  }, 30_000);

  it("is an ordinary email when nothing vouched for its sender: screened by the AI, quoted a few lines, its links kept only for the business's people unless forged", async () => {
    const s = await setUp();
    const phish = (id: string, auth: MailAuth | null) =>
      s.ingest(
        raw(
          {
            From: "Acme Security <noreply@acme-secure.example>",
            To: "support@oficinamare.example",
            Subject: "Verify your account",
            "Message-ID": `<${id}@acme-secure.example>`,
            "List-Unsubscribe": "<https://acme-secure.example/u>",
          },
          [
            {
              type: "text/plain",
              body: CUSTOMER_TEXT.replace("Hello,", `Your account ${id} is on hold. Verify it below.`),
            },
            { type: "text/html", body: '<a href="https://acme-secure.example/verify?u=1">Verify now</a>' },
          ],
        ),
        auth,
      );
    const none = await phish("v1", null);
    const failed = await phish("v2", { dkim: [], dmarc: "fail" });
    const elsewhere = await phish("v3", { dkim: ["mailer.example"], dmarc: "none" });
    await s.drain();
    await s.drain();
    for (const r of [none, failed, elsewhere]) {
      expect(r.outcome).toBe("created");
      expect(await s.flags(idOf(r))).not.toHaveProperty("account");
      const [entry] = await s.entries(idOf(r));
      // Shown to the business's people in the inbox, as a sign-in button's link must be; never a forged sender's.
      if (r === failed) expect(entry?.bodyText).not.toContain(LINKS_HEADING);
      else expect(entry?.bodyText).toContain(`${LINKS_HEADING}\nhttps://acme-secure.example/verify?u=1`);
    }
    // The AI was sent each, and the shared list asked of each.
    for (const id of ["v1", "v2", "v3"]) expect(s.sent.some((r) => r.user.includes(`account ${id} is`))).toBe(true);
    expect(s.shared.lookups).toBe(3);
    // Each alert quotes twelve lines, as for anyone, and lists no links.
    for (const alert of s.alerts("Verify your account")) {
      expect(alert.text).toContain("> …");
      expect(alert.text).not.toContain(LINKS_HEADING);
      expect(alert.text).not.toContain("verify?u=1");
    }
  }, 30_000);

  it("delivers the same notice a third and a fifth time, from a new no-reply address each time", async () => {
    const s = await setUp();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await s.ingest(signIn(`w${i}`, `no-reply-${i}Xq${i}Lm`));
      expect(r.outcome).toBe("created");
      ids.push(idOf(r));
      await s.drain(2 * 60_000);
    }
    const verdicts = await s.q(
      `SELECT verdict, signals FROM spam_verdicts WHERE item_id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    expect(verdicts.map((v) => v[0])).toEqual(["deliver", "deliver", "deliver", "deliver", "deliver"]);
    expect(verdicts.some((v) => /same_text|near_same|wave|same_link_domain/.test(String(v[1])))).toBe(false);
    expect(s.alerts("Your secure link")).toHaveLength(5);
  }, 30_000);

  it("reads the email's own words, its links once: what the item keeps under them adds no points", async () => {
    const s = await setUp();
    const r = await s.ingest(
      raw(
        {
          From: "Acme <no-reply@mail.acmecloud.example>",
          To: "support@oficinamare.example",
          Subject: "Your secure link to Acme is here",
          "Message-ID": "<once@mail.acmecloud.example>",
        },
        [
          { type: "text/plain", body: "Click the button below to sign in to Acme.\n\nIt expires in an hour." },
          {
            type: "text/html",
            body: `<a href="${LINK.replace("&", "&amp;")}">Sign in</a> <a href="https://acmecloud.example/help">Help</a>`,
          },
        ],
      ),
    );
    const [entry] = await s.entries(idOf(r));
    expect(entry?.bodyText).toContain(`${LINKS_HEADING}\n${LINK}\nhttps://acmecloud.example/help`);
    const [verdict] = await s.q("SELECT signals FROM spam_verdicts WHERE item_id = ?", [idOf(r)]);
    expect(String(verdict?.[0])).not.toContain("many_links");
  }, 30_000);

  it("never takes a shop's mailing for one, though its domain is vouched for", async () => {
    const s = await setUp();
    const promo = (id: string, subject: string) =>
      s.ingest(
        raw(
          {
            From: "Loja <news@loja.example>",
            To: "support@oficinamare.example",
            Subject: subject,
            "Message-ID": `<${id}@loja.example>`,
            "List-Unsubscribe": "<https://loja.example/u>",
          },
          [
            {
              type: "text/plain",
              body: CUSTOMER_TEXT.replace("Hello,", "Our autumn sale is on: https://loja.example/sale"),
            },
          ],
        ),
        { dkim: ["loja.example"], dmarc: "pass" },
      );
    // A discount code is kept (a code is never dropped), and screened as any email; "designing" names no sign-in.
    const code = await promo("p1", "Código de desconto exclusivo: OUTONO20");
    expect(code.outcome).toBe("created");
    expect(await s.flags(idOf(code))).not.toHaveProperty("account");
    expect((await s.entries(idOf(code)))[0]?.bodyText).not.toContain(LINKS_HEADING);
    expect(await promo("p2", "Designing your autumn window")).toMatchObject({
      outcome: "notice",
      reason: "a mailing or a notice that answers no conversation",
    });
    await s.drain();
    expect(s.sent.some((r) => r.user.includes("Our autumn sale"))).toBe(true);
    const [alert] = s.alerts("OUTONO20");
    expect(alert?.text).toContain("> …");
    expect(alert?.text).not.toContain(LINKS_HEADING);
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

  it("are read only of a notice: a code from a sender that takes no answer or with a list's headers, on its own domain", () => {
    const code = { subject: "Your verification code", text: "Use 481516." };
    const pass: MailAuth = { dmarc: "pass" };
    const list = [{ key: "list-id", originalKey: "List-Id", value: "<x>" }];
    expect(isAccountNotice({ ...code, headers: [] }, "noreply@bank.example", pass)).toBe(true);
    expect(isAccountNotice({ ...code, headers: list }, "accounts@bank.example", pass)).toBe(true);
    // A DKIM signature of the From's own domain, or of the domain above it, vouches as DMARC does.
    expect(isAccountNotice({ ...code, headers: [] }, "noreply@mail.bank.example", { dkim: ["bank.example"] })).toBe(
      true,
    );
    expect(isAccountNotice({ ...code, headers: [] }, "rita@example.com", pass)).toBe(false);
    // Nothing said, a failed DMARC, or a signature of another domain vouches for nothing.
    expect(isAccountNotice({ ...code, headers: [] }, "noreply@bank.example", undefined)).toBe(false);
    expect(
      isAccountNotice({ ...code, headers: [] }, "noreply@bank.example", { dkim: ["bank.example"], dmarc: "fail" }),
    ).toBe(false);
    expect(isAccountNotice({ ...code, headers: [] }, "noreply@bank.example", { dkim: ["mailer.example"] })).toBe(false);
    // A mailing's words are not a notice's, though its domain is vouched for.
    for (const subject of [
      "20% off",
      "Código de desconto exclusivo: OUTONO20",
      "Designing your autumn window",
      "Your code for 10% off",
    ]) {
      expect(isAccountNotice({ subject, text: "Use code SAVE20.", headers: list }, "news@shop.example", pass)).toBe(
        false,
      );
    }
  });
});
