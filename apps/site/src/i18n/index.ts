/**
 * Every language's dictionary, by its code. A language is added here and in src/lib/i18n.ts; the
 * Dict type names any key its dictionary lacks, and the tests read every one of them.
 */
import type { Lang } from "../lib/i18n";
import { de } from "./de";
import { en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";
import { pt } from "./pt";
import type { Dict } from "./types";

export const DICTS: Readonly<Record<Lang, Dict>> = { en, es, pt, fr, de, it };

export const dict = (lang: Lang): Dict => DICTS[lang];

/** A word of the bar or the footer in a language, by its English words; English is the source. */
export const navWord = (lang: Lang, english: string): string => DICTS[lang].ui.nav[english] ?? english;

export type { Dict } from "./types";
