import type { StayQuote } from "@surfingdog/spec";
import { shortRef } from "../customer/format";
import { type LinkAction, type LinkRow, linkUsedStatement } from "../customer/links";
import type { CustomerPage, LinkActResult, PageLink } from "../customer/page";
import type { Db } from "../db";
import type { Item, PayloadOf } from "../domain/types";
import { policySentence } from "../policy/index";
import { formatMinor } from "../util/money";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";
import { transitionItem } from "../write/transition";
import { type StayCopy, type StayLang, stayCopy, stayLang } from "./copy";
import { nightsOf } from "./nights";
import { propertyLocale } from "./price";
import { readSetup } from "./store";
import { cancellationTerms, datesWords, dueNow, feeSha, stayTermsSha, whenWords } from "./terms";
import { paidOf } from "./transition";

/**
 * A stay's pages behind the links in its emails (ADR-033 §12 G1–G5): the quote to accept, other dates
 * to ask for, a no thanks, the cancellation at the fee shown, a card to hold the stay, and the property's
 * change. Opening one only shows the terms (mail scanners fetch links); only its POST acts, bound to the
 * terms the page showed. In the guest's language, in the property's name; never a word of ours.
 */

type StayPayload = PayloadOf<"stay">;

export const STAY_LINK_ACTIONS: ReadonlySet<LinkAction> = new Set([
  "stay_accept",
  "stay_decline",
  "stay_dates",
  "stay_cancel",
  "stay_card",
  "stay_change_yes",
  "stay_change_no",
]);

export function isStayAction(action: LinkAction): boolean {
  return STAY_LINK_ACTIONS.has(action);
}

/** What a stay's link is bound to: the quote's terms, the change's, or the stay itself (cancel, card). */
export async function stayLinkSha(item: Item, action: LinkAction): Promise<string> {
  const p = item.payload as StayPayload;
  if (action === "stay_cancel") return `stay-cancel:${item.id}`;
  if (action === "stay_card") return `stay-card:${item.id}`;
  if ((action === "stay_change_yes" || action === "stay_change_no") && p.change?.quote) {
    return stayTermsSha(
      { checkIn: p.change.checkIn, checkOut: p.change.checkOut, rooms: p.change.rooms ?? p.rooms },
      p.change.quote,
    );
  }
  if (action === "stay_change_yes" || action === "stay_change_no")
    return `stay-change:${item.id}:${p.change?.checkIn}:${p.change?.checkOut}`;
  return p.quote ? stayTermsSha(p, p.quote) : `stay:${item.id}`;
}

/** The few words a page needs beyond the emails', in the six languages. */
interface PageWords {
  readonly total: string;
  readonly help: string;
  readonly expired: string;
  readonly noLonger: (status: string) => string;
  readonly changed: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly note: string;
  readonly send: string;
  readonly decline: string;
  readonly notDone: string;
  readonly payLinks: string;
  readonly cardOpen: string;
  readonly cardLater: string;
}

