import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hasAliasedFields, lenientInput, withAliasesFor } from "../src/capabilities/aliases";
import { checkAvailabilityInput, createBookingInput, getItemStatusInput } from "../src/capabilities/types";

/**
 * service_id and access_token under either spelling (the doors' `lenientInput`): renamed to the one an
 * input has, at every level it describes, and never over what the input already names. Node and workerd.
 */
describe("either spelling", () => {
  it("takes serviceId and accessToken where an input has service_id and access_token", () => {
    expect(checkAvailabilityInput.safeParse({ serviceId: "s1", from: "x", to: "y" }).success).toBe(false);
    const times = lenientInput(checkAvailabilityInput).parse({
      serviceId: "s1",
      from: "2026-11-02T00:00:00Z",
      to: "2026-11-03T00:00:00Z",
    });
    expect(times.service_id).toBe("s1");
    const token = "t".repeat(32);
    expect(lenientInput(getItemStatusInput).parse({ item_id: "i1", accessToken: token }).access_token).toBe(token);
  });

  it("takes service_id inside a payload that spells it serviceId, and accessToken inside visit_for", () => {
    const token = "t".repeat(32);
    const booking = lenientInput(createBookingInput).parse({
      payload: { reservationFor: { service_id: "s1" }, startTime: "2026-11-02T09:00:00Z" },
      visit_for: { item_id: "q1", accessToken: token },
    });
    expect(booking.payload.reservationFor.serviceId).toBe("s1");
    expect(booking.visit_for?.access_token).toBe(token);
  });

  it("never renames over what the input already names, nor where it has both spellings", () => {
    const shape = z.object({ service_id: z.string() });
    expect(withAliasesFor(shape, { service_id: "a", serviceId: "b" })).toEqual({ service_id: "a", serviceId: "b" });
    const both = z.object({ service_id: z.string(), serviceId: z.string() });
    const sent = { serviceId: "b" };
    expect(withAliasesFor(both, sent)).toBe(sent);
    expect(withAliasesFor(shape, "not an object")).toBe("not an object");
  });

  it("leaves a value untouched when there is nothing to rename", () => {
    const sent = { service_id: "a", from: "x" };
    expect(withAliasesFor(checkAvailabilityInput, sent)).toBe(sent);
  });

  it("knows which inputs have such a field, at any depth", () => {
    expect(hasAliasedFields(checkAvailabilityInput)).toBe(true);
    expect(hasAliasedFields(createBookingInput)).toBe(true);
    expect(hasAliasedFields(z.object({ q: z.string().optional() }))).toBe(false);
    expect(hasAliasedFields(z.string())).toBe(false);
  });

  it("describes itself as the input it wraps", () => {
    expect(z.toJSONSchema(lenientInput(checkAvailabilityInput), { io: "input" })).toEqual(
      z.toJSONSchema(checkAvailabilityInput, { io: "input" }),
    );
  });
});
