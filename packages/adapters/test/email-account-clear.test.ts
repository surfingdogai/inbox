import {
  ACCOUNT_CLEAR_KIND,
  type Caller,
  CLEARED,
  clearCodes,
  createRunner,
  ensureLifecycleSweep,
  LINKS_HEADING,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { ingestEmail, type MailAuth } from "../src/email";
import { freshDb } from "./db";

/**
 * An account's code or sign-in link is the owner's for a day: 24 hours after the email came, each
 * code and each link is taken out of everything the inbox keeps of it (its words and its subject, the
 * item's text, the history a reply left, the alerts and the digest that named it, the search index
 * and its pages, the copy a second delivery is answered from), a marker in its place. The message
 * stays, with its subject and the rest of its words; nothing else is touched, and clearing it again
 * changes nothing. Node and workerd.
 */

const INBOUND = "oficina-mare@in.example.net";
const OWNER = "rui@personal.example";
const T = Date.parse("2026-11-01T09:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const LINK = "https://app.acmecloud.example/magic-link#t0k3n-9f2c&s=1";
const VOUCHED: MailAuth = { spf: "pass", dkim: ["mail.acmecloud.example"], dmarc: "pass" };

const owner: Caller = {
  actor: { kind: "owner", id: "user_owner", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T,
};

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

const CODE_TEXT = [
  "Your Acme sign-in code is 481516.",
  "",
  "Or click the button below to sign in to Acme.",
  "",
  "This code expires in 1 hour and can only be used once.",
  "",
  "Acme Cloud",
  "© 2026 Acme",
].join("\n");

const signIn = (id: string, extra: Record<string, string> = {}, text = CODE_TEXT) =>
  raw(
    {
      From: "Acme <no-reply@mail.acmecloud.example>",
      To: "support@oficinamare.example",
      Subject: "Your Acme sign-in code",
      "Message-ID": `<${id}@mail.acmecloud.example>`,
      ...extra,
    },
    [
      { type: "text/plain", body: text },
      { type: "text/html", body: `<p>${text}</p><a href="${LINK.replace("&", "&amp;")}">Sign in to Acme</a>` },
    ],
  );

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
  const mail = logMailOut();
  caps.attachMail(mail);
  const runner = createRunner({ mailOut: mail });
  let clock = T;
  /** The clock moved on by `advance`, then every job due by then, the quarter hours' sweeps among them. */
  const until = async (at: number) => {
    clock = at;
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now: clock, limit: 50 })).claimed === 0) return;
  };
  const ingest = (message: string) =>
    ingestEmail(db, caps, { raw: message, envelopeTo: INBOUND, auth: VOUCHED }, { now: () => clock });
  const q = async (sql: string, params: string[] = []) => (await db.client.query({ sql, params, method: "all" })).rows;
  const bodies = async (itemId: string) =>
    (await q("SELECT body_text FROM thread_entries WHERE item_id = ? ORDER BY created_at, id", [itemId])).map((r) =>
      String(r[0]),
    );
  const itemText = async (itemId: string) =>
    String((await q("SELECT json_extract(payload, '$.text') FROM items WHERE id = ?", [itemId]))[0]?.[0]);
  const subject = async (itemId: string) => (await q("SELECT subject FROM items WHERE id = ?", [itemId]))[0]?.[0];
  const found = async (word: string) =>
    Number((await q("SELECT count(*) FROM search_fts WHERE search_fts MATCH ?", [`"${word}"`]))[0]?.[0]);
  /** The search index's own pages that still hold the word, matched or not. */
  const pages = async (word: string) =>
    Number((await q("SELECT count(*) FROM search_fts_data WHERE instr(block, CAST(? AS BLOB)) > 0", [word]))[0]?.[0]);
  const history = async (itemId: string) =>
    (await q("SELECT meta FROM item_events WHERE item_id = ? ORDER BY seq", [itemId])).map((r) => String(r[0]));
  /** Every email the inbox wrote down: the alerts and the digests. */
  const logged = async () =>
    (await q("SELECT template, subject, body_text FROM outbound_mail ORDER BY created_at, id")).map((r) => ({
      template: String(r[0]),
      subject: String(r[1]),
      text: String(r[2]),
    }));
  const kept = async (itemId: string) =>
    (await q("SELECT response FROM idempotency_keys WHERE item_id = ?", [itemId])).map((r) => String(r[0]));
  const clears = async () =>
    (await q("SELECT dedupe_key, status, run_at FROM jobs WHERE kind = ? ORDER BY run_at", [ACCOUNT_CLEAR_KIND])).map(
      (r) => ({ key: String(r[0]), status: String(r[1]), runAt: Number(r[2]) }),
    );
  await ensureLifecycleSweep(db, T);
  return { db, caps, mail, until, ingest, q, bodies, itemText, subject, found, pages, history, logged, kept, clears };
}

