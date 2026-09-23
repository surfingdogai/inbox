/**
 * The languages the business speaks to its customers in. Every sentence a customer reads — through
 * their assistant, in an email, on the page a link opens — exists in each of them (`copy.ts`).
 */
export type CustomerLang = "en" | "pt";

export const CUSTOMER_LANGS: readonly CustomerLang[] = ["en", "pt"];

/**
 * The language to answer a customer in: the first of their own locale and the business's languages,
 * in that order, that is one we write; English when none is.
 */
export function customerLang(
  locale: string | null | undefined,
  businessLanguages: readonly string[] = [],
): CustomerLang {
  for (const candidate of [locale, ...businessLanguages]) {
    const tag = candidate?.trim().toLowerCase();
    if (!tag) continue;
    if (tag === "pt" || tag.startsWith("pt-") || tag.startsWith("pt_")) return "pt";
    if (tag === "en" || tag.startsWith("en-") || tag.startsWith("en_")) return "en";
  }
  return "en";
}

/** The language an `Accept-Language` header asks for, when it is one we write; else null. */
export function langFromHeader(header: string | null | undefined): CustomerLang | null {
  if (!header) return null;
  const tags = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: (tag ?? "").trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((t) => t.tag && Number.isFinite(t.q) && t.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const t of tags) {
    if (t.tag === "pt" || t.tag.startsWith("pt-")) return "pt";
    if (t.tag === "en" || t.tag.startsWith("en-")) return "en";
  }
  return null;
}
