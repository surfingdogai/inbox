import { HOLD_WORDS } from "../../../inbox/client/src/lib/food-words";
import {
  formatClock,
  formatDay,
  formatMoney,
  localDateKey,
  partyName,
  slotShort,
  slotWhen,
  truncate,
} from "../../../inbox/client/src/lib/format";
import { stayTitle } from "../../../inbox/client/src/lib/stays";
import type { Item, ItemView } from "../../../inbox/client/src/lib/types";

/**
 * What the phone's screens say about an item, as the approved design has it (ADR-028). Pure, so the
 * words are tested on both runtimes; the owner app's own formatting does the dates and money.
 */
const INITIAL: Readonly<Record<Item["type"], string>> = {
  booking: "requested",
  order: "received",
  quote_request: "received",
  message: "open",
  refund: "requested",
  stay: "requested",
};

export const KIND_WORD: Readonly<Record<Item["type"], string>> = {
  booking: "Booking",
  order: "Order",
  quote_request: "Quote",
  message: "Message",
  refund: "Refund",
  stay: "Stay",
};

const REQUEST_WORD: Readonly<Record<Item["type"], string>> = {
  booking: "Booking request",
  order: "Order",
  quote_request: "Quote request",
  message: "Message",
  refund: "Refund request",
  stay: "Stay request",
};

export function requestWord(item: Item): string {
  return REQUEST_WORD[item.type];
}

/**
 * Whether it waits for the owner: a rule asked for a person, nobody has answered it since it came, or
 * the customer asked for a change to what was agreed.
 */
export function needsYou(view: ItemView): boolean {
  const { item } = view;
  if (item.closedAt !== null) return false;
  if (item.flags.needsHuman) return true;
  if (item.state === INITIAL[item.type]) return true;
  const change = (item.payload as { change?: { by?: string } }).change;
  return change?.by === "customer";
}

/** A short "how long ago", as the approved cards say it: "now", "2 min", "1 h", "Yesterday", "Tue", "3 Oct". */
export function ago(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.floor((now - t) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 2) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(t));
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(t));
}

/** The same in a sentence, never a bare weekday: "just now", "2 min ago", "1 h ago", "yesterday", "3 days ago". */
export function agoSentence(iso: string, now: number = Date.now()): string {
  const short = ago(iso, now);
  if (!short) return "";
  if (short === "now") return "just now";
  if (short === "Yesterday") return "yesterday";
  if (short.endsWith(" min") || short.endsWith(" h")) return `${short} ago`;
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return days < 30 ? `${days} days ago` : `on ${short}`;
}

/** Money as the design writes it: "€48" for a whole amount, "€36.50" otherwise. */
export function money(m: Parameters<typeof formatMoney>[0]): string {
  if (!m) return "";
  if (m.value % 100 !== 0) return formatMoney(m);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: m.currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(m.value / 100);
  } catch {
    return formatMoney(m);
  }
}

/** Who sent it, for the item's sub-line: "Sent by an assistant", "Sent by email", "Sent from your website". */
export function sentPhrase(item: Item): string {
  switch (item.channel) {
    case "email":
      return "Sent by email";
    case "form":
      return "Sent from your website";
    case "owner_ui":
      return "Added by you";
    default:
      return "Sent by an assistant";
  }
}

/** How it came: "via an assistant", "via the website", "via email". */
export function channelPhrase(item: Item): string {
  switch (item.channel) {
    case "email":
      return "via email";
    case "form":
      return "via the website";
    case "owner_ui":
      return "added by you";
    default:
      return "via an assistant";
  }
}

/** How a kitchen's order for a time is had (ADR-040's `fulfil.method`): in a card, and as its fact's name. */
const FULFIL_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  pickup: ["pick-up", "Pick-up"],
  delivery: ["delivery", "Delivery"],
  dine_in: ["eat in", "Eat in"],
};

