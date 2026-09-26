import { type Audience, customerLabel, DEFAULT_AUDIENCE, statusSentence } from "../customer/describe";
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
  "accept_change",
  "approve",
  "goods_back",
  "counter",
  "quote",
  "answer",
  "record_payment",
  "request_payment",
  "start_fulfilment",
  "fulfil",
  "complete",
  "propose",
  "propose_change",
  "record_delivery",
  "request_info",
  "retract",
  "retract_change",
  "provide_info",
  "reopen",
  "unspam",
  "refund",
  "open_return",
  "close",
  "decline",
  "decline_change",
  "reject",
  "no_show",
  "payment_failed",
  "charge_back",
  "record_charge_back",
  "cancel",
  "cancel_late",
  "cancel_by_business",
  "record_cancel",
  "record_cancel_late",
  "record_withdrawal",
  "dispute_goods",
  "mark_spam",
  "expire",
  "expire_change",
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
 * one-time corrections (`corrections.ts`), which only a reader of its history knows. `audience`:
 * for a customer, the language, time zone and notice the business speaks to them in.
 */
export function viewFor(
  item: Item,
  actor: ActorKind,
  party?: PartyView,
  hidden?: ReadonlySet<string>,
  audience?: Audience,
): ItemView {
  const machine = machines[item.type];
  const customer = CUSTOMER_KINDS.has(actor);
  const lang = (audience ?? DEFAULT_AUDIENCE).lang;
  // What we proposed is withdrawn only when it said it was subject to our confirmation (ADR-018 §2).
  const withdrawable = (item.payload as { offer?: { binding?: boolean } }).offer?.binding === false;
  // A change to a promise is answered by the side it was asked of, and taken back by the one who
  // asked (we only when it said it was subject to our confirmation); with none open, it can be asked.
  const change = (item.payload as { change?: { by: "business" | "customer" } }).change;
  const side = customer ? "customer" : "business";
  const changeShown = (event: string) => {
    // The owner also records a customer's yes to our own change, given to a person.
    if (event === "accept_change") return change !== undefined && (change.by !== side || !customer);
    if (event === "decline_change") return change !== undefined && change.by !== side;
    if (event === "retract_change") return change?.by === side && (customer || withdrawable);
    return true;
  };
  // A booking nothing was paid for is a reservation to cancel, not a contract to withdraw from (ADR-018 §7).
  const paidBooking =
    item.type !== "booking" || item.payload.paymentRef !== undefined || (item.payload.paidAmount?.value ?? 0) > 0;
  const transitions = availableTransitions(machine, item.state, actor)
    .filter(
      (t) =>
        !hidden?.has(t.event) &&
        (t.event !== "retract" || withdrawable) &&
        changeShown(t.event) &&
        (t.event !== "record_withdrawal" || paidBooking),
    )
    .map((t, i) => ({
      event: t.event,
      label: customer
        ? customerLabel(t.event, item.type, item.state, lang)
        : t.event === "accept_change" && change?.by === "business"
          ? "Customer accepted the change"
          : t.label,
      i,
    }))
    .sort((a, b) => rankOf(a.event) - rankOf(b.event) || a.i - b.i)
    .map(({ event, label }) => ({ event, label }));
  // A customer reads the business's own words; the business reads about its item. Whatever door
  // answers them — a create, a transition, the status — the business's flags never go with it.
  const human = customer ? describeToCustomer(item, audience) : describe(item);
  return { item: customer ? customerItem(item) : item, transitions, human, ...(party ? { party } : {}) };
}

/**
 * The item as its customer sees it: none of the business's own flags (priority, a person needed,
 * test mode), and a message the business put aside as spam is simply closed.
 */
export function customerItem(item: Item): Item {
  const { flags: _flags, ...rest } = item;
  // Nor how far a negotiation has gone: the round is the business's to count (ADR-018 §4).
  const offer = (item.payload as { offer?: Record<string, unknown> }).offer;
  const payload = offer
    ? (() => {
        const { round: _round, ...pointer } = offer;
        return { ...item.payload, offer: pointer };
      })()
    : item.payload;
  return { ...rest, payload, state: item.state === "spam" ? "closed" : item.state } as unknown as Item;
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
  goods_received: "back with the business, waiting for the refund",
  rejected: "rejected",
  refunded: "refunded",
};

/**
 * What the business says to its customer about their item, in its own voice and language: the
 * customer wrote to the business, and whatever carries this sentence to them — their assistant, most
 * often — passes on the business's words, and names nobody else (`customer/copy.ts`).
 */
export function describeToCustomer(item: Item, audience: Audience = DEFAULT_AUDIENCE): string {
  return statusSentence(item, audience);
}

export function describe(item: Item): string {
  const what = item.subject ? `${TYPE_WORD[item.type]} "${item.subject}"` : TYPE_WORD[item.type];
  const when = item.type === "booking" ? ` for ${formatWhen(item.payload.startTime)}` : "";
  const prices = statedPrices(item);
  const who = item.channel === "email" || item.channel === "form" ? "The customer" : "The customer's assistant";
  const price = prices ? ` ${who} suggested ${moneyText(prices.stated)}; your price is ${moneyText(prices.ours)}.` : "";
  const state =
    item.type === "order" && item.state === "proposed"
      ? "waiting for the customer's answer to the changes the business suggested"
      : (STATE_WORD[item.state] ?? item.state);
  return `${what}${when} is ${state}.${price}${changeLine(item)} Reference ${item.id}.`;
}

/** A change asked for and not answered yet, for the business: who asked, and what it would be. */
function changeLine(item: Item): string {
  if (item.type === "booking" && item.payload.change) {
    const to = formatWhen(item.payload.change.startTime);
    return item.payload.change.by === "customer"
      ? ` The customer asks to move it to ${to}.`
      : ` You asked the customer to move it to ${to}; waiting for their answer.`;
  }
  if (item.type === "order" && item.payload.change) {
    const total = moneyText(item.payload.change.totalPrice);
    return item.payload.change.by === "customer"
      ? ` The customer asks for changes to it (total ${total}).`
      : ` You asked the customer for changes to it (total ${total}); waiting for their answer.`;
  }
  return "";
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
