import type { FeedBooking, FeedContext, Interval, RunContext } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  bookingsCalendar,
  busyFromICal,
  ICS_FEED_AHEAD_DAYS,
  ICS_FEED_PAST_DAYS,
  icsConnector,
  icsFeedConnector,
  isOwnUid,
  ownUid,
  parseICal,
} from "../src/index";
import { fakePlatform } from "./fakes/platform";

/**
 * The calendar link to share (ADR-030): confirmed bookings as RFC 5545 for another platform to import
 * (https://www.rfc-editor.org/rfc/rfc5545), and read back by the inbox's own calendar link without
 * blocking its own time twice. A B&B in Oaxaca and a studio in Melbourne.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-02T15:00:00Z");
const OAXACA = {
  id: "7d2e91c0a4b35f6e8a12",
  origin: "https://reservas.casa-azul.example.com",
  host: "reservas.casa-azul.example.com",
  name: "Casa Azul, Oaxaca",
  timezone: "America/Mexico_City",
  language: "es",
};

const stay: FeedBooking = {
  itemId: "01JBOAXSTAY0000000000001",
  // Two nights from midnight to midnight in Oaxaca (UTC-6, no daylight saving since 2022).
  start: Date.parse("2026-12-24T06:00:00Z"),
  end: Date.parse("2026-12-26T06:00:00Z"),
  serviceName: "Habitación doble; vista al jardín, con desayuno",
  sequence: 3,
  updatedAt: Date.parse("2026-10-30T18:12:00Z"),
};
const tour: FeedBooking = {
  itemId: "01JBOAXTOUR0000000000002",
  start: Date.parse("2026-11-05T16:00:00Z"),
  end: Date.parse("2026-11-05T19:30:00Z"),
  serviceName: "Recorrido de mezcal",
  sequence: 1,
  updatedAt: Date.parse("2026-11-01T09:00:00Z"),
};

function feedCtx(bookings: readonly FeedBooking[], asked: Interval[] = []): FeedContext {
  return {
    now: NOW,
    inbox: OAXACA,
    extra: {},
    async bookings(window) {
      asked.push(window);
      return bookings.filter((b) => b.end > window.start && b.start < window.end);
    },
  };
}

/** Unfolds and splits an iCalendar text into its content lines (RFC 5545 §3.1). */
const linesOf = (text: string) => text.replace(/\r\n[ \t]/g, "").split("\r\n");

/** The events of the feed's one calendar. */
const eventsOf = (text: string) =>
  (parseICal(text).find((c) => c.name === "VCALENDAR")?.children ?? []).filter((c) => c.name === "VEVENT");

