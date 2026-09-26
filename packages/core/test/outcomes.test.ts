import { inboxOutcomeCodeSchema, OUTCOMES, outcomeItemType } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { actorKindSchema, CUSTOMER_ACTORS } from "../src/domain/types";
import { outcomeOf, PROMISE_STATES } from "../src/machine/outcomes";
import { bookingMachine, machines, orderMachine, refundMachine } from "../src/machine/tables";

/**
 * The outcome a transition records (ADR-017 §3.1) is one pure function of the item type, the
 * event, the state it leaves and the actor; `receipts-v2.json` pins every path against the ADR's
 * table (network-vectors.test.ts). These are the rules the table follows, checked over every path.
 */
const paths = (m: (typeof machines)[keyof typeof machines]) =>
  m.transitions.flatMap((t) => t.from.flatMap((from) => t.by.map((actor) => ({ t, from, actor }))));

describe("outcomes over every path", () => {
  it("queue an outcome receipt exactly where the function names one", () => {
    for (const m of Object.values(machines)) {
      for (const { t, from, actor } of paths(m)) {
        const outcome = outcomeOf(m.type, t.event, from, actor);
        expect(!!outcome, `${m.type} ${t.event} from ${from} by ${actor}`).toBe(
          (t.effects ?? []).includes("issue_receipt:outcome"),
        );
      }
    }
  });

  it("close every promise that is left: each way out of the promise states records one", () => {
    for (const m of [bookingMachine, orderMachine, refundMachine]) {
      const promise = PROMISE_STATES[m.type as "booking" | "order" | "refund"];
      for (const { t, from, actor } of paths(m)) {
        if (promise.includes(from) && !promise.includes(t.to)) {
          expect(
            outcomeOf(m.type, t.event, from, actor),
            `${m.type} ${t.event} from ${from} by ${actor}`,
          ).not.toBeNull();
        }
      }
    }
  });

  it("record nothing before a promise is made", () => {
    const before: Record<string, readonly string[]> = {
      booking: ["requested", "needs_info", "proposed"],
      order: ["received", "needs_info", "proposed"],
    };
    for (const m of [bookingMachine, orderMachine]) {
      for (const { t, from, actor } of paths(m)) {
        if (before[m.type]?.includes(from)) {
          expect(outcomeOf(m.type, t.event, from, actor), `${m.type} ${t.event} from ${from}`).toBeNull();
        }
      }
    }
  });

  it("name only inbox outcomes of the item's own type, and reach every one", () => {
    const reached = new Set<string>();
    // A refund paid after its date is the one outcome that depends on when (ADR-017 Amendment 3).
    const late = { due: Date.parse("2026-10-01T00:00:00Z"), now: Date.parse("2026-10-02T00:00:00Z") };
    for (const m of Object.values(machines)) {
      for (const { t, from, actor } of paths(m)) {
        for (const ctx of [{}, late]) {
          const o = outcomeOf(m.type, t.event, from, actor, ctx);
          if (!o) continue;
          expect(inboxOutcomeCodeSchema.safeParse(o.code).success).toBe(true);
          expect(outcomeItemType(o.code)).toBe(m.type);
          reached.add(o.code);
        }
      }
    }
    expect([...reached].sort()).toEqual([...inboxOutcomeCodeSchema.options].sort());
  });

  it("mark aut exactly when nobody decided it: the system or a rule", () => {
    for (const m of Object.values(machines)) {
      for (const { t, from, actor } of paths(m)) {
        const o = outcomeOf(m.type, t.event, from, actor);
        if (o) expect(o.aut === 1, `${t.event} by ${actor}`).toBe(actor === "system" || actor === "rule");
      }
    }
  });

  it("tell the customer's cancel from the business's once an order is accepted", () => {
    for (const actor of actorKindSchema.options) {
      const o = outcomeOf("order", "cancel", "accepted", actor);
      expect(o?.code).toBe(CUSTOMER_ACTORS.includes(actor) ? "order.cancelled_by_customer" : "order.not_fulfilled");
      expect(outcomeOf("order", "cancel", "received", actor)).toBeNull();
    }
    // A booking cancelled before it was confirmed promised nothing, whoever cancels it.
    expect(outcomeOf("booking", "cancel", "requested", "customer_human")).toBeNull();
    expect(outcomeOf("booking", "cancel_by_business", "proposed", "owner")).toBeNull();
    expect(outcomeOf("booking", "cancel_by_business", "confirmed", "owner")).toEqual({
      code: "booking.cancelled_by_business",
    });
  });

  it("never records one for quotes or messages", () => {
    for (const type of ["quote_request", "message"] as const) {
      for (const { t, from, actor } of paths(machines[type])) {
        expect(outcomeOf(type, t.event, from, actor)).toBeNull();
      }
    }
  });
});

/**
 * Refunds (ADR-017 Amendment 3, ADR-018 §8): the business's promise to repay by a date, kept when it
 * is paid by then and broken after; the customer dropping the return closes it neutrally. Nothing
 * here is ever a row on the customer's side.
 */
describe("a refund's outcomes", () => {
  const DAY = 86_400_000;
  const due = Date.parse("2026-10-15T10:00:00Z");

  it("paid by its date is kept, to the second; after it, broken", () => {
    for (const from of ["approved", "goods_received"]) {
      for (const actor of ["owner", "staff", "connector"] as const) {
        expect(outcomeOf("refund", "refund", from, actor, { due, now: due - DAY })).toEqual({
          code: "refund.honoured",
        });
        // The receipts carry whole seconds: a payment in the second it was due is on time.
        expect(outcomeOf("refund", "refund", from, actor, { due, now: due + 999 })).toEqual({
          code: "refund.honoured",
        });
        expect(outcomeOf("refund", "refund", from, actor, { due, now: due + 1000 })).toEqual({ code: "refund.late" });
        expect(outcomeOf("refund", "refund", from, actor, { due, now: due + 30 * DAY })).toEqual({
          code: "refund.late",
        });
      }
    }
  });

  it("paid before any date was fixed is kept at once", () => {
    expect(outcomeOf("refund", "refund", "approved", "owner", { due: null, now: due })).toEqual({
      code: "refund.honoured",
    });
  });

  it("dropped after its date was fixed closes neutrally; dropped before, nothing was promised", () => {
    for (const [event, actor] of [
      ["cancel", "customer_agent"],
      ["cancel", "customer_human"],
      ["record_cancel", "owner"],
      ["record_cancel", "staff"],
    ] as const) {
      expect(outcomeOf("refund", event, "approved", actor, { due, now: due - DAY })).toEqual({
        code: "refund.cancelled_by_customer",
      });
      expect(outcomeOf("refund", event, "approved", actor, { due: null, now: due })).toBeNull();
      expect(outcomeOf("refund", event, "requested", actor, { due, now: due })).toBeNull();
    }
  });

  it("records nothing for approving, refusing, the goods, or a dispute", () => {
    for (const event of ["approve", "reject", "goods_back", "dispute_goods"]) {
      for (const from of refundMachine.states) {
        expect(outcomeOf("refund", event, from, "owner", { due, now: due })).toBeNull();
      }
    }
  });

  it("no outcome version 6 adds is a row on the customer's side", () => {
    for (const o of OUTCOMES) {
      if ("since" in o) expect(o.customer, o.code).toBeNull();
    }
  });
});
