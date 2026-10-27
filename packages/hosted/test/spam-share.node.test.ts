import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type SharedPrint, sharedPrintOf } from "@surfingdog/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEDGER_TABLES, Ledger } from "../src/ledger";
import {
  SHARE_ACCOUNT_AGE_MS,
  SHARE_KEEP_MS,
  SHARE_WINDOW_MS,
  type SharedPrints,
  tenantShare,
} from "../src/spam-share";
import type { PolicyPayload } from "../src/types";
import { type FakeTenant, type Runtime, startRuntime } from "./harness";

/**
 * Known spam shared between the inboxes one runtime hosts (ADR-041 §16), in the ledger every shard
 * opens. A fingerprint counts for an inbox only once three other owners, with accounts a week old,
 * reported one like it within a fortnight; a person's Not spam on a match lowers it; everything is
 * forgotten after thirty days; and nothing kept is a word, an address or a value an inbox could match
 * without the runtime's key.
 */

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-27T09:00:00Z");

const PITCH =
  "Hello! We help cafés like yours reach the first page of Google within 30 days. Our team has helped 250 businesses grow. Reply for a free audit of your website and your listing.";
// Sent on to another business: other numbers, another link, one word changed.
const RESENT =
  "Hello! We help salons like yours reach the first page of Google within 14 days. Our team has helped 900 businesses grow. Reply for a free audit of your website and your listing: www.growth.example/a";
const OTHER =
  "Good afternoon, we are a family of four looking for a quiet table this Saturday evening, ideally near the window, and we would love to try the tasting menu if it is still on.";

const print = (text: string, domain: string | null = null): SharedPrint => ({
  bands: sharedPrintOf(text)?.bands ?? [],
  domain,
});

function ledgerAt(o: { key?: string; dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "sdh-share-"));
  const ledger = new Ledger(join(dir, "ledger.db"), { hashKey: o.key ?? "share-test-key" });
  return { dir, ledger, prints: ledger.shared };
}

/** Owners whose accounts are a month old, each with one inbox, unless a test says otherwise. */
function owners(prints: SharedPrints, n: number, since = T0 - 30 * DAY) {
  return Array.from({ length: n }, (_, i) => {
    const owner = prints.ownerOf({ owner_email: `owner${i}@business${i}.example` });
    prints.seen(owner, since);
    return owner;
  });
}

const report = (
  prints: SharedPrints,
  owner: string,
  o: { tenant?: string; item?: string; text?: string; at?: number; vote?: 1 | -1; domain?: string | null } = {},
) =>
  prints.report({
    tenantId: o.tenant ?? `tn_${owner.slice(0, 6)}`,
    itemId: o.item ?? `it_${Math.random().toString(36).slice(2)}`,
    owner,
    print: print(o.text ?? PITCH, o.domain ?? null),
    vote: o.vote ?? 1,
    kind: "pitches",
    now: o.at ?? T0,
  });

