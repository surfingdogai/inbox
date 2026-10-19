import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db";
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
  const spec: SlotSpec = { ...service, resourceKey: `service:${service.id}` };
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
  },
): Promise<boolean> {
  const [service] = await db.orm.select().from(services).where(eq(services.id, input.serviceId));
  if (!service?.active || !(input.end > input.start) || askedForAPrice(service.price)) return false;
  if (input.start % (service.granularityMin * 60_000) !== 0) return false;
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
  if (!withinOpening(localiser(input.timezone), weekly, input.start, input.end)) return false;
  const closures = await readClosures(db, service.id);
  const localDate = dateLocaliser(input.timezone);
  if (
    closures.length > 0 &&
    (isClosed(closures, localDate(input.start)) || isClosed(closures, localDate(input.end - 1)))
  )
    return false;
  const spec: SlotSpec = { ...service, resourceKey: `service:${service.id}` };
  let buckets: number[];
  try {
    buckets = bucketsFor(spec, new Date(input.start).toISOString(), new Date(input.end).toISOString());
  } catch {
    return false;
  }
  return planClaims(spec, buckets, await readClaims(db, spec, buckets, input.exceptItemId)).ok;
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
