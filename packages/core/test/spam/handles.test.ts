import { describe, expect, it } from "vitest";
import { countFirstStatements } from "../../src/spam/handles";
import { WriteError } from "../../src/write/errors";
import { agent, DAY, fakeJudge, idOf, MIN, owner, sentText, spamSetup, T0 } from "./harness";

/**
 * Budgets per handle (ADR-029 §4.4): a stranger starts a few conversations a day under each of its
 * handles; past that the next waits and costs no AI check; past a ceiling an agent comes back later.
 * Never a client's address; a sender the business knows never counts.
 */

const KEY = "selfKeyThumbprint000000000000000000000000000";
/** Different words from each sender: the same words from many would be a wave of their own. */
const TOPICS = [
  "oat milk",
  "parking",
  "gift cards",
  "decaf beans",
  "a group of six",
  "wheelchair access",
  "Sunday hours",
  "a French press grind",
  "cash payments",
  "a birthday",
  "a refund",
  "a late arrival",
  "children",
  "dogs",
  "an invoice",
  "the Toraja roast",
  "iced lattes",
  "a cancellation",
  "the second floor",
  "a private class",
  "a Monday slot",
  "a delivery",
  "a quote",
  "a voucher",
  "a big order",
  "syrups",
  "allergies",
  "the terrace",
  "a tour",
  "a recipe",
  "a grinder",
  "a tamper",
  "a milk jug",
  "beans in bulk",
  "a wedding",
  "an office",
  "a school",
  "a hotel",
  "a restaurant",
  "a kiosk",
  "a market stall",
  "a festival",
  "a podcast",
  "a magazine",
  "a student",
  "a teacher",
  "a chef",
  "a barista job",
  "a photo shoot",
  "a film crew",
  "a charity",
  "a neighbour",
  "a supplier",
];
const words = (i: number) =>
  `Hi, a question about ${TOPICS[i % TOPICS.length]} (${i}${"!".repeat(i % 3)})? ${"Thanks".slice(0, 3 + (i % 4))}.`;

async function sendAs(
  s: Awaited<ReturnType<typeof spamSetup>>,
  i: number,
  o: { key?: string; level?: "self" | "vouched"; email?: string; locale?: string },
) {
  return s.caps.sendMessage(
    {
      ...agent(T0 + i * 1_000, { ...(o.key ? { key: o.key } : {}), ...(o.level ? { level: o.level } : {}) }),
      ...(o.locale ? { locale: o.locale } : {}),
    },
    {
      body: words(i),
      contact: { name: `Sender ${i}`, email: o.email ?? `s${i}@mail${i}.example.org` },
    },
  );
}

const screens = async (s: Awaited<ReturnType<typeof spamSetup>>) =>
  (
    await s.q("SELECT i.screen, v.cause FROM items i JOIN spam_verdicts v ON v.item_id = i.id ORDER BY i.created_at")
  ).map((r) => `${r[0]}${r[1] ? `:${r[1]}` : ""}`);

describe("an agent's key", () => {
  it("starts five new conversations a day; the sixth waits, and costs no AI check", async () => {
    const judge = fakeJudge({ kind: "customer", certainty: "high" });
    const s = await spamSetup({ filters: ["pitches"], judge });
    for (let i = 0; i < 6; i++) {
      await sendAs(s, i, { key: KEY });
      await s.drain(T0 + i * 1_000);
    }
    const all = await screens(s);
    expect(all.slice(0, 5).every((x) => x === "delivered")).toBe(true);
    expect(all[5]).toBe("aside:many_new");
    expect(judge.calls).toHaveLength(5);
    // A booking past the budget is held for proof, never put aside.
    const b = await s.caps.createBooking(agent(T0 + 10_000, { key: KEY }), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Latte art class" },
        startTime: new Date(T0 + 3 * DAY + 3_600_000).toISOString(),
        endTime: new Date(T0 + 3 * DAY + 7_200_000).toISOString(),
      },
      contact: { name: "Same app", email: "x@other.example.org" },
    });
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [b.view.item.id])).toEqual([["held"]]);
    // A new day, a new budget.
    await sendAs(s, 86_400, { key: KEY });
    await s.drain(T0 + 86_400_000);
    expect((await screens(s)).at(-1)).toBe("delivered");
  });

  it("is asked to come back later past its ceiling, in the sender's words, with no reason given", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 50; i++) await sendAs(s, i, { key: KEY });
    const en = await sendAs(s, 50, { key: KEY }).catch((e) => e);
    expect(en).toBeInstanceOf(WriteError);
    expect(en).toMatchObject({ code: "too_many_requests", status: 429, details: { retry_after_s: 3_600 } });
    expect(en.message).toBe("We have had many new requests from you. Please try again later.");
    const pt = await sendAs(s, 51, { key: KEY, locale: "pt-BR" }).catch((e) => e);
    expect(pt.message).toBe("Recebemos muitos pedidos novos seus. Por favor, tente mais tarde.");
    expect(await s.q("SELECT COUNT(*) FROM items")).toEqual([[50]]);
  });
});

