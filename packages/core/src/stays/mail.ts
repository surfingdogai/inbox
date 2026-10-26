import { shortRef } from "../customer/format";
import { LINK_GRACE_MS, type LinkAction, linkUrl, mintLinks } from "../customer/links";
import type { Db } from "../db";
import type { Item, PayloadOf } from "../domain/types";
import { randomToken } from "../ids";
import { policySentence } from "../policy/index";
import type { SecretBox } from "../secrets/box";
import { formatMinor } from "../util/money";
import { labelled, type StayCopy, type StayLang, stayCopy } from "./copy";
import { nightsOf } from "./nights";
import { stayLinkSha } from "./page";
import { propertyLocale } from "./price";
import { readSetup } from "./store";
import { datesWords, whenWords } from "./terms";
import { paidOf } from "./transition";

/**
 * A stay's emails to its guest (ADR-037 §12 G1–G6, §10): in the property's name and the guest's
 * language, from the stay as it stands when the email goes. The confirmation says it is not an invoice;
 * an automatic one says so; every one says who the booking is with. Private arrival details are never
 * written into the email as it is kept: the kept text holds a placeholder, filled only as it is sent.
 */

type StayPayload = PayloadOf<"stay">;

/**
 * Where the sealed arrival details go in the email as sent: a marker of this email's own, random, only
 * ever in the arrival-details email the inbox writes itself. Anything shaped like one in words someone
 * else wrote (a reply, a name) is taken out before the email is kept, so no reply can ask for the codes.
 */
export const ARRIVAL_MARKER = /\{\{arrival-details(?::[A-Za-z0-9_-]*)?\}\}/g;
const ARRIVAL_SPOT = "\u0000arrival\u0000";

/** The template whose email carries the arrival details, and the states a stay must be in for it to. */
export const ARRIVAL_TEMPLATE = "stay.arrival_details";
export const ARRIVAL_STATES: readonly string[] = ["confirmed", "checked_in"];

export interface StayMailInput {
  readonly item: Item;
  readonly event: string;
  readonly lang: StayLang;
  /** The owner's own words on this event (a note the guest reads), when there are any. */
  readonly words: string | null;
  readonly automated: boolean;
  /** Whether a reply reaches the property. */
  readonly replies: boolean;
  readonly links: ReadonlyMap<LinkAction, string> | null;
  /** The open pay links, by schedule entry. */
  readonly pay: readonly {
    readonly scheduleId: string;
    readonly url: string;
    readonly amount: { value: number; currency: string };
  }[];
  readonly fromState: string | null;
  readonly now: number;
}

/** A few words the emails need beyond the copy table, in the six languages. */
const EXTRA: Readonly<
  Record<
    StayLang,
    {
      total: string;
      lapsed: (p: string, d: string) => [string, string];
      changeAsked: (p: string) => string;
      changeRefused: (p: string, d: string) => [string, string];
      status: (p: string, d: string) => string;
    }
  >
