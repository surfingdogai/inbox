import { describe, expect, it } from "vitest";
import { WriteError } from "../../src/write/errors";
import {
  agent,
  classPayload,
  DAY,
  fakeJudge,
  HOUR,
  idOf,
  MIN,
  owner,
  sentText,
  spamSetup,
  T0,
  visitor,
} from "./harness";

/**
 * Attacks on the spam filter as a whole (ADR-029 §16): a run of five hundred requests from agents
 * that change address, name and link with every one; a flood of held bookings aimed at the class's
 * places; and through both, the real customer who keeps getting through. Nothing is dropped: every
 * request is kept or refused with a time to come back.
 */

const CITIES = ["Lagos", "Lima", "Hanoi", "Tbilisi", "Quito", "Accra", "Busan", "Porto", "Tunis", "Cebu"];
const NAMES = ["Alex", "Sam", "Jordan", "Taylor", "Robin", "Kim", "Noor", "Ari", "Lee", "Dana", "Max", "Rio"];

/** One pitch of the run, reworded a little each time, linking to one of a handful of the sender's sites. */
function pitchOf(i: number): string {
  const name = NAMES[i % NAMES.length];
  const city = CITIES[i % CITIES.length];
  return `Hi there, I'm ${name} from RankBoost ${city}. We put cafés like Kopi Senja on the first page of Google in 30 days, guaranteed. See our results at https://rankboost-${i % 7}.example.net/audit and reply for a free audit of your website.`;
}

const ownerMails = (s: Awaited<ReturnType<typeof spamSetup>>) =>
  s.mail.sent.filter((m) => m.to.includes("owner@kopisenja.example"));

describe("a run of five hundred agent requests", () => {
  it("reaches the owner a few times at most, asks the AI a few times at most, and drops none", {
    timeout: 300_000,
  }, async () => {
    const judge = fakeJudge((req) =>
      /RankBoost/.test(sentText(req))
        ? { kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["first page of Google"] }
        : { kind: "customer", certainty: "high", customer_intent: true, topic: "none", quotes: [] },
    );
    const s = await spamSetup({ filters: ["pitches", "scams", "junk"], judge });
    let refused = 0;
    let kept = 0;
    let lucia: string | null = null;
    for (let i = 0; i < 500; i++) {
      const at = T0 + i * 7_000;
      try {
        await s.caps.sendMessage(agent(at), {
          body: pitchOf(i),
          contact: { name: `${NAMES[i % NAMES.length]} ${i}`, email: `outreach${i}@growth${i % 40}.example.com` },
        });
        kept++;
      } catch (error) {
        expect(error).toBeInstanceOf(WriteError);
        expect((error as WriteError).code).toBe("too_many_requests");
        expect((error as WriteError).details).toMatchObject({ retry_after_s: expect.any(Number) });
        refused++;
      }
      // Halfway through, a real customer books a class.
      if (i === 250) {
        const b = await s.caps.createBooking(agent(at + 1_000), {
          payload: classPayload(s.svc),
          contact: { name: "Lucía Fernández", email: "lucia.fernandez@example.es" },
          message: "Is it fine for a complete beginner? I'd like to bring my own cup.",
        });
        lucia = b.view.item.id;
      }
      await s.drain(at + 2 * MIN);
    }
    await s.drain(T0 + 500 * 7_000 + 5 * MIN);
    expect(kept + refused).toBe(500);
    // Every one kept is in the inbox: put aside, never thrown away.
    const byScreen = new Map(
      (await s.q("SELECT screen, COUNT(*) FROM items WHERE type = 'message' GROUP BY screen")).map((r) => [
        String(r[0]),
        Number(r[1]),
      ]),
    );
    expect([...byScreen.values()].reduce((a, b) => a + b, 0)).toBe(kept);
    expect(byScreen.get("aside") ?? 0).toBeGreaterThanOrEqual(kept - 4);
    expect(
      await s.q("SELECT COUNT(*) FROM items WHERE type = 'message' AND screen = 'aside' AND state <> 'spam'"),
    ).toEqual([[0]]);
    // The owner heard of the first few, at most, and of Lucía.
    const alerts = ownerMails(s);
    expect(
      alerts.filter((m) => m.text.includes("RankBoost") || m.subject.includes("RankBoost")).length,
    ).toBeLessThanOrEqual(4);
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [lucia])).toEqual([["delivered"]]);
    expect(alerts.some((m) => m.subject.includes("Lucía Fernández"))).toBe(true);
    // A reworded run costs a few AI checks, not one a copy: an answer is lent to the texts near it.
    expect(judge.calls.filter((c) => /RankBoost/.test(sentText(c))).length).toBeLessThanOrEqual(30);
    expect(await s.q("SELECT COUNT(*) FROM spam_verdicts WHERE ai = 'reused'")).not.toEqual([[0]]);
    // What the owner reads about it is short: one cause for the run.
    const causes = await s.q(
      "SELECT cause, COUNT(*) FROM spam_verdicts WHERE verdict = 'aside' GROUP BY cause ORDER BY COUNT(*) DESC LIMIT 1",
    );
    expect(Number(causes[0]?.[1])).toBeGreaterThan(kept / 2);
  });
});