const WORDS: Readonly<Record<StayLang, PageWords>> = {
  en: {
    total: "Total",
    help: "Questions? Reply to the email.",
    expired: "This link has expired. Reply to the email and we will help you.",
    noLonger: (s) => `This can no longer be done here. ${s}`,
    changed: "What was offered has changed since this email. The newest email has the link.",
    checkIn: "Arrival",
    checkOut: "Departure",
    note: "Anything to add (optional)",
    send: "Send",
    decline: "No, thank you",
    notDone: "Nothing was done. Please try again.",
    payLinks: "To pay:",
    cardOpen: "Continue to add your card",
    cardLater: "Adding a card is not possible right now. Reply to the email and we will help you.",
  },
  es: {
    total: "Total",
    help: "¿Dudas? Responda al correo.",
    expired: "Este enlace ha caducado. Responda al correo y le ayudaremos.",
    noLonger: (s) => `Esto ya no se puede hacer aquí. ${s}`,
    changed: "Lo ofrecido ha cambiado desde este correo. El correo más reciente tiene el enlace.",
    checkIn: "Llegada",
    checkOut: "Salida",
    note: "Algo que añadir (opcional)",
    send: "Enviar",
    decline: "No, gracias",
    notDone: "No se hizo nada. Inténtelo de nuevo.",
    payLinks: "Para pagar:",
    cardOpen: "Continuar para añadir su tarjeta",
    cardLater: "Ahora no es posible añadir una tarjeta. Responda al correo y le ayudaremos.",
  },
  fr: {
    total: "Total",
    help: "Des questions ? Répondez à l'e-mail.",
    expired: "Ce lien a expiré. Répondez à l'e-mail et nous vous aiderons.",
    noLonger: (s) => `Ce n'est plus possible ici. ${s}`,
    changed: "Ce qui était proposé a changé depuis cet e-mail. Le plus récent contient le lien.",
    checkIn: "Arrivée",
    checkOut: "Départ",
    note: "Quelque chose à ajouter (facultatif)",
    send: "Envoyer",
    decline: "Non, merci",
    notDone: "Rien n'a été fait. Veuillez réessayer.",
    payLinks: "Pour payer :",
    cardOpen: "Continuer pour ajouter votre carte",
    cardLater: "Impossible d'ajouter une carte pour le moment. Répondez à l'e-mail et nous vous aiderons.",
  },
  de: {
    total: "Gesamt",
    help: "Fragen? Antworten Sie auf die E-Mail.",
    expired: "Dieser Link ist abgelaufen. Antworten Sie auf die E-Mail, wir helfen Ihnen.",
    noLonger: (s) => `Das ist hier nicht mehr möglich. ${s}`,
    changed: "Das Angebot hat sich seit dieser E-Mail geändert. Die neueste E-Mail enthält den Link.",
    checkIn: "Anreise",
    checkOut: "Abreise",
    note: "Noch etwas (freiwillig)",
    send: "Senden",
    decline: "Nein, danke",
    notDone: "Es wurde nichts getan. Bitte versuchen Sie es erneut.",
    payLinks: "Zum Bezahlen:",
    cardOpen: "Weiter, um Ihre Karte zu hinterlegen",
    cardLater: "Eine Karte zu hinterlegen ist gerade nicht möglich. Antworten Sie auf die E-Mail, wir helfen Ihnen.",
  },
  it: {
    total: "Totale",
    help: "Domande? Rispondi all'email.",
    expired: "Questo link è scaduto. Rispondi all'email e ti aiuteremo.",
    noLonger: (s) => `Qui non è più possibile. ${s}`,
    changed: "L'offerta è cambiata da questa email. L'email più recente contiene il link.",
    checkIn: "Arrivo",
    checkOut: "Partenza",
    note: "Altro da aggiungere (facoltativo)",
    send: "Invia",
    decline: "No, grazie",
    notDone: "Non è stato fatto nulla. Riprova.",
    payLinks: "Per pagare:",
    cardOpen: "Continua per aggiungere la carta",
    cardLater: "Al momento non è possibile aggiungere una carta. Rispondi all'email e ti aiuteremo.",
  },
  pt: {
    total: "Total",
    help: "Dúvidas? Responda ao email.",
    expired: "Esta ligação expirou. Responda ao email e ajudamos.",
    noLonger: (s) => `Isto já não pode ser feito aqui. ${s}`,
    changed: "O que foi proposto mudou desde este email. O email mais recente tem a ligação.",
    checkIn: "Chegada",
    checkOut: "Partida",
    note: "Algo a acrescentar (opcional)",
    send: "Enviar",
    decline: "Não, obrigado",
    notDone: "Nada foi feito. Tente de novo.",
    payLinks: "Para pagar:",
    cardOpen: "Continuar para adicionar o cartão",
    cardLater: "Não é possível adicionar um cartão agora. Responda ao email e ajudamos.",
  },
};

export function pageWordsOf(lang: StayLang): PageWords {
  return WORDS[lang];
}

