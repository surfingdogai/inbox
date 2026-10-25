import { describe, expect, it } from "vitest";
import type { RuleDefinition } from "../../src/rules/schema";
import { addToListStatements } from "../../src/spam/lists";
import { normalise } from "../../src/spam/normalise";
import { namesOwnOffer } from "../../src/spam/screen";
import { transitionItem } from "../../src/write/transition";
import {
  agent,
  BASE,
  classPayload,
  DAY,
  fakeJudge,
  HOUR,
  idOf,
  MIN,
  owner,
  ownerAi,
  spamSetup,
  T0,
  visitor,
} from "./harness";

/**
 * The write path (ADR-029 §4.0): every effect of a stranger's request waits for its screening, until
 * a deadline; a verdict pulls them forward or cancels them; a held booking claims nothing; a release
 * runs each effect once; and a screening that never finishes loses nobody's request.
 */

const pitch = "Hello, we can get your café on the first page of Google with our SEO services. Reply for prices.";
const pitchAnswer = { kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["first page of Google"] };
const customerAnswer = { kind: "customer", certainty: "high", customer_intent: true, topic: "none", quotes: [] };

async function jobsOf(s: Awaited<ReturnType<typeof spamSetup>>, itemId: string) {
  const rows = await s.q("SELECT kind, run_at, status, dedupe_key FROM jobs WHERE payload LIKE ? ORDER BY dedupe_key", [
    `%${itemId}%`,
  ]);
  return rows.map((r) => ({ kind: String(r[0]), runAt: Number(r[1]), status: String(r[2]), key: String(r[3] ?? "") }));
}

const ownerMails = (s: Awaited<ReturnType<typeof spamSetup>>) =>
  s.mail.sent.filter((m) => m.to.includes("owner@kopisenja.example"));
const toCustomer = (s: Awaited<ReturnType<typeof spamSetup>>, address: string) =>
  s.mail.sent.filter((m) => m.to.includes(address));

describe("without filters", () => {
  it("delivers as before: every effect as today, the screening written down", async () => {
    const s = await spamSetup();
    const r = await s.caps.sendMessage(agent(T0), {
      body: "Do you still have the Toraja beans? I'd like two bags.",
      contact: { name: "Amara Okafor", email: "amara@example.org" },
    });
    const id = (r as { view: { item: { id: string } } }).view.item.id;
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [id])).toEqual([["delivered"]]);
    expect(await s.q("SELECT verdict, ai FROM spam_verdicts WHERE item_id = ?", [id])).toEqual([["deliver", "none"]]);
    const jobs = await jobsOf(s, id);
    expect(jobs.every((j) => j.runAt === T0)).toBe(true);
    expect(jobs.map((j) => j.kind).sort()).toEqual(["notify", "rules"]);
    await s.drain(T0);
    expect(ownerMails(s)).toHaveLength(1);
  });
});

