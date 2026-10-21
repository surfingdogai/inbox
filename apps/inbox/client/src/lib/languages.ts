/**
 * Languages as the owner picks them: by name, typed ahead, kept as BCP 47 codes. Browsers have no list
 * of languages to offer (Intl names them, it does not list them), so the list is ISO 639-1 here.
 */

/** The ones most businesses here speak, first in every list. */
export const COMMON_LANGUAGES: readonly string[] = [
  "en",
  "pt",
  "es",
  "fr",
  "de",
  "it",
  "nl",
  "ca",
  "pl",
  "ro",
  "sv",
  "da",
  "nb",
  "fi",
  "el",
  "cs",
  "hu",
  "tr",
  "uk",
  "ru",
  "ar",
  "hi",
  "zh",
  "ja",
  "ko",
];

/** ISO 639-1: every language with a two-letter code. */
export const ISO_639_1: readonly string[] = (
  "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el " +
  "en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu " +
  "ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na " +
  "nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so " +
  "sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
).split(" ");

/** A language's name in English (`pt-BR` → "Brazilian Portuguese"); the code when the browser cannot say. */
export function languageName(code: string, locale = "en"): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/** A language's name in itself (`pt` → "português"), or "" when it is the same as in English or unknown. */
export function nativeName(code: string): string {
  const own = languageName(code, code);
  return own === code || own.toLowerCase() === languageName(code).toLowerCase() ? "" : own;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The languages to offer for what the owner typed, best first: a code typed whole, then names that
 * start with it, then names that hold it; the common ones first among equals; never one already
 * chosen. Empty text offers the common ones.
 */
export function matchLanguages(text: string, chosen: readonly string[], limit = 8): readonly string[] {
  const taken = new Set(chosen.map((c) => c.toLowerCase()));
  const q = fold(text.trim());
  const pool = [...COMMON_LANGUAGES, ...ISO_639_1.filter((c) => !COMMON_LANGUAGES.includes(c))].filter(
    (c) => !taken.has(c),
  );
  if (!q) return pool.slice(0, limit);
  const scored: { code: string; score: number; at: number }[] = [];
  pool.forEach((code, at) => {
    const names = [fold(languageName(code)), fold(nativeName(code))].filter(Boolean);
    let score = 0;
    if (code === q) score = 4;
    else if (names.some((n) => n.startsWith(q))) score = 3;
    else if (names.some((n) => n.split(/[\s()-]+/).some((w) => w.startsWith(q)))) score = 2;
    else if (q.length > 2 && names.some((n) => n.includes(q))) score = 1;
    if (score) scored.push({ code, score, at });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .map((s) => s.code);
}

/**
 * The languages a save sends: the chosen ones as they are, unless the owner changed the language
 * customers' emails are in, which then goes first (added when it was not chosen). Never empty: with
 * nothing chosen, the email language alone.
 */
export function languagesToSave(chosen: readonly string[], emailLang: string, emailLangChanged: boolean): string[] {
  const list = [...chosen];
  if (list.length === 0) return [emailLang];
  if (!emailLangChanged) return list;
  const primary = (c: string) => c.toLowerCase().split(/[-_]/)[0];
  const at = list.findIndex((c) => primary(c) === emailLang);
  const first = at === -1 ? emailLang : (list[at] as string);
  return [first, ...list.filter((_, i) => i !== at)];
}
