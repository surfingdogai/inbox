import type { Item, ItemType, Money } from "./types";

/**
 * Words and numbers for humans. Pure functions, no DOM, so they run in tests on both runtimes.
 * Colour keys (`tint-quote`, `dot-quote`) come from the design tokens, not from the type name.
 */
export const TYPE_WORD: Record<ItemType, string> = {
  message: "Message",
  quote_request: "Quote",
  booking: "Booking",
  order: "Order",
  refund: "Refund",
};

export const TYPE_PLURAL: Record<ItemType, string> = {
  message: "Messages",
  quote_request: "Quotes",
  booking: "Bookings",
  order: "Orders",
  refund: "Refunds",
};

export const TYPE_CLASS: Record<ItemType, string> = {
  message: "message",
  quote_request: "quote",
  booking: "booking",
  order: "order",
  refund: "refund",
};

export type Tone = "neutral" | "success" | "warning" | "danger";

const STATE_WORDS: Record<string, string> = {
  needs_info: "Needs info",
  awaiting_payment: "Awaiting payment",
  no_show: "No-show",
  cancelled_by_customer: "Cancelled by customer",
  cancelled_by_business: "Cancelled by you",
};
const SUCCESS_STATES = new Set([
  "confirmed",
  "accepted",
  "paid",
  "fulfilled",
  "completed",
  "answered",
  "approved",
  "refunded",
]);
const WARNING_STATES = new Set(["needs_info", "awaiting_payment", "proposed"]);
const DANGER_STATES = new Set([
  "declined",
  "cancelled",
  "cancelled_by_customer",
  "cancelled_by_business",
  "rejected",
  "spam",
  "no_show",
  "expired",
]);

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function stateWord(state: string): string {
  return STATE_WORDS[state] ?? capitalise(state.replaceAll("_", " "));
}

export function stateTone(state: string): Tone {
  if (SUCCESS_STATES.has(state)) return "success";
  if (WARNING_STATES.has(state)) return "warning";
  if (DANGER_STATES.has(state)) return "danger";
  return "neutral";
}

const EVENT_WORDS: Record<string, string> = {
  create: "Created",
  confirm: "Confirmed",
  propose: "Proposed another time",
  request_info: "Asked for details",
  provide_info: "Details received",
  accept: "Accepted",
  decline: "Declined",
  expire: "Expired",
  cancel: "Cancelled",
  cancel_by_business: "Cancelled",
  complete: "Completed",
  no_show: "Marked as no-show",
  request_payment: "Payment requested",
  record_payment: "Payment recorded",
  start_fulfilment: "Fulfilment started",
  fulfil: "Fulfilled",
  quote: "Quote sent",
  answer: "Replied",
  reopen: "Reopened",
  close: "Closed",
  mark_spam: "Marked as spam",
  unspam: "Marked as not spam",
  approve: "Approved",
  reject: "Rejected",
  refund: "Refunded",
  flags: "Flag changed",
};

export function eventWord(event: string): string {
  return EVENT_WORDS[event] ?? capitalise(event.replaceAll("_", " "));
}

const ACTOR_WORDS: Record<string, string> = {
  owner: "you",
  staff: "staff",
  owner_ai: "your AI",
  rule: "a rule",
  customer_human: "the customer",
  customer_agent: "the customer's agent",
  connector: "a connector",
  system: "the system",
};

/** "owner:01J…" → "you". */
export function actorWord(actor: string): string {
  const kind = actor.split(":")[0] ?? actor;
  return ACTOR_WORDS[kind] ?? kind;
}

const CHANNEL_WORDS: Record<string, string> = {
  rest: "the API",
  mcp_public: "MCP",
  mcp_owner: "MCP",
  a2a: "A2A",
  ucp: "UCP",
  acp: "ACP",
  arp: "ARP",
  email: "email",
  form: "the web form",
  owner_ui: "the inbox",
  action_link: "an action link",
  simulator: "the simulator",
  connector: "a connector",
  system: "the system",
};

export function channelWord(channel: string): string {
  return CHANNEL_WORDS[channel] ?? channel;
}

export function formatMoney(m: Money | null | undefined, locale?: string): string {
  if (!m) return "";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(m.value / 100);
  } catch {
    return `${(m.value / 100).toFixed(2)} ${m.currency}`;
  }
}

