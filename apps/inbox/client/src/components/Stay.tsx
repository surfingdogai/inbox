import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { parseMajor } from "../lib/actions";
import { problemOf } from "../lib/api";
import { minorUnitsOf } from "../lib/currencies";
import { formatDateTime, formatMoney } from "../lib/format";
import { languageName } from "../lib/languages";
import {
  holdMinutesLeft,
  MEAL_WORDS,
  propertyApi,
  quoteSums,
  type StayQuoteView,
  scheduleWord,
  systemWords,
  useProperty,
} from "../lib/property";
import { useOwnerLocale, useTransition } from "../lib/queries";
import { guestWords, nightsOf, stayDates } from "../lib/stays";
import type { ItemOf } from "../lib/types";
import { MoneyInput } from "./Choosers";
import { Field } from "./Form";

type Stay = ItemOf<"stay">;

function F({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean | undefined }) {
  return (
    <div className={wide ? "wide" : undefined}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A stay's facts in the detail panel (S12): the dates and nights, the rooms and who for, the plan,
 * what is paid and what is still due, the arrival window, a hold's minutes, and where it stands with
 * the property's own system.
 */
export function StayFields({ item, tz }: { item: Stay; tz: string | undefined }) {
  const locale = useOwnerLocale();
  const p = item.payload;
  const nights = nightsOf(p.checkIn, p.checkOut);
  const hold = holdMinutesLeft(p);
  const system = systemWords(p, item.state);
  const plan = p.quote?.ratePlan ?? null;
  return (
    <>
      <F label="Dates">
        {stayDates(p.checkIn, p.checkOut, locale)} · {nights} night{nights === 1 ? "" : "s"}
      </F>
      <F label="Guests">{guestWords(p)}</F>
      <F label="Rooms" wide>
        {p.rooms.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rooms are the stay's lines, in order
          <div key={i}>
            {r.roomTypeName || "Any room"}
            {r.childrenAges.length > 0 ? ` · children ${r.childrenAges.join(", ")}` : ""}
          </div>
        ))}
      </F>
      {plan && (
        <F label="Plan">
          {plan.name} · {MEAL_WORDS[plan.meal] ?? plan.meal}
          {plan.refundable ? "" : " · non-refundable"}
        </F>
      )}
      {p.totalPrice && <F label="Total">{formatMoney(p.totalPrice, locale)}</F>}
      {p.arrival && (
        <F label="Arriving">
          {p.arrival.from}–{p.arrival.to}
        </F>
      )}
      {hold !== null && <F label="Held">{hold} min left</F>}
      {system && <F label="Property system">{system}</F>}
      {p.guests?.lead.name && <F label="Lead guest">{p.guests.lead.name}</F>}
      {p.requests && (
        <F label="Requests" wide>
          {p.requests}
        </F>
      )}
      {(p.payments?.schedules ?? []).length > 0 && (
        <F label="Payments" wide>
          {(p.payments?.schedules ?? []).map((s) => (
            <div key={s.id}>
              {formatMoney(s.amount, locale)} · {scheduleWord(s.status)}
              {s.dueAt && s.status === "due" ? ` by ${formatDateTime(s.dueAt, tz, locale)}` : ""}
            </div>
          ))}
        </F>
      )}
      {p.payments?.guarantee.status === "requested" && <F label="Card">Asked for, not saved yet</F>}
      {p.payments?.guarantee.status === "saved" && <F label="Card">Saved to hold the stay</F>}
      {p.cancellation && (
        <F label="Cancelled" wide>
          {formatDateTime(p.cancellation.at, tz, locale)} by the {p.cancellation.by} · fee{" "}
          {formatMoney(p.cancellation.fee, locale)}
          {p.cancellation.refundOwed ? ` · to refund ${formatMoney(p.cancellation.refundOwed, locale)}` : ""}
        </F>
      )}
      {p.change && (
        <F label="Change asked" wide>
          {stayDates(p.change.checkIn, p.change.checkOut, locale)}
          {p.change.quote ? ` · ${formatMoney(p.change.quote.total, locale)}` : ""}
          {p.change.writing ? " · being written to your system" : ""}
        </F>
      )}
    </>
  );
}

/** The quote in force, line by line, with what is paid when (S12). */
export function StayQuoteBlock({ quote, tz }: { quote: StayQuoteView; tz: string | undefined }) {
  const sums = quoteSums(quote);
  const locale = useOwnerLocale();
  return (
    <div className="stack">
      <div className="eyebrow">{quote.source === "person" ? "Your quote" : "Quote from your rates"}</div>
      <QuoteLines quote={quote} locale={locale} />
      <dl className="fields quote-fields">
        {sums.now && <F label="Now">{sums.now}</F>}
        {sums.later && <F label="Later">{sums.later}</F>}
        {sums.atProperty && <F label="At the property">{sums.atProperty}</F>}
        <F label="Valid through">{formatDateTime(quote.validThrough, tz)}</F>
      </dl>
    </div>
  );
}

/** A quote's lines as its guest reads them (their language), the amounts as the owner app writes money. */
function QuoteLines({ quote, locale }: { quote: StayQuoteView; locale: string | undefined }) {
  return (
    <div className="money">
      {quote.lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a quote's lines are in order and never move
        <Fragment key={i}>
          <span>{l.label}</span>
          <span>{l.collected === "at_property" ? "at the property" : ""}</span>
          <span>{formatMoney({ value: l.amount, currency: quote.currency }, locale)}</span>
        </Fragment>
      ))}
      <span className="tot">Total</span>
      <span className="tot" />
      <span className="tot">{formatMoney(quote.total, locale)}</span>
    </div>
  );
}

