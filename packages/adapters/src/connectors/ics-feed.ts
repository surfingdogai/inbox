import type { ConnectorDefinition, FeedBooking, FeedContext, FeedRequest, FeedResponse } from "@surfingdog/core";
import { escapeText, foldLine } from "./caldav/ical";
import { ownUid } from "./caldav/index";
import { wallTimeOf } from "./caldav/zones";

/**
 * The calendar link to share (ADR-030): the inbox's confirmed bookings as an iCalendar feed (RFC 5545,
 * https://www.rfc-editor.org/rfc/rfc5545), at a private address the owner pastes where another platform
 * imports a calendar by link: a booking site's calendar sync, a phone's calendar, Google Calendar's "From
 * URL". With the calendar link the inbox already reads (`ics`), a business that also takes bookings
 * elsewhere keeps both sides closed for the same time.
 *
 * What it shows is what a link may travel with: when the business is booked and for which service,
 * never who booked, how to reach them, or a price. Each booking keeps one UID for its whole life, the
 * same one CalDAV writes (`ownUid`), so an importer updates it in place, and the inbox, reading a
 * calendar that copied it back, knows it for its own and does not block its own time twice (`isOwnUid`
 * in `ics.ts`). `SEQUENCE` rises when it moves; a cancelled one leaves the feed, which importers read as
 * removed. A booking that covers whole days in the business's zone is an all-day event (`VALUE=DATE`),
 * the way stay platforms block nights.
 *
 * Nothing is asked of any platform and nothing is written anywhere: the link is the whole connection.
 * The token in it is the secret (32 random bytes; only its hash is kept for the lookup); making a new
 * link stops the old one at once (`rotateLink`).
 */

/** How far back the feed reaches: a booking a platform already imported does not vanish the next day. */
export const ICS_FEED_PAST_DAYS = 30;
/** How far ahead: eighteen months, as far as stay platforms take bookings. */
export const ICS_FEED_AHEAD_DAYS = 548;

const DAY_MS = 86_400_000;

/** `YYYYMMDDTHHMMSSZ`, the UTC form RFC 5545 §3.3.5 calls form #2. */
function utcStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * The days a booking covers in the business's zone, when it starts and ends at midnight there: an
 * all-day event, `DTEND` the day after the last (RFC 5545 §3.6.1). Null for a booking with times.
 */
function wholeDays(b: FeedBooking, zone: string): { readonly start: string; readonly end: string } | null {
  let s: ReturnType<typeof wallTimeOf>;
  let e: ReturnType<typeof wallTimeOf>;
  try {
    s = wallTimeOf(b.start, zone);
    e = wallTimeOf(b.end, zone);
  } catch {
    return null;
  }
  const midnight = (w: typeof s) => w.hour === 0 && w.minute === 0 && w.second === 0;
  if (!midnight(s) || !midnight(e) || b.end - b.start < DAY_MS - 3_600_000) return null;
  return {
    start: `${pad(s.year, 4)}${pad(s.month)}${pad(s.day)}`,
    end: `${pad(e.year, 4)}${pad(e.month)}${pad(e.day)}`,
  };
}

/** The feed's text: one VCALENDAR, one VEVENT per confirmed booking, CRLF line ends, folded at 75 octets. */
export function bookingsCalendar(
  bookings: readonly FeedBooking[],
  opts: { readonly inboxId: string; readonly name: string; readonly timezone: string },
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Surfing Dog//Inbox bookings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.name.trim().slice(0, 120) || "Bookings")}`,
    // How often a calendar app should look again (RFC 7986 §5.7); most poll on their own schedule.
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];
  for (const b of bookings) {
    const days = wholeDays(b, opts.timezone);
    // The last change, not the moment of the request: the same bookings give the same text, so an
    // importer that asks again with the ETag it has is told nothing changed.
    const stamp = utcStamp(b.updatedAt > 0 ? b.updatedAt : b.start);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ownUid(b.itemId, opts.inboxId)}`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      ...(days
        ? [`DTSTART;VALUE=DATE:${days.start}`, `DTEND;VALUE=DATE:${days.end}`]
        : [`DTSTART:${utcStamp(b.start)}`, `DTEND:${utcStamp(b.end)}`]),
      `SUMMARY:${escapeText(b.serviceName.slice(0, 120) || "Booked")}`,
      `SEQUENCE:${Math.max(0, Math.floor(b.sequence))}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

async function etagOf(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  return `"${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** Whether an `If-None-Match` names this ETag (a list, weak or strong, or `*`). */
function matches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((raw) => {
    const t = raw.trim().replace(/^W\//, "");
    return t === "*" || t === etag;
  });
}

async function serve(ctx: FeedContext, request: FeedRequest): Promise<FeedResponse> {
  const bookings = await ctx.bookings({
    start: ctx.now - ICS_FEED_PAST_DAYS * DAY_MS,
    end: ctx.now + ICS_FEED_AHEAD_DAYS * DAY_MS,
  });
  const body = bookingsCalendar(bookings, {
    inboxId: ctx.inbox.id,
    name: ctx.inbox.name,
    timezone: ctx.inbox.timezone,
  });
  const etag = await etagOf(body);
  const headers = {
    "content-type": "text/calendar; charset=utf-8",
    "content-disposition": 'inline; filename="bookings.ics"',
    etag,
  };
  if (matches(request.headers.get("if-none-match"), etag)) return { status: 304, headers, body: "" };
  return { status: 200, headers, body };
}

export function icsFeedConnector(): ConnectorDefinition {
  return {
    kind: "ics_feed",
    title: "Calendar link to share",
    group: "calendars",
    capabilities: [],
    auth: "link",
    note: "When you are booked and for what, never who booked. Anyone with the link sees it.",
    steps: [
      "Paste the link where another site or app imports a calendar: often Import calendar, Sync calendars or Subscribe.",
      "Bookings show there as often as that site looks again: minutes on some, a few hours on others.",
    ],
    feed: { extension: ".ics", serve },
  };
}
