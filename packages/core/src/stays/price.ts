import { type StayQuote, type StayQuoteLine, type StayScheduleEntry, shareOf, stayPolicySteps } from "@surfingdog/spec";
import type { Money } from "../domain/types";
import { datePolicy, refundable } from "../policy/index";
import { countryOfZone, localeFor } from "../util/geo";
import { formatMinor } from "../util/money";
import { addDays, instantOf, isoIn } from "../util/zoned";
import { lodgingWord, type StayLang, stayCopy } from "./copy";
import { covers, nightsOf, stayTimes } from "./nights";
import type { PropertySetup, RatePlanRow, RateRow, RoomTypeRow } from "./store";

/**
 * A stay's price from the property's own rates (ADR-033 §5.1–§5.2): night by night from the rate plan's
 * season that covers it (else its base, by weekday), extra guests above the base occupancy, children
 * under the property's age free in existing beds, a derived plan's percent off, then extras, then every
 * tax and fee, whoever collects it. Each line is rounded to the currency's minor unit, half up; the total
 * is their sum, and the schedule adds up to it. Real tax rates are always the property's input.
 *
 * Pure: it reads the property's setup and the request, and writes nothing.
 */

export interface PricedRoom {
  readonly roomTypeId: string;
  readonly ratePlanId?: string | undefined;
  readonly adults: number;
  readonly childrenAges: readonly number[];
  readonly extras: readonly { readonly extraId: string; readonly quantity: number }[];
}

export interface PriceRequest {
  readonly checkIn: string;
  readonly checkOut: string;
  readonly rooms: readonly PricedRoom[];
  /** The guest's language: the words of the lines. */
  readonly lang: StayLang;
  /** When it is priced: steps already past are left out, and validity counts from now. */
  readonly now: number;
  /** How long the quote holds, in hours: the property's own when left out. */
  readonly validHours?: number | undefined;
  readonly source: StayQuote["source"];
  /** A connected system's own subtotal per room (its offer), when it gives one: used in place of the rates. */
  readonly systemSubtotals?: readonly ({ readonly nights: readonly { night: string; amount: number }[] } | null)[];
  /**
   * What the property can take before arrival (`payCollection`): with no payment platform connected,
   * the plan's deposit and balance are paid at the property and no card is asked for. Left out, as
   * the plan says.
   */
  readonly collect?: { readonly links: boolean; readonly cards: boolean } | undefined;
}

export type PriceResult =
  | { readonly ok: true; readonly quote: StayQuote; readonly roomNames: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly code: "no_room" | "no_rate" | "no_price" | "too_short" };

/** The rate plan a room is priced on: the one named, else the first active plan offered for that room. */
export function planFor(setup: PropertySetup, roomTypeId: string, ratePlanId?: string): RatePlanRow | undefined {
  const usable = (p: RatePlanRow) => p.active && (p.roomTypeIds === null || p.roomTypeIds.includes(roomTypeId));
  if (ratePlanId) return setup.plans.find((p) => p.id === ratePlanId && usable(p));
  return setup.plans.find((p) => usable(p) && p.offered);
}

/** How many weekdays a row covers: the fewer, the more specific (Friday and Saturday over every day). */
function weekdayCount(mask: number): number {
  let n = 0;
  for (let m = mask & 127; m; m &= m - 1) n++;
  return n;
}

/**
 * The rate row that prices a night, the most specific that covers it, whatever order the rows come in:
 * a season over the base, the latest-starting season first, then the one for fewer weekdays (a weekend
 * row over an every-day row), then the shorter season.
 */
export function rateFor(
  rates: readonly RateRow[],
  planId: string,
  roomTypeId: string,
  night: string,
): RateRow | undefined {
  const mine = rates.filter((r) => r.ratePlanId === planId && r.roomTypeId === roomTypeId && covers(r, night));
  const order = (a: RateRow, b: RateRow): number =>
    Number(a.fromDate === "") - Number(b.fromDate === "") ||
    b.fromDate.localeCompare(a.fromDate) ||
    weekdayCount(a.weekdays) - weekdayCount(b.weekdays) ||
    (a.toDate || a.fromDate).localeCompare(b.toDate || b.fromDate);
  return [...mine].sort(order)[0];
}

