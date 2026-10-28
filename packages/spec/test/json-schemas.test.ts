import { describe, expect, it } from "vitest";
import { getBusinessOutputSchema, JSON_SCHEMAS, jsonSchemaOf, outcomeSince } from "../src/index";

/** Every subschema of a JSON Schema document, the document first. */
function* nodes(v: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(v)) for (const x of v) yield* nodes(x);
  else if (v && typeof v === "object") {
    yield v as Record<string, unknown>;
    for (const x of Object.values(v)) yield* nodes(x);
  }
}

describe("the published JSON Schemas", () => {
  it("close every tuple by its bounds, never by items: false, which a draft-07 checker reads as no items", () => {
    let tuples = 0;
    for (const name of Object.keys(JSON_SCHEMAS)) {
      for (const n of nodes(jsonSchemaOf(name))) {
        if (!Array.isArray(n.prefixItems)) continue;
        tuples++;
        expect(n.items, name).toBeUndefined();
        expect(n.maxItems, name).toBe(n.prefixItems.length);
      }
    }
    // The opening hours alone are tuples, in more than one schema.
    expect(tuples).toBeGreaterThan(7);
  });

  it("list every outcome a network counts on a business's listing, promise.closed_late among them", () => {
    const outcomes = (jsonSchemaOf("mcp-get-business-output") as { properties: Record<string, unknown> }).properties
      .outcomes as { propertyNames: { enum: string[] } };
    expect(outcomes.propertyNames.enum).toContain("promise.closed_late");
    expect(outcomeSince("promise.closed_late")).toBe(9);
    // A listing on rules version 9 counts it, and reads as valid.
    expect(
      getBusinessOutputSchema.shape.outcomes.safeParse({ "promise.unclosed": 0, "promise.closed_late": 1 }).success,
    ).toBe(true);
  });
});
