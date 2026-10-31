import { and, eq, isNull, or } from "drizzle-orm";
import { audienceFor } from "../customer/audience";
import { copyFor } from "../customer/copy";
import { dayText, timeText, whenText } from "../customer/format";
import type { CustomerLang } from "../customer/lang";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { availabilityRules, services } from "../schema/tables";
import { WriteError } from "../write/errors";
import { bucketRange, bucketsFor, planClaims, readClaims, type SlotSpec } from "../write/slots";
import { dateLocaliser, isClosed, readClosures } from "./closures";

/**
 * Free slots for a service inside a window: opening hours from availability rules (a weekly
 * schedule in the business time zone, "09:00-18:00" style), minus what slot claims already hold,
 * and never a time that starts before `now` plus the minimum notice (`booking.minNoticeMin`): a
 * time that has passed, or that is too close to book online, is not offered.
 * Deterministic and cheap: at most 14 days, at most 200 slots returned.
 *
 * Hours nobody set are no hours: with no weekly hours saved, for the business or the service, no
 * time is offered. A service asked about for a price (`price.model` "quote") is never booked, so it
 * has no times at all: the customer asks for a price instead.
 */
export interface Slot {
  readonly startTime: string;
  readonly endTime: string;
  readonly available: number;
}

export type Weekly = Partial<
  Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", readonly (readonly [string, string])[]>
>;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** No hours: what a business or a service that set none is open. */
export const NO_HOURS: Weekly = {};

/**
 * The weekly hours a service is booked in: its own, else the business's, else none. Hours are never
 * made up: a business that saved none is open to no booking, whatever it lists.
 */
export function weeklyFor(
  rules: readonly { readonly serviceId: string | null; readonly weekly: unknown }[],
  serviceId: string,
): Weekly {
  return (rules.find((r) => r.serviceId === serviceId)?.weekly ??
    rules.find((r) => !r.serviceId)?.weekly ??
    NO_HOURS) as Weekly;
}

/** Whether a service is asked about for a price rather than booked (`price.model` "quote"). */
export function askedForAPrice(price: unknown): boolean {
  const p = typeof price === "string" ? safeJson(price) : price;
  return typeof p === "object" && p !== null && (p as { model?: unknown }).model === "quote";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The refusal for a booking of a service this business does not offer, or no longer does. */
export function unknownService(serviceId: string): WriteError {
  return new WriteError(
    "invalid_input",
    "This business offers no service with that id: read its services and book one of them. Nothing was written.",
    {
      fields: [{ path: "payload.reservationFor.serviceId", problem: "invalid", message: "no such service here" }],
      details: { reason: "unknown_service", service_id: serviceId },
    },
  );
}

/** The refusal for times or a booking of a service priced by quote: ask for a price instead. */
export function quoteNotBookable(serviceId: string): WriteError {
  return new WriteError(
    "invalid_input",
    "This service is asked about for a price, not booked: send a request for a price instead. Nothing was written.",
    {
      fields: [{ path: "service_id", problem: "invalid", message: "asked for a price, not booked" }],
      details: { reason: "quote_only", service_id: serviceId },
    },
  );
}

export async function findSlots(
  db: Db,
  input: {
    serviceId: string;
    from: string;
    to: string;
    timezone: string;
    limit?: number;
    /** Nothing that starts before this, plus the notice, is offered. */
    now: number;
    minNoticeMin: number;
    /** A booking looking for somewhere to move: its own places do not count as taken. */
    exceptItemId?: string | undefined;
    /** For a service whose places are people (a table): the party, which a slot must fit. */
    partySize?: number | undefined;
  },
): Promise<{ service: { id: string; name: string; durationMin: number }; slots: Slot[] }> {
  const [service] = await db.orm.select().from(services).where(eq(services.id, input.serviceId));
  if (!service?.active) {
    throw new WriteError("invalid_input", `unknown service ${input.serviceId}`, {
      fields: [{ path: "service_id", problem: "invalid", message: "unknown service" }],
    });
  }
  if (askedForAPrice(service.price)) throw quoteNotBookable(service.id);
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new WriteError("invalid_input", "to must be after from", {
      fields: [{ path: "to", problem: "invalid", message: "must be after from" }],
    });
  }
  if (to - from > 14 * 86_400_000) {
    throw new WriteError("invalid_input", "search at most 14 days at a time", {
      fields: [{ path: "to", problem: "invalid", message: "window too long" }],
    });
  }
  const rules = await db.orm
    .select()
    .from(availabilityRules)
    .where(
      and(
        eq(availabilityRules.kind, "open"),
        or(eq(availabilityRules.serviceId, service.id), isNull(availabilityRules.serviceId)),
      ),
    );
  const weekly = weeklyFor(rules, service.id);
  const closures = await readClosures(db, service.id);
  const localDate = dateLocaliser(input.timezone);
  // A service whose places are people (a table's covers, ADR-040): a slot is free for a party that fits.
  const units = service.capacityUnit === "people" ? Math.max(1, input.partySize ?? 1) : undefined;
  const spec: SlotSpec = { ...service, resourceKey: `service:${service.id}`, ...(units ? { units } : {}) };
  const step = service.granularityMin * 60_000;
  const duration = service.durationMin * 60_000;
  const local = localiser(input.timezone);
  const slots: Slot[] = [];
  const limit = input.limit ?? 200;
  // The first start worth looking at: inside the window, and not before the notice runs out.
  const earliest = Math.max(from, input.now + input.minNoticeMin * 60_000);
  const first = Math.ceil(earliest / step) * step;
  const serviceView = { id: service.id, name: service.name, durationMin: service.durationMin };
  if (first + duration > to) return { service: serviceView, slots };
  // One read of the claims across the whole window, then pure arithmetic per candidate.
  // The whole window in one read. bucketRange, not bucketsFor: this is a range to read, not a
  // booking to place, and the booking cap here made any window longer than a day fail.
  const allBuckets = bucketRange(
    { ...spec, bufferBeforeMin: 0, bufferAfterMin: 0 },
    new Date(first).toISOString(),
    new Date(Math.min(to + duration, first + 14 * 86_400_000 + duration)).toISOString(),
  );
  const taken = await readClaims(db, spec, allBuckets, input.exceptItemId ?? "");
  for (let start = first; start + duration <= to && slots.length < limit; start += step) {
    const end = start + duration;
    if (!withinOpening(local, weekly, start, end)) continue;
    if (closures.length > 0 && (isClosed(closures, localDate(start)) || isClosed(closures, localDate(end - 1))))
      continue;
    const buckets = bucketsFor(spec, new Date(start).toISOString(), new Date(end).toISOString());
    const plan = planClaims(spec, buckets, taken);
    if (!plan.ok) continue;
    const free = Math.min(...buckets.map((b) => spec.capacity - (taken.get(b)?.size ?? 0)));
    slots.push({ startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(), available: free });
  }
  return { service: serviceView, slots };
}

