import { describe, expect, it } from "vitest";
import { actorKindSchema } from "../src/domain/types";
import { availableTransitions, isTerminal, resolveTransition } from "../src/machine/machine";
import { outcomeOf } from "../src/machine/outcomes";
import { bookingMachine, machines, orderMachine, quoteMachine } from "../src/machine/tables";

describe("state machines as data", () => {
  for (const [type, m] of Object.entries(machines)) {
    describe(type, () => {
      it("is internally consistent", () => {
        expect(m.states).toContain(m.initial);
        for (const s of m.terminal) expect(m.states).toContain(s);
        for (const t of m.transitions) {
          expect(m.states).toContain(t.to);
          for (const f of t.from) expect(m.states).toContain(f);
          expect(t.by.length).toBeGreaterThan(0);
          for (const a of t.by) expect(actorKindSchema.options).toContain(a);
          expect(t.label.length).toBeGreaterThan(0);
        }
      });

      it("has no way out of a terminal state, only records that leave it closed", () => {
        for (const s of m.terminal) {
          // A correction or a charge-back on a closed item (ADR-017 §3.1) amends it and leaves it
          // closed; nothing else leaves a terminal state.
          for (const t of m.transitions.filter((x) => x.from.includes(s))) {
            expect(t.amends, `${t.event} from ${s}`).toBe(true);
            expect(m.terminal).toContain(t.to);
            expect(t.effects ?? []).not.toContain("claim_slot");
          }
          expect(isTerminal(m, s)).toBe(true);
        }
      });

      it("offers an actor each event at most once from a state", () => {
        for (const s of m.states) {
          for (const a of actorKindSchema.options) {
            const events = m.transitions.filter((t) => t.from.includes(s) && t.by.includes(a)).map((t) => t.event);
            expect(new Set(events).size, `${type} ${s} ${a}`).toBe(events.length);
          }
        }
      });

      it("reaches every state from the initial one", () => {
        const seen = new Set([m.initial]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const t of m.transitions) {
            if (t.from.some((f) => seen.has(f)) && !seen.has(t.to)) {
              seen.add(t.to);
              grew = true;
            }
          }
        }
        expect([...seen].sort()).toEqual([...m.states].sort());
      });
    });
  }

  it("names the exact reason a transition is refused", () => {
    expect(resolveTransition(bookingMachine, "requested", "teleport", "owner")).toEqual({
      ok: false,
      error: { code: "unknown_event" },
    });
    expect(resolveTransition(bookingMachine, "confirmed", "confirm", "owner")).toMatchObject({
      ok: false,
      error: { code: "wrong_state" },
    });
    expect(resolveTransition(bookingMachine, "requested", "confirm", "customer_human")).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    });
    const ok = resolveTransition(bookingMachine, "requested", "confirm", "owner");
    expect(ok.ok && ok.transition.to).toBe("confirmed");
  });

  it("gives each of the customer's answers and the owner's records exactly its states and its actors", () => {
    const ok = (m: typeof bookingMachine | typeof orderMachine, state: string, event: string, actor: string) =>
      resolveTransition(m as never, state as never, event, actor as never).ok;
    expect(ok(bookingMachine, "needs_info", "confirm", "owner")).toBe(true);
    // Confirm on a proposed booking books the proposed time, and only a person may (N13).
    const fromProposed = resolveTransition(bookingMachine, "proposed", "confirm", "owner");
    expect(fromProposed.ok && fromProposed.transition.byPerson).toBe(true);
    expect(fromProposed.ok && fromProposed.transition.effects).toContain("apply_proposal");
    const fromRequested = resolveTransition(bookingMachine, "requested", "confirm", "owner");
    expect(fromRequested.ok && fromRequested.transition.byPerson).toBeUndefined();
    for (const s of bookingMachine.states) {
      expect(ok(bookingMachine, s, "counter", "customer_agent"), s).toBe(s === "proposed");
      expect(ok(bookingMachine, s, "record_cancel", "owner"), s).toBe(
        ["requested", "needs_info", "proposed", "confirmed"].includes(s),
      );
    }
    expect(resolveTransition(bookingMachine, "proposed", "counter", "owner")).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    });
    for (const actor of ["rule", "customer_agent", "customer_human", "connector", "system"]) {
      expect(ok(bookingMachine, "confirmed", "record_cancel", actor), actor).toBe(false);
    }
    expect(ok(bookingMachine, "confirmed", "record_cancel", "owner_ai")).toBe(true);
    expect(ok(bookingMachine, "confirmed", "record_cancel_late", "staff")).toBe(true);
    expect(availableTransitions(bookingMachine, "confirmed", "owner").map((t) => t.event)).not.toContain(
      "record_cancel_late",
    );
    for (const s of orderMachine.states) {
      expect(ok(orderMachine, s, "record_cancel", "staff"), s).toBe(
        ["received", "needs_info", "accepted", "awaiting_payment", "payment_failed"].includes(s),
      );
    }
    // A new quote replaces the one before.
    expect(resolveTransition(quoteMachine, "quoted", "quote", "owner").ok).toBe(true);
  });

  it("never makes a recorded customer cancellation the business's broken promise", () => {
    for (const actor of ["owner", "staff", "owner_ai"] as const) {
      expect(outcomeOf("booking", "record_cancel", "confirmed", actor)?.code).toBe("booking.cancelled_by_customer");
      expect(outcomeOf("booking", "record_cancel_late", "confirmed", actor)?.code).toBe(
        "booking.cancelled_late_by_customer",
      );
      expect(outcomeOf("order", "record_cancel", "accepted", actor)?.code).toBe("order.cancelled_by_customer");
      expect(outcomeOf("booking", "record_cancel", "requested", actor)).toBeNull();
      expect(outcomeOf("order", "record_cancel", "received", actor)).toBeNull();
      expect(outcomeOf("booking", "counter", "proposed", "customer_agent")).toBeNull();
    }
  });

  it("lists the owner's primary buttons for a requested booking", () => {
    expect(availableTransitions(bookingMachine, "requested", "owner").map((t) => t.label)).toEqual([
      "Ask for details",
      "Propose another time",
      "Confirm booking",
      "Decline",
      "Cancel booking",
      "Customer cancelled",
    ]);
  });
});
