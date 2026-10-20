import { formatMoney } from "./format";
import type { Item } from "./types";

type StayPayload = Extract<Item, { type: "stay" }>["payload"];

/** The nights between two local dates: their difference, never minutes. */
export function nightsOf(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}

/**
 * "12–15 Dec", "Dec 12 – 15" or "30 Dec – 2 Jan", as the reader's locale writes a range: the dates of
 * a stay, as local dates, never shifted by a zone.
 */
export function stayDates(checkIn: string, checkOut: string, locale?: string): string {
  const a = new Date(`${checkIn}T12:00:00Z`);
  const b = new Date(`${checkOut}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).formatRange(a, b);
  } catch {
    return `${checkIn} – ${checkOut}`;
  }
}

/** Guests in a stay, in a few words: "2 adults · 1 child". */
export function guestWords(p: Pick<StayPayload, "rooms">): string {
  const adults = p.rooms.reduce((a, r) => a + r.adults, 0);
  const children = p.rooms.reduce((a, r) => a + r.childrenAges.length, 0);
  const words = [`${adults} adult${adults === 1 ? "" : "s"}`];
  if (children > 0) words.push(`${children} child${children === 1 ? "" : "ren"}`);
  return words.join(" · ");
}

/** A stay's list row line (S11): "12–15 Dec · 3 nights · 2 adults · Japanese room · ¥90,540". */
export function staySnippet(p: StayPayload, locale?: string): string {
  const nights = nightsOf(p.checkIn, p.checkOut);
  const parts = [stayDates(p.checkIn, p.checkOut, locale), `${nights} night${nights === 1 ? "" : "s"}`, guestWords(p)];
  const rooms = p.rooms.map((r) => r.roomTypeName).filter(Boolean);
  if (rooms.length) parts.push(rooms.length > 1 ? `${rooms[0]} and ${rooms.length - 1} more` : (rooms[0] ?? ""));
  if (p.totalPrice) parts.push(formatMoney(p.totalPrice, locale));
  return parts.join(" · ");
}