describe("a recognised platform's key, which signs for all its users", () => {
  const PLATFORM = "pLaTfOrMkEyThUmBpRiNt0123456789abcdefghijk";
  const DIRECTORY = "https://assistant-platform.example";
  /** Signed with the key a recognised platform's directory lists (`vouched`). */
  const via = (t: number) => agent(t, { key: PLATFORM, level: "vouched", platform: DIRECTORY });

  it("never puts a customer's message aside, nor holds their booking, for the platform's other users", async () => {
    const s = await spamSetup();
    // Fifty-two people, each with their own address and their own words, through one assistant platform.
    for (let i = 0; i < 52; i++) {
      await s.caps.sendMessage(via(T0 + i * 1_000), {
        body: words(i),
        contact: { name: `Customer ${i}`, email: `person${i}@home${i}.example.org` },
      });
    }
    expect((await screens(s)).filter((x) => x !== "delivered")).toEqual([]);
    for (let i = 0; i < 8; i++) {
      const b = await s.caps.createBooking(via(T0 + DAY / 2 + i * 1_000), {
        payload: {
          reservationFor: { serviceId: s.svc, name: "Latte art class" },
          startTime: new Date(T0 + 3 * DAY + (i % 4) * 3_600_000).toISOString(),
          endTime: new Date(T0 + 3 * DAY + (i % 4) * 3_600_000 + 3_600_000).toISOString(),
        },
        contact: { name: `Guest ${i}`, email: `guest${i}@house${i}.example.org` },
      });
      expect(await s.q("SELECT screen FROM items WHERE id = ?", [b.view.item.id])).toEqual([["delivered"]]);
    }
  });

  it("still counts each of its users by their own mailbox, and asks a flood to come back later", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 6; i++)
      await sendAs(s, i, { key: PLATFORM, level: "vouched", email: "one.person@mailbox.example.org" });
    expect((await screens(s)).at(-1)).toBe("aside:many_new");
    const t = await spamSetup();
    // Its own ceiling is a flood's: far past what any one sender would start in a day.
    for (let i = 0; i < 1_500; i++)
      await t.db.batch(countFirstStatements([{ kind: "platform_key", ref: PLATFORM }], T0 + i));
    const refused = await t.caps
      .sendMessage(via(T0 + MIN), {
        body: words(1),
        contact: { name: "Anyone", email: "anyone@example.org" },
      })
      .catch((e) => e);
    expect(refused).toMatchObject({ code: "too_many_requests", status: 429 });
  });

  it("is on no list and trusted by nobody: letting one user in lets in no one else", async () => {
    const s = await spamSetup();
    const first = await s.caps.sendMessage(via(T0), {
      body: words(1),
      contact: { name: "No address" },
    });
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: idOf(first), event: "mark_spam" });
    await s.caps.transitionItem(owner(T0 + 2 * MIN), { item_id: idOf(first), event: "unspam" });
    expect(await s.q("SELECT COUNT(*) FROM spam_lists")).toEqual([[0]]);
    expect(await s.q("SELECT COUNT(*) FROM spam_handles WHERE trusted_at IS NOT NULL")).toEqual([[0]]);
  });
});

/** A pitch with no contact at all, as a bulk sender writes it to every business. */
const PITCH =
  "Hi, I noticed your website and we offer SEO services and guest posts. WhatsApp +62 812 5555 0101 for prices.";

