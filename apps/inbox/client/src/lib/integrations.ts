import type { ConnectionView, ServiceRow } from "./types";

/**
 * Settings → Integrations, the parts that are words and rules rather than drawing: which connections
 * are booking platforms, what a card's tag says, and what a platform cannot take. Kept apart from the
 * component so they are tested on their own (Node and workerd).
 */

/**
 * Booking platforms: they book on event types, and add what they book to the calendar they check, so
 * a calendar that adds the same bookings shows each twice.
 */
const BOOKING_PLATFORMS: ReadonlySet<string> = new Set(["calcom", "calendly"]);

export function isBookingPlatform(c: Pick<ConnectionView, "kind">): boolean {
  return BOOKING_PLATFORMS.has(c.kind);
}

/** A connection that is a link the inbox serves (a calendar to import elsewhere): nothing to sync. */
export function servesLink(c: Pick<ConnectionView, "capabilities">): boolean {
  return c.capabilities.length === 0;
}

const adding = (c: ConnectionView) => c.bookings_on && c.status !== "disabled";

/**
 * A booking platform and a calendar both adding confirmed bookings: the platform puts its own in the
 * calendar too, so each would show twice there. Null when that is not so.
 */
export function bookedTwice(
  connections: readonly ConnectionView[],
): { readonly platform: ConnectionView; readonly calendar: ConnectionView } | null {
  const platform = connections.find((c) => isBookingPlatform(c) && adding(c));
  const calendar = connections.find((c) => (c.kind === "caldav" || c.kind === "google_calendar") && adding(c));
  return platform && calendar ? { platform, calendar } : null;
}

/**
 * What a card's tag says: the worst of its connections, when one is not simply connected, or what is
 * still to do with one (`unmatched`); "Made" for a link made and nothing else.
 */
export function tagOf(
  connections: readonly ConnectionView[],
  unmatched = false,
): { readonly text: string; readonly tone: "on" | "warn" | "quiet" } | null {
  if (connections.length === 0) return null;
  if (connections.every((c) => c.payments?.disconnecting)) return { text: "Disconnecting", tone: "quiet" };
  if (connections.some((c) => c.status === "error")) return { text: "Failing", tone: "warn" };
  if (connections.every((c) => c.status === "disabled")) return { text: "Paused", tone: "quiet" };
  // A property system connected and not matched yet: one step left, said in few words; the row below
  // has the one button for it.
  if (unmatched) return { text: "1 step left", tone: "warn" };
  if (connections.every(servesLink)) return { text: "Made", tone: "on" };
  // Connected and well: its row above already says so.
  return null;
}

/** The account beside a connection's title, when it says something the title does not. */
export function accountOf(c: Pick<ConnectionView, "account" | "title">): string | null {
  const account = c.account.trim();
  return account && account !== c.title ? account : null;
}

const names = (list: readonly string[]) =>
  list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;

/**
 * What a booking platform that books by length cannot take (Calendly): each length of the active
 * services that no event type here has, in a line, so the owner knows before a booking fails. Nothing
 * when bookings are off, or the connection says already that it takes none (`note`).
 */
export function lengthGaps(
  c: ConnectionView,
  services: readonly Pick<ServiceRow, "name" | "durationMin" | "active">[],
): string[] {
  if (c.kind !== "calendly" || !adding(c) || c.note) return [];
  const types = c.destinations.filter((d) => (d.lengths?.length ?? 0) > 0);
  const chosen = c.destination ? types.find((d) => d.id === c.destination) : undefined;
  const lengths = new Set((chosen ? [chosen] : types).flatMap((d) => d.lengths ?? []));
  if (lengths.size === 0) return [];
  const missing = new Map<number, string[]>();
  for (const s of services) {
    if (s.active !== 1 || lengths.has(s.durationMin)) continue;
    missing.set(s.durationMin, [...(missing.get(s.durationMin) ?? []), s.name]);
  }
  return [...missing.entries()]
    .sort(([a], [b]) => a - b)
    .map(([min, list]) =>
      chosen
        ? `${chosen.name} is not ${min} min: ${names(list)} bookings won't be added there.`
        : `No ${min}-min event type on ${c.title}: ${names(list)} bookings won't be added there.`,
    );
}