function dateFormatter(locale: string | undefined, opts: Intl.DateTimeFormatOptions, tz: string | undefined) {
  try {
    return new Intl.DateTimeFormat(locale, tz ? { ...opts, timeZone: tz } : opts);
  } catch {
    return new Intl.DateTimeFormat(locale, opts);
  }
}

const parse = (iso: string): Date | null => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "Tue 23 Sep". */
export function formatDay(iso: string, tz?: string, locale?: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return dateFormatter(locale, { weekday: "short", day: "numeric", month: "short" }, tz).format(d);
}

/** "14:00". */
export function formatClock(iso: string, tz?: string, locale?: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return dateFormatter(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, tz).format(d);
}

/** "Tue 23 Sep, 14:02". */
export function formatDateTime(iso: string, tz?: string, locale?: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return `${formatDay(iso, tz, locale)}, ${formatClock(iso, tz, locale)}`;
}

/** "Tue 23 Sep · 14:00–15:30", or both days when the end falls on another day. */
export function formatWhen(start: string, end?: string | undefined, tz?: string, locale?: string): string {
  const s = parse(start);
  if (!s) return start;
  const day = formatDay(start, tz, locale);
  if (!end || !parse(end)) return `${day} · ${formatClock(start, tz, locale)}`;
  if (formatDay(end, tz, locale) === day) {
    return `${day} · ${formatClock(start, tz, locale)}–${formatClock(end, tz, locale)}`;
  }
  return `${day} ${formatClock(start, tz, locale)} – ${formatDay(end, tz, locale)} ${formatClock(end, tz, locale)}`;
}

/** Compact age for list rows: "now", "2m", "3h", "yesterday", "Mon", "23 Sep", "23 Sep 2025". */
export function relativeTime(iso: string, now: number = Date.now(), locale?: string): string {
  const d = parse(iso);
  if (!d) return "";
  const diff = now - d.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 2) return "yesterday";
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return new Intl.DateTimeFormat(
    locale,
    sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" },
  ).format(d);
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

export function initials(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((p) => p.charAt(0))
    .filter((c) => /\p{L}/u.test(c));
  return (parts.length > 1 ? `${parts[0]}${parts[parts.length - 1]}` : (parts[0] ?? "?")).toUpperCase();
}

export function titleFor(item: Item): string {
  return item.subject?.trim() || TYPE_WORD[item.type];
}

/** The second line of a list row: the fact that tells the item apart. */
export function snippetFor(item: Item, tz?: string, locale?: string): string {
  switch (item.type) {
    case "booking": {
      const p = item.payload;
      const parts = [formatWhen(p.startTime, p.endTime, tz, locale)];
      if (p.totalPrice) parts.push(formatMoney(p.totalPrice, locale));
      return parts.join(" · ");
    }
    case "order": {
      const p = item.payload;
      const first = p.orderedItem[0];
      const what =
        p.orderedItem.length === 1 && first ? `${first.quantity} × ${first.name}` : `${p.orderedItem.length} lines`;
      return `${what} · ${formatMoney(p.totalPrice, locale)}`;
    }
    case "quote_request":
      return truncate(item.payload.description, 90);
    case "message":
      return truncate(item.payload.text, 90);
    case "refund":
      return `${formatMoney(item.payload.amount, locale)} · ${truncate(item.payload.reason, 60)}`;
  }
}

export interface Address {
  readonly streetAddress?: string | undefined;
  readonly addressLocality?: string | undefined;
  readonly addressRegion?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly addressCountry?: string | undefined;
}

export function formatAddress(a: Address | undefined): string {
  if (!a) return "";
  return [
    a.streetAddress,
    [a.postalCode, a.addressLocality].filter(Boolean).join(" "),
    a.addressRegion,
    a.addressCountry,
  ]
    .filter((part) => part?.trim())
    .join(", ");
}

/** The currency an item already speaks, so forms about it use the same one. */
export function currencyOf(item: Item): string | undefined {
  switch (item.type) {
    case "booking":
      return item.payload.totalPrice?.currency;
    case "order":
      return item.payload.totalPrice.currency;
    case "quote_request":
      return item.payload.quote?.totalPrice.currency ?? item.payload.budget?.currency;
    case "refund":
      return item.payload.amount.currency;
    case "message":
      return undefined;
  }
}
