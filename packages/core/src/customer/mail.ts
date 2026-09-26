import type { Item, Money } from "../domain/types";
import { type CopyVars, cap, copyFor, type ExceptionWords, vars, withdrawalCopy } from "./copy";
import { type Audience, personalisedLine, statusSentence, subjectIn, whatOf } from "./describe";
import { moneyIn, oneLine, shortRef, whenText } from "./format";
import type { CustomerLang } from "./lang";
import type { LinkAction } from "./links";
import { isChangeable, type OfferTerms, openChange, timeDeadline } from "./offer";

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
  /** The quote, the time or the changes replace what we proposed before. */
  readonly revised?: boolean | undefined;
  /** Until when what lapsed could have been accepted: for the email that says it lapsed. */
  readonly lapsedAt?: string | null | undefined;
  /**
   * The change this email is about, as the event that closed it found it: who asked for it, and the
   * promise as it would have been. For the email that says it was not made.
   */
  readonly closedChange?: { readonly by: "business" | "customer"; readonly terms: OfferTerms } | null | undefined;
  /**
   * The right of withdrawal as it stands for this booking or order (ADR-018 §7): the confirmations
   * carry it — the period and the link to withdraw, or why there is none — with the model form and
   * who we are in the first of them.
   */
  readonly withdrawal?: MailWithdrawal | null | undefined;
  /** Who the business is (`commerce.legal`), for the confirmations: name, address, how to reach it, its VAT number. */
  readonly trader?: MailTrader | null | undefined;
  /** The return or refund the change made (a withdrawal, a paid order cancelled), for the email about it. */
  readonly refund?: Item | null | undefined;
  /** The business's return policy, as far as the emails say it. */
  readonly returns?: { readonly respondHours: number; readonly postage: "customer" | "business" } | undefined;
  readonly now?: number | undefined;
}

export interface MailWithdrawal {
  readonly available: boolean;
  /** When the period ends, once it has begun. */
  readonly until: string | null;
  readonly kind: "goods" | "service";
  /** Why there is no right, when the product or service is excepted. */
  readonly exception?: keyof ExceptionWords | null | undefined;
  readonly law: "eu" | "pt" | "uk";
  /** The period in days. */
  readonly days: number;
}

export interface MailTrader {
  readonly legalName: string;
  readonly address: string;
  readonly email: string;
  readonly phone: string;
  readonly vatId: string;
  readonly complaintsUrl: string;
}

/**
 * The emails that confirm a contract the customer may withdraw from, which carry the right and its
 * link (CRD arts. 8(7), 11a); the first of each, also the model form and who we are.
 */
const CONFIRMATIONS: ReadonlySet<string> = new Set([
  "booking.confirmed",
  "booking.accepted",
  "booking.paid",
  "booking.change.accept",
  "order.accepted",
  "order.awaiting_payment",
  "order.paid",
  "order.fulfilled",
  "order.change.accept",
]);
const FIRST_CONFIRMATIONS: ReadonlySet<string> = new Set([
  "booking.confirmed",
  "booking.accepted",
  "booking.paid",
  "order.accepted",
  // An order accepted and paid at once is confirmed by the payment's email.
  "order.paid",
]);

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
  blocks.push(...withdrawalBlocks(input, body.template));
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
  const order = item.type === "order" && item.state === "proposed" && item.payload.proposed;
  const details = item.state === "needs_info";
  const change = openChange(item)?.by === "business";
  if (change) {
    if (!links || links.size === 0) return [m.replyToAnswerChange];
    const at = (label: string, action: LinkAction) => {
      const url = links.get(action);
      return url ? [`${label}: ${url}`] : [];
    };
    return [...at(m.acceptChange, "accept_change"), ...at(m.keepAsIs, "keep_as_is")];
  }
  // A confirmed booking can be moved: the link to ask, when the email carries one.
  const move = links?.get("change_time");
  if (item.type === "booking" && isChangeable(item) && move) return [`${m.changeTime}: ${move}`];
  if (!time && !quote && !order && !details) return [];
  if (!links || links.size === 0)
    return [details ? m.replyWithDetails : order ? m.replyToAnswerOrder : m.replyToAnswer];
  const line = (label: string, action: LinkAction) => {
    const url = links.get(action);
    return url ? [`${label}: ${url}`] : [];
  };
  if (time)
    return [...line(m.accept, "accept_time"), ...line(m.decline, "decline_time"), ...line(m.otherTime, "other_time")];
  if (quote) return [...line(m.accept, "accept_quote"), ...line(m.decline, "decline_quote")];
  if (order) return [...line(m.accept, "accept_order"), ...line(m.decline, "decline_order")];
  const send = line(m.details, "details");
  return send.length ? [...send, c.email.details.orReply] : [m.replyWithDetails];
}

