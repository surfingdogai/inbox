import { describe, expect, it } from "vitest";
import { WriteError } from "../../src/write/errors";
import { agent, DAY, fakeJudge, MIN, owner, spamSetup, T0 } from "./harness";

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

  it("starts three times as many under a platform a network vouches for", async () => {
    const s = await spamSetup();
    for (let i = 0; i < 16; i++) await sendAs(s, i, { key: KEY, level: "vouched" });
    const all = await screens(s);
    expect(all.filter((x) => x === "delivered")).toHaveLength(15);
    expect(all[15]).toBe("aside:many_new");
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
