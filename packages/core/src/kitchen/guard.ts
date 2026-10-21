import type { Db } from "../db";
import type { Item } from "../domain/types";
import { WriteError } from "../write/errors";

/**
 * What only a person at the business says yes to (ADR-036): an order the kitchen marked as not instant
 * (an allergen nobody confirmed, more than was set aside, made to order, a kitchen that accepts each
 * order by hand), and a table booking at a service that keeps no covers aside for direct bookings.
 * Automation drafts for the owner instead: it never accepts or confirms them.
 */
export async function assertKitchenClears(db: Db, item: Item, event: string): Promise<void> {
  if (item.type === "order" && event === "accept") {
    const mark = item.payload.kitchen;
    if (mark && !mark.instant) {
      const allergens = mark.hold.includes("allergens_unconfirmed");
      throw new WriteError(
        "guard_failed",
        allergens
          ? "This order has a dish whose allergens nobody at the business confirmed, so only a person can accept it. Tell the owner in a note (reply with internal: true) what you would do."
          : "This order waits for a person (made to order, more than was set aside, or the kitchen accepts each order by hand). Tell the owner in a note (reply with internal: true) what you would do.",
        { details: { guard: "kitchen", hold: mark.hold, draft_for_owner: true } },
      );
    }
  }
  if (item.type === "booking" && event === "confirm") {
    const { rows } = await db.client.query({
      sql: "SELECT capacity_unit, table_rules FROM services WHERE id = ?",
      params: [item.payload.reservationFor.serviceId],
      method: "all",
    });
    const r = rows[0];
    if (r && String(r[0]) === "people") {
      const rules = parse(r[1]) as { setAside?: unknown } | null;
      if (typeof rules?.setAside !== "number") {
        throw new WriteError(
          "guard_failed",
          "No covers are set aside for direct bookings, so a person confirms each table. Tell the owner in a note (reply with internal: true) what you would do.",
          { details: { guard: "tables", draft_for_owner: true } },
        );
      }
    }
  }
}

function parse(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}