describe("a request waiting on its AI check", () => {
  it("writes every effect with a deadline, and the verdict pulls them forward", async () => {
    const judge = fakeJudge(customerAnswer);
    const s = await spamSetup({ filters: ["pitches", "scams", "junk"], judge, listeners: true });
    const b = await s.caps.createBooking(agent(T0), {
      payload: classPayload(s.svc),
      contact: { name: "Kenji Watanabe", email: "kenji@example.jp" },
      message: "Can my daughter join too? She is twelve and loves coffee art.",
    });
    const id = b.view.item.id;
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [id])).toEqual([["pending"]]);
    const jobs = await jobsOf(s, id);
    const at = (kind: string, key: RegExp) => jobs.find((j) => j.kind === kind && key.test(j.key))?.runAt;
    expect(at("spam_screen", /^spam_screen:/)).toBe(T0);
    expect(at("notify", /:owner$/)).toBe(T0 + 60_000);
    expect(at("rules", /^rules:/)).toBe(T0 + 60_000);
    expect(at("webhook_fanout", /^fanout:/)).toBe(T0 + 60_000);
    expect(at("notify", /:customer$/)).toBe(T0 + 90_000);
    // One run: the check, and what it made due, in the same run.
    await s.runOnce(T0);
    expect(judge.calls).toHaveLength(1);
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [id])).toEqual([["delivered"]]);
    expect(ownerMails(s)).toHaveLength(1);
    expect((await jobsOf(s, id)).find((j) => j.kind === "webhook_fanout")?.status).toBe("done");
    expect(await s.q("SELECT verdict, ai, tokens_in FROM spam_verdicts WHERE item_id = ?", [id])).toEqual([
      ["deliver", "judged", 1800],
    ]);
  });

  it("labels: on Needs you, and a rule may only flag it", async () => {
    const s = await spamSetup({ filters: ["pitches"], judge: fakeJudge({ ...pitchAnswer, certainty: "medium" }) });
    await s.caps.setup.createRule(owner(T0), {
      name: "Confirm every request",
      priority: 10,
      enabled: true,
      definition: {
        on: ["item.created"],
        if: { path: "item.type", op: "eq", value: "message" },
        actions: [
          { action: "reply", template: "Thanks!", internal: false },
          { action: "set_flags", priority: 2 },
        ],
        stop: false,
        maxRunsPerItem: 1,
      } as RuleDefinition,
    });
    const r = await s.caps.sendMessage(agent(T0), {
      body: pitch,
      contact: { name: "Growth Team", email: "growth@agency.example.net" },
    });
    const id = (r as { view: { item: { id: string } } }).view.item.id;
    await s.drain(T0);
    expect(
      await s.q("SELECT screen, needs_human, json_extract(flags, '$.spamLabel'), priority FROM items WHERE id = ?", [
        id,
      ]),
    ).toEqual([["warned", 1, "pitches", 2]]);
    // The reply was skipped, and the owner reads why.
    expect(await s.q("SELECT COUNT(*) FROM thread_entries WHERE item_id = ? AND direction = 'out'", [id])).toEqual([
      [0],
    ]);
    expect(await s.q("SELECT COUNT(*) FROM item_events WHERE item_id = ? AND event = 'rule_skipped'", [id])).toEqual([
      [1],
    ]);
    expect(ownerMails(s)).toHaveLength(1);
  });

  it("puts a message aside: nobody told, nothing run, every effect cancelled", async () => {
    const s = await spamSetup({ filters: ["pitches"], judge: fakeJudge(pitchAnswer), listeners: true });
    const r = await s.caps.sendMessage(agent(T0), {
      body: pitch,
      contact: { name: "Growth Team", email: "growth@agency.example.net" },
    });
    const id = (r as { view: { item: { id: string } } }).view.item.id;
    await s.drain(T0 + 5 * MIN);
    expect(await s.q("SELECT state, screen FROM items WHERE id = ?", [id])).toEqual([["spam", "aside"]]);
    expect(ownerMails(s)).toHaveLength(0);
    const jobs = await jobsOf(s, id);
    expect(jobs.filter((j) => j.kind !== "spam_screen").every((j) => j.status === "done")).toBe(true);
    expect(await s.q("SELECT event, actor_kind FROM item_events WHERE item_id = ? ORDER BY seq", [id])).toEqual([
      ["create", "customer_agent"],
      ["mark_spam", "system"],
    ]);
  });

  it("holds a booking: no alert, no rule, no webhook, no slot; the acknowledgement asks them to confirm", async () => {
    const s = await spamSetup({ filters: ["pitches"], judge: fakeJudge(pitchAnswer), listeners: true });
    await s.caps.setup.createRule(owner(T0), {
      name: "Confirm bookings",
      priority: 10,
      enabled: true,
      definition: {
        on: ["item.created"],
        if: { path: "item.type", op: "eq", value: "booking" },
        actions: [{ action: "transition", event: "confirm" }],
        stop: false,
        maxRunsPerItem: 1,
      } as RuleDefinition,
    });
    const b = await s.caps.createBooking(agent(T0), {
      payload: classPayload(s.svc),
      contact: { name: "SEO Team", email: "seo@growth.example.net" },
      message: pitch,
    });
    const id = b.view.item.id;
    await s.drain(T0 + 5 * MIN);
    expect(await s.q("SELECT state, screen FROM items WHERE id = ?", [id])).toEqual([["requested", "held"]]);
    expect(ownerMails(s)).toHaveLength(0);
    expect(await s.q("SELECT COUNT(*) FROM slot_claims WHERE item_id = ?", [id])).toEqual([[0]]);
    expect((await jobsOf(s, id)).find((j) => j.kind === "webhook_fanout")?.status).toBe("done");
    const ack = toCustomer(s, "seo@growth.example.net");
    expect(ack).toHaveLength(1);
    expect(ack[0]?.text).toContain("Please confirm it's you, so we know your request reached the right person.");
    expect(ack[0]?.text).toMatch(new RegExp(`Confirm it's me: ${BASE}/c/[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{22}`));
    // The held booking holds no time: another customer books and is confirmed for the same one.
    const other = await s.caps.createBooking(agent(T0 + MIN, { key: "kOther0000000000000000000000000000000000000" }), {
      payload: classPayload(s.svc),
      contact: { name: "Lucía Fernández", email: "lucia@example.es" },
    });
    await s.drain(T0 + 6 * MIN);
    // The owner's rule confirms hers at once, its time free; the held one ran no rule.
    expect(await s.q("SELECT state FROM items WHERE id = ?", [other.view.item.id])).toEqual([["confirmed"]]);
    expect(await s.q("SELECT state FROM items WHERE id = ?", [id])).toEqual([["requested"]]);
  });

  it("goes on anyway when its screening never finishes, and a late verdict only labels", async () => {
    const s = await spamSetup({ filters: ["pitches"], judge: fakeJudge(pitchAnswer) });
    const r = await s.caps.sendMessage(agent(T0), {
      body: pitch,
      contact: { name: "Growth", email: "growth@agency.example.net" },
    });
    const id = (r as { view: { item: { id: string } } }).view.item.id;
    // The check never runs (its runner died with it).
    await s.q("UPDATE jobs SET status = 'dead' WHERE kind = 'spam_screen'");
    await s.drain(T0 + 30_000);
    expect(ownerMails(s)).toHaveLength(0);
    await s.drain(T0 + 61_000);
    expect(ownerMails(s)).toHaveLength(1);
    // It runs, late: the owner has seen it, so it can only label.
    await s.q("UPDATE jobs SET status = 'queued', run_at = ? WHERE kind = 'spam_screen'", [T0 + 70_000]);
    await s.drain(T0 + 70_000);
    expect(await s.q("SELECT state, screen, json_extract(flags, '$.spamLabel') FROM items WHERE id = ?", [id])).toEqual(
      [["open", "warned", "pitches"]],
    );
  });

  it("waits the rules a moment when something pulls them early, then runs them once it is decided", async () => {
    const judge = fakeJudge(customerAnswer);
    const s = await spamSetup({ filters: ["pitches"], judge });
    const r = await s.caps.sendMessage(agent(T0), {
      body: "Is the latte art class good for beginners? I've never steamed milk.",
      contact: { name: "Ngozi", email: "ngozi@example.ng" },
    });
    const id = (r as { view: { item: { id: string } } }).view.item.id;
    await s.q("UPDATE jobs SET run_at = ? WHERE kind = 'rules'", [T0]);
    await s.q("UPDATE jobs SET status = 'done' WHERE kind = 'spam_screen'");
    await s.drain(T0 + 1_000);
    expect(
      (await jobsOf(s, id)).filter((j) => j.kind === "rules").map((j) => [j.key.endsWith(":wait"), j.status]),
    ).toEqual([
      [false, "done"],
      [true, "queued"],
    ]);
  });
});