describe("the threshold", () => {
  it("is three owners other than the reader's: two are not enough, and a fourth owner reads it known", () => {
    const { prints, ledger } = ledgerAt();
    const [a, b, c, reader] = owners(prints, 4) as [string, string, string, string];
    report(prints, a);
    report(prints, b, { at: T0 + DAY });
    const look = (at: number, who = reader) => prints.lookup({ print: print(RESENT), owner: who, now: at });
    expect(look(T0 + 2 * DAY)).toMatchObject({ known: false, owners: 2 });
    report(prints, c, { at: T0 + 2 * DAY });
    expect(look(T0 + 3 * DAY)).toEqual({ known: true, owners: 3, kind: "pitches", domain: false });
    // A reporter's own inbox counts the others only.
    expect(look(T0 + 3 * DAY, a)).toMatchObject({ known: false, owners: 2 });
    // A text that is not the same message is no match.
    expect(prints.lookup({ print: print(OTHER), owner: reader, now: T0 + 3 * DAY }).known).toBe(false);
    ledger.close();
  });

  it("counts an owner once, however many of their inboxes reported it", () => {
    const { prints, ledger } = ledgerAt();
    const [a, b, reader] = owners(prints, 3) as [string, string, string];
    report(prints, a, { tenant: "tn_a1" });
    report(prints, a, { tenant: "tn_a2" });
    report(prints, a, { tenant: "tn_a3" });
    report(prints, b);
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 + DAY })).toMatchObject({
      known: false,
      owners: 2,
    });
    // Two inboxes the control plane says are one account's are one owner, whatever their addresses.
    const one = prints.ownerOf({ owner_email: "x@one.example", owner_account: { id: "acc_1", created_at: "x" } });
    const same = prints.ownerOf({ owner_email: "y@two.example", owner_account: { id: "acc_1", created_at: "x" } });
    expect(one).toBe(same);
    ledger.close();
  });

  it("needs the three within one fortnight", () => {
    const { prints, ledger } = ledgerAt();
    const [a, b, c, reader] = owners(prints, 4) as [string, string, string, string];
    report(prints, a, { at: T0 });
    report(prints, b, { at: T0 + 8 * DAY });
    report(prints, c, { at: T0 + 8 * DAY + SHARE_WINDOW_MS / 2 + DAY });
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 + 20 * DAY }).known).toBe(false);
    report(prints, a, { at: T0 + 21 * DAY, item: "it_again" });
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 + 21 * DAY }).known).toBe(true);
    ledger.close();
  });
});

describe("abuse", () => {
  it("counts nothing from an account younger than a week, and keeps nothing of it", () => {
    const { prints, ledger } = ledgerAt();
    const [a, b] = owners(prints, 2);
    const fresh = owners(prints, 3, T0 - 6 * DAY).slice(2) as [string];
    const [young] = fresh;
    expect(report(prints, young)).toBe(false);
    expect(ledger.db.prepare("SELECT COUNT(*) AS n FROM spam_share_reports").get()).toEqual({ n: 0 });
    report(prints, a as string);
    report(prints, b as string);
    const reader = owners(prints, 5).at(-1) as string;
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 }).known).toBe(false);
    // A week on, the same owner counts.
    expect(report(prints, young, { at: T0 - 6 * DAY + SHARE_ACCOUNT_AGE_MS })).toBe(true);
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 + DAY }).known).toBe(true);
    ledger.close();
  });

  it("takes the account's age from the control plane when it says, and the first sight of it otherwise", () => {
    const { prints, ledger } = ledgerAt();
    const policy = (o: Partial<PolicyPayload>) =>
      ({ owner_email: "o@biz.example", plan: "pro", state: "live", read_only: false, ...o }) as PolicyPayload;
    const old = tenantShare({
      prints,
      tenantId: "tn_old",
      policy: policy({ owner_account: { id: "acc_old", created_at: "2026-01-02T00:00:00Z" } }),
      now: T0,
    });
    old.report("it_1", print(PITCH), { vote: 1, kind: null, now: T0 });
    const seenToday = tenantShare({
      prints,
      tenantId: "tn_new",
      policy: policy({ owner_email: "n@biz.example" }),
      now: T0,
    });
    seenToday.report("it_2", print(PITCH), { vote: 1, kind: null, now: T0 });
    expect(ledger.db.prepare("SELECT COUNT(*) AS n FROM spam_share_reports").get()).toEqual({ n: 1 });
    ledger.close();
  });

  it("lowers a fingerprint by every owner whose person said Not spam on a match of it", () => {
    const { prints, ledger } = ledgerAt();
    const [a, b, c, d, reader] = owners(prints, 5) as [string, string, string, string, string];
    for (const o of [a, b, c]) report(prints, o);
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 }).known).toBe(true);
    report(prints, d, { vote: -1, text: RESENT });
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 })).toMatchObject({ known: false, owners: 2 });
    ledger.close();
  });

  it("only labels on a Free inbox, and only a Pro inbox live at its own domain counts for others", () => {
    const { prints, ledger } = ledgerAt();
    const port = (o: Partial<PolicyPayload>) =>
      tenantShare({
        prints,
        tenantId: "tn_x",
        policy: { owner_email: "o@biz.example", state: "live", read_only: false, ...o } as PolicyPayload,
        now: T0,
      });
    expect(port({}).contributes).toBe(false);
    expect(port({ plan: "free" }).contributes).toBe(false);
    expect(port({ plan: "pro", state: "dns_pending" }).contributes).toBe(false);
    expect(port({ plan: "pro", state: "closing", read_only: true }).contributes).toBe(false);
    expect(port({ plan: "pro" }).contributes).toBe(true);
    // A Free inbox's word is not kept, whatever it says.
    port({ plan: "free" }).report("it_1", print(PITCH), { vote: 1, kind: null, now: T0 + 30 * DAY });
    expect(ledger.db.prepare("SELECT COUNT(*) AS n FROM spam_share_reports").get()).toEqual({ n: 0 });
    ledger.close();
  });
});