/** Every page string in a language, for the customer copy lint. */
export function samplePageStrings(lang: StayLang): string[] {
  const w = WORDS[lang];
  return [
    w.total,
    w.help,
    w.expired,
    w.noLonger("x"),
    w.changed,
    w.checkIn,
    w.checkOut,
    w.note,
    w.send,
    w.decline,
    w.notDone,
    w.payLinks,
    w.cardOpen,
    w.cardLater,
  ];
}

export interface StayLinkContext {
  readonly row: LinkRow;
  readonly item: Item;
  readonly business: string;
  readonly token: string;
}

export interface StayPageDeps {
  readonly db: Db;
  /** Opens the card-holding page on the property's own payment platform, when it can. */
  readonly openCard?:
    | ((item: Item, lang: StayLang, returnUrl: string, now: number) => Promise<{ url: string } | { refused: string }>)
    | undefined;
  /** Reads back whether the guest saved the card (the platform's word, with the business's key). */
  readonly checkCard?: ((item: Item, now: number) => Promise<boolean>) | undefined;
  /** This inbox's public address, for where the payment platform sends the guest back. */
  readonly base?: string | undefined;
}

/** Money as the guest reads it where the property is, its narrow spaces kept from vanishing in a bold face. */
function money(m: { value: number; currency: string }, locale: string): string {
  return formatMinor(m, locale).replace(/[\u202f\u2009]/g, "\u00a0");
}

function guestCaller(ctx: StayLinkContext, now: number, lang: StayLang): Caller {
  return {
    actor: { kind: "customer_human", id: `link:${ctx.row.jti}`, partyId: ctx.item.partyId, channel: "action_link" },
    tier: "verified_principal",
    sandbox: ctx.item.flags.sandbox,
    locale: lang,
    idempotency: { scope: "link", key: `link:${ctx.row.jti}` },
    now: () => now,
  };
}

/** The quote's lines, total and schedule as a page's rows. */
function quoteRows(q: StayQuote, c: StayCopy, lang: StayLang, locale: string): { label: string; value: string }[] {
  const rows = q.lines.map((l) => ({
    label: l.label,
    value: money({ value: l.amount, currency: q.currency }, locale),
  }));
  rows.push({ label: WORDS[lang].total, value: money(q.total, locale) });
  const now = q.schedule.filter((s) => s.type === "immediate").reduce((a, s) => a + s.amount.value, 0);
  const there = q.schedule.filter((s) => s.type === "at_property").reduce((a, s) => a + s.amount.value, 0);
  if (now > 0) rows.push({ label: c.schedule.now, value: money({ value: now, currency: q.currency }, locale) });
  if (there > 0)
    rows.push({ label: c.schedule.atProperty, value: money({ value: there, currency: q.currency }, locale) });
  return rows;
}

async function payLinks(db: Db, itemId: string, lang: StayLang, locale: string): Promise<PageLink[]> {
  const { rows } = await db.client.query({
    sql: "SELECT url, amount, currency FROM connector_payments WHERE item_id = ? AND state = 'open' AND url IS NOT NULL ORDER BY created_at",
    params: [itemId],
    method: "all",
  });
  const c = stayCopy(lang);
  return rows.map((r) => ({
    label: c.page.pay({ amount: money({ value: Number(r[1]), currency: String(r[2]) }, locale) }),
    href: String(r[0]),
  }));
}

