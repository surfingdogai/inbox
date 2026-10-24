import type { Db } from "../db";
import type { Item } from "../domain/types";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";

/**
 * A booking the salon's own system holds (ADR-035, ADR-032 §4): its service came from a booking system
 * connected here that writes bookings (Phorest). It is promised only once that system took it, so
 * nothing confirms it before: not a rule, not the owner's AI, not a key, not a customer's yes to a time
 * we proposed (a person takes that yes), and not a person while the system's answer is on its way. The
 * system's own answer confirms it (`write_first:<connection>`); a person's confirm is written there first
 * by the owner's door, and stands on that answer.
 */
export interface SystemHold {
  readonly connectorId: string;
  /** The connection's name, as the owner knows it. */
  readonly title: string;
  /** What the system answered the last write for this booking; null: nothing was written yet. */
  readonly outcome: string | null;
}

export async function systemHold(db: Db, item: Pick<Item, "id" | "type" | "payload">): Promise<SystemHold | null> {
  if (item.type !== "booking") return null;
  const serviceId = (item.payload as { reservationFor?: { serviceId?: unknown } }).reservationFor?.serviceId;
  if (typeof serviceId !== "string") return null;
  const { rows } = await db.client.query({
    sql: `SELECT c.id, c.name FROM services s JOIN connectors c ON c.kind = s.source
           WHERE s.id = ? AND s.source <> 'builtin' AND s.external_id IS NOT NULL AND c.status <> 'disabled'
             AND COALESCE(json_extract(c.config_public, '$.bookingsOn'), 1) = 1
             AND json_extract(c.config_public, '$.disconnectingAt') IS NULL
           ORDER BY c.created_at, c.id LIMIT 1`,
    params: [serviceId],
    method: "all",
  });
  const c = rows[0];
  if (!c) return null;
  const connectorId = String(c[0]);
  const { rows: last } = await db.client.query({
    sql: `SELECT outcome FROM connector_writes WHERE connector_id = ? AND item_id = ? AND op = 'reserve'
           ORDER BY attempt DESC LIMIT 1`,
    params: [connectorId, item.id],
    method: "all",
  });
  return { connectorId, title: String(c[1] ?? "Your booking system"), outcome: last[0] ? String(last[0][0]) : null };
}

/** Whether the system's own answer is confirming the booking: the caller `bookFirstInSystem` and its resolver use. */
export function isWrittenFirst(caller: Caller): boolean {
  return (
    caller.actor.kind === "rule" && caller.actor.channel === "connector" && caller.actor.id.startsWith("write_first:")
  );
}

/** Whether the system's answer to a booking is still on its way. */
export function awaitingSystem(hold: SystemHold): boolean {
  return hold.outcome === "pending" || hold.outcome === "unknown";
}

/** The refusal for confirming a booking the salon's own system has not taken. */
export function systemFirstRefusal(hold: SystemHold, opts: { readonly forOwner: boolean }): WriteError {
  if (awaitingSystem(hold)) {
    return new WriteError(
      "guard_failed",
      `${hold.title} has not answered for this booking yet. Nothing is promised until it does: try again in a minute.`,
      { details: { guard: "system_first", outcome: hold.outcome } },
    );
  }
  return new WriteError(
    "guard_failed",
    opts.forOwner
      ? `${hold.title} keeps this salon's diary: a booking is confirmed here once ${hold.title} took it. Tell the owner in a note (reply with internal: true) what you would do.`
      : `${hold.title} keeps this salon's diary: the salon confirms this time itself.`,
    { details: { guard: "system_first", outcome: hold.outcome, ...(opts.forOwner ? { draft_for_owner: true } : {}) } },
  );
}
