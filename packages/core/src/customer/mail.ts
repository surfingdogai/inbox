import type { Item, Money } from "../domain/types";
import { type CopyVars, cap, copyFor, vars } from "./copy";
import { type Audience, statusSentence, subjectIn, whatOf } from "./describe";
import { moneyIn, oneLine, shortRef, whenText } from "./format";
import type { CustomerLang } from "./lang";
import type { LinkAction } from "./links";

/**
 * Every email the business sends its customer, put together: in the customer's language, times in
 * the business's zone with the zone named, the price and the total, until when to answer, the links
 * to answer with, and a footer with the six-character reference and the business's name. Pure, so
 * every wording is pinned by tests on both runtimes (`test/customer-mail.test.ts`).
 *
 * The customer wrote to the business, so the email is the business speaking: nothing in it names
 * the software, a network or anybody else. An email a rule or the business's assistant caused says
 * so in one line, in the business's words (`automated`), instead of "reply to reach us".
 */
export interface CustomerMailInput {
  readonly item: Item;
  /** What happened: a transition's event, `create` (the acknowledgement) or `message` (a reply). */
  readonly event: string;
  /** The state the change left, when a change caused the email. */
  readonly fromState?: string | null | undefined;
  /** Who caused it: the actor kind of the transition or of the reply. */
  readonly actorKind?: string | null | undefined;
  /** The business's own words with it: a reply, or the note written with the change. */
  readonly words?: string | null | undefined;
  /**
   * Nobody at the business wrote or decided it: a rule or the business's assistant did. Defaults to
   * what `actorKind` says (`isAutomated`).
   */
  readonly automated?: boolean | undefined;
  readonly lang: CustomerLang;
  /** The business's time zone: every time is written in it, with the zone named. */
  readonly timezone: string;
  /** The business's name, or empty. */
  readonly business: string;
  /** The customer's name, when they gave one. */
  readonly name?: string | null | undefined;
  /** The links that answer what we asked or proposed; none when links cannot be made. */
  readonly links?: ReadonlyMap<LinkAction, string> | null | undefined;
  /** What an accepted quote became. */
  readonly linked?: Item | null | undefined;
  /** The request holds a price that is not ours yet (ADR-018 §3.2). */
  readonly unpriced?: boolean | undefined;
  /** Minutes before a confirmed booking until which the customer may cancel. */
  readonly cancellationWindowMin?: number | undefined;
  /** Minutes before a proposed time until which the customer can take it. */
  readonly minNoticeMin?: number | undefined;
  /** The quote replaces an earlier one. */
  readonly revised?: boolean | undefined;
  readonly now?: number | undefined;
}

export interface RenderedMail {
  /** Which email it is, as the mail log and the owner's app name it: `booking.proposed`, `ack.order`, … */
  readonly template: string;
  readonly subject: string;
  readonly text: string;
}

/**
 * The actors whose doing an email says was automatic, because no person typed it (Tiago, 23
 * September 2026): a rule, the business's own assistant, a key the owner gave another system (a
 * CRM, an automation tool) and a shop's connector.
 */
export const AUTOMATED_KINDS: ReadonlySet<string> = new Set(["rule", "owner_ai", "integration", "connector"]);

/**
 * Whether a reply or a change was automatic: a rule's, the business's assistant's (an AI app with
 * its own key, or anything through the owner's MCP door, even with a full owner key — the test the
 * `security` settings and `isPerson` use), another system's, or anything its request said nobody
 * typed (`written_by: automation`). An integration whose request says a person wrote it
 * (`written_by: person`, `effectiveWrittenBy`) is not.
 */
export function isAutomated(
  actorKind: string | null | undefined,
  channel?: string | null | undefined,
  writtenBy?: string | null | undefined,
): boolean {
  if (writtenBy === "automation" || channel === "mcp_owner") return true;
  if (writtenBy === "person" && actorKind === "integration") return false;
  return actorKind ? AUTOMATED_KINDS.has(actorKind) : false;
}

