import { describe, expect, it } from "vitest";
import { NO_MATCH, type SharedMatch, type SharedPrint, type SharedSpamPort } from "../../src/spam/shared";
import type { Filter } from "../../src/spam/types";
import { agent, classPayload, DAY, HOUR, hostPolicy, idOf, MIN, owner, spamSetup, T0, visitor } from "./harness";

/**
 * Known spam shared between a host's inboxes, as one inbox lives it (ADR-041 §16): it reads a match by
 * its fingerprint as a stranger's request arrives, and labels or puts aside as its filters say; a
 * person's Spam, or what the filter is sure of, is reported, a Not spam on a match is a word against
 * it; nothing but bands and a company domain ever reaches the host's port; and nothing at all where the
 * host offers no shared list.
 */

const PITCH =
  "Hello! We help cafés like yours reach the first page of Google within 30 days. Our team has helped 250 businesses grow. Reply for a free audit of your website and your listing.";
const PITCH_WORDS = /google|audit|cafés|businesses|website/i;
const pitcher = { name: "Growth Team", email: "growth@growth-agency.example" };

interface Reported {
  readonly itemId: string;
  readonly print: SharedPrint;
  readonly vote: 1 | -1;
  readonly kind: Filter | null;
}

/** The host's shared list, as a test sets it: what a lookup answers, and everything the inbox told it. */
function fakeShared(o: { contributes?: boolean; match?: SharedMatch; fail?: boolean } = {}) {
  const lookups: SharedPrint[] = [];
  const reports: Reported[] = [];
  const withdrawn: string[] = [];
  const port: SharedSpamPort = {
    contributes: o.contributes ?? true,
    lookup(print) {
      lookups.push(print);
      if (o.fail) throw new Error("the ledger is busy");
      return o.match ?? NO_MATCH;
    },
    report(itemId, print, r) {
      reports.push({ itemId, print, vote: r.vote, kind: r.kind });
    },
    withdraw(itemId) {
      withdrawn.push(itemId);
    },
  };
  return { port, lookups, reports, withdrawn };
}

const KNOWN: SharedMatch = { known: true, owners: 4, kind: "pitches", domain: false };

const form = (t: number, trap = false) => ({
  screen: { door: "form" as const, form: { key: "valid" as const, trap, drawnAt: t - 90_000 } },
});

async function setup(o: Parameters<typeof spamSetup>[0] & { shared?: ReturnType<typeof fakeShared> } = {}) {
  const s = await spamSetup(o);
  const shared = o.shared ?? fakeShared();
  s.caps.spam.attach({ shared: shared.port });
  const send = async (t: number, body = PITCH, contact = pitcher, trap = false) =>
    idOf(await s.caps.sendMessage(visitor(t), { body, contact }, form(t, trap)));
  const verdict = async (id: string) =>
    (
      await s.q(
        "SELECT i.screen, v.verdict, v.cause FROM items i JOIN spam_verdicts v ON v.item_id = i.id WHERE i.id = ?",
        [id],
      )
    )[0];
  const shareJobs = async () => Number((await s.q("SELECT COUNT(*) FROM jobs WHERE kind = 'spam_share'"))[0]?.[0]);
  return { ...s, shared, send, verdict, shareJobs };
}

const free = () => hostPolicy({ plan: "free", ai: false, filters: [], defaultOn: false });

describe("a match on the shared list", () => {
  it("labels a Free inbox's message, and puts nothing aside", async () => {
    const s = await setup({ host: free(), shared: fakeShared({ match: KNOWN }) });
    const id = await s.send(T0);
    expect(await s.verdict(id)).toEqual(["warned", "warn", "shared_spam"]);
    expect(await s.q("SELECT json_extract(flags, '$.spamLabel') FROM items WHERE id = ?", [id])).toEqual([
      ["shared_spam"],
    ]);
    // What went to the host: eight bands, no word of the message.
    expect(s.shared.lookups).toHaveLength(1);
    expect(JSON.stringify(s.shared.lookups)).not.toMatch(PITCH_WORDS);
  });

  it("on Pro, does what the filter it is under is set to: labels in its learning week, puts aside after", async () => {
    const learning = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN }) });
    await learning.q("UPDATE spam_filter_spans SET learning_until = ? WHERE filter = 'pitches'", [T0 + DAY]);
    expect(await learning.verdict(await learning.send(T0))).toEqual(["warned", "warn", "pitches"]);
    const after = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN }) });
    const aside = await after.send(T0);
    expect(await after.verdict(aside)).toEqual(["aside", "aside", "pitches"]);
    // Put aside by the match alone, it is not reported again: the list never feeds itself.
    expect(await after.shareJobs()).toBe(0);
    const label = await setup({ filters: ["pitches"], choice: "label", shared: fakeShared({ match: KNOWN }) });
    expect(await label.verdict(await label.send(T0))).toEqual(["warned", "warn", "pitches"]);
  });

  it("only labels on Pro when the filter it is under is off", async () => {
    const s = await setup({ filters: ["scams"], shared: fakeShared({ match: KNOWN }) });
    expect(await s.verdict(await s.send(T0))).toEqual(["warned", "warn", "shared_spam"]);
  });

  it("only labels a booking's note, never holds it alone", async () => {
    const s = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN }) });
    const notes =
      "Could we have the table by the window, please? We are celebrating a birthday and would love a quiet corner if you have one.";
    const b = await s.caps.createBooking(
      visitor(T0),
      { payload: { ...classPayload(s.svc), notes }, contact: { name: "Rui Costa", email: "rui@costa.example" } },
      form(T0),
    );
    expect((await s.verdict(idOf(b)))?.[0]).toBe("warned");
  });

  it("is not looked for when the business knows the sender, and a list that fails delivers as if there were none", async () => {
    const known = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN }) });
    await known.q(
      "INSERT INTO spam_lists (list, kind, value, party_id, item_id, by_user, created_at) VALUES ('allow', 'agent_key', 'kKnown', NULL, NULL, 'user_1', ?)",
      [T0],
    );
    const m = await known.caps.sendMessage(agent(T0, { key: "kKnown" }), { body: PITCH, contact: pitcher });
    expect(await known.q("SELECT screen FROM items WHERE id = ?", [idOf(m)])).toEqual([[null]]);
    expect(known.shared.lookups).toHaveLength(0);

    const down = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN, fail: true }) });
    expect((await down.verdict(await down.send(T0)))?.[0]).toBe("delivered");
    expect(down.shared.lookups).toHaveLength(1);
  });
});