describe("a flood of held bookings", () => {
  it("claims none of the class's places, so real customers still book and are confirmed", async () => {
    const s = await spamSetup({
      filters: ["pitches"],
      judge: fakeJudge({ kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["first page of Google"] }),
    });
    const at = T0 + 3 * DAY + HOUR;
    // Thirty bookings for the same class, each with a pitch, from thirty addresses.
    for (let i = 0; i < 30; i++) {
      await s.caps.createBooking(agent(T0 + i * 1_000), {
        payload: classPayload(s.svc, at),
        contact: { name: `Team ${i}`, email: `team${i}@seo${i}.example.net` },
        message: pitchOf(i),
      });
    }
    await s.drain(T0 + 10 * MIN);
    expect(await s.q("SELECT screen, COUNT(*) FROM items WHERE type = 'booking' GROUP BY screen")).toEqual([
      ["held", 30],
    ]);
    expect(await s.q("SELECT COUNT(*) FROM slot_claims")).toEqual([[0]]);
    // The class takes four: four real customers book it and the owner confirms each.
    const real: string[] = [];
    for (const [i, name] of ["Amara Okafor", "Kenji Sato", "Ines Duarte", "Olu Bello"].entries()) {
      const b = await s.caps.createBooking(agent(T0 + 20 * MIN + i * 1_000, { key: `kReal${i}`.padEnd(43, "0") }), {
        payload: classPayload(s.svc, at),
        contact: { name, email: `${name.split(" ")[0]?.toLowerCase()}@example.org` },
      });
      real.push(b.view.item.id);
    }
    await s.drain(T0 + 30 * MIN);
    for (const id of real) {
      const r = await s.caps.transitionItem(owner(T0 + 31 * MIN), { item_id: id, event: "confirm" });
      expect(r.view.item.state).toBe("confirmed");
    }
    // Letting a held one in afterwards cannot overbook the class: it is not confirmed past its places.
    const [held] = (await s.q("SELECT id FROM items WHERE screen = 'held' LIMIT 1")) as [string][];
    await s.caps.letIn(owner(T0 + 40 * MIN), { item_id: held?.[0] as string });
    await expect(
      s.caps.transitionItem(owner(T0 + 41 * MIN), { item_id: held?.[0] as string, event: "confirm" }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/slot|conflict|capacity|unavailable|full/),
    });
  });
});

describe("an answer lent to a near copy", () => {
  const text = (name: string) =>
    `Hello, my name is ${name} and I would love to book the latte art class for my sister's birthday next month, she adores coffee and has a new machine at home.`;

  it("is only ever one that found no customer: a customer's words sent first vouch for nobody else", async () => {
    const judge = fakeJudge({ kind: "customer", certainty: "high", customer_intent: true, topic: "none", quotes: [] });
    const s = await spamSetup({ filters: ["pitches"], judge });
    await s.caps.sendMessage(agent(T0), { body: text("Maya"), contact: { name: "Maya", email: "maya@example.in" } });
    await s.drain(T0 + MIN);
    await s.caps.sendMessage(agent(T0 + 2 * MIN), {
      body: text("Mia"),
      contact: { name: "Mia", email: "mia@example.in" },
    });
    await s.drain(T0 + 3 * MIN);
    expect(judge.calls).toHaveLength(2);
  });

  it("keeps only the quotes the copy holds", async () => {
    const judge = fakeJudge({ kind: "sales_pitch", certainty: "high", topic: "other", quotes: ["my name is Maya"] });
    const s = await spamSetup({ filters: ["pitches"], judge });
    await s.caps.sendMessage(agent(T0), { body: text("Maya"), contact: { name: "Maya", email: "maya@example.in" } });
    await s.drain(T0 + MIN);
    await s.caps.sendMessage(agent(T0 + 2 * MIN), {
      body: text("Mia"),
      contact: { name: "Mia", email: "mia@example.in" },
    });
    await s.drain(T0 + 3 * MIN);
    expect(judge.calls).toHaveLength(1);
    const [first, second] = await s.q(
      "SELECT ai, quotes, json_extract(answer, '$.certainty') FROM spam_verdicts ORDER BY created_at",
    );
    expect(first).toEqual(["judged", '["my name is maya"]', "high"]);
    // The copy does not say "my name is Maya": lent without the quote, it is no longer certain.
    expect(second).toEqual(["reused", null, "medium"]);
  });
});

