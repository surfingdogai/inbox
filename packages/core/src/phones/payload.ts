import type { Item } from "../domain/types";
import { moneyText } from "../util/money";
import { MAX_PUSH_PLAINTEXT } from "./crypto";
import type { PushKind } from "./prefs";

/**
 * What a phone is sent about an item (ADR-026), before it is encrypted for that phone. Minimal by
 * default: the kind, the time or the size of it, never who sent it or what they wrote. Only when the
 * owner turned on "Show details" on that phone do a name and the first words ride along, and even
 * then encrypted end to end: the relay and Google's push service carry bytes they cannot read.
 *
 * The phone shows it as it is; the action, when there is one, only opens the item with that action
 * chosen, and asks for the owner's fingerprint or face first. Nothing is ever done from a
 * notification without the owner pressing it in the app.
 */
export interface PushPayload {
  readonly v: 1;
  readonly t: "item" | "test";
  /** The item to open; absent for a test. */
  readonly item?: string;
  readonly kind: PushKind | "test";
  readonly title: string;
  readonly body: string;
  /** The customer's name: only with details on. */
  readonly who?: string;
  /** The first words they wrote: only with details on. */
  readonly text?: string;
  /** The action the notification offers to open with, and its words ("Accept 14:00"). */
  readonly action?: { readonly event: string; readonly label: string };
  readonly at: number;
}

export interface PayloadContext {
  readonly item: Item;
  readonly kind: PushKind;
  /** What happened: `create`, `message`, a change, a draft waiting… (the owner notify job's event). */
  readonly event: string;
  readonly details: boolean;
  /** The customer's name as the business knows them, used only with details on. */
  readonly who?: string | null;
  /** The newest words the customer wrote on it, used only with details on. */
  readonly text?: string | null;
  readonly timezone: string;
  readonly locale?: string;
  readonly now: number;
}

function when(iso: string, tz: string, locale: string): { day: string; time: string } {
  const d = new Date(iso);
  const opts = (o: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZone: tz, ...o }).format(d);
    } catch {
      return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...o }).format(d);
    }
  };
  return {
    day: opts({ weekday: "short", day: "numeric", month: "short" }),
    time: opts({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  };
}

const NEW: Record<PushKind, string> = {
  booking: "New booking request",
  order: "New order",
  quote: "New quote request",
  message: "New message",
  handled: "Answered by your rules",
};

/** Titles for what happens to an item after it arrived, as the owner's email names them. */
const LATER: Readonly<Record<string, string>> = {
  message: "A reply came in",
  draft_offer: "A draft waits for you",
  held_reply: "A reply waits for you",
  refund_due: "A refund is due",
  request_change: "A change is asked for",
  counter: "A different time is asked for",
  withdraw: "A customer withdrew",
  cancel: "A customer cancelled",
};

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The line under the title: what and when, never who. */
function summary(item: Item, tz: string, locale: string): string {
  switch (item.type) {
    case "booking": {
      const w = when(item.payload.startTime, tz, locale);
      return `${w.day}, ${w.time} · ${item.payload.reservationFor.name}`;
    }
    case "order": {
      const count = item.payload.orderedItem.reduce((n, l) => n + l.quantity, 0);
      const how = item.payload.delivery?.method;
      const by = item.payload.delivery?.when ? when(item.payload.delivery.when, tz, locale).day : "";
      const way =
        how === "pickup" ? `pick-up${by ? ` ${by}` : ""}` : how === "delivery" ? `delivery${by ? ` ${by}` : ""}` : "";
      return [`${count} item${count === 1 ? "" : "s"}`, way].filter(Boolean).join(" · ");
    }
    case "quote_request":
      return item.payload.itemOffered.name;
    case "refund":
      return "About an order";
    default:
      return item.channel === "email" ? "By email" : item.channel === "form" ? "From your page" : "From an assistant";
  }
}

/** The action a new request may be opened with, from the notification: accepting it as it is. */
function actionFor(item: Item, kind: PushKind, tz: string, locale: string): PushPayload["action"] | undefined {
  if (kind === "handled") return undefined;
  if (item.type === "booking" && (item.state === "requested" || item.state === "needs_info")) {
    return { event: "confirm", label: `Accept ${when(item.payload.startTime, tz, locale).time}` };
  }
  if (item.type === "order" && (item.state === "received" || item.state === "needs_info")) {
    return { event: "accept", label: "Accept order" };
  }
  return undefined;
}

/** The plaintext for one phone: minimal, or with details when that phone allows them. */
export function buildPushPayload(ctx: PayloadContext): PushPayload {
  const locale = ctx.locale ?? "en-GB";
  const { item } = ctx;
  const isNew = ctx.event === "create";
  let title = isNew ? NEW[ctx.kind] : (LATER[ctx.event] ?? "Something changed");
  if (isNew && item.type === "order" && ctx.kind !== "handled")
    title = `${title} · ${moneyText(item.payload.totalPrice)}`;
  // A booking's price rides in the body, after its time and service, as the approved design has it.
  let body = summary(item, ctx.timezone, locale);
  if (isNew && item.type === "booking" && item.payload.totalPrice)
    body = `${body} · ${moneyText(item.payload.totalPrice)}`;
  const action = isNew ? actionFor(item, ctx.kind, ctx.timezone, locale) : undefined;
  const payload: PushPayload = {
    v: 1,
    t: "item",
    item: item.id,
    kind: ctx.kind,
    title: oneLine(title, 80),
    body: oneLine(body, 120),
    ...(ctx.details && ctx.who ? { who: oneLine(ctx.who, 60) } : {}),
    ...(ctx.details && ctx.text ? { text: oneLine(ctx.text, 160) } : {}),
    ...(action ? { action } : {}),
    at: ctx.now,
  };
  return fitPayload(payload);
}

/** A test notification, as Settings → Phone sends it. */
export function testPayload(now: number, business: string): PushPayload {
  return {
    v: 1,
    t: "test",
    kind: "test",
    title: "Notifications work",
    body: oneLine(`This phone hears from ${business || "your inbox"}.`, 120),
    at: now,
  };
}

/** Bytes to encrypt: the JSON, trimmed of the optional words first when it would not fit. */
export function encodePayload(payload: PushPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fitPayload(payload)));
}

function fitPayload(p: PushPayload): PushPayload {
  const size = (x: PushPayload) => new TextEncoder().encode(JSON.stringify(x)).length;
  if (size(p) <= MAX_PUSH_PLAINTEXT) return p;
  const { text: _t, ...withoutText } = p;
  if (size(withoutText) <= MAX_PUSH_PLAINTEXT) return withoutText;
  const { who: _w, ...bare } = withoutText;
  return bare;
}
