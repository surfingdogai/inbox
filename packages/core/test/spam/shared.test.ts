import { describe, expect, it } from "vitest";
import {
  companyDomain,
  NO_MATCH,
  reportedKind,
  SHARE_BANDS,
  sharedPrintOf,
  sharedSignals,
  sharedText,
  sureAside,
} from "../../src/spam/shared";
import type { Filter } from "../../src/spam/types";

/**
 * The fingerprint a hosted inbox shares of known spam (ADR-041 §16): MinHash bands of the text with its
 * links, addresses, phone numbers and digits masked, and the sender's company domain. Never words: what
 * leaves is bands of hash values, which the host keys again before it keeps one.
 */

const PITCH =
  "Hello! We help cafés like yours reach the first page of Google within 30 days. Our team has helped 250 businesses grow. Reply to this email or call +44 20 7946 0958 for a free audit: https://growth-agency.example/audit";
// The same pitch, sent on by another sender: other numbers, another link, another address, one word changed.
const RESENT =
  "Hello! We help cafés like yours reach the first page of Google within 14 days. Our team has helped 900 businesses grow. Reply to this email or call +1 415 555 0134 for a free audit: www.other-domain.example/x?ref=77 or seo@another.example";
const CUSTOMER =
  "Hi, I'd like to book the latte art class for two people on Saturday morning. Is there parking near the café, and can we bring our own milk alternative? Thanks a lot!";

const shared = (a: readonly string[], b: readonly string[]) => a.filter((x) => b.includes(x)).length;

describe("the text a fingerprint is made of", () => {
  it("masks links whole, email addresses, phone numbers and every digit", () => {
    const t = sharedText(PITCH);
    expect(t).not.toMatch(/growth-agency|example|\d|7946|@/);
    expect(t).toContain("[link]");
    expect(t).toContain("[phone]");
    expect(sharedText("Write to maria.silva@empresa.pt or visit empresa.pt/promo now")).toBe(
      "write to [email] or visit [link] now",
    );
    // Look-alike letters and invisible characters change nothing.
    expect(sharedText("Fr​ee аudit")).toBe(sharedText("Free audit"));
  });

  it("gives a short message no fingerprint: short questions are alike everywhere", () => {
    expect(sharedPrintOf("Are you open on Sunday?")).toBeNull();
    expect(sharedPrintOf(`${"https://a.example/x ".repeat(20)}`)).toBeNull();
  });
});

describe("the fingerprint", () => {
  it("is the same for a copy resent with other links, numbers and addresses, and close for one word changed", () => {
    const a = sharedPrintOf(PITCH);
    const b = sharedPrintOf(RESENT.replace(" or seo@another.example", ""));
    expect(a?.bands).toHaveLength(SHARE_BANDS);
    expect(a?.bands).toEqual(b?.bands);
    const reworded = sharedPrintOf(PITCH.replace("grow", "thrive"));
    expect(shared(a?.bands ?? [], reworded?.bands ?? [])).toBeGreaterThanOrEqual(2);
  });

  it("shares nothing with a customer's message", () => {
    const a = sharedPrintOf(PITCH);
    const c = sharedPrintOf(CUSTOMER);
    expect(shared(a?.bands ?? [], c?.bands ?? [])).toBeLessThan(2);
  });

  it("holds hash values only: no word of the message, no address, no number", () => {
    const print = sharedPrintOf(PITCH, "growth@growth-agency.example");
    for (const band of print?.bands ?? []) expect(band).toMatch(/^[0-7]:[0-9a-f]{32}$/);
    expect(JSON.stringify(print)).not.toMatch(/google|audit|cafés|7946|growth@/i);
    expect(print?.domain).toBe("growth-agency.example");
  });

  it("names a company's mail domain, never a provider many share or a throwaway one", () => {
    expect(companyDomain("someone@gmail.com")).toBeNull();
    expect(companyDomain("someone@mailinator.com")).toBeNull();
    expect(companyDomain("ana@mail.empresa.co.uk")).toBe("empresa.co.uk");
    expect(companyDomain(undefined)).toBeNull();
  });
});

