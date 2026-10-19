/**
 * Wall-clock times in a named zone, through `Intl` alone (no zone database to ship): an iCalendar
 * `DTSTART;TZID=Europe/Lisbon:20261020T100000` is ten in the morning in Lisbon, whatever the offset
 * that day. Calendars also name zones in their own ways (Outlook's "W. Europe Standard Time", a
 * vendor prefix before an IANA name): those are mapped to the zone they mean.
 */

export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

export function isZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The wall time an instant shows in a zone. */
export function wallTimeOf(ms: number, zone: string): WallTime {
  const parts = formatter(zone).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetAt(ms: number, zone: string): number {
  const w = wallTimeOf(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall time is in a zone. In a spring-forward gap the time is moved past the gap, as
 * calendars do; in the repeated hour of a fall-back, the first of the two is taken.
 */
export function zonedToUtc(w: WallTime, zone: string): number {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const first = asUtc - offsetAt(asUtc, zone);
  const second = asUtc - offsetAt(first, zone);
  if (first === second) return first;
  // Two candidates: take the earlier one that shows this wall time, or the later in a gap.
  const shows = (ms: number) => {
    const s = wallTimeOf(ms, zone);
    return s.hour === w.hour && s.minute === w.minute && s.day === w.day;
  };
  if (shows(Math.min(first, second))) return Math.min(first, second);
  if (shows(Math.max(first, second))) return Math.max(first, second);
  return Math.max(first, second);
}

/** Outlook and Exchange name zones their own way; these are the ones small businesses meet. */
const WINDOWS: Readonly<Record<string, string>> = {
  UTC: "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Turkey Standard Time": "Europe/Istanbul",
  "Israel Standard Time": "Asia/Jerusalem",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Egypt Standard Time": "Africa/Cairo",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "E. Africa Standard Time": "Africa/Nairobi",
  "Morocco Standard Time": "Africa/Casablanca",
  "Arabian Standard Time": "Asia/Dubai",
  "Arab Standard Time": "Asia/Riyadh",
  "Iran Standard Time": "Asia/Tehran",
  "Pakistan Standard Time": "Asia/Karachi",
  "India Standard Time": "Asia/Kolkata",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Singapore Standard Time": "Asia/Singapore",
  "China Standard Time": "Asia/Shanghai",
  "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "W. Australia Standard Time": "Australia/Perth",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Central Standard Time": "America/Chicago",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Eastern Standard Time": "America/New_York",
  "SA Pacific Standard Time": "America/Bogota",
  "Atlantic Standard Time": "America/Halifax",
  "Venezuela Standard Time": "America/Caracas",
  "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago",
  "Argentina Standard Time": "America/Buenos_Aires",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Newfoundland Standard Time": "America/St_Johns",
};

/**
 * The IANA zone a calendar's TZID means, or null. Tried in turn: the name itself, Outlook's names,
 * and the last two path segments of a vendor-prefixed name ("/mozilla.org/20050126_1/Europe/Paris").
 */
export function resolveZone(tzid: string): string | null {
  const name = tzid.trim().replace(/^"|"$/g, "");
  if (!name) return null;
  if (isZone(name)) return name;
  const windows = WINDOWS[name];
  if (windows) return windows;
  const parts = name.split("/").filter(Boolean);
  for (let n = Math.min(3, parts.length); n >= 2; n--) {
    const tail = parts.slice(-n).join("/");
    if (isZone(tail)) return tail;
  }
  return null;
}
