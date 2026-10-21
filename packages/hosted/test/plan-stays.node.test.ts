import { describe, expect, it } from "vitest";
import { validatePlan } from "../src/plan";

/**
 * A hosted inbox for a place to stay (ADR-033): the control plane takes its plan before it sends
 * anyone a code — the stays rules, the owner confirming each stay, the stay door expected, and stays
 * kept at the property's own booking engine with its deep link — and refuses a deep link on any other door.
 */
describe("a place to stay's setup plan", () => {
  it("is taken", () => {
    expect(
      validatePlan({
        profile: { name: "Pousada Maré Alta", timezone: "America/Bahia", currency: "BRL", languages: ["pt", "en"] },
        preset: "stays",
        booking: { confirm: "owner" },
        doors: ["message", "stay"],
        doors_elsewhere: [
          {
            door: "stay",
            url: "https://engine.example.net/mare-alta",
            url_template: "https://engine.example.net/mare-alta?in={check_in}&out={check_out}&adults={adults}",
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a deep link on a door that is not a stay's", () => {
    const r = validatePlan({
      preset: "stays",
      doors_elsewhere: [
        {
          door: "booking",
          url: "https://engine.example.net/mare-alta",
          url_template: "https://engine.example.net/mare-alta?in={check_in}&out={check_out}&adults={adults}",
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
});
