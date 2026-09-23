import { type ActorKind, type Item, type ItemType, itemFlagsSchema, type Money, payloadSchemas } from "../domain/types";
import { availableTransitions } from "../machine/machine";
import { machines } from "../machine/tables";
import type { ReceiptView } from "../receipts/capabilities";
import type { items } from "../schema/tables";
import { moneyText } from "../util/money";
import { CUSTOMER_KINDS } from "./caller";

export type ItemRow = typeof items.$inferSelect;

/** What every door returns: the typed item, what the caller may do next, and a sentence for humans. */
export interface ItemView {
  readonly item: Item;
  readonly transitions: readonly { readonly event: string; readonly label: string }[];
  readonly human: string;
  /** Who is asking; present for the business side only, never echoed back to customers. */
  readonly party?: PartyView | undefined;
  /**
   * The receipts this item has earned (ADR-016), oldest first. Present on the doors that read one
   * item; absent from lists, which do not pay for the extra query.
   */
  readonly receipts?: readonly ReceiptView[] | undefined;
}

export interface PartyView {
  readonly id: string;
  readonly name: string | null;
  readonly kind: string;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly verified: boolean;
}

/**
 * The order the owner sees actions in: the happy path first, then alternatives, then the
 * destructive ones. Machines list transitions in lifecycle order, which is not reading order.
 */
const ACTION_RANK = [
  "confirm",
  "accept",
  "approve",
  "quote",
  "answer",
  "record_payment",
  "request_payment",
  "start_fulfilment",
  "fulfil",
  "complete",
  "propose",
  "request_info",
  "provide_info",
  "reopen",
  "unspam",
  "refund",
  "close",
  "decline",
  "reject",
  "no_show",
  "payment_failed",
  "charge_back",
  "record_charge_back",
  "cancel",
  "cancel_late",
  "cancel_by_business",
  "mark_spam",
  "expire",
  "lapse",
];
const rankOf = (event: string) => {
  const i = ACTION_RANK.indexOf(event);
  return i === -1 ? ACTION_RANK.length : i;
};

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

/**
 * `hidden`: events the machine would list that can no longer happen for this item — its dead
 * one-time corrections (`corrections.ts`), which only a reader of its history knows.
 */
export function viewFor(item: Item, actor: ActorKind, party?: PartyView, hidden?: ReadonlySet<string>): ItemView {
  const machine = machines[item.type];
  const transitions = availableTransitions(machine, item.state, actor)
    .filter((t) => !hidden?.has(t.event))
    .map((t, i) => ({ event: t.event, label: t.label, i }))
    .sort((a, b) => rankOf(a.event) - rankOf(b.event) || a.i - b.i)
    .map(({ event, label }) => ({ event, label }));
  // A customer reads the business's own words; the business reads about its item.
  const human = CUSTOMER_KINDS.has(actor) ? describeToCustomer(item) : describe(item);
  return { item, transitions, human, ...(party ? { party } : {}) };
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
  payment_failed: "accepted; the payment failed",
  charged_back: "charged back: the payment was reversed",
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

/**
 * What the business says to its customer about their item, in its own voice: the customer wrote to
 * the business, and whatever carries this sentence to them — their assistant, most often — passes
 * on the business's words, and names nobody else.
 */
const CUSTOMER_STATE_WORD: Record<string, string> = {
  requested: "is with us; we will confirm it or suggest another time",
  received: "is with us; we will get back to you",
  needs_info: "needs a detail from you",
  proposed: "has another time from us; accept or decline it",
  confirmed: "is confirmed",
  quoted: "has our quote; accept or decline it",
  accepted: "is accepted",
  awaiting_payment: "is accepted and waiting for your payment",
  payment_failed: "is accepted; your payment did not go through",
  charged_back: "was charged back: the payment was reversed",
  paid: "is paid",
  fulfilling: "is being prepared",
  fulfilled: "is fulfilled",
  completed: "is completed",
  declined: "was declined: we cannot take it",
  expired: "has expired",
  cancelled: "is cancelled",
  cancelled_by_customer: "is cancelled, as you asked",
  cancelled_by_business: "was cancelled by us",
  no_show: "is recorded as missed",
  open: "is with us; we will reply soon",
  answered: "has our answer",
  closed: "is closed",
  spam: "is closed",
  approved: "is approved",
  rejected: "was not approved",
  refunded: "is refunded",
};

export function describeToCustomer(item: Item): string {
  const noun = TYPE_WORD[item.type].toLowerCase();
  const what = item.subject ? `Your ${noun} "${item.subject}"` : `Your ${noun}`;
  const when = item.type === "booking" ? ` for ${formatWhen(item.payload.startTime)}` : "";
  // A request that named another price hears ours, in our words (ADR-018 §3.2).
  const prices = statedPrices(item);
  const price = prices ? ` Our price is ${moneyText(prices.ours)}.` : "";
  return `${what}${when} ${CUSTOMER_STATE_WORD[item.state] ?? `is ${item.state.replaceAll("_", " ")}`}.${price} Reference ${item.id}.`;
}

export function describe(item: Item): string {
  const what = item.subject ? `${TYPE_WORD[item.type]} "${item.subject}"` : TYPE_WORD[item.type];
  const when = item.type === "booking" ? ` for ${formatWhen(item.payload.startTime)}` : "";
  const prices = statedPrices(item);
  const who = item.channel === "email" || item.channel === "form" ? "The customer" : "The customer's assistant";
  const price = prices ? ` ${who} suggested ${moneyText(prices.stated)}; your price is ${moneyText(prices.ours)}.` : "";
  return `${what}${when} is ${STATE_WORD[item.state] ?? item.state}.${price} Reference ${item.id}.`;
}

/** The price a customer's request stated beside the business's own, when they differ (ADR-018 §3.2). */
function statedPrices(item: Item): { stated: Money; ours: Money } | null {
  if (item.type !== "booking" && item.type !== "order") return null;
  const { customerStatedPrice: stated, totalPrice: ours } = item.payload;
  return stated && ours ? { stated, ours } : null;
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
