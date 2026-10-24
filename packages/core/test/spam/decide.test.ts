import { describe, expect, it } from "vitest";
import { answerSignals, decide } from "../../src/spam/decide";
import type { CheckedAnswer, Filter, Signal } from "../../src/spam/types";

/**
 * Deciding (ADR-029 §6): the thresholds, what is certain, every cap and floor, learning, Just label,
 * the type mapping (bookings and orders are never put aside), a known sender only labelled, and an
 * AI answer that puts a message aside only with proof.
 */

const s = (c: string, w: number, f: Signal["f"] = "basic", x?: 1): Signal => ({ c, w, f, ...(x ? { x } : {}) });
const on = (...filters: Filter[]) => new Map(filters.map((f) => [f, "aside" as const]));
const answer = (o: Partial<CheckedAnswer> = {}): CheckedAnswer => ({
  kind: "sales_pitch",
  certainty: "high",
  customerIntent: false,
  talksToFilter: false,
  topic: "seo",
  quotes: ["we can get you on the first page"],
  ...o,
});

describe("the thresholds", () => {
  it("deliver under 3, label from 3, aside band from 6 or with anything certain", () => {
    expect(decide({ type: "message", signals: [s("shortener", 1), s("many_links", 2) /* 3 */] }).verdict).toBe("warn");
    expect(decide({ type: "message", signals: [s("shortener", 1), s("disposable", 1.5)] }).verdict).toBe("deliver");
    expect(decide({ type: "message", signals: [s("too_fast", 4), s("name_link", 3)] }).verdict).toBe("aside");
    const certain = decide({ type: "message", signals: [s("trap", 6, "basic", 1)] });
    expect(certain).toMatchObject({ verdict: "aside", cause: "trap", certain: true, noProof: true });
    expect(decide({ type: "message", signals: [] })).toMatchObject({ verdict: "deliver", cause: null, label: null });
  });

  it("names the strongest cause, and a filter's name for its own points", () => {
    expect(
      decide({ type: "message", signals: [s("pitch_phrases", 3, "pitches"), s("ai_kind", 6, "pitches")] }).cause,
    ).toBe("pitches");
    expect(decide({ type: "message", signals: [s("many_links", 2), s("too_fast", 4)] }).cause).toBe("too_fast");
  });
});

describe("the type mapping", () => {
  const band = [s("too_fast", 4), s("name_link", 3)];
  it("puts a message aside, holds a booking or an order for proof, never puts them aside", () => {
    expect(decide({ type: "message", signals: band }).verdict).toBe("aside");
    expect(decide({ type: "booking", signals: band }).verdict).toBe("hold");
    expect(decide({ type: "order", signals: band }).verdict).toBe("hold");
    expect(decide({ type: "booking", signals: [s("trap", 6, "basic", 1)] }).verdict).toBe("hold");
    expect(decide({ type: "order", signals: [s("wave", 6, "basic", 1)] }).verdict).toBe("hold");
  });

  it("holds a quote request, and puts it aside only for what a bot did", () => {
    expect(decide({ type: "quote_request", signals: band }).verdict).toBe("hold");
    expect(decide({ type: "quote_request", signals: [s("trap", 6, "basic", 1)] }).verdict).toBe("aside");
    // Too many new requests is certain, but a person can prove it: held, never put aside.
    const many = decide({ type: "quote_request", signals: [s("many_new", 6, "basic", 1)] });
    expect(many).toMatchObject({ verdict: "hold", noProof: false });
  });
});

