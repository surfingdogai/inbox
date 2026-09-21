import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db";
import { availabilityRules } from "../schema/tables";

/**
 * Closures: whole days the business (or one service) does not take bookings — holidays, a
 * closed week, a fair. Stored as `availability_rules` rows of kind "closed" whose JSON column
 * holds `{ from, to, reason }` as local calendar dates (YYYY-MM-DD in the business time zone),
 * so no time-zone arithmetic ever touches them.
 */
export interface Closure {
  readonly from: string;
  readonly to: string;
  readonly reason?: string | undefined;
}

export async function readClosures(db: Db, serviceId?: string): Promise<Closure[]> {
  const scope = serviceId
    ? or(isNull(availabilityRules.serviceId), eq(availabilityRules.serviceId, serviceId))
    : isNull(availabilityRules.serviceId);
  const rows = await db.orm
    .select({ weekly: availabilityRules.weekly })
    .from(availabilityRules)
    .where(and(eq(availabilityRules.kind, "closed"), scope));
  return rows
    .map((r) => r.weekly as Closure | null)
    .filter((c): c is Closure => Boolean(c && typeof c.from === "string" && typeof c.to === "string"));
}

export function isClosed(closures: readonly Closure[], localDate: string): boolean {
  return closures.some((c) => localDate >= c.from && localDate <= c.to);
}

/** Local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function dateLocaliser(timezone: string): (ms: number) => string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (ms) => fmt.format(new Date(ms));
}
