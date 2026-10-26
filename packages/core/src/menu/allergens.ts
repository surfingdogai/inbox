import { ALLERGEN_CLAIMS, type AllergenInfo, allergenEntry, allergenLabel, expandAllergens } from "@surfingdog/spec";
import { canonicalJson } from "../util/canonical";
import { type Caller, isPerson } from "../write/caller";
import type { MenuFields, StoredAllergens } from "./schema";

/**
 * Allergens are never inferred (ADR-040). What a business states is kept as it states it; what an import
 * or the owner's AI filled in is `unconfirmed`; and only a person at the business, in the owner app,
 * confirms it, by pressing confirm on exactly the lists they were shown (their fingerprint). Any change
 * to a dish's allergens afterwards, by anyone, makes it unconfirmed again until a person confirms it.
 *
 * Unconfirmed is answered "ask the business", never "free from"; and an order with a dish whose
 * allergens nobody confirmed waits for a person, everywhere (Reg. 1169/2011 art. 14 and 44 make the
 * information due before a distance sale is concluded in the EU; the inbox holds every order to it).
 */

/** Whether a caller may confirm allergens: the owner or staff, in person, never their AI or a key's system. */
export function mayConfirmAllergens(caller: Caller): boolean {
  return isPerson(caller) && caller.principal?.via !== "oauth";
}

/** What of a dish its allergen status speaks for: its lists, each choice's, and its allergen claims. */
function allergenContent(menu: Pick<MenuFields, "allergens" | "optionGroups" | "dietary">): unknown {
  return {
    contains: [...menu.allergens.contains].sort(),
    mayContain: [...menu.allergens.mayContain].sort(),
    choices: menu.optionGroups.flatMap((g) =>
      g.choices
        .filter((c) => c.allergens && (c.allergens.contains.length > 0 || c.allergens.mayContain.length > 0))
        .map((c) => ({
          group: g.id,
          choice: c.id,
          contains: [...(c.allergens?.contains ?? [])].sort(),
          mayContain: [...(c.allergens?.mayContain ?? [])].sort(),
        })),
    ),
    claims: menu.dietary.filter((t) => ALLERGEN_CLAIMS.has(t)).sort(),
  };
}

/** The fingerprint of what a person confirms: the same lists give the same fingerprint, on every runtime. */
export async function allergenFingerprint(
  menu: Pick<MenuFields, "allergens" | "optionGroups" | "dietary">,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(allergenContent(menu)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A dish's allergens after an edit: as confirmed as before when what they speak for did not change, else
 * unconfirmed, with where the lists came from. An edit never confirms anything: that is `confirmAllergens`.
 */
export function afterEdit(
  before: MenuFields | null,
  after: MenuFields,
  caller: Caller,
  source?: string | undefined,
): StoredAllergens {
  const same = before !== null && canonicalJson(allergenContent(before)) === canonicalJson(allergenContent(after));
  if (same && before) return before.allergens;
  const from = source ?? (isPerson(caller) ? undefined : caller.actor.kind === "owner_ai" ? "assistant" : "system");
  return {
    contains: after.allergens.contains,
    mayContain: after.allergens.mayContain,
    status: "unconfirmed",
    ...(from ? { source: from } : {}),
  };
}

/** A dish's allergens, confirmed by this person now. */
export function confirmedBy(menu: MenuFields, caller: Caller, now: number): StoredAllergens {
  return {
    contains: menu.allergens.contains,
    mayContain: menu.allergens.mayContain,
    status: "confirmed",
    confirmedAt: new Date(now).toISOString(),
    confirmedBy: caller.actor.kind === "staff" ? "staff" : "owner",
  };
}

/**
 * A dish's allergens as an agent is told them: every code with what it is a part of (walnut is a tree
 * nut too), and what it may contain beyond what it contains.
 */
export function allergenView(stored: StoredAllergens): AllergenInfo {
  const contains = expandAllergens(stored.contains);
  const may = expandAllergens(stored.mayContain).filter((c) => !contains.includes(c));
  return { status: stored.status, contains, may_contain: may };
}

/** Whether a dish's allergens may be relied on: confirmed by a person at the business. */
export function allergensConfirmed(menu: MenuFields | null): boolean {
  return menu?.allergens.status === "confirmed";
}

const ASK: Readonly<Record<string, (b: string) => string>> = {
  en: (b) => `Allergens marked unconfirmed have not been checked by ${b} yet: ask ${b} before relying on them.`,
  es: (b) => `Los alérgenos sin confirmar aún no los ha revisado ${b}: pregunta a ${b} antes de fiarte de ellos.`,
  fr: (b) =>
    `Les allergènes non confirmés n'ont pas encore été vérifiés par ${b} : demandez à ${b} avant de vous y fier.`,
  de: (b) => `Nicht bestätigte Allergene hat ${b} noch nicht geprüft: frag ${b}, bevor du dich darauf verlässt.`,
  it: (b) => `Gli allergeni non confermati non sono ancora stati verificati da ${b}: chiedi a ${b} prima di fidarti.`,
  pt: (b) =>
    `Os alergénios por confirmar ainda não foram verificados por ${b}: pergunta a ${b} antes de confiar neles.`,
  ja: (b) => `「未確認」のアレルゲンは、まだ${b}が確認していません。参考にする前に${b}にお問い合わせください。`,
};

/** What an agent is told of allergens, in the business's words and language. */
export function allergenWords(business: string, lang: string): string {
  const who = business.trim() || "the business";
  return (ASK[lang.slice(0, 2)] ?? (ASK.en as (b: string) => string))(who);
}

/** The allergens a dish contains, in words, for a summary: "Contains milk, wheat". */
export function containsWords(stored: StoredAllergens, lang: string): string {
  const codes = expandAllergens(stored.contains).filter((c, _i, all) => !all.some((o) => parentOf(o) === c));
  return codes.map((c) => allergenLabel(c, lang)).join(", ");
}

function parentOf(code: string): string | null {
  return allergenEntry(code)?.parent ?? null;
}
