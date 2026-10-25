import { describe, expect, it } from "vitest";
import {
  heldDigestMail,
  heldWhat,
  heldWhenWords,
  nextLocal,
  SPAM_HELD_DIGEST_KIND,
  SPAM_WEEKLY_KIND,
  scheduleSpamEmails,
  weeklyMail,
} from "../../src/spam/emails";
import { agent, classPayload, DAY, HOUR, MIN, owner, spamSetup, T0, visitor } from "./harness";

/**
 * The spam filter's two emails to the owner (ADR-029 §11.6): the morning digest of what was held,
 * and Monday's summary of what was put aside, each only when there is something to say, worded as
 * the plan has them, with links that only open the owner app.
 */

const ownerMails = (s: Awaited<ReturnType<typeof spamSetup>>) =>
  s.mail.sent.filter((m) => m.to.includes("owner@kopisenja.example"));

/** A bot's booking, held at the door (a form never drawn). */
async function heldBooking(s: Awaited<ReturnType<typeof spamSetup>>, t: number, name: string, email: string) {
  const b = await s.caps.createBooking(
    visitor(t),
    { payload: classPayload(s.svc, T0 + 4 * DAY + 2 * HOUR), contact: { name, email } },
    { screen: { door: "form", form: { key: "none", trap: false } } },
  );
  return b.view.item.id;
}

