import { checkStayTotals, type StayQuote } from "@surfingdog/spec";
import { base64Url } from "../customer/offer";
import type { Money } from "../domain/types";
import { feeAt, policySentence, refundOwed } from "../policy/index";
import { canonicalJson } from "../util/canonical";
import { formatMinor } from "../util/money";
import { instantOf } from "../util/zoned";
import { type StayLang, stayCopy } from "./copy";
import { stayTimes } from "./nights";
import { propertyLocale } from "./price";
import type { PropertySetup } from "./store";

/**
 * What a guest is shown and confirms before they are bound (ADR-033 §11): the total, the schedule, the
 * policy's dated steps, the rate plan, the rooms and the dates, as one fingerprint (`terms_sha`) — and,
 * before a confirmed stay is cancelled, the fee and what is owed back as of now (`fee_sha`). A request
 * with a stale fingerprint is answered with the terms as they are now, never taken on the old ones.
 */

async function sha(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

export interface StayTermsSubject {
  readonly checkIn: string;
  readonly checkOut: string;
  readonly rooms: readonly {
    readonly roomTypeId?: string | undefined;
    readonly adults: number;
    readonly childrenAges: readonly number[];
  }[];
}

/** The fingerprint of a quote's terms for a stay: what accepting, booking or a priced request confirms. */
export function stayTermsSha(stay: StayTermsSubject, quote: StayQuote): Promise<string> {
  return sha({
    kind: "stay",
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    rooms: stay.rooms.map((r) => ({ room: r.roomTypeId ?? null, adults: r.adults, children: [...r.childrenAges] })),
    total: quote.total,
    schedule: quote.schedule.map((s) => ({ id: s.id, type: s.type, amount: s.amount, dueAt: s.dueAt ?? null })),
    policy: quote.policy,
    ratePlan: quote.ratePlan,
    guarantee: quote.guarantee,
  });
}

/** What cancelling a confirmed stay costs now, and what is owed back of what was paid. */
export function cancellationTerms(
  quote: StayQuote,
  paid: Money,
  at: number,
  opts: { readonly keep?: Money | undefined } = {},
): { readonly fee: Money; readonly refund: Money } {
  const fee = feeAt(quote.policy, at, { total: quote.total, ...(opts.keep ? { keep: opts.keep } : {}) });
  return { fee, refund: refundOwed(paid, fee) };
}

/** The fingerprint of a cancellation's terms as of now: the fee and what is owed back. */
export function feeSha(itemId: string, terms: { readonly fee: Money; readonly refund: Money }): Promise<string> {
  return sha({ kind: "stay_cancel", item: itemId, fee: terms.fee, refund: terms.refund });
}

/**
 * Why a quote cannot be sent for this stay, or an empty list: the spec's invariants, every step before
 * arrival at check-in time, one currency (the property's), and it can still be accepted.
 */
export function quoteProblems(
  setup: PropertySetup,
  stay: { readonly checkIn: string; readonly checkOut: string },
  quote: StayQuote,
  now: number,
): string[] {
  const arrivalAt = instantOf(stay.checkIn, setup.property.checkInFrom, setup.property.timezone);
  const problems = checkStayTotals(quote, { now, arrivalAt });
  if (quote.currency !== setup.property.currency) {
    problems.push(`the quote is in ${quote.currency}, the property prices in ${setup.property.currency}`);
  }
  return problems;
}

/** The lines and total of a quote in the guest's language, with what is paid now and at the property. */
export function quoteWords(
  setup: PropertySetup,
  quote: StayQuote,
  lang: StayLang,
): { readonly total: string; readonly now: string | null; readonly there: string | null; readonly policy: string } {
  const locale = propertyLocale(lang, setup.property);
  const sum = (types: readonly string[]) =>
    quote.schedule.filter((s) => types.includes(s.type)).reduce((a, s) => a + s.amount.value, 0);
  const now = sum(["immediate"]);
  const there = sum(["at_property"]);
  const money = (value: number) => formatMinor({ value, currency: quote.currency }, locale);
  return {
    total: money(quote.total.value),
    now: now > 0 ? money(now) : null,
    there: there > 0 ? money(there) : null,
    policy: policySentence(quote.policy, {
      lang,
      locale,
      total: quote.total,
      what: "stay",
      place: setup.property.locality ?? undefined,
    }),
  };
}

/** Whether something is to be paid now on a quote: a deposit, or a card to hold the stay. */
export function dueNow(quote: StayQuote): boolean {
  return quote.guarantee === "card" || quote.schedule.some((s) => s.type === "immediate" && s.amount.value > 0);
}

/**
 * The guest's words for a stay's dates, "12–15 Dec", "1.–4. Nov.", "Nov 1 – 4", as their language
 * writes a range where the property is: the runtime's own range, its spaces kept from breaking.
 */
export function datesWords(
  checkIn: string,
  checkOut: string,
  lang: StayLang,
  property?: { readonly timezone: string } | null,
): string {
  const locale = propertyLocale(lang, property);
  const a = new Date(`${checkIn}T12:00:00Z`);
  const b = new Date(`${checkOut}T12:00:00Z`);
  try {
    const f = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
    return f.formatRange(a, b).replace(/[\u202f\u2009]/g, "\u00a0");
  } catch {
    return `${checkIn} – ${checkOut}`;
  }
}

/** An instant in the property's zone, in the guest's language: "13 Nov, 10:00 Kyoto time". */
export function whenWords(setup: PropertySetup, iso: string, lang: StayLang): string {
  const locale = propertyLocale(lang, setup.property);
  const zone = setup.property.timezone;
  const at = new Date(iso);
  try {
    const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: zone }).format(at);
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    }).format(at);
    return `${date}, ${time}`;
  } catch {
    return iso;
  }
}

/** The words a confirmed stay's guest reads about its times: check-in from, check-out by. */
export function timesWords(setup: PropertySetup, checkIn: string, checkOut: string, lang: StayLang): string {
  const c = stayCopy(lang);
  stayTimes(setup.property, checkIn, checkOut);
  return c.emails.confirmed.times({ time: setup.property.checkInFrom, until: setup.property.checkOutUntil });
}