describe("the calendar link to share", () => {
  const feed = icsFeedConnector();

  it("is a link to make, with nothing to sign in to and nothing it reads or writes elsewhere", () => {
    expect(feed).toMatchObject({ kind: "ics_feed", auth: "link", group: "calendars", capabilities: [] });
    expect(feed.feed?.extension).toBe(".ics");
    expect(feed.connect).toBeUndefined();
    expect(feed.busy).toBeUndefined();
    expect(feed.bookings).toBeUndefined();
    expect(feed.steps?.length).toBeGreaterThan(0);
  });

  it("serves confirmed bookings as RFC 5545: stable UIDs, UTC times, whole days as dates, service names only", async () => {
    const asked: Interval[] = [];
    const res = await feed.feed?.serve(feedCtx([tour, stay], asked), { headers: new Headers(), extension: ".ics" });
    expect(res?.status).toBe(200);
    expect(res?.headers["content-type"]).toBe("text/calendar; charset=utf-8");
    expect(asked).toEqual([{ start: NOW - ICS_FEED_PAST_DAYS * DAY, end: NOW + ICS_FEED_AHEAD_DAYS * DAY }]);
    const text = String(res?.body);
    // CRLF everywhere, and no line over 75 octets.
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    for (const line of text.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const lines = linesOf(text);
    expect(lines.slice(0, 6)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Surfing Dog//Inbox bookings//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Casa Azul\\, Oaxaca",
    ]);
    const events = eventsOf(text);
    expect(events).toHaveLength(2);
    const prop = (i: number, name: string) => events[i]?.props.find((p) => p.name === name);
    // A booking with times: in UTC.
    expect(prop(0, "UID")?.value).toBe(ownUid(tour.itemId, OAXACA.id));
    expect(prop(0, "DTSTART")?.value).toBe("20261105T160000Z");
    expect(prop(0, "DTEND")?.value).toBe("20261105T193000Z");
    expect(prop(0, "SUMMARY")?.value).toBe("Recorrido de mezcal");
    expect(prop(0, "SEQUENCE")?.value).toBe("1");
    expect(prop(0, "DTSTAMP")?.value).toBe("20261101T090000Z");
    // Whole days in the business's zone: dates, the end the day after the last night.
    expect(prop(1, "DTSTART")).toMatchObject({ value: "20261224", params: { VALUE: "DATE" } });
    expect(prop(1, "DTEND")).toMatchObject({ value: "20261226", params: { VALUE: "DATE" } });
    expect(lines).toContain("SUMMARY:Habitación doble\\; vista al jardín\\, con desayuno");
    expect(prop(1, "SEQUENCE")?.value).toBe("3");
    expect(lines.filter((l) => l === "STATUS:CONFIRMED" || l === "TRANSP:OPAQUE")).toHaveLength(4);
    // Nothing about who booked, and no address of the inbox's.
    expect(text).not.toMatch(/ATTENDEE|ORGANIZER|DESCRIPTION|URL|@example|reservas\./);
  });

  it("answers the same text for the same bookings, and 304 to an importer that has it", async () => {
    const one = await feed.feed?.serve(feedCtx([stay]), { headers: new Headers(), extension: ".ics" });
    const two = await feed.feed?.serve(
      { ...feedCtx([stay]), now: NOW + 3_600_000 },
      {
        headers: new Headers(),
        extension: ".ics",
      },
    );
    expect(two?.body).toBe(one?.body);
    const etag = String(one?.headers.etag);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const cached = await feed.feed?.serve(feedCtx([stay]), {
      headers: new Headers({ "if-none-match": `W/"other", ${etag}` }),
      extension: ".ics",
    });
    expect(cached).toMatchObject({ status: 304, body: "" });
    // Moved: a new ETag and a higher SEQUENCE.
    const moved = await feed.feed?.serve(
      feedCtx([{ ...stay, start: stay.start + DAY, end: stay.end + DAY, sequence: 4, updatedAt: NOW }]),
      { headers: new Headers({ "if-none-match": etag }), extension: ".ics" },
    );
    expect(moved?.status).toBe(200);
    expect(moved?.body).toContain("SEQUENCE:4");
  });

  it("keeps a stay all-day across a change of clocks, and an hour-long booking at midnight timed", () => {
    // Melbourne moves its clocks on 4 April 2027: the night of the 3rd is 25 hours long.
    const text = bookingsCalendar(
      [
        {
          itemId: "mel-1",
          start: Date.parse("2027-04-02T13:00:00Z"),
          end: Date.parse("2027-04-04T14:00:00Z"),
          serviceName: "Studio",
          sequence: 1,
          updatedAt: NOW,
        },
        {
          itemId: "mel-2",
          start: Date.parse("2027-02-01T13:00:00Z"),
          end: Date.parse("2027-02-01T14:00:00Z"),
          serviceName: "Night shoot",
          sequence: 1,
          updatedAt: NOW,
        },
      ],
      { inboxId: OAXACA.id, name: "Light Room Studio", timezone: "Australia/Melbourne" },
    );
    const lines = linesOf(text);
    expect(lines).toContain("DTSTART;VALUE=DATE:20270403");
    expect(lines).toContain("DTEND;VALUE=DATE:20270405");
    expect(lines).toContain("DTSTART:20270201T130000Z");
    // A zone the inbox does not know: times, never a guessed day.
    const unknown = linesOf(bookingsCalendar([stay], { inboxId: "x", name: "", timezone: "Mars/Olympus" }));
    expect(unknown).toContain("DTSTART:20261224T060000Z");
    expect(unknown).toContain("X-WR-CALNAME:Bookings");
  });

  it("is an empty calendar, still valid, with no booking", () => {
    expect(linesOf(bookingsCalendar([], { inboxId: OAXACA.id, name: "Casa Azul", timezone: OAXACA.timezone }))).toEqual(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Surfing Dog//Inbox bookings//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Casa Azul",
        "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
        "X-PUBLISHED-TTL:PT15M",
        "END:VCALENDAR",
        "",
      ],
    );
  });
});

describe("no loops with the calendar link the inbox reads", () => {
  const text = bookingsCalendar([tour, stay], { inboxId: OAXACA.id, name: "Casa Azul", timezone: OAXACA.timezone });
  const window = { start: NOW, end: NOW + 90 * DAY };

  it("knows every event of its own feed for its own, and another inbox's for busy time", () => {
    expect(eventsOf(text)).toHaveLength(2);
    for (const e of eventsOf(text)) {
      expect(isOwnUid(String(e.props.find((p) => p.name === "UID")?.value), OAXACA.id)).toBe(true);
    }
    const own = busyFromICal(text, window, { timezone: OAXACA.timezone, skipUid: (u) => isOwnUid(u, OAXACA.id) });
    expect(own).toEqual([]);
    const another = busyFromICal(text, window, {
      timezone: OAXACA.timezone,
      skipUid: (u) => isOwnUid(u, "another-inbox"),
    });
    expect(another).toHaveLength(2);
  });

  it("blocks nothing when the inbox's calendar link reads a calendar that copied its feed", async () => {
    // A booking site that imported the feed and publishes it again, UIDs kept, beside its own booking.
    const copied = text.replace(
      "END:VCALENDAR",
      [
        "BEGIN:VEVENT",
        "UID:airbnb-reservation-48213@platform.example.com",
        "DTSTAMP:20261101T000000Z",
        "DTSTART;VALUE=DATE:20261120",
        "DTEND;VALUE=DATE:20261122",
        "SUMMARY:Reserved",
        "TRANSP:OPAQUE",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const p = fakePlatform().on(
      "GET",
      "https://calendar.platform.example.com/ical/casa-azul.ics",
      () => new Response(copied, { headers: { "content-type": "text/calendar" } }),
    );
    const ctx: RunContext = {
      http: p.http,
      now: NOW,
      inbox: OAXACA,
      secret: { url: "https://calendar.platform.example.com/ical/casa-azul.ics" },
      extra: {},
      calendars: [],
      busyCalendars: [],
      destinations: [],
      destination: null,
      own: { ids: new Set(), spans: [] },
      marker: "m",
      saveSecret: async () => {},
    };
    const busy = await icsConnector().busy?.(ctx, window);
    // Only the platform's own reservation, two nights in Oaxaca.
    expect(busy).toEqual([{ start: Date.parse("2026-11-20T06:00:00Z"), end: Date.parse("2026-11-22T06:00:00Z") }]);
  });
});
