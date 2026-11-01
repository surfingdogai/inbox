import vocabulary from "../vocab/attributes.json" with { type: "json" };
import type { AttributeVocabulary } from "./network/directory";

/**
 * The attributes vocabulary (`vocab/attributes.json`, §4.10) as a reader holds it: every key a listing may carry, its
 * type, the categories it applies to, how a crawler may read it, whether it needs a proof, and its labels.
 */
export const ATTRIBUTES_VOCABULARY = vocabulary as unknown as AttributeVocabulary;

export type AttributeEntry = AttributeVocabulary["keys"][number];

const BY_KEY = new Map(ATTRIBUTES_VOCABULARY.keys.map((k) => [k.key, k]));

/** A key's entry, or undefined. */
export function attributeEntry(key: string): AttributeEntry | undefined {
  return BY_KEY.get(key);
}

/**
 * The keys a business may declare of itself, true or left out (spec 0.14): every `bool` key that needs no proof from
 * a register (never halal, kosher or a certification) and is not derived from something else the network reads
 * (`crawlable: never`, like `open_24h` from published hours). A set (`cuisine`) is said by its own field.
 */
export const DECLARABLE_ATTRIBUTES: readonly string[] = ATTRIBUTES_VOCABULARY.keys
  .filter((k) => k.type === "bool" && !k.needs_proof && k.crawlable !== "never")
  .map((k) => k.key);

const declarable = new Set(DECLARABLE_ATTRIBUTES);

/** Whether a key is one a business may declare of itself. */
export function isDeclarableAttribute(key: string): boolean {
  return declarable.has(key);
}

/** A key's label in a language, English where it has none in it; the key itself for one the vocabulary lacks. */
export function attributeLabel(key: string, lang = "en"): string {
  const entry = BY_KEY.get(key);
  if (!entry) return key;
  const base = lang.toLowerCase().split(/[-_]/)[0] ?? "en";
  return entry.labels[base] ?? entry.labels.en ?? key;
}
