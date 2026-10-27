import { describe, expect, it } from "vitest";
import { NO_MATCH, type SharedMatch, type SharedPrint, type SharedSpamPort } from "../../src/spam/shared";
import type { Filter } from "../../src/spam/types";
import { agent, classPayload, DAY, HOUR, hostPolicy, idOf, MIN, owner, spamSetup, T0, visitor } from "./harness";

/**
 * Known spam shared between a host's inboxes, as one inbox lives it (ADR-041 §16): it reads a match by
 * its fingerprint as a stranger's request arrives; the match alone only labels, and puts a message aside
 * only beside a signal of the inbox's own or the AI's; a person's Spam, or what the filter is sure of,
 * is reported from a Pro inbox, a Not spam on a match from any inbox; nothing but bands and a company
 * domain a mail server vouched for ever reaches the host's port; and nothing at all where the host
 * offers no shared list.
 */

const PITCH =
  "Hello! We help cafés like yours reach the first page of Google within 30 days. Our team has helped 250 businesses grow. Reply for a free audit of your website and your listing.";
const PITCH_WORDS = /google|audit|cafés|businesses|website/i;
/** A pitch this inbox's own phrases label on their own: two families of them, three points. */
const HARD_PITCH =
  "Hello! We help cafés like yours reach the first page of Google within 30 days, and we publish a guest post with a backlink on our partner blogs every month. Reply for a free audit of your website.";
const pitcher = { name: "Growth Team", email: "growth@growth-agency.example" };
/** A message nothing in this inbox's own checks finds anything in: only the shared list can speak of it. */
const PLAIN =
  "Good morning, could you tell me whether you have room for a small private gathering next month? We would be about twelve people, and would like coffee and cakes in the afternoon.";

interface Reported {
  readonly itemId: string;
  readonly print: SharedPrint;
  readonly vote: 1 | -1;
  readonly kind: Filter | null;
}