> = {
  en: {
    total: "Total",
    lapsed: (p, d) => [
      `Your request to ${p}: ${d}`,
      `${p} could not answer your request in time, so it is closed. Write to us if you would still like to come.`,
    ],
    changeAsked: (p) => `${p} asks to change your stay`,
    changeRefused: (p, d) => [
      `Your stay at ${p} could not be changed`,
      `${p} could not make the change: the new dates are not free after all. Your stay stays as it was, ${d}.`,
    ],
    status: (p, d) => `Your stay at ${p}: ${d}`,
  },
  es: {
    total: "Total",
    lapsed: (p, d) => [
      `Su solicitud a ${p}: ${d}`,
      `${p} no pudo responder a tiempo y la solicitud se ha cerrado. Escríbanos si todavía quiere venir.`,
    ],
    changeAsked: (p) => `${p} le pide cambiar su estancia`,
    changeRefused: (p, d) => [
      `Su estancia en ${p} no se pudo cambiar`,
      `${p} no pudo hacer el cambio: las nuevas fechas no están libres. Su estancia sigue como estaba, ${d}.`,
    ],
    status: (p, d) => `Su estancia en ${p}: ${d}`,
  },
  fr: {
    total: "Total",
    lapsed: (p, d) => [
      `Votre demande à ${p}\u00a0: ${d}`,
      `${p} n'a pas pu répondre à temps, la demande est close. Écrivez-nous si vous souhaitez toujours venir.`,
    ],
    changeAsked: (p) => `${p} vous propose de modifier votre séjour`,
    changeRefused: (p, d) => [
      `Votre séjour chez ${p} n'a pas pu être modifié`,
      `${p} n'a pas pu faire la modification\u00a0: les nouvelles dates ne sont finalement pas libres. Votre séjour reste tel quel, ${d}.`,
    ],
    status: (p, d) => `Votre séjour chez ${p}\u00a0: ${d}`,
  },
  de: {
    total: "Gesamt",
    lapsed: (p, d) => [
      `Ihre Anfrage an ${p}: ${d}`,
      `${p} konnte nicht rechtzeitig antworten, die Anfrage ist geschlossen. Schreiben Sie uns, wenn Sie trotzdem kommen möchten.`,
    ],
    changeAsked: (p) => `${p} schlägt eine Änderung Ihres Aufenthalts vor`,
    changeRefused: (p, d) => [
      `Ihr Aufenthalt bei ${p} konnte nicht geändert werden`,
      `${p} konnte die Änderung nicht vornehmen: Die neuen Daten sind doch nicht frei. Ihr Aufenthalt bleibt wie vereinbart, ${d}.`,
    ],
    status: (p, d) => `Ihr Aufenthalt bei ${p}: ${d}`,
  },
  it: {
    total: "Totale",
    lapsed: (p, d) => [
      `La tua richiesta a ${p}: ${d}`,
      `${p} non è riuscita a rispondere in tempo e la richiesta è chiusa. Scrivici se vuoi ancora venire.`,
    ],
    changeAsked: (p) => `${p} ti propone di cambiare il soggiorno`,
    changeRefused: (p, d) => [
      `Il tuo soggiorno presso ${p} non è stato modificato`,
      `${p} non ha potuto fare la modifica: le nuove date non sono libere. Il soggiorno resta com'era, ${d}.`,
    ],
    status: (p, d) => `Il tuo soggiorno presso ${p}: ${d}`,
  },
  pt: {
    total: "Total",
    lapsed: (p, d) => [
      `O seu pedido a ${p}: ${d}`,
      `${p} não conseguiu responder a tempo e o pedido foi fechado. Escreva-nos se ainda quiser vir.`,
    ],
    changeAsked: (p) => `${p} propõe alterar a sua estadia`,
    changeRefused: (p, d) => [
      `Não foi possível alterar a sua estadia em ${p}`,
      `${p} não conseguiu fazer a alteração: as novas datas afinal não estão livres. A sua estadia mantém-se como estava, ${d}.`,
    ],
    status: (p, d) => `A sua estadia em ${p}: ${d}`,
  },
};

export function extraWordsOf(lang: StayLang): string[] {
  const e = EXTRA[lang];
  return [
    e.total,
    ...e.lapsed("X", "1 Jan"),
    e.changeAsked("X"),
    ...e.changeRefused("X", "1 Jan"),
    e.status("X", "1 Jan"),
  ];
}

/** The links a stay's email carries, as it stands: answer a quote, cancel, add a card, answer a change. */
export async function stayLinks(
  db: Db,
  box: SecretBox | null,
  item: Item,
  opts: { readonly mailKey: string; readonly lang: StayLang; readonly base: string; readonly now: number },
): Promise<Map<LinkAction, string> | null> {
  if (!box || !opts.base) return null;
  const p = item.payload as StayPayload;
  const out = new Map<LinkAction, string>();
  const mint = async (actions: LinkAction[], until: number) => {
    if (until <= opts.now) return;
    const sha = await stayLinkSha(item, actions[0] as LinkAction);
    const tokens = await mintLinks(
      db,
      box,
      {
        itemId: item.id,
        mailKey: opts.mailKey,
        lang: opts.lang as never,
        termsSha: sha,
        expiresAt: until + LINK_GRACE_MS,
        actions,
      },
      opts.now,
    );
    for (const [a, t] of tokens) out.set(a, linkUrl(opts.base, t));
  };
  const setup = await readSetup(db, p.propertyId);
  const endAt = setup ? Date.parse(p.endTime ?? `${p.checkOut}T23:59:59Z`) : opts.now;
  if (item.state === "quoted" && p.quote) {
    await mint(["stay_accept", "stay_dates", "stay_decline"], Date.parse(p.quote.validThrough));
  }
  if (item.state === "confirmed") {
    await mint(["stay_cancel"], Date.parse(p.startTime ?? `${p.checkIn}T00:00:00Z`));
    if (p.change?.by === "business" && p.change.validThrough) {
      await mint(["stay_change_yes", "stay_change_no"], Date.parse(p.change.validThrough));
    }
  }
  if (
    (item.state === "awaiting_payment" || item.state === "confirmed") &&
    p.payments?.guarantee.status === "requested"
  ) {
    await mint(["stay_card"], p.payments.dueBy ? Date.parse(p.payments.dueBy) : endAt);
  }
  return out;
}

