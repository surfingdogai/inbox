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
export const DEFAULT_WEEKLY: Weekly = {
  mon: [["09:00", "18:00"]],
  tue: [["09:00", "18:00"]],
  wed: [["09:00", "18:00"]],
  thu: [["09:00", "18:00"]],
  fri: [["09:00", "18:00"]],
};

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
  },
): Promise<{ service: { id: string; name: string; durationMin: number }; slots: Slot[] }> {
  const [service] = await db.orm.select().from(services).where(eq(services.id, input.serviceId));
  if (!service?.active) {
    throw new WriteError("invalid_input", `unknown service ${input.serviceId}`, {
      fields: [{ path: "service_id", problem: "invalid", message: "unknown service" }],
    });
  }
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
  const weekly = (rules.find((r) => r.serviceId === service.id)?.weekly ??
    rules[0]?.weekly ??
    DEFAULT_WEEKLY) as Weekly;
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
  const taken = await readClaims(db, spec.resourceKey, allBuckets, "");
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

export function withinOpening(local: Localiser, weekly: Weekly, start: number, end: number): boolean {
  const s = local(start);
  const e = local(end - 1);
  if (s.day !== e.day) return false;
  const windows = weekly[s.day] ?? [];
  return windows.some(([open, close]) => s.minutes >= toMinutes(open) && e.minutes + 1 <= toMinutes(close));
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