/**
 * What is kept of a request's `written_by`: `automation` from anyone; `person` only from an
 * integration key outside the owner's MCP (the owner in the app is a person already, and the owner's
 * AI never is); nothing otherwise.
 */
export function effectiveWrittenBy(
  caller: {
    readonly actor: { readonly kind: string; readonly channel: string };
    readonly principal?: { readonly keyKind?: string | undefined } | undefined;
  },
  requested: string | null | undefined,
): "person" | "automation" | null {
  if (requested === "automation") return "automation";
  if (
    requested === "person" &&
    caller.actor.kind === "integration" &&
    caller.principal?.keyKind === "integration" &&
    caller.actor.channel !== "mcp_owner"
  ) {
    return "person";
  }
  return null;
}
const CUSTOMER_KINDS: ReadonlySet<string> = new Set(["customer_agent", "customer_human"]);

interface Body {
  readonly template: string;
  readonly subject: string;
  /** Paragraphs: each a list of lines, a blank line between them. */
  readonly blocks: readonly (readonly string[])[];
  /** The business's words go in their own paragraph after these, unless the body already holds them. */
  readonly wordsUsed?: boolean;
  /** No greeting: a reply is the business's own words, greeting and all. */
  readonly bare?: boolean;
}

export function renderCustomerMail(input: CustomerMailInput): RenderedMail {
  const c = copyFor(input.lang);
  const body = bodyOf(input);
  const words = input.words?.trim() || "";
  const automated = input.automated ?? isAutomated(input.actorKind);
  const answer = answerLines(input.item, input.links ?? null, input.lang);
  const blocks: (readonly string[])[] = [];
  if (!body.bare) blocks.push([c.email.hello(vars({ name: oneLine(input.name) }))]);
  blocks.push(...body.blocks.filter((b) => b.length > 0));
  if (words && !body.wordsUsed) blocks.push([words]);
  if (answer.length) blocks.push(answer);
  const ref = shortRef(input.item.id);
  blocks.push([
    ...(automated ? [c.email.automated] : []),
    c.email.reference(vars({ ref })),
    ...(automated ? [] : [c.email.replyToReach]),
  ]);
  if (input.business.trim()) blocks.push([input.business.trim()]);
  return {
    template: body.template,
    // A subject is one line, whatever the request's subject held.
    subject: oneLine(body.subject),
    text: blocks.map((b) => b.join("\n")).join("\n\n"),
  };
}

/**
 * The lines that let the customer answer what we asked or proposed: a link for each answer, or,
 * where links cannot be made, the reply that does the same. Nothing when nothing waits for them.
 */
export function answerLines(item: Item, links: ReadonlyMap<LinkAction, string> | null, lang: CustomerLang): string[] {
  const c = copyFor(lang);
  const m = c.mail;
  const time = item.type === "booking" && item.state === "proposed" && item.payload.proposed;
  const quote = item.type === "quote_request" && item.state === "quoted" && item.payload.quote;
  const details = item.state === "needs_info";
  if (!time && !quote && !details) return [];
  if (!links || links.size === 0) return [details ? m.replyWithDetails : m.replyToAnswer];
  const line = (label: string, action: LinkAction) => {
    const url = links.get(action);
    return url ? [`${label}: ${url}`] : [];
  };
  if (time)
    return [...line(m.accept, "accept_time"), ...line(m.decline, "decline_time"), ...line(m.otherTime, "other_time")];
  if (quote) return [...line(m.accept, "accept_quote"), ...line(m.decline, "decline_quote")];
  const send = line(m.details, "details");
  return send.length ? [...send, c.email.details.orReply] : [m.replyWithDetails];
}

