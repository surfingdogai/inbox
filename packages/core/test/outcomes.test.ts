import { inboxOutcomeCodeSchema, outcomeItemType } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import { actorKindSchema, CUSTOMER_ACTORS } from "../src/domain/types";
import { outcomeOf, PROMISE_STATES } from "../src/machine/outcomes";
import { bookingMachine, machines, orderMachine } from "../src/machine/tables";

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
    for (const m of [bookingMachine, orderMachine]) {
      const promise = PROMISE_STATES[m.type as "booking" | "order"];
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
      order: ["received", "needs_info"],
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
    for (const m of Object.values(machines)) {
      for (const { t, from, actor } of paths(m)) {
        const o = outcomeOf(m.type, t.event, from, actor);
        if (!o) continue;
        expect(inboxOutcomeCodeSchema.safeParse(o.code).success).toBe(true);
        expect(outcomeItemType(o.code)).toBe(m.type);
        reached.add(o.code);
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

  it("never records one for quotes, messages or refunds", () => {
    for (const type of ["quote_request", "message", "refund"] as const) {
      for (const { t, from, actor } of paths(machines[type])) {
        expect(outcomeOf(type, t.event, from, actor)).toBeNull();
      }
    }
  });
});