/** What one night of one room costs for its guests, on a rate row. */
function nightly(rate: RateRow, adults: number, payingChildren: number): number {
  const extraAdults = Math.max(0, adults - rate.baseGuests);
  const room = Math.max(0, rate.baseGuests - adults);
  const extraChildren = Math.max(0, payingChildren - room);
  return rate.nightly + extraAdults * (rate.extraAdult ?? 0) + extraChildren * (rate.extraChild ?? 0);
}

/** Children who are charged: those at or above the age under which the property lets them stay free. */
function payingChildren(setup: PropertySetup, ages: readonly number[]): number {
  const free = setup.property.children.freeUnder;
  return free === undefined ? ages.length : ages.filter((a) => a >= free).length;
}

/** A room's price night by night, from the rates (or the system's offer), with a derived plan's discount. */
function roomNights(
  setup: PropertySetup,
  room: PricedRoom,
  plan: RatePlanRow,
  nights: readonly string[],
  system: { readonly nights: readonly { night: string; amount: number }[] } | null | undefined,
): { night: string; amount: number }[] | null {
  if (system) return nights.map((n) => ({ night: n, amount: system.nights.find((x) => x.night === n)?.amount ?? 0 }));
  const basePlan = plan.derived ? setup.plans.find((p) => p.id === plan.derived?.fromPlanId) : plan;
  if (!basePlan) return null;
  const off = plan.derived ? Math.max(0, Math.min(100, plan.derived.percentOff)) : 0;
  const out: { night: string; amount: number }[] = [];
  for (const n of nights) {
    const rate = rateFor(setup.rates, basePlan.id, room.roomTypeId, n);
    if (!rate) return null;
    const full = nightly(rate, room.adults, payingChildren(setup, room.childrenAges));
    out.push({ night: n, amount: off ? shareOf(full, (100 - off) * 100) : full });
  }
  return out;
}

/** The shortest stay the rates for these nights allow (a season's own minimum, else the plan's). */
function minimumStay(setup: PropertySetup, plan: RatePlanRow, roomTypeId: string, nights: readonly string[]): number {
  const basePlan = plan.derived ? (setup.plans.find((p) => p.id === plan.derived?.fromPlanId) ?? plan) : plan;
  const first = nights[0];
  const rate = first ? rateFor(setup.rates, basePlan.id, roomTypeId, first) : undefined;
  return Math.max(plan.minNights, rate?.minNights ?? 1);
}

const percent = (bp: number) => `${Math.round(bp) / 100}%`.replace(/\.0+%$/, "%");

