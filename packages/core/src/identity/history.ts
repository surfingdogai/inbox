import type { Db } from "../db";

/**
 * The business's own history with a customer (ADR-017 §8.2), a first-class signal beside any
 * network's: over every party the same person is linked to here, every party merged into it, and
 * every party sharing one of its verified contacts. Local rows only, so the rules never wait on a
 * network.
 */
export interface CustomerHistory {
  /** Items of this customer's before this one (any type). */
  readonly items: number;
  readonly completed: number;
  readonly paid: number;
  readonly no_shows: number;
  readonly late_cancellations: number;
  readonly payment_failed: number;
  readonly charged_back: number;
  /** The largest order paid, in minor units; 0 without one. */
  readonly largest_paid: number;
  /** Open bookings, this one included. */
  readonly open_bookings: number;
  /** Unix ms of the first and the latest of the earlier items; null without any. */
  readonly first_seen: number | null;
  readonly last_seen: number | null;
}

export const EMPTY_HISTORY: CustomerHistory = {
  items: 0,
  completed: 0,
  paid: 0,
  no_shows: 0,
  late_cancellations: 0,
  payment_failed: 0,
  charged_back: 0,
  largest_paid: 0,
  open_bookings: 0,
  first_seen: null,
  last_seen: null,
};

const OPEN_BOOKING_STATES = ["requested", "needs_info", "proposed", "confirmed"];

/** Every party that is this customer here: itself, those merged into it, those sharing a person or a verified contact. */
export async function partySet(db: Db, partyId: string): Promise<string[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ? UNION
          SELECT id FROM parties WHERE merged_into = ?
          UNION
          SELECT l2.party_id FROM person_links l1 JOIN person_links l2 ON l2.network = l1.network AND l2.ppid = l1.ppid
           WHERE l1.party_id = ?
          UNION
          SELECT c2.party_id FROM party_contacts c1
            JOIN party_contacts c2 ON c2.kind = c1.kind AND c2.value = c1.value AND c2.verified_at IS NOT NULL
           WHERE c1.party_id = ? AND c1.verified_at IS NOT NULL`,
    params: [partyId, partyId, partyId, partyId],
    method: "all",
  });
  return [...new Set(rows.map((r) => String(r[0])))].slice(0, 50);
}

export async function customerHistory(db: Db, partyId: string, currentItemId?: string): Promise<CustomerHistory> {
  const parties = await partySet(db, partyId);
  const marks = parties.map(() => "?").join(", ");
  const except = currentItemId ?? "";
  const { rows } = await db.client.query({
    sql: `SELECT
            SUM(CASE WHEN i.id <> ? THEN 1 ELSE 0 END),
            SUM(CASE WHEN i.id <> ? AND ((i.type = 'booking' AND i.state = 'completed')
                                       OR (i.type = 'order' AND i.state IN ('fulfilled', 'completed'))) THEN 1 ELSE 0 END),
            SUM(CASE WHEN i.id <> ? AND i.type = 'booking' AND i.state = 'no_show' THEN 1 ELSE 0 END),
            SUM(CASE WHEN i.type = 'booking' AND i.state IN (${OPEN_BOOKING_STATES.map(() => "?").join(", ")}) THEN 1 ELSE 0 END),
            MIN(CASE WHEN i.id <> ? THEN i.created_at END),
            MAX(CASE WHEN i.id <> ? THEN i.created_at END)
          FROM items i WHERE i.party_id IN (${marks}) AND COALESCE(i.sandbox, 0) = 0`,
    params: [except, except, except, ...OPEN_BOOKING_STATES, except, except, ...parties],
    method: "all",
  });
  const r = rows[0] ?? [];
  const events = await db.client.query({
    sql: `SELECT e.event, COUNT(DISTINCT e.item_id) FROM item_events e JOIN items i ON i.id = e.item_id
           WHERE i.party_id IN (${marks}) AND i.id <> ? AND COALESCE(i.sandbox, 0) = 0
             AND e.event IN ('record_payment', 'cancel_late', 'payment_failed', 'charge_back', 'record_charge_back')
           GROUP BY e.event`,
    params: [...parties, except],
    method: "all",
  });
  const byEvent = new Map(events.rows.map((e) => [String(e[0]), Number(e[1] ?? 0)]));
  const paid = await db.client.query({
    sql: `SELECT MAX(COALESCE(json_extract(i.payload, '$.paidAmount.value'), i.amount_minor, 0))
            FROM items i WHERE i.party_id IN (${marks}) AND i.id <> ? AND i.type = 'order' AND COALESCE(i.sandbox, 0) = 0
             AND EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.event = 'record_payment')
             AND NOT EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.event IN ('charge_back', 'record_charge_back'))`,
    params: [...parties, except],
    method: "all",
  });
  const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const t = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    items: n(r[0]),
    completed: n(r[1]),
    no_shows: n(r[2]),
    open_bookings: n(r[3]),
    first_seen: t(r[4]),
    last_seen: t(r[5]),
    paid: byEvent.get("record_payment") ?? 0,
    late_cancellations: byEvent.get("cancel_late") ?? 0,
    payment_failed: byEvent.get("payment_failed") ?? 0,
    charged_back: (byEvent.get("charge_back") ?? 0) + (byEvent.get("record_charge_back") ?? 0),
    largest_paid: n(paid.rows[0]?.[0]),
  };
}
