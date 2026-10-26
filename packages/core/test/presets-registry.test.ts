import { describe, expect, it } from "vitest";
import { applyPresetInput, setupPlanSchema } from "../src/capabilities/index";
import { evaluate, NO_AGENT_CONTEXT, NO_CUSTOMER, NO_PERSON, type RuleContext } from "../src/rules/evaluate";
import {
  PRESET_KEYS,
  PRESET_NAMES,
  PRESET_REGISTRY,
  PRESETS,
  presetFor,
  presetKeySchema,
} from "../src/rules/presets/index";

/**
 * The presets are a registry (ADR-036): one file per kind of business, one line each in
 * `rules/presets/index.ts`, and every door that takes a preset key reads it from there.
 */
describe("the preset registry", () => {
  it("names every kind once, in order, with its rules", () => {
    expect(PRESET_KEYS).toEqual(PRESET_REGISTRY.map((p) => p.key));
    expect(new Set(PRESET_KEYS).size).toBe(PRESET_KEYS.length);
    for (const p of PRESET_REGISTRY) {
      expect(PRESET_NAMES[p.key]).toBe(p.name);
      expect(PRESETS[p.key]).toEqual([...p.rules]);
      expect(p.rules.length).toBeGreaterThan(0);
    }
    expect(PRESET_KEYS.slice(0, 3)).toEqual(["appointments", "trades", "shop"]);
  });

  it("is what every door takes: the key schema, applying a preset, a setup plan", () => {
    expect(presetKeySchema.options).toEqual(PRESET_KEYS);
    for (const key of PRESET_KEYS) {
      expect(applyPresetInput.safeParse({ preset: key }).success, key).toBe(true);
      expect(setupPlanSchema.safeParse({ preset: key }).success, key).toBe(true);
    }
    expect(applyPresetInput.safeParse({ preset: "spaceport" }).success).toBe(false);
  });

  it("speaks the business's language, and leaves out what says yes on its own when the owner confirms", () => {
    for (const key of PRESET_KEYS) {
      const owner = presetFor(key, "en", "owner");
      expect(
        owner.some((r) => r.definition.actions.some((a) => a.action === "transition" && a.event === "confirm")),
      ).toBe(false);
    }
    expect(JSON.stringify(presetFor("appointments", "pt"))).toContain("Talvez já o conheçamos");
  });
});

describe("a trade's presets", () => {
  /** The priority an item ends at, the rules run as the engine runs them: highest priority first. */
  const endsAt = (key: "trades" | "projects", ctx: RuleContext) => {
    let priority = 0;
    const order = [...(PRESETS[key] ?? [])].sort((a, b) => b.priority - a.priority);
    for (const rule of order) {
      if (!rule.definition.on.includes("item.created")) continue;
      if (rule.definition.if && !evaluate(rule.definition.if, ctx)) continue;
      for (const a of rule.definition.actions) {
        if (a.action === "set_flags" && a.priority !== undefined) priority = a.priority;
      }
    }
    return priority;
  };
  const request = (urgency: string, known: boolean): RuleContext => ({
    item: { type: "quote_request", payload: { job: { urgency } }, flags: {} },
    event: { event: "item.created", from: null, to: "received", actorKind: "customer_agent", depth: 0 },
    party: { kind: "person", tier: "anonymous" },
    person: NO_PERSON,
    customer: known ? { ...NO_CUSTOMER, match: "strong", known: true, completed: 2 } : NO_CUSTOMER,
    agent: NO_AGENT_CONTEXT,
    settings: {},
    now: 0,
    text: "",
    facts: { slotIsFree: null, withinBusinessHours: null },
  });

  it("puts a known customer's emergency first, as anyone's", () => {
    for (const key of ["trades", "projects"] as const) {
      expect(endsAt(key, request("emergency", true)), key).toBe(3);
      expect(endsAt(key, request("emergency", false)), key).toBe(3);
      expect(endsAt(key, request("within_24h", true)), key).toBe(2);
      expect(endsAt(key, request("flexible", true)), key).toBe(2);
    }
    expect(endsAt("trades", request("flexible", false))).toBe(1);
  });
});
