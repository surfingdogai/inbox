import type { ConnectorGroup, GalleryCard } from "./types";

/**
 * How a card reads here: something to connect, something that needs its operator first, or later. A
 * card with several ways that need setting up names them all, never only the first: a hotel on one
 * system never reads that it needs another.
 */
export function cardState(card: GalleryCard): { readonly tag: string | null; readonly hint: string | null } {
  if (card.status === "ready") return { tag: null, hint: null };
  const setups = card.ways.filter((w) => w.status === "setup");
  const [only] = setups;
  if (setups.length === 1 && only) return { tag: "Needs setup", hint: only.hint ?? null };
  if (setups.length > 1) {
    return {
      tag: "Needs setup",
      hint: `${setups.map((w) => w.label).join(", ")}: each needs a partner account on this server.`,
    };
  }
  return { tag: "Soon", hint: null };
}

/** The cards of these groups, in the order the groups are given, then the gallery's own order. */
export function cardsFor(cards: readonly GalleryCard[], groups: readonly ConnectorGroup[]): GalleryCard[] {
  return groups.flatMap((g) => cards.filter((c) => c.group === g));
}
