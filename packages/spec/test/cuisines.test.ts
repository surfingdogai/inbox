import { describe, expect, it } from "vitest";
import {
  attributeVocabularySchema,
  CUISINE_SLUGS,
  CUISINES_VOCABULARY,
  cuisineLabel,
  cuisineVocabularySchema,
  foldCuisineTerm,
  isCuisineSlug,
  MAX_PROFILE_CUISINES,
  PROFILE_DESCRIPTION_MAX,
  profileSchema,
  profileSourceSchema,
  readCuisines,
  readCuisineTerm,
} from "../src/index";
import profileVectors from "../vectors/profile.json" with { type: "json" };
import attributes from "../vocab/attributes.json" with { type: "json" };

/** The cuisines vocabulary (spec 0.14) and attributes.json version 2, which files a cuisine as `cuisine=<slug>`. */
describe("vocab/cuisines.json", () => {
  const v = cuisineVocabularySchema.parse(CUISINES_VOCABULARY);

  it("is well formed: seven languages, a label in each, about a hundred slugs, each once", () => {
    expect(v.languages).toEqual(["en", "pt", "es", "fr", "de", "it", "nl"]);
    expect(v.max_per_business).toBe(MAX_PROFILE_CUISINES);
    expect(v.cuisines.length).toBeGreaterThanOrEqual(90);
    expect(new Set(CUISINE_SLUGS).size).toBe(CUISINE_SLUGS.length);
    for (const c of [...v.cuisines, ...v.diets]) {
      for (const lang of v.languages) expect(c.labels[lang], `${"slug" in c ? c.slug : c.term}: ${lang}`).toBeTruthy();
      for (const lang of Object.keys(c.synonyms)) expect(v.languages).toContain(lang);
    }
    // Regional cuisines first, then dishes, each in slug order: the order a chooser lists them in.
    const order = (kind: string) => v.cuisines.filter((c) => c.kind === kind).map((c) => c.slug);
    expect(order("regional")).toEqual([...order("regional")].sort());
    expect(order("dish")).toEqual([...order("dish")].sort());
    expect(CUISINE_SLUGS).toEqual([...order("regional"), ...order("dish")]);
    // A value of attributes' set key: what a filter names after cuisine=.
    for (const slug of CUISINE_SLUGS) expect(slug).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("names one entry with each term: slug, label, synonym, schema.org string or OSM value, folded", () => {
    const named = new Map<string, string>();
    for (const c of [...v.cuisines, ...v.diets]) {
      const id = "slug" in c ? c.slug : `diet:${c.term}`;
      const terms = [
        "slug" in c ? c.slug : c.term,
        ...Object.values(c.labels),
        ...Object.values(c.synonyms).flat(),
        ...c.schemaorg,
        ...c.osm,
      ];
      for (const t of terms) {
        const f = foldCuisineTerm(t);
        expect(f, `${id}: ${t}`).not.toBe("");
        expect(named.get(f) ?? id, `${t} names ${named.get(f)} and ${id}`).toBe(id);
        named.set(f, id);
      }
    }
    // An Overture place category names one entry at most.
    const overture = [...v.cuisines, ...v.diets].flatMap((c) => c.overture);
    expect(new Set(overture).size).toBe(overture.length);
  });

  it("reads vegan and vegetarian as diet attributes, and never halal or kosher", () => {
    const keys = new Map(attributes.keys.map((k) => [k.key, k]));
    expect(v.diets.map((d) => d.attribute)).toEqual(["vegan_options", "vegetarian_options"]);
    for (const d of v.diets) expect(keys.get(d.attribute)?.group).toBe("diet");
    expect(readCuisineTerm("Vegan")).toEqual({ diet: "vegan_options" });
    expect(readCuisineTerm("vegetariana")).toEqual({ diet: "vegetarian_options" });
    for (const t of ["halal", "Halal", "kosher", "casher", "koscher"]) expect(readCuisineTerm(t), t).toBeNull();
  });

  it("is what attributes.json version 2's set key cuisine holds", () => {
    const vocab = attributeVocabularySchema.parse(attributes);
    expect(vocab.version).toBe(2);
    const cuisine = vocab.keys.find((k) => k.key === "cuisine");
    expect(cuisine).toMatchObject({
      type: "set",
      values_from: "cuisines.json",
      crawlable: "declared",
      needs_proof: false,
      schemaorg: "servesCuisine",
      osm: "cuisine",
    });
    expect(cuisine?.labels.en).toBe("Cuisine");
    // Every other key is as version 1 had it: a set is the only new type.
    expect(vocab.keys.filter((k) => k.type === "set").map((k) => k.key)).toEqual(["cuisine"]);
  });
});

describe("reading a profile's cuisines", () => {
  it("reads each term as its slug in any language, capitals or accents, each once, the first five", () => {
    expect(readCuisines(["Ramen", "japonesa", "JAPANESE", "Sushi", "pizzería", "Tacos", "Thai"])).toEqual({
      cuisines: ["ramen", "japanese", "sushi", "pizza", "tacos"],
      diets: [],
    });
    expect(readCuisines(["Döner", "fish & chips", "Tex Mex", "steak_house"]).cuisines).toEqual([
      "kebab",
      "fish_and_chips",
      "tex_mex",
      "steak_house",
    ]);
  });

  it("gives a diet's attribute for vegan or vegetarian, drops anything else alone, and keeps nothing of a non-list", () => {
    expect(readCuisines(["Vegan", "vegan", "nonsense", 7, null, "", "x".repeat(81), "italian"])).toEqual({
      cuisines: ["italian"],
      diets: ["vegan_options"],
    });
    expect(readCuisines("ramen")).toEqual({ cuisines: [], diets: [] });
    expect(readCuisines(undefined)).toEqual({ cuisines: [], diets: [] });
  });

  it("labels a slug in a language, English where it has none", () => {
    expect(cuisineLabel("japanese", "pt")).toBe("Japonesa");
    expect(cuisineLabel("japanese", "pt-BR")).toBe("Japonesa");
    expect(cuisineLabel("japanese", "ja")).toBe("Japanese");
    expect(cuisineLabel("not_a_slug")).toBe("not_a_slug");
    expect(isCuisineSlug("ramen")).toBe(true);
    expect(isCuisineSlug("Ramen")).toBe(false);
  });
});

describe("a profile's 0.14 fields", () => {
  it("names at most five cuisine slugs, one of four ways to take tables, 600 characters of its own words, and sources", () => {
    expect(profileSchema.shape.cuisines.safeParse(["ramen", "japanese"]).success).toBe(true);
    expect(profileSchema.shape.cuisines.safeParse(["a", "b", "c", "d", "e", "f"]).success).toBe(false);
    expect(profileSchema.shape.cuisines.safeParse(["Ramen"]).success).toBe(false);
    for (const r of ["required", "recommended", "accepted", "walk_in_only"])
      expect(profileSchema.shape.reservations.safeParse(r).success, r).toBe(true);
    expect(profileSchema.shape.reservations.safeParse("Required").success).toBe(false);
    expect(PROFILE_DESCRIPTION_MAX).toBe(600);
    expect(profileSchema.shape.description.safeParse("x".repeat(600)).success).toBe(true);
    expect(profileSchema.shape.description.safeParse("x".repeat(601)).success).toBe(false);
    const sources = {
      description: { via: "business", at: "2026-11-30T09:00:00Z" },
      cuisines: { via: "website", url: "https://tasca.example/sobre", at: "2026-11-29T09:15:00+01:00" },
    };
    expect(profileSchema.shape.sources.safeParse(sources).success).toBe(true);
    expect(profileSourceSchema.safeParse({ via: "model", at: "2026-11-30T09:00:00Z" }).success).toBe(false);
    expect(profileSourceSchema.safeParse({ via: "business", at: "yesterday" }).success).toBe(false);
  });

  it("are what the vectors keep: each kept value is one a profile may say, its cuisines as readCuisines reads them", () => {
    let food = 0;
    for (const c of profileVectors.cases) {
      const kept = c.kept as Record<string, unknown>;
      const profile = c.profile as Record<string, unknown>;
      if (kept.cuisines !== undefined) {
        food++;
        expect(profileSchema.shape.cuisines.safeParse(kept.cuisines).success, c.name).toBe(true);
        expect(readCuisines(profile.cuisines).cuisines, c.name).toEqual(kept.cuisines);
      }
      if (kept.reservations !== undefined)
        expect(profileSchema.shape.reservations.safeParse(kept.reservations).success, c.name).toBe(true);
      if (kept.sources !== undefined) {
        expect(profileSchema.shape.sources.safeParse(kept.sources).success, c.name).toBe(true);
        // A source is kept only for a field that is.
        for (const field of Object.keys(kept.sources as object))
          expect(kept[field], `${c.name}: ${field}`).toBeTruthy();
      }
      if (typeof kept.description === "string")
        expect(kept.description.length, c.name).toBeLessThanOrEqual(PROFILE_DESCRIPTION_MAX);
    }
    expect(food).toBeGreaterThanOrEqual(3);
  });
});