/** The first line of a card: who, or for an order, what (and for a kitchen's order, how and its slot). */
export function cardTitle(view: ItemView, tz?: string, now: number = Date.now()): string {
  const { item } = view;
  if (item.type === "order") {
    const count = item.payload.orderedItem.reduce((n, l) => n + l.quantity, 0);
    const fulfil = item.payload.fulfil;
    if (fulfil) {
      const how = FULFIL_WORDS[fulfil.method]?.[0] ?? fulfil.method;
      const at = fulfil.slot ? ` ${slotShort(fulfil.slot.start, tz, now)}` : "";
      return `${count} item${count === 1 ? "" : "s"} · ${how}${at}`;
    }
    const delivery = item.payload.delivery;
    const when = delivery?.when ? ` ${formatDay(delivery.when)}` : "";
    const how =
      delivery?.method === "pickup" ? ` · pick-up${when}` : delivery?.method === "delivery" ? ` · delivery${when}` : "";
    return `${count} item${count === 1 ? "" : "s"}${how}`;
  }
  return partyName(view.party);
}

/** A kitchen's order for a time, as a fact on its screen: ["Pick-up", "Today, 17:30"]. Null for any other. */
export function fulfilFact(
  view: Pick<ItemView, "item">,
  tz?: string,
  now: number = Date.now(),
): [string, string] | null {
  const { item } = view;
  if (item.type !== "order" || !item.payload.fulfil) return null;
  const f = item.payload.fulfil;
  return [FULFIL_WORDS[f.method]?.[1] ?? f.method, f.slot ? slotWhen(f.slot.start, tz, now) : ""];
}

/**
 * Why a kitchen's order waits for the owner (`payload.kitchen.hold`), as the owner app says it:
 * allergens nobody confirmed first. A kitchen that accepts each order by hand says nothing here.
 */
export function holdNotes(view: Pick<ItemView, "item">): string[] {
  const { item } = view;
  if (item.type !== "order") return [];
  const holds = (item.payload.kitchen?.hold ?? []).filter((h) => h !== "owner_accepts");
  return [...holds]
    .sort((a, b) => Number(b === "allergens_unconfirmed") - Number(a === "allergens_unconfirmed"))
    .map((h) => HOLD_WORDS[h] ?? h);
}

/** The second line: when and what, or the first words. */
export function cardLine(view: ItemView, tz?: string): string {
  const { item } = view;
  switch (item.type) {
    case "booking":
      return `${item.payload.reservationFor.name} · ${formatDay(item.payload.startTime, tz)}, ${formatClock(item.payload.startTime, tz)}`;
    case "order":
      return truncate(item.payload.orderedItem.map((l) => l.name).join(", "), 80);
    case "quote_request":
      return `${item.payload.itemOffered.name} · asks for a price`;
    case "message":
      return `“${truncate(item.payload.text, 70)}”`;
    case "refund":
      return truncate(item.payload.reason ?? "A refund to decide", 70);
    case "stay":
      // A stay says its room, dates and nights, as the owner app's list does.
      return stayTitle(item.payload);
  }
}

/** The money on a card, when there is any. */
export function cardAmount(item: Item): string {
  if (item.type === "booking" || item.type === "order")
    return item.payload.totalPrice ? money(item.payload.totalPrice) : "";
  if (item.type === "refund") return money(item.payload.amount);
  if (item.type === "stay") return item.payload.totalPrice ? money(item.payload.totalPrice) : "";
  return "";
}

/**
 * A booking request's place in the calendar, as the card and the item say it: "Free in your calendar",
 * or what it clashes with. Null when the inbox did not say (anything but an open booking request).
 */
export function calendarWords(
  view: Pick<ItemView, "calendar">,
  tz?: string,
): { free: boolean; short: string; line: string } | null {
  const c = view.calendar;
  if (!c) return null;
  if (c.free) return { free: true, short: "Free", line: "Free in your calendar" };
  if (c.clash) {
    const who = c.clash.name ?? "another booking";
    const text = `Clashes with ${who}, ${formatClock(c.clash.startTime, tz)}`;
    return { free: false, short: text, line: text };
  }
  return { free: false, short: "Not a free time", line: "Not a free time in your calendar" };
}

