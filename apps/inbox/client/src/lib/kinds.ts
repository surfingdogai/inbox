import vocabulary from "../../../../../packages/spec/vocab/business-kinds.json" with { type: "json" };

/**
 * Kinds of business as the owner finds theirs (`vocab/business-kinds.json`): hundreds of them, typed ahead by
 * their name in English, Portuguese, Spanish, French or German, kept by id with the name the owner chose. A kind
 * the list lacks is the owner's own words (`id` null). Each kind names the setup it starts from (`preset`).
 */
export type KindPreset =
  | "appointments"
  | "trades"
  | "projects"
  | "food"
  | "bakery"
  | "cafe"
  | "shop"
  | "stays"
  | "general";

export interface BusinessKind {
  readonly id: string;
  readonly names: {
    readonly en: string;
    readonly pt: string;
    readonly es: string;
    readonly fr: string;
    readonly de: string;
  };
  readonly preset: KindPreset;
  readonly categories: readonly string[];
}

/** What the business runs, as the settings keep it (`directory.kind`). */
export interface ChosenKind {
  readonly id: string | null;
  readonly label: string;
}

export const BUSINESS_KINDS: readonly BusinessKind[] = vocabulary.kinds as unknown as readonly BusinessKind[];

/** The most the owner's own words for their kind may run to. */
export const KIND_LABEL_MAX = 60;

const byId = new Map(BUSINESS_KINDS.map((k) => [k.id, k]));

export function businessKind(id: string | null | undefined): BusinessKind | undefined {
  return id ? byId.get(id) : undefined;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const LANGS = ["en", "pt", "es", "fr", "de"] as const;

/** A kind's name in the owner's browser language when it is one of the five and differs from the English. */
export function kindAlso(kind: BusinessKind, browser: string | undefined): string {
  const lang = (browser ?? "").toLowerCase().split(/[-_]/)[0] as (typeof LANGS)[number];
  if (!LANGS.includes(lang) || lang === "en") return "";
  const name = kind.names[lang];
  return fold(name) === fold(kind.names.en) ? "" : name;
}

/**
 * The kinds to offer for what the owner typed, best first: a name that is the text, then names that start with
 * it, then names with a word that starts with it, then (from three letters) names that hold it, in any of the
 * five languages; the list's own order among equals. Nothing for empty text.
 */
export function matchKinds(text: string, limit = 8): readonly BusinessKind[] {
  const q = fold(text.trim());
  if (!q) return [];
  const scored: { kind: BusinessKind; score: number; at: number }[] = [];
  BUSINESS_KINDS.forEach((kind, at) => {
    const names = LANGS.map((l) => fold(kind.names[l]));
    let score = 0;
    if (names.some((n) => n === q)) score = 4;
    else if (names.some((n) => n.startsWith(q))) score = 3;
    else if (names.some((n) => n.split(/[\s&'-]+/).some((w) => w.startsWith(q)))) score = 2;
    else if (q.length > 2 && names.some((n) => n.includes(q))) score = 1;
    if (score) scored.push({ kind, score, at });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .map((s) => s.kind);
}

/** The kind as the settings keep it: a kind of the list by id with its English name, or the owner's own words. */
export function chosenKind(pick: BusinessKind | string): ChosenKind | null {
  if (typeof pick !== "string") return { id: pick.id, label: pick.names.en };
  const words = pick.trim().replace(/\s+/g, " ").slice(0, KIND_LABEL_MAX);
  return words ? { id: null, label: words } : null;
}
