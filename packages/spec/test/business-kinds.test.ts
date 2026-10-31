import { describe, expect, it } from "vitest";
import {
  BUSINESS_KINDS,
  businessKind,
  businessKindsVocabSchema,
  isBusinessKind,
  KIND_LANGUAGES,
  KIND_PRESETS,
  kindCategories,
} from "../src/index";
import vocab from "../vocab/business-kinds.json";
import categories from "../vocab/categories.json";

/**
 * vocab/business-kinds.json: hundreds of kinds, each named in five languages, each starting from a setup an inbox
 * has, each filed under categories the directory knows; and what a kind adds to a profile's categories.
 */
describe("the business kinds vocabulary", () => {
  it("is well formed: hundreds of kinds, each once, named in every language, from a setup an inbox has", () => {
    const doc = businessKindsVocabSchema.parse(vocab);
    expect(doc.kinds.length).toBeGreaterThanOrEqual(300);
    expect(doc.languages).toEqual([...KIND_LANGUAGES]);
    expect(doc.presets).toEqual([...KIND_PRESETS]);
    const ids = BUSINESS_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    const english = BUSINESS_KINDS.map((k) => k.names.en.toLowerCase());
    expect(new Set(english).size, "each English name once").toBe(english.length);
    for (const k of BUSINESS_KINDS)
      for (const l of KIND_LANGUAGES) expect(k.names[l].trim(), `${k.id} ${l}`).toBe(k.names[l]);
    // Every setup is a kind's, so each is reached from the list.
    for (const p of KIND_PRESETS)
      expect(
        BUSINESS_KINDS.some((k) => k.preset === p),
        p,
      ).toBe(true);
  });

  it("files every kind under categories of vocab/categories.json", () => {
    const slugs = new Set(categories.categories.map((c) => c.slug));
    for (const k of BUSINESS_KINDS) for (const c of k.categories) expect(slugs.has(c), `${k.id}: ${c}`).toBe(true);
    // Every category has a kind in it, so no part of the directory is out of reach.
    for (const s of slugs)
      expect(
        BUSINESS_KINDS.some((k) => k.categories.includes(s)),
        s,
      ).toBe(true);
  });

  it("reads a kind by its id, and nothing else", () => {
    expect(businessKind("tattoo-studio")?.names).toMatchObject({ en: "Tattoo studio", pt: "Estúdio de tatuagens" });
    expect(businessKind("tattoo-studio")?.preset).toBe("appointments");
    expect(isBusinessKind("surf-house")).toBe(true);
    expect(isBusinessKind("Tattoo studio")).toBe(false);
    expect(businessKind(null)).toBeUndefined();
  });

  it("adds a kind to a profile's categories: its slugs, then its name as a free tag unless it is one of them", () => {
    expect(kindCategories({ id: "tattoo-studio", label: "Tattoo studio" })).toEqual(["hair-beauty", "Tattoo studio"]);
    // "Bakery" is the bakery category already.
    expect(kindCategories({ id: "bakery", label: "Bakery" })).toEqual(["bakery"]);
    expect(kindCategories({ id: "cafe", label: "Café" })).toEqual(["cafe"]);
    // A kind the list lacks: the business's own words, as a free tag.
    expect(kindCategories({ id: null, label: "  Hovercraft tours  " })).toEqual(["Hovercraft tours"]);
    expect(kindCategories({ id: null, label: " " })).toEqual([]);
    expect(kindCategories(null)).toEqual([]);
  });
});