/**
 * Whether one time is one the business would offer for a service (`findSlots`, for a single
 * candidate of any length): a service that is booked (not asked about for a price), on its grid,
 * inside opening hours someone set, on a day it is open, and
 * free for its whole length — counting every claim but the item's own (`exceptItemId`), so a
 * booking can move to a time that overlaps where it is now.
 */
export async function slotOffered(
  db: Db,
  input: {
    readonly serviceId: string;
    readonly start: number;
    readonly end: number;
    readonly timezone: string;
    readonly exceptItemId: string;
    readonly partySize?: number | undefined;
  },
): Promise<boolean> {
  return (await slotFit(db, input)) === "offered";
}

/**
 * How one time fits the business (`slotOffered`, with why not): `offered`; `closed` when it is no time
 * the business takes bookings (outside its hours, on a day it is closed, a service it does not book);
 * `off_grid` when it is inside the hours but not one of the service's start times; `taken` when it is
 * inside its hours and no place is free; `no_hours` when nobody saved hours for it at all, so no time
 * is offered. For a service whose places are people (a table), free means free for the whole party.
 * The start times are counted, as `findSlots` counts them, from midnight UTC: in a time zone half an
 * hour off UTC an hourly service starts at half past the local hour.
 */
export async function slotFit(
  db: Db,
  input: {
    readonly serviceId: string;
    readonly start: number;
    readonly end: number;
    readonly timezone: string;
    readonly exceptItemId: string;
    readonly partySize?: number | undefined;
  },
): Promise<"offered" | "closed" | "off_grid" | "taken" | "no_hours"> {
  const [service] = await db.orm.select().from(services).where(eq(services.id, input.serviceId));
  if (!service?.active || !(input.end > input.start) || askedForAPrice(service.price)) return "closed";
  const rules = await db.orm
    .select()
    .from(availabilityRules)
    .where(
      and(
        eq(availabilityRules.kind, "open"),
        or(eq(availabilityRules.serviceId, service.id), isNull(availabilityRules.serviceId)),
      ),
    );
  const weekly = weeklyFor(rules, service.id);
  if (!Object.values(weekly).some((windows) => (windows ?? []).length > 0)) return "no_hours";
  if (!withinOpening(localiser(input.timezone), weekly, input.start, input.end)) return "closed";
  const closures = await readClosures(db, service.id);
  const localDate = dateLocaliser(input.timezone);
  if (
    closures.length > 0 &&
    (isClosed(closures, localDate(input.start)) || isClosed(closures, localDate(input.end - 1)))
  )
    return "closed";
  if (input.start % (service.granularityMin * 60_000) !== 0) return "off_grid";
  const units = service.capacityUnit === "people" ? Math.max(1, input.partySize ?? 1) : undefined;
  const spec: SlotSpec = { ...service, resourceKey: `service:${service.id}`, ...(units ? { units } : {}) };
  let buckets: number[];
  try {
    buckets = bucketsFor(spec, new Date(input.start).toISOString(), new Date(input.end).toISOString());
  } catch {
    return "closed";
  }
  return planClaims(spec, buckets, await readClaims(db, spec, buckets, input.exceptItemId)).ok ? "offered" : "taken";
}

