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
 * code and each link is taken out of everything the inbox keeps of it (its words, the item's text,
 * the search index, the copy a second delivery is answered from), a marker in its place. The message
 * stays, with its subject and the rest of its words; nothing else is touched, and clearing it again
 * changes nothing. Node and workerd.
 */

const INBOUND = "oficina-mare@in.example.net";
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
  const kept = async (itemId: string) =>
    (await q("SELECT response FROM idempotency_keys WHERE item_id = ?", [itemId])).map((r) => String(r[0]));
  const clears = async () =>
    (await q("SELECT dedupe_key, status, run_at FROM jobs WHERE kind = ? ORDER BY run_at", [ACCOUNT_CLEAR_KIND])).map(
      (r) => ({ key: String(r[0]), status: String(r[1]), runAt: Number(r[2]) }),
    );
  await ensureLifecycleSweep(db, T);
  return { db, caps, until, ingest, q, bodies, itemText, subject, found, kept, clears };
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
    // Searching finds it by its words, never by its code.
    expect(await s.found("481516")).toBe(0);
    expect(await s.found("button")).toBe(1);
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
});

describe("what counts as a code or a link", () => {
  it("is a code of digits or of capitals and digits, and any link; a word, a year, a date, a time or an amount stays", () => {
    const said = (text: string) => clearCodes(text).text;
    expect(said("Your verification code is 481516.")).toBe(`Your verification code is ${CLEARED}.`);
    expect(said("481516 is your code")).toBe(`${CLEARED} is your code`);
    expect(said("Code: 123 456, or 4821-9375")).toBe(`Code: ${CLEARED}, or ${CLEARED}`);
    expect(said("Use G-482913, X7K9Q2 or XK7-93Q")).toBe(`Use ${CLEARED}, ${CLEARED} or ${CLEARED}`);
    expect(said("Open www.acme.example/login or https://acme.example/a?b=1.")).toBe(`Open ${CLEARED} or ${CLEARED}.`);
    const plain =
      "On 2026-11-01 at 10:30 you paid €45 and $1500.00. SIGN IN NOW, © 2026 Acme. Your code expires in 1 hour.";
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
