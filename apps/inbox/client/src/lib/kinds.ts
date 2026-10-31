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
  /** Other names people search for it by ("Dog groomer", "B&B"): found by, never shown or published. */
  readonly also?: readonly string[] | undefined;
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

/** Small words a search leaves out: "and", "of", "for" in the five languages. */
const STOP = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "for",
  "e",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "para",
  "y",
  "el",
  "la",
  "los",
  "las",
  "et",
  "le",
  "les",
  "du",
  "des",
  "pour",
  "und",
  "der",
  "die",
  "fur",
]);

/** A word without its ending, so groomer, grooming and groomers, or nail and nails, are found by each other. */
function stem(word: string): string {
  for (const end of ["ings", "ing", "ers", "er", "es", "s"]) {
    if (word.length - end.length >= 3 && word.endsWith(end)) return word.slice(0, -end.length);
  }
  return word;
}

const wordsOf = (s: string) =>
  fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const compact = (s: string) => wordsOf(s).join("");

/** A name ready to be searched: whole, as its stemmed words, and run together ("guest house" is "guesthouse"). */
interface Searchable {
  readonly whole: string;
  readonly stems: readonly string[];
  readonly joined: string;
}
const searchable = (name: string): Searchable => ({
  whole: wordsOf(name).join(" "),
  stems: wordsOf(name).map(stem),
  joined: compact(name),
});

/** Each kind's names: English and its other names first (the browser's language beside them), then the rest. */
const INDEX = BUSINESS_KINDS.map((kind) => ({
  kind,
  main: [kind.names.en, ...(kind.also ?? [])].map(searchable),
  by: Object.fromEntries(LANGS.map((l) => [l, searchable(kind.names[l])])) as Record<
    (typeof LANGS)[number],
    Searchable
  >,
}));

/**
 * How well a name answers the typed words: 6 it is them, 5 it starts with them, 4 every word typed starts a word of
 * it (or, run together, they start it: "guest house" for Guesthouse), 3 some do, 1 it holds them (from three letters);
 * 0 not at all. Words are compared without their endings ("groomers" finds Pet groomer).
 */
function scoreName(n: Searchable, q: { whole: string; stems: readonly string[]; joined: string }): number {
  if (!n.whole) return 0;
  if (n.whole === q.whole) return 6;
  if (n.whole.startsWith(q.whole)) return 5;
  const hits = q.stems.filter((t) => n.stems.some((w) => w.startsWith(t))).length;
  if (hits === q.stems.length || (q.joined.length > 3 && n.joined.startsWith(q.joined))) return 4;
  if (hits > 0 && q.stems.length > 1) return 2 + hits / q.stems.length;
  if (q.whole.length > 2 && n.whole.includes(q.whole)) return 1;
  return 0;
}

/**
 * The kinds to offer for what the owner typed, best first: by every name of a kind, in any of the five languages
 * and the other names people know it by, word by word in any order and without endings ("dog groomers" finds Pet
 * groomer, "guest house" Guesthouse, "nails" Nail salon); a name in English, its other names or the browser's
 * language counts before the same match in another language ("vet" is Vet before a "vêtements"). The list's own
 * order among equals. Nothing for empty text.
 */
export function matchKinds(text: string, limit = 8, browser?: string | undefined): readonly BusinessKind[] {
  const all = wordsOf(text);
  if (all.length === 0) return [];
  const kept = all.filter((w) => !STOP.has(w));
  const words = kept.length ? kept : all;
  const q = { whole: all.join(" "), stems: words.map(stem), joined: all.join("") };
  const own = (browser ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  const scored: { kind: BusinessKind; score: number; at: number }[] = [];
  INDEX.forEach(({ kind, main, by }, at) => {
    let score = 0;
    for (const n of main) score = Math.max(score, scoreName(n, q) + 0.5);
    for (const l of LANGS) {
      if (l === "en") continue;
      score = Math.max(score, scoreName(by[l], q) + (l === own ? 0.5 : 0));
    }
    if (score >= 1) scored.push({ kind, score, at });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .map((s) => s.kind);
}

/** The kind the typed words name exactly, by any of its names in any language, if one does. */
export function exactKind(text: string): BusinessKind | undefined {
  const whole = wordsOf(text).join(" ");
  if (!whole) return undefined;
  return INDEX.find(({ main, by }) => [...main, ...LANGS.map((l) => by[l])].some((n) => n.whole === whole))?.kind;
}

/**
 * What the owner typed in the finder but never picked, read when they continue: the kind it names exactly, else
 * their own words, kept with the kind they had chosen (its id, so the setup it starts from stays). Nothing when the
 * text is empty or is what was chosen.
 */
export function settleTyped(
  text: string,
  chosen: ChosenKind | null | undefined,
): { readonly found: BusinessKind } | { readonly own: ChosenKind } | null {
  const own = chosenKind(text);
  if (!own) return null;
  // A kind's own name, even typed as "Something else", is that kind.
  const found = exactKind(own.label);
  if (found) return chosen?.id === found.id ? null : { found };
  if (chosen && fold(chosen.label) === fold(own.label)) return null;
  return { own: { id: chosen?.id ?? null, label: own.label } };
}

/** The kind as the settings keep it: a kind of the list by id with its English name, or the owner's own words. */
export function chosenKind(pick: BusinessKind | string): ChosenKind | null {
  if (typeof pick !== "string") return { id: pick.id, label: pick.names.en };
  const words = pick.trim().replace(/\s+/g, " ").slice(0, KIND_LABEL_MAX);
  return words ? { id: null, label: words } : null;
}
