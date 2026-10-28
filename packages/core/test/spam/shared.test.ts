import { describe, expect, it } from "vitest";
import { chipOf } from "../../src/spam/copy";
import { decide } from "../../src/spam/decide";
import {
  companyDomain,
  NO_MATCH,
  reportedKind,
  SHARE_BANDS,
  SHARED_DOMAIN_POINTS,
  SHARED_POINTS,
  sharedPrintOf,
  sharedSignals,
  sharedText,
  sureAside,
} from "../../src/spam/shared";
import { ASIDE_AT, type Filter, type Signal, WARN_AT } from "../../src/spam/types";

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
  const match = (f: Filter | "basic") => ({ c: "shared_spam", w: SHARED_POINTS, f, v: 4 });

  it("is worth a label: under the free protection on Free, or with the filter it is under off", () => {
    expect(SHARED_POINTS).toBe(WARN_AT);
    expect(sharedSignals(known, { on: new Set(), templated: false, domain: null })).toEqual([match("basic")]);
    expect(sharedSignals(known, { on: new Set(["scams", "junk"]), templated: false, domain: null })).toEqual([
      match("basic"),
    ]);
  });

  it("goes under the filter its reporters named when it is on, so its learning week and Just label apply", () => {
    expect(sharedSignals(known, { on: new Set(["pitches"]), templated: false, domain: null })).toEqual([
      match("pitches"),
    ]);
    // Nobody named a kind: Junk's.
    expect(sharedSignals({ ...known, kind: null }, { on: new Set(["junk"]), templated: false, domain: null })).toEqual([
      match("junk"),
    ]);
  });

  it("only labels a booking's or an order's note: assistants write those alike for many people", () => {
    expect(sharedSignals(known, { on: new Set(["pitches"]), templated: true, domain: null })).toEqual([match("basic")]);
  });

  it("adds points for a sender's domain known for spam, too few to label alone, and nothing for no match", () => {
    expect(SHARED_POINTS + SHARED_DOMAIN_POINTS).toBeLessThan(ASIDE_AT);
    expect(
      sharedSignals({ ...NO_MATCH, domain: true }, { on: new Set(), templated: false, domain: "agency.example" }),
    ).toEqual([{ c: "shared_domain", w: SHARED_DOMAIN_POINTS, f: "basic", d: "agency.example" }]);
    // No domain from the message (none vouched for): nothing, whatever the list says of one.
    expect(sharedSignals({ ...NO_MATCH, domain: true }, { on: new Set(), templated: false, domain: null })).toEqual([]);
    expect(sharedSignals(NO_MATCH, { on: new Set(["pitches"]), templated: false, domain: "agency.example" })).toEqual(
      [],
    );
  });
});

/**
 * The rule the founder set (ADR-041 §16.5): a match on the shared list never puts a message aside, nor
 * holds a booking or an order, on its own. It labels ("Seen as spam at other businesses"); with a signal
 * of this inbox's own checks or of the AI beside it, it adds its points.
 */
