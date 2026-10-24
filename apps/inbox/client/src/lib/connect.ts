import type { ConnectorGroup, GalleryCard } from "./types";

/**
 * How a card reads here: something to connect, something that needs its operator first ("Not available
 * yet" when it waits on another company, as Settings → Integrations says it), or later. The tag is said
 * once: a hint that opens with it goes on from there.
 */
export function cardState(card: GalleryCard): { readonly tag: string | null; readonly hint: string | null } {
  if (card.status === "ready") return { tag: null, hint: null };
  const setup = card.ways.find((w) => w.status === "setup");
  if (setup) {
    const tag = setup.tag ?? card.ways.find((w) => w.tag)?.tag ?? "Needs setup";
    return { tag, hint: setup.hint ? withoutTag(setup.hint, tag) : null };
  }
  return { tag: "Soon", hint: null };
}

/** A hint that opens with its card's tag ("Not available yet: …"), from what comes after it. */
function withoutTag(hint: string, tag: string): string {
  if (!hint.toLowerCase().startsWith(tag.toLowerCase())) return hint;
  const rest = hint.slice(tag.length).replace(/^[\s.:;,—-]+/, "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : hint;
}

/**
 * The cards with nothing to press yet, as one quiet line by what each waits for — "Not available yet:
 * Phorest · Mindbody · Soon: Calendly" — for a phone, where their tiles are not shown. Null when none.
 */
export function waitingLine(cards: readonly GalleryCard[]): string | null {
  const by = new Map<string, string[]>();
  for (const c of cards) {
    const { tag } = cardState(c);
    if (tag) by.set(tag, [...(by.get(tag) ?? []), c.title]);
  }
  if (by.size === 0) return null;
  return [...by].map(([tag, titles]) => `${tag}: ${titles.join(" · ")}`).join(" · ");
}

/** The cards of these groups, in the order the groups are given, then the gallery's own order. */
export function cardsFor(cards: readonly GalleryCard[], groups: readonly ConnectorGroup[]): GalleryCard[] {
  return groups.flatMap((g) => cards.filter((c) => c.group === g));
}