describe("letting it in", () => {
  async function held() {
    const s = await spamSetup({ filters: ["pitches"], judge: fakeJudge(pitchAnswer), listeners: true });
    const b = await s.caps.createBooking(agent(T0), {
      payload: classPayload(s.svc),
      contact: { name: "Pat Example", email: "pat@example.net" },
      message: pitch,
    });
    await s.drain(T0 + 5 * MIN);
    return { s, id: b.view.item.id };
  }

  it("runs each held effect once, however many times it is let in, and teaches the filter", async () => {
    const { s, id } = await held();
    expect(await s.caps.letIn(owner(T0 + 10 * MIN), { item_id: id })).toEqual({ released: true, time_passed: false });
    await expect(s.caps.letIn(owner(T0 + 11 * MIN), { item_id: id })).rejects.toMatchObject({ code: "wrong_state" });
    await s.drain(T0 + 12 * MIN);
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [id])).toEqual([["released"]]);
    const released = (await jobsOf(s, id)).filter((j) => j.key.endsWith(":released"));
    expect(released.map((j) => j.kind).sort()).toEqual(["rules", "webhook_fanout"]);
    expect(released.every((j) => j.status === "done")).toBe(true);
    // The owner let it in themselves: no alert about it.
    expect(ownerMails(s)).toHaveLength(0);
    expect(await s.q("SELECT list, kind, value FROM spam_lists")).toEqual([["allow", "address", "pat@example.net"]]);
    expect(await s.q("SELECT owner_verdict, released_by FROM spam_verdicts WHERE item_id = ?", [id])).toEqual([
      ["let_in", "owner"],
    ]);
    // From now on, Pat's own mail comes straight in; what anyone types under her address is still read.
    const mail = await s.caps.sendMessage(
      visitor(T0 + 20 * MIN),
      { body: "Thanks! See you at the class.", contact: { name: "Pat Example", email: "pat@example.net" } },
      { screen: { door: "email", email: { serverMarked: false, auth: { dmarc: "pass" } } } },
    );
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [idOf(mail)])).toEqual([[null]]);
    const typed = await s.caps.createBooking(agent(T0 + 21 * MIN), {
      payload: classPayload(s.svc, T0 + 4 * DAY + HOUR),
      contact: { name: "Pat Example", email: "pat@example.net" },
      message: pitch,
    });
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [typed.view.item.id])).not.toEqual([[null]]);
  });

  it("is a person's only: the owner's AI is told it waits for one", async () => {
    const { s, id } = await held();
    await expect(s.caps.letIn(ownerAi(T0 + 10 * MIN), { item_id: id })).rejects.toMatchObject({ code: "not_allowed" });
    await expect(
      s.caps.transitionItem(ownerAi(T0 + 10 * MIN), { item_id: id, event: "confirm" }),
    ).rejects.toMatchObject({ code: "not_allowed", details: { reason: "held" } });
    expect(await s.q("SELECT screen, state FROM items WHERE id = ?", [id])).toEqual([["held", "requested"]]);
  });

  it("lets it in when a person confirms it from the item, and the customer hears of it", async () => {
    const { s, id } = await held();
    await s.caps.transitionItem(owner(T0 + 10 * MIN), { item_id: id, event: "confirm" });
    await s.drain(T0 + 11 * MIN);
    expect(await s.q("SELECT screen, state FROM items WHERE id = ?", [id])).toEqual([["released", "confirmed"]]);
    expect(toCustomer(s, "pat@example.net").map((m) => m.subject)).toEqual([
      "We have your booking request",
      "Confirmed: Latte art class",
    ]);
  });

  it("says when the time asked for has passed", async () => {
    const { s, id } = await held();
    expect(await s.caps.letIn(owner(T0 + 4 * DAY), { item_id: id })).toEqual({ released: true, time_passed: true });
  });

  it("sends nothing while it lapses held, and lets in what lapsed all the same", async () => {
    const { s, id } = await held();
    const before = s.mail.sent.length;
    await s.drain(T0 + 3 * DAY + 2 * HOUR);
    const { rows } = await s.db.client.query({
      sql: "SELECT state FROM items WHERE id = ?",
      params: [id],
      method: "all",
    });
    const state = String(rows[0]?.[0]);
    if (state === "requested") {
      await transitionItem(
        s.db,
        {
          actor: { kind: "system", id: "lifecycle", channel: "system" },
          tier: "verified_principal",
          sandbox: false,
          now: () => T0 + 3 * DAY + 2 * HOUR,
        },
        { itemId: id, event: "expire" },
      );
      await s.drain(T0 + 3 * DAY + 3 * HOUR);
    }
    expect(await s.q("SELECT state, screen FROM items WHERE id = ?", [id])).toEqual([["expired", "held"]]);
    expect(s.mail.sent.length).toBe(before);
    expect(await s.caps.letIn(owner(T0 + 4 * DAY), { item_id: id })).toEqual({ released: true, time_passed: true });
  });

  it("goes on by itself when the sender confirms it is them, and the owner is told then", async () => {
    const { s, id } = await held();
    expect(await s.caps.spam.confirmFromSender(id, T0 + 20 * MIN)).toBe("released");
    expect(await s.caps.spam.confirmFromSender(id, T0 + 21 * MIN)).toBe("confirmed");
    await s.drain(T0 + 22 * MIN);
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [id])).toEqual([["released"]]);
    expect(await s.q("SELECT released_by FROM spam_verdicts WHERE item_id = ?", [id])).toEqual([["sender"]]);
    expect(ownerMails(s)).toHaveLength(1);
  });
});

