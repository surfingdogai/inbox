import { describe, expect, it } from "vitest";
import type { JudgeRequest } from "../../src/spam/judge";
import { agent, BASE, classPayload, fakeJudge, MIN, nonceOf, spamSetup, T0 } from "./harness";

/**
 * Nobody learns their request was held (ADR-029 §10.2, §14): its create answer, every later read and
 * the confirm page read exactly as a delivered one's, once ids, references and times are taken out.
 * And everyone new is asked to confirm, held or not, so being asked tells them nothing.
 */

const NOTE = "Could you also show us how to steam oat milk? We are two friends visiting for a week.";
/** The pitch the held one carries: an answer is given for a text, and the same words would get the same one. */
const PITCH = "We put cafés like yours on the first page of Google within a month. Shall we talk this week?";

/** Ids, references, tokens, times and the sender's own words out: what is left is what a sender could compare. */
function comparable(value: unknown): string {
  return JSON.stringify(value)
    .replace(/"text":"[^"]*"/g, '"text":"WORDS"')
    .replace(/[0-9A-HJKMNP-TV-Z]{26}/g, "ID")
    .replace(/\b[0-9A-HJKMNP-TV-Z]{6}\b/g, "REF")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g, "TIME")
    .replace(/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}/g, "TOKEN")
    .replace(/"accessToken":"[^"]+"/g, '"accessToken":"X"')
    .replace(/[a-z]•••@[a-z]•••\.[a-z]+/g, "MASKED");
}

/** A model that sees through the pitch, and takes everyone else for a customer. */
const judge = () =>
  fakeJudge((req: JudgeRequest) =>
    req.user.includes("first page of Google")
      ? { kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["first page of Google"] }
      : { check: nonceOf(req), kind: "customer", certainty: "high", customer_intent: true },
  );

describe("a held request and a delivered one", () => {
  it("answer the same at the door, on every read, and on the confirm page", async () => {
    const s = await spamSetup({ filters: ["pitches"], judge: judge() });
    const make = (email: string, t: number, message: string) =>
      s.caps.createBooking(agent(t), { payload: classPayload(s.svc), contact: { name: "Alex", email }, message });
    const held = await make("alex@pitch.example.net", T0, PITCH);
    const delivered = await make("alex@home.example.org", T0 + 1, NOTE);
    expect(comparable(held)).toBe(comparable(delivered));
    expect(held.identity?.confirm).toEqual({ sent_to: "a•••@p•••.net" });
    expect(delivered.identity?.confirm).toEqual({ sent_to: "a•••@h•••.org" });
    await s.drain(T0 + 5 * MIN);
    expect((await s.q("SELECT screen FROM items ORDER BY created_at")).map((r) => r[0])).toEqual(["held", "delivered"]);

    const read = (r: typeof held) =>
      s.caps.getItemStatus(agent(T0 + 6 * MIN), { item_id: r.view.item.id, access_token: r.accessToken as string });
    expect(comparable(await read(held))).toBe(comparable(await read(delivered)));

    // Both were asked to confirm, in the same words, and the page each link opens reads the same.
    const acks = s.mail.sent.filter((m) => m.subject === "We have your booking request");
    expect(acks).toHaveLength(2);
    expect(comparable(acks[0]?.text)).toBe(comparable(acks[1]?.text));
    const tokenOf = (text: string) =>
      /\/c\/([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22})/.exec(text.split("Confirm it's me: ")[1] ?? "")?.[1] as string;
    const pages = await Promise.all(acks.map((m) => s.caps.customer.linkView(tokenOf(m.text), { now: T0 + 7 * MIN })));
    expect(comparable(pages[0])).toBe(comparable(pages[1]));
    const pressed = await Promise.all(
      acks.map((m, i) => {
        const page = pages[i] as { form?: { hidden?: Record<string, string> } };
        return s.caps.customer.linkAct(tokenOf(m.text), page.form?.hidden ?? {}, { now: T0 + 8 * MIN });
      }),
    );
    expect(comparable(pressed[0])).toBe(comparable(pressed[1]));
    const after = await Promise.all(acks.map((m) => s.caps.customer.linkView(tokenOf(m.text), { now: T0 + 9 * MIN })));
    expect(comparable(after[0])).toBe(comparable(after[1]));
    expect((after[0] as { heading: string }).heading).toBe("Thank you, that's confirmed. We'll be in touch.");
    // Pressing it let the held one go on, as the sender's own act.
    expect((await s.q("SELECT screen FROM items ORDER BY created_at")).map((r) => r[0])).toEqual([
      "released",
      "delivered",
    ]);
    expect(acks[0]?.text).toContain(`${BASE}/c/`);
  });

  it("gives no confirm line to a known customer, and none to a message", async () => {
    const s = await spamSetup();
    const m = await s.caps.sendMessage(agent(T0), {
      body: "Hello! Are you open on public holidays?",
      contact: { name: "Bo", email: "bo@example.org" },
    });
    expect((m as { identity?: { confirm?: unknown } }).identity?.confirm ?? null).toBeNull();
  });
});

describe("the business's privacy page", () => {
  const headings = async (s: Awaited<ReturnType<typeof spamSetup>>) =>
    ((await s.caps.customer.privacy({ lang: "en" })).sections ?? []).map((x) => x.heading);

  it("says new messages may be read by an automated check only while they may", async () => {
    expect(await headings(await spamSetup())).not.toContain("Keeping out spam");
    expect(await headings(await spamSetup({ filters: ["pitches"] }))).not.toContain("Keeping out spam");
    const reading = await spamSetup({ filters: ["pitches"], judge: judge() });
    expect(await headings(reading)).toContain("Keeping out spam");
    const page = await reading.caps.customer.privacy({ lang: "pt" });
    expect(page.sections?.find((x) => x.heading === "Proteção contra spam")?.paragraphs[0]).toContain(
      "não guarda nada",
    );
    // A host that does not let its AI read: nothing to say.
    reading.caps.spam.attach({
      host: {
        ai: false,
        filters: ["pitches"],
        dayCap: 150,
        monthCap: 1_500,
        reader: null,
        billing: "off",
        price: null,
      },
    });
    expect(await headings(reading)).not.toContain("Keeping out spam");
  });
});