describe("a key from a directory nobody recognises", () => {
  const BULK = "bulkSenderOwnDirectoryKey000000000000000000";
  const OWN_DIRECTORY = "https://bulk-sender.example";
  const via = (t: number) => agent(t, { key: BULK, platform: OWN_DIRECTORY });

  it("is a platform's all the same: its users are counted each on their own, never as one sender", async () => {
    const s = await spamSetup();
    // Eight people, each with their own address, through a platform no network this inbox uses knows.
    for (let i = 0; i < 8; i++) {
      await s.caps.sendMessage(agent(T0 + i * MIN, { key: BULK, platform: "https://assistant.example" }), {
        body: words(i),
        contact: { name: `Customer ${i}`, email: `customer.${i}@gmail.com` },
      });
    }
    expect(await screens(s)).toEqual(Array(8).fill("delivered"));
    // Its own ceiling is a flood's, lower than a recognised platform's.
    const t = await spamSetup();
    for (let i = 0; i < 500; i++) await t.db.batch(countFirstStatements([{ kind: "platform_key", ref: BULK }], T0 + i));
    const refused = await t.caps
      .sendMessage(via(T0 + MIN), { body: words(1), contact: { name: "Anyone", email: "anyone@example.org" } })
      .catch((e) => e);
    expect(refused).toMatchObject({ code: "too_many_requests", status: 429 });
  });

  it("still makes a wave of the same pitch sent under it, as unsigned copies do", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 10; i++) await s.caps.sendMessage(via(T0 + i * MIN), { body: PITCH });
    const all = await screens(s);
    expect(all.slice(0, 2)).toEqual(["delivered", "delivered"]);
    expect(all.slice(4)).toEqual(Array(6).fill("aside:wave"));
    // And one person through it is counted by their mailbox.
    const t = await spamSetup();
    for (let i = 0; i < 6; i++) await sendAs(t, i, { key: BULK, email: "one.person@mailbox.example.org" });
    expect((await screens(t)).at(-1)).toBe("aside:many_new");
  });
});

describe("a request that names nobody", () => {
  it("is a sender of its own: the same pitch, unsigned and with no contact, becomes a wave", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 10; i++) await s.caps.sendMessage(agent(T0 + i * MIN), { body: PITCH });
    const all = await screens(s);
    expect(all.slice(0, 2)).toEqual(["delivered", "delivered"]);
    expect(all.slice(2, 4)).toEqual(["warned:same_text", "warned:same_text"]);
    expect(all.slice(4)).toEqual(Array(6).fill("aside:wave"));
  });
});

describe("rotating", () => {
  it("mailboxes under one key are caught by the key, keys under one mailbox by the mailbox", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 6; i++) await sendAs(s, i, { key: KEY, email: `rotating${i}@mail${i}.example.org` });
    expect((await screens(s)).at(-1)).toBe("aside:many_new");
    const t = await spamSetup();
    for (let i = 0; i < 6; i++)
      await sendAs(t, i, { key: `key${i}`.padEnd(43, "0"), email: "one@mailbox.example.org" });
    expect((await screens(t)).at(-1)).toBe("aside:many_new");
  });

  it("both keys and mailboxes under one company domain are caught by the domain", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 21; i++)
      await sendAs(s, i, { key: `key${i}`.padEnd(43, "0"), email: `p${i}@leadsfactory.example.net` });
    expect((await screens(s)).filter((x) => x === "aside:many_new")).toHaveLength(1);
  });

  it("never counts a mail provider many people share as one domain", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 25; i++) await sendAs(s, i, { email: `person${i}@gmail.com` });
    expect((await screens(s)).every((x) => x === "delivered")).toBe(true);
  });

  it("counts no large provider as one company's domain, wherever its people are", async () => {
    for (const provider of ["foxmail.com", "docomo.ne.jp", "yahoo.de", "outlook.es", "hotmail.com.br"]) {
      const s = await spamSetup();
      for (let i = 0; i < 21; i++) await sendAs(s, i, { email: `person${i}@${provider}` });
      expect((await screens(s)).at(-1), provider).toBe("delivered");
    }
  });
});

describe("a sender the business knows", () => {
  it("is never screened and never counts, once a person let them through", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 6; i++) await sendAs(s, i, { key: KEY, email: "regular@example.org" });
    const last = (await s.q("SELECT id FROM items ORDER BY created_at DESC LIMIT 1"))[0]?.[0] as string;
    expect(await s.q("SELECT state FROM items WHERE id = ?", [last])).toEqual([["spam"]]);
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: last, event: "unspam" });
    for (let i = 10; i < 20; i++) await sendAs(s, i, { key: KEY, email: "regular@example.org" });
    const recent = await s.q("SELECT screen FROM items ORDER BY created_at DESC LIMIT 10");
    expect(recent.every((r) => r[0] === null)).toBe(true);
  });
});

