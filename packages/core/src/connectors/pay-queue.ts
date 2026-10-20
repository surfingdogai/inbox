import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { isMoneyCurrency } from "../util/locale";
import { jobStatement } from "../write/common";

/**
 * What the write path needs of pay links (ADR-023), apart from the rest so the write path and the
 * payments side do not import each other: whether any payment connection takes orders, whether an
 * order has a live link, and the job that brings an order's link in step with it.
 */

export const PAY_LINK_KIND = "pay_link";
export const PAY_NOTICE_KIND = "pay_notice";
/** A payment platform being disconnected: its links switched off, a few at a time, then the connection gone. */
export const PAY_CLOSE_KIND = "pay_close";

/**
 * How long a customer's email waits after an order is accepted (or a payment failed) while a link is
 * on its way, so the customer gets one email with the link in it rather than two.
 */
export const PAY_LINK_GRACE_MS = 20_000;

/** A payment connection that makes links: not paused, pay links on, and not being disconnected. */
const USABLE = `kind <> 'feed' AND status <> 'disabled' AND json_extract(config_public, '$.payOn') = 1
  AND json_extract(config_public, '$.disconnectingAt') IS NULL`;

/**
 * Whether a payment connection takes this inbox's orders: any connection that makes links. Read by
 * the write path, so an inbox with none queues nothing.
 */
export async function hasPayLinks(db: Db): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM connectors WHERE ${USABLE} LIMIT 1`,
    params: [],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * What this inbox can take from a guest or customer now, by the business's own payment platform: money
 * through a link, and a card saved to hold a booking. With neither, nothing is ever asked for now: it is
 * paid at the place, and no promise waits on a payment nobody can make.
 */
export async function payCollection(db: Db): Promise<{ readonly links: boolean; readonly cards: boolean }> {
  const { rows } = await db.client.query({
    sql: `SELECT COUNT(*), COALESCE(SUM(json_extract(config_public, '$.guarantees') = 1), 0) FROM connectors WHERE ${USABLE}`,
    params: [],
    method: "all",
  });
  return { links: Number(rows[0]?.[0] ?? 0) > 0, cards: Number(rows[0]?.[1] ?? 0) > 0 };
}

/**
 * Whether a link is on its way for an order as it stands after an event, by the rules the payments
 * side makes one by (`PaymentLinks.ensure`): a connection of the order's mode makes links, the order
 * comes to something in a currency whose minor unit is known (ADR-032), no change to it waits, it names no link of
 * the owner's own, and it was accepted once that connection was there (or has a link of ours). The
 * customer's email waits for it only then.
 */
export async function linkComing(
  db: Db,
  order: { readonly id: string; readonly payload: Readonly<Record<string, unknown>>; readonly sandbox: boolean },
  now: number,
  /** A person asks for the payment now, without a link of their own: the connection is for the order then. */
  asked = false,
): Promise<boolean> {
  const p = order.payload as {
    totalPrice?: { value?: unknown; currency?: unknown };
    paymentUrl?: unknown;
    change?: unknown;
  };
  const value = Number(p.totalPrice?.value ?? 0);
  const currency = String(p.totalPrice?.currency ?? "").toUpperCase();
  if (!Number.isInteger(value) || value <= 0 || !isMoneyCurrency(currency)) return false;
  if (p.change !== undefined && p.change !== null) return false;
  const url = typeof p.paymentUrl === "string" ? p.paymentUrl : null;
  const { rows } = await db.client.query({
    sql: `SELECT MIN(created_at),
                 (SELECT MIN(created_at) FROM item_events WHERE item_id = ? AND to_state = 'accepted'),
                 (SELECT COUNT(*) FROM connector_payments WHERE item_id = ?),
                 (SELECT COUNT(*) FROM connector_payments WHERE item_id = ? AND url = ?)
            FROM connectors WHERE ${USABLE} AND json_extract(config_public, '$.mode') = ?`,
    params: [order.id, order.id, order.id, url ?? "", order.sandbox ? "test" : "live"],
    method: "all",
  });
  const r = rows[0];
  if (!r || r[0] === null || r[0] === undefined) return false;
  // The owner's own link stays theirs.
  if (url !== null && Number(r[3] ?? 0) === 0) return false;
  // Ours already, asked for now, or accepted now (this event) or since the connection was made.
  if (Number(r[2] ?? 0) > 0 || asked) return true;
  const acceptedAt = r[1] === null || r[1] === undefined ? now : Number(r[1]);
  return acceptedAt >= Number(r[0]);
}

/** Whether the order has a link of ours that is still live, which a change to it may close. */
export async function hasLivePayLink(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM connector_payments WHERE item_id = ? AND state IN ('creating', 'open') LIMIT 1",
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/** The job that makes, keeps or closes an order's link, once per event that may change it. */
export function payLinkStatement(itemId: string, eventId: string, now: number): Statement {
  return jobStatement(PAY_LINK_KIND, { itemId }, now, { dedupeKey: `paylink:${itemId}:${eventId}` });
}

/** An order's pay-link jobs run one after another: a lane per order. */
export function payLane(payload: unknown): string | undefined {
  const id = (payload as { itemId?: unknown } | null)?.itemId;
  return typeof id === "string" ? `pay:${id}` : undefined;
}
