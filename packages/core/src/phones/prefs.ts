import { z } from "zod";
import type { Item } from "../domain/types";

/**
 * What a phone is told about, and when (ADR-028): one switch per kind of request, quiet hours that
 * hold notifications until morning, and whether customer names and words may reach the lock screen.
 * Kept per phone, set on the phone (Settings → Notifications), so two people's phones differ.
 */
export const PUSH_KINDS = ["booking", "order", "quote", "message", "handled"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time of day, HH:MM");

export const notifyPrefsSchema = z.object({
  kinds: z
    .object({
      booking: z.boolean().default(true),
      order: z.boolean().default(true),
      quote: z.boolean().default(true),
      message: z.boolean().default(true),
      /** What the business's rules answered on their own: off unless asked for. */
      handled: z.boolean().default(false),
    })
    .default({ booking: true, order: true, quote: true, message: true, handled: false }),
  quiet: z
    .object({ on: z.boolean().default(false), from: clock.default("21:00"), to: clock.default("08:00") })
    .default({ on: false, from: "21:00", to: "08:00" }),
  /** Customer names and their words in the notification. Off, neither ever leaves the inbox. */
  details: z.boolean().default(false),
  /** The phone's time zone, for quiet hours. Absent, the business's. */
  tz: z.string().max(64).optional(),
});
export type NotifyPrefs = z.infer<typeof notifyPrefsSchema>;

export const DEFAULT_PREFS: NotifyPrefs = notifyPrefsSchema.parse({});

/** Prefs as stored, read leniently: a row written by an older release still reads. */
export function readPrefs(json: string | null | undefined): NotifyPrefs {
  try {
    const parsed = notifyPrefsSchema.safeParse(JSON.parse(json || "{}"));
    return parsed.success ? parsed.data : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * The kind a phone's switches know an item by: `handled` when the owner has nothing to do on it
 * (a rule answered it), else its own. Refunds are about money, as orders are; a stay is a booking of
 * rooms (ADR-037), so the Bookings switch governs it.
 */
export function pushKindOf(item: Pick<Item, "type">, awaitsOwner: boolean): PushKind {
  if (!awaitsOwner) return "handled";
  switch (item.type) {
    case "booking":
    case "stay":
      return "booking";
    case "order":
    case "refund":
      return "order";
    case "quote_request":
      return "quote";
    default:
      return "message";
  }
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** The wall-clock time (minutes since midnight) and date parts at `now` in `tz`. */
function localParts(now: number, tz: string): { minutes: number; seconds: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now));
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now));
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { minutes: get("hour") * 60 + get("minute"), seconds: get("second") };
}

/**
 * When a notification may go out: `now` outside quiet hours, else the moment they end (to the
 * minute, on the phone's clock). Quiet hours may cross midnight (21:00 to 08:00) or not (13:00 to
 * 14:00); from equal to to means none.
 */
export function deliverAt(prefs: NotifyPrefs, now: number, fallbackTz: string): number {
  if (!prefs.quiet.on) return now;
  const from = minutesOf(prefs.quiet.from);
  const to = minutesOf(prefs.quiet.to);
  if (from === to) return now;
  const { minutes, seconds } = localParts(now, prefs.tz || fallbackTz);
  const inside = from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  if (!inside) return now;
  const wait = (to - minutes + 1440) % 1440;
  // To the start of the minute quiet hours end. A clock change in between moves it by the hour at
  // most, once a year: a held notification arriving an hour early or late is acceptable.
  return now + wait * 60_000 - seconds * 1000 - (now % 1000);
}
