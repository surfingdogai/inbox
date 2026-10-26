import { stayPolicySteps } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import type { PayloadOf } from "../src/domain/types";
import { datePolicy, feeAt, refundOwed } from "../src/policy/index";
import { transitionItem, type WriteError } from "../src/write/index";
import { clock, contact, guest, mapleHollow, owner, ownerAi } from "./stay-fixtures";

/**
 * A stay's cancellation policy (ADR-037 §5.3): every preset as steps, the fee at each moment, what is
 * owed back of what was paid, and a cancellation the property writes down judged as of when the guest
 * asked, which can only make the fee lower; lower still only by a person.
 */
type StayPayload = PayloadOf<"stay">;
const CAD = (value: number) => ({ value, currency: "CAD" });

describe("stay policies", () => {
  it("turns every preset into steps", () => {
    expect(stayPolicySteps({ preset: "free_until", days: 14, after: "half", noShow: "full" })).toEqual({
      steps: [{ before: { days: 14 }, fee: { kind: "none" } }],
      after: { kind: "percent", value: 50 },
      noShow: { kind: "full" },
    });
    expect(stayPolicySteps({ preset: "non_refundable" })).toEqual({
      steps: [],
      after: { kind: "full" },
      noShow: { kind: "full" },
    });
    const custom = stayPolicySteps({
      preset: "custom",
      steps: [
        { daysBefore: 2, fee: { kind: "percent", value: 50 } },
        { daysBefore: 30, fee: { kind: "none" } },
        { daysBefore: 7, fee: { kind: "units", value: 1 } },
      ],
      after: { kind: "full" },
      noShow: { kind: "full" },
    });
    expect(custom.steps.map((s) => ("days" in s.before ? s.before.days : null))).toEqual([30, 7, 2]);
  });

  it("charges the fee of the step still ahead, at each moment, and owes back the rest", () => {
    const dated = datePolicy(stayPolicySteps({ preset: "free_until", days: 7, after: "first_night", noShow: "full" }), {
      start: { date: "2026-12-04", time: "16:00" },
      zone: "America/Halifax",
      total: CAD(37_800),
      units: [18_900, 18_900],
    });
    expect(dated.steps).toEqual([{ until: "2026-11-27T23:59:59-04:00", fee: CAD(0) }]);
    expect(feeAt(dated, Date.parse("2026-11-27T23:59:59-04:00"))).toEqual(CAD(0));
    expect(feeAt(dated, Date.parse("2026-11-28T00:00:00-04:00"))).toEqual(CAD(18_900));
    expect(refundOwed(CAD(37_800), CAD(18_900))).toEqual(CAD(18_900));
    expect(refundOwed(CAD(10_000), CAD(18_900))).toEqual(CAD(0));
  });

  it("records a guest's cancellation as of when they asked: the fee only goes down, and lower still only by a person", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    const held = await m.caps.stays.hold(guest(), {
      check_in: "2026-11-20",
      check_out: "2026-11-22",
      rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
      contact,
      consent: true,
    });
    const id = held.view.item.id;
    await m.caps.stays.book(guest({ accessToken: held.accessToken as string }), {
      item_id: id,
      terms_sha: held.terms_sha,
    });
    // Past the free week now; the guest phoned inside it.
    clock.now = Date.parse("2026-11-16T15:00:00Z");
    const askedAt = "2026-11-12T14:00:00Z";
    // The owner's AI may write down what the guest said, at the policy's fee as of then, never lower.
    const lower = await transitionItem(m.db, ownerAi, {
      itemId: id,
      event: "record_cancel",
      input: { note: "Called to cancel", askedAt: "2026-11-16T14:00:00Z", fee: CAD(5_000) },
    }).catch((e: WriteError) => e);
    expect((lower as WriteError).code).toBe("not_allowed");
    const higher = await transitionItem(m.db, owner, {
      itemId: id,
      event: "record_cancel",
      input: { note: "Called to cancel", fee: CAD(99_000) },
    }).catch((e: WriteError) => e);
    expect((higher as WriteError).code).toBe("invalid_input");
    const done = await transitionItem(m.db, owner, {
      itemId: id,
      event: "record_cancel",
      input: { note: "Called on the 12th", askedAt },
    });
    expect(done.view.item.state).toBe("cancelled_by_guest");
    expect((done.view.item.payload as StayPayload).cancellation?.fee).toEqual(CAD(0));
  });
});