describe("what is kept", () => {
  it("forgets a fingerprint thirty days after it was reported", () => {
    const { prints, ledger } = ledgerAt();
    const [a, b, c, reader] = owners(prints, 4) as [string, string, string, string];
    for (const o of [a, b, c]) report(prints, o);
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 + SHARE_KEEP_MS - DAY }).known).toBe(true);
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 + SHARE_KEEP_MS + DAY }).known).toBe(false);
    prints.prune(T0 + SHARE_KEEP_MS + DAY);
    for (const table of ["spam_share_reports", "spam_share_bands"]) {
      expect(ledger.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    ledger.close();
  });

  it("is keyed hashes only: no word, address, band, domain, inbox or item as an inbox knew it", () => {
    const { dir, prints, ledger } = ledgerAt();
    const [a, b, c] = owners(prints, 3) as [string, string, string];
    const p = print(PITCH, "growth-agency.example");
    for (const o of [a, b, c]) {
      prints.report({
        tenantId: "tn_visible",
        itemId: `it_visible_${o.slice(0, 4)}`,
        owner: o,
        print: p,
        vote: 1,
        kind: "pitches",
        now: T0,
      });
    }
    const dump = ["spam_share_owners", "spam_share_reports", "spam_share_bands"]
      .map((t) => JSON.stringify(ledger.db.prepare(`SELECT * FROM ${t}`).all()))
      .join("\n");
    expect(dump).not.toMatch(/google|audit|cafés|growth|owner\d@|business\d|tn_visible|it_visible/i);
    for (const band of p.bands) expect(dump).not.toContain(band.slice(2));
    expect(LEDGER_TABLES).toEqual(expect.arrayContaining(["spam_share_reports", "spam_share_bands"]));
    // Another runtime's key matches nothing here, so no copy of the store can be matched without ours.
    ledger.close();
    const other = new Ledger(join(dir, "ledger.db"), { hashKey: "another-runtime-key" });
    const reader = other.shared.ownerOf({ owner_email: "reader@biz.example" });
    expect(other.shared.lookup({ print: p, owner: reader, now: T0 }).known).toBe(false);
    other.close();
  });

  it("takes back an inbox's word on an item, and a new word replaces the old", () => {
    const { prints, ledger } = ledgerAt();
    const [a, b, c, reader] = owners(prints, 4) as [string, string, string, string];
    for (const o of [a, b]) report(prints, o);
    report(prints, c, { tenant: "tn_c", item: "it_c" });
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 }).known).toBe(true);
    prints.withdraw("tn_c", "it_c");
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 }).known).toBe(false);
    report(prints, c, { tenant: "tn_c", item: "it_c" });
    report(prints, c, { tenant: "tn_c", item: "it_c", vote: -1 });
    expect(prints.lookup({ print: print(PITCH), owner: reader, now: T0 })).toMatchObject({ known: false, owners: 1 });
    ledger.close();
  });

  it("knows a sender's company domain three owners reported, whatever the words", () => {
    const { prints, ledger } = ledgerAt();
    const [a, b, c, reader] = owners(prints, 4) as [string, string, string, string];
    for (const o of [a, b, c]) report(prints, o, { domain: "growth-agency.example" });
    expect(prints.lookup({ print: print(OTHER, "growth-agency.example"), owner: reader, now: T0 })).toEqual({
      known: false,
      owners: 0,
      kind: null,
      domain: true,
    });
    expect(prints.lookup({ print: print(OTHER, "bistro.example"), owner: reader, now: T0 }).domain).toBe(false);
    ledger.close();
  });
});

