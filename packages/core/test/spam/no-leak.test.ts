import { describe, expect, it } from "vitest";
import type { JudgeRequest } from "../../src/spam/judge";
import { agent, BASE, classPayload, DAY, fakeJudge, idOf, MIN, nonceOf, spamSetup, T0 } from "./harness";

/**
 * Nobody learns their request was held (ADR-041 §10.2, §14): its create answer, every later read and
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

  it("reads the same for a quote request put aside as for one delivered: at the door and on every read", async () => {
    const s = await spamSetup();
    // The owner chose Always put aside for this address, from a request of theirs long gone.
    await s.db.client.query({
      sql: "INSERT INTO spam_lists (list, kind, value, party_id, item_id, by_user, created_at) VALUES ('block', 'address', 'sales@agency.example', NULL, NULL, 'user_1', ?)",
      params: [T0 - DAY],
      method: "run",
    });
    const ask = (email: string, t: number) =>
      s.caps.requestQuote(agent(t), {
        payload: {
          itemOffered: { name: "Latte art class" },
          description: "A private class for a team of eight, please.",
        },
        contact: { name: "Sam", email },
      });
    const aside = await ask("sales@agency.example", T0 + MIN);
    const delivered = await ask("sam@office.example.org", T0 + MIN + 1);
    expect(
      (await s.q("SELECT screen, state FROM items WHERE type = 'quote_request' ORDER BY created_at")).map((r) =>
        r.join(" "),
      ),
    ).toEqual(["aside spam", "delivered received"]);
    expect(comparable(aside)).toBe(comparable(delivered));
    expect(aside.view.transitions.map((t) => t.event)).toEqual(delivered.view.transitions.map((t) => t.event));
    const read = (r: typeof aside) =>
      s.caps.getItemStatus(agent(T0 + 5 * MIN), { item_id: r.view.item.id, access_token: r.accessToken as string });
    const [a, b] = [await read(aside), await read(delivered)];
    expect(comparable(a)).toBe(comparable(b));
    expect(a).toMatchObject({ waiting_on: "us", item: { state: "received", closedAt: null } });
  });

  it("reads the same for a message put aside as for one delivered: open, waiting on us", async () => {
    const pitchJudge = fakeJudge((req: JudgeRequest) =>
      req.user.includes("first page of Google")
        ? { kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["first page of Google"] }
        : { kind: "customer", certainty: "high", customer_intent: true },
    );
    const s = await spamSetup({ filters: ["pitches"], judge: pitchJudge });
    const pitch = await s.caps.sendMessage(agent(T0), {
      body: PITCH,
      contact: { name: "Alex", email: "alex@pitch.example.net" },
    });
    const asks = await s.caps.sendMessage(agent(T0 + 1), {
      body: NOTE,
      contact: { name: "Alex", email: "alex@home.example.org" },
    });
    await s.drain(T0 + 5 * MIN);
    expect((await s.q("SELECT state FROM items ORDER BY created_at")).map((r) => r[0])).toEqual(["spam", "open"]);
    const read = (r: typeof pitch) =>
      s.caps.getItemStatus(agent(T0 + 6 * MIN), {
        item_id: idOf(r),
        access_token: (r as { accessToken?: string }).accessToken as string,
      });
    const [a, b] = [await read(pitch), await read(asks)];
    // Their own words differ; nothing else does.
    const words = (v: unknown) =>
      comparable(v)
        .replace(/"subject":"[^"]*"/g, '"subject":"WORDS"')
        .replace(/"human":"Your message \\"[^\\]*\\" is/g, '"human":"Your message WORDS is');
    expect(words(a)).toBe(words(b));
    expect(a).toMatchObject({ waiting_on: "us", item: { state: "open", closedAt: null } });
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
    const line = async (lang: "en" | "pt", heading: string) =>
      (await reading.caps.customer.privacy({ lang })).sections?.find((x) => x.heading === heading)?.paragraphs[0] ?? "";
    // A model this server's owner set up: what its provider keeps is not ours to promise.
    expect(await line("en", "Keeping out spam")).toContain("without email addresses, phone numbers or bank details");
    expect(await line("en", "Keeping out spam")).not.toContain("keeps nothing");
    expect(await line("pt", "Proteção contra spam")).not.toContain("não guarda nada");
    // The host's model, which keeps nothing (D2): then it says so.
    reading.caps.spam.attach({
      host: { ai: true, filters: ["pitches"], dayCap: 150, monthCap: 1_500, reader: null, billing: "off", price: null },
    });
    expect(await line("en", "Keeping out spam")).toContain("keeps nothing");
    expect(await line("pt", "Proteção contra spam")).toContain("não guarda nada");
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
