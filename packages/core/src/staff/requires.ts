import type { Db } from "../db";
import type { Item } from "../domain/types";
import { WriteError } from "../write/errors";

/**
 * What must come first (ADR-035): a colour after a patch test, a treatment after a consultation, within
 * so many days before. It is checked only against this business's own bookings, and only for a customer
 * the inbox already knows for sure (the person behind their access token, or an agent key bound to them):
 * a name or an address someone types proves nothing, so it is never looked up, and the answer to a
 * stranger is the same whatever anyone's bookings hold. Nobody is ever shown anyone's bookings.
 *
 * - `met`: a patch test (or whatever comes first) of theirs, completed or confirmed, starts within the
 *   days the owner set and at least `atLeastHours` before this booking (48 by default: a patch test is
 *   read two days on, so one minutes before the colour is no patch test at all).
 * - `unmet`: the inbox knows them for sure and finds none: they are asked to book it first.
 * - `unknown`: the inbox cannot know who they are, or theirs is still a request nobody confirmed: the
 *   booking waits for a person, who checks.
 */
export type RequiresAnswer = "met" | "unmet" | "unknown";

export interface Requires {
  readonly serviceId: string;
  readonly withinDays: number;
  /** How long before at the least; absent: `REQUIRES_LEAD_HOURS`. */
  readonly atLeastHours?: number | undefined;
}

/** How long before what comes first must be, unless the owner said otherwise: a patch test's 48 hours. */
export const REQUIRES_LEAD_HOURS = 48;

/** The lead a requirement asks: its own, else two days. */
export function leadHours(r: Requires): number {
  return r.atLeastHours ?? REQUIRES_LEAD_HOURS;
}

export async function requiresMet(
  db: Db,
  input: { readonly partyId: string | undefined; readonly requires: Requires; readonly start: number },
): Promise<RequiresAnswer> {
  if (!input.partyId) return "unknown";
  const earliest = input.start - input.requires.withinDays * 86_400_000;
  const latest = input.start - leadHours(input.requires) * 3_600_000;
  // The party and every party merged into it: one customer, however they came. Start times are read
  // in code: ISO strings with offsets do not compare as text.
  const { rows: starts } = await db.client.query({
    sql: `SELECT json_extract(payload, '$.startTime'), state FROM items
           WHERE type = 'booking' AND state IN ('completed', 'confirmed', 'requested', 'needs_info', 'proposed')
             AND COALESCE(sandbox, 0) = 0
             AND (party_id = ? OR party_id IN (SELECT id FROM parties WHERE merged_into = ?))
             AND json_extract(payload, '$.reservationFor.serviceId') = ?
           LIMIT 200`,
    params: [input.partyId, input.partyId, input.requires.serviceId],
    method: "all",
  });
  const inTime = starts.filter((r) => {
    const at = Date.parse(String(r[0] ?? ""));
    return Number.isFinite(at) && at <= latest && at >= earliest;
  });
  if (inTime.some((r) => r[1] === "completed" || r[1] === "confirmed")) return "met";
  // Asked for in time, not confirmed yet: theirs to have, a person's to check.
  return inTime.length > 0 ? "unknown" : "unmet";
}

/**
 * No rule, and no automation, confirms a booking whose create waited for a person to check what comes
 * first (`checkFirst` on its create), nor proposes another time for it, which the customer's yes would
 * confirm: that person confirms it, or proposes the first service.
 */
export async function heldForCheck(db: Db, item: Pick<Item, "id" | "type">, event: string): Promise<boolean> {
  if (item.type !== "booking" || (event !== "confirm" && event !== "propose")) return false;
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM item_events WHERE item_id = ? AND seq = 1 AND json_extract(meta, '$.checkFirst') = 1 LIMIT 1",
    params: [item.id],
    method: "all",
  });
  return rows.length > 0;
}

export function checkFirstRefusal(): WriteError {
  return new WriteError(
    "guard_failed",
    "A person checks this booking first: its service needs another one before it. Tell the owner in a note (reply with internal: true) what you would do.",
    { details: { guard: "check_first", draft_for_owner: true } },
  );
}