describe("between hosted inboxes", () => {
  let rt: Runtime;
  beforeAll(async () => {
    rt = await startRuntime();
  });
  afterAll(async () => {
    await rt.close();
  });

  async function inbox(plan: PolicyPayload["plan"], account: string) {
    const t = await rt.createTenant();
    t.plan = plan;
    t.ownerAccount = { id: account, created_at: "2026-01-02T00:00:00Z" };
    await rt.setState(t, "live", { ownResolves: true });
    const host = t.ownHost ?? "";
    const cookie = await rt.signIn(t, host);
    return { t, host, owner: { cookie, "content-type": "application/json", origin: `https://${host}` } };
  }

  const send = (host: string, body: string, n: number) =>
    rt.http(host, "POST", "/v1/messages", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, contact: { name: "Growth Team", email: `growth${n}@agency-${n}.example` } }),
    });

  const verdicts = (t: FakeTenant) => {
    const file = new DatabaseSync(rt.shardOf(t).dbPath(t.tenantId));
    try {
      return file.prepare("SELECT item_id, verdict, cause FROM spam_verdicts ORDER BY created_at").all() as {
        item_id: string;
        verdict: string;
        cause: string | null;
      }[];
    } finally {
      file.close();
    }
  };

  async function settle(t: FakeTenant) {
    for (let i = 0; i < 20; i++) {
      await rt.shardOf(t).tick();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("labels on a Free inbox what three Pro businesses marked as spam, by its fingerprint only", async () => {
    const reporters = [await inbox("pro", "acc_a"), await inbox("pro", "acc_b"), await inbox("pro", "acc_c")];
    for (const [i, r] of reporters.entries()) {
      expect((await send(r.host, PITCH, i)).status).toBe(201);
      const id = verdicts(r.t)[0]?.item_id ?? "";
      const marked = await rt.http(r.host, "POST", `/v1/owner/items/${id}/transitions`, {
        headers: { ...r.owner, "idempotency-key": `mark-${i}` },
        body: JSON.stringify({ event: "mark_spam" }),
      });
      expect(marked.status, marked.text).toBe(200);
      await settle(r.t);
    }
    expect(rt.ledger.db.prepare("SELECT COUNT(*) AS n FROM spam_share_reports WHERE vote = 1").get()).toEqual({ n: 3 });

    const free = await inbox(undefined, "acc_d");
    expect((await send(free.host, RESENT, 9)).status).toBe(201);
    expect(verdicts(free.t)).toEqual([expect.objectContaining({ verdict: "warn", cause: "shared_spam" })]);
    // Settings says so, and that the inbox's own marks would count with Pro.
    const status = await rt.http(free.host, "GET", "/v1/owner/spam", { headers: { cookie: free.owner.cookie } });
    expect((status.json as { shared: string }).shared).toBe("reads");
    // The ledger every shard opens holds no word of it.
    const dump = JSON.stringify(rt.ledger.db.prepare("SELECT * FROM spam_share_reports").all());
    expect(dump).not.toMatch(/google|audit|growth|acc_/i);
  });
});
