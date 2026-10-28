import { describe, expect, it } from "vitest";
import { filterDays } from "../../src/spam/filters";
import { agent, DAY, fakeJudge, HOUR, hostPolicy, idOf, MIN, owner, ownerAi, spamSetup, T0, visitor } from "./harness";

/**
 * Metering and plans (ADR-041 §15, the founder's decisions of 27 October 2026): a filter-day is a UTC
 * day a filter was on at any moment, counted for usage, never charged by; Pro includes the filters.
 * AI checks are counted per inbox for what they cost to run, and capped. Only a person switches a
 * filter; a plan switches on what nobody switched, and switches off what it no longer includes.
 */

const OCT = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) };
const NOV = { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 11, 1) };

describe("filter-days", () => {
  it("count each UTC day a filter was on at any moment, across day and month edges and overlapping spans", async () => {
    const s = await spamSetup();
    // On for an hour across midnight 30–31 October: two days in October.
    await s.caps.spam.setFilter(owner(0), { filter: "pitches", on: true }, Date.UTC(2026, 9, 30, 23, 30));
    await s.caps.spam.setFilter(owner(0), { filter: "pitches", on: false }, Date.UTC(2026, 9, 31, 0, 30));
    // Off and on twice on 5 November: one day.
    await s.caps.spam.setFilter(owner(0), { filter: "pitches", on: true }, Date.UTC(2026, 10, 5, 8));
    await s.caps.spam.setFilter(owner(0), { filter: "pitches", on: false }, Date.UTC(2026, 10, 5, 9));
    await s.caps.spam.setFilter(owner(0), { filter: "pitches", on: true }, Date.UTC(2026, 10, 5, 10));
    await s.caps.spam.setFilter(owner(0), { filter: "pitches", on: false }, Date.UTC(2026, 10, 5, 11));
    // Scams from 30 October to now (10 November): two days in October, ten in November.
    await s.caps.spam.setFilter(owner(0), { filter: "scams", on: true }, Date.UTC(2026, 9, 30, 12));
    const now = Date.UTC(2026, 10, 10, 12);
    expect(await filterDays(s.db, OCT, now)).toEqual({ pitches: 2, scams: 2, junk: 0 });
    expect(await filterDays(s.db, NOV, now)).toEqual({ pitches: 1, scams: 10, junk: 0 });
  });

  it("learn for a week when first switched on, and carry on where they were when switched on again within a month", async () => {
    const s = await spamSetup();
    await s.caps.spam.setFilter(owner(0), { filter: "junk", on: true }, T0);
    const first = await s.caps.spamStatus(owner(T0 + HOUR));
    expect(first.filters.find((f) => f.filter === "junk")?.learning_until).toBe(new Date(T0 + 7 * DAY).toISOString());
    await s.caps.spam.setFilter(owner(0), { filter: "junk", on: false }, T0 + DAY);
    await s.caps.spam.setFilter(owner(0), { filter: "junk", on: true }, T0 + 2 * DAY);
    const again = await s.caps.spamStatus(owner(T0 + 2 * DAY));
    expect(again.filters.find((f) => f.filter === "junk")?.learning_until).toBe(new Date(T0 + 7 * DAY).toISOString());
    await s.caps.startSpamFilterNow(owner(T0 + 3 * DAY), { filter: "junk" });
    expect(
      (await s.caps.spamStatus(owner(T0 + 3 * DAY))).filters.find((f) => f.filter === "junk")?.learning_until,
    ).toBeNull();
  });
});

