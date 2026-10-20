/**
 * Words a business's customers never read (ADR-032): a guest, a client or a buyer deals with the
 * business, in its name and its language, and nothing they read names the software, a network, the
 * receipts and passes their assistant may carry, or a reputation. Identity plumbing goes to agents in
 * machine answers only. Every customer-facing template, page and pay-link title is held to this list
 * by the test of the track that writes it (`customerCopyProblems`).
 *
 * Whole words only, in any case: "passport", "turkey" and "keynote" are not "pass" and "key". The six
 * languages the templates ship in each have their own words. What the business writes itself (its
 * arrival details naming a key box) is its own and is not held to this.
 */
export const CUSTOMER_FORBIDDEN_WORDS: Readonly<Record<"en" | "es" | "fr" | "de" | "it" | "pt", readonly string[]>> = {
  en: [
    "surfing dog",
    "surfingdog",
    "network",
    "networks",
    "receipt",
    "receipts",
    "pass",
    "passes",
    "key",
    "keys",
    "reputation",
    "inbox",
    "inboxes",
  ],
  es: ["red de", "recibo", "recibos", "pase", "pases", "clave", "claves", "reputación", "bandeja de entrada"],
  // Not "reçu": it is also how "received" is written ("nous avons reçu votre demande").
  fr: ["réseau", "réseaux", "laissez-passer", "clé", "clés", "réputation", "boîte de réception"],
  de: ["netzwerk", "netzwerke", "quittung", "beleg", "schlüssel", "ruf", "reputation", "posteingang"],
  it: ["rete", "reti", "ricevuta", "ricevute", "pass", "chiave", "chiavi", "reputazione", "posta in arrivo"],
  pt: ["rede", "redes", "recibo", "recibos", "passe", "passes", "chave", "chaves", "reputação", "caixa de entrada"],
};

const escapeWord = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

const PATTERNS = Object.fromEntries(
  Object.entries(CUSTOMER_FORBIDDEN_WORDS).map(([lang, words]) => [
    lang,
    words.map((w) => ({ word: w, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeWord(w)}(?![\\p{L}\\p{N}])`, "iu") })),
  ]),
) as Record<string, { word: string; re: RegExp }[]>;

/**
 * The forbidden words a customer-facing text holds, in its language and in English (every language's
 * templates are checked for the English words too: a word left untranslated is still read).
 */
export function customerWordsIn(text: string, lang = "en"): string[] {
  const primary = lang.toLowerCase().split(/[-_]/)[0] ?? "en";
  const lists = primary === "en" ? ["en"] : ["en", primary];
  const found = new Set<string>();
  for (const l of lists) for (const p of PATTERNS[l] ?? []) if (p.re.test(text)) found.add(p.word);
  return [...found];
}

/**
 * Every forbidden word in a set of customer-facing strings, by the string's name: empty when they are
 * all fit for a customer. For tests: `expect(customerCopyProblems(templates, "fr")).toEqual([])`.
 */
export function customerCopyProblems(
  strings: Readonly<Record<string, string>> | readonly string[],
  lang = "en",
): string[] {
  const entries = Array.isArray(strings)
    ? strings.map((s, i) => [String(i), s] as const)
    : Object.entries(strings as Readonly<Record<string, string>>);
  const out: string[] = [];
  for (const [name, text] of entries) {
    for (const word of customerWordsIn(text, lang)) out.push(`${name}: "${word}"`);
  }
  return out;
}
