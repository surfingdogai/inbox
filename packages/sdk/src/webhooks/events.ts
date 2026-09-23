/**
 * The shape of what an Inbox sends (ADR-015 §3). Two styles, chosen per endpoint:
 *
 * - `thin` (the default) carries a pointer — id, type, state, version and a URL. It never goes
 *   stale when it is retried ten hours later, and it never copies a customer's name and address to
 *   an address somebody pasted into a form once.
 * - `full` carries the item as well, so a no-code tool that cannot hold an owner key and call back
 *   still has something to work with. The Settings screen says, in plain words, that this style
 *   sends customer data to that address.
 *
 * The envelope is identical either way, so a receiver that only reads `id`, `type` and
 * `data.id` works with both.
 */

/** The five kinds of thing an Inbox holds. */
export type InboxItemType = "message" | "quote_request" | "booking" | "order" | "refund";

/**
 * The one event type that is not about an item: what `send_test_event` and
 * `POST /v1/owner/webhooks/{id}/test` deliver. Its body carries `test: true` and a sentence saying
 * that nothing was created, and no item exists behind its `data.id`.
 */
export const TEST_EVENT_TYPE = "inbox.test";

/**
 * `<item type>.<event>` — `booking.create`, `order.record_payment`, `quote_request.quote`,
 * `message.message`. The event half is the machine event that fired, `create` for a new item,
 * `flags` when a flag changed, and `message` for an inbound message on an item. `inbox.test` is
 * the one exception and belongs to no item. New events appear as the machines grow, so treat this
 * as an open set: match the ones you handle, ignore the rest.
 */
export type InboxEventType = `${InboxItemType}.${string}` | typeof TEST_EVENT_TYPE;

/** True for the event the owner sent from Settings to check the endpoint works. Ignore it. */
export function isTestEvent(event: InboxEventEnvelope): boolean {
  return event.type === TEST_EVENT_TYPE;
}

/** Common to both styles. `timestamp` is the event's own ISO 8601 instant, in UTC. */
export interface InboxEventEnvelope {
  /** Unique, sortable, and the `webhook-id` header. Deduplicate on it: a retry reuses it. */
  readonly id: string;
  readonly type: InboxEventType;
  /** When the event happened, e.g. `2026-09-21T12:00:00.000Z`. Not when this attempt was sent. */
  readonly timestamp: string;
}

/** What every event carries about the item the event happened to. */
export interface ThinEventData {
  readonly id: string;
  readonly type: InboxItemType;
  /** The state the item is in after the event, e.g. `confirmed`. */
  readonly state: string;
  /** The item's version after the event. Use it to drop an event older than what you hold. */
  readonly version: number;
  /** Where to fetch the item: `https://<inbox>/v1/owner/items/<id>`. Needs an owner key. */
  readonly url: string;
  /**
   * Who caused the event. `kind` is `owner`, `owner_ai`, `integration`, `connector`, `rule`,
   * `system`, `customer_agent` or `customer_human`; `id` is the user, AI app or key id (null for a
   * customer); `name` is the key's or AI app's name. A two-way sync skips events whose actor is
   * its own key. Absent on events from instances older than this field.
   */
  readonly actor?: { readonly kind: string; readonly id: string | null; readonly name?: string };
  /** The door it came through: `rest`, `mcp_owner`, `mcp_public`, `email`, `owner_ui`, `system`, … */
  readonly channel?: string | null;
  /** Whether the item is a sandbox (test) item. */
  readonly sandbox?: boolean;
}

/** An item as the owner doors return it. `payload` holds the typed fields for its `type`. */
export interface InboxItem {
  readonly id: string;
  readonly type: InboxItemType;
  readonly state: string;
  readonly version: number;
  readonly partyId: string;
  readonly locationId: string | null;
  readonly channel: string;
  readonly subject: string | null;
  readonly flags: { readonly needsHuman: boolean; readonly sandbox: boolean; readonly priority: number };
  readonly linkedItemId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  /** Schema.org names in camelCase; the shape depends on `type`. */
  readonly payload: Record<string, unknown>;
}

/** Who the item belongs to. Only on the full style, and only once a party is known. */
export interface EventParty {
  readonly id: string;
  readonly name: string | null;
  readonly kind: string;
  readonly email?: string;
  readonly phone?: string;
  /** True once the address or number behind this party has been proved.  */
  readonly verified: boolean;
}

/** The message itself, on a `<type>.message` event in the full style. */
export interface EventMessage {
  readonly id: string;
  readonly direction: string;
  readonly channel: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly at: string;
}

/** The full style: the same pointer, plus the item, what may happen to it next, and the party. */
export interface FullEventData extends ThinEventData {
  readonly item: InboxItem;
  /** The events this item accepts right now, each with a label a person can read. */
  readonly transitions: readonly { readonly event: string; readonly label: string }[];
  /** One sentence describing the item, as the owner app shows it. */
  readonly human: string;
  readonly party?: EventParty;
  readonly message?: EventMessage;
}

export interface ThinInboxEvent extends InboxEventEnvelope {
  readonly data: ThinEventData;
}

export interface FullInboxEvent extends InboxEventEnvelope {
  readonly data: FullEventData;
}

/** What `verifyWebhook` returns unless you name a narrower type. */
export type InboxEvent = ThinInboxEvent | FullInboxEvent;

/** True when the endpoint is on the `full` style, so `event.data` carries the item itself. */
export function isFullEvent(event: InboxEvent): event is FullInboxEvent {
  const item = (event as FullInboxEvent).data?.item;
  return typeof item === "object" && item !== null;
}
