import {
  type Caller,
  createRunner,
  OWNER_ACCOUNT_ALERTS_PER_HOUR,
  OWNER_ALERTS_PER_HOUR,
  OWNER_DIGEST_KIND,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { ingestEmail, type MailAuth } from "../src/email";
import { freshDb } from "./db";

/**
 * The owner's alert about an account's code or sign-in link is never held for the end of the hour by
 * the cap of 20 alerts: the owner needs a code now. Those alerts count apart from the others, so
 * neither holds the other back, and have a bound of their own, 30 an hour, so a flood of notices
 * that only look real cannot fill the owner's mailbox. Node and workerd.
 */

const INBOUND = "oficina-mare@in.example.net";
const OWNER = "rui@personal.example";
const T = Date.parse("2026-11-01T09:00:00Z");
const VOUCHED: MailAuth = { spf: "pass", dkim: [], dmarc: "pass" };

const owner: Caller = {
  actor: { kind: "owner", id: "user_owner", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T,
};

const raw = (headers: Record<string, string>, text: string) =>
  `${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;

/** A sign-in code from a service of its own, its domain vouched for. */
const notice = (i: number) =>
  raw(
    {
      From: `Service ${i} <no-reply@mail.service${i}.example>`,
      To: "support@oficinamare.example",
      Subject: `Your sign-in code for Service ${i}`,
      "Message-ID": `<n${i}@mail.service${i}.example>`,
    },
    `Your sign-in code is ${100000 + i}.`,
  );

/** A customer's question, each from a place of their own. */
const question = (i: number) =>
  raw(
    {
      From: `Customer ${i} <c${i}@shop${i}.example>`,
      To: "support@oficinamare.example",
      Subject: `Question ${i}`,
      "Message-ID": `<q${i}@shop${i}.example>`,
    },
    `Do you fix wheels? (${i})`,
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
  const drain = async () => {
    clock += 60_000;
    for (let i = 0; i < 40; i++) if ((await runner.runDue(db, { now: clock, limit: 100 })).claimed === 0) return;
  };
  const ingest = async (message: string) => {
    const r = await ingestEmail(db, caps, { raw: message, envelopeTo: INBOUND, auth: VOUCHED }, { now: () => clock });
    expect(r.outcome).toBe("created");
  };
  const toOwner = (what: RegExp) => mail.sent.filter((m) => m.to.includes(OWNER) && what.test(m.subject));
  const held = async () =>
    Number(
      (
        await db.client.query({
          sql: "SELECT count(*) FROM outbound_mail WHERE recipient = 'owner' AND skip_reason = 'alert_limit'",
          method: "all",
        })
      ).rows[0]?.[0],
    );
  const digests = async () =>
    Number(
      (
        await db.client.query({
          sql: "SELECT count(*) FROM jobs WHERE kind = ?",
          params: [OWNER_DIGEST_KIND],
          method: "all",
        })
      ).rows[0]?.[0],
    );
  return { drain, ingest, toOwner, held, digests };
}

describe("an account's sign-in alert", () => {
  it("reaches the owner at once though the hour's alerts are spent, and holds no other alert back", async () => {
    const s = await setUp();
    const extra = 3;
    for (let i = 0; i < OWNER_ALERTS_PER_HOUR + extra; i++) await s.ingest(question(i));
    await s.drain();
    expect(s.toOwner(/Question/)).toHaveLength(OWNER_ALERTS_PER_HOUR);
    expect(await s.held()).toBe(extra);

    // The hour's alerts are spent: a code still reaches the owner, whole, at once.
    for (let i = 0; i < 5; i++) await s.ingest(notice(i));
    await s.drain();
    const codes = s.toOwner(/sign-in code/);
    expect(codes).toHaveLength(5);
    expect(codes[0]?.text).toContain("100000");
    expect(await s.held()).toBe(extra);

    // And the other way round: codes first, then as many questions as ever.
    const t = await setUp();
    for (let i = 0; i < 10; i++) await t.ingest(notice(i));
    await t.drain();
    for (let i = 0; i < OWNER_ALERTS_PER_HOUR; i++) await t.ingest(question(i));
    await t.drain();
    expect(t.toOwner(/sign-in code/)).toHaveLength(10);
    expect(t.toOwner(/Question/)).toHaveLength(OWNER_ALERTS_PER_HOUR);
    expect(await t.held()).toBe(0);
    expect(await t.digests()).toBe(0);
  }, 60_000);

  it("is bounded: past 30 an hour, notices that only look real wait for the hour's digest", async () => {
    const s = await setUp();
    const extra = 4;
    for (let i = 0; i < OWNER_ACCOUNT_ALERTS_PER_HOUR + extra; i++) await s.ingest(notice(i));
    await s.drain();
    expect(s.toOwner(/sign-in code/)).toHaveLength(OWNER_ACCOUNT_ALERTS_PER_HOUR);
    expect(await s.held()).toBe(extra);
    expect(await s.digests()).toBe(1);
    // A customer's question still has the hour's own room.
    await s.ingest(question(1));
    await s.drain();
    expect(s.toOwner(/Question/)).toHaveLength(1);
  }, 60_000);
});