describe("a sender who pressed Confirm it's me", () => {
  const PITCHER = { name: "Rank", email: "outreach@rankboost.example.net" };
  const judge = () =>
    fakeJudge((req) =>
      /RankBoost/.test(sentText(req))
        ? { kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["first page of Google"] }
        : { kind: "unclear", certainty: "low" },
    );

  it("lets that one request go on, and is screened as before afterwards, with wider budgets", async () => {
    const j = judge();
    const s = await spamSetup({ filters: ["pitches"], judge: j });
    const q = await s.caps.requestQuote(agent(T0), {
      payload: {
        itemOffered: { name: "SEO" },
        description: "RankBoost puts cafes on the first page of Google in 30 days.",
      },
      contact: PITCHER,
    });
    await s.drain(T0 + 5 * MIN);
    expect(await s.q("SELECT screen FROM items WHERE id = ?", [q.view.item.id])).toEqual([["held"]]);
    expect(await s.caps.spam.confirmFromSender(q.view.item.id, T0 + 6 * MIN)).toBe("released");
    const before = j.calls.length;
    for (let i = 0; i < 3; i++) {
      await s.caps.sendMessage(agent(T0 + 10 * MIN + i * 1_000), {
        body: `RankBoost #${i}: we put cafes on the first page of Google in 30 days, guaranteed.`,
        contact: PITCHER,
      });
      await s.drain(T0 + 10 * MIN + i * 1_000);
    }
    // Every one was read, and put aside: proving a mailbox proves nothing about the next pitch.
    expect(j.calls.length - before).toBeGreaterThanOrEqual(1);
    const later = await s.q("SELECT screen FROM items WHERE type = 'message' ORDER BY created_at");
    expect(later.map((r) => r[0])).toEqual(["aside", "aside", "aside"]);
    // Its budget is three times a stranger's: the sixteenth new conversation of the day waits, not the sixth.
    const u = await spamSetup();
    const first = await u.caps.createBooking(agent(T0), {
      payload: {
        reservationFor: { serviceId: u.svc, name: "Latte art class" },
        startTime: new Date(T0 + 3 * DAY).toISOString(),
        endTime: new Date(T0 + 3 * DAY + 3_600_000).toISOString(),
      },
      contact: { name: "Busy", email: "busy@office.example.org" },
    });
    await u.caps.spam.confirmFromSender(first.view.item.id, T0 + MIN);
    for (let i = 1; i < 16; i++) await sendAs(u, i, { email: "busy@office.example.org" });
    const all = await screens(u);
    expect(all.slice(0, 15).every((x) => x === "delivered")).toBe(true);
    expect(all[15]).toBe("aside:many_new");
  });

  it("never undoes a spam mark: only a person's Let it in or Not spam makes a sender known", async () => {
    const s = await spamSetup({ filters: ["pitches"], judge: judge() });
    const m = await s.caps.sendMessage(agent(T0), { body: "Hello, a question about decaf beans?", contact: PITCHER });
    await s.drain(T0 + MIN);
    await s.caps.transitionItem(owner(T0 + 2 * MIN), { item_id: idOf(m), event: "mark_spam" });
    const b = await s.caps.createBooking(agent(T0 + DAY), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Latte art class" },
        startTime: new Date(T0 + 3 * DAY).toISOString(),
        endTime: new Date(T0 + 3 * DAY + 3_600_000).toISOString(),
      },
      contact: PITCHER,
      message: "Hi",
    });
    await s.drain(T0 + DAY + 5 * MIN);
    await s.caps.spam.confirmFromSender(b.view.item.id, T0 + DAY + 6 * MIN);
    const r = await s.caps.sendMessage(agent(T0 + DAY + 10 * MIN), {
      body: "RankBoost again: we put cafes on the first page of Google in 30 days, guaranteed.",
      contact: PITCHER,
    });
    await s.drain(T0 + DAY + 11 * MIN);
    expect(await s.q("SELECT screen, state FROM items WHERE id = ?", [idOf(r)])).toEqual([["aside", "spam"]]);
  });
});
