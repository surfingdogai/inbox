import type { Settings } from "./types";

/**
 * Where the details a setup plan filled in were read (`settings.setup.sources`), for the owner to
 * check: the site, and whether only a page's words said it (`read`) or the site declared it. Once the
 * owner saves the part of Settings that holds a detail, its note goes: they have checked it.
 */
type Sources = Settings["setup"]["sources"];

export interface SourceNote {
  readonly host: string;
  /** Read from a page's words, or by a language model: for the owner to check. */
  readonly check: boolean;
}

/** The note for the first of `fields` that has one (`services`, `profile.name`, …), or null. */
export function sourceNote(sources: Sources | undefined, ...fields: readonly string[]): SourceNote | null {
  for (const field of fields) {
    const s = sources?.[field];
    if (!s || s.confidence === "confirmed") continue;
    let host = s.source_url;
    try {
      host = new URL(s.source_url).hostname.replace(/^www\./, "");
    } catch {
      // Kept as written: the settings checked it was a URL when it was stored.
    }
    return { host, check: s.confidence === "read" };
  }
  return null;
}

/** The settings write that takes the notes for `fields` away; null when none of them has one. */
export function clearSources(
  sources: Sources | undefined,
  ...fields: readonly string[]
): { setup: { sources: Record<string, null> } } | null {
  const held = fields.filter((f) => sources?.[f]);
  if (!held.length) return null;
  return { setup: { sources: Object.fromEntries(held.map((f) => [f, null])) } };
}
