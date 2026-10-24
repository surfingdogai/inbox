import { describe, expect, it } from "vitest";
import {
  DEPOSIT_PRESETS,
  datedSteps,
  depositKey,
  POLICY_PRESETS,
  policyKey,
  policyWords,
} from "../client/src/lib/staff";

/**
 * A service's terms in the owner app (ADR-035): the chips a deposit and a policy start from, and the
 * few words the service line says them in. What the owner set is never quietly changed by a chip.
 */
describe("a service's terms", () => {
  it("keep a deposit no chip holds as it was set", () => {
    expect(depositKey({ kind: "percent", value: 30 })).toBe("custom");
    expect(depositKey({ kind: "percent", value: 20 })).toBe("p20");
    expect(depositKey({ kind: "amount", value: 20_000 })).toBe("fixed");
    expect(DEPOSIT_PRESETS.find((p) => p.key === "custom")).toBeUndefined();
  });

  it("say every fee a policy holds, with its unit and before", () => {
    expect(
      policyWords({
        steps: [
          { before: { hours: 48 }, fee: { kind: "none" } },
          { before: { hours: 12 }, fee: { kind: "percent", value: 50 } },
        ],
        after: { kind: "full" },
        noShow: { kind: "full" },
      }),
    ).toBe("free until 48 h before · 50% until 12 h before · then full price · no-show: full price");
  });

  it("say a deposit the policy keeps as kept, never as free", () => {
    const keep = POLICY_PRESETS.find((p) => p.key === "keep")?.policy;
    expect(policyWords(keep)).toBe("free until 24 h before · then the deposit is kept · no-show: full price");
    expect(policyWords(keep)).not.toContain("then free");
  });

  it("name their fees in their labels, for any business", () => {
    expect(POLICY_PRESETS.map((p) => p.label)).toEqual([
      "Your usual policy",
      "Free until 24 h, then 50%",
      "Free until 48 h, then 50%",
      "Deposit kept under 24 h",
    ]);
    expect(policyKey(POLICY_PRESETS[1]?.policy)).toBe("free24");
  });
});

/** A booking's policy on its detail, dated: what the owner reads beside its deposit. */
describe("a booking's dated policy", () => {
  const money = (m: { value: number; currency: string }) => `${m.currency} ${(m.value / 100).toFixed(2)}`;
  const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
  const dated = {
    steps: [{ until: "2026-11-03T12:00:00-06:00", fee: { value: 0, currency: "MXN" } }],
    after: { value: 0, currency: "MXN" },
    noShow: { value: 80_000, currency: "MXN" },
    zone: "America/Mexico_City",
  };

  it("says a deposit the policy keeps as kept after the free time, never as free", () => {
    expect(datedSteps(dated, money, when, { depositKept: true })).toEqual([
      "Free until 2026-11-03 12:00",
      "then the deposit is kept",
      "no-show MXN 800.00",
    ]);
    expect(datedSteps(dated, money, when)).toContain("then free");
  });

  it("says it as kept for a booking made after the free time", () => {
    expect(datedSteps({ ...dated, steps: [] }, money, when, { depositKept: true })[0]).toBe(
      "Cancelling keeps the deposit",
    );
  });
});