const idOf = (r: unknown) => (r as { itemId: string }).itemId;

describe("a code or a sign-in link for an account the business holds, a day on", () => {
  it("is taken out of everything the inbox keeps of it, the rest of the message left as it was", async () => {
    const s = await setUp();
    const notice = idOf(await s.ingest(signIn("c1")));
    const customer = idOf(
      await s.ingest(
        raw(
          {
            From: "Rita Amaral <rita@example.com>",
            To: "support@oficinamare.example",
            Subject: "Order 553412",
            "Message-ID": "<r1@example.com>",
          },
          [{ type: "text/plain", body: "My order 553412 has not come. Tracking: https://post.example/t/553412" }],
        ),
      ),
    );
    await s.until(T + 5 * MIN);
    const [before] = await s.bodies(notice);
    expect(before).toContain("481516");
    expect(await s.pages("481516")).toBeGreaterThan(0);
    expect(before).toContain(`${LINKS_HEADING}\n${LINK}`);
    expect(await s.found("481516")).toBe(1);
    expect((await s.kept(notice)).some((r) => r.includes("481516"))).toBe(true);
    // Its clearing is queued as it is seen, due a day after the email came.
    const [queued] = await s.clears();
    expect(queued).toMatchObject({ status: "queued", runAt: T + 24 * HOUR });

    // A minute short of the day: as it came.
    await s.until(T + 24 * HOUR - MIN);
    expect(await s.bodies(notice)).toEqual([before]);

    await s.until(T + 24 * HOUR);
    const [after] = await s.bodies(notice);
    expect(after).toBe(
      [
        `Your Acme sign-in code is ${CLEARED}.`,
        "",
        "Or click the button below to sign in to Acme.",
        "",
        "This code expires in 1 hour and can only be used once.",
        "",
        "Acme Cloud",
        "© 2026 Acme",
        "",
        LINKS_HEADING,
        CLEARED,
      ].join("\n"),
    );
    expect(await s.itemText(notice)).toBe(after);
    expect(await s.subject(notice)).toBe("Your Acme sign-in code");
    // Searching finds it by its words, never by its code; and once the quarter hour's merge has run,
    // the index's own pages hold the code no more.
    expect(await s.found("481516")).toBe(0);
    expect(await s.found("button")).toBe(1);
    await s.until(T + 24 * HOUR + 15 * MIN);
    expect(await s.pages("481516")).toBe(0);
    expect(await s.pages("553412")).toBeGreaterThan(0);
    // The copy a second delivery of the same email is answered from holds neither.
    for (const r of await s.kept(notice)) {
      expect(r).not.toContain("481516");
      expect(r).not.toContain("magic-link");
    }
    expect(await s.kept(notice)).not.toEqual([]);
    // A customer's message is never touched.
    expect(await s.bodies(customer)).toEqual(["My order 553412 has not come. Tracking: https://post.example/t/553412"]);
    expect(await s.found("553412")).toBeGreaterThan(0);

    // Once is all: the next day changes nothing, and queues nothing more.
    await s.until(T + 49 * HOUR);
    expect(await s.bodies(notice)).toEqual([after]);
    expect((await s.clears()).map((c) => c.status)).toEqual(["done"]);
  }, 30_000);

  it("clears each email on its own day, and one that came while nothing ran as soon as the sweep sees it", async () => {
    const s = await setUp();
    const notice = idOf(await s.ingest(signIn("c2")));
    // The same account writes again in the same conversation, half a day later.
    await s.until(T + 12 * HOUR);
    const again = await s.ingest(
      signIn("c3", { "In-Reply-To": "<c2@mail.acmecloud.example>" }, "Your new Acme sign-in code is 772093."),
    );
    expect(idOf(again)).toBe(notice);
    await s.until(T + 24 * HOUR);
    const [first, second] = await s.bodies(notice);
    expect(first).not.toContain("481516");
    expect(second).toContain("772093");
    await s.until(T + 36 * HOUR);
    expect((await s.bodies(notice))[1]).toBe(`Your new Acme sign-in code is ${CLEARED}.`);

    // A server that was off for two days: the sweep that comes back finds it, and clears it at once.
    const late = await setUp();
    await late.q("DELETE FROM jobs");
    const item = idOf(await late.ingest(signIn("c4")));
    await late.until(T + 48 * HOUR);
    expect(await late.clears()).toEqual([]);
    await ensureLifecycleSweep(late.db, T + 48 * HOUR);
    await late.until(T + 48 * HOUR + MIN);
    expect((await late.bodies(item))[0]).not.toContain("481516");
  }, 30_000);
  it("takes a code out of the subject too, wherever the subject was said: the item, its search, the alerts and the hour's digest", async () => {
    const s = await setUp();
    // Six codes from one sender's domain in an hour: five reach the owner at once, the sixth waits for
    // the hour's digest.
    const codes = ["481516", "602214", "314159", "271828", "161803", "141421"];
    const items: string[] = [];
    for (const [i, code] of codes.entries()) {
      const notice = raw(
        {
          From: `Acme <no-reply@mail${i}.acmecloud.example>`,
          To: "support@oficinamare.example",
          Subject: `${code} is your Acme code`,
          "Message-ID": `<s${i}@mail.acmecloud.example>`,
        },
        [{ type: "text/plain", body: `Your Acme sign-in code is ${code}. Ends soon.` }],
      );
      items.push(idOf(await s.ingest(notice)));
    }
    await s.until(T + MIN);
    await s.until(T + 2 * HOUR);
    expect(new Set(items).size).toBe(codes.length);
    expect(s.mail.sent.filter((m) => m.to.includes(OWNER) && /is your Acme code/.test(m.subject))).toHaveLength(5);
    const digest = (await s.logged()).find((m) => m.template === "owner.digest");
    expect(digest?.text).toContain("141421 is your Acme code");
    expect(await s.found("481516")).toBe(1);

    // A day on, then the quarter hour's merge of the search index.
    await s.until(T + 24 * HOUR);
    await s.until(T + 24 * HOUR + 15 * MIN);
    const [first] = items;
    expect(await s.subject(first ?? "")).toBe(`${CLEARED} is your Acme code`);
    expect(await s.q("SELECT json_extract(payload, '$.subject') FROM items WHERE id = ?", [first ?? ""])).toEqual([
      [`${CLEARED} is your Acme code`],
    ]);
    expect(await s.q("SELECT subject FROM thread_entries WHERE item_id = ?", [first ?? ""])).toEqual([
      [`${CLEARED} is your Acme code`],
    ]);
    expect(await s.bodies(first ?? "")).toEqual([`Your Acme sign-in code is ${CLEARED}. Ends soon.`]);
    for (const code of codes) {
      expect(await s.found(code)).toBe(0);
      expect(await s.pages(code)).toBe(0);
      for (const m of await s.logged()) {
        expect(m.subject).not.toContain(code);
        expect(m.text).not.toContain(code);
      }
      for (const id of items) for (const r of await s.kept(id)) expect(r).not.toContain(code);
    }
    // The alerts and the digest keep the rest of what they said.
    const after = await s.logged();
    expect(after.filter((m) => m.subject === `New message from Acme: ${CLEARED} is your Acme code`)).toHaveLength(6);
    expect(after.find((m) => m.template === "owner.digest")?.text).toContain(
      `- New message from Acme: ${CLEARED} is your Acme code`,
    );
    expect(await s.found("soon")).toBe(codes.length);
  }, 60_000);

  it("takes the code out of the history a reply left when it reopened a closed conversation", async () => {
    const s = await setUp();
    const notice = idOf(await s.ingest(signIn("c5")));
    await s.until(T + 5 * MIN);
    await s.caps.transitionItem(owner, { item_id: notice, event: "close" });
    await s.until(T + 12 * HOUR);
    const words = "Your new Acme sign-in code is 772093. https://app.acmecloud.example/magic-link?t=SECRET2";
    const again = await s.ingest(signIn("c6", { "In-Reply-To": "<c5@mail.acmecloud.example>" }, words));
    expect(idOf(again)).toBe(notice);
    expect((await s.history(notice)).filter((m) => m.includes("772093") && m.includes("SECRET2"))).toHaveLength(1);

    await s.until(T + 36 * HOUR);
    await s.until(T + 36 * HOUR + 15 * MIN);
    const history = await s.history(notice);
    for (const m of history) {
      expect(m).not.toContain("772093");
      expect(m).not.toContain("SECRET2");
    }
    const cleared = `Your new Acme sign-in code is ${CLEARED}. ${CLEARED}`;
    expect(history.filter((m) => m.includes(cleared))).toHaveLength(1);
    expect(await s.bodies(notice)).toEqual([expect.not.stringContaining("481516"), cleared]);
    expect(await s.pages("772093")).toBe(0);
  }, 30_000);
});

