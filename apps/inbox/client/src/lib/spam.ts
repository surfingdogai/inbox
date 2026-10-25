import { formatDateTime, formatDay, formatMoney, partyName } from "./format";
import type { ItemSpamSummary, ItemView, SpamStatus } from "./types";

/**
 * The spam filter's words in the owner app (ADR-029 §11), pure so they are tested on both runtimes.
 * Our own sentences only: the owner never reads a model's prose, only what the code found.
 */

export const HELD_TOP =
  "Held until the sender confirms or you let them in. No rule ran, and you weren't alerted, except once on your phone for a booking in the next two days. Bookings here hold no time.";
export const SPAM_TOP = "Put aside. Not spam moves one back.";
export const HELD_EMPTY = "Nothing held.";
export const SPAM_EMPTY = "Nothing put aside.";
export const MAY_BE_CUSTOMER = "May be a customer";

/** How long what is put aside is kept, under the empty Spam list. */
export function keepLine(keepDays: number): string {
  return keepDays > 0
    ? `Put-aside messages are kept ${keepDays} days.`
    : "Put-aside messages are kept until you choose a time in Settings → Spam.";
}

/** Who sent it, as a Held row names them: the name they gave, else their email's domain. */
export function heldWho(view: ItemView): string {
  const name = view.party?.name?.trim();
  if (name) return name;
  const email = view.party?.email ?? view.spam?.sender.address ?? null;
  if (email?.includes("@")) return email.slice(email.lastIndexOf("@") + 1);
  return partyName(view.party);
}

/** What a held request is for: "Booking request for Fri 30 Oct, 15:00", "Quote request", "Order". */
export function heldWhat(view: ItemView, tz?: string, locale?: string): string {
  const { item } = view;
  if (item.type === "booking") return `Booking request for ${formatDateTime(item.payload.startTime, tz, locale)}`;
  if (item.type === "order") return "Order";
  if (item.type === "quote_request") return "Quote request";
  return "Message";
}

/** The row's tag: "May be a customer" for those listed first, else the chip of why it waits. */
export function rowTag(spam: ItemSpamSummary | undefined): string {
  if (!spam) return "";
  if (spam.screen === "held" && spam.may_be_customer) return MAY_BE_CUSTOMER;
  return spam.chip;
}

/** Held rows with "May be a customer" first, each group in the order the list gave. */
export function heldOrder(views: readonly ItemView[]): ItemView[] {
  return [...views].sort((a, b) => Number(b.spam?.may_be_customer === true) - Number(a.spam?.may_be_customer === true));
}

/** The chip a desk row carries before its subject when the filter delivered it with a label. */
export function deskChip(view: ItemView): string {
  if (view.spam?.screen === "warned") return view.spam.chip;
  return "";
}

/** What a labelled item says in itself (§11.2): what it may be, and why it came anyway. */
export function warnSentence(cause: string | null | undefined): string {
  const what = cause === "pitches" ? "a sales pitch" : cause === "scams" ? "a scam" : cause === "junk" ? "junk" : null;
  return what ? `This may be ${what}. It came to you because the filter wasn't sure.` : "";
}

/** "by the spam filter" · "by the AI check" · "by you" · "by a mail server". */
export function byWords(by: string): string {
  switch (by) {
    case "ai_check":
      return "by the AI check";
    case "you":
      return "by you";
    case "mail_server":
      return "by a mail server";
    default:
      return "by the spam filter";
  }
}

/** The quote lines under Why it's here: our frame, the sender's words between curly quotes. */
export function quoteLine(quote: string): string {
  return `It says: “${quote.replace(/\s+/g, " ").trim()}”`;
}

// ---- what the owner does, and what the toast says --------------------------------------------

/** The four things a person does with what the filter decided, and the two choices after them. */
export type SpamAct = "let_in" | "not_spam" | "looks_fine" | "spam";

export interface ToastCopy {
  readonly text: string;
  /** The small follow-up offered under the toast, when there is one. */
  readonly follow?: { readonly kind: "let_domain" | "block" | "suggest_time"; readonly label: string } | undefined;
}

