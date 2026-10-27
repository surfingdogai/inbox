import { describe, expect, it } from "vitest";
import { decide } from "../../src/spam/decide";
import type { Signal, Verdict } from "../../src/spam/types";
import { agent, spamSetup, T0 } from "./harness";

/**
 * Trust only lifts (ADR-029 §1.3, R25): what speaks for a sender — a network pass, a vouched platform,
 * authenticated mail, a message the owner kept — only ever lowers the score and softens the verdict.
 * Nothing about a person's standing anywhere adds a point, and a request with no identity at all is
 * never worse off than the anonymous baseline.
 */

const RANK: Record<Verdict, number> = { deliver: 0, warn: 1, hold: 2, aside: 3 };
const LIFTS: readonly Signal[] = [
  { c: "pass", w: -3, f: "basic" },
  { c: "vouched", w: -1, f: "basic" },
  { c: "aligned", w: -1, f: "basic" },
  { c: "like_kept", w: -3, f: "basic" },
  { c: "ai_customer", w: -4, f: "ai" },
];
const CAUSES: readonly Signal[] = [
  { c: "too_fast", w: 4, f: "basic" },
  { c: "name_link", w: 3, f: "basic" },
  { c: "many_links", w: 2, f: "basic" },
  { c: "shortener", w: 1, f: "basic" },
  { c: "pitch_phrases", w: 2, f: "pitches" },
  { c: "scam_phrases", w: 3, f: "scams" },
  { c: "ai_kind", w: 6, f: "pitches" },
  { c: "same_link_domain", w: 3, f: "basic" },
  { c: "trap", w: 6, f: "basic", x: 1 },
  { c: "talks_to_filter", w: 3, f: "basic" },
];

/** A small deterministic generator, so a failure names the case that broke. */
function* cases(n: number): Generator<Signal[]> {
  let seed = 7;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  for (let i = 0; i < n; i++) {
    const out: Signal[] = [];
    for (const c of CAUSES) if (next() < 0.3) out.push(c);
    yield out;
  }
}

describe("trust only lifts", () => {
  it("adding any lift never raises the score nor worsens the verdict, for every type", () => {
    for (const type of ["message", "quote_request", "booking", "order"] as const) {
      for (const base of cases(400)) {
        const before = decide({ type, signals: base });
        for (const lift of LIFTS) {
          const after = decide({ type, signals: [...base, lift] });
          expect(after.score, `${type} ${base.map((s) => s.c)} + ${lift.c}`).toBeLessThanOrEqual(before.score);
          expect(RANK[after.verdict], `${type} ${base.map((s) => s.c)} + ${lift.c}`).toBeLessThanOrEqual(
            RANK[before.verdict],
          );
        }
      }
    }
  });

  it("a request with no identity at all is never worse off than the same request from a stranger with one", async () => {
    const s = await spamSetup();
    const body = "Hello, could you tell me if the latte art class has space on Thursday morning for one?";
    await s.caps.sendMessage(agent(T0), { body, contact: { name: "No one", email: "noone@example.org" } });
    await s.caps.sendMessage(agent(T0 + 1_000, { key: "keyedAgent00000000000000000000000000000000000" }), {
      body: `${body} Thanks.`,
      contact: { name: "Someone", email: "someone@example.net" },
    });
    const scores = (await s.q("SELECT score, verdict FROM spam_verdicts ORDER BY created_at")).map((r) => [
      Number(r[0]),
      r[1],
    ]);
    expect(scores[1]?.[0]).toBeLessThanOrEqual(scores[0]?.[0] as number);
    expect(scores.map((r) => r[1])).toEqual(["deliver", "deliver"]);
  });
});