describe("what a shared match decides", () => {
  const known = { known: true, owners: 5, kind: "pitches" as Filter | null, domain: true };
  const shared = (on: readonly Filter[], templated = false) =>
    sharedSignals(known, { on: new Set(on), templated, domain: "agency.example" });
  const asideChoices = (on: readonly Filter[]) => new Map(on.map((f) => [f, "aside" as const]));
  const plans: { name: string; on: readonly Filter[] }[] = [
    { name: "Free", on: [] },
    { name: "Pro, the named filter off", on: ["scams", "junk"] },
    { name: "Pro, the named filter on", on: ["pitches", "scams", "junk"] },
  ];

  for (const plan of plans) {
    it(`alone, with the sender's domain known too, only labels a message, on ${plan.name}`, () => {
      const d = decide({ type: "message", signals: shared(plan.on), choices: asideChoices(plan.on) });
      expect(d).toMatchObject({ verdict: "warn", cause: "shared_spam", label: "shared_spam", learning: false });
      expect(chipOf(d.label, true)).toBe("Seen as spam at other businesses");
    });

    it(`alone never holds a booking, an order or a quote request, on ${plan.name}`, () => {
      for (const type of ["booking", "order"] as const) {
        const d = decide({ type, signals: shared(plan.on, true), choices: asideChoices(plan.on) });
        expect(d.verdict, type).toBe("warn");
      }
      const quote = decide({ type: "quote_request", signals: shared(plan.on), choices: asideChoices(plan.on) });
      expect(quote.verdict).toBe("warn");
    });

    it(`adds to a signal of this inbox's own, and together they put a message aside, on ${plan.name}`, () => {
      const own: Signal = { c: "link_only", w: 3, f: "basic" };
      const d = decide({ type: "message", signals: [own, ...shared(plan.on)], choices: asideChoices(plan.on) });
      expect(d.verdict).toBe("aside");
      // Without the match, the same message is only labelled: the match added its weight.
      expect(decide({ type: "message", signals: [own], choices: asideChoices(plan.on) }).verdict).toBe("warn");
    });

    it(`beside a signal of the inbox's own too weak to label alone, only labels, on ${plan.name}`, () => {
      // Each delivers a message with no label on its own; the text and the domain known add 5 points.
      const weak: Signal[] = [
        { c: "reply_elsewhere", w: 2, f: "basic" },
        { c: "many_links", w: 2, f: "basic" },
        { c: "disposable", w: 2, f: "basic" },
        { c: "display_other", w: 2, f: "basic" },
      ];
      for (const own of weak) {
        expect(decide({ type: "message", signals: [own], choices: asideChoices(plan.on) }).verdict, own.c).toBe(
          "deliver",
        );
        const d = decide({ type: "message", signals: [own, ...shared(plan.on)], choices: asideChoices(plan.on) });
        expect(d.score, own.c).toBeGreaterThanOrEqual(ASIDE_AT);
        expect(d, own.c).toMatchObject({ verdict: "warn", cause: "shared_spam", label: "shared_spam" });
        const quote = decide({
          type: "quote_request",
          signals: [own, ...shared(plan.on)],
          choices: asideChoices(plan.on),
        });
        expect(quote.verdict, own.c).toBe("warn");
      }
      // Mail a server vouched for: its point off leaves the Reply-To elsewhere at 1, and only a label.
      const vouched: Signal[] = [
        { c: "aligned", w: -1, f: "basic" },
        { c: "reply_elsewhere", w: 2, f: "basic" },
      ];
      expect(
        decide({ type: "message", signals: [...vouched, ...shared(plan.on)], choices: asideChoices(plan.on) }).verdict,
      ).toBe("warn");
      // Two of them together label on their own, and the match beside them puts the message aside.
      const two = weak.slice(0, 2);
      expect(decide({ type: "message", signals: two, choices: asideChoices(plan.on) }).verdict).toBe("warn");
      expect(
        decide({ type: "message", signals: [...two, ...shared(plan.on)], choices: asideChoices(plan.on) }).verdict,
      ).toBe("aside");
    });

    it(`with a signal of the inbox's own, still never holds a booking's or an order's note on it, on ${plan.name}`, () => {
      const own: Signal = { c: "many_links", w: 2, f: "basic" };
      for (const type of ["booking", "order"] as const) {
        const d = decide({ type, signals: [own, ...shared(plan.on, true)], choices: asideChoices(plan.on) });
        expect(d.verdict, type).toBe("warn");
      }
      // A quote request, which the sender confirms, is held for proof.
      const quote = decide({
        type: "quote_request",
        signals: [{ c: "link_only", w: 3, f: "basic" }, ...shared(plan.on)],
        choices: asideChoices(plan.on),
      });
      expect(quote.verdict).toBe("hold");
    });
  }

  it("adds to what the AI check found, and a customer in the AI's answer takes it off again", () => {
    const on: Filter[] = ["pitches"];
    const medium: Signal = { c: "ai_kind", w: 3, f: "pitches" };
    const answer = {
      kind: "sales_pitch" as const,
      certainty: "high" as const,
      customerIntent: false,
      talksToFilter: false,
      topic: "seo",
      quotes: ["reach the first page of Google"],
    };
    expect(
      decide({ type: "message", signals: [medium, ...shared(on)], answer, choices: asideChoices(on) }).verdict,
    ).toBe("aside");
    // The AI found a customer: the match counts no more than what a filter found.
    const customer: Signal = { c: "ai_customer", w: -4, f: "ai" };
    const said = { ...answer, kind: "customer" as const, customerIntent: true, quotes: [] };
    const lowered = decide({
      type: "message",
      signals: [{ c: "link_only", w: 3, f: "basic" }, ...shared(on), customer],
      answer: said,
      choices: asideChoices(on),
    });
    expect(lowered.verdict).toBe("warn");
  });

  it("is lowered by the business's own offer named, and by a filter still learning or set to Just label", () => {
    const on: Filter[] = ["pitches"];
    const own: Signal = { c: "pitch_phrases", w: 3, f: "pitches" };
    expect(decide({ type: "message", signals: [own, ...shared(on)], veto: true }).verdict).toBe("warn");
    const learning = decide({ type: "message", signals: [own, ...shared(on)], learning: new Set(["pitches"]) });
    expect(learning).toMatchObject({ verdict: "warn", learning: true });
    const label = decide({ type: "message", signals: [own, ...shared(on)], choices: new Map([["pitches", "label"]]) });
    expect(label.verdict).toBe("warn");
  });

  it("takes nothing of a negative signal for one of the inbox's own", () => {
    const aligned: Signal = { c: "aligned", w: -1, f: "basic" };
    const big = { c: "shared_spam", w: 9, f: "basic" } as Signal;
    expect(decide({ type: "message", signals: [aligned, big] }).verdict).toBe("warn");
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
