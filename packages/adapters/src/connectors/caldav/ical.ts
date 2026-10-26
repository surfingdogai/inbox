import { type Interval, mergeIntervals } from "@surfingdog/core";
import { expandRRule, parseRRule } from "./rrule";
import { resolveZone, type WallTime, wallTimeOf, zonedToUtc } from "./zones";

/**
 * iCalendar (RFC 5545), the part a calendar's busy times need, and the one event this inbox writes.
 *
 * What counts as busy, as calendars count it: an event that is not cancelled and not marked free
 * (`TRANSP:TRANSPARENT`). An all-day event counts only when it is marked busy (`TRANSP:OPAQUE`):
 * birthdays and holidays sit on whole days and are almost never meant to close a business, so one
 * that should is marked busy in the calendar app. Times are read in the event's zone, a floating
 * time in the business's.
 */

interface Prop {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

interface Component {
  readonly name: string;
  readonly props: Prop[];
  readonly children: Component[];
}

/** Unfolds and splits lines, then nests BEGIN/END. Anything malformed is skipped, never fatal. */
export function parseICal(text: string): Component[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const root: Component = { name: "#root", props: [], children: [] };
  const stack: Component[] = [root];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const prop = parseLine(raw);
    if (!prop) continue;
    const top = stack[stack.length - 1] ?? root;
    if (prop.name === "BEGIN") {
      const c: Component = { name: prop.value.toUpperCase(), props: [], children: [] };
      top.children.push(c);
      if (stack.length < 16) stack.push(c);
    } else if (prop.name === "END") {
      if (stack.length > 1 && top.name === prop.value.toUpperCase()) stack.pop();
    } else top.props.push(prop);
  }
  return root.children;
}

function parseLine(line: string): Prop | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments: string[] = [];
  let current = "";
  quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      segments.push(current);
      current = "";
    } else current += c;
  }
  segments.push(current);
  const name = (segments.shift() ?? "").trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const s of segments) {
    const eq = s.indexOf("=");
    if (eq > 0)
      params[s.slice(0, eq).trim().toUpperCase()] = s
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

const allOf = (c: Component, name: string) => c.props.filter((p) => p.name === name);
const oneOf = (c: Component, name: string) => c.props.find((p) => p.name === name);

/** A DATE or DATE-TIME as read: wall time with how to place it, or an all-day date. */
interface Stamp {
  readonly wall: WallTime;
  /** `utc`, a zone name, or `floating`. */
  readonly zone: "utc" | "floating" | string;
  readonly allDay: boolean;
}

function readStamp(p: Prop | undefined): Stamp | null {
  if (!p) return null;
  return parseStamp(p.value.split(",")[0] ?? "", p.params);
}

function parseStamp(value: string, params: Readonly<Record<string, string>>): Stamp | null {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || params.VALUE === "DATE") {
    const m = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return {
      wall: { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: 0, minute: 0, second: 0 },
      zone: "floating",
      allDay: true,
    };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!dt) return null;
  const wall = {
    year: Number(dt[1]),
    month: Number(dt[2]),
    day: Number(dt[3]),
    hour: Number(dt[4]),
    minute: Number(dt[5]),
    second: Number(dt[6]),
  };
  if (dt[7] === "Z") return { wall, zone: "utc", allDay: false };
  if (params.TZID) return { wall, zone: params.TZID, allDay: false };
  return { wall, zone: "floating", allDay: false };
}

interface Zones {
  /** IANA zone for a TZID, else a fixed offset (minutes) the calendar's own VTIMEZONE gives. */
  readonly resolve: (tzid: string) => { readonly zone: string } | { readonly offsetMin: number };
  readonly fallback: string;
}

function placeStamp(s: Stamp, zones: Zones): number {
  const w = s.wall;
  if (s.zone === "utc") return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  if (s.zone === "floating") return zonedToUtc(w, zones.fallback);
  const r = zones.resolve(s.zone);
  if ("zone" in r) return zonedToUtc(w, r.zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - r.offsetMin * 60_000;
}

/** ISO 8601 duration (P1D, PT1H30M, -PT15M) in milliseconds. */
export function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const ms =
    ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86_400 +
      Number(m[4] ?? 0) * 3600 +
      Number(m[5] ?? 0) * 60 +
      Number(m[6] ?? 0)) *
    1000;
  return m[1] === "-" ? -ms : ms;
}

function zonesFor(calendars: readonly Component[], fallback: string): Zones {
  const offsets = new Map<string, number>();
  for (const cal of calendars) {
    for (const tz of cal.children.filter((c) => c.name === "VTIMEZONE")) {
      const id = oneOf(tz, "TZID")?.value;
      const standard = tz.children.find((c) => c.name === "STANDARD") ?? tz.children[0];
      const to = standard ? oneOf(standard, "TZOFFSETTO")?.value : undefined;
      const m = to ? /^([+-])(\d{2})(\d{2})/.exec(to) : null;
      if (id && m) offsets.set(id, (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])));
    }
  }
  const cache = new Map<string, { zone: string } | { offsetMin: number }>();
  return {
    fallback,
    resolve(tzid) {
      let r = cache.get(tzid);
      if (!r) {
        const zone = resolveZone(tzid);
        r = zone ? { zone } : offsets.has(tzid) ? { offsetMin: offsets.get(tzid) ?? 0 } : { zone: fallback };
        cache.set(tzid, r);
      }
      return r;
    },
  };
}

export interface BusyOptions {
  /** The business's zone: floating times and all-day dates are read in it. */
  readonly timezone: string;
  /** Leave out an event: this inbox's own, by UID. */
  readonly skipUid?: ((uid: string) => boolean) | undefined;
}

