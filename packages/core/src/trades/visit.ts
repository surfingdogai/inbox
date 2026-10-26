import type { Db } from "../db";

/**
 * A site visit tied to its request for a price (ADR-039 §4): the booking names the request it is for
 * (`linked_item_id`), and the request names its visit (`job.visitBookingId`), so the owner sees one
 * from the other. The visit is booked like any booking, on request unless the owner's rules confirm
 * it; this only ties the two together, once the booking is made.
 */
export async function linkVisit(db: Db, requestId: string, bookingId: string, now: number): Promise<void> {
  await db.batch([
    {
      sql: "UPDATE items SET linked_item_id = ?, updated_at = ? WHERE id = ? AND type = 'booking' AND linked_item_id IS NULL",
      params: [requestId, now, bookingId],
      method: "run",
    },
    {
      sql: `UPDATE items SET payload = json_set(payload, '$.job',
                     json(json_set(COALESCE(json_extract(payload, '$.job'), '{}'), '$.visitBookingId', ?))),
                   version = version + 1, updated_at = ?
             WHERE id = ? AND type = 'quote_request'`,
      params: [bookingId, now, requestId],
      method: "run",
    },
  ]);
}
