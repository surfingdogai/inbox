import type { Customer, Item, ItemType, ItemView, Money, Party, Receipt } from "./types";

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
  payment_failed: "Payment failed",
  charged_back: "Charged back",
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
const WARNING_STATES = new Set(["needs_info", "awaiting_payment", "payment_failed", "proposed"]);
const DANGER_STATES = new Set([
  "declined",
  "charged_back",
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
  cancel_late: "Cancelled late",
  cancel_by_business: "Cancelled",
  complete: "Completed",
  no_show: "Marked as no-show",
  request_payment: "Payment requested",
  record_payment: "Payment recorded",
  payment_failed: "Payment failed",
  lapse: "Lapsed: no payment came",
  charge_back: "Charged back",
  record_charge_back: "Charge-back recorded",
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
  rule_skipped: "Rule held back",
};

export function eventWord(event: string): string {
  return EVENT_WORDS[event] ?? capitalise(event.replaceAll("_", " "));
}

const ACTOR_WORDS: Record<string, string> = {
  owner: "you",
  staff: "staff",
  owner_ai: "your AI",
  integration: "a key",
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

/** Who caused an event, with the key's or the AI app's name when the history has it: "the key “Zapier”". */
export function byWord(by: { kind: string; name?: string | undefined } | undefined, actor: string): string {
  if (!by) return actorWord(actor);
  const word = ACTOR_WORDS[by.kind] ?? by.kind;
  if (!by.name) return word;
  return by.kind === "owner_ai" ? `your AI “${by.name}”` : by.kind === "integration" ? `the key “${by.name}”` : word;
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

/** Who is asking: the name, else the email, else what little we know. */
export function partyName(party: Party | undefined): string {
  if (party?.name?.trim()) return party.name.trim();
  if (party?.email) return party.email;
  return party?.kind === "agent" ? "An agent" : "Someone";
}

/** "Rita Amaral · Full service": a row's first line. */
export function rowTitle(view: ItemView): string {
  const subject = view.item.subject?.trim();
  return `${partyName(view.party)} · ${subject || TYPE_WORD[view.item.type]}`;
}

/** The calendar day (YYYY-MM-DD) of an instant in a time zone, so "today" is the business's today. */
export function localDateKey(at: string | number, tz?: string): string {
  const d = typeof at === "number" ? new Date(at) : parse(at);
  if (!d) return "";
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
  return dateFormatter("en-CA", opts, tz).format(d);
}

const OUTCOME_WORDS: Record<string, string> = {
  "booking.completed": "Completed",
  "order.fulfilled": "Fulfilled",
  "booking.cancelled_by_business": "Cancelled by you",
  "order.not_fulfilled": "Not fulfilled",
  "booking.no_show_customer": "No-show",
  "booking.cancelled_late_by_customer": "Cancelled late by the customer",
  "order.payment_failed": "Payment failed",
  "order.charged_back": "Charged back",
  "booking.cancelled_by_customer": "Cancelled by the customer",
  "order.cancelled_by_customer": "Cancelled by the customer",
  "order.lapsed": "Lapsed unpaid",
};

const RECEIPT_KIND_WORDS: Record<string, string> = { confirmed: "Confirmed", paid: "Paid", accepted: "Accepted" };

/**
 * What a receipt attests, in a word or three: "Confirmed", "Paid", "Accepted" for a promise, and
 * for an outcome how it ended — "Completed", "No-show" — marked "automatically" when the system
 * recorded it (ADR-017 §3).
 */
export function receiptWord(r: Pick<Receipt, "kind" | "outcome" | "payload">): string {
  if (r.kind !== "outcome") return RECEIPT_KIND_WORDS[r.kind] ?? capitalise(r.kind);
  const word = (r.outcome && OUTCOME_WORDS[r.outcome]) ?? "Outcome";
  return (r.payload as { aut?: unknown }).aut === 1 ? `${word} automatically` : word;
}

/**
 * Who is asking, beyond a name (ADR-017 §8.2, §8.3), in the few words the owner needs: whether it
 * may be a customer they know (unconfirmed), is one ("a customer you know", with the history that
 * says so), and how the agent signed. How each network knows the person is `personStandings`.
 * Empty for an item that says nothing more than its party.
 */
export interface CustomerNote {
  readonly tone: Tone;
  readonly text: string;
}

export function customerNotes(c: Customer | undefined, currency: string, locale?: string): CustomerNote[] {
  if (!c) return [];
  const out: CustomerNote[] = [];
  if (c.match === "weak" && c.possible) {
    out.push({ tone: "warning", text: `May be ${c.possible.name ?? "a customer you know"}, unconfirmed` });
  }
  if (c.known) {
    const h = c.history;
    const parts = [
      `${h.completed} completed`,
      ...(h.no_shows ? [`${h.no_shows} no-show${h.no_shows === 1 ? "" : "s"}`] : []),
      ...(h.late_cancellations
        ? [`${h.late_cancellations} late cancellation${h.late_cancellations === 1 ? "" : "s"}`]
        : []),
      ...(h.payment_failed ? [`${h.payment_failed} failed payment${h.payment_failed === 1 ? "" : "s"}`] : []),
      ...(h.charged_back ? [`${h.charged_back} charge-back${h.charged_back === 1 ? "" : "s"}`] : []),
      ...(h.largest_paid ? [`largest paid ${formatMoney({ value: h.largest_paid, currency }, locale)}`] : []),
    ];
    out.push({ tone: "success", text: `A customer you know: ${parts.join(", ")}` });
  }
  if (c.agent.level === "vouched") {
    out.push({ tone: "neutral", text: `Signed agent of ${(c.agent.platform ?? "").replace(/^https:\/\//, "")}` });
  } else if (c.agent.level === "self" && c.agent.platform) {
    // A platform's key that no network the business uses recognises: signed, and nothing more.
    out.push({
      tone: "neutral",
      text: `Signed agent (key from ${c.agent.platform.replace(/^https:\/\//, "")}, a platform your networks do not recognise)`,
    });
  } else if (c.agent.level === "self") {
    out.push({ tone: "neutral", text: "Signed agent" });
  }
  return out;
}

const TIER_WORDS: Record<string, string> = { new: "New", building: "Building a record", trusted: "Trusted" };

/**
 * How each network knows the person (ADR-017 §2.2, §5.3), one row per network, in plain words:
 * the tier, what their record is made of, since when the network has known them, and whether it
 * said so with this request or earlier. A business sees a person's standing only when their
 * assistant presents it, so there is no row for a network that never did.
 *
 *   { network: "network.surfingdog.ai", tier: "Trusted",
 *     text: "14 kept, 1 broken, at 5 businesses. Known there since March 2026; address proven." }
 */
export interface PersonStanding {
  readonly network: string;
  readonly tier: string;
  readonly tone: Tone;
  readonly text: string;
  /** "With this request", or when a network last said it. */
  readonly when: string;
  /** Said only when the network flagged the pass; it still works (R25). */
  readonly caution: string | null;
}

export function personStandings(c: Customer | undefined, locale?: string, tz?: string): PersonStanding[] {
  if (!c) return [];
  return c.persons.map((p) => {
    const host = p.network.replace(/^https:\/\//, "");
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const record =
      p.kept === 0 && p.broken === 0
        ? "No record there yet"
        : `${p.kept} kept, ${p.broken} broken${p.businesses > 0 ? `, at ${plural(p.businesses, "business", "businesses")}` : ""}`;
    const since = p.since
      ? `Known there since ${dateFormatter(locale, { month: "long", year: "numeric" }, tz).format(new Date(p.since))}`
      : null;
    const facts = [since, p.email_proven ? "address proven" : null].filter((f): f is string => f !== null);
    return {
      network: host,
      tier: TIER_WORDS[p.tier] ?? capitalise(p.tier),
      tone: p.tier === "trusted" ? "success" : "neutral",
      text: `${record}.${facts.length ? ` ${capitalise(facts.join("; "))}.` : ""}`,
      when: p.seen === "this_item" ? "With this request" : `As last presented, ${formatDateTime(p.as_of, tz, locale)}`,
      caution: p.unusual_use
        ? "Their pass was used at many businesses in a day, or by two assistants' keys. It still works; the person can replace it."
        : null,
    };
  });
}
