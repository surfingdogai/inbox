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

describe("an address typed where nothing vouches for it", () => {
  const anna = { name: "Anna Kowalska", email: "anna.kowalska@biuro.example.pl" };
  const signedMail = { screen: { door: "email" as const, email: { serverMarked: false, auth: { dmarc: "pass" } } } };
  const slowForm = (t: number) => ({
    screen: { door: "form" as const, form: { key: "valid" as const, trap: false, drawnAt: t - 90_000 } },
  });
  const ask = (i: number) => `Hello, a question about order ${1000 + i}: could it come on day ${i + 1} instead?`;

  it("never spends her signed mail's budget, nor her company's", async () => {
    const s = await spamSetup();
    // Five form posts at a person's pace, naming her, then her own mail, which a server vouched for.
    for (let i = 0; i < 5; i++) {
      const t = T0 + i * MIN;
      await s.caps.sendMessage(visitor(t), { body: ask(i), contact: anna }, slowForm(t));
    }
    const own = await s.caps.sendMessage(
      visitor(T0 + HOUR),
      {
        body: "Hello, could we order three kilos of the house blend for our office, delivered on Thursday?",
        contact: anna,
      },
      signedMail,
    );
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [idOf(own)])).toEqual([["delivered"]]);
    // Twenty posts naming twenty people at her company, then a colleague's signed mail.
    const t = await spamSetup();
    for (let i = 0; i < 20; i++) {
      const at = T0 + i * MIN;
      await t.caps.sendMessage(
        visitor(at),
        { body: ask(i), contact: { name: `Person ${i}`, email: `person${i}@biuro.example.pl` } },
        slowForm(at),
      );
    }
    const marek = await t.caps.sendMessage(
      visitor(T0 + HOUR),
      {
        body: "Good morning, we would like a quote for coffee at our office: about twenty people, every weekday.",
        contact: { name: "Marek Nowak", email: "marek.nowak@biuro.example.pl" },
      },
      signedMail,
    );
    expect(await t.q("SELECT screen FROM items WHERE id = ?", [idOf(marek)])).toEqual([["delivered"]]);
  });

  it("never gets her own assistant refused, however many unsigned requests named her", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 30; i++) await s.caps.sendMessage(agent(T0 + i * 1_000), { body: ask(i), contact: anna });
    const own = await s.caps
      .sendMessage(agent(T0 + MIN, { key: "annasOwnAssistantKey00000000000000000000000" }), {
        body: "Hello, could we order three kilos of the house blend for our office, delivered on Thursday?",
        contact: anna,
      })
      .catch((e) => e);
    expect(own).not.toBeInstanceOf(WriteError);
    expect(await s.q("SELECT COUNT(*) FROM items")).toEqual([[31]]);
  });
});

describe("a form a bot hurried through with a forged key", () => {
  it("counts against nobody: the person it names writes her own message, and it is no 'many new'", async () => {
    const s = await spamSetup();
    const anna = { name: "Anna Kowalska", email: "anna.kowalska@biuro.example.pl" };
    for (let i = 0; i < 5; i++) {
      const t = T0 + i * 1_000;
      const r = await s.caps.sendMessage(
        visitor(t),
        { body: `Cheap followers for your page, offer number ${i}, best prices this week.`, contact: anna },
        { screen: { door: "form", form: { key: "invalid", trap: false, drawnAt: t - 400 } } },
      );
      expect(await s.q("SELECT screen FROM items WHERE id = ?", [idOf(r)])).toEqual([["aside"]]);
    }
    const t = T0 + 10_000;
    const own = await s.caps.sendMessage(
      visitor(t),
      {
        body: "Hello, could we order three kilos of the house blend for our office, delivered on Thursday?",
        contact: anna,
      },
      { screen: { door: "form", form: { key: "valid", trap: false, drawnAt: t - 90_000 } } },
    );
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [idOf(own)])).toEqual([["delivered"]]);
  });
});

describe("a reworded wave behind one chat number", () => {
  const NUMBER = "6281299990000";
  const WORDINGS = [
    `Part-time job from home, earn 300 a day liking videos. Message us: https://wa.me/${NUMBER}`,
    `Looking for staff! Simple online tasks, daily pay. Contact https://wa.me/${NUMBER}`,
    `Earn extra income in your free time, no experience needed. Chat: https://wa.me/${NUMBER}`,
    `Flexible remote work, paid every day, only a phone needed. Join via https://wa.me/${NUMBER}`,
    `We are hiring online assistants, high commission, start today. Write to https://wa.me/${NUMBER}`,
  ];

  it("is the same link from many senders, and its number is kept nowhere", async () => {
    const s = await spamSetup();
    for (const [i, body] of WORDINGS.entries()) {
      await s.caps.sendMessage(agent(T0 + i * MIN), {
        body,
        contact: { name: `R${i}`, email: `r${i}@mail${i}.example.org` },
      });
    }
    const rows = await s.q(
      "SELECT i.screen, v.signals FROM items i JOIN spam_verdicts v ON v.item_id = i.id ORDER BY i.created_at",
    );
    const shared = rows.map((r) =>
      (JSON.parse(String(r[1])) as { c: string; d?: string }[]).find((x) => x.c === "same_link_domain"),
    );
    expect(shared.slice(0, 2)).toEqual([undefined, undefined]);
    for (const [i, x] of shared.slice(2).entries()) expect(x, String(i)).toMatchObject({ d: "wa.me" });
    expect(rows.slice(2).map((r) => r[0])).toEqual(["warned", "warned", "warned"]);
    expect(JSON.stringify(await s.q("SELECT link_domains FROM spam_prints"))).not.toContain(NUMBER);
    expect(JSON.stringify(rows)).not.toContain(NUMBER);
  });

  it("never joins customers who each link a chat of their own", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 5; i++) {
      await s.caps.sendMessage(agent(T0 + i * MIN), {
        body: `Hello, I'd like to book the latte art class for ${i + 2} people. My WhatsApp: https://wa.me/62812000000${i}`,
        contact: { name: `C${i}`, email: `c${i}@home${i}.example.org` },
      });
    }
    expect((await s.q("SELECT DISTINCT screen FROM items")).map((r) => r[0])).toEqual(["delivered"]);
  });
});

describe("customers who link a big site on their own country's domain", () => {
  it("are delivered however many send one in a week", async () => {
    const s = await spamSetup();
    const asks = [
      "¿Abren hoy? https://www.google.es/maps/place/Kopi+Senja",
      "¿Es aquí? https://www.google.es/maps/place/Kopi+Senja/@-8.6,115.2",
      "¿Siguen aquí? https://www.google.es/maps/place/Kopi+Senja?hl=es",
    ];
    for (const [i, body] of asks.entries()) {
      await s.caps.sendMessage(agent(T0 + i * DAY), {
        body,
        contact: { name: `L${i}`, email: `l${i}@correo${i}.example.es` },
      });
    }
    expect((await s.q("SELECT screen FROM items ORDER BY created_at")).map((r) => r[0])).toEqual([
      "delivered",
      "delivered",
      "delivered",
    ]);
  });
});