describe("put aside at the door", () => {
  it("writes a bot's form message already put aside, with no job at all", async () => {
    const s = await spamSetup();
    const r = await s.caps.sendMessage(
      visitor(T0),
      {
        body: "Hello",
        contact: { name: "Bot", email: "bot@example.net" },
      },
      { screen: { door: "form", form: { key: "valid", trap: true, drawnAt: T0 - 30_000 } } },
    );
    const id = (r as { view: { item: { id: string } } }).view.item.id;
    expect(await s.q("SELECT state, screen FROM items WHERE id = ?", [id])).toEqual([["spam", "aside"]]);
    expect(await jobsOf(s, id)).toEqual([]);
    expect(await s.q("SELECT cause, certain FROM spam_verdicts WHERE item_id = ?", [id])).toEqual([["trap", 1]]);
  });

  it("holds a bot's booking without a word to the address it typed", async () => {
    const s = await spamSetup();
    const b = await s.caps.createBooking(
      visitor(T0),
      {
        payload: classPayload(s.svc),
        contact: { name: "Bot", email: "someone@example.net" },
      },
      { screen: { door: "form", form: { key: "none", trap: false } } },
    );
    await s.drain(T0 + 5 * MIN);
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [b.view.item.id])).toEqual([["held"]]);
    expect(s.mail.sent).toHaveLength(0);
    // A bot's request cannot be confirmed from the email it never got, nor by guessing the item.
    expect(await s.caps.spam.confirmFromSender(b.view.item.id, T0 + 6 * MIN)).toBe("confirmed");
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [b.view.item.id])).toEqual([["held"]]);
  });
});

