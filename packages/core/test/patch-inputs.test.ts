import { describe, expect, it } from "vitest";
import { patchOf, serviceInput, updateProductInput, updateRuleInput, updateServiceInput } from "../src";

/**
 * A change to something that exists changes only what was sent. Zod's `.partial()` keeps the create's
 * defaults, so a change to a service's description alone came back with its duration, slots and order
 * reset; every update is built with `patchOf`, which leaves them out.
 */
describe("updates carry no defaults", () => {
  it("a service's description alone changes nothing else", () => {
    expect(updateServiceInput.parse({ service_id: "s", description: "New words" })).toEqual({
      service_id: "s",
      description: "New words",
    });
  });

  it("a product's stock alone does not publish it again, and a rule's name alone does not switch it on", () => {
    expect(updateProductInput.parse({ product_id: "p", stock: 3 })).toEqual({ product_id: "p", stock: 3 });
    expect(updateRuleInput.parse({ rule_id: "r", name: "Renamed" })).toEqual({ rule_id: "r", name: "Renamed" });
  });

  it("still checks what is sent, and keeps each field's description for assistants", () => {
    expect(updateServiceInput.safeParse({ service_id: "s", duration_min: 2 }).success).toBe(false);
    const capacity = patchOf(serviceInput).shape.capacity;
    expect(capacity.description ?? capacity.unwrap().description).toBe("How many bookings can share one slot.");
  });

  it("a new service still gets the defaults", () => {
    expect(serviceInput.parse({ name: "Wash" })).toMatchObject({ duration_min: 60, granularity_min: 15, active: true });
  });
});
