import type { Money } from "../../../inbox/client/src/lib/types";
import type { QuickReply } from "./replies";
import { sameWords } from "./replies";
import { money } from "./view";

/**
 * One-tap answers on an item (ADR-028 Amendment 5), built from facts and from the owner's own words,
 * never by AI:
 *
 * - on a request for a price, the matching prices from the inbox's public list of services
 *   (`GET /v1/services`, read with no token, as any assistant reads it): "€35 · Lunch for one". A tap
 *   opens the price sheet with the amount filled in;
 * - on a message, the owner's saved replies, then two default ones, only in a language we write for
 *   customers (English or Portuguese, as `customer/lang.ts`), and only for a business that speaks it.
 */

/** A service as the inbox's public door lists it: what any assistant reads. */
export interface PublicService {
  readonly id: string;
  readonly name: string;
  readonly price: {
    readonly model: string;
    readonly value?: number | undefined;
    readonly currency?: string | undefined;
    readonly per?: "booking" | "person" | undefined;
  } | null;
}

/** What the chips are made from: the public prices, and the languages and currency the business gave. */
export interface PublicFacts {
  readonly services: readonly PublicService[];
  readonly languages: readonly string[];
  readonly currency: string;
  /** When they were read from the inbox. */
  readonly at: number;
}

export type ChipLang = "en" | "pt";

/** The default chips, in the business's voice, in each language we write for customers. */
export const DEFAULT_CHIPS: Readonly<Record<ChipLang, readonly string[]>> = {
  en: ["Yes, we can.", "Sorry, not that day."],
  pt: ["Sim, podemos.", "Lamentamos, nesse dia não podemos."],
};

/** The first of the business's languages that we write for customers; null when it speaks none of them. */
export function chipLang(languages: readonly string[]): ChipLang | null {
  for (const language of languages) {
    const tag = language.trim().toLowerCase();
    if (tag === "en" || tag.startsWith("en-") || tag.startsWith("en_")) return "en";
    if (tag === "pt" || tag.startsWith("pt-") || tag.startsWith("pt_")) return "pt";
  }
  return null;
}

/** A reply chip: the owner's saved words, or a default one. */
export interface ReplyChip {
  readonly text: string;
  readonly saved: boolean;
}

/** On a message: the owner's saved replies first, then the default ones in the business's language. */
export function replyChips(saved: readonly QuickReply[], languages: readonly string[]): ReplyChip[] {
  const out: ReplyChip[] = saved.map((r) => ({ text: r.text, saved: true }));
  const lang = chipLang(languages);
  if (lang)
    for (const text of DEFAULT_CHIPS[lang])
      if (!out.some((c) => sameWords(c.text, text))) out.push({ text, saved: false });
  return out;
}

/** A price chip: what it says, and what the price sheet opens with. */
export interface PriceChip {
  /** The service it prices. */
  readonly serviceId: string;
  readonly label: string;
  /** The amount the sheet is filled in with: the price, times the people for a price per person. */
  readonly amount: Money;
  readonly service: string;
  /** A price per person, for more than one: how it was worked out ("4 × €12"). */
  readonly each?: { readonly quantity: number; readonly price: Money } | undefined;
}

/** A name as it is compared: no accents, no capitals, words only. */
function norm(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether the whole of `part`, word for word, is in `whole`. */
function within(whole: string, part: string): boolean {
  return part.length >= 3 && ` ${whole} `.includes(` ${part} `);
}

function priced(s: PublicService): boolean {
  const p = s.price;
  return (p?.model === "fixed" || p?.model === "from") && typeof p.value === "number" && p.value > 0;
}

/** At most this many prices in a row: the sheet takes any other amount. */
export const MAX_PRICE_CHIPS = 3;

/**
 * The prices that match a request for one: the service it names, when it names one (and only that);
 * else a service of the same name; else a service whose whole name is within the request's, or the
 * other way round. A service priced on request has no price to offer.
 */
export function priceChips(
  request: {
    readonly itemOffered: { readonly name: string; readonly serviceId?: string | undefined };
    readonly quantity?: number | undefined;
  },
  services: readonly PublicService[],
  currency: string,
): PriceChip[] {
  const candidates = services.filter(priced);
  const asked = norm(request.itemOffered.name);
  const serviceId = request.itemOffered.serviceId;
  const matches = serviceId
    ? candidates.filter((s) => s.id === serviceId)
    : (() => {
        const same = candidates.filter((s) => norm(s.name) === asked);
        if (same.length) return same;
        return candidates.filter((s) => within(asked, norm(s.name)) || within(norm(s.name), asked));
      })();
  return matches.slice(0, MAX_PRICE_CHIPS).map((s) => chipOf(s, request.quantity, currency));
}

function chipOf(s: PublicService, quantity: number | undefined, currency: string): PriceChip {
  const p = s.price as NonNullable<PublicService["price"]>;
  const unit: Money = { value: p.value ?? 0, currency: (p.currency ?? currency).toUpperCase() };
  const perPerson = p.per === "person";
  const people = perPerson && quantity && quantity > 1 ? quantity : 1;
  const label = `${p.model === "from" ? "From " : ""}${money(unit)}${perPerson ? " a person" : ""} · ${s.name}`;
  return {
    serviceId: s.id,
    label,
    amount: { value: unit.value * people, currency: unit.currency },
    service: s.name,
    ...(people > 1 ? { each: { quantity: people, price: unit } } : {}),
  };
}

/** What the price sheet sends: the built offer for a request for a price (`POST …/offers`), a total and a note. */
export function priceOffer(amount: Money, note: string): Record<string, unknown> {
  const words = note.trim();
  return { totalPrice: { value: amount.value, currency: amount.currency }, ...(words ? { notes: words } : {}) };
}