describe("what an inbox tells the shared list", () => {
  it("reports a person's Spam, with the fingerprint only, by a job after the mark", async () => {
    const s = await setup({ filters: ["pitches"] });
    const id = await s.send(T0);
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    expect(s.shared.reports).toHaveLength(0);
    await s.drain(T0 + 2 * MIN);
    // Under the filter whose phrases labelled it.
    expect(s.shared.reports).toEqual([{ itemId: id, print: expect.any(Object), vote: 1, kind: "pitches" }]);
    const sent = s.shared.reports[0]?.print;
    expect(sent?.bands).toHaveLength(8);
    // A form's typed address names no domain: anyone can type one.
    expect(sent?.domain).toBeNull();
    expect(JSON.stringify(s.shared.reports)).not.toMatch(PITCH_WORDS);
    expect(JSON.stringify(s.shared.reports)).not.toContain("growth@");
  });

  it("names the sender's domain only where a mail server vouched for the address", async () => {
    const s = await setup({ filters: ["pitches"] });
    const m = await s.caps.sendMessage(
      visitor(T0),
      { body: PITCH, contact: pitcher },
      { screen: { door: "email", email: { serverMarked: false, auth: { dmarc: "pass" } } } },
    );
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: idOf(m), event: "mark_spam" });
    await s.drain(T0 + 2 * MIN);
    expect(s.shared.reports[0]?.print.domain).toBe("growth-agency.example");
  });

  it("reports what the filter is sure of on its own: a bot's form", async () => {
    const s = await setup({ filters: ["pitches"] });
    const id = await s.send(T0, PITCH, pitcher, true);
    expect((await s.verdict(id))?.slice(1)).toEqual(["aside", "trap"]);
    await s.drain(T0 + MIN);
    expect(s.shared.reports.map((r) => [r.itemId, r.vote])).toEqual([[id, 1]]);
  });

  it("says Not spam against a match it had labelled, and takes back its own Spam when a person changes their mind", async () => {
    const s = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN }) });
    const matched = await s.send(T0);
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: matched, event: "unspam" });
    await s.drain(T0 + 2 * MIN);
    expect(s.shared.reports.map((r) => [r.itemId, r.vote])).toEqual([[matched, -1]]);

    const plain = await setup({ filters: ["pitches"] });
    const id = await plain.send(T0);
    await plain.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    await plain.caps.transitionItem(owner(T0 + 2 * MIN), { item_id: id, event: "unspam" });
    await plain.drain(T0 + 3 * MIN);
    // The job reads the item as it is when it runs: the last word is Not spam, with no match to speak against.
    expect(plain.shared.reports).toEqual([]);
    expect(plain.shared.withdrawn).toContain(id);
  });

  it("tells nothing from an inbox whose marks don't count for others, and reads all the same", async () => {
    const s = await setup({ host: free(), shared: fakeShared({ contributes: false }) });
    const id = await s.send(T0);
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    await s.send(T0 + HOUR, PITCH, { name: "Bot", email: "bot@bots.example" }, true);
    expect(await s.shareJobs()).toBe(0);
    await s.drain(T0 + 2 * HOUR);
    expect(s.shared.reports).toEqual([]);
    expect(s.shared.lookups.length).toBe(2);
  });

  it("takes back what it said of a customer who is erased", async () => {
    const s = await setup({ filters: ["pitches"] });
    const id = await s.send(T0);
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    await s.drain(T0 + 2 * MIN);
    const party = (await s.q("SELECT party_id FROM items WHERE id = ?", [id]))[0]?.[0] as string;
    const asked = await s.caps.customers.erase(owner(T0 + DAY), { party_id: party }).catch((e) => e);
    await s.caps.customers.erase(owner(T0 + DAY), { party_id: party, confirm: asked.details.confirm });
    await s.drain(T0 + DAY + MIN);
    expect(s.shared.withdrawn).toContain(id);
  });
});

describe("where the shared list is said", () => {
  it("Settings knows whether the inbox reads it and counts for others", async () => {
    const pro = await setup({ host: hostPolicy() });
    expect((await pro.caps.spam.status(owner(T0), T0)).shared).toBe("reads_and_shares");
    const reads = await setup({ host: free(), shared: fakeShared({ contributes: false }) });
    expect((await reads.caps.spam.status(owner(T0), T0)).shared).toBe("reads");
    reads.caps.spam.attach({ shared: null });
    expect((await reads.caps.spam.status(owner(T0), T0)).shared).toBe("off");
  });
});