describe("a shared match as points", () => {
  const known = { known: true, owners: 4, kind: "pitches" as Filter | null, domain: false };

  it("on Free, or with the filter it is under off, labels and never decides alone", () => {
    expect(sharedSignals(known, { on: new Set(), templated: false, domain: null })).toEqual([
      { c: "shared_spam", w: 4, f: "basic", v: 4 },
    ]);
    expect(sharedSignals(known, { on: new Set(["scams", "junk"]), templated: false, domain: null })).toEqual([
      { c: "shared_spam", w: 4, f: "basic", v: 4 },
    ]);
  });

  it("goes under the filter its reporters named when it is on, which then does as it is set to", () => {
    expect(sharedSignals(known, { on: new Set(["pitches"]), templated: false, domain: null })).toEqual([
      { c: "shared_spam", w: 6, f: "pitches", v: 4 },
    ]);
    // Nobody named a kind: Junk's.
    expect(sharedSignals({ ...known, kind: null }, { on: new Set(["junk"]), templated: false, domain: null })).toEqual([
      { c: "shared_spam", w: 6, f: "junk", v: 4 },
    ]);
  });

  it("only labels a booking's or an order's note: assistants write those alike for many people", () => {
    expect(sharedSignals(known, { on: new Set(["pitches"]), templated: true, domain: null })).toEqual([
      { c: "shared_spam", w: 4, f: "basic", v: 4 },
    ]);
  });

  it("adds points for a sender's domain known for spam, too few to label alone, and nothing for no match", () => {
    expect(
      sharedSignals({ ...NO_MATCH, domain: true }, { on: new Set(), templated: false, domain: "agency.example" }),
    ).toEqual([{ c: "shared_domain", w: 2, f: "basic", d: "agency.example" }]);
    expect(sharedSignals(NO_MATCH, { on: new Set(["pitches"]), templated: false, domain: "agency.example" })).toEqual(
      [],
    );
  });
});

describe("what is reported as known spam on its own", () => {
  const base = { verdict: "aside", cause: null, certain: false, learning: false, answer: null };
  it("is what a bot, a server's mark or a wave put aside, or the AI check was sure of with a quote", () => {
    for (const cause of ["trap", "no_key", "server_marked", "wave"]) {
      expect(sureAside({ ...base, cause, certain: true }), cause).toBe(true);
    }
    const sure = { kind: "sales_pitch", certainty: "high", customerIntent: false, quotes: 1 };
    expect(sureAside({ ...base, cause: "pitches", answer: sure })).toBe(true);
  });

  it("is never the owner's Always put aside, a learning week's, a doubtful answer, or what was not put aside", () => {
    expect(sureAside({ ...base, cause: "blocked", certain: true })).toBe(false);
    expect(sureAside({ ...base, cause: "like_marked", certain: true })).toBe(false);
    expect(sureAside({ ...base, cause: "trap", certain: true, learning: true })).toBe(false);
    expect(sureAside({ ...base, verdict: "hold", cause: "trap", certain: true })).toBe(false);
    const answer = { kind: "sales_pitch", certainty: "high", customerIntent: false, quotes: 1 };
    expect(sureAside({ ...base, answer: { ...answer, quotes: 0 } })).toBe(false);
    expect(sureAside({ ...base, answer: { ...answer, certainty: "medium" } })).toBe(false);
    expect(sureAside({ ...base, answer: { ...answer, customerIntent: true } })).toBe(false);
    // Points alone, a shared match's among them, are no proof.
    expect(sureAside({ ...base, cause: "pitches" })).toBe(false);
  });

  it("names the filter the AI check or the cause said", () => {
    expect(reportedKind(null, "scam")).toBe("scams");
    expect(reportedKind("junk", null)).toBe("junk");
    expect(reportedKind("trap", undefined)).toBeNull();
  });
});
