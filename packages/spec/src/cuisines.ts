import { z } from "zod";
import vocabulary from "../vocab/cuisines.json" with { type: "json" };

/**
 * The cuisines vocabulary (`vocab/cuisines.json`, spec 0.14, `docs/protocol/network.md` §4.6): what a place that
 * serves food cooks, by where the food comes from (`regional`) or by what is served (`dish`). A profile names at most
 * five (`profile.cuisines`); a network keeps the ones it knows and files each as the attribute `cuisine=<slug>`
 * (`vocab/attributes.json` version 2, a `set`), so a search can ask for one. Each slug carries its labels in seven
 * languages, synonyms, the OpenStreetMap `cuisine=` values and schema.org `servesCuisine` strings that name it, and
 * the Overture place category ids whose places serve it. A diet is not a cuisine: `vegan` or `vegetarian` named as
 * one is read as its diet attribute (`diets`), and halal and kosher are never read from a cuisine.
 */
export const cuisineVocabularySchema = z.object({
  description: z.string(),
  version: z.int().min(1),
  languages: z.array(z.string().regex(/^[a-z]{2}$/)).min(1),
  max_per_business: z.int().min(1),
  cuisines: z
    .array(
      z.object({
        slug: z.string().regex(/^[a-z][a-z0-9_]*$/),
        kind: z.enum(["regional", "dish"]),
        labels: z.record(z.string(), z.string().min(1)),
        synonyms: z.record(z.string(), z.array(z.string().min(1))),
        osm: z.array(z.string().min(1)),
        schemaorg: z.array(z.string().min(1)),
        overture: z.array(z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/)),
      }),
    )
    .min(1),
  diets: z.array(
    z.object({
      term: z.string().regex(/^[a-z][a-z0-9_]*$/),
      attribute: z.string().regex(/^[a-z][a-z0-9_]*$/),
      labels: z.record(z.string(), z.string().min(1)),
      synonyms: z.record(z.string(), z.array(z.string().min(1))),
      osm: z.array(z.string().min(1)),
      schemaorg: z.array(z.string().min(1)),
      overture: z.array(z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/)),
    }),
  ),
});
export type CuisineVocabulary = z.infer<typeof cuisineVocabularySchema>;
export type CuisineEntry = CuisineVocabulary["cuisines"][number];

export const CUISINES_VOCABULARY = vocabulary as unknown as CuisineVocabulary;

/** The most cuisines a profile names and a network keeps. */
export const MAX_PROFILE_CUISINES = 5;

/** Every slug, in the vocabulary's order: regional ones, then dishes, each by slug. */
export const CUISINE_SLUGS: readonly string[] = CUISINES_VOCABULARY.cuisines.map((c) => c.slug);

const BY_SLUG = new Map(CUISINES_VOCABULARY.cuisines.map((c) => [c.slug, c]));

/** Whether a string is a slug of the vocabulary. */
export function isCuisineSlug(s: string): boolean {
  return BY_SLUG.has(s);
}

/** A slug's entry, or undefined. */
export function cuisineEntry(slug: string): CuisineEntry | undefined {
  return BY_SLUG.get(slug);
}

/** A slug's label in a language, English where the vocabulary has none in it; the slug itself when it is not one. */
export function cuisineLabel(slug: string, lang = "en"): string {
  const entry = BY_SLUG.get(slug);
  if (!entry) return slug;
  const base = lang.toLowerCase().split(/[-_]/)[0] ?? "en";
  return entry.labels[base] ?? entry.labels.en ?? slug;
}

/**
 * How a term is compared (the categories' and payments' foldTerm): lower case, accents off, every run of anything but
 * letters and digits one space, and the words "and" and "e" left out.
 */
export function foldCuisineTerm(s: string): string {
  return s
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "" && w !== "and" && w !== "e")
    .join(" ");
}

/** What a term names: a cuisine's slug, or a diet's attribute key. */
export type CuisineReading = { readonly slug: string } | { readonly diet: string };

const TERMS: ReadonlyMap<string, CuisineReading> = (() => {
  const out = new Map<string, CuisineReading>();
  const add = (terms: readonly string[], reading: CuisineReading) => {
    for (const t of terms) {
      const f = foldCuisineTerm(t);
      if (f && !out.has(f)) out.set(f, reading);
    }
  };
  const termsOf = (e: {
    labels: Record<string, string>;
    synonyms: Record<string, string[]>;
    schemaorg: string[];
    osm: string[];
  }) => [...Object.values(e.labels), ...Object.values(e.synonyms).flat(), ...e.schemaorg, ...e.osm];
  for (const c of CUISINES_VOCABULARY.cuisines) add([c.slug, ...termsOf(c)], { slug: c.slug });
  for (const d of CUISINES_VOCABULARY.diets) add([d.term, ...termsOf(d)], { diet: d.attribute });
  return out;
})();

/** What one term names: its slug, a label, a synonym, a schema.org string or an OSM value, in any capitals and accents. */
export function readCuisineTerm(term: unknown): CuisineReading | null {
  // At most 80 characters, counted as a network counts them: by code point, never by UTF-16 unit.
  if (typeof term !== "string" || [...term].length > 80) return null;
  return TERMS.get(foldCuisineTerm(term)) ?? null;
}

/**
 * What a reader keeps of a profile's `cuisines` (`vectors/profile.json`): each term read as its slug, each slug once,
 * the first five, in the profile's order; a term that names a diet gives that diet's attribute key instead (in
 * `diets`), and anything else is dropped alone. A value that is not a list keeps nothing.
 */
export function readCuisines(value: unknown): { readonly cuisines: string[]; readonly diets: string[] } {
  const cuisines: string[] = [];
  const diets: string[] = [];
  if (!Array.isArray(value)) return { cuisines, diets };
  for (const term of value.slice(0, 50)) {
    const r = readCuisineTerm(term);
    if (!r) continue;
    if ("diet" in r) {
      if (!diets.includes(r.diet)) diets.push(r.diet);
    } else if (!cuisines.includes(r.slug) && cuisines.length < MAX_PROFILE_CUISINES) {
      cuisines.push(r.slug);
    }
  }
  return { cuisines, diets };
}