/** The page a stay's link opens: the terms first, and a form whose POST acts on exactly those. */
export async function stayLinkView(
  deps: StayPageDeps,
  ctx: StayLinkContext,
  now: number,
  opts: { readonly error?: string | undefined; readonly status?: CustomerPage["status"] | undefined } = {},
): Promise<CustomerPage> {
  const { row, item } = ctx;
  const p = item.payload as StayPayload;
  const lang = stayLang(row.langTag);
  const c = stayCopy(lang);
  const w = WORDS[lang];
  const setup = await readSetup(deps.db, p.propertyId);
  const locale = propertyLocale(lang, setup?.property);
  const property = setup?.property.name ?? ctx.business;
  const ref = shortRef(item.id);
  const base = (status: CustomerPage["status"], heading: string, more: Partial<CustomerPage> = {}): CustomerPage => ({
    status,
    lang,
    business: property,
    heading,
    footer: `${c.with({ property })} · ${c.page.reference({ ref })}`,
    help: w.help,
    ...more,
  });
  const dates = datesWords(p.checkIn, p.checkOut, lang, setup?.property);
  const statusWord = c.page.status[item.state] ?? item.state;
  if (row.usedAt !== null) return doneView(deps, ctx, base, now);
  if (now > row.expiresAt) return base(410, w.expired);
  if (row.termsSha !== (await stayLinkSha(item, row.action))) return base(409, w.changed);
  const hidden = { terms: row.termsSha, v: String(item.version) };
  const nights = c.nights(nightsOf(p.checkIn, p.checkOut).length);
  switch (row.action) {
    case "stay_accept": {
      const q = p.quote;
      if (item.state !== "quoted" || !q) return base(409, w.noLonger(statusWord));
      const free = q.policy.steps.find((s) => s.fee.value === 0);
      const policy = policySentence(q.policy, {
        lang,
        locale,
        total: q.total,
        what: "stay",
        place: setup?.property.locality ?? undefined,
      });
      return base(
        opts.status ?? 200,
        c.page.confirmAccept({ nights, dates, total: money(q.total, locale), ...(free ? { free: policy } : {}) }),
        {
          rows: quoteRows(q, c, lang, locale),
          // The policy once: in the heading when cancelling is free for a while, else under it.
          paragraphs: [
            ...(free ? [] : [policy]),
            c.emails.quote.holds({ until: setup ? whenWords(setup, q.validThrough, lang) : q.validThrough }),
          ],
          form: { hidden, fields: [], button: dueNow(q) ? c.page.bookAndPay : c.page.obligation },
          ...(opts.error ? { error: opts.error } : {}),
        },
      );
    }
    case "stay_decline":
      if (item.state !== "quoted") return base(409, w.noLonger(statusWord));
      return base(opts.status ?? 200, c.page.noThanks, {
        paragraphs: [dates],
        form: {
          hidden,
          fields: [{ kind: "textarea", name: "note", label: w.note, required: false, maxLength: 2_000 }],
          button: w.decline,
        },
        ...(opts.error ? { error: opts.error } : {}),
      });
    case "stay_dates":
      if (item.state !== "quoted") return base(409, w.noLonger(statusWord));
      return base(opts.status ?? 200, c.page.otherDates, {
        paragraphs: [dates],
        form: {
          hidden,
          fields: [
            { kind: "date", name: "check_in", label: w.checkIn, required: true, maxLength: 10, value: p.checkIn },
            { kind: "date", name: "check_out", label: w.checkOut, required: true, maxLength: 10, value: p.checkOut },
            { kind: "textarea", name: "note", label: w.note, required: false, maxLength: 2_000 },
          ],
          button: w.send,
        },
        ...(opts.error ? { error: opts.error } : {}),
      });
    case "stay_cancel": {
      const q = p.quote;
      if (item.state !== "confirmed" || !q) return base(409, w.noLonger(statusWord));
      const terms = cancellationTerms(q, paidOf(p), now);
      const paid = paidOf(p);
      const lines =
        terms.fee.value === 0
          ? [paid.value > 0 ? c.page.cancelFree({ property, paid: money(paid, locale) }) : c.page.cancelNothingBack]
          : [
              // The last free day as the guest reads a date, when there was one; else what it costs now.
              q.policy.steps.at(-1)?.until && setup
                ? c.page.cancelQuestion({
                    date: whenWords(setup, q.policy.steps.at(-1)?.until ?? "", lang),
                    fee: money(terms.fee, locale),
                  })
                : c.page.cancelNow({ fee: money(terms.fee, locale) }),
              terms.refund.value > 0
                ? c.page.cancelRefund({ paid: money(paid, locale), property, refund: money(terms.refund, locale) })
                : c.page.cancelNothingBack,
            ];
      return base(opts.status ?? 200, c.page.cancelMine, {
        paragraphs: [dates, ...lines],
        form: { hidden: { ...hidden, fee: await feeSha(item.id, terms) }, fields: [], button: c.page.cancelMine },
        links: { items: [] },
        ...(opts.error ? { error: opts.error } : {}),
      });
    }
    case "stay_card":
      if (p.payments?.guarantee.status === "saved" || (deps.checkCard && (await deps.checkCard(item, now)))) {
        return base(200, c.page.cardSaved);
      }
      if (item.state !== "awaiting_payment" && item.state !== "confirmed") return base(409, w.noLonger(statusWord));
      return base(opts.status ?? 200, c.page.addCard, {
        paragraphs: [c.page.card({ property })],
        form: { hidden, fields: [], button: c.page.addCard },
        ...(opts.error ? { error: opts.error } : {}),
      });
    case "stay_change_yes":
    case "stay_change_no": {
      const change = p.change;
      if (item.state !== "confirmed" || !change || change.by !== "business") return base(409, w.noLonger(statusWord));
      const newDates = datesWords(change.checkIn, change.checkOut, lang, setup?.property);
      const yes = row.action === "stay_change_yes";
      return base(opts.status ?? 200, yes ? c.page.changeMine : c.page.keep, {
        paragraphs: [
          newDates,
          ...(change.quote ? [c.page.newTotal({ total: money(change.quote.total, locale) })] : []),
        ],
        ...(change.quote ? { rows: quoteRows(change.quote, c, lang, locale) } : {}),
        form: { hidden, fields: [], button: yes ? c.page.changeMine : c.page.keep },
        ...(opts.error ? { error: opts.error } : {}),
      });
    }
    default:
      return base(404, w.expired);
  }
}

