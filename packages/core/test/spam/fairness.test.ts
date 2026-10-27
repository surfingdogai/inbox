import { describe, expect, it } from "vitest";
import customers from "../fixtures/spam-customers.json";
import { agent, classPayload, DAY, fakeJudge, HOUR, MIN, spamSetup, T0 } from "./harness";

/**
 * Fairness (ADR-041 §1.4, §5.5): real customers write in every language and script, short and long,
 * rude, misspelled, machine-translated, from every mail provider, and through their assistants. With
 * every filter on, none of them scores even a label on the filter's own signals; and with an AI check
 * that only says "probably a customer", none is labelled either. A language with no phrase family yet
 * means less caught, never more.
 */

interface Fixture {
  readonly lang: string;
  readonly name: string;
  readonly email: string;
  readonly text: string;
}

const all = customers as readonly Fixture[];

async function sendAll(s: Awaited<ReturnType<typeof spamSetup>>) {
  for (const [i, c] of all.entries()) {
    const at = T0 + i * MIN;
    const caller = agent(at);
    const contact = { name: c.name, email: c.email };
    if (i % 7 === 3) {
      await s.caps.createBooking(caller, {
        payload: classPayload(s.svc, T0 + (3 + (i % 3)) * DAY + (i % 6) * HOUR),
        contact,
        message: c.text,
      });
    } else if (i % 5 === 2) {
      await s.caps.requestQuote(caller, {
        payload: { itemOffered: { name: c.text.slice(0, 60) }, description: c.text },
        contact,
      });
    } else {
      await s.caps.sendMessage(caller, { body: c.text, contact });
    }
    await s.drain(at);
  }
}

describe("customers of every language and every way of writing", () => {
  it("are at least 120 messages in at least 15 languages and scripts", () => {
    expect(all.length).toBeGreaterThanOrEqual(120);
    expect(new Set(all.map((c) => c.lang)).size).toBeGreaterThanOrEqual(15);
  });

  it("never score a label on the filter's own signals, with every filter on and no AI", async () => {
    const s = await spamSetup({ filters: ["pitches", "scams", "junk"] });
    await sendAll(s);
    const rows = await s.q(
      "SELECT v.verdict, v.score, v.signals, i.subject FROM spam_verdicts v JOIN items i ON i.id = v.item_id",
    );
    expect(rows).toHaveLength(all.length);
    const flagged = rows.filter((r) => r[0] !== "deliver" || Number(r[1]) >= 3);
    expect(flagged.map((r) => `${r[0]} ${r[1]} ${r[2]} ${r[3]}`)).toEqual([]);
  }, 120_000);

  it("are never labelled when the AI check says they are probably customers", async () => {
    const judge = fakeJudge({ kind: "customer", certainty: "medium", customer_intent: true });
    const s = await spamSetup({ filters: ["pitches", "scams", "junk"], judge });
    await sendAll(s);
    const rows = await s.q("SELECT v.verdict, v.ai, i.subject FROM spam_verdicts v JOIN items i ON i.id = v.item_id");
    expect(rows.filter((r) => r[0] !== "deliver").map((r) => `${r[0]} ${r[1]} ${r[2]}`)).toEqual([]);
    expect(judge.calls.length).toBeGreaterThan(all.length / 2);
  }, 120_000);
});