function bodyOf(input: CustomerMailInput): Body {
  const { item, lang } = input;
  const c = copyFor(lang);
  const e = c.email;
  const bare = subjectIn(item, lang) || cap(c.yourNoun[item.type]);
  const what = whatOf(item, lang) || c.yourNoun[item.type];
  const when = (iso: string) => whenText(iso, input.timezone, lang);
  const money = (m: Money | { value: number; currency: string }) => moneyIn(m, lang);
  const v = (extra: Partial<CopyVars> = {}) =>
    vars({ what, yourNoun: c.yourNoun[item.type], business: input.business, ...extra });
  // A subject names the thing without quotes.
  const s = (extra: Partial<CopyVars> = {}) => vars({ what: bare, yourNoun: c.yourNoun[item.type], ...extra });
  const byCustomer =
    (input.actorKind ? CUSTOMER_KINDS.has(input.actorKind) : false) || input.event.startsWith("record_cancel");
  const words = input.words?.trim() || "";

  // A reply the business wrote is the email; a sentence about it would only be in the way.
  if (input.event === "message" || (item.type === "message" && item.state === "answered" && input.event !== "create")) {
    return words
      ? { template: "reply", subject: e.reply(vars({ subject: bare })), blocks: [[words]], wordsUsed: true, bare: true }
      : { template: "message.answered", subject: e.reply(vars({ subject: bare })), blocks: [[e.answered(v())]] };
  }

  if (input.event === "create") {
    switch (item.type) {
      case "booking":
        return {
          template: "ack.booking",
          subject: e.ack.bookingSubject(s()),
          blocks: [
            [
              e.ack.booking(v({ when: when(item.payload.startTime) })),
              ...priceLines(input, item.payload.totalPrice),
              e.ack.bookingNext,
            ],
          ],
        };
      case "order":
        return {
          template: "ack.order",
          subject: e.ack.orderSubject(s()),
          blocks: [[e.ack.order], orderLines(input, item), [e.ack.orderNext]],
        };
      case "quote_request":
        return { template: "ack.quote", subject: e.ack.quoteSubject(s()), blocks: [[e.ack.quote(v())]] };
    }
  }

  switch (item.type) {
    case "booking": {
      const at = when(item.payload.startTime);
      switch (item.state) {
        case "confirmed": {
          const lines = [...priceLines(input, item.payload.totalPrice), ...cutoffLines(input, item)];
          if (input.event === "accept")
            return {
              template: "booking.accepted",
              subject: e.confirmed.subject(s()),
              blocks: [[e.confirmed.accepted(v({ when: at })), ...lines]],
            };
          if (input.event === "confirm" && input.fromState === "proposed")
            return {
              template: "booking.confirmed",
              subject: e.confirmed.subject(s()),
              blocks: [[e.confirmed.proposedTime(v({ when: at })), ...lines]],
            };
          return {
            template: "booking.confirmed",
            subject: e.confirmed.subject(s()),
            blocks: [[e.confirmed.first(v({ when: at })), ...lines]],
          };
        }
        case "requested":
          if (input.event === "counter")
            return {
              template: "booking.counter",
              subject: e.counter.subject(s()),
              blocks: [[e.counter.first(v({ when: at }))]],
            };
          break;
        case "proposed": {
          const p = item.payload.proposed;
          if (!p) break;
          const deadline = new Date(Date.parse(p.startTime) - (input.minNoticeMin ?? 0) * 60_000).toISOString();
          return {
            template: "booking.proposed",
            subject: e.proposed.subject(s()),
            blocks: [
              [
                e.proposed.first(v({ newWhen: when(p.startTime) })),
                e.proposed.youAsked(v({ askedWhen: at })),
                // A price of ours with the time we propose settles it; without one, the request's stands.
                ...priceLines(
                  p.totalPrice ? { ...input, unpriced: false } : input,
                  p.totalPrice ?? item.payload.totalPrice,
                ),
                e.proposed.answerBy(v({ deadline: when(deadline) })),
              ],
            ],
          };
        }
        case "needs_info":
          return detailsBody(input, v, s);
        case "declined":
          return {
            template: "declined",
            subject: e.declined.subject(s()),
            blocks: [[e.declined.booking(v({ when: at }))]],
          };
        case "cancelled_by_business":
          return {
            template: "cancelled.by_us",
            subject: e.cancelledByUs.subject(s()),
            blocks: [[e.cancelledByUs.booking(v({ when: at }))]],
          };
        case "cancelled_by_customer":
          // The customer said no to the time we proposed: their request is closed, as they chose.
          if (input.event === "cancel" && input.fromState === "proposed")
            return {
              template: "booking.declined_time",
              subject: e.declinedTime.subject(s()),
              blocks: [[e.declinedTime.first(v())], [e.declinedTime.next]],
              // What they told us when they declined is theirs, never ours to send back.
              wordsUsed: true,
            };
          return {
            template: "cancelled.as_asked",
            subject: e.cancelledAsAsked.subject(s()),
            blocks: [
              [
                input.fromState === "confirmed"
                  ? e.cancelledAsAsked.booking(v({ when: at }))
                  : e.cancelledAsAsked.request(v()),
              ],
            ],
            wordsUsed: true,
          };
      }
      break;
    }
    case "order": {
      const url = item.payload.paymentUrl;
      switch (item.state) {
        case "needs_info":
          return detailsBody(input, v, s);
        case "accepted":
          return {
            template: "order.accepted",
            subject: e.order.acceptedSubject(s()),
            blocks: [[e.order.accepted(v())], orderLines(input, item)],
          };
        case "awaiting_payment":
          return {
            template: "order.awaiting_payment",
            subject: e.order.paymentSubject(s()),
            blocks: [
              [
                e.order.payment(v({ total: money(item.payload.totalPrice) })),
                ...(url ? [e.order.payHere(v({ url }))] : []),
              ],
            ],
          };
        case "paid":
          return {
            template: "order.paid",
            subject: e.order.paidSubject(s()),
            blocks: [
              [
                item.payload.totalPrice.value > 0
                  ? e.order.paid(v({ amount: money(item.payload.totalPrice) }))
                  : e.order.paidNoAmount(v()),
              ],
            ],
          };
        case "payment_failed":
          return {
            template: "order.payment_failed",
            subject: e.order.failedSubject(s()),
            blocks: [[e.order.failed(v()), ...(url ? [e.order.payStill(v({ url }))] : [])]],
          };
        case "fulfilled":
          return {
            template: "order.fulfilled",
            subject: e.order.fulfilledSubject(s()),
            blocks: [[e.order.fulfilled(v())]],
          };
        case "declined":
          return { template: "declined", subject: e.declined.subject(s()), blocks: [[e.declined.order(v())]] };
        case "cancelled":
          return byCustomer
            ? {
                template: "cancelled.as_asked",
                subject: e.cancelledAsAsked.subject(s()),
                blocks: [[e.cancelledAsAsked.order(v())]],
                wordsUsed: true,
              }
            : {
                template: "cancelled.by_us",
                subject: e.cancelledByUs.subject(s()),
                blocks: [[e.cancelledByUs.order(v())]],
              };
      }
      break;
    }
    case "quote_request": {
      switch (item.state) {
        case "accepted": {
          const linked = input.linked;
          if (linked?.type === "booking") {
            return {
              template: "quote.accepted",
              subject: e.quoteAccepted.subject(s()),
              blocks: [
                [
                  e.quoteAccepted.booking(v({ when: when(linked.payload.startTime) })),
                  ...(linked.payload.totalPrice ? [e.total(v({ total: money(linked.payload.totalPrice) }))] : []),
                ],
              ],
            };
          }
          if (linked?.type === "order") {
            return {
              template: "quote.accepted",
              subject: e.quoteAccepted.subject(s()),
              blocks: [[e.quoteAccepted.order(v()), e.total(v({ total: money(linked.payload.totalPrice) }))]],
            };
          }
          break;
        }
        case "needs_info":
          return detailsBody(input, v, s);
        case "quoted": {
          const q = item.payload.quote;
          if (!q) break;
          const notes = q.notes?.trim() ?? "";
          return {
            template: "quote.quoted",
            subject: e.quoted.subject(s()),
            blocks: [
              [
                input.revised ? e.quoted.revised(v()) : e.quoted.first(v()),
                ...q.lines.map((l) => `${l.quantity} × ${l.name} — ${money(times(l.price, l.quantity))}`),
                e.total(v({ total: money(q.totalPrice) })),
                ...(q.creates === "booking" && q.startTime ? [e.quoted.forWhen(v({ when: when(q.startTime) }))] : []),
                e.quoted.holds(v({ validThrough: when(q.validThrough) })),
              ],
              notes ? [notes] : [],
              // The note written with the quote, when it says something the quote's own notes do not.
              words && words !== notes ? [words] : [],
            ],
            wordsUsed: true,
          };
        }
        case "declined":
          return byCustomer
            ? {
                template: "quote.declined",
                subject: e.quoteDeclined.subject(s()),
                blocks: [[e.quoteDeclined.first(v())]],
                wordsUsed: true,
              }
            : { template: "declined", subject: e.declined.subject(s()), blocks: [[e.declined.quote(v())]] };
      }
      break;
    }
    case "refund": {
      switch (item.state) {
        case "approved":
          return { template: "refund.approved", subject: e.refund.subject, blocks: [[e.refund.approved]] };
        case "rejected":
          return { template: "refund.rejected", subject: e.refund.subject, blocks: [[e.refund.rejected]] };
        case "refunded":
          return {
            template: "refund.refunded",
            subject: e.refund.subject,
            blocks: [[e.refund.refunded(v({ amount: money(item.payload.amount) }))]],
          };
      }
      break;
    }
  }
  // Anything else: that there is news, and what it is, in the words the status door uses.
  const audience: Audience = { lang, timezone: input.timezone, minNoticeMin: input.minNoticeMin ?? 0 };
  const status = statusSentence(item, audience).replace(
    ` ${lang === "pt" ? "Referência" : "Reference"} ${shortRef(item.id)}.`,
    "",
  );
  return { template: "news", subject: e.news.subject(s()), blocks: [[e.news.first(v())], [status]] };
}