/** The host's shared list, as a test sets it: what a lookup answers, and everything the inbox told it. */
function fakeShared(o: { contributes?: boolean; disputes?: boolean; match?: SharedMatch; fail?: boolean } = {}) {
  const lookups: SharedPrint[] = [];
  const reports: Reported[] = [];
  const withdrawn: string[] = [];
  const port: SharedSpamPort = {
    contributes: o.contributes ?? true,
    disputes: o.disputes ?? true,
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
/** The text and the sender's company domain both known: the most the shared list ever says. */
const KNOWN_ALL: SharedMatch = { ...KNOWN, domain: true };

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
  const label = async (s: Awaited<ReturnType<typeof setup>>, id: string) =>
    (await s.q("SELECT json_extract(flags, '$.spamLabel') FROM items WHERE id = ?", [id]))[0]?.[0];

  it("labels a Free inbox's message, and puts nothing aside, even with the sender's domain known", async () => {
    const s = await setup({ host: free(), shared: fakeShared({ match: KNOWN_ALL }) });
    const id = await s.send(T0);
    expect(await s.verdict(id)).toEqual(["warned", "warn", "shared_spam"]);
    expect(await label(s, id)).toBe("shared_spam");
    // What went to the host: eight bands, no word of the message.
    expect(s.shared.lookups).toHaveLength(1);
    expect(JSON.stringify(s.shared.lookups)).not.toMatch(PITCH_WORDS);
  });

  it("never holds a Free inbox's booking, nor puts aside what came with a domain typed at the form", async () => {
    const s = await setup({ host: free(), shared: fakeShared({ match: KNOWN_ALL }) });
    const notes =
      "Could we have the table by the window, please? We are celebrating a birthday and would love a quiet corner if you have one.";
    const b = await s.caps.createBooking(
      visitor(T0),
      { payload: { ...classPayload(s.svc), notes }, contact: pitcher },
      form(T0),
    );
    expect((await s.verdict(idOf(b)))?.[0]).toBe("warned");
    // The address was typed at a form: no domain was looked up, so none counted.
    expect(s.shared.lookups.map((p) => p.domain)).toEqual([null]);
    const signals = JSON.parse(
      String((await s.q("SELECT signals FROM spam_verdicts WHERE item_id = ?", [idOf(b)]))[0]?.[0]),
    ) as { c: string }[];
    expect(signals.map((x) => x.c)).not.toContain("shared_domain");
  });

  it("looks a sender's domain up only where a mail server vouched for the address", async () => {
    const s = await setup({ host: free(), shared: fakeShared({ match: KNOWN_ALL }) });
    const email = (dmarc: string) => ({
      screen: { door: "email" as const, email: { serverMarked: false, auth: { dmarc } } },
    });
    await s.caps.sendMessage(visitor(T0), { body: PLAIN, contact: pitcher }, email("pass"));
    await s.caps.sendMessage(visitor(T0), { body: PLAIN, contact: pitcher }, email("none"));
    await s.caps.sendMessage(agent(T0), { body: PLAIN, contact: pitcher });
    expect(s.shared.lookups.map((p) => p.domain)).toEqual(["growth-agency.example", null, null]);
    // Vouched, with its domain known as well: still a label, and nothing put aside.
    const screens = await s.q("SELECT screen FROM items WHERE type = 'message' ORDER BY created_at");
    expect(screens.every(([screen]) => screen === "warned")).toBe(true);
  });

  it("only labels on Pro when the filter it is under is off", async () => {
    const s = await setup({ filters: ["scams"], shared: fakeShared({ match: KNOWN_ALL }) });
    const id = await s.send(T0, PLAIN);
    expect(await s.verdict(id)).toEqual(["warned", "warn", "shared_spam"]);
    expect(await label(s, id)).toBe("shared_spam");
  });

  it("only labels on Pro with the filter on and past its learning week, when nothing else here speaks", async () => {
    const s = await setup({ filters: ["pitches", "scams", "junk"], shared: fakeShared({ match: KNOWN_ALL }) });
    const id = await s.send(T0, PLAIN);
    expect(await s.verdict(id)).toEqual(["warned", "warn", "shared_spam"]);
    // A label is all it was: nothing to report, the list never feeds itself.
    expect(await s.shareJobs()).toBe(0);
  });

  it("adds to what the inbox's own checks found: together they put a message aside on Pro", async () => {
    // The pitch's own phrases label it here; with the match beside them, it is put aside.
    const alone = await setup({ filters: ["pitches"] });
    expect((await alone.verdict(await alone.send(T0, HARD_PITCH)))?.[0]).toBe("warned");
    const both = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN }) });
    const aside = await both.send(T0, HARD_PITCH);
    expect((await both.verdict(aside))?.slice(0, 2)).toEqual(["aside", "aside"]);
    // Points, the match's among them, are no proof: it is not reported again.
    expect(await both.shareJobs()).toBe(0);
  });

  it("with the inbox's own signal beside it, still only labels in the filter's learning week or on Just label", async () => {
    const learning = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN }) });
    await learning.q("UPDATE spam_filter_spans SET learning_until = ? WHERE filter = 'pitches'", [T0 + DAY]);
    expect((await learning.verdict(await learning.send(T0, HARD_PITCH)))?.[0]).toBe("warned");
    const label = await setup({ filters: ["pitches"], choice: "label", shared: fakeShared({ match: KNOWN }) });
    expect((await label.verdict(await label.send(T0, HARD_PITCH)))?.[0]).toBe("warned");
  });

  it("adds to what the free protection found on Free: together they put a message aside", async () => {
    const s = await setup({ host: free(), shared: fakeShared({ contributes: false, match: KNOWN }) });
    const id = await s.send(T0, `${PLAIN} [url=https://deals.example]See the menu[/url]`);
    const signals = JSON.parse(
      String((await s.q("SELECT signals FROM spam_verdicts WHERE item_id = ?", [id]))[0]?.[0]),
    ) as { c: string; w: number }[];
    const own = signals.filter((x) => !x.c.startsWith("shared_")).reduce((n, x) => n + x.w, 0);
    expect(own).toBeGreaterThanOrEqual(3);
    expect((await s.verdict(id))?.[0]).toBe("aside");
  });

  it("only labels a booking's note on Pro, never holds it, whatever else is known", async () => {
    const s = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN_ALL }) });
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
    expect((await down.verdict(await down.send(T0, PLAIN)))?.[0]).toBe("delivered");
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

  it("names the kind a match counted under when a person marks it as spam", async () => {
    const s = await setup({ filters: ["pitches"], shared: fakeShared({ match: KNOWN }) });
    const id = await s.send(T0, PLAIN);
    expect((await s.verdict(id))?.[2]).toBe("shared_spam");
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    await s.drain(T0 + 2 * MIN);
    expect(s.shared.reports.map((r) => [r.itemId, r.vote, r.kind])).toEqual([[id, 1, "pitches"]]);
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
    // Labelled by the match alone, a person says it looks fine; put aside by the match and the pitch's
    // own phrases, a person says Not spam.
    const matched = await s.send(T0, PLAIN);
    const aside = await s.send(T0, HARD_PITCH, { name: "Growth", email: "hello@growth-two.example" });
    expect((await s.verdict(aside))?.[0]).toBe("aside");
    await s.caps.spam.looksFine(owner(T0 + MIN), { item_id: matched }, T0 + MIN);
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: aside, event: "unspam" });
    await s.drain(T0 + 2 * MIN);
    expect(s.shared.reports.map((r) => [r.itemId, r.vote])).toEqual([
      [matched, -1],
      [aside, -1],
    ]);

    const plain = await setup({ filters: ["pitches"] });
    const id = await plain.send(T0);
    await plain.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    await plain.caps.transitionItem(owner(T0 + 2 * MIN), { item_id: id, event: "unspam" });
    await plain.drain(T0 + 3 * MIN);
    // The job reads the item as it is when it runs: the last word is Not spam, with no match to speak against.
    expect(plain.shared.reports).toEqual([]);
    expect(plain.shared.withdrawn).toContain(id);
  });

  it("from a Free inbox, reports no Spam and nothing it is sure of, but its Not spam on a match counts", async () => {
    const s = await setup({ host: free(), shared: fakeShared({ contributes: false, match: NO_MATCH }) });
    const id = await s.send(T0);
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: id, event: "mark_spam" });
    // A bot's form, put aside and sure: a Free inbox's is its own.
    await s.send(T0 + HOUR, PITCH, { name: "Bot", email: "bot@bots.example" }, true);
    await s.drain(T0 + 2 * HOUR);
    expect(s.shared.reports).toEqual([]);
    expect(s.shared.lookups.length).toBe(2);

    const answers = await setup({ host: free(), shared: fakeShared({ contributes: false, match: KNOWN }) });
    const matched = await answers.send(T0, PLAIN);
    await answers.caps.spam.looksFine(owner(T0 + MIN), { item_id: matched }, T0 + MIN);
    await answers.drain(T0 + 2 * MIN);
    expect(answers.shared.reports.map((r) => [r.itemId, r.vote, r.kind])).toEqual([[matched, -1, null]]);
    expect(JSON.stringify(answers.shared.reports)).not.toMatch(/gathering|coffee|cakes/i);
  });

  it("tells nothing from an inbox that can't be written to, and reads all the same", async () => {
    const s = await setup({ host: free(), shared: fakeShared({ contributes: false, disputes: false, match: KNOWN }) });
    const id = await s.send(T0, PLAIN);
    await s.caps.spam.looksFine(owner(T0 + MIN), { item_id: id }, T0 + MIN);
    expect(await s.shareJobs()).toBe(0);
    await s.drain(T0 + 2 * MIN);
    expect(s.shared.reports).toEqual([]);
    expect(s.shared.lookups.length).toBe(1);
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

  it("the privacy page says each new message is compared, what this business shares, and only while it does", async () => {
    const section = async (x: Awaited<ReturnType<typeof setup>>, lang: "en" | "pt") =>
      (await x.caps.customer.privacy({ lang })).sections?.find((y) => /spam/i.test(y.heading));
    // An inbox that only reads (Free): its own Spam marks stay its own.
    const reads = await setup({ host: free(), shared: fakeShared({ contributes: false }) });
    expect((await section(reads, "en"))?.paragraphs).toEqual([
      "To keep out spam, the provider that handles our messages compares a fingerprint of each new message from someone we haven't heard from before with the fingerprints of messages the other businesses it serves marked as spam. We don't share the fingerprints of messages we mark as spam; when one that matched turns out not to be spam, we say so, by its fingerprint. A fingerprint can't be turned back into the message.",
    ]);
    expect((await section(reads, "pt"))?.paragraphs[0]).toContain("Não partilhamos as impressões digitais");
    // An inbox whose marks count for others (Pro, live).
    const shares = await setup({ host: hostPolicy({ ai: false }), shared: fakeShared({ contributes: true }) });
    const en = (await section(shares, "en"))?.paragraphs ?? [];
    expect(en.at(-1)).toBe(
      "To keep out spam, the provider that handles our messages compares a fingerprint of each new message from someone we haven't heard from before with the fingerprints of messages the other businesses it serves marked as spam, and shares with them the fingerprints of messages we mark as spam, or of ones that matched but weren't. A fingerprint can't be turned back into the message.",
    );
    for (const x of [reads, shares]) {
      for (const lang of ["en", "pt"] as const) {
        const text = JSON.stringify(await section(x, lang));
        expect(text).toMatch(/não permite reconstituir a mensagem|can't be turned back into the message/);
        // The business's customers are told nothing of whose product it is.
        expect(text).not.toMatch(/Surfing Dog|Anthropic/);
      }
    }
    reads.caps.spam.attach({ shared: null });
    expect(await section(reads, "en")).toBeUndefined();
  });
});