/** Prices a stay from the property's rates: the quote, or why it cannot be priced. */
export function quoteFromRates(setup: PropertySetup, req: PriceRequest): PriceResult {
  const { property } = setup;
  const c = stayCopy(req.lang);
  const locale = propertyLocale(req.lang, property);
  const cur = property.currency;
  const money = (value: number): Money => ({ value, currency: cur });
  const nights = nightsOf(req.checkIn, req.checkOut);
  const lines: StayQuoteLine[] = [];
  const perNight = new Map<string, number>();
  const roomNames: string[] = [];
  let plan: RatePlanRow | undefined;
  let roomSubtotal = 0;
  let guestsAll = 0;
  const priced: { room: RoomTypeRow; nights: { night: string; amount: number }[]; guests: number }[] = [];
  for (const [i, r] of req.rooms.entries()) {
    const room = setup.rooms.find((x) => x.id === r.roomTypeId && x.active);
    if (!room) return { ok: false, code: "no_room", reason: "that room is not one of this property's" };
    const p = planFor(setup, r.roomTypeId, r.ratePlanId ?? plan?.id);
    if (!p) return { ok: false, code: "no_rate", reason: `no rate is set for ${room.name}` };
    if (plan && p.id !== plan.id)
      return { ok: false, code: "no_rate", reason: "every room of one stay is on one rate" };
    plan = p;
    if (nights.length < minimumStay(setup, p, room.id, nights)) {
      return {
        ok: false,
        code: "too_short",
        reason: `${room.name} takes at least ${minimumStay(setup, p, room.id, nights)} nights then`,
      };
    }
    if (p.maxNights !== null && nights.length > p.maxNights) {
      return { ok: false, code: "too_short", reason: `${p.name} takes at most ${p.maxNights} nights` };
    }
    const priceNights = roomNights(setup, r, p, nights, req.systemSubtotals?.[i]);
    if (!priceNights) return { ok: false, code: "no_price", reason: `no price is set for ${room.name} on every night` };
    const subtotal = priceNights.reduce((a, n) => a + n.amount, 0);
    for (const n of priceNights) perNight.set(n.night, (perNight.get(n.night) ?? 0) + n.amount);
    const includes = property.pricesInclude
      ? ` (${c.includes(percent(property.pricesInclude.rateBp), property.pricesInclude.name)})`
      : "";
    lines.push({
      type: "subtotal",
      label: `${room.name}, ${c.nights(nights.length)}${includes}`,
      amount: subtotal,
      collected: "with_booking",
      nights: priceNights,
    });
    roomNames.push(room.name);
    roomSubtotal += subtotal;
    const guests = r.adults + r.childrenAges.length;
    guestsAll += guests;
    priced.push({ room, nights: priceNights, guests });
    // Extras: on-property items only, at the property's own prices.
    for (const want of r.extras) {
      const extra = setup.extras.find((e) => e.id === want.extraId && e.active);
      if (!extra) continue;
      const times =
        extra.basis === "per_stay" ? 1 : extra.basis === "per_night" ? nights.length : nights.length * guests;
      lines.push({
        type: "extra",
        label: want.quantity > 1 ? `${extra.name} × ${want.quantity}` : extra.name,
        amount: extra.price * times * want.quantity,
        collected: "with_booking",
      });
    }
  }
  if (!plan) return { ok: false, code: "no_room", reason: "a stay has at least one room" };
  // Every tax and fee is in the total, whoever collects it.
  for (const fee of setup.fees.filter((f) => f.active)) {
    const capped = fee.maxNights ? Math.min(nights.length, fee.maxNights) : nights.length;
    const exempt = (ages: readonly number[]) =>
      fee.childExemptUnder === null ? 0 : ages.filter((a) => a < (fee.childExemptUnder ?? 0)).length;
    let amount = 0;
    let detail = "";
    switch (fee.basis) {
      case "per_stay":
        amount = fee.amount ?? 0;
        break;
      case "per_night":
        amount = (fee.amount ?? 0) * capped;
        detail = `${formatMinor(money(fee.amount ?? 0), locale)} ${lodgingWord("fee_bases", "per_night", req.lang).toLowerCase()}`;
        break;
      case "per_room_night":
        amount = (fee.amount ?? 0) * capped * req.rooms.length;
        detail = `${formatMinor(money(fee.amount ?? 0), locale)} ${lodgingWord("fee_bases", "per_room_night", req.lang).toLowerCase()}`;
        break;
      case "per_person_night": {
        for (const [i, r] of req.rooms.entries()) {
          const persons = r.adults + r.childrenAges.length - exempt(r.childrenAges);
          const pr = priced[i];
          if (!pr) continue;
          for (const n of pr.nights.slice(0, capped)) {
            const perGuest = pr.guests > 0 ? Math.floor(n.amount / pr.guests) : n.amount;
            const tier = fee.tiers?.find((t) => t.upToNightly === null || perGuest <= t.upToNightly);
            const each = tier
              ? (tier.amount ?? (tier.rateBp !== undefined ? shareOf(perGuest, tier.rateBp) : 0))
              : (fee.amount ?? 0);
            amount += each * persons;
          }
        }
        if (!fee.tiers && fee.amount !== null) {
          detail = `${formatMinor(money(fee.amount), locale)} ${lodgingWord("fee_bases", "per_person_night", req.lang).toLowerCase()}`;
        }
        break;
      }
      case "percent_of_room":
        amount = shareOf(roomSubtotal, fee.rateBp ?? 0);
        detail = percent(fee.rateBp ?? 0);
        break;
    }
    if (amount === 0) continue;
    const label = `${fee.name}${detail ? (fee.basis === "percent_of_room" ? ` ${detail}` : `, ${detail}`) : ""}${
      fee.collected === "at_property" ? ` ${c.paidAtProperty}` : ""
    }`;
    lines.push({ type: fee.kind, label, amount, collected: fee.collected });
  }
  const total = lines.reduce((a, l) => a + l.amount, 0);
  const atProperty = lines.filter((l) => l.collected === "at_property").reduce((a, l) => a + l.amount, 0);
  const withBooking = total - atProperty;
  const times = stayTimes(property, req.checkIn, req.checkOut);
  const firstNight = nights[0] ? (perNight.get(nights[0]) ?? 0) : 0;
  const schedule = scheduleFor({
    plan,
    total,
    withBooking,
    firstNight,
    currency: cur,
    lang: req.lang,
    checkIn: req.checkIn,
    timezone: property.timezone,
    now: req.now,
  });
  const collected = collectable(schedule, plan.guarantee, req.collect, cur, req.lang);
  const policy = datePolicy(plan.policy, {
    start: { date: req.checkIn, time: property.checkInFrom },
    zone: property.timezone,
    total: money(total),
    units: nights.map((n) => perNight.get(n) ?? 0),
    bookedAt: req.now,
  });
  const hours = req.validHours ?? property.quoteValidHours;
  const cap = property.mode === "connected" ? Math.min(hours, 2) : hours;
  const validThrough = Math.min(req.now + cap * 3_600_000, times.startAt - 60_000);
  const meal = plan.meal;
  const includes = meal === "room_only" ? [] : [c.mealFor(lodgingWord("meals", meal, req.lang), guestsAll)];
  return {
    ok: true,
    roomNames,
    quote: {
      currency: cur,
      lines,
      total: money(total),
      ratePlan: { id: plan.id, name: plan.name, meal, refundable: refundable(plan.policy) },
      policy,
      schedule: collected.schedule,
      guarantee: collected.guarantee,
      includes,
      validThrough: isoIn(validThrough, property.timezone),
      source: req.source,
    },
  };
}