/** We asked the customer something: the question, and how to answer it. */
function detailsBody(
  input: CustomerMailInput,
  v: (extra?: Partial<CopyVars>) => CopyVars,
  s: (extra?: Partial<CopyVars>) => CopyVars,
): Body {
  const e = copyFor(input.lang).email;
  const words = input.words?.trim() || "";
  return {
    template: "needs_info",
    subject: e.details.subject(s()),
    blocks: [[e.details.first(v())], words ? [words] : []],
    wordsUsed: true,
  };
}

/** The price of a booking: ours, or that we will confirm it; nothing when it has none. */
function priceLines(input: CustomerMailInput, price: Money | undefined): string[] {
  const c = copyFor(input.lang);
  if (input.unpriced) return [c.email.priceToConfirm];
  if (!price) return [];
  return [c.price(vars({ total: moneyIn(price, input.lang) }))];
}

/** Until when a confirmed booking can be cancelled, while that is still ahead. */
function cutoffLines(input: CustomerMailInput, item: Extract<Item, { type: "booking" }>): string[] {
  const window = input.cancellationWindowMin ?? 0;
  if (window <= 0) return [];
  const cutoff = Date.parse(item.payload.startTime) - window * 60_000;
  if (!Number.isFinite(cutoff) || cutoff <= (input.now ?? Date.now())) return [];
  const c = copyFor(input.lang);
  return [
    c.email.confirmed.cutoff(vars({ cutoff: whenText(new Date(cutoff).toISOString(), input.timezone, input.lang) })),
  ];
}

/** An order's lines, one each, then the total: a line whose price is ours to set says so. */
function orderLines(input: CustomerMailInput, item: Extract<Item, { type: "order" }>): string[] {
  const c = copyFor(input.lang);
  const lines = item.payload.orderedItem.map((l) => {
    const open = input.unpriced && !l.productId;
    return `${l.quantity} × ${l.name} — ${open ? c.email.lineToConfirm : moneyIn(times(l.price, l.quantity), input.lang)}`;
  });
  return [
    ...lines,
    input.unpriced
      ? c.email.priceToConfirm
      : c.email.total(vars({ total: moneyIn(item.payload.totalPrice, input.lang) })),
  ];
}

function times(price: Money, quantity: number): Money {
  return { ...price, value: price.value * quantity };
}