/** The event the owner most likely means, first: accepting it as it is. */
const PRIMARY = ["confirm", "accept", "accept_change", "approve", "answer", "quote", "fulfil", "complete"];
const DANGER = new Set(["decline", "reject", "cancel", "decline_change", "mark_spam", "no_show"]);

export interface Actions {
  readonly primary: { readonly event: string; readonly label: string } | null;
  readonly propose: { readonly event: string; readonly label: string } | null;
  readonly decline: { readonly event: string; readonly label: string } | null;
}

/** The three buttons the design gives an item: accept, propose another time, decline. */
export function actionsFor(view: ItemView, tz?: string): Actions {
  const t = view.transitions;
  const found = PRIMARY.map((e) => t.find((x) => x.event === e)).find(Boolean) ?? null;
  // Answering a message takes words, which the reply field gives: it is not a button of its own.
  const primary = found && found.event !== "answer" && found.event !== "quote" ? found : null;
  const label =
    primary && view.item.type === "booking" && primary.event === "confirm"
      ? `Accept ${formatClock(view.item.payload.startTime, tz)}`
      : primary?.event === "accept" && view.item.type === "order"
        ? "Accept order"
        : (primary?.label ?? "");
  const propose = view.item.type === "booking" ? (t.find((x) => x.event === "propose") ?? null) : null;
  const decline = t.find((x) => x.event === "decline") ?? null;
  return {
    primary: primary ? { event: primary.event, label } : null,
    propose: propose ? { event: propose.event, label: "Propose another time" } : null,
    decline: decline && DANGER.has(decline.event) ? { event: decline.event, label: "Decline" } : null,
  };
}

/** Initials for an inbox's badge: "Atelier Lumen" → "AL". */
export function badgeOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export interface TodayRow {
  readonly at: string;
  readonly kind: "booking" | "ask" | "free";
  readonly title: string;
  readonly line: string;
  readonly itemId?: string;
}

/**
 * Today, as the design lays it out: the day's bookings in time order, the requests for a time today
 * marked to review, and the free stretches between them over an hour long.
 */
export function today(
  views: readonly ItemView[],
  now: number,
  tz: string,
): {
  rows: TodayRow[];
  bookings: number;
  toConfirm: number;
  orders: ItemView[];
} {
  const day = localDateKey(now, tz);
  const todays = views
    .filter((v) => v.item.type === "booking" && v.item.closedAt === null)
    .filter((v) => v.item.type === "booking" && localDateKey(v.item.payload.startTime, tz) === day)
    .sort((a, b) =>
      a.item.type === "booking" && b.item.type === "booking"
        ? Date.parse(a.item.payload.startTime) - Date.parse(b.item.payload.startTime)
        : 0,
    );
  const rows: TodayRow[] = [];
  let lastEnd: number | null = null;
  let toConfirm = 0;
  for (const v of todays) {
    if (v.item.type !== "booking") continue;
    const start = Date.parse(v.item.payload.startTime);
    const end = Date.parse(v.item.payload.endTime);
    if (lastEnd !== null && start - lastEnd >= 3_600_000) {
      rows.push({
        at: formatClock(new Date(lastEnd).toISOString(), tz),
        kind: "free",
        title: `Free until ${formatClock(v.item.payload.startTime, tz)}`,
        line: "",
      });
    }
    const asks = needsYou(v);
    if (asks) toConfirm++;
    const minutes = Math.round((end - start) / 60_000);
    rows.push({
      at: formatClock(v.item.payload.startTime, tz),
      kind: asks ? "ask" : "booking",
      title: partyName(v.party),
      line: asks
        ? `Asks for this time · ${v.item.payload.reservationFor.name}`
        : `${v.item.payload.reservationFor.name} · ${minutes} min`,
      itemId: v.item.id,
    });
    lastEnd = Math.max(lastEnd ?? 0, end);
  }
  const orders = views.filter(
    (v) =>
      v.item.type === "order" && v.item.closedAt === null && ["accepted", "paid", "fulfilling"].includes(v.item.state),
  );
  return { rows, bookings: todays.length, toConfirm, orders };
}
