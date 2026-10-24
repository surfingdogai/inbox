import { describe, expect, it } from "vitest";
import {
  blockLines,
  DEPOSIT_PRESETS,
  datedSteps,
  depositKey,
  depositPaid,
  ownLengths,
  POLICY_PRESETS,
  policyKey,
  policyWords,
  shownName,
  withWhom,
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

  it("say a deposit the policy keeps beside every fee after the free time, since the more is charged", () => {
    expect(
      policyWords({
        steps: [
          { before: { hours: 48 }, fee: { kind: "none" } },
          { before: { hours: 24 }, fee: { kind: "percent", value: 20 } },
        ],
        after: { kind: "full" },
        noShow: { kind: "full" },
        deposit: { refundable: false },
      }),
    ).toBe(
      "free until 48 h before · 20% (or the deposit, if more) until 24 h before · then full price · no-show: full price",
    );
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

  it("says the deposit beside a smaller fee after the free time, and leaves it off a larger one", () => {
    const steps = {
      ...dated,
      steps: [...dated.steps, { until: "2026-11-04T12:00:00-06:00", fee: { value: 20_000, currency: "MXN" } }],
      after: { value: 80_000, currency: "MXN" },
    };
    expect(datedSteps(steps, money, when, { depositKept: true, deposit: { value: 40_000, currency: "MXN" } })).toEqual([
      "Free until 2026-11-03 12:00",
      "MXN 200.00 (or the deposit, if more) until 2026-11-04 12:00",
      "then MXN 800.00",
      "no-show MXN 800.00",
    ]);
  });

  it("says it as kept for a booking made after the free time", () => {
    expect(datedSteps({ ...dated, steps: [] }, money, when, { depositKept: true })[0]).toBe(
      "Cancelling keeps the deposit",
    );
  });
});

describe("the name customers see", () => {
  it("is the one the owner chose, whole, else the first word of the name", () => {
    expect(shownName("Nguyễn Thu Hà", "Thu Hà")).toBe("Thu Hà");
    expect(shownName("María José Ruiz", " María José ")).toBe("María José");
    expect(shownName("Mei Chen")).toBe("Mei");
    expect(shownName("Mei Chen", " ")).toBe("Mei");
  });
});

describe("a booking on the day by staff", () => {
  const b = { clock: "15:00", service: "Men's cut", customer: "Lena Fischer" };
  it("says what fits its height, never a line cut through", () => {
    // Half an hour (20 px): the start and the service, no customer under them.
    expect(blockLines({ ...b, height: 20, narrow: false })).toEqual([
      { id: "what", clock: "15:00", text: "Men's cut" },
    ]);
    // Three quarters (31 px): still one line.
    expect(blockLines({ ...b, height: 31, narrow: false }).map((l) => l.id)).toEqual(["what"]);
    // An hour (42 px): the customer too.
    expect(blockLines({ ...b, height: 42, narrow: false }).map((l) => l.id)).toEqual(["what", "who"]);
  });

  it("names the service first beside another booking, the start under it when there is room", () => {
    expect(blockLines({ ...b, height: 20, narrow: true })).toEqual([{ id: "what", text: "Men's cut" }]);
    expect(blockLines({ ...b, height: 64, narrow: true }).map((l) => l.id)).toEqual(["what", "when", "who"]);
  });

  it("gives a long booking's service the room it has, so its name reads whole", () => {
    // Five and a half hours (240 px of block): the service wraps onto every line the customer leaves.
    const long = blockLines({ ...b, service: "Knotless braids, waist length", height: 240, narrow: false });
    expect(long.map((l) => l.id)).toEqual(["what", "who"]);
    expect(long[0]?.rows).toBe(Math.floor((240 - 8) / 14.5) - 1);
    // Exactly as tall as its lines: none to spare, one line each.
    expect(blockLines({ ...b, height: 42, narrow: false }).every((l) => l.rows === undefined)).toBe(true);
  });
});

describe("someone's own length for a service", () => {
  it("offers, in one press, the lengths around the usual one", () => {
    expect(ownLengths(300).map((l) => l.label)).toEqual(["Usual (5 h)", "4 h 30", "5 h 30", "6 h"]);
    expect(ownLengths(300).map((l) => l.value)).toEqual([null, 270, 330, 360]);
    // Never nothing: half an hour less of half an hour is left out.
    expect(ownLengths(30).map((l) => l.value)).toEqual([null, 60, 90]);
  });
});

describe("a booking's deposit, as the owner reads it", () => {
  it("is paid by a payment recorded with no amount, and no more than it, as the inbox reads it", () => {
    const deposit = { amount: { value: 1_000_000, currency: "NGN" } };
    // Nothing paid yet: all of it is still to pay, and the payment form starts from it.
    expect(depositPaid({ deposit })).toEqual({ paid: 0, left: { value: 1_000_000, currency: "NGN" } });
    // Taken at the desk with no amount said: the inbox recorded it as the deposit.
    expect(depositPaid({ deposit, paymentRef: "cash", paidAmount: { value: 1_000_000, currency: "NGN" } })).toEqual({
      paid: 1_000_000,
      left: { value: 0, currency: "NGN" },
    });
    // Part of it paid; then the rest of the price, with no amount, which covers it.
    expect(depositPaid({ deposit, paymentRef: "pi_1", paidAmount: { value: 400_000, currency: "NGN" } })?.left).toEqual(
      { value: 600_000, currency: "NGN" },
    );
    expect(depositPaid({ deposit, paymentRef: "cash-rest" })?.left.value).toBe(0);
    expect(depositPaid({ paymentRef: "cash" })).toBeNull();
  });
});

describe("who a booking is with, as the owner reads it", () => {
  it("is whoever a time we proposed goes with while the customer answers, said as proposed", () => {
    const asked = { resourceId: "minjun", staffName: "Minjun" };
    const proposed = { ...asked, proposed: { resourceId: "dohyun", staffName: "Dohyun" } };
    expect(withWhom("proposed", proposed)).toEqual({ resourceId: "dohyun", staffName: "Dohyun", proposed: true });
    // Accepted, the booking is with them, and nothing is said as proposed.
    expect(withWhom("confirmed", { resourceId: "dohyun", staffName: "Dohyun" })).toEqual({
      resourceId: "dohyun",
      staffName: "Dohyun",
      proposed: false,
    });
    // A time that stays with the person it is with, or one proposed for a booking with nobody yet.
    expect(withWhom("proposed", { ...asked, proposed: {} })).toEqual({ ...asked, proposed: false });
    expect(withWhom("requested", proposed)).toEqual({ ...asked, proposed: false });
    expect(withWhom("proposed", { proposed: { resourceId: "dohyun", staffName: "Dohyun" } })).toEqual({
      resourceId: "dohyun",
      staffName: "Dohyun",
      proposed: true,
    });
  });
});