describe("words that name the business's own offer", () => {
  it("name it in the plural, or with a suffix written onto it, and never inside another word", () => {
    const offers = ["Latte art class", "Tea", "아메리카노"];
    const names = (text: string) => namesOwnOffer(normalise(text), offers);
    expect(names("Are your latte art classes running on Friday?")).toBe(true);
    expect(names("Is the latte art class on Friday?")).toBe(true);
    expect(names("아메리카노를 두 잔 예약할 수 있나요?")).toBe(true);
    expect(names("아메리카노 있나요?")).toBe(true);
    expect(names("Our team would like a tour")).toBe(false);
    expect(names("Do you have teapots?")).toBe(false);
  });

  it("keep a customer the AI mistook for a pitch at a label, however the offer is written", async () => {
    for (const body of [
      "Hi! Are there two places left in the latte art class this Friday?",
      "Hi! Are there two places left in the latte art classes this Friday?",
    ]) {
      const s = await spamSetup({
        filters: ["pitches"],
        judge: fakeJudge({ kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["this Friday"] }),
      });
      const r = await s.caps.sendMessage(agent(T0), { body, contact: { name: "Mia", email: "mia@home.example.org" } });
      await s.drain(T0 + MIN);
      expect(await s.q("SELECT screen FROM items WHERE id = ?", [idOf(r)]), body).toEqual([["warned"]]);
    }
  });
});

describe("mail under an address on Let through", () => {
  const supplier = { name: "Supplier Ltd", email: "ap@supplier-ltd.example" };
  const invoice =
    "Your invoice 4471 is overdue. Pay today to the new account at https://pay-supplier.example.net/inv or service stops.";

  it("is screened when no server vouches for it, and comes straight in when one does", async () => {
    const s = await spamSetup({ filters: ["pitches", "scams"], judge: fakeJudge({ kind: "scam", certainty: "high" }) });
    await s.db.batch(
      addToListStatements({
        list: "allow",
        kind: "address",
        value: supplier.email,
        partyId: null,
        itemId: null,
        byUser: "user_1",
        now: T0 - DAY,
      }),
    );
    const forged = await s.caps.sendMessage(
      visitor(T0),
      { body: invoice, contact: supplier },
      { screen: { door: "email", email: { serverMarked: false, auth: { dmarc: "fail" } } } },
    );
    await s.drain(T0 + MIN);
    expect(
      await s.q("SELECT i.screen, v.verdict FROM items i JOIN spam_verdicts v ON v.item_id = i.id WHERE i.id = ?", [
        idOf(forged),
      ]),
    ).toEqual([["warned", "warn"]]);
    const signed = await s.caps.sendMessage(
      visitor(T0 + MIN),
      { body: "Thanks for the order, the beans ship on Tuesday.", contact: supplier },
      { screen: { door: "email", email: { serverMarked: false, auth: { dmarc: "pass" } } } },
    );
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [idOf(signed)])).toEqual([[null]]);
  });
  it("is screened when typed at the website form or by an assistant, which nothing vouches for", async () => {
    const s = await spamSetup({ filters: ["pitches", "scams"], judge: fakeJudge({ kind: "scam", certainty: "high" }) });
    await s.db.batch(
      addToListStatements({
        list: "allow",
        kind: "address",
        value: supplier.email,
        partyId: null,
        itemId: null,
        byUser: "user_1",
        now: T0 - DAY,
      }),
    );
    const form = await s.caps.sendMessage(
      visitor(T0),
      { body: invoice, contact: supplier },
      { screen: { door: "form", form: { key: "valid", trap: false, drawnAt: T0 - 90_000 } } },
    );
    const assistant = await s.caps.sendMessage(agent(T0 + MIN), { body: invoice, contact: supplier });
    await s.drain(T0 + 5 * MIN);
    for (const r of [form, assistant]) {
      expect(await s.q("SELECT screen FROM items WHERE id = ?", [idOf(r)])).toEqual([["warned"]]);
    }
  });
});
