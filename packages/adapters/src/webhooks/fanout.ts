import { type JobHandler, matchesEvent, schema, ulid, WEBHOOK_FANOUT_KIND } from "@surfingdog/core";
import type { Statement } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { deliverJobStatement, readEvent } from "./deliver";

/**
 * One event, many endpoints (ADR-015 §5). The write path enqueues exactly one `webhook_fanout`
 * job, in the same batch as the change that caused it and only when there is an active endpoint to
 * receive it, so an instance with no integrations writes exactly what it writes today. The handler
 * then turns that one job into one delivery row and one delivery job per subscribed endpoint, in a
 * single batch — D1 has no interactive transactions, and this is the whole point of the outbox.
 */
export { WEBHOOK_FANOUT_KIND };

/**
 * One event never fans out to more than this; an endpoint list is a list, not a broadcast tree.
 * Endpoints are taken oldest first, and anything past the cap is named in the job's note rather
 * than dropped in silence — `replay_missing_webhook_deliveries` is then the way to backfill it,
 * because it matches on the endpoint's own subscriptions and does not go through the fanout.
 */
export const MAX_ENDPOINTS_PER_EVENT = 20;

export interface FanoutPayload {
  /** The `events_v1` id — an `item_events` id, or the id of an inbound `thread_entries` row. */
  readonly eventId: string;
  /** `<item_type>.<machine event>`, or `<item_type>.message`. A hint: the view is the truth. */
  readonly eventType?: string;
  readonly itemId?: string;
}

/**
 * Subscriptions match exactly (`booking.confirm`), by item type (`booking.*`), by event
 * (`*.create`) or by the wildcard (`*`). An endpoint that subscribes to nothing receives nothing;
 * there is no implicit "all".
 *
 * The rule is `matchesEvent` in `@surfingdog/core`, and this is the same function under the name
 * the fanout reads better with. It has to be the same one: `replayMissing` in the owner capability
 * decides what an endpoint *should* have had with `matchesEvent`, so a fanout that matched
 * anything else would be asked to replay events it had refused to send in the first place.
 */
export function matchesSubscription(subscriptions: readonly string[], eventType: string): boolean {
  return matchesEvent(
    subscriptions.map((s) => s.trim()).filter((s) => s.length > 0),
    eventType,
  );
}

export function webhookFanoutHandler(): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as FanoutPayload;
    if (!p?.eventId) return { note: "no event id" };
    const event = await readEvent(db, p.eventId);
    const eventType = event?.type ?? p.eventType;
    if (!eventType) return { note: `event ${p.eventId} is gone` };

    const endpoints = await db.orm
      .select({ id: schema.webhooks.id, events: schema.webhooks.events, url: schema.webhooks.url })
      .from(schema.webhooks)
      .where(eq(schema.webhooks.active, 1))
      .orderBy(schema.webhooks.createdAt);
    const matched = endpoints.filter((e) => matchesSubscription(subscriptions(e.events), eventType));
    // The cap is deliberate; being quiet about it was not. The count is taken before the slice, so
    // a fanout that dropped an endpoint says so in the note, and the runner writes that note onto
    // the job row — durable evidence rather than a log line that scrolls away.
    const wanted = matched.slice(0, MAX_ENDPOINTS_PER_EVENT);
    const skipped = matched.length - wanted.length;
    if (wanted.length === 0) return { note: `no active endpoint is subscribed to ${eventType}` };

    // A fanout that runs twice must write the same rows, not new ones: where a delivery already
    // exists for this pair, its id is reused, so both the unique index and the job dedupe key
    // recognise the repeat and INSERT OR IGNORE does the rest.
    const existing = new Map(
      (
        await db.orm
          .select({ id: schema.webhookDeliveries.id, webhookId: schema.webhookDeliveries.webhookId })
          .from(schema.webhookDeliveries)
          .where(eq(schema.webhookDeliveries.eventId, p.eventId))
      ).map((d) => [d.webhookId, d.id] as const),
    );

    const statements: Statement[] = [];
    for (const endpoint of wanted) {
      const deliveryId = existing.get(endpoint.id) ?? ulid();
      statements.push(deliveryStatement(deliveryId, endpoint.id, p.eventId, eventType, now));
      statements.push(
        deliverJobStatement({ deliveryId, webhookId: endpoint.id, eventId: p.eventId, attempt: 0 }, now, now),
      );
    }
    await db.batch(statements);
    return {
      note:
        `${eventType} → ${wanted.length} endpoint${wanted.length === 1 ? "" : "s"}` +
        (skipped ? ` (${skipped} over the ${MAX_ENDPOINTS_PER_EVENT} cap, not delivered)` : ""),
    };
  };
}

function deliveryStatement(id: string, webhookId: string, eventId: string, eventType: string, now: number): Statement {
  return {
    sql: "INSERT OR IGNORE INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
    params: [id, webhookId, eventId, eventType, now, now],
    method: "run",
  };
}

/** The column is JSON; a driver that hands back the raw text is read the same way. */
function subscriptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  }
  return [];
}