/** What a used link shows: where the stay stands now, with what is still to pay and how. */
async function doneView(
  deps: StayPageDeps,
  ctx: StayLinkContext,
  base: (status: CustomerPage["status"], heading: string, more?: Partial<CustomerPage>) => CustomerPage,
  now: number,
): Promise<CustomerPage> {
  const [fresh] = (
    await deps.db.client.query({
      sql: "SELECT state, payload FROM items WHERE id = ?",
      params: [ctx.item.id],
      method: "all",
    })
  ).rows;
  const state = String(fresh?.[0] ?? ctx.item.state);
  const p = JSON.parse(String(fresh?.[1] ?? JSON.stringify(ctx.item.payload))) as StayPayload;
  const lang = stayLang(ctx.row.langTag);
  const c = stayCopy(lang);
  const setup = await readSetup(deps.db, p.propertyId);
  const locale = propertyLocale(lang, setup?.property);
  const property = setup?.property.name ?? ctx.business;
  const paragraphs: string[] = [datesWords(p.checkIn, p.checkOut, lang, setup?.property)];
  if (state === "confirmed" && setup) {
    paragraphs.push(
      c.emails.confirmed.times({ time: setup.property.checkInFrom, until: setup.property.checkOutUntil }),
    );
    paragraphs.push(c.notInvoice({ property }));
  }
  const links = state === "awaiting_payment" ? await payLinks(deps.db, ctx.item.id, lang, locale) : [];
  if (state === "awaiting_payment" && p.payments?.dueBy && setup) {
    const due = (p.payments.schedules ?? [])
      .filter((s) => s.type === "immediate" && s.status === "due")
      .reduce((a, s) => a + s.amount.value, 0);
    if (due > 0)
      paragraphs.push(
        c.page.payBy({
          amount: money({ value: due, currency: p.quote?.currency ?? setup.property.currency }, locale),
          property,
          until: whenWords(setup, p.payments.dueBy, lang),
        }),
      );
  }
  void now;
  return base(200, state === "confirmed" ? c.page.booked : (c.page.status[state] ?? state), {
    paragraphs,
    ...(links.length ? { links: { lead: WORDS[lang].payLinks, items: links } } : {}),
  });
}