/** Whether a booking's asked-for time has passed: Let it in then offers another time. */
export function timePassed(view: ItemView, now: number = Date.now()): boolean {
  return view.item.type === "booking" && Date.parse(view.item.payload.startTime) <= now;
}

/** The toast for each act (ADR-029 §11.3), with its one follow-up. */
export function toastFor(act: SpamAct, view: ItemView, now: number = Date.now()): ToastCopy {
  const sender = view.spam?.sender;
  const address = sender?.address ?? view.party?.email ?? null;
  if (act === "let_in") {
    if (timePassed(view, now)) {
      return {
        text: "Let in. The time asked for has passed: suggest another.",
        follow: { kind: "suggest_time", label: "Suggest another time" },
      };
    }
    // Let it in lets that one sender through, never their whole domain: named by their name, else by
    // their full address.
    const name = view.party?.name?.trim();
    if (name) return { text: `Let in. ${name} comes straight to you from now on.` };
    if (address) return { text: `Let in. Messages from ${address} come straight to you from now on.` };
    return {
      text:
        sender?.app === true || view.party?.kind === "agent"
          ? "Let in. Messages from this app come straight to you from now on."
          : "Let in. This sender comes straight to you from now on.",
    };
  }
  if (act === "not_spam" || act === "looks_fine") {
    const domain = sender?.company_domain ?? null;
    // Looks fine takes a label off something that was on the desk all along.
    const text =
      act === "looks_fine"
        ? address
          ? `Label taken off. Messages from ${address} come straight to you from now on.`
          : "Label taken off. This sender comes straight to you from now on."
        : address
          ? `Back in your inbox. Messages from ${address} won't be put aside again.`
          : "Back in your inbox. Messages from this sender won't be put aside again.";
    return {
      text,
      ...(domain ? { follow: { kind: "let_domain" as const, label: `Let everyone at ${domain} through` } } : {}),
    };
  }
  const app = sender?.app === true || (!address && view.party?.kind === "agent");
  return {
    text: "Put aside.",
    ...(address || app
      ? {
          follow: {
            kind: "block" as const,
            label: app ? "Always put aside messages from this app" : `Always put aside messages from ${address}`,
          },
        }
      : {}),
  };
}

/** What the follow-up did, said once it is done (it has no Undo: Settings → Spam lists it). */
export function followDone(kind: "let_domain" | "block", view: ItemView): string {
  const sender = view.spam?.sender;
  if (kind === "let_domain") return `Everyone at ${sender?.company_domain ?? "that domain"} comes straight in now.`;
  const address = sender?.address ?? view.party?.email;
  return address
    ? `Messages from ${address} will always be put aside.`
    : "Messages from this app will always be put aside.";
}

/** How long an act waits for Undo before it is sent. */
export const UNDO_MS = 6_000;

/**
 * Whether an act the inbox refused was done already: a Let it in (or a Not spam or Looks fine sent
 * as one) on something a reply or an answer let in first. Nothing to say to the owner then.
 */
export function alreadyDone(
  act: SpamAct,
  problem: { readonly code?: string; readonly details?: Record<string, unknown> | undefined },
): boolean {
  return act !== "spam" && problem.code === "wrong_state" && problem.details?.screen === "released";
}

/**
 * How far above the screen's bottom the Undo toast sits so it covers none of an action bar's buttons:
 * 12px over the bar's top, when one is shown along the bottom; null when none is.
 */
export function toastLift(barTop: number | null, viewportHeight: number): number | null {
  if (barTop === null || barTop <= 0 || barTop >= viewportHeight) return null;
  return Math.round(viewportHeight - barTop + 12);
}

/**
 * Which acts an item offers (§11.2): held → Let it in · Spam; put aside → Not spam; labelled →
 * Looks fine · Spam, where its own transitions allow Spam.
 */
export function actsFor(view: Pick<ItemView, "item" | "transitions" | "spam">): SpamAct[] {
  const screen = view.spam?.screen ?? null;
  const can = (event: string) => view.transitions.some((t) => t.event === event);
  if (screen === "held" || screen === "pending") return ["let_in", "spam"];
  if (view.item.state === "spam" || screen === "aside") return ["not_spam"];
  if (screen === "warned") return can("mark_spam") ? ["looks_fine", "spam"] : ["looks_fine"];
  return [];
}