describe("who switches a filter", () => {
  it("is a person signed in: never the owner's AI, a rule or a key", async () => {
    const s = await spamSetup();
    await expect(s.caps.setSpamFilter(ownerAi(T0), { filter: "pitches", on: true })).rejects.toMatchObject({
      code: "not_allowed",
      message: "Only you can change this, signed in.",
    });
    const key = {
      ...owner(T0),
      principal: {
        via: "api_key" as const,
        id: "k1",
        name: "Shop",
        scopes: ["*"],
        userId: null,
        keyKind: "integration" as const,
      },
    };
    await expect(s.caps.setSpamFilter(key, { filter: "pitches", on: true })).rejects.toMatchObject({
      code: "not_allowed",
    });
    expect((await s.caps.spamStatus(ownerAi(T0))).can_change).toBe(false);
    expect((await s.caps.spamStatus(owner(T0))).can_change).toBe(true);
  });

  it("may only switch on what the plan includes: Free keeps basic protection, and its filters come with Pro", async () => {
    const s = await spamSetup({ host: hostPolicy({ plan: "free", ai: false, filters: [] }) });
    await expect(s.caps.setSpamFilter(owner(T0), { filter: "scams", on: true })).rejects.toMatchObject({
      code: "not_allowed",
      message: "The filters come with Pro.",
      details: { reason: "plan" },
    });
    const status = await s.caps.spamStatus(owner(T0));
    expect(status.plan).toBe("free");
    expect(status.reader).toBe("hosted_phrases");
    expect(status.reader_name).toBeNull();
    expect(status.filters.map((f) => [f.on, f.allowed])).toEqual([
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it("switches off, as the system, what the plan no longer includes", async () => {
    const s = await spamSetup({ host: hostPolicy({ filters: ["pitches"] }) });
    await s.caps.setSpamFilter(owner(T0), { filter: "pitches", on: true });
    await expect(s.caps.setSpamFilter(owner(T0), { filter: "scams", on: true })).rejects.toMatchObject({
      code: "not_allowed",
      details: { reason: "not_offered" },
    });
    s.caps.spam.attach({ host: hostPolicy({ plan: "free", ai: false, filters: [] }) });
    await s.caps.spam.applyHost(T0 + HOUR);
    expect(await s.q("SELECT filter, by_kind FROM spam_filter_spans WHERE filter = 'pitches'")).toEqual([
      ["pitches", "system"],
    ]);
    const status = await s.caps.spamStatus(owner(T0 + 2 * HOUR));
    expect(status.filters.every((f) => !f.on)).toBe(true);
    expect(status.plan).toBe("free");
  });
});

describe("Pro's filters", () => {
  const pro = (over = {}) => hostPolicy({ defaultOn: true, reader: "Gemini Flash-Lite, by Google", ...over });

  it("start on as the inbox opens, learning for a week: they label, and put nothing aside yet", async () => {
    const judge = fakeJudge({ kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["rank your cafe first"] });
    const s = await spamSetup({ judge, host: pro() });
    await s.caps.spam.applyHost(T0);
    const status = await s.caps.spamStatus(owner(T0 + MIN));
    expect(status.plan).toBe("pro");
    expect(status.reader).toBe("hosted_ai");
    expect(status.reader_name).toBe("Gemini Flash-Lite, by Google");
    for (const f of status.filters) {
      expect(f).toMatchObject({ on: true, allowed: true, choice: "aside" });
      expect(f.learning_until).toBe(new Date(T0 + 7 * DAY).toISOString());
    }
    expect(await s.q("SELECT DISTINCT by_kind, by_id FROM spam_filter_spans WHERE filter <> 'basic'")).toEqual([
      ["system", "host"],
    ]);
    // Opening again changes nothing: one span each.
    await s.caps.spam.applyHost(T0 + HOUR);
    expect(await s.q("SELECT COUNT(*) FROM spam_filter_spans WHERE filter <> 'basic'")).toEqual([[3]]);
    const pitch = await s.caps.sendMessage(agent(T0 + 2 * HOUR), {
      body: "We will rank your cafe first on every search, guaranteed or your money back.",
      contact: { name: "Growth Team", email: "growth@pitch.example.net" },
    });
    await s.drain(T0 + 2 * HOUR);
    expect(await s.q("SELECT verdict, learning FROM spam_verdicts WHERE item_id = ?", [idOf(pitch)])).toEqual([
      ["warn", 1],
    ]);
  });

  it("never switch on again a filter a person switched off, and come back after a plan that lapsed", async () => {
    const s = await spamSetup({ host: pro() });
    await s.caps.spam.applyHost(T0);
    await s.caps.setSpamFilter(owner(T0 + HOUR), { filter: "junk", on: false });
    await s.caps.spam.applyHost(T0 + 2 * HOUR);
    expect((await s.caps.spamStatus(owner(T0 + 2 * HOUR))).filters.map((f) => f.on)).toEqual([true, true, false]);
    // Free for a while: the plan switches them off; Pro again: the plan's come back, where they were in
    // their learning week; the one the owner switched off stays off.
    s.caps.spam.attach({ host: hostPolicy({ plan: "free", ai: false, filters: [] }) });
    await s.caps.spam.applyHost(T0 + 3 * HOUR);
    expect((await s.caps.spamStatus(owner(T0 + 3 * HOUR))).filters.map((f) => f.on)).toEqual([false, false, false]);
    s.caps.spam.attach({ host: pro() });
    await s.caps.spam.applyHost(T0 + 2 * DAY);
    const back = await s.caps.spamStatus(owner(T0 + 2 * DAY));
    expect(back.filters.map((f) => [f.filter, f.on, f.learning_until])).toEqual([
      ["pitches", true, new Date(T0 + 7 * DAY).toISOString()],
      ["scams", true, new Date(T0 + 7 * DAY).toISOString()],
      ["junk", false, null],
    ]);
  });

  it("are read by no AI while the host's model is not set up, and Settings says no AI reads", async () => {
    const s = await spamSetup({ host: pro({ ai: false, reader: null }) });
    await s.caps.spam.applyHost(T0);
    const status = await s.caps.spamStatus(owner(T0));
    expect(status.filters.every((f) => f.on)).toBe(true);
    expect(status.reader).toBe("hosted_phrases");
    expect(status.reader_name).toBeNull();
  });
});

describe("the month's usage", () => {
  it("counts filter-days, AI checks and their tokens, and what was put aside, held, labelled, let in and brought back", async () => {
    const judge = fakeJudge((req) =>
      req.user.includes("pitch.example.net")
        ? { kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["rank"] }
        : { kind: "customer", certainty: "high" },
    );
    const s = await spamSetup({ filters: ["pitches"], judge });
    const pitch = await s.caps.sendMessage(agent(T0), {
      body: "We will rank your cafe first on every search, guaranteed or your money back.",
      contact: { email: "a@pitch.example.net" },
    });
    await s.caps.sendMessage(agent(T0 + MIN), {
      body: "Do you sell your beans in 1 kg bags? I run a small kiosk.",
      contact: { email: "b@kiosk.example.org" },
    });
    await s.drain(T0 + 2 * MIN);
    await s.caps.transitionItem(owner(T0 + 3 * MIN), {
      item_id: (pitch as { view: { item: { id: string } } }).view.item.id,
      event: "unspam",
    });
    const usage = await s.caps.spam.usage(OCT, T0 + HOUR);
    expect(usage).toMatchObject({
      judged: 2,
      reused: 0,
      capped: 0,
      failed: 0,
      tokens_in: 3_600,
      tokens_out: 160,
      aside: 1,
      held: 0,
      brought_back: 1,
    });
    // On from eight days before T0 (the harness): 26 October counts, and every day back to 18 October.
    expect(usage.filter_days.pitches).toBe(9);
    expect(usage.filter_days.scams).toBe(0);
  });

  it("counts no check the host's ledger refused as one made", async () => {
    const judge = fakeJudge(() => ({ ok: false, why: "capped" }));
    const s = await spamSetup({ filters: ["pitches"], judge });
    await s.caps.sendMessage(agent(T0), {
      body: "We will rank your cafe first on every search, guaranteed or your money back.",
      contact: { email: "a@pitch.example.net" },
    });
    await s.drain(T0 + MIN);
    expect(judge.calls).toHaveLength(1);
    expect(await s.caps.spam.usage(OCT, T0 + HOUR)).toMatchObject({ judged: 0, capped: 1 });
  });

  it("leaves what is held, being screened or put aside out of a hosted inbox's requests, and counts one let in again", async () => {
    const s = await spamSetup();
    await s.caps.createBooking(agent(T0), {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Latte art class" },
        startTime: new Date(T0 + 3 * DAY + HOUR).toISOString(),
        endTime: new Date(T0 + 3 * DAY + 2 * HOUR).toISOString(),
      },
      contact: { name: "A", email: "a@example.org" },
    });
    const count = async () =>
      Number(
        (
          await s.q(
            "SELECT COUNT(*) FROM items WHERE COALESCE(sandbox, 0) = 0 AND state <> 'spam' AND COALESCE(screen, '') NOT IN ('pending', 'held', 'aside')",
          )
        )[0]?.[0],
      );
    expect(await count()).toBe(1);
    await s.q("UPDATE items SET screen = 'held'");
    expect(await count()).toBe(0);
    await s.q("UPDATE items SET screen = 'released'");
    expect(await count()).toBe(1);
  });
});

describe("a bot's run at the form", () => {
  it("costs no AI check when what it did there puts it aside alone, and leaves the caps to real pitches", async () => {
    const judge = fakeJudge({ kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["rank your cafe first"] });
    const s = await spamSetup({
      filters: ["pitches"],
      judge,
      host: hostPolicy({ filters: ["pitches"], dayCap: 5 }),
    });
    // Twenty posts under forged keys, each sent less than half a second after the form was drawn.
    for (let i = 0; i < 20; i++) {
      const t = T0 + i * 1_000;
      const r = await s.caps.sendMessage(
        visitor(t),
        {
          body: `Cheap followers for your page, offer number ${i}, best prices this week.`,
          contact: { name: `Bot ${i}`, email: `bot${i}@followers${i}.example.net` },
        },
        { screen: { door: "form", form: { key: "invalid", trap: false, drawnAt: t - 400 } } },
      );
      await s.drain(t);
      expect(await s.q("SELECT screen FROM items WHERE id = ?", [idOf(r)])).toEqual([["aside"]]);
    }
    expect(judge.calls).toHaveLength(0);
    // A real pitch, typed at the form at a person's pace, is still read: the day's checks are its own.
    const t = T0 + 5 * MIN;
    const pitch = await s.caps.sendMessage(
      visitor(t),
      {
        body: "Hello, we will rank your cafe first on every search, guaranteed or your money back. Reply for prices.",
        contact: { name: "Rank Co", email: "hello@rankco.example.net" },
      },
      { screen: { door: "form", form: { key: "valid", trap: false, drawnAt: t - 90_000 } } },
    );
    await s.drain(t + MIN);
    expect(judge.calls).toHaveLength(1);
    expect(
      await s.q("SELECT i.screen, v.ai FROM items i JOIN spam_verdicts v ON v.item_id = i.id WHERE i.id = ?", [
        idOf(pitch),
      ]),
    ).toEqual([["aside", "judged"]]);
  });
});