describe("the caps", () => {
  const pitch = [s("pitch_phrases", 3, "pitches"), s("ai_kind", 6, "pitches")];
  it("label at most a sender the business knows, even a certain signal", () => {
    expect(decide({ type: "message", signals: [s("server_marked", 6, "basic", 1)], trusted: true }).verdict).toBe(
      "warn",
    );
    expect(decide({ type: "message", signals: pitch, trusted: true }).verdict).toBe("warn");
  });

  it("label at most what names the business's own offer, for words; never a door's certain signal", () => {
    expect(decide({ type: "message", signals: pitch, veto: true, answer: answer() }).verdict).toBe("warn");
    expect(decide({ type: "message", signals: [s("trap", 6, "basic", 1)], veto: true }).verdict).toBe("aside");
    // What a door saw is not vetoed by words: a bot that typed a service's name is still a bot.
    expect(decide({ type: "message", signals: [s("too_fast", 4), s("key_invalid", 4)], veto: true }).verdict).toBe(
      "aside",
    );
  });

  it("label at most, for words, a request that presented a network pass", () => {
    expect(decide({ type: "message", signals: [...pitch, s("pass", -3)], answer: answer() }).verdict).toBe("warn");
  });

  it("only label what a filter set to Just label is sure of", () => {
    expect(
      decide({ type: "message", signals: pitch, choices: new Map([["pitches", "label"]]), answer: answer() }).verdict,
    ).toBe("warn");
    expect(decide({ type: "message", signals: pitch, choices: on("pitches"), answer: answer() }).verdict).toBe("aside");
  });

  it("turn what a learning filter would put aside into 'Would have been put aside'", () => {
    const d = decide({
      type: "message",
      signals: pitch,
      choices: on("pitches"),
      learning: new Set(["pitches"]),
      answer: answer(),
    });
    expect(d).toMatchObject({ verdict: "warn", learning: true, label: "learning" });
    // The free protection learns too, for its point-based part only.
    const basic = decide({
      type: "message",
      signals: [s("too_fast", 4), s("name_link", 3)],
      learning: new Set(["basic"]),
    });
    expect(basic).toMatchObject({ verdict: "warn", learning: true });
    expect(decide({ type: "message", signals: [s("trap", 6, "basic", 1)], learning: new Set(["basic"]) }).verdict).toBe(
      "aside",
    );
  });

  it("put a message aside on the AI's answer alone only when it is sure, quotes it, and nothing asks for the offer", () => {
    const ai = [s("ai_kind", 6, "pitches")];
    expect(decide({ type: "message", signals: ai, answer: answer() }).verdict).toBe("aside");
    expect(decide({ type: "message", signals: ai, answer: answer({ quotes: [] }) }).verdict).toBe("warn");
    expect(decide({ type: "message", signals: ai, answer: answer({ certainty: "medium" }) }).verdict).toBe("warn");
    expect(decide({ type: "message", signals: ai, answer: answer({ customerIntent: true }) }).verdict).toBe("warn");
    // A booking whose note sells SEO: held for proof, never put aside.
    expect(decide({ type: "booking", signals: ai, answer: answer() }).verdict).toBe("hold");
  });

  it("label at most what the owner was already told of", () => {
    expect(decide({ type: "message", signals: [s("trap", 6, "basic", 1)], alerted: true }).verdict).toBe("warn");
  });

  it("never deliver words aimed at an assistant without a label", () => {
    expect(decide({ type: "message", signals: [s("talks_to_filter", 3), s("ai_customer", -4, "ai")] }).verdict).toBe(
      "warn",
    );
    expect(decide({ type: "message", signals: [s("ai_talks_to_filter", 3, "ai"), s("pass", -3)] }).verdict).toBe(
      "warn",
    );
  });
});

describe("the AI's answer as points", () => {
  const all = new Set<Filter>(["pitches", "scams", "junk"]);
  it("counts a kind only while its filter is on, and lifts for a customer", () => {
    expect(answerSignals(answer(), all)).toEqual([{ c: "ai_kind", w: 6, f: "pitches" }]);
    expect(answerSignals(answer({ certainty: "medium" }), all)[0]?.w).toBe(3);
    expect(answerSignals(answer({ certainty: "low" }), all)[0]?.w).toBe(1);
    expect(answerSignals(answer(), new Set(["scams"]))).toEqual([]);
    expect(answerSignals(answer({ kind: "customer", certainty: "high" }), all)).toEqual([
      { c: "ai_customer", w: -4, f: "ai" },
    ]);
    expect(answerSignals(answer({ kind: "customer", certainty: "medium" }), all)).toEqual([
      { c: "ai_customer", w: -2, f: "ai" },
    ]);
    expect(answerSignals(answer({ kind: "unclear" }), all)).toEqual([]);
    expect(answerSignals(answer({ kind: "unclear", talksToFilter: true }), all)).toEqual([
      { c: "ai_talks_to_filter", w: 3, f: "ai" },
    ]);
  });
});