export const ACT_LABEL: Readonly<Record<SpamAct, string>> = {
  let_in: "Let it in",
  not_spam: "Not spam",
  looks_fine: "Looks fine",
  spam: "Spam",
};

// ---- Settings → Spam --------------------------------------------------------------------------

export const SETTINGS_INTRO =
  "What isn't from a customer waits under Spam or Held instead of on your desk, kept for as long as you choose, one tap back. You aren't alerted, except once on your phone for a booking held for the next two days.";
export const BASIC_LINE =
  "Stops form bots, mail a server already marked as spam, senders posing as you, disguised links, the same message from many senders, and floods of new requests from one sender.";
export const BASIC_FREE =
  "Free, and nothing it reads leaves your inbox. A new sender's mail domain is looked up in DNS with an AI check, never without one.";
export const FILTERS_LINE = "Each one reads new messages from people you haven't dealt with before.";
export const ONLY_YOU = "Only you can change this, signed in.";

export const FILTER_COPY: Readonly<Record<"pitches" | "scams" | "junk", { title: string; line: string }>> = {
  pitches: { title: "Sales pitches", line: "SEO, guest posts, websites, ads and leads you didn't ask for." },
  scams: { title: "Scams", line: "False invoices, changed bank details, account and domain warnings, review threats." },
  junk: { title: "Junk", line: "Random text, link lists, adult, gambling and crypto promotion." },
};

/** "This month: {n} put aside · {h} held · {b} brought back", under Basic protection. */
export function basicMonth(s: Pick<SpamStatus, "this_month">): string {
  return `This month: ${s.this_month.aside} put aside · ${s.this_month.held} held · ${s.this_month.brought_back} brought back`;
}

/** "This month: {n} put aside · {m} brought back", under a filter that is on. */
export function filterMonth(f: SpamStatus["filters"][number]): string {
  return `This month: ${f.this_month.aside} put aside · ${f.this_month.brought_back} brought back`;
}

/** "Learning until {date}: …", under a filter in its learning week. */
export function learningLine(until: string, tz?: string, locale?: string): string {
  return `Learning until ${formatDay(until, tz, locale)}: it labels what it would put aside, and puts nothing aside yet.`;
}

/** Who reads for the filters, as Settings says it (§11.4). */
export function readerLine(
  s: Pick<SpamStatus, "reader" | "model" | "reader_name" | "checks">,
  tz?: string,
  locale?: string,
): string {
  if (s.checks.resting_until) {
    return `The AI check is resting until ${formatDay(s.checks.resting_until, tz, locale)}: more new messages than usual. Until then the filters look for known phrases only.`;
  }
  switch (s.reader) {
    case "hosted_ai":
      return s.reader_name
        ? `Read by ${s.reader_name}, an AI service we pay for, only for new senders, with email addresses, phone numbers and bank details taken out. It keeps nothing.`
        : "Read by an AI service we pay for, only for new senders, with email addresses, phone numbers and bank details taken out. It keeps nothing.";
    case "hosted_phrases":
      return "For now the filters look for known phrases only. Reading by AI comes later, and you'll be told first.";
    case "own_model":
      return s.model
        ? `Read by ${s.model.model} from ${s.model.provider}, set up for this inbox.`
        : "Read by your own AI model, set up for this inbox.";
    default:
      return "Without an AI model, the filters look for known phrases only.";
  }
}

/** The link after the reader line, on one's own server with no model: the one place to connect one. */
export const CONNECT_MODEL = "Connect one in Settings → Integrations";

/**
 * Whether Settings → Spam speaks of the owner's own model's use (the month's checks, the cap, what the
 * provider charges): on their own server, with a model connected. Without one there is nothing to count.
 */
export function showsModelUse(s: Pick<SpamStatus, "reader" | "billing">): boolean {
  return s.billing.state === "self_hosted" && s.reader === "own_model";
}