/** Money as the guest reads it where the property is. */
function money(m: { value: number; currency: string }, locale: string): string {
  return formatMinor(m, locale).replace(/[\u202f\u2009]/g, "\u00a0");
}

/** The lines of a quote as an email shows them: label, amount; the total; what is paid now and there. */
function quoteBlock(p: StayPayload, c: StayCopy, lang: StayLang, locale: string): string[] {
  const q = p.quote;
  if (!q) return [];
  const lines = q.lines.map((l) => labelled(lang, l.label, money({ value: l.amount, currency: q.currency }, locale)));
  lines.push(labelled(lang, EXTRA[lang].total, money(q.total, locale)));
  const now = q.schedule.filter((s) => s.type === "immediate").reduce((a, s) => a + s.amount.value, 0);
  const there = q.schedule.filter((s) => s.type === "at_property").reduce((a, s) => a + s.amount.value, 0);
  if (now > 0 && there > 0) {
    lines.push(
      c.emails.payNow({
        now: money({ value: now, currency: q.currency }, locale),
        there: money({ value: there, currency: q.currency }, locale),
      }),
    );
  } else if (now > 0) lines.push(c.emails.payParts({ now: money({ value: now, currency: q.currency }, locale) }));
  return lines;
}

/** Renders a stay's email for an event, or null when the event sends the guest none. */
export async function renderStayMail(
  db: Db,
  input: StayMailInput,
): Promise<{ template: string; subject: string; text: string } | null> {
  const { item, lang } = input;
  const p = item.payload as StayPayload;
  const setup = await readSetup(db, p.propertyId);
  const locale = propertyLocale(lang, setup?.property);
  const property = setup?.property.name ?? "";
  const c = stayCopy(lang);
  const dates = datesWords(p.checkIn, p.checkOut, lang, setup?.property);
  const nights = nightsOf(p.checkIn, p.checkOut).length;
  const ref = shortRef(item.id);
  const say = (input.words ?? "").replace(ARRIVAL_MARKER, "").trim();
  const blocks: string[][] = [];
  const link = (a: LinkAction, label: string) => {
    const url = input.links?.get(a);
    return url ? labelled(lang, label, url) : null;
  };
  const policy = p.quote
    ? policySentence(p.quote.policy, {
        lang,
        locale,
        total: p.quote.total,
        what: "stay",
        place: setup?.property.locality ?? undefined,
      })
    : null;
  const paidLines = () => {
    const paid = paidOf(p);
    const there = (p.payments?.schedules ?? [])
      .filter((s) => s.status === "at_property")
      .reduce((a, s) => a + s.amount.value, 0);
    return [
      ...(paid.value > 0 ? [c.emails.paymentReceived.body({ property, amount: money(paid, locale) })] : []),
      ...(there > 0
        ? [labelled(lang, c.schedule.atProperty, money({ value: there, currency: paid.currency }, locale))]
        : []),
    ];
  };
  const payLines = () => input.pay.map((x) => labelled(lang, c.page.pay({ amount: money(x.amount, locale) }), x.url));
  let template: string;
  let subject: string;
  switch (input.event) {
    case "create":
      template = "stay.received";
      subject = c.emails.received.subject({ property, dates });
      blocks.push([c.emails.received.body({ property, dates, hours: String(setup?.property.answerHours ?? 12) })]);
      break;
    case "request_info":
      template = "stay.needs_info";
      subject = c.emails.needsInfo.subject({ property });
      blocks.push([say || c.page.status.needs_info || ""]);
      break;
    case "quote":
      if (item.state !== "quoted" || !p.quote) return null;
      template = "stay.quote";
      subject = c.emails.quote.subject({ property, dates });
      blocks.push([c.emails.quote.intro({ property }), `${dates} · ${c.nights(nights)}`]);
      blocks.push(quoteBlock(p, c, lang, locale));
      if (say) blocks.push([say]);
      if (policy) blocks.push([policy]);
      blocks.push([
        c.emails.quote.holds({ until: setup ? whenWords(setup, p.quote.validThrough, lang) : p.quote.validThrough }),
      ]);
      blocks.push(
        [
          link("stay_accept", c.page.accept),
          link("stay_dates", c.page.otherDates),
          link("stay_decline", c.page.noThanks),
        ].filter((x): x is string => x !== null),
      );
      break;
    case "decline":
      template = "stay.declined";
      subject = c.emails.declined.subject({ property, dates });
      blocks.push([say || c.emails.declined.full]);
      break;
    case "expire": {
      if (input.fromState === "quoted") {
        template = "stay.quote_expired";
        subject = c.emails.expiredQuote.subject({ property });
        blocks.push([c.emails.expiredQuote.body({ dates })]);
      } else if (input.fromState === "awaiting_payment") {
        template = "stay.not_paid";
        subject = c.emails.notPaid.subject({ property });
        blocks.push([c.emails.notPaid.body({ dates })]);
      } else if (input.fromState === "requested" || input.fromState === "needs_info") {
        template = "stay.lapsed";
        const [s, b] = EXTRA[lang].lapsed(property, dates);
        subject = s;
        blocks.push([b]);
      } else return null;
      break;
    }
    case "write_refused":
      template = "stay.not_written";
      subject = c.emails.declined.subject({ property, dates });
      blocks.push([c.emails.declined.full]);
      break;
    case "cancel":
    case "record_cancel": {
      template = "stay.cancelled";
      subject = c.emails.cancelled.subject({ property });
      const fee = p.cancellation?.fee;
      const refund = p.cancellation?.refundOwed;
      blocks.push([
        c.emails.cancelled.body({
          property,
          dates,
          ...(fee && fee.value > 0 ? { fee: money(fee, locale) } : {}),
          ...(refund && refund.value > 0 ? { refund: money(refund, locale) } : {}),
        }),
      ]);
      break;
    }
    case "cancel_by_property": {
      template = "stay.cancelled_by_property";
      subject = c.emails.cancelledByProperty.subject({ property });
      const refund = p.cancellation?.refundOwed;
      blocks.push(
        [
          say,
          ...(refund && refund.value > 0
            ? [c.emails.cancelledByProperty.refund({ property, paid: money(refund, locale) })]
            : []),
        ].filter(Boolean),
      );
      break;
    }
    case "propose_change":
      if (p.change?.by !== "business") return null;
      template = "stay.change_asked";
      subject = EXTRA[lang].changeAsked(property);
      blocks.push([
        datesWords(p.change.checkIn, p.change.checkOut, lang, setup?.property),
        ...(p.change.quote ? [c.page.newTotal({ total: money(p.change.quote.total, locale) })] : []),
        ...(say ? [say] : []),
      ]);
      blocks.push(
        [link("stay_change_yes", c.page.changeMine), link("stay_change_no", c.page.keep)].filter(
          (x): x is string => x !== null,
        ),
      );
      break;
    case "change_refused": {
      template = "stay.change_refused";
      const [s, b] = EXTRA[lang].changeRefused(property, dates);
      subject = s;
      blocks.push([b]);
      break;
    }
    case "accept_change":
    case "change_written":
      template = "stay.changed";
      subject = c.emails.changed.subject({ property, dates });
      blocks.push([c.emails.changed.body({ dates, total: p.quote ? money(p.quote.total, locale) : "" })]);
      if (input.pay.length) blocks.push(payLines());
      break;
    case "stay_before": {
      if (!setup) return null;
      template = "stay.before_arrival";
      const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
        new Date(`${p.checkIn}T12:00:00Z`),
      );
      subject = c.emails.beforeArrival.subject({ property, weekday });
      const due = (p.payments?.schedules ?? [])
        .filter((s) => s.status === "at_property" || s.status === "due")
        .reduce((a, s) => a + s.amount.value - (s.paidAmount?.value ?? 0), 0);
      blocks.push([
        setup.property.preArrivalText?.trim() ||
          c.emails.beforeArrival.body({
            time: setup.property.checkInFrom,
            ...(setup.property.arrivalPublic ? { how: setup.property.arrivalPublic } : {}),
            ...(due > 0
              ? {
                  due: `${labelled(lang, c.schedule.atProperty, money({ value: due, currency: p.quote?.currency ?? setup.property.currency }, locale))}.`,
                }
              : {}),
          }),
      ]);
      break;
    }
    case "stay_arrival":
      template = "stay.arrival_details";
      subject = c.emails.arrivalDetails.subject({ property });
      if (!ARRIVAL_STATES.includes(item.state)) return null;
      blocks.push([c.emails.arrivalDetails.body({ date: dates, details: ARRIVAL_SPOT })]);
      break;
    case "stay_thanks":
      template = "stay.thank_you";
      subject = c.emails.thankYou.subject({ property });
      blocks.push([c.emails.thankYou.body({})]);
      break;
    case "stay_reminder": {
      if (item.state !== "awaiting_payment" || !setup) return null;
      template = "stay.reminder";
      subject = c.emails.reminder.subject({ dates });
      const due = input.pay.reduce((a, x) => a + x.amount.value, 0);
      if (due > 0 && p.payments?.dueBy) {
        blocks.push([
          c.emails.reminder.body({
            amount: money({ value: due, currency: input.pay[0]?.amount.currency ?? "" }, locale),
            until: whenWords(setup, p.payments.dueBy, lang),
          }),
        ]);
      }
      blocks.push(payLines());
      {
        const card = link("stay_card", c.page.addCard);
        if (card) blocks.push([card]);
      }
      break;
    }
    default: {
      // The stay agreed, waiting for its deposit, confirmed after a payment, or a payment received.
      if (item.state === "awaiting_payment") {
        template = "stay.awaiting_payment";
        subject = c.emails.quote.subject({ property, dates });
        const due = input.pay.reduce((a, x) => a + x.amount.value, 0);
        if (due > 0 && p.payments?.dueBy && setup) {
          blocks.push([
            c.page.payBy({
              amount: money({ value: due, currency: input.pay[0]?.amount.currency ?? "" }, locale),
              property,
              until: whenWords(setup, p.payments.dueBy, lang),
            }),
          ]);
        }
        blocks.push(payLines());
        const card = link("stay_card", c.page.addCard);
        if (card) blocks.push([c.page.card({ property }), card]);
        if (policy) blocks.push([policy]);
        break;
      }
      if (item.state === "confirmed" && input.event === "record_payment" && input.fromState === "confirmed") {
        template = "stay.payment_received";
        const paid = paidOf(p);
        subject = c.emails.paymentReceived.subject({ amount: money(paid, locale), ref });
        blocks.push([c.emails.paymentReceived.body({ property, amount: money(paid, locale) })]);
        break;
      }
      if (item.state === "confirmed") {
        template = "stay.confirmed";
        subject = c.emails.confirmed.subject({ property, dates });
        blocks.push([c.emails.confirmed.intro, c.page.reference({ ref }), `${dates} · ${c.nights(nights)}`]);
        if (setup)
          blocks.push([
            c.emails.confirmed.times({ time: setup.property.checkInFrom, until: setup.property.checkOutUntil }),
          ]);
        blocks.push(paidLines());
        if (policy) blocks.push([policy]);
        if (setup?.property.arrivalPublic)
          blocks.push([labelled(lang, c.page.howToFind, setup.property.arrivalPublic)]);
        if (p.registration) blocks.push([p.registration]);
        const cancel = link("stay_cancel", c.page.cancelMine);
        if (cancel) blocks.push([cancel]);
        blocks.push([c.notInvoice({ property })]);
        break;
      }
      if (!say) return null;
      template = `stay.${input.event}`;
      subject = EXTRA[lang].status(property, dates);
      blocks.push([c.page.status[item.state] ?? "", say].filter(Boolean));
    }
  }
  // The owner's own words go with whatever the email says, once.
  if (say && !blocks.some((b) => b.includes(say))) blocks.push([say]);
  // An email that would say nothing but the policy (a deposit with no link to pay it, a reminder with
  // nothing due) is not sent at all.
  if (!blocks.some((b) => b.some((l) => Boolean(l?.trim()) && l !== policy))) return null;
  const footer = [
    c.with({ property }),
    ...(input.automated ? [c.automatic({ property })] : []),
    ...(input.replies ? [c.reply({ property })] : []),
    c.page.reference({ ref }),
  ];
  blocks.push(footer);
  if (property) blocks.push([property]);
  const text = blocks
    .map((b) => b.filter((l) => l?.trim()).join("\n"))
    .filter(Boolean)
    .join("\n\n")
    .replace(ARRIVAL_MARKER, "")
    .replace(/[\u202f\u2009]/g, "\u00a0");
  return {
    template,
    subject: subject.replace(ARRIVAL_MARKER, "").replace(/\s+/g, " ").trim(),
    text:
      template === ARRIVAL_TEMPLATE
        ? text.replace(ARRIVAL_SPOT, `{{arrival-details:${randomToken(12)}}}`)
        : text.replaceAll(ARRIVAL_SPOT, ""),
  };
}
