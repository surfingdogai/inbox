import type { OfferSection } from "./setup";
import type { GalleryCard, GalleryWay } from "./types";

/**
 * Bringing things in from the systems a business already uses, as the setup and Settings → Integrations say it:
 * which systems each part can come from, and how far along each one is, in plain words. Kept apart from the setup's
 * other words so the integrations screens never load the kinds of business with it.
 */

/**
 * The systems each part can be brought from, as Settings → Integrations' cards: a till or shop's catalogue, a
 * booking platform's or a calendar's times, a property system's rooms, a job tool. In this order.
 */
export const SOURCE_CARDS: Readonly<Record<OfferSection | "rooms" | "work", readonly string[]>> = {
  services: ["square", "calendly", "calcom", "calendar"],
  products: ["shopify", "woocommerce", "square"],
  menu: ["pos", "square", "woocommerce", "shopify"],
  rooms: ["property", "calendar"],
  work: ["job_tool", "calendar"],
};

/**
 * Connectors that have run against a real account of their platform: only these read as ready. Every other one was
 * built from its platform's documentation and checked against a stand-in, and says so. A kind joins this list once a
 * first live account has confirmed it.
 */
export const VERIFIED_LIVE: ReadonlySet<string> = new Set<string>();

/** Platforms that let only approved partners connect: until ours is approved, they wait on the partner, not on us. */
export const PARTNER_KINDS: ReadonlySet<string> = new Set([
  "mews",
  "apaleo",
  "cloudbeds",
  "smoobu",
  "toast",
  "lightspeed",
  "clover",
  "deliverect",
  "jobber",
]);

export type SourceState = "ready" | "unverified" | "partner" | "setup" | "soon";

/** What each state says, in the owner's words. */
export const SOURCE_WORDS: Readonly<Record<SourceState, string>> = {
  ready: "Ready",
  unverified: "Built, not yet verified on a live account",
  partner: "Waiting for the partner",
  setup: "Needs setup on this server",
  soon: "On its way",
};

/** One system to bring things from: its name, what it brings, how far along it is, and the card that connects it. */
export interface SourceRow {
  readonly key: string;
  readonly name: string;
  readonly line: string;
  /** Settings → Integrations' card that connects it (`?open=`). */
  readonly card: string;
  readonly state: SourceState;
  readonly words: string;
  /** Why it is not ready, as the server says it; null when it is. */
  readonly hint: string | null;
}

/** How far along a platform is, from its ways: one that can be connected is ready, verified live or not. */
export function sourceState(ways: readonly Pick<GalleryWay, "kind" | "status">[]): SourceState {
  const ready = ways.filter((w) => w.status === "ready");
  if (ready.length) return ready.some((w) => VERIFIED_LIVE.has(w.kind)) ? "ready" : "unverified";
  if (ways.some((w) => PARTNER_KINDS.has(w.kind))) return "partner";
  if (ways.some((w) => w.status === "setup")) return "setup";
  return "soon";
}

/** Cards whose ways are each a platform of their own: a row per platform. */
const MULTI = new Set(["property", "job_tool", "pos"]);

/**
 * The rows for the given cards, in that order, from what this inbox offers (Settings → Integrations' gallery): a
 * card with one platform is one row; a property system, a job tool or a till is a row per platform; the calendar
 * is Google, then the rest. A card this inbox does not offer is left out.
 */
export function sourceRows(
  cards: readonly GalleryCard[],
  ids: readonly string[],
  /** A place to stay: its calendar is the links its other channels give, named as it knows them. */
  opts: { readonly lodging?: boolean | undefined } = {},
): SourceRow[] {
  const rows: SourceRow[] = [];
  const seen = new Set<string>();
  const add = (card: GalleryCard, key: string, name: string, ways: readonly GalleryWay[]) => {
    if (ways.length === 0 || seen.has(key)) return;
    seen.add(key);
    const state = sourceState(ways);
    const hint = state === "ready" || state === "unverified" ? null : (ways.find((w) => w.hint)?.hint ?? null);
    rows.push({ key, name, line: card.line, card: card.id, state, words: SOURCE_WORDS[state], hint });
  };
  for (const id of ids) {
    const card = cards.find((c) => c.id === id);
    if (!card) continue;
    if (card.id === "calendar" && opts.lodging) {
      const links = card.ways.filter((w) => w.kind === "ics" || w.kind === "caldav");
      add(
        { ...card, line: "Airbnb, Booking.com, Vrbo: the nights they hold" },
        "calendar_links",
        "Calendar links",
        links,
      );
    } else if (card.id === "calendar") {
      add(
        card,
        "google_calendar",
        "Google Calendar",
        card.ways.filter((w) => w.kind === "google_calendar"),
      );
      add(
        card,
        "calendar_other",
        "iCloud, Outlook or a calendar link",
        card.ways.filter((w) => w.kind !== "google_calendar"),
      );
    } else if (MULTI.has(card.id)) {
      for (const way of card.ways.filter((w) => !w.advanced)) {
        add(
          card,
          way.kind,
          way.label,
          card.ways.filter((w) => w.kind === way.kind),
        );
      }
    } else {
      add(card, card.id, card.title, card.ways);
    }
  }
  return rows;
}