/**
 * The quote composer (S13): for a request, each room as a room type and a plan, priced from the
 * rates as the guest would be quoted, then sent in one press. Nothing goes until the owner presses.
 */
export function StayQuoteComposer({ item, guest }: { item: Stay; guest?: string | null | undefined }) {
  const property = useProperty();
  const locale = useOwnerLocale();
  const setup = property.data?.setup ?? null;
  const p = item.payload;
  const [picks, setPicks] = useState(() =>
    p.rooms.map((r) => ({ room: r.roomTypeId ?? "", plan: r.ratePlanId ?? "" })),
  );
  // The owner's own price for the room nights, where the rates do not cover them yet.
  const [typed, setTyped] = useState("");
  const currency = setup?.property.currency ?? "";
  const ownPrice = typed ? parseMajor(typed, minorUnitsOf(currency)) : undefined;
  const price = ownPrice !== undefined && ownPrice > 0 ? { value: ownPrice, currency } : undefined;
  const chosen = picks.every((x) => x.room);
  const rooms = picks.map((x, index) => ({
    index,
    room_type_id: x.room,
    ...(x.plan ? { rate_plan_id: x.plan } : {}),
  }));
  const rated = useQuery({
    queryKey: ["property", "draft", item.id, rooms],
    queryFn: () => propertyApi.draftQuote(item.id, rooms),
    enabled: chosen,
    staleTime: 10_000,
  });
  const priced = useQuery({
    queryKey: ["property", "draft", item.id, rooms, price?.value ?? 0],
    queryFn: () => propertyApi.draftQuote(item.id, rooms, price),
    enabled: chosen && price !== undefined && rated.data !== undefined && !rated.data.quote,
    staleTime: 10_000,
  });
  const own = rated.data !== undefined && !rated.data.quote;
  const draft = own ? priced : rated;
  const send = useTransition(item.id);
  if (!setup) return null;
  const nights = nightsOf(p.checkIn, p.checkOut);
  const firstRoom = setup.rooms.find((r) => r.id === picks[0]?.room)?.name ?? "this room";
  const lang = rated.data?.lang;
  const offered = setup.rooms.filter((r) => r.active && r.offered);
  const plans = setup.plans.filter((x) => x.active);
  const set = (i: number, next: Partial<{ room: string; plan: string }>) =>
    setPicks((all) => all.map((x, j) => (j === i ? { ...x, ...next } : x)));
  return (
    <div className="stack">
      <div className="eyebrow">Quote this stay</div>
      {p.rooms.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rooms are the stay's lines, in order
        <div key={i} className="grid2">
          <div>
            <label className="label" htmlFor={`q-room-${i}`}>
              Room {p.rooms.length > 1 ? i + 1 : ""} · {r.adults} adult{r.adults === 1 ? "" : "s"}
            </label>
            <select
              id={`q-room-${i}`}
              className="input"
              value={picks[i]?.room ?? ""}
              onChange={(e) => set(i, { room: e.target.value })}
            >
              <option value="">Choose a room type</option>
              {offered.map((o) => (
                <option key={o.id} value={o.id} disabled={o.capacity.total < r.adults + r.childrenAges.length}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`q-plan-${i}`}>
              Plan
            </label>
            <select
              id={`q-plan-${i}`}
              className="input"
              value={picks[i]?.plan ?? ""}
              onChange={(e) => set(i, { plan: e.target.value })}
            >
              <option value="">Best price that fits</option>
              {plans.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
      {rated.isPending && chosen && <div className="skeleton sk-line" />}
      {own && (
        <Field
          id={`q-price-${item.id}`}
          label={`Price for these ${nights} night${nights === 1 ? "" : "s"}`}
          hint={`Your rates don't cover these nights yet. Type a price, or add a rate for ${firstRoom}. Your taxes and fees are added.`}
        >
          <MoneyInput
            id={`q-price-${item.id}`}
            value={typed}
            onChange={setTyped}
            currency={currency}
            invalid={!!typed && price === undefined}
          />
        </Field>
      )}
      {draft.data?.quote && (
        <>
          <div className="label">
            As {guest?.trim() || p.guests?.lead.name?.trim() || "the guest"} will read it
            {lang ? ` (${languageName(lang)})` : ""}
          </div>
          <QuoteLines quote={draft.data.quote} locale={locale} />
        </>
      )}
      {own && price && priced.data && !priced.data.quote && <p className="hint">{priced.data.reason}</p>}
      {draft.isError && <p className="hint error">{problemOf(draft.error).detail}</p>}
      {send.isError && <p className="hint error">{problemOf(send.error).detail}</p>}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!draft.data?.quote || send.isPending}
          onClick={() =>
            send.mutate({
              event: "quote",
              input: {
                rooms: rooms.map((r) => ({
                  index: r.index,
                  roomTypeId: r.room_type_id,
                  ...(r.rate_plan_id ? { ratePlanId: r.rate_plan_id } : {}),
                })),
                ...(own && price ? { price } : {}),
              },
            })
          }
        >
          Send this quote
        </button>
      </div>
    </div>
  );
}