describe("what disguises a pitch", () => {
  const verdictOf = async (s: Awaited<ReturnType<typeof spamSetup>>, id: string) =>
    (await s.q("SELECT v.verdict, v.cause FROM spam_verdicts v WHERE v.item_id = ?", [id]))[0];

  it("is never a word that holds a short product's name: 'team' names no 'Tea'", async () => {
    for (const crew of ["crew", "team"]) {
      const judge = fakeJudge({
        kind: "sales_pitch",
        certainty: "high",
        topic: "seo",
        quotes: ["first page of Google"],
      });
      const s = await spamSetup({ filters: ["pitches"], judge });
      await s.db.client.query({
        sql: `INSERT INTO products (id, name, price, active, created_at, updated_at) VALUES ('p_tea', 'Tea', '{"value":1000000,"currency":"IDR"}', 1, ?, ?)`,
        params: [T0, T0],
        method: "run",
      });
      const r = await s.caps.sendMessage(agent(T0), {
        body: `Hi there, our ${crew} puts cafes like yours on the first page of Google in 30 days. Reply for a free audit of your website.`,
        contact: { name: "Rank Co", email: `hi@rank-${crew}.example.net` },
      });
      await s.drain(T0 + MIN);
      expect(await verdictOf(s, idOf(r)), crew).toEqual(["aside", "pitches"]);
    }
  });

  it("is never a shortener: a reworded wave behind one still shares its link domain", async () => {
    const s = await spamSetup();
    const texts = [
      "Good morning, we help cafes win more guests online every single week.",
      "Want more people walking through your door? Our growth studio can help.",
      "Hello from a small agency that grows local coffee shops quickly.",
      "Quick question for the owner: would you like twice the footfall this season?",
    ];
    let last = "";
    for (const [i, t] of texts.entries()) {
      const r = await s.caps.sendMessage(agent(T0 + i * MIN), {
        body: `${t} https://bit.ly/3xYz${i}`,
        contact: { name: `S${i}`, email: `s${i}@sender${i}.example.org` },
      });
      last = idOf(r);
      await s.drain(T0 + i * MIN + 1);
    }
    const [row] = await s.q("SELECT signals, verdict FROM spam_verdicts WHERE item_id = ?", [last]);
    expect(String(row?.[0])).toContain("same_link_domain");
    expect(row?.[1]).toBe("warn");
  });

  it("is never a character drawn as nothing: copies with a joiner in a different place are one wave", async () => {
    const pitch =
      "Hi, I noticed your website and I think we can redesign it. We build websites for cafes and bring organic traffic every month.";
    const joiner = String.fromCodePoint(0x034f);
    const s = await spamSetup();
    let last = "";
    for (let i = 0; i < 5; i++) {
      const r = await s.caps.sendMessage(agent(T0 + i * MIN), {
        body: `${pitch.slice(0, 10 + i * 7)}${joiner}${pitch.slice(10 + i * 7)}`,
        contact: { name: `W${i}`, email: `w${i}@wave${i}.example.org` },
      });
      last = idOf(r);
      await s.drain(T0 + i * MIN + 1);
    }
    expect(await verdictOf(s, last)).toEqual(["aside", "wave"]);
  });
});

describe("what a bot sent under someone's address", () => {
  it("counts against nobody: its own message the next day is screened as a stranger's first", async () => {
    const s = await spamSetup();
    const anna = { name: "Anna Kowalska", email: "anna.kowalska@biuro.example.pl" };
    // Six form posts under her address, each with the hidden field filled: a bot's.
    for (let i = 0; i < 6; i++) {
      await s.caps.sendMessage(
        visitor(T0 + i * 1_000),
        { body: `Cheap followers ${i} https://followers${i}.example.net`, contact: anna },
        { screen: { door: "form", form: { key: "valid", trap: true, drawnAt: T0 - 30_000 } } },
      );
    }
    const r = await s.caps.sendMessage(agent(T0 + 10_000), {
      body: "Hello, could we order three kilos of the house blend for our office, delivered on Thursday?",
      contact: anna,
    });
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [idOf(r)])).toEqual([["delivered"]]);
    expect(await s.q("SELECT COUNT(*) FROM spam_handles WHERE firsts > 1")).toEqual([[0]]);
  });
});
