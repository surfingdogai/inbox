import { describe, expect, it } from "vitest";
import { actorKindSchema } from "../src/domain/types";
import { availableTransitions, isTerminal, resolveTransition } from "../src/machine/machine";
import { bookingMachine, machines } from "../src/machine/tables";

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

  it("lists the owner's primary buttons for a requested booking", () => {
    expect(availableTransitions(bookingMachine, "requested", "owner").map((t) => t.label)).toEqual([
      "Ask for details",
      "Propose another time",
      "Confirm booking",
      "Decline",
      "Cancel booking",
    ]);
  });
});
