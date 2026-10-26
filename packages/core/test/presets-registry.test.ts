import { describe, expect, it } from "vitest";
import { applyPresetInput, setupPlanSchema } from "../src/capabilities/index";
import {
  PRESET_KEYS,
  PRESET_NAMES,
  PRESET_REGISTRY,
  PRESETS,
  presetFor,
  presetKeySchema,
} from "../src/rules/presets/index";

/**
 * The presets are a registry (ADR-032): one file per kind of business, one line each in
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