/** A form message a bot sent, put aside at the door. */
async function asideMessage(s: Awaited<ReturnType<typeof spamSetup>>, t: number, name: string, body: string) {
  const r = await s.caps.sendMessage(
    visitor(t),
    { body, contact: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@example.net` } },
    { screen: { door: "form", form: { key: "valid", trap: true, drawnAt: t - 30_000 } } },
  );
  return (r as { view: { item: { id: string } } }).view.item.id;
}

describe("the words", () => {
  it("names what was held, at most ten, exactly as the plan says it", () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({
      who: `Guest ${i + 1}`,
      what: "Booking request for Fri 30 Oct, 15:00",
      chip: "Sales pitch",
    }));
    const one = heldDigestMail(lines.slice(0, 1), 1, "https://inbox.kopisenja.example/?f=held");
    expect(one?.subject).toBe("1 held for you to check");
    expect(one?.text).toBe(
      [
        "The spam filter held these since yesterday. You weren't alerted and nothing ran. Let in anything that's yours:",
        "",
        "· Guest 1 — Booking request for Fri 30 Oct, 15:00 — Sales pitch",
        "",
        "Open Held: https://inbox.kopisenja.example/?f=held",
        "",
        "You get this when something new is held. Change it in Settings → Spam.",
      ].join("\n"),
    );
    const many = heldDigestMail(lines, 12, "https://inbox.kopisenja.example/?f=held");
    expect(many?.subject).toBe("12 held for you to check");
    expect(many?.text.split("\n").filter((l) => l.startsWith("· Guest"))).toHaveLength(10);
    expect(many?.text).toContain("· and 2 more");
    expect(heldDigestMail([], 0, "x")).toBeNull();
    // A sender held for an uncertain reason got their acknowledgement: nobody says nobody was told.
    expect(one?.text).not.toMatch(/nobody was told/i);
  });

  it("sums up the week with the three nearest the line", () => {
    const m = weeklyMail(
      7,
      2,
      [
        { who: "Ngozi Adeyemi", line: "Do you roast decaf?" },
        { who: "example.net", line: "" },
      ],
      "https://inbox.kopisenja.example/?f=spam",
    );
    expect(m?.subject).toBe("Spam this week: 7 put aside");
    expect(m?.text).toBe(
      [
        "7 messages were put aside this week, and 2 are held.",
        "",
        "These looked the most like customers; worth a glance:",
        "· Ngozi Adeyemi — “Do you roast decaf?”",
        "· example.net",
        "",
        "See everything under Spam: https://inbox.kopisenja.example/?f=spam",
        "",
        "You get this on Mondays when something was put aside. Turn it off in Settings → Spam.",
      ].join("\n"),
    );
    expect(weeklyMail(1, 0, [], "")?.text.startsWith("1 message was put aside this week.")).toBe(true);
    expect(weeklyMail(0, 3, [], "x")).toBeNull();
  });

  it("says a booking's time in the business's own zone", () => {
    expect(heldWhenWords("2026-10-30T08:00:00Z", "Asia/Jakarta")).toBe("Fri 30 Oct, 15:00");
    expect(heldWhat("booking", "2026-10-30T08:00:00Z", "Asia/Jakarta")).toBe("Booking request for Fri 30 Oct, 15:00");
    expect(heldWhat("quote_request", null, "UTC")).toBe("Quote request");
    expect(heldWhat("order", null, "UTC")).toBe("Order");
  });
});

describe("when they go", () => {
  it("is due at nine each morning and at eight on Mondays, in the business's time", () => {
    // T0 is Monday 26 October, 09:00 UTC: 16:00 in Jakarta.
    const digest = nextLocal(T0, "Asia/Jakarta", 9);
    expect(digest).toEqual({ day: "2026-10-27", at: Date.parse("2026-10-27T02:00:00Z") });
    const monday = nextLocal(T0, "Asia/Jakarta", 8, (d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 1);
    expect(monday).toEqual({ day: "2026-11-02", at: Date.parse("2026-11-02T01:00:00Z") });
    // Before nine the same morning: today.
    expect(nextLocal(Date.parse("2026-10-26T01:00:00Z"), "Asia/Jakarta", 9).day).toBe("2026-10-26");
  });

  it("schedules each once, whatever the number of sweeps", async () => {
    const s = await spamSetup();
    for (const t of [T0, T0 + 15 * MIN, T0 + 30 * MIN]) await scheduleSpamEmails(s.db, t);
    expect(
      await s.q("SELECT kind, run_at FROM jobs WHERE kind IN (?, ?) ORDER BY kind", [
        SPAM_HELD_DIGEST_KIND,
        SPAM_WEEKLY_KIND,
      ]),
    ).toEqual([
      [SPAM_HELD_DIGEST_KIND, Date.parse("2026-10-27T02:00:00Z")],
      [SPAM_WEEKLY_KIND, Date.parse("2026-11-02T01:00:00Z")],
    ]);
  });
});

describe("the morning digest", () => {
  it("names what was newly held, and links only to the app", async () => {
    const s = await spamSetup();
    await heldBooking(s, T0 + HOUR, "Rangi Parata", "rangi@example.net");
    await heldBooking(s, T0 + 2 * HOUR, "", "orders@bulk.example.com");
    await s.drain(T0 + 3 * HOUR);
    expect(ownerMails(s)).toHaveLength(0);
    await scheduleSpamEmails(s.db, T0 + 3 * HOUR);
    const due = Date.parse("2026-10-27T02:00:00Z");
    await s.drain(due);
    const [digest] = ownerMails(s);
    expect(ownerMails(s)).toHaveLength(1);
    expect(digest?.subject).toBe("2 held for you to check");
    expect(digest?.text).toContain("· Rangi Parata — Booking request for Fri 30 Oct, 18:00 — Not sent from your form");
    // No name: the email's domain.
    expect(digest?.text).toContain(
      "· bulk.example.com — Booking request for Fri 30 Oct, 18:00 — Not sent from your form",
    );
    expect(digest?.text).toContain("Open Held: https://inbox.kopisenja.example/?f=held");
    // The link opens the app, where a person signs in: no token, no action in it.
    const links = digest?.text.match(/https?:\/\/\S+/g) ?? [];
    expect(links).toEqual(["https://inbox.kopisenja.example/?f=held"]);
    expect(digest?.headers?.["Auto-Submitted"]).toBe("auto-generated");
  });

  it("says nothing when nothing new was held, or when the owner switched it off", async () => {
    const s = await spamSetup();
    await scheduleSpamEmails(s.db, T0);
    await s.drain(Date.parse("2026-10-27T02:00:00Z"));
    expect(ownerMails(s)).toHaveLength(0);
    expect(await s.q("SELECT COUNT(*) FROM outbound_mail WHERE template LIKE 'owner.spam%'")).toEqual([[0]]);

    const off = await spamSetup();
    await off.caps.updateSettings(owner(T0), { doc: { spam: { heldDigest: false } } });
    await heldBooking(off, T0 + HOUR, "Rangi Parata", "rangi@example.net");
    await scheduleSpamEmails(off.db, T0 + HOUR);
    await off.drain(Date.parse("2026-10-27T02:00:00Z"));
    expect(ownerMails(off)).toHaveLength(0);
  });

  it("leaves out what was let in since", async () => {
    const s = await spamSetup();
    const kept = await heldBooking(s, T0 + HOUR, "Rangi Parata", "rangi@example.net");
    await heldBooking(s, T0 + 2 * HOUR, "Ana Lima", "ana.lima@example.com");
    await s.caps.letIn(owner(T0 + 3 * HOUR), { item_id: kept });
    await scheduleSpamEmails(s.db, T0 + 3 * HOUR);
    await s.drain(Date.parse("2026-10-27T02:00:00Z"));
    const digest = ownerMails(s).find((m) => m.subject.includes("held"));
    expect(digest?.subject).toBe("1 held for you to check");
    expect(digest?.text).not.toContain("Rangi");
  });
});

describe("the Monday summary", () => {
  it("counts the week and offers the three that looked most like customers", async () => {
    const s = await spamSetup({ filters: ["pitches"] });
    const ids: string[] = [];
    for (const [i, name] of ["Sipho Dlamini", "Mei Lin", "Omar Haddad", "Ines Moreau"].entries()) {
      ids.push(
        await asideMessage(s, T0 + (i + 1) * HOUR, name, `Hello, a question number ${i + 1} about your classes.`),
      );
    }
    // Two of them nearer the line than the rest: not certain, few points.
    await s.db.batch(
      [ids[1], ids[3]].map((id) => ({
        sql: "UPDATE spam_verdicts SET certain = 0, score = 3 WHERE item_id = ?",
        params: [id],
        method: "run" as const,
      })),
    );
    await heldBooking(s, T0 + 5 * HOUR, "Rangi Parata", "rangi@example.net");
    // Mondays at eight in Jakarta: the next is 2 November, 01:00 UTC.
    await scheduleSpamEmails(s.db, T0 + 6 * HOUR);
    await s.drain(Date.parse("2026-11-02T01:00:00Z"));
    const summary = ownerMails(s).find((m) => m.subject.startsWith("Spam this week"));
    expect(summary?.subject).toBe("Spam this week: 4 put aside");
    expect(summary?.text.split("\n")[0]).toBe("4 messages were put aside this week, and 1 is held.");
    const named = (summary?.text.split("\n") ?? []).filter((l) => l.startsWith("· "));
    expect(named).toHaveLength(3);
    expect(named[0]).toMatch(/^· (Mei Lin|Ines Moreau) — “Hello, a question number/);
    expect(named[1]).toMatch(/^· (Mei Lin|Ines Moreau) — /);
    expect(summary?.text).toContain("See everything under Spam: https://inbox.kopisenja.example/?f=spam");
  });

  it("says nothing in a week nothing was put aside", async () => {
    const s = await spamSetup();
    await s.caps.sendMessage(agent(T0), {
      body: "Do you still have the Toraja beans? I'd like two bags.",
      contact: { name: "Amara Okafor", email: "amara@example.org" },
    });
    await scheduleSpamEmails(s.db, T0);
    await s.drain(Date.parse("2026-11-02T01:00:00Z"));
    expect(ownerMails(s).filter((m) => m.subject.startsWith("Spam this week"))).toHaveLength(0);
  });
});

describe("what the emails quote of a sender", () => {
  it("is masked: no live link, address or number from a put-aside message reaches the owner's mailbox", async () => {
    const s = await spamSetup();
    await asideMessage(
      s,
      T0 + HOUR,
      "Account Team support@secure-login.example.net",
      "Your account is locked: sign in at https://secure-login.example.net/verify or call +44 20 7946 0958 today.",
    );
    await heldBooking(s, T0 + 2 * HOUR, "billing@pay-now.example.net", "x@pay-now.example.net");
    await scheduleSpamEmails(s.db, T0 + 3 * HOUR);
    await s.drain(Date.parse("2026-10-27T02:00:00Z"));
    await s.drain(Date.parse("2026-11-02T01:00:00Z"));
    const digest = ownerMails(s).find((m) => m.subject.includes("held for you"));
    const summary = ownerMails(s).find((m) => m.subject.startsWith("Spam this week"));
    expect(digest?.text).toContain("· [email] — Booking request");
    const quoted = (summary?.text.split("\n") ?? []).filter((l) => l.startsWith("· "));
    expect(quoted).toEqual([
      "· Account Team [email] — “Your account is locked: sign in at [link to example.net] or call [phone] today.”",
    ]);
    // The only links are the app's own.
    for (const m of [digest, summary]) {
      expect(
        (m?.text.match(/https?:\/\/\S+/g) ?? []).every((l) => l.startsWith("https://inbox.kopisenja.example/")),
      ).toBe(true);
    }
  });
});
