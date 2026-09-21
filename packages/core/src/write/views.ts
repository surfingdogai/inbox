import { type ActorKind, type Item, type ItemType, itemFlagsSchema, payloadSchemas } from "../domain/types";
import { availableTransitions } from "../machine/machine";
import { machines } from "../machine/tables";
import type { items } from "../schema/tables";

export type ItemRow = typeof items.$inferSelect;

/** What every door returns: the typed item, what the caller may do next, and a sentence for humans. */
export interface ItemView {
  readonly item: Item;
  readonly transitions: readonly { readonly event: string; readonly label: string }[];
  readonly human: string;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function rowToItem(row: ItemRow): Item {
  const flags = itemFlagsSchema.parse(row.flags ?? {});
  const type = row.type as ItemType;
  const payload = payloadSchemas[type].parse(row.payload);
  return {
    id: row.id,
    type,
    state: row.state,
    version: row.version,
    partyId: row.partyId,
    locationId: row.locationId,
    channel: row.channel as Item["channel"],
    subject: row.subject,
    flags,
    linkedItemId: row.linkedItemId,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    closedAt: iso(row.closedAt),
    payload,
  } as Item;
}

export function viewFor(item: Item, actor: ActorKind): ItemView {
  const machine = machines[item.type];
  const transitions = availableTransitions(machine, item.state, actor).map((t) => ({ event: t.event, label: t.label }));
  return { item, transitions, human: describe(item) };
}

const TYPE_WORD: Record<ItemType, string> = {
  message: "Message",
  quote_request: "Quote request",
  booking: "Booking",
  order: "Order",
  refund: "Refund",
};

const STATE_WORD: Record<string, string> = {
  requested: "requested, waiting for the business to confirm",
  received: "received, waiting for the business",
  needs_info: "waiting for more details from you",
  proposed: "the business proposed another time; accept or decline it",
  confirmed: "confirmed",
  quoted: "quoted; accept or decline the quote",
  accepted: "accepted",
  awaiting_payment: "accepted, waiting for payment",
  paid: "paid",
  fulfilling: "being prepared",
  fulfilled: "fulfilled",
  completed: "completed",
  declined: "declined by the business",
  expired: "expired without an answer",
  cancelled: "cancelled",
  cancelled_by_customer: "cancelled by you",
  cancelled_by_business: "cancelled by the business",
  no_show: "recorded as a no-show",
  open: "open, waiting for a reply",
  answered: "answered",
  closed: "closed",
  spam: "marked as spam",
  approved: "approved",
  rejected: "rejected",
  refunded: "refunded",
};

export function describe(item: Item): string {
  const what = item.subject ? `${TYPE_WORD[item.type]} "${item.subject}"` : TYPE_WORD[item.type];
  const when = item.type === "booking" ? ` for ${formatWhen(item.payload.startTime)}` : "";
  return `${what}${when} is ${STATE_WORD[item.state] ?? item.state}. Reference ${item.id}.`;
}

function formatWhen(isoTime: string): string {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return isoTime;
  return `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function defaultSubject(type: ItemType, payload: Record<string, unknown>): string {
  switch (type) {
    case "booking":
      return String((payload.reservationFor as { name?: string } | undefined)?.name ?? "Booking");
    case "order": {
      const lines = (payload.orderedItem as { name: string; quantity: number }[] | undefined) ?? [];
      const first = lines[0];
      return first
        ? lines.length > 1
          ? `${first.name} and ${lines.length - 1} more`
          : `${first.quantity} × ${first.name}`
        : "Order";
    }
    case "quote_request":
      return String((payload.itemOffered as { name?: string } | undefined)?.name ?? "Quote request");
    case "message": {
      const subject = payload.subject as string | undefined;
      const text = String(payload.text ?? "");
      return subject ?? (text.length > 80 ? `${text.slice(0, 77)}…` : text);
    }
    case "refund":
      return "Refund request";
  }
}