/** A POST from a stay's page: checked against what the page showed, then one transition. */
export async function stayLinkAct(
  deps: StayPageDeps,
  ctx: StayLinkContext,
  form: Readonly<Record<string, string | undefined>>,
  now: number,
): Promise<LinkActResult> {
  const { row, item } = ctx;
  const lang = stayLang(row.langTag);
  const w = WORDS[lang];
  if (row.usedAt !== null) return { redirect: `/c/${ctx.token}` };
  const version = Number(form.v);
  if (!form.terms || !Number.isInteger(version) || version < 1) {
    return { page: await stayLinkView(deps, ctx, now, { error: w.notDone, status: 422 }) };
  }
  if (form.terms !== row.termsSha || row.termsSha !== (await stayLinkSha(item, row.action))) {
    return { page: await stayLinkView(deps, ctx, now, { status: 409 }) };
  }
  const caller = guestCaller(ctx, now, lang);
  const note = (form.note ?? "").trim().slice(0, 2_000);
  const p = item.payload as StayPayload;
  let event: string;
  let input: Record<string, unknown> = {};
  switch (row.action) {
    case "stay_accept":
      event = "accept";
      input = { terms_sha: p.quote ? await stayTermsSha(p, p.quote) : "" };
      break;
    case "stay_decline":
      event = "decline";
      input = note ? { note } : {};
      break;
    case "stay_dates": {
      const checkIn = (form.check_in ?? "").trim();
      const checkOut = (form.check_out ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || checkOut <= checkIn) {
        return { page: await stayLinkView(deps, ctx, now, { error: w.notDone, status: 422 }) };
      }
      event = "counter";
      input = { checkIn, checkOut, ...(note ? { note } : {}) };
      break;
    }
    case "stay_cancel":
      event = "cancel";
      input = { fee_sha: form.fee ?? "" };
      break;
    case "stay_card": {
      if (!deps.openCard) return { page: await stayLinkView(deps, ctx, now, { error: w.cardLater, status: 409 }) };
      const opened = await deps.openCard(item, lang, `${(deps.base ?? "").replace(/\/+$/, "")}/c/${ctx.token}`, now);
      if ("refused" in opened) return { page: await stayLinkView(deps, ctx, now, { error: w.cardLater, status: 409 }) };
      // A form may not take the guest to another site after it posts: they follow this link instead.
      const view = await stayLinkView(deps, ctx, now);
      return { page: { ...view, form: undefined, links: { items: [{ label: w.cardOpen, href: opened.url }] } } };
    }
    case "stay_change_yes":
      event = "accept_change";
      input = p.change?.quote
        ? {
            terms_sha: await stayTermsSha(
              { checkIn: p.change.checkIn, checkOut: p.change.checkOut, rooms: p.change.rooms ?? p.rooms },
              p.change.quote,
            ),
          }
        : {};
      break;
    case "stay_change_no":
      event = "decline_change";
      input = note ? { note } : {};
      break;
    default:
      return { page: await stayLinkView(deps, ctx, now, { status: 404 }) };
  }
  try {
    await transitionItem(deps.db, caller, {
      itemId: item.id,
      event,
      input,
      expectedVersion: version,
      extraStatements: [linkUsedStatement(row.jti, now)],
      hashInput: { link: row.jti, event, input },
    });
    return { redirect: `/c/${ctx.token}` };
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
    // The fee moved on since the page was shown (a step passed): the page again, with the fee as it is now.
    const why =
      error.code === "confirm_terms" || error.code === "offer_changed" || error.code === "version_conflict"
        ? w.changed
        : error.message;
    return { page: await stayLinkView(deps, ctx, now, { error: why, status: 409 }) };
  }
}