/**
 * The free times nearest to `at`, before or after it, at most `count`, in order (ADR-044 §2): what
 * `check_availability` would offer, so the minimum notice holds. Up to half a day before it and a week
 * after it.
 */
export async function nearestFreeTimes(
  db: Db,
  input: {
    readonly serviceId: string;
    readonly at: number;
    readonly timezone: string;
    readonly now: number;
    readonly minNoticeMin: number;
    readonly partySize?: number | undefined;
    readonly count?: number | undefined;
  },
): Promise<Slot[]> {
  const count = input.count ?? 3;
  const earliest = input.now + input.minNoticeMin * 60_000;
  const search = async (from: number, to: number, limit: number): Promise<Slot[]> => {
    if (to <= from) return [];
    try {
      const r = await findSlots(db, {
        serviceId: input.serviceId,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        timezone: input.timezone,
        limit,
        now: input.now,
        minNoticeMin: input.minNoticeMin,
        ...(input.partySize !== undefined ? { partySize: input.partySize } : {}),
      });
      return r.slots;
    } catch {
      return [];
    }
  };
  const after = Math.max(input.at, earliest);
  const [later, earlier] = await Promise.all([
    search(after, after + 7 * 86_400_000, count),
    search(Math.max(earliest, input.at - 12 * 3_600_000), input.at + 12 * 3_600_000, 200),
  ]);
  const seen = new Set<string>();
  return [...earlier.filter((slot) => Date.parse(slot.startTime) < input.at), ...later]
    .filter((slot) => !seen.has(slot.startTime) && seen.add(slot.startTime))
    .sort((a, b) => Math.abs(Date.parse(a.startTime) - input.at) - Math.abs(Date.parse(b.startTime) - input.at))
    .slice(0, count)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/**
 * A customer's request for a time the business does not offer is refused before anything is
 * confirmed or written (ADR-044 §2): outside its hours, on a day it is closed, off the service's grid,
 * or with no place free (but a table, ADR-040), it would only land on the owner as work for a time
 * they never opened. The refusal names the nearest free times, in the customer's words. A time inside
 * the minimum notice that the business would otherwise offer is still taken, and waits for a person
 * (ADR-018); one that has started is the create's to refuse, as it always was. The owner's side books
 * any time it likes.
 */
export async function refuseTimeNotOffered(
  db: Db,
  input: {
    readonly serviceId: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly partySize?: number | undefined;
    readonly locale: string | null;
    readonly now: number;
  },
): Promise<void> {
  const start = Date.parse(input.startTime);
  const end = Date.parse(input.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start <= input.now) return;
  const audience = await audienceFor(db, { locale: input.locale });
  const fit = await slotFit(db, {
    serviceId: input.serviceId,
    start,
    end,
    timezone: audience.timezone,
    exceptItemId: "",
    partySize: input.partySize,
  });
  // Hours nobody set: no time is offered, and an agent is told no booking is taken here before it gets
  // this far (`refuseUnbookable`). A person who writes on a form is heard, and a person answers.
  if (fit === "offered" || fit === "no_hours") return;
  // A table past the covers set aside goes to a person, who may seat it from the room (ADR-040 §8):
  // only a time the restaurant is closed is refused.
  if (fit === "taken" && (await countsPeople(db, input.serviceId))) return;
  const free = await nearestFreeTimes(db, {
    serviceId: input.serviceId,
    at: start,
    timezone: audience.timezone,
    now: input.now,
    minNoticeMin: audience.minNoticeMin,
    partySize: input.partySize,
  });
  const message = copyFor(audience.lang).problems.timeNotOffered({
    when: whenText(new Date(start).toISOString(), audience.timezone, audience.lang),
    free: timesText(free, audience),
    why: fit,
  });
  throw new WriteError("invalid_input", message, {
    fields: [{ path: "payload.startTime", problem: "invalid", message }],
    details: {
      reason: fit === "taken" ? "time_not_free" : fit === "off_grid" ? "not_a_start_time" : "outside_hours",
      free_times: free.map((slot) => ({ start_time: slot.startTime, end_time: slot.endTime })),
    },
  });
}

async function countsPeople(db: Db, serviceId: string): Promise<boolean> {
  const [row] = await db.orm.select({ unit: services.capacityUnit }).from(services).where(eq(services.id, serviceId));
  return row?.unit === "people";
}

/** `Saturday, 1 November: 09:00, 09:30; Monday, 3 November: 09:00`, in the business's time zone. */
function timesText(slots: readonly Slot[], audience: { timezone: string; lang: CustomerLang }): string {
  const days: { day: string; times: string[] }[] = [];
  for (const slot of slots) {
    const day = dayText(slot.startTime, audience.timezone, audience.lang);
    const last = days[days.length - 1];
    const time = timeText(slot.startTime, audience.timezone, audience.lang);
    if (last?.day === day) last.times.push(time);
    else days.push({ day, times: [time] });
  }
  return days.map((d) => `${d.day}: ${d.times.join(", ")}`).join("; ");
}

/**
 * How a booking request sits in the business's calendar, for the owner deciding on it (ADR-028): free
 * (the time is one the business would offer, counting every claim and busy time but its own), or not,
 * and then the booking it clashes with when there is one. Null for anything but an open request.
 */
export interface CalendarFit {
  readonly free: boolean;
  /** The booking that holds the time, when one does: its customer's name (null when unknown) and start. */
  readonly clash: { readonly name: string | null; readonly startTime: string } | null;
}

const ASKS_FOR_A_TIME = new Set(["requested", "needs_info"]);

export async function calendarFit(db: Db, item: Item, timezone: string): Promise<CalendarFit | null> {
  if (item.type !== "booking" || item.closedAt !== null || !ASKS_FOR_A_TIME.has(item.state)) return null;
  const start = Date.parse(item.payload.startTime);
  const end = Date.parse(item.payload.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const serviceId = item.payload.reservationFor.serviceId;
  const free = await slotOffered(db, { serviceId, start, end, timezone, exceptItemId: item.id });
  if (free) return { free: true, clash: null };
  const [service] = await db.orm.select().from(services).where(eq(services.id, serviceId));
  if (!service) return { free: false, clash: null };
  let buckets: number[];
  try {
    buckets = bucketsFor(
      { ...service, resourceKey: `service:${service.id}` },
      item.payload.startTime,
      item.payload.endTime,
    );
  } catch {
    return { free: false, clash: null };
  }
  const { rows } = await db.client.query({
    sql: `SELECT p.display_name, i.start_at FROM slot_claims c
            JOIN items i ON i.id = c.item_id JOIN parties p ON p.id = i.party_id
           WHERE c.resource_key = ? AND c.bucket_start >= ? AND c.bucket_start <= ? AND c.item_id <> ?
             AND i.closed_at IS NULL
           ORDER BY c.bucket_start LIMIT 1`,
    params: [`service:${service.id}`, buckets[0] ?? 0, buckets[buckets.length - 1] ?? 0, item.id],
    method: "all",
  });
  const r = rows[0] as [string | null, string | null] | undefined;
  return { free: false, clash: r?.[1] ? { name: r[0]?.trim() || null, startTime: r[1] } : null };
}

export type Localiser = (ms: number) => { day: (typeof DAYS)[number]; minutes: number };

export function localiser(timezone: string): Localiser {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return (ms) => {
    const parts = fmt.formatToParts(new Date(ms));
    const weekday =
      parts
        .find((p) => p.type === "weekday")
        ?.value.toLowerCase()
        .slice(0, 3) ?? "mon";
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return {
      day: (DAYS.includes(weekday as (typeof DAYS)[number]) ? weekday : "mon") as (typeof DAYS)[number],
      minutes: hour * 60 + minute,
    };
  };
}

/**
 * Whether [start, end) is inside the opening hours. Within one day, inside one window. Across
 * midnight, only where the business stays open through it: a window to 24:00 on the first day and
 * one from 00:00 on the next, as a business open all the time has every night.
 */
export function withinOpening(local: Localiser, weekly: Weekly, start: number, end: number): boolean {
  const s = local(start);
  const e = local(end - 1);
  if (s.day === e.day) {
    const windows = weekly[s.day] ?? [];
    return windows.some(([open, close]) => s.minutes >= toMinutes(open) && e.minutes + 1 <= toMinutes(close));
  }
  if (DAYS[(DAYS.indexOf(s.day) + 1) % DAYS.length] !== e.day) return false;
  const untilMidnight = (weekly[s.day] ?? []).some(
    ([open, close]) => s.minutes >= toMinutes(open) && toMinutes(close) === 24 * 60,
  );
  const fromMidnight = (weekly[e.day] ?? []).some(
    ([open, close]) => toMinutes(open) === 0 && e.minutes + 1 <= toMinutes(close),
  );
  return untilMidnight && fromMidnight;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