/**
 * The terms a person's own price goes on where the property has no plan for these rooms yet (a place
 * set up a moment ago): room only, free to cancel until 7 days before arrival, nothing paid now.
 */
export function standardPlan(propertyId: string): RatePlanRow {
  return {
    id: "standard",
    propertyId,
    name: "Standard",
    meal: "room_only",
    policyId: "",
    policy: stayPolicySteps({ preset: "free_until", days: 7, after: "first_night", noShow: "full" }),
    policyPreset: "free_until:7:first_night:full",
    deposit: { kind: "none" },
    balance: { when: "at_property" },
    guarantee: "none",
    roomTypeIds: null,
    derived: null,
    minNights: 1,
    maxNights: null,
    externalId: null,
    offered: true,
    active: true,
    sort: 10_000,
  };
}

/**
 * A stay priced at a person's own price for its room nights, where the rates do not cover it: shared
 * across the rooms and nights, then every tax and fee the property charges added as the rates' quote
 * would, on its plan for these rooms, else the standard terms. Never automation's: a price of its own
 * is the owner's to give.
 */
export function quoteFromPrice(setup: PropertySetup, req: PriceRequest, price: Money): PriceResult {
  if (price.currency !== setup.property.currency) {
    return {
      ok: false,
      code: "no_price",
      reason: `the price is in ${price.currency}, the property's in ${setup.property.currency}`,
    };
  }
  if (!Number.isInteger(price.value) || price.value <= 0) {
    return { ok: false, code: "no_price", reason: "a price above nothing" };
  }
  const nights = nightsOf(req.checkIn, req.checkOut);
  if (nights.length === 0 || req.rooms.length === 0)
    return { ok: false, code: "no_room", reason: "no nights to price" };
  const perRoom = Math.floor(price.value / req.rooms.length);
  const subtotals = req.rooms.map((_, i) => {
    const room = perRoom + (i === 0 ? price.value - perRoom * req.rooms.length : 0);
    const each = Math.floor(room / nights.length);
    return {
      nights: nights.map((night, j) => ({ night, amount: each + (j === 0 ? room - each * nights.length : 0) })),
    };
  });
  const planned = req.rooms.every((r) => planFor(setup, r.roomTypeId, r.ratePlanId));
  const priced = planned ? setup : { ...setup, plans: [...setup.plans, standardPlan(setup.property.id)] };
  return quoteFromRates(priced, { ...req, systemSubtotals: subtotals, source: "person" });
}

/**
 * The locale a guest's money and dates are written in: their language as it is written in the country
 * the property is in (`es` in Mexico is es-MX), else the bare language — never one region's by default.
 */
