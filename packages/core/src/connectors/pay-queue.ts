import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { jobStatement } from "../write/common";

/**
 * What the write path needs of pay links (ADR-023), apart from the rest so the write path and the
 * payments side do not import each other: whether any payment connection takes orders, whether an
 * order has a live link, and the job that brings an order's link in step with it.
 */

export const PAY_LINK_KIND = "pay_link";
export const PAY_NOTICE_KIND = "pay_notice";

/**
 * How long a customer's email waits after an order is accepted (or a payment failed) while a link is
 * on its way, so the customer gets one email with the link in it rather than two.
 */
export const PAY_LINK_GRACE_MS = 20_000;

/**
 * Whether a payment connection takes this inbox's orders: any connection that is not paused and has
 * pay links on. Read by the write path, so an inbox with none queues nothing.
 */
export async function hasPayLinks(db: Db): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM connectors WHERE kind <> 'feed' AND status <> 'disabled'
            AND json_extract(config_public, '$.payOn') = 1 LIMIT 1`,
    params: [],
    method: "all",
  });
  return rows.length > 0;
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
