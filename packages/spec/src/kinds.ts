import { z } from "zod";
import vocabulary from "../vocab/business-kinds.json" with { type: "json" };

/**
 * Kinds of business (`vocab/business-kinds.json`): what a business says it runs, from a tattoo studio to a
 * surf house. Each kind has its name in five languages, the setup it starts from (`preset`) and the directory
 * categories it falls under (slugs of `vocab/categories.json`). A profile carries a kind in its `categories`:
 * those slugs, then the kind's name as a free tag (`kindCategories`), so a network that reads categories reads
 * the kind too. A kind is never removed or renamed, so a stored one always reads.
 */
export const KIND_LANGUAGES = ["en", "pt", "es", "fr", "de"] as const;
export type KindLanguage = (typeof KIND_LANGUAGES)[number];

/** The setups a kind starts from: an inbox's rule presets, and `general`, whose rules follow what agents can do. */
export const KIND_PRESETS = [
  "appointments",
  "trades",
  "projects",
  "food",
  "bakery",
  "cafe",
  "shop",
  "stays",
  "general",
] as const;
export type KindPreset = (typeof KIND_PRESETS)[number];

const kindSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lower case words joined by hyphens"),
  names: z.object({
    en: z.string().min(1).max(60),
    pt: z.string().min(1).max(60),
    es: z.string().min(1).max(60),
    fr: z.string().min(1).max(60),
    de: z.string().min(1).max(60),
  }),
  preset: z.enum(KIND_PRESETS),
  categories: z.array(z.string().min(1).max(60)).max(3),
  /** Other names people search for it by ("Dog groomer", "B&B"), in any of the languages: found by, never published. */
  also: z.array(z.string().min(1).max(60)).max(8).optional(),
});
export type BusinessKind = z.infer<typeof kindSchema>;

/** The vocabulary file's shape, which a test holds it to. */
export const businessKindsVocabSchema = z.object({
  description: z.string().min(1),
  version: z.int().min(1),
  languages: z.array(z.enum(KIND_LANGUAGES)),
  presets: z.array(z.enum(KIND_PRESETS)),
  kinds: z.array(kindSchema).min(300),
});

export const BUSINESS_KINDS_VERSION: number = vocabulary.version;

/** Every kind, in the vocabulary's order (grouped by what they are, the most common of each first). */
export const BUSINESS_KINDS: readonly BusinessKind[] = vocabulary.kinds as unknown as readonly BusinessKind[];

const byId = new Map(BUSINESS_KINDS.map((k) => [k.id, k]));

/** The kind of an id, if it is one. */
export function businessKind(id: string | null | undefined): BusinessKind | undefined {
  return id ? byId.get(id) : undefined;
}

/** Whether a string is the id of a kind of the vocabulary. */
export function isBusinessKind(id: string): boolean {
  return byId.has(id);
}

/** The most a business's own words for its kind may run to: a profile's free tag. */
export const KIND_LABEL_MAX = 60;

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * What a business's kind adds to its profile's categories: the kind's directory categories, then its name (or,
 * for a kind the vocabulary lacks, the business's own words) as a free tag, unless that name is one of those
 * categories already ("Bakery" is `bakery`). Nothing for a label that is empty.
 */
export function kindCategories(
  kind: { readonly id: string | null; readonly label: string } | null | undefined,
): string[] {
  if (!kind) return [];
  const label = kind.label.trim().slice(0, KIND_LABEL_MAX);
  const known = businessKind(kind.id);
  const slugs = known ? [...known.categories] : [];
  const name = label || known?.names.en || "";
  if (!name) return slugs;
  return slugs.some((s) => fold(s) === fold(name)) ? slugs : [...slugs, name];
}