export function localeOf(lang: StayLang, country?: string | null): string {
  return localeFor(lang, country);
}

/** The locale for a guest of this property: their language, the property's country (from its zone). */
export function propertyLocale(lang: StayLang, property: { readonly timezone: string } | null | undefined): string {
  return localeFor(lang, property ? countryOfZone(property.timezone) : null);
}

/**
 * A schedule as the property can collect it: with no payment platform to take money before arrival,
 * everything is paid at the property; with none to save a card, no card is asked for.
 */
function collectable(
  schedule: StayScheduleEntry[],
  guarantee: StayQuote["guarantee"],
  collect: PriceRequest["collect"],
  currency: string,
  lang: StayLang,
): { schedule: StayScheduleEntry[]; guarantee: StayQuote["guarantee"] } {
  if (!collect) return { schedule, guarantee };
  const card = guarantee === "card" && !collect.cards ? "none" : guarantee;
  if (collect.links || schedule.every((s) => s.type === "at_property")) return { schedule, guarantee: card };
  const total = schedule.reduce((a, s) => a + s.amount.value, 0);
  return {
    schedule: [
      {
        id: "at_property",
        type: "at_property",
        amount: { value: total, currency },
        label: stayCopy(lang).schedule.atProperty,
      },
    ],
    guarantee: card,
  };
}

/** A quote as the property can collect it now (a person's own, say): everything at the property without a payment platform. */
export function collectableQuote(
  quote: StayQuote,
  collect: { readonly links: boolean; readonly cards: boolean },
  lang: StayLang,
): StayQuote {
  const schedule = quote.schedule as StayScheduleEntry[];
  const c = collectable(schedule, quote.guarantee, collect, quote.currency, lang);
  if (c.guarantee === quote.guarantee && c.schedule === schedule) return quote;
  return { ...quote, schedule: c.schedule, guarantee: c.guarantee };
}

/**
 * When a stay is paid, from its rate plan: a deposit now (the first night, a share, or all that is paid
 * with the booking), the balance by a date before arrival or at the property, and everything collected
 * at the property at the property. The entries add up to the total; one that comes to nothing is left
 * out, and a balance whose date has already passed is paid now with the deposit.
 */
export function scheduleFor(o: {
  readonly plan: Pick<RatePlanRow, "deposit" | "balance">;
  readonly total: number;
  readonly withBooking: number;
  readonly firstNight: number;
  readonly currency: string;
  readonly lang: StayLang;
  readonly checkIn: string;
  readonly timezone: string;
  readonly now: number;
}): StayScheduleEntry[] {
  const c = stayCopy(o.lang);
  const money = (value: number) => ({ value, currency: o.currency });
  const d = o.plan.deposit;
  let deposit =
    d.kind === "none"
      ? 0
      : d.kind === "first_night"
        ? o.firstNight
        : d.kind === "percent"
          ? shareOf(o.withBooking, Math.max(0, Math.min(100, d.value ?? 0)) * 100)
          : o.withBooking;
  deposit = Math.max(0, Math.min(deposit, o.withBooking));
  let rest = o.withBooking - deposit;
  const out: StayScheduleEntry[] = [];
  let balanceAt: number | null = null;
  if (o.plan.balance.when === "days_before" && rest > 0) {
    balanceAt = instantOf(addDays(o.checkIn, -Math.max(0, o.plan.balance.days ?? 7)), "10:00", o.timezone);
    // Its date has passed already: it is paid now, with the deposit.
    if (balanceAt <= o.now) {
      deposit += rest;
      rest = 0;
      balanceAt = null;
    }
  }
  if (deposit > 0) out.push({ id: "deposit", type: "immediate", amount: money(deposit), label: c.schedule.deposit });
  if (balanceAt !== null && rest > 0) {
    out.push({
      id: "balance",
      type: "deferred",
      amount: money(rest),
      dueAt: isoIn(balanceAt, o.timezone),
      label: c.schedule.balance,
    });
    rest = 0;
  }
  const there = o.total - o.withBooking + rest;
  if (there > 0 || out.length === 0) {
    out.push({ id: "at_property", type: "at_property", amount: money(there), label: c.schedule.atProperty });
  }
  return out;
}