/**
 * The right of withdrawal in a confirmation (ADR-018 §7): until when, or for how long once it starts,
 * and the link to withdraw; the exception when there is none. The first confirmation also carries the
 * model form and who we are (CRD arts. 6(1), 8(7)).
 */
function withdrawalBlocks(input: CustomerMailInput, template: string): (readonly string[])[] {
  const w = input.withdrawal;
  if (!w || !CONFIRMATIONS.has(template)) return [];
  const words = withdrawalCopy(input.lang, w.law);
  if (!w.available) return w.exception ? [[words.except[w.exception]]] : [];
  const when = (iso: string) => whenText(iso, input.timezone, input.lang);
  const days = String(w.days);
  const link = input.links?.get("withdraw");
  const out: (readonly string[])[] = [
    [
      w.until
        ? words.until(vars({ deadline: when(w.until) }))
        : w.kind === "goods"
          ? words.lineGoods(vars({ days }))
          : words.lineService(vars({ days })),
      ...(link ? [`${words.label}: ${link}`] : []),
    ],
  ];
  if (FIRST_CONFIRMATIONS.has(template)) {
    const t = input.trader;
    const name = t?.legalName.trim() || input.business.trim();
    const what = whatOf(input.item, input.lang) || copyFor(input.lang).yourNoun[input.item.type];
    out.push([
      words.modelForm(
        vars({
          business: [name, t?.email.trim()].filter(Boolean).join(", "),
          address: t?.address.trim() ?? "",
          what,
          ref: shortRef(input.item.id),
        }),
      ),
    ]);
    const line = traderLine(t, words.vatLabel);
    if (line) out.push([line]);
  }
  return out;
}