/** Model ids that name a provider's smaller, cheaper models: what the spam check needs. */
const SMALL_MODEL = /haiku|mini|nano|flash|lite|small/i;

/**
 * The model the chooser starts on: the provider's first small one (the list comes small first), else
 * none, so the owner, who pays per check, picks a large one only on purpose.
 */
export function defaultModel(models: readonly { readonly id: string }[]): string {
  return models.find((m) => SMALL_MODEL.test(m.id))?.id ?? "";
}

/** A month's price for one filter, in the currency the host bills. */
export function priceText(price: { currency: string; per_filter_month_minor: number }): string {
  return formatMoney({ value: price.per_filter_month_minor, currency: price.currency.toUpperCase() });
}

/** What the filters cost here (§11.4); own server: what the owner's model was used for this month. */
export function priceLine(s: Pick<SpamStatus, "billing" | "checks">): string {
  if (s.billing.state === "self_hosted") {
    const words = Math.round((s.checks.tokens_this_month * 3) / 4);
    return `${s.checks.this_month.toLocaleString("en")} checked by your model this month · ${words.toLocaleString("en")} words of model time.`;
  }
  if (s.billing.state === "on" && s.billing.price) {
    return `${priceText(s.billing.price)} a month for each filter that's on, counted by the day.`;
  }
  return "Free while hosted inboxes are free. If that changes, you'll be told 30 days ahead and asked first.";
}

/** The sheet that opens when a filter is switched on, on a hosted inbox. */
export function turnOnSheet(
  filter: "pitches" | "scams" | "junk",
  s: Pick<SpamStatus, "reader" | "model" | "reader_name" | "checks" | "billing">,
  tz?: string,
): { title: string; text: string } {
  const title = FILTER_COPY[filter].title;
  const money =
    s.billing.state === "on" && s.billing.price
      ? `${priceText(s.billing.price)} a month while it's on, counted by the day.`
      : "Free while hosted inboxes are free; we'll ask before charging anything.";
  return {
    title: `Turn on ${title}?`,
    text: `It reads new messages from people you haven't dealt with before. ${readerLine(s, tz)} ${money}`,
  };
}

/** The most checks a month the owner's own model may make (own server). */
export const MONTHLY_CHECKS: readonly { readonly value: 0 | 500 | 2000 | 10000; readonly label: string }[] = [
  { value: 500, label: "500" },
  { value: 2000, label: "2,000" },
  { value: 10000, label: "10,000" },
  { value: 0, label: "No limit" },
];

export const KEEP_CHOICES: readonly { readonly value: 0 | 30 | 90; readonly label: string }[] = [
  { value: 0, label: "Keep them" },
  { value: 90, label: "90 days" },
  { value: 30, label: "30 days" },
];

/** Under Keep what's put aside: what goes whatever the choice. */
export const KEEP_BOTS = "A bot's form messages go after seven days.";

/** The Test result on the Your AI model card (§11.5). */
export function testLine(t: { readonly pitch: boolean; readonly customer: boolean }): string {
  const pitch = t.pitch ? "a sales pitch was spotted" : "the sales pitch wasn't spotted";
  const customer = t.customer
    ? "a customer asking a price in Japanese came through"
    : "a customer asking a price in Japanese wasn't let through";
  return `Checked two samples: ${pitch}; ${customer}.`;
}

/** Why a Test could not finish, in the owner's words. */
export function testFailed(why: string): string {
  if (why === "auth") return "The provider didn't accept the key. Paste it again.";
  if (why === "timeout") return "The model took too long to answer. Try again, or choose a smaller model.";
  if (why === "refused") return "The model declined to answer. Choose another model.";
  if (why.startsWith("invalid")) return "The model's answer didn't follow the form. Choose another model.";
  return "The model couldn't be reached just now. Try again in a minute.";
}

/** The Your AI model card's own lines. */
export const MODEL_INTRO = "Used to read new messages for the spam filters. Later, for other help you switch on.";
export const MODEL_HINT = "Smaller models cost less and are enough here.";
export const GEMINI_NOTE = "On Google's free tier, what you send may be used to improve its products. Use a paid key.";
