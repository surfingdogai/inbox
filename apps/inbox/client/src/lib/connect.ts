import type { ConnectorGroup, GalleryCard } from "./types";

/**
 * How a card reads here: something to connect, something that needs its operator first ("Not available
 * yet" when it waits on another company, as Settings → Integrations says it), or later.
 */
export function cardState(card: GalleryCard): { readonly tag: string | null; readonly hint: string | null } {
  if (card.status === "ready") return { tag: null, hint: null };
  const setup = card.ways.find((w) => w.status === "setup");
  if (setup) return { tag: setup.tag ?? card.ways.find((w) => w.tag)?.tag ?? "Needs setup", hint: setup.hint ?? null };
  return { tag: "Soon", hint: null };
}

/** The cards of these groups, in the order the groups are given, then the gallery's own order. */
export function cardsFor(cards: readonly GalleryCard[], groups: readonly ConnectorGroup[]): GalleryCard[] {
  return groups.flatMap((g) => cards.filter((c) => c.group === g));
}
