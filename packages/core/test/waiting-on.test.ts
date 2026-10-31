import { describe, expect, it } from "vitest";
import { waitingOn } from "../src/customer/describe";
import type { Item } from "../src/domain/types";

/**
 * Who an item waits on, as the customer's status says it (ADR-043 §3): a confirmed booking said
 * "waiting_on: us" while nothing was pending. Now only who must act is named, and nobody when nothing
 * is pending. Runs on Node and in workerd.
 */
const item = (
  type: Item["type"],
  state: string,
  payload: Record<string, unknown> = {},
  closedAt: string | null = null,
) =>
  ({
    id: "01J0000000000000000000000",
    type,
    state,
    version: 1,
    partyId: null,
    locationId: null,
    channel: "rest",
    subject: null,
    flags: { needsHuman: false, sandbox: false, priority: 0 },
    linkedItemId: null,
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
    closedAt,
    payload,
  }) as unknown as Item;

const booking = { reservationFor: { serviceId: "s", name: "Full service" }, startTime: "", endTime: "" };

describe("waiting_on", () => {
  it("names nobody on a confirmed booking with nothing pending, and the side that must act otherwise", () => {
    expect(waitingOn(item("booking", "confirmed", booking))).toBeNull();
    expect(waitingOn(item("booking", "requested", booking))).toBe("us");
    expect(waitingOn(item("booking", "proposed", booking))).toBe("you");
    expect(waitingOn(item("booking", "needs_info", booking))).toBe("you");
  });

  it("names whoever did not ask for a change to what was agreed", () => {
    expect(waitingOn(item("booking", "confirmed", { ...booking, change: { by: "customer" } }))).toBe("us");
    expect(waitingOn(item("booking", "confirmed", { ...booking, change: { by: "business" } }))).toBe("you");
    expect(waitingOn(item("order", "accepted", { change: { by: "customer" } }))).toBe("us");
  });

  it("names us while the business still has to do something, and nobody once it is done", () => {
    expect(waitingOn(item("order", "received"))).toBe("us");
    expect(waitingOn(item("order", "accepted"))).toBe("us");
    expect(waitingOn(item("order", "paid"))).toBe("us");
    expect(waitingOn(item("order", "awaiting_payment"))).toBe("you");
    expect(waitingOn(item("order", "fulfilled"))).toBeNull();
    expect(waitingOn(item("message", "open"))).toBe("us");
    expect(waitingOn(item("message", "answered"))).toBeNull();
    expect(waitingOn(item("quote_request", "quoted"))).toBe("you");
    expect(waitingOn(item("stay", "confirmed"))).toBeNull();
    expect(waitingOn(item("stay", "checked_in"))).toBeNull();
  });

  it("names nobody once it is closed", () => {
    expect(waitingOn(item("booking", "completed", booking, "2026-10-31T10:00:00.000Z"))).toBeNull();
    expect(waitingOn(item("message", "spam"))).toBeNull();
  });
});