describe("what counts as a code or a link", () => {
  it("is a code of digits or of capitals and digits, what follows a word for a code, and any link; a word, a year, a date, a time or an amount stays", () => {
    const said = (text: string) => clearCodes(text).text;
    expect(said("Your verification code is 481516.")).toBe(`Your verification code is ${CLEARED}.`);
    expect(said("481516 is your code")).toBe(`${CLEARED} is your code`);
    expect(said("Code: 123 456, or 4821-9375")).toBe(`Code: ${CLEARED}, or ${CLEARED}`);
    expect(said("Use G-482913, X7K9Q2 or XK7-93Q")).toBe(`Use ${CLEARED}, ${CLEARED} or ${CLEARED}`);
    expect(said("Open www.acme.example/login or https://acme.example/a?b=1.")).toBe(`Open ${CLEARED} or ${CLEARED}.`);
    expect(said("Your Steam Guard code: F4K7J")).toBe(`Your Steam Guard code: ${CLEARED}`);
    // After a word for a code, whatever its case or its shape, a year's included.
    expect(said("Your verification code is abc123")).toBe(`Your verification code is ${CLEARED}`);
    expect(said("Your sign-in code is 1987. Your code is 2025")).toBe(
      `Your sign-in code is ${CLEARED}. Your code is ${CLEARED}`,
    );
    expect(said("Code 4 8 1 5 1 6, PIN code: x7k9q2, Sicherheitscode: 7X2kq9, código é 4821")).toBe(
      `Code ${CLEARED}, PIN code: ${CLEARED}, Sicherheitscode: ${CLEARED}, código é ${CLEARED}`,
    );
    // Set apart on a line of its own, and a run of digits however long.
    expect(said("Enter this code to sign in:\n\nx7k9q2\n\nThanks")).toBe(
      `Enter this code to sign in:\n\n${CLEARED}\n\nThanks`,
    );
    expect(said("Your code: 1234567890123456")).toBe(`Your code: ${CLEARED}`);
    const plain = [
      "On 2026-11-01 at 10:30 you paid €45 and $1500.00. SIGN IN NOW, © 2026 Acme. Your code expires in 1 hour.",
      "Your code is valid for 10 minutes. Total 1500 €, or 1500 EUR, or EUR 1500.",
      "Signed in on 1 November 2026, Nov 1, 2026, or 1 de novembro de 2026. Copyright Acme Ltd 2026.",
    ].join("\n");
    expect(said(plain)).toBe(plain);
    // The links an email carried, under its words, read as one marker.
    expect(said(`Hi\n\n${LINKS_HEADING}\nhttps://a.example/1\nhttps://b.example/2`)).toBe(
      `Hi\n\n${LINKS_HEADING}\n${CLEARED}`,
    );
    // Again, nothing changes.
    const once = said(CODE_TEXT);
    expect(clearCodes(once)).toEqual({ text: once, removed: 0 });
  });
});