/** Who the business is, on one line: name, address, phone, email, VAT number. */
export function traderLine(t: MailTrader | null | undefined, vatLabel: string): string {
  if (!t) return "";
  return [
    t.legalName.trim(),
    oneLine(t.address),
    t.phone.trim(),
    t.email.trim(),
    t.vatId.trim() ? `${vatLabel} ${t.vatId.trim()}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A withdrawal, as the customer's copy of it (ADR-018 §7): when they sent it, what they sent, and
 * what happens next — their refund by a date, or the goods to send back and the refund after them.
 */
function withdrawalBody(
  input: CustomerMailInput,
  s: (extra?: Partial<CopyVars>) => CopyVars,
  what: string,
  law: "eu" | "pt" | "uk",
): Body {
  const { lang, item } = input;
  const words = withdrawalCopy(lang, law);
  const when = (iso: string) => whenText(iso, input.timezone, lang);
  const refund = input.refund?.type === "refund" ? input.refund.payload : item.type === "refund" ? item.payload : null;
  const sent = refund?.noticeAt ?? new Date(input.now ?? Date.now()).toISOString();
  const money = (m: Money) => moneyIn(m, lang);
  const next: string[] = [];
  if (refund?.goodsBack) {
    if (refund.returnBy) next.push(words.sendBack(vars({ deadline: when(refund.returnBy) })));
    next.push(input.returns?.postage === "business" ? words.postageUs : words.postageCustomer);
    if (refund.amount.value > 0) next.push(words.refundOnReturn(vars({ amount: money(refund.amount) })));
  } else if (refund && refund.amount.value > 0 && refund.refundDue) {
    next.push(words.refundBy(vars({ amount: money(refund.amount), deadline: when(refund.refundDue) })));
  }
  return {
    template: `${item.type}.withdrawn`,
    subject: words.receivedSubject(s()),
    blocks: [
      [words.received(vars({ what, when: when(sent) }))],
      [words.statement(vars({ what, ref: shortRef(input.refund?.linkedItemId ?? item.linkedItemId ?? item.id) }))],
      next,
    ],
    // What they told us with it is theirs, never ours to send back.
    wordsUsed: true,
  };
}

/** A return or a refund, at each step (ADR-018 §3.4): received, agreed, the goods back, disputed, refunded, refused, dropped. */
function refundBody(
  input: CustomerMailInput,
  item: Extract<Item, { type: "refund" }>,
  s: (extra?: Partial<CopyVars>) => CopyVars,
): Body | null {
  const { lang } = input;
  const c = copyFor(lang);
  const r = c.returns;
  const p = item.payload;
  const when = (iso: string) => whenText(iso, input.timezone, lang);
  const money = (m: Money) => moneyIn(m, lang);
  const amount = money(p.amount);
  // The order it returns, by name when it has one; else simply "your return".
  const named = whatOf(item, lang);
  const subject = r.subject(vars({ what: subjectIn(item, lang) }));
  const law = input.withdrawal?.law ?? "eu";
  const postage =
    p.kind === "faulty" || input.returns?.postage === "business"
      ? withdrawalCopy(lang, law).postageUs
      : withdrawalCopy(lang, law).postageCustomer;
  const v = (extra: Partial<CopyVars> = {}) => vars({ what: named, ...extra });
  if (input.event === "create") {
    if (p.kind === "withdrawal") return withdrawalBody(input, s, named || c.yourNoun[item.type], law);
    const hours = String(input.returns?.respondHours ?? 48);
    return {
      template: "refund.received",
      subject,
      blocks: [[p.kind === "faulty" ? r.faulty(v({ hours })) : r.received(v({ hours }))]],
      wordsUsed: true,
    };
  }
  switch (input.event) {
    case "approve": {
      if (p.goodsBack) {
        const how = p.instructions;
        return {
          template: "refund.approved",
          subject,
          blocks: [
            [
              r.approvedBack(v({ deadline: p.returnBy ? when(p.returnBy) : "" })),
              ...(how ? [r.method[how.method]] : []),
              ...(how?.address ? [how.address] : []),
              ...(how?.note ? [how.note] : []),
              postage,
              ...(p.amount.value > 0 ? [withdrawalCopy(lang, law).refundOnReturn(vars({ amount }))] : []),
            ],
          ],
        };
      }
      return {
        template: "refund.approved",
        subject,
        blocks: [[r.approvedRefund(v({ amount, deadline: p.refundDue ? when(p.refundDue) : "" }))]],
      };
    }
    case "goods_back":
      return {
        template: "refund.goods_back",
        subject,
        blocks: [
          [p.refundDue ? r.goodsBack(v({ amount, deadline: when(p.refundDue) })) : r.goodsBackLater(v({ amount }))],
        ],
      };
    case "dispute_goods":
      return {
        template: "refund.disputed",
        subject,
        blocks: [[r.disputed(v())], [p.disputed?.note ?? input.words?.trim() ?? ""].filter(Boolean), [r.disputedNext]],
        wordsUsed: true,
      };
    case "refund":
      return {
        template: "refund.refunded",
        subject,
        blocks: [[r.refunded(v({ amount: money(p.paidAmount ?? p.amount), paymentRef: p.paymentRef ?? "" }))]],
      };
    case "reject": {
      const url = input.trader?.complaintsUrl.trim() ?? "";
      return {
        template: "refund.rejected",
        subject,
        blocks: [
          [r.rejected(v())],
          [input.words?.trim() ?? ""].filter(Boolean),
          [r.disagree, ...(url ? [r.complaints(v({ url }))] : [])],
        ],
        wordsUsed: true,
      };
    }
    case "cancel":
    case "record_cancel":
      return { template: "refund.cancelled", subject, blocks: [[r.cancelled(v())]], wordsUsed: true };
    default:
      return null;
  }
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
              ...priceLines(input, item.payload.totalPrice, item.payload),
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
      const changed = changeBody(input, v, s, at);
      if (changed) return changed;
      if (input.event === "withdraw" || input.event === "record_withdrawal") {
        return withdrawalBody(input, s, what, input.withdrawal?.law ?? "eu");
      }
      if (input.event === "record_payment" && item.state === "confirmed") {
        const paid = item.payload.paidAmount;
        return {
          template: "booking.paid",
          subject: e.order.paidSubject(s()),
          blocks: [[paid && paid.value > 0 ? e.order.paid(v({ amount: money(paid) })) : e.order.paidNoAmount(v())]],
        };
      }
      switch (item.state) {
        case "confirmed": {
          const lines = [...priceLines(input, item.payload.totalPrice, item.payload), ...cutoffLines(input, item)];
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
          if (input.event === "retract")
            return {
              template: "booking.retracted",
              subject: e.retracted.subject(s()),
              blocks: [[e.retracted.time(v())]],
            };
          break;
        case "proposed": {
          const p = item.payload.proposed;
          if (!p) break;
          const deadline = timeDeadline(item, input.minNoticeMin ?? 0) ?? p.startTime;
          const held = item.payload.offer?.held === true;
          const withdrawable = item.payload.offer?.binding === false;
          return {
            template: "booking.proposed",
            subject: e.proposed.subject(s()),
            blocks: [
              [
                input.revised
                  ? e.proposed.revised(v({ newWhen: when(p.startTime) }))
                  : e.proposed.first(v({ newWhen: when(p.startTime) })),
                e.proposed.youAsked(v({ askedWhen: at })),
                // A price of ours with the time we propose settles it; without one, the request's stands.
                ...priceLines(
                  p.totalPrice ? { ...input, unpriced: false } : input,
                  p.totalPrice ?? item.payload.totalPrice,
                  p.totalPrice ? p : item.payload,
                ),
                held
                  ? e.proposed.answerByHeld(v({ deadline: when(deadline) }))
                  : e.proposed.answerBy(v({ deadline: when(deadline) })),
                ...(withdrawable ? [c.withdrawable] : []),
              ],
            ],
          };
        }
        case "expired":
          return expiredBody(input, v, s, input.lapsedAt ? when(input.lapsedAt) : "");
        case "needs_info":
          return detailsBody(input, v, s);
        case "declined":
          return {
            template: "declined",
            subject: e.declined.subject(s()),
            blocks: [[e.declined.booking(v({ when: at }))]],
          };
        case "cancelled_by_business": {
          // What was paid for it is owed back by a date.
          const refund = input.refund?.type === "refund" ? input.refund.payload : null;

          const back =
            refund && refund.amount.value > 0 && refund.refundDue
              ? [c.returns.cancelledPaid(v({ amount: money(refund.amount), deadline: when(refund.refundDue) }))]
              : [];
          return {
            template: "cancelled.by_us",
            subject: e.cancelledByUs.subject(s()),
            blocks: [[e.cancelledByUs.booking(v({ when: at })), ...back]],
          };
        }
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
      const changed = changeBody(input, v, s, "");
      if (changed) return changed;
      if (input.event === "withdraw" || input.event === "record_withdrawal") {
        return withdrawalBody(input, s, what, input.withdrawal?.law ?? "eu");
      }
      switch (item.state) {
        case "needs_info":
          return detailsBody(input, v, s);
        case "received":
          if (input.event === "counter")
            return {
              template: "order.counter",
              subject: e.counterReceived.subject(s()),
              blocks: [[e.counterReceived.order(v())], orderLines(input, item)],
              wordsUsed: true,
            };
          if (input.event === "retract")
            return {
              template: "order.retracted",
              subject: e.retracted.subject(s()),
              blocks: [[e.retracted.order(v())]],
            };
          break;
        case "proposed": {
          const p = item.payload.proposed;
          if (!p) break;
          const until = item.payload.offer?.by === "business" ? item.payload.offer.validThrough : undefined;
          return {
            template: "order.proposed",
            subject: e.orderProposed.subject(s()),
            blocks: [
              [input.revised ? e.orderProposed.revised(v()) : e.orderProposed.first(v())],
              [
                ...p.orderedItem.map(
                  (l) => `${l.quantity} × ${oneLine(l.name)} — ${money(times(l.price, l.quantity))}`,
                ),
                e.total(v({ total: money(p.totalPrice) })),
                ...noticeLines(input, p),
                ...(p.delivery?.when ? [`${c.page.rows.delivery}: ${when(p.delivery.when)}`] : []),
              ],
              [
                ...(until ? [e.orderProposed.answerBy(v({ deadline: when(until) }))] : []),
                ...(item.payload.offer?.binding === false ? [c.withdrawable] : []),
              ],
            ],
          };
        }
        case "expired":
          return expiredBody(input, v, s, input.lapsedAt ? when(input.lapsedAt) : "");
        case "accepted":
          if (input.event === "accept" && input.fromState === "proposed")
            return {
              template: "order.accepted",
              subject: e.order.acceptedSubject(s()),
              blocks: [[e.order.acceptedChanges(v())], orderLines(input, item)],
            };
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
        case "cancelled": {
          // What was paid, and what happens to it: owed back by a date when we cancelled, theirs to ask
          // back when they did.
          const refund = input.refund?.type === "refund" ? input.refund.payload : null;
          const back =
            refund && refund.amount.value > 0
              ? byCustomer
                ? [c.returns.refundToAsk(v({ amount: money(refund.amount) }))]
                : refund.refundDue
                  ? [c.returns.cancelledPaid(v({ amount: money(refund.amount), deadline: when(refund.refundDue) }))]
                  : []
              : [];
          return byCustomer
            ? {
                template: "cancelled.as_asked",
                subject: e.cancelledAsAsked.subject(s()),
                blocks: [[e.cancelledAsAsked.order(v()), ...back]],
                wordsUsed: true,
              }
            : {
                template: "cancelled.by_us",
                subject: e.cancelledByUs.subject(s()),
                blocks: [[e.cancelledByUs.order(v()), ...back]],
              };
        }
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
        case "received":
          if (input.event === "counter")
            return {
              template: "quote.counter",
              subject: e.counterReceived.subject(s()),
              blocks: [[e.counterReceived.quote(v())]],
              wordsUsed: true,
            };
          if (input.event === "retract")
            return {
              template: "quote.retracted",
              subject: e.retracted.subject(s()),
              blocks: [[e.retracted.quote(v())]],
            };
          break;
        case "expired":
          return expiredBody(input, v, s, item.payload.quote ? when(item.payload.quote.validThrough) : "");
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
      const body = refundBody(input, item, s);
      if (body) return body;
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

/**
 * A change to a promise (ADR-018 §3.1, §3.2): one we ask for, with what was agreed beside it and
 * until when to answer; one the customer asked for, received; one made; or one not made — ours
 * declined, withdrawn or lapsed, theirs we could not take or answer in time — after which the promise
 * stays as agreed, and the email says so. Null for anything else.
 */
function changeBody(
  input: CustomerMailInput,
  v: (extra?: Partial<CopyVars>) => CopyVars,
  s: (extra?: Partial<CopyVars>) => CopyVars,
  at: string,
): Body | null {
  const { item, lang } = input;
  if (item.type !== "booking" && item.type !== "order") return null;
  const events = ["propose_change", "accept_change", "decline_change", "retract_change", "expire_change"];
  if (!events.includes(input.event)) return null;
  const c = copyFor(lang);
  const e = c.email.change;
  const when = (iso: string) => whenText(iso, input.timezone, lang);
  const money = (m: Money) => moneyIn(m, lang);
  const booking = item.type === "booking";
  const template = `${item.type}.change.${input.event.replace("_change", "")}`;
  const lines = (terms: { orderedItem: readonly { name: string; quantity: number; price: Money }[] }) =>
    terms.orderedItem.map((l) => `${l.quantity} × ${oneLine(l.name)} — ${money(times(l.price, l.quantity))}`);
  const byCustomer = input.actorKind ? CUSTOMER_KINDS.has(input.actorKind) : false;
  switch (input.event) {
    case "propose_change": {
      const change = item.payload.change;
      if (!change) return null;
      if (change.by === "customer") {
        return booking && item.type === "booking" && item.payload.change
          ? {
              template,
              subject: e.receivedSubject(s()),
              blocks: [[e.receivedTime(v({ when: at, newWhen: when(item.payload.change.startTime) }))]],
              wordsUsed: true,
            }
          : { template, subject: e.receivedSubject(s()), blocks: [[e.receivedOrder(v())]], wordsUsed: true };
      }
      const until = item.payload.offer?.by === "business" ? item.payload.offer.validThrough : undefined;
      const held = item.payload.offer?.held === true;
      const answer = until
        ? [held ? e.answerByHeld(v({ deadline: when(until) })) : e.answerBy(v({ deadline: when(until) }))]
        : [];
      const withdrawable = item.payload.offer?.binding === false ? [c.withdrawable] : [];
      if (item.type === "booking" && item.payload.change) {
        const next = item.payload.change;
        const repriced =
          next.totalPrice &&
          (!item.payload.totalPrice ||
            next.totalPrice.value !== item.payload.totalPrice.value ||
            next.totalPrice.currency !== item.payload.totalPrice.currency);
        return {
          template,
          subject: e.askTimeSubject(s()),
          blocks: [
            [
              e.askTime(v({ when: at, newWhen: when(next.startTime) })),
              ...(repriced && next.totalPrice ? [c.price(vars({ total: money(next.totalPrice) }))] : []),
              ...answer,
              ...withdrawable,
            ],
          ],
        };
      }
      if (item.type === "order" && item.payload.change) {
        const next = item.payload.change;
        return {
          template,
          subject: e.askOrderSubject(s()),
          blocks: [
            [e.askOrder(v())],
            [
              ...lines(next),
              c.email.total(v({ total: money(next.totalPrice) })),
              ...(next.delivery?.when ? [`${c.page.rows.delivery}: ${when(next.delivery.when)}`] : []),
            ],
            [...answer, ...withdrawable],
          ],
        };
      }
      return null;
    }
    case "accept_change":
      if (item.type === "booking") {
        return {
          template,
          subject: e.doneSubject(s()),
          blocks: [
            [
              e.doneTime(v({ when: at })),
              ...priceLines({ ...input, unpriced: false }, item.payload.totalPrice, item.payload),
              ...cutoffLines(input, item),
            ],
          ],
        };
      }
      if (item.type === "order") {
        return {
          template,
          subject: e.doneSubject(s()),
          blocks: [
            [e.doneOrder(v())],
            [
              ...lines(item.payload),
              c.email.total(v({ total: money(item.payload.totalPrice) })),
              ...(item.payload.delivery?.when ? [`${c.page.rows.delivery}: ${when(item.payload.delivery.when)}`] : []),
            ],
          ],
        };
      }
      return null;
    default: {
      // Not made: the promise stays as agreed.
      const closed = input.closedChange;
      const ours = closed ? closed.by === "business" : !byCustomer;
      const newWhen = closed?.terms.startTime ? when(closed.terms.startTime) : "";
      const say =
        input.event === "expire_change"
          ? ours
            ? booking
              ? e.lapsedOursTime(v({ when: at }))
              : e.lapsedOursOrder(v())
            : booking
              ? e.lapsedYoursTime(v({ when: at }))
              : e.lapsedYoursOrder(v())
          : input.event === "decline_change" && !byCustomer
            ? booking
              ? e.weCantTime(v({ when: at, newWhen }))
              : e.weCantOrder(v())
            : input.event === "retract_change" && !byCustomer
              ? booking
                ? e.withdrawnTime(v({ when: at }))
                : e.withdrawnOrder(v())
              : booking
                ? e.keptTime(v({ when: at }))
                : e.keptOrder(v());
      // What the customer told us with their no is theirs, never ours to send back.
      return { template, subject: e.keptSubject(s()), blocks: [[say]], wordsUsed: byCustomer };
    }
  }
}

/**
 * It lapsed (ADR-018 §1): what we proposed, past the date to accept it, or a request nobody
 * answered in time — ours to answer, or theirs, when we had asked them something.
 */
function expiredBody(
  input: CustomerMailInput,
  v: (extra?: Partial<CopyVars>) => CopyVars,
  s: (extra?: Partial<CopyVars>) => CopyVars,
  until: string,
): Body {
  const e = copyFor(input.lang).email;
  const base = {
    template: `${input.item.type === "quote_request" ? "quote" : input.item.type}.expired`,
    subject: e.expired.subject(s()),
  };
  switch (input.fromState) {
    case "proposed":
      return input.item.type === "order"
        ? { ...base, blocks: [[e.expired.order(v())]] }
        : { ...base, blocks: [[e.expired.time(v({ deadline: until }))]] };
    case "quoted":
      return { ...base, blocks: [[e.expired.quote(v({ validThrough: until }))]] };
    case "needs_info":
      return { ...base, blocks: [[e.expired.waitingOnYou(v())]] };
    default:
      return { ...base, blocks: [[e.expired.unanswered(v())]] };
  }
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

/**
 * The price of a booking: ours, or that we will confirm it; nothing when it has none. A price we chose
 * for them (`holder`'s `personalised`) carries the notice beside it (ADR-018 §5; CRD art. 6(1)(ea)).
 */
function priceLines(input: CustomerMailInput, price: Money | undefined, holder?: object): string[] {
  const c = copyFor(input.lang);
  if (input.unpriced) return [c.email.priceToConfirm];
  if (!price) return [];
  return [c.price(vars({ total: moneyIn(price, input.lang) })), ...noticeLines(input, holder)];
}

/** The personalised-price notice for what `holder` prices, when a price in it was chosen for them. */
function noticeLines(input: CustomerMailInput, holder: object | undefined): string[] {
  if (!holder) return [];
  const line = personalisedLine(holder, {
    lang: input.lang,
    timezone: input.timezone,
    minNoticeMin: input.minNoticeMin ?? 0,
  });
  return line ? [line] : [];
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
    ...(input.unpriced ? [] : noticeLines(input, item.payload)),
  ];
}

function times(price: Money, quantity: number): Money {
  return { ...price, value: price.value * quantity };
}