/**
 * The busy times one iCalendar body holds inside the window. Several bodies (one per event resource)
 * are read one by one and their intervals merged by the caller.
 */
export function busyFromICal(text: string, window: Interval, opts: BusyOptions): Interval[] {
  const calendars = parseICal(text).filter((c) => c.name === "VCALENDAR");
  const zones = zonesFor(calendars, opts.timezone);
  const events = calendars.flatMap((c) => c.children.filter((e) => e.name === "VEVENT"));
  // Overrides of single occurrences (RECURRENCE-ID), by UID: the occurrence they replace is not counted.
  const overridden = new Map<string, Set<number>>();
  for (const e of events) {
    const rid = readStamp(oneOf(e, "RECURRENCE-ID"));
    const uid = oneOf(e, "UID")?.value ?? "";
    if (!rid || !uid) continue;
    let set = overridden.get(uid);
    if (!set) {
      set = new Set();
      overridden.set(uid, set);
    }
    set.add(placeStamp(rid, zones));
  }
  const out: Interval[] = [];
  for (const e of events) {
    const uid = oneOf(e, "UID")?.value ?? "";
    if (uid && opts.skipUid?.(uid)) continue;
    const status = (oneOf(e, "STATUS")?.value ?? "").toUpperCase();
    if (status === "CANCELLED") continue;
    const transp = (oneOf(e, "TRANSP")?.value ?? "").toUpperCase();
    if (transp === "TRANSPARENT") continue;
    const start = readStamp(oneOf(e, "DTSTART"));
    if (!start) continue;
    if (start.allDay && transp !== "OPAQUE") continue;
    const startMs = placeStamp(start, zones);
    const endStamp = readStamp(oneOf(e, "DTEND"));
    const durationProp = oneOf(e, "DURATION");
    let length: number;
    if (endStamp) length = placeStamp(endStamp, zones) - startMs;
    else if (durationProp) length = parseDuration(durationProp.value) ?? 0;
    else length = start.allDay ? 86_400_000 : 0;
    if (!(length > 0)) continue;
    const isOverride = oneOf(e, "RECURRENCE-ID") !== undefined;
    const rruleProp = oneOf(e, "RRULE");
    const starts: number[] = [];
    if (rruleProp && !isOverride) {
      const place = (w: WallTime) => placeStamp({ ...start, wall: w }, zones);
      const rule = parseRRule(rruleProp.value, (v) => {
        const until = parseStamp(v, {});
        if (!until) return null;
        // An UNTIL date includes that whole day; an UNTIL time with no zone is in the event's zone.
        if (until.allDay) return placeStamp(until, zones) + 86_400_000 - 1;
        return placeStamp(until.zone === "floating" ? { ...until, zone: start.zone } : until, zones);
      });
      if (rule)
        starts.push(...expandRRule(rule, start.wall, place, { after: window.start - length, before: window.end }));
      else starts.push(startMs);
      for (const rdate of allOf(e, "RDATE")) {
        for (const v of rdate.value.split(",")) {
          const s = parseStamp(v, rdate.params);
          if (s && !s.allDay) starts.push(placeStamp(s.zone === "floating" ? { ...s, zone: start.zone } : s, zones));
        }
      }
      const excluded = new Set<number>();
      for (const ex of allOf(e, "EXDATE")) {
        for (const v of ex.value.split(",")) {
          const s = parseStamp(v, ex.params);
          if (!s) continue;
          if (s.allDay && !start.allDay) continue;
          excluded.add(placeStamp(s.zone === "floating" && !s.allDay ? { ...s, zone: start.zone } : s, zones));
        }
      }
      const moved = overridden.get(uid);
      for (let i = starts.length - 1; i >= 0; i--) {
        const at = starts[i] as number;
        if (excluded.has(at) || moved?.has(at)) starts.splice(i, 1);
      }
    } else starts.push(startMs);
    for (const s of starts) {
      const end = s + length;
      if (end > window.start && s < window.end) out.push({ start: s, end });
    }
  }
  return mergeIntervals(out);
}

/* --- writing one event ----------------------------------------------------- */

/**
 * Text as iCalendar escapes it (RFC 5545 §3.3.11): backslash, semicolon, comma, and every line break
 * (CRLF, LF or a lone CR) as `\n`; any other control character goes, since a strict reader may take
 * one as the end of the line.
 */
export function escapeText(text: string): string {
  return (
    text
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

/** Folds a content line at 75 octets, never inside a character. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (size + n > limit) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

function utcStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export interface OwnEvent {
  readonly uid: string;
  readonly start: number;
  readonly end: number;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly itemId: string;
  readonly now: number;
}

/** The event this inbox writes for a confirmed booking, in UTC, marked busy and as ours. */
export function buildEvent(e: OwnEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Surfing Dog//Inbox//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${utcStamp(e.now)}`,
    `DTSTART:${utcStamp(e.start)}`,
    `DTEND:${utcStamp(e.end)}`,
    `SUMMARY:${escapeText(e.title)}`,
    `DESCRIPTION:${escapeText(e.description)}`,
    ...(e.url ? [`URL:${e.url}`] : []),
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    // Rising with every write, so a calendar app takes the newest as the event.
    `SEQUENCE:${Math.max(0, Math.floor(e.now / 1000) - 1_790_000_000)}`,
    `X-SURFINGDOG-ITEM:${e.itemId}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** The wall time of an instant in a zone, for tests and for reading back. */
export { wallTimeOf };
