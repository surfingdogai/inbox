import type { Statement } from "@surfingdog/platform";
import type { StayQuote } from "@surfingdog/spec";
import { hasLivePayLink, hasPayLinks, payLinkStatement } from "../connectors/pay-queue";
import { audienceFor } from "../customer/audience";
import type { Audience } from "../customer/describe";
import type { Db } from "../db";
import type { Item, Money, PayloadOf } from "../domain/types";
import type { Transition } from "../machine/machine";
import { feeAt } from "../policy/index";
import { ariCovers } from "../property/ari";
import type { Settings } from "../settings/schema";
import { addDays, dateIn, instantOf, isoIn } from "../util/zoned";
import { type Caller, isCustomer, isPerson } from "../write/caller";
import { hasEventListeners, jobStatement } from "../write/common";
import { WriteError } from "../write/errors";
import { isAutomation, sideOf } from "../write/offers";
import { refundStatements } from "../write/returns";
import {
  closedNights,
  insideAllotment,
  nightsFree,
  planNightClaims,
  promoteStatement,
  releaseAfterStatement,
  releaseStatement,
  type WantedNights,
  wantedRooms,
} from "./claims";
import { type StayLang, stayLang } from "./copy";
import { checkDates, nightsOf, stayTimes } from "./nights";
import { quoteFromRates } from "./price";
import { stayProblems } from "./problems";
import { type PropertySetup, readSetup } from "./store";
import { cancellationTerms, dueNow, feeSha, quoteProblems, stayTermsSha } from "./terms";

/**
 * The stays layer of the write algorithm (ADR-033 §3): the machine says which transition a stay may
 * take; this checks its stay guards and writes its stay effects in the same batch as the item — night
 * claims, the quote, the payment schedule, the jobs that write to the property's own system and send
 * the guest's messages. It reads everything first and throws before anything is written.
 */

type StayPayload = PayloadOf<"stay">;
type StayItem = Item & { readonly type: "stay"; readonly payload: StayPayload };
type Mut = Record<string, unknown>;

export const STAY_WRITE_KIND = "stay_write";
export const STAY_MESSAGE_KIND = "stay_message";
export const STAY_SWEEP_KIND = "stay_sweep";
/** Nights stay held while a write to the property's system is in flight: the write settles them, never a clock. */
export const WRITE_HOLD_MS = 24 * 3_600_000;
/** A payment landing at the window's last minute still finds its nights. */
export const PAY_GRACE_MS = 10 * 60_000;
/** An instant stay's pay window: the room is blocked in the property's system meanwhile. */
const INSTANT_PAY_HOURS = 1;
/** How long after check-out a stay's outcome can still be corrected. */
export const STAY_CORRECTION_MS = 7 * 86_400_000;

export interface StayWriteJob {
  readonly itemId: string;
  readonly op: "reserve" | "modify" | "cancel";
  readonly status: "hold" | "provisional" | "confirmed";
  readonly eventId: string;
}

export interface StayMessageJob {
  readonly itemId: string;
  readonly kind: "before" | "arrival" | "thanks" | "reminder";
  /** The stay's check-in when it was queued: a stay moved since gets the message queued for its new dates. */
  readonly checkIn: string;
}

/** Whether a property writes stays to its own system before anything is promised. */
export function writesFirst(setup: PropertySetup): boolean {
  return setup.property.mode === "connected" && setup.property.connectorId !== null;
}

/** The nights a stay takes, room type by room type. */
export function wantOf(p: Pick<StayPayload, "rooms" | "checkIn" | "checkOut">): WantedNights {
  return { rooms: wantedRooms(p.rooms), nights: nightsOf(p.checkIn, p.checkOut) };
}

/** What has been paid on a stay, in its quote's currency. */
export function paidOf(p: Pick<StayPayload, "payments" | "quote">): Money {
  const currency = p.quote?.currency ?? p.payments?.schedules[0]?.amount.currency ?? "XXX";
  let value = 0;
  for (const s of p.payments?.schedules ?? []) {
    if (s.status !== "paid" && s.status !== "refund_owed") continue;
    const amount = s.paidAmount ?? s.amount;
    if (amount.currency === currency) value += amount.value;
  }
  return { value, currency };
}

/** Whether something is still to be paid now: a deposit not paid, a card to hold it not saved. */
export function stillDueNow(p: Pick<StayPayload, "payments">): boolean {
  const pay = p.payments;
  if (!pay) return false;
  if (pay.guarantee.status === "requested") return true;
  return pay.schedules.some((s) => s.type === "immediate" && s.status === "due");
}

/**
 * The event a stay takes for what was asked (ADR-033 D2): an acceptance or a booking leads to the
 * property's own system first when it has one, else to the deposit when one is due now, else straight
 * to confirmed; a payment confirms when it is the last one due now, and lands on a lapsed stay as a
 * late payment.
 */
export async function stayEventFor(db: Db, item: Item, event: string, input: unknown): Promise<string> {
  if (item.type !== "stay") return event;
  const p = item.payload as StayPayload;
  switch (event) {
    case "accept":
    case "record_accept": {
      if (item.state !== "quoted" || !p.quote) return event;
      const setup = await readSetup(db, p.propertyId);
      if (setup && writesFirst(setup)) return `${event}_write`;
      return dueNow(p.quote) ? `${event}_pay` : event;
    }
    case "book": {
      if (item.state !== "held" || !p.quote) return event;
      if (p.hold?.source === "connected") return "book_write";
      return dueNow(p.quote) ? "book_pay" : "book";
    }
    case "written":
      return item.state === "booking" && p.quote && dueNow(p.quote) ? "written_pay" : "written";
    case "record_payment": {
      if (item.state === "expired") return "late_payment";
      if (item.state !== "awaiting_payment") return event;
      const next = structuredClone(p) as StayPayload;
      applyPayment(next as unknown as Mut, (input ?? {}) as Mut);
      return stillDueNow(next) ? "record_part_payment" : "record_payment";
    }
    default:
      return event;
  }
}

/** The schedule a stay pays on once it is agreed: its quote's, each entry due, at the property, or paid. */
export function paymentsFrom(quote: StayQuote, dueBy: number | null): NonNullable<StayPayload["payments"]> {
  return {
    schedules: quote.schedule.map((s) => ({
      id: s.id,
      type: s.type,
      amount: s.amount,
      ...(s.type === "immediate" && dueBy !== null
        ? { dueAt: new Date(dueBy).toISOString() }
        : s.dueAt
          ? { dueAt: s.dueAt }
          : {}),
      status: s.type === "at_property" ? ("at_property" as const) : ("due" as const),
    })),
    ...(dueBy !== null ? { dueBy: new Date(dueBy).toISOString() } : {}),
    guarantee: { status: quote.guarantee === "card" ? ("requested" as const) : ("none" as const) },
  };
}

/**
 * A payment recorded on a stay's schedule: on the entry it names, else the first one due now, else the
 * first one due, else what is paid at the property. A card saved to hold the stay is `guarantee`.
 */
export function applyPayment(payload: Mut, data: Mut): void {
  const pay = payload.payments as StayPayload["payments"] | undefined;
  if (!pay) return;
  const named = typeof data.scheduleId === "string" ? data.scheduleId : undefined;
  if (named === "guarantee") {
    (pay.guarantee as { status: string }).status = "saved";
    return;
  }
  const entries = pay.schedules;
  const entry =
    (named ? entries.find((s) => s.id === named) : undefined) ??
    entries.find((s) => s.type === "immediate" && s.status === "due") ??
    entries.find((s) => s.status === "due") ??
    entries.find((s) => s.status === "at_property");
  if (!entry) return;
  const amount = data.amount as Money | undefined;
  const before = entry.paidAmount?.currency === entry.amount.currency ? entry.paidAmount.value : 0;
  const now = amount && amount.currency === entry.amount.currency ? before + amount.value : entry.amount.value;
  entry.paidAmount = { value: now, currency: entry.amount.currency };
  if (typeof data.paymentRef === "string") entry.paymentRef = data.paymentRef;
  if (now >= entry.amount.value) entry.status = "paid";
}

interface PlanCtx {
  readonly db: Db;
  readonly caller: Caller;
  readonly item: Item;
  readonly t: Transition;
  /** The payload as it will be written: this mutates it. */
  readonly payload: Mut;
  readonly data: Mut;
  readonly settings: Settings;
  readonly now: number;
  readonly audience: Audience | undefined;
}

export interface StayPlan {
  /** What goes in the transition's batch, after the item's own row. */
  statements(eventId: string): Promise<Statement[]>;
  /** Whether the batch claims nights: a failed batch is judged against them. */
  readonly claims: boolean;
  /** The linked item the transition made (a refund owed), for the answer. */
  readonly linkedId?: string | undefined;
}

/** A refusal in the guest's words for a customer, else in the owner's. */
function refuse(
  ctx: PlanCtx,
  code: ConstructorParameters<typeof WriteError>[0],
  owner: string,
  guest: (p: ReturnType<typeof stayProblems>) => string,
  details: Record<string, unknown>,
): never {
  throw new WriteError(code, ctx.audience ? guest(stayProblems(ctx.audience.lang)) : owner, { details });
}

/** Runs a stay transition's guards and plans its effects. Throws before anything is written. */
export async function planStay(ctx: PlanCtx): Promise<StayPlan> {
  const { db, caller, item, t, payload, data, settings, now } = ctx;
  const before = item.payload as StayPayload;
  const p = payload as unknown as StayPayload & Mut;
  const found = await readSetup(db, p.propertyId);
  if (!found) {
    throw new WriteError("guard_failed", "This place to stay is not set up any more.", {
      details: { guard: "property", propertyId: p.propertyId },
    });
  }
  const setup = found;
  const zone = setup.property.timezone;
  const lang: StayLang = stayLang((ctx.audience ?? (await audienceFor(db, { partyId: item.partyId, settings }))).lang);
  const effects = new Set<string>(t.effects ?? []);
  const guards = new Set<string>(t.guards ?? []);
  const _side = sideOf(caller);

  // What the input changes before anything is judged: the guest's other dates, the property's quote,
  // a payment, a change asked for.
  if (effects.has("stay_counter")) applyCounter(setup, p, data);
  if (t.event === "request_info") {
    delete p.quote;
    delete p.totalPrice;
    delete p.hold;
  }
  if (t.event === "quote") await composeQuote(ctx, setup, p, lang);
  // An agent's hold makes the inbox's own offer binding, for as long as the hold lasts: the price the
  // inbox worked out from the property's rates or its system when the stay was made, never the agent's.
  if (t.event === "hold") {
    const offered = before.estimate;
    if (!offered) {
      throw new WriteError("guard_failed", "there is no offer on this stay to hold", {
        details: { guard: "instant_safe" },
      });
    }
    const terms = offered;
    p.quote = {
      ...terms,
      validThrough: isoIn(now + setup.property.holdMinutes * 60_000, zone),
      source: setup.property.mode === "connected" ? "connected" : "allotment",
    };
    p.totalPrice = terms.total;
  }
  if (
    t.event === "record_payment" ||
    t.event === "record_part_payment" ||
    t.event === "late_payment" ||
    t.event === "payment_failed"
  ) {
    if (t.event !== "payment_failed") applyPayment(p, data);
  }
  if (t.event === "propose_change") planChange(ctx, setup, p, lang);
  if (t.event === "written" || t.event === "written_pay") {
    p.external = {
      connectorId: String(data.connectorId),
      externalId: String(data.externalId),
      ...(typeof data.status === "string" ? { status: data.status } : {}),
    };
  }
  if (t.event === "check_in") p.checkedInAt = new Date(now).toISOString();
  if (t.event === "check_out") p.checkedOutAt = new Date(now).toISOString();
  if (t.event === "waive_payment" && p.payments) {
    for (const s of p.payments.schedules) if (s.type === "immediate" && s.status === "due") s.status = "at_property";
    if (p.payments.guarantee.status === "requested") p.payments.guarantee.status = "none";
    delete p.payments.dueBy;
  }

  // ---- guards ------------------------------------------------------------
  let cancelTerms: { fee: Money; refund: Money } | undefined;
  for (const guard of guards) {
    switch (guard) {
      case "customer_owns_item":
        break; // asserted for every customer write
      case "stay_quote_complete":
        break; // composeQuote checked it
      case "capacity_ok":
        checkCapacity(ctx, setup, p);
        break;
      case "registration_ok": {
        const reg = setup.property.registration;
        if (reg?.required && !reg.number) {
          refuse(
            ctx,
            "guard_failed",
            "Your area requires a short-term rental registration number. Add it in Settings → Property first.",
            (w) => w.closed,
            { guard },
          );
        }
        if (reg?.number) p.registration = reg.number;
        break;
      }
      case "not_past":
        checkNotPast(ctx, setup, p);
        break;
      case "nights_open": {
        for (const [roomTypeId] of wantOf(p).rooms) {
          const closed = closedNights(setup, roomTypeId, wantOf(p).nights);
          if (closed.length > 0) {
            refuse(ctx, "guard_failed", `You closed ${closed.join(", ")} for this room.`, (w) => w.closed, {
              guard,
              nights: closed,
            });
          }
        }
        await mustBeFree(ctx, setup, wantOf(p), guard);
        break;
      }
      case "nights_available":
        await mustBeFree(ctx, setup, wantOf(p), guard);
        break;
      case "instant_safe": {
        const want = wantOf(p);
        const safe =
          setup.property.mode === "allotment"
            ? await insideAllotment(db, setup, item.id, want, now)
            : setup.property.mode === "connected" && setup.property.instant
              ? await ariCovers(db, setup, want, now)
              : false;
        if (!safe) {
          refuse(
            ctx,
            "guard_failed",
            `On request. ${setup.property.name} answers within ${setup.property.answerHours} hours.`,
            (w) => w.onRequest(setup.property.answerHours),
            { guard, on_request: true },
          );
        }
        break;
      }
      case "stay_quote_open": {
        const q = before.quote;
        if (!q) refuse(ctx, "no_offer", "There is no quote on this stay to accept.", (w) => w.noQuote, { guard });
        if (Date.parse(q.validThrough) <= now) {
          refuse(
            ctx,
            "offer_expired",
            `The quote could be accepted until ${q.validThrough}.`,
            (w) => w.quoteLapsed(q.validThrough.slice(0, 16).replace("T", " ")),
            { guard, validThrough: q.validThrough },
          );
        }
        break;
      }
      case "hold_open":
        if (!before.hold || Date.parse(before.hold.until) <= now) {
          refuse(ctx, "offer_expired", "The hold on these nights has ended.", (w) => w.holdLapsed, {
            guard,
            ...(before.hold ? { until: before.hold.until } : {}),
          });
        }
        break;
      case "terms_confirmed":
        if (isCustomer(caller) && before.quote) await mustConfirm(ctx, before, before.quote);
        break;
      case "nothing_due_now":
      case "payment_due_now": {
        const q = p.quote;
        const due = q ? dueNow(q) : false;
        if ((guard === "nothing_due_now") === due) {
          throw new WriteError("guard_failed", due ? "something is due now on this stay" : "nothing is due now", {
            details: { guard },
          });
        }
        break;
      }
      case "payment_complete":
        if (stillDueNow(p)) {
          throw new WriteError("guard_failed", "more is still due now on this stay", { details: { guard } });
        }
        break;
      case "late_payment_open":
        if (!before.payments || before.cancellation) {
          throw new WriteError("guard_failed", "this stay was not waiting for a payment", { details: { guard } });
        }
        break;
      case "stay_quote_lapsed":
        if (!before.quote || Date.parse(before.quote.validThrough) > now) {
          throw new WriteError("guard_failed", "the quote has not lapsed yet", { details: { guard } });
        }
        break;
      case "stay_request_lapsed":
        if (Date.parse(item.updatedAt) + settings.stays.requestExpiresHours * 3_600_000 > now) {
          throw new WriteError("guard_failed", "the request has not lapsed yet", { details: { guard } });
        }
        break;
      case "hold_lapsed":
        if (!before.hold || Date.parse(before.hold.until) > now) {
          throw new WriteError("guard_failed", "the hold has not lapsed yet", { details: { guard } });
        }
        break;
      case "payment_lapsed": {
        const by = before.payments?.dueBy;
        if (!by || Date.parse(by) > now) {
          throw new WriteError("guard_failed", "the time to pay has not passed yet", { details: { guard } });
        }
        break;
      }
      case "fee_confirmed": {
        const q = before.quote;
        if (!q) break;
        cancelTerms = cancellationTerms(q, paidOf(before), now);
        const sha = await feeSha(item.id, cancelTerms);
        if (data.fee_sha !== sha) {
          throw new WriteError(
            "confirm_terms",
            ctx.audience ? stayProblems(ctx.audience.lang).confirmFee : "confirm the cancellation fee first",
            { details: { guard, fee_sha: sha, fee: cancelTerms.fee, refund: cancelTerms.refund } },
          );
        }
        break;
      }
      case "fee_lowered_by_person": {
        const q = before.quote;
        if (!q) break;
        cancelTerms = recordedCancellation(ctx, before, q);
        break;
      }
      case "stay_ahead": {
        const { startAt } = stayTimes(setup.property, before.checkIn, before.checkOut);
        if (startAt <= now) {
          refuse(ctx, "guard_failed", "The stay has started, so it can no longer change.", (w) => w.started, {
            guard,
          });
        }
        break;
      }
      case "change_nights_open": {
        const c = (t.event === "accept_change" ? before.change : p.change) as StayPayload["change"];
        if (!c) break;
        const want = wantOf({ rooms: c.rooms ?? before.rooms, checkIn: c.checkIn, checkOut: c.checkOut });
        for (const [roomTypeId] of want.rooms) {
          if (closedNights(setup, roomTypeId, want.nights).length > 0) {
            refuse(ctx, "guard_failed", "Some of the new nights are closed.", (w) => w.closed, { guard });
          }
        }
        await mustBeFree(ctx, setup, want, guard);
        break;
      }
      case "stay_change_open":
      case "stay_change_theirs":
      case "stay_change_mine":
      case "stay_change_lapsed":
        await checkChange(ctx, before, guard);
        break;
      case "checkin_day_reached":
        if (dateIn(now, zone) < before.checkIn) {
          throw new WriteError("guard_failed", `check-in is on ${before.checkIn}`, { details: { guard } });
        }
        break;
      case "stay_ended": {
        const { endAt } = stayTimes(setup.property, before.checkIn, before.checkOut);
        if (endAt + settings.stays.autoCompleteHours * 3_600_000 > now) {
          throw new WriteError("guard_failed", "the stay has not ended yet", { details: { guard } });
        }
        break;
      }
      case "arrival_passed":
        if (instantOf(before.checkIn, "23:59:59", zone) > now) {
          throw new WriteError(
            "guard_failed",
            `a no-show can be marked once the check-in day (${before.checkIn}) has ended`,
            { details: { guard } },
          );
        }
        break;
      case "stay_correction_window": {
        const { endAt } = stayTimes(setup.property, before.checkIn, before.checkOut);
        if (now > endAt + STAY_CORRECTION_MS) {
          throw new WriteError("guard_failed", "a stay's outcome can be corrected until 7 days after check-out", {
            details: { guard },
          });
        }
        break;
      }
    }
  }

  // ---- effects on the payload ---------------------------------------------
  let refundOwedMoney: Money | null = null;
  if (effects.has("apply_stay_change") && before.change) {
    const c = before.change;
    p.checkIn = c.checkIn;
    p.checkOut = c.checkOut;
    if (c.rooms) p.rooms = c.rooms;
    if (c.quote) {
      p.quote = c.quote;
      p.totalPrice = c.quote.total;
      // The payments made stay paid; what the new terms add is a difference to pay, and what they take
      // away from what was paid already is owed back, for the property to refund.
      const paid = paidOf(before);
      const withBooking = c.quote.schedule
        .filter((x) => x.type !== "at_property")
        .reduce((a, x) => a + x.amount.value, 0);
      if (paid.currency === c.quote.currency && paid.value > withBooking) {
        refundOwedMoney = { value: paid.value - withBooking, currency: paid.currency };
      }
      p.payments = mergeChangedSchedule(p.payments, c.quote);
    }
    Object.assign(p, timesOf(setup, p.checkIn, p.checkOut));
    delete p.change;
  }
  if (effects.has("drop_change")) delete p.change;
  if (effects.has("cancellation_fee") && before.quote) {
    const terms = cancelTerms ?? cancellationTerms(before.quote, paidOf(before), now);
    p.cancellation = { at: new Date(now).toISOString(), fee: terms.fee, by: "guest" };
  }
  if (effects.has("refund_owed")) {
    const paid = paidOf(before);
    const fee = (p.cancellation as StayPayload["cancellation"] | undefined)?.fee ?? {
      value: 0,
      currency: paid.currency,
    };
    const owed = Math.max(0, paid.value - (fee.currency === paid.currency ? fee.value : 0));
    const by = t.event === "cancel_by_property" ? "property" : "guest";
    p.cancellation = {
      at: new Date(now).toISOString(),
      fee: by === "property" ? { value: 0, currency: paid.currency } : fee,
      ...(owed > 0 ? { refundOwed: { value: owed, currency: paid.currency } } : {}),
      by,
    };
    if (owed > 0) refundOwedMoney = { value: owed, currency: paid.currency };
  }
  if (effects.has("release_nights") || effects.has("promote_claims")) delete p.hold;
  if (t.event === "hold") {
    p.hold = {
      until: new Date(now + setup.property.holdMinutes * 60_000).toISOString(),
      source: setup.property.mode === "connected" ? "connected" : "allotment",
    };
  }

  // The pay window opens as the stay is agreed with something due now.
  const payWindowOpens = effects.has("queue_pay_links") && !before.payments && p.quote;
  let dueBy: number | null = null;
  if (payWindowOpens && p.quote) {
    const hours =
      setup.property.mode === "request"
        ? setup.property.payWithinHours
        : Math.min(INSTANT_PAY_HOURS, setup.property.payWithinHours);
    const { startAt } = stayTimes(setup.property, p.checkIn, p.checkOut);
    dueBy = dueNow(p.quote) ? Math.min(now + hours * 3_600_000, startAt) : null;
    p.payments = paymentsFrom(p.quote, dueBy);
  }
  // A stay agreed with nothing due now still gets its schedule, for what is paid later.
  if (
    !p.payments &&
    p.quote &&
    (effects.has("claim_nights") || effects.has("promote_claims") || effects.has("write_stay"))
  ) {
    p.payments = paymentsFrom(p.quote, null);
  }

  // ---- what goes in the batch ---------------------------------------------
  const claimsWanted =
    effects.has("claim_nights") ||
    effects.has("claim_nights:hold") ||
    effects.has("reclaim_nights") ||
    (effects.has("hold_nights") && setup.property.mode !== "request");
  const holdUntil = (): number | null => {
    if (effects.has("claim_nights") || effects.has("reclaim_nights")) return null;
    if (effects.has("hold_nights") && p.quote) return Date.parse(p.quote.validThrough);
    if (t.event === "hold") return now + setup.property.holdMinutes * 60_000;
    if (effects.has("write_stay")) return now + WRITE_HOLD_MS;
    if (p.payments?.dueBy) return Date.parse(p.payments.dueBy) + PAY_GRACE_MS;
    return now + setup.property.payWithinHours * 3_600_000 + PAY_GRACE_MS;
  };
  const claim = claimsWanted ? await planNightClaims(db, setup, item.id, wantOf(p), holdUntil(), now) : null;
  if (claim && !claim.ok) {
    refuse(ctx, "slot_taken", `${claim.night} is taken for this room by another stay.`, (w) => w.nightsTaken, {
      guard: "nights_available",
      night: claim.night,
      roomTypeId: claim.roomTypeId,
    });
  }

  const plan: { claims: boolean; linkedId?: string; statements(eventId: string): Promise<Statement[]> } = {
    claims: claim !== null,
    async statements(eventId: string): Promise<Statement[]> {
      const out: Statement[] = [];
      if (effects.has("release_nights")) {
        out.push(t.event === "no_show" ? releaseAfterStatement(item.id, before.checkIn) : releaseStatement(item.id));
      }
      if (effects.has("hold_nights") && setup.property.mode === "request") out.push(releaseStatement(item.id));
      if (claim?.ok) out.push(...claim.statements);
      if (effects.has("promote_claims")) out.push(promoteStatement(item.id));
      if (effects.has("schedule_messages")) out.push(...messageStatements(item.id, setup, p, settings, now));
      if (payWindowOpens && dueBy !== null) {
        // A reminder at half the window, while it is still to be paid.
        out.push(
          jobStatement(
            STAY_MESSAGE_KIND,
            { itemId: item.id, kind: "reminder", checkIn: p.checkIn } satisfies StayMessageJob,
            now,
            { runAt: now + Math.floor((dueBy - now) / 2), dedupeKey: `stay_message:${item.id}:reminder:${dueBy}` },
          ),
        );
      }
      if (
        (effects.has("queue_pay_links") || effects.has("close_pay_links")) &&
        ((await hasPayLinks(db)) || (await hasLivePayLink(db, item.id)))
      ) {
        out.push(payLinkStatement(item.id, eventId, now));
      }
      if (effects.has("write_stay") && writesFirst(setup)) {
        const op: StayWriteJob["op"] = t.event === "accept_change" ? "modify" : "reserve";
        if (op === "reserve" || before.external) {
          out.push(
            jobStatement(
              STAY_WRITE_KIND,
              {
                itemId: item.id,
                op,
                status: p.quote && dueNow(p.quote) && op === "reserve" ? "provisional" : "confirmed",
                eventId,
              } satisfies StayWriteJob,
              now,
              { dedupeKey: `stay_write:${eventId}` },
            ),
          );
        }
      }
      if (
        effects.has("cancel_stay_write") &&
        (before.external || item.state === "booking" || before.hold?.source === "connected")
      ) {
        out.push(
          jobStatement(
            STAY_WRITE_KIND,
            { itemId: item.id, op: "cancel", status: "confirmed", eventId } satisfies StayWriteJob,
            now,
            { dedupeKey: `stay_write:${eventId}` },
          ),
        );
      }
      if (refundOwedMoney) {
        const refundDue = now + settings.returns.refundDays * 86_400_000;
        const made = refundStatements({
          caller,
          item,
          plan: {
            kind: "cancellation",
            state: "approved",
            acknowledge: false,
            payload: {
              orderItemId: item.id,
              amount: refundOwedMoney,
              kind: "cancellation",
              noticeAt: new Date(now).toISOString(),
              goodsBack: false,
              refundDue: new Date(refundDue).toISOString(),
            },
          },
          causationId: eventId,
          now,
          webhooks: await hasEventListeners(db),
        });
        plan.linkedId = made.id;
        out.push(...made.statements);
      }
      return out;
    },
  };
  return plan;
}

/** The guest's other dates or rooms: the request goes back to the property to quote. */
function applyCounter(setup: PropertySetup, p: StayPayload & Mut, data: Mut): void {
  const checkIn = typeof data.checkIn === "string" ? data.checkIn : p.checkIn;
  const checkOut = typeof data.checkOut === "string" ? data.checkOut : p.checkOut;
  checkDates(setup.property, checkIn, checkOut, "input");
  p.checkIn = checkIn;
  p.checkOut = checkOut;
  if (Array.isArray(data.rooms)) p.rooms = data.rooms as StayPayload["rooms"];
  Object.assign(p, timesOf(setup, checkIn, checkOut));
  delete p.quote;
  delete p.totalPrice;
  delete p.hold;
}

/** The times a stay is written with: its check-in and check-out in the property's zone. */
export function timesOf(
  setup: PropertySetup,
  checkIn: string,
  checkOut: string,
): { startTime: string; endTime: string } {
  const { startTime, endTime } = stayTimes(setup.property, checkIn, checkOut);
  return { startTime, endTime };
}

/**
 * The property's quote for this stay: the whole quote a person wrote, or one from its rates. Automation
 * quotes only from the rates: a quote with prices of its own is the owner's to send (ADR-018 §4).
 */
async function composeQuote(ctx: PlanCtx, setup: PropertySetup, p: StayPayload & Mut, lang: StayLang): Promise<void> {
  const { caller, data, now } = ctx;
  if (data.quote !== undefined && isAutomation(caller)) {
    throw new WriteError(
      "not_allowed",
      'A quote with prices of its own is the owner\'s to send. Quote from the rates (from: "rates"), or tell the owner in a note (reply with internal: true) what you would quote.',
      { details: { reason: "owner_money", draft_for_owner: true } },
    );
  }
  for (const r of (data.rooms ?? []) as { index: number; roomTypeId: string; ratePlanId?: string }[]) {
    const room = p.rooms[r.index];
    const type = setup.rooms.find((x) => x.id === r.roomTypeId && x.active);
    if (!room || !type) {
      throw new WriteError("invalid_input", `input.rooms: no room ${r.index} of type ${r.roomTypeId}`, {
        fields: [{ path: "input.rooms", problem: "invalid", message: "a room of this stay and a room type you have" }],
      });
    }
    room.roomTypeId = type.id;
    room.roomTypeName = type.name;
    if (r.ratePlanId) room.ratePlanId = r.ratePlanId;
  }
  const missing = p.rooms.findIndex((r) => !r.roomTypeId);
  if (missing !== -1) {
    throw new WriteError("invalid_input", "Say which room type each room is (input.rooms).", {
      fields: [{ path: `input.rooms`, problem: "missing", message: `room ${missing} has no room type` }],
      details: { guard: "stay_quote_complete" },
    });
  }
  let quote: StayQuote;
  if (data.quote !== undefined) {
    quote = { ...(data.quote as StayQuote), source: "person" };
  } else {
    const source =
      setup.property.mode === "allotment" ? "allotment" : setup.property.mode === "connected" ? "connected" : "rates";
    const priced = quoteFromRates(setup, {
      checkIn: p.checkIn,
      checkOut: p.checkOut,
      rooms: p.rooms.map((r) => ({
        roomTypeId: r.roomTypeId as string,
        ratePlanId: r.ratePlanId,
        adults: r.adults,
        childrenAges: r.childrenAges,
        extras: r.extras,
      })),
      lang,
      now,
      validHours: typeof data.validHours === "number" ? data.validHours : undefined,
      source,
    });
    if (!priced.ok) {
      throw new WriteError("guard_failed", `Your rates cannot price this stay: ${priced.reason}`, {
        details: { guard: "stay_quote_complete", reason: priced.code },
      });
    }
    quote = priced.quote;
  }
  if (typeof data.note === "string" && data.note.trim() && !quote.notes) quote = { ...quote, notes: data.note.trim() };
  const problems = quoteProblems(setup, p, quote, now);
  if (problems.length > 0) {
    throw new WriteError("invalid_input", `The quote does not hold together: ${problems.join("; ")}.`, {
      fields: problems.map((m) => ({ path: "input.quote", problem: "invalid" as const, message: m })),
      details: { guard: "stay_quote_complete" },
    });
  }
  for (const room of p.rooms) {
    const plan =
      setup.plans.find((x) => x.id === room.ratePlanId) ?? setup.plans.find((x) => x.id === quote.ratePlan.id);
    if (plan) {
      room.ratePlanId = plan.id;
      room.ratePlanName = plan.name;
    }
  }
  p.quote = quote;
  p.totalPrice = quote.total;
  p.availability = {
    source:
      setup.property.mode === "allotment" ? "allotment" : setup.property.mode === "connected" ? "connected" : "owner",
    checkedAt: new Date(now).toISOString(),
  };
}

/** Every room sleeps its guests: adults, children, and children at all where they are welcome. */
function checkCapacity(ctx: PlanCtx, setup: PropertySetup, p: StayPayload): void {
  for (const room of p.rooms) {
    if (!room.roomTypeId) continue;
    const type = setup.rooms.find((r) => r.id === room.roomTypeId && r.active);
    const name = type?.name ?? room.roomTypeName ?? "This room";
    const children = room.childrenAges.length;
    const fits =
      type !== undefined &&
      room.adults <= type.capacity.adults &&
      children <= type.capacity.children &&
      room.adults + children <= type.capacity.total &&
      (children === 0 || setup.property.children.welcome) &&
      room.childrenAges.every(
        (a) => setup.property.children.fromAge === undefined || a >= setup.property.children.fromAge,
      );
    if (!fits) {
      refuse(
        ctx,
        "guard_failed",
        `${name} does not sleep ${room.adults} adults and ${children} children.`,
        (w) => w.tooMany(name),
        {
          guard: "capacity_ok",
          roomTypeId: room.roomTypeId,
        },
      );
    }
  }
}

/** Arrival has not passed; arriving today only until the property's same-day time, or a person quotes it. */
function checkNotPast(ctx: PlanCtx, setup: PropertySetup, p: StayPayload): void {
  const today = dateIn(ctx.now, setup.property.timezone);
  const until = setup.property.sameDayUntil;
  const lateToday =
    p.checkIn === today &&
    (until === null
      ? !(isPerson(ctx.caller) && ctx.t.event === "quote")
      : ctx.now > instantOf(today, until, setup.property.timezone));
  if (p.checkIn < today || lateToday) {
    refuse(ctx, "guard_failed", "Arrival is too soon or has passed.", (w) => w.started, {
      guard: "not_past",
      today,
      sameDayUntil: until,
    });
  }
}

/** The nights are free for this stay: every other stay's live claims counted, its own not. */
async function mustBeFree(ctx: PlanCtx, setup: PropertySetup, want: WantedNights, guard: string): Promise<void> {
  if (want.rooms.size === 0) return;
  const free = await nightsFree(ctx.db, setup, ctx.item.id, want, ctx.now);
  if (!free.ok) {
    const room = setup.rooms.find((r) => r.id === free.roomTypeId)?.name ?? "this room";
    refuse(ctx, "slot_taken", `${free.night} is taken for ${room} by another stay.`, (w) => w.nightsTaken, {
      guard,
      night: free.night,
      roomTypeId: free.roomTypeId,
    });
  }
}

/** The guest confirms the terms they were shown: their fingerprint, or the terms as they are now. */
async function mustConfirm(ctx: PlanCtx, stay: StayPayload, quote: StayQuote): Promise<void> {
  const sha = await stayTermsSha(stay, quote);
  if (ctx.data.terms_sha === sha) return;
  const words = ctx.audience ? stayProblems(ctx.audience.lang).confirmTerms : "confirm the terms first";
  throw new WriteError(ctx.data.terms_sha === undefined ? "confirm_terms" : "offer_changed", words, {
    details: {
      guard: "terms_confirmed",
      terms_sha: sha,
      total: quote.total,
      schedule: quote.schedule,
      policy: quote.policy,
      valid_through: quote.validThrough,
    },
  });
}

/**
 * A guest's cancellation the property writes down: the fee as of when they asked, which can only make
 * it lower, and lower still only when a person at the property gives it.
 */
function recordedCancellation(ctx: PlanCtx, stay: StayPayload, quote: StayQuote): { fee: Money; refund: Money } {
  const { data, now, item, caller } = ctx;
  const created = Date.parse(item.createdAt);
  const typed = typeof data.askedAt === "string" ? Date.parse(data.askedAt) : now;
  if (!(typed <= now + 60_000 && typed >= created - 60_000)) {
    throw new WriteError(
      "invalid_input",
      "when the guest asked must be after the stay was made and not in the future",
      {
        fields: [{ path: "input.askedAt", problem: "invalid", message: "between the stay's creation and now" }],
      },
    );
  }
  const paid = paidOf(stay);
  const policyFee = Math.min(feeAt(quote.policy, Math.max(typed, created)).value, feeAt(quote.policy, now).value);
  const capped = Math.min(policyFee, quote.total.value);
  let fee = capped;
  const given = data.fee as Money | undefined;
  if (given) {
    if (given.currency !== quote.currency || given.value < 0 || given.value > capped) {
      throw new WriteError("invalid_input", `the fee can be at most the policy's, ${capped} ${quote.currency}`, {
        fields: [{ path: "input.fee", problem: "invalid", message: "at most the policy's fee" }],
      });
    }
    if (given.value < capped && !isPerson(caller)) {
      throw new WriteError(
        "not_allowed",
        "A fee lower than the policy's is the owner's to give. Record the cancellation without a fee, or tell the owner in a note (reply with internal: true).",
        { details: { reason: "person_only", draft_for_owner: true } },
      );
    }
    fee = given.value;
  }
  const feeMoney = { value: fee, currency: quote.currency };
  return { fee: feeMoney, refund: { value: Math.max(0, paid.value - fee), currency: paid.currency } };
}

/**
 * A change one side asks for (ADR-018 change transitions on `confirmed`): the stay as it would be,
 * priced from the rates when it can be, until the time a change stays open.
 */
function planChange(ctx: PlanCtx, setup: PropertySetup, p: StayPayload & Mut, lang: StayLang): void {
  const { data, now, caller, settings } = ctx;
  const checkIn = String(data.checkIn);
  const checkOut = String(data.checkOut);
  checkDates(setup.property, checkIn, checkOut, "input");
  const rooms = (data.rooms as StayPayload["rooms"] | undefined) ?? p.rooms;
  let quote = data.quote as StayQuote | undefined;
  if (quote && isAutomation(caller)) {
    throw new WriteError("not_allowed", "A change with prices of its own is the owner's to send.", {
      details: { reason: "owner_money", draft_for_owner: true },
    });
  }
  if (quote && isCustomer(caller)) {
    throw new WriteError("invalid_input", "the property prices a change", {
      fields: [{ path: "input.quote", problem: "invalid", message: "only the property sends a quote" }],
    });
  }
  if (!quote && rooms.every((r) => r.roomTypeId)) {
    const priced = quoteFromRates(setup, {
      checkIn,
      checkOut,
      rooms: rooms.map((r) => ({
        roomTypeId: r.roomTypeId as string,
        ratePlanId: r.ratePlanId,
        adults: r.adults,
        childrenAges: r.childrenAges,
        extras: r.extras,
      })),
      lang,
      now,
      source: p.quote?.source === "person" ? "rates" : (p.quote?.source ?? "rates"),
    });
    if (priced.ok) quote = priced.quote;
  }
  if (quote) {
    const problems = quoteProblems(setup, { checkIn, checkOut }, quote, now);
    if (problems.length > 0) {
      throw new WriteError("invalid_input", `The new quote does not hold together: ${problems.join("; ")}.`, {
        fields: problems.map((m) => ({ path: "input.quote", problem: "invalid" as const, message: m })),
      });
    }
  }
  const validThrough = Math.min(
    now + settings.negotiation.offerValidHours * 3_600_000,
    stayTimes(setup.property, p.checkIn, p.checkOut).startAt,
  );
  p.change = {
    by: sideOf(caller) ?? "business",
    checkIn,
    checkOut,
    ...(data.rooms ? { rooms } : {}),
    ...(quote ? { quote } : {}),
    validThrough: isoIn(validThrough, setup.property.timezone),
  };
}

/** The open change on a stay, and whose it is, for the change guards. */
async function checkChange(ctx: PlanCtx, stay: StayPayload, guard: string): Promise<void> {
  const { caller, now } = ctx;
  const side = sideOf(caller);
  const c = stay.change;
  const words = (owner: string, guest: (w: ReturnType<typeof stayProblems>) => string) =>
    ctx.audience ? guest(stayProblems(ctx.audience.lang)) : owner;
  if (guard === "stay_change_lapsed") {
    if (!c?.validThrough || Date.parse(c.validThrough) > now) {
      throw new WriteError("guard_failed", "the change has not lapsed yet", { details: { guard } });
    }
    return;
  }
  if (!c)
    throw new WriteError(
      "no_offer",
      words("There is no change open on this stay.", (w) => w.noChange),
      { details: { guard } },
    );
  const mine = c.by === side;
  // A yes the guest gave a person to the property's own change is recorded by a person.
  const heard = guard === "stay_change_open" && mine && side === "business";
  if (heard && !isPerson(caller)) {
    throw new WriteError(
      "not_allowed",
      "Only a person can record that the guest agreed to the change you asked for. They can accept it from the email; the owner can record it in the app.",
      { details: { reason: "person_only" } },
    );
  }
  const ok = guard === "stay_change_mine" ? mine : !mine || heard;
  if (!ok)
    throw new WriteError(
      "no_offer",
      words("There is no change of the other side's to answer.", (w) => w.noChange),
      { details: { guard } },
    );
  if (guard === "stay_change_open") {
    if (c.validThrough && Date.parse(c.validThrough) <= now) {
      throw new WriteError(
        "offer_expired",
        words(`The change could be accepted until ${c.validThrough}`, (w) => w.changeLapsed),
        {
          details: { guard, validThrough: c.validThrough },
        },
      );
    }
    // A guest says yes to the new price only having seen it.
    if (isCustomer(caller) && c.quote) {
      await mustConfirm(
        ctx,
        { ...stay, checkIn: c.checkIn, checkOut: c.checkOut, rooms: c.rooms ?? stay.rooms },
        c.quote,
      );
    }
  }
}

/**
 * The schedule after a change: what was paid stays paid, at the property stays at the property, and
 * what the new total adds over what is already paid or due is a difference to pay now.
 */
function mergeChangedSchedule(
  pay: StayPayload["payments"] | undefined,
  quote: StayQuote,
): NonNullable<StayPayload["payments"]> {
  const fresh = paymentsFrom(quote, null);
  if (!pay) return fresh;
  const paid = pay.schedules.filter((s) => s.status === "paid");
  const paidTotal = paid.reduce((a, s) => a + (s.paidAmount ?? s.amount).value, 0);
  const withBooking = quote.schedule.filter((s) => s.type !== "at_property").reduce((a, s) => a + s.amount.value, 0);
  const atProperty = quote.total.value - withBooking;
  const difference = withBooking - paidTotal;
  const n = pay.schedules.filter((s) => s.id.startsWith("difference")).length + 1;
  const schedules: NonNullable<StayPayload["payments"]>["schedules"] = [...paid];
  if (difference > 0) {
    schedules.push({
      id: `difference-${n}`,
      type: "immediate",
      amount: { value: difference, currency: quote.currency },
      status: "due",
    });
  }
  if (atProperty > 0) {
    schedules.push({
      id: "at_property",
      type: "at_property",
      amount: { value: atProperty, currency: quote.currency },
      status: "at_property",
    });
  }
  return { schedules: schedules.slice(0, 6), guarantee: pay.guarantee };
}

/** The guest's messages a confirmed stay schedules: before arrival, the arrival details, a thank-you. */
function messageStatements(
  itemId: string,
  setup: PropertySetup,
  p: StayPayload,
  settings: Settings,
  now: number,
): Statement[] {
  const out: Statement[] = [];
  const zone = setup.property.timezone;
  const { startAt, endAt } = stayTimes(setup.property, p.checkIn, p.checkOut);
  const queue = (kind: StayMessageJob["kind"], runAt: number) =>
    out.push(
      jobStatement(STAY_MESSAGE_KIND, { itemId, kind, checkIn: p.checkIn } satisfies StayMessageJob, now, {
        runAt: Math.max(now, runAt),
        dedupeKey: `stay_message:${itemId}:${kind}:${p.checkIn}`,
      }),
    );
  if (settings.stays.preArrivalDays > 0) {
    const at = instantOf(addDays(p.checkIn, -settings.stays.preArrivalDays), "10:00", zone);
    if (at > now) queue("before", at);
  }
  if (setup.property.hasArrivalPrivate && settings.stays.arrivalDetailsHours > 0 && startAt > now) {
    queue("arrival", startAt - settings.stays.arrivalDetailsHours * 3_600_000);
  }
  if (settings.stays.thankYou) queue("thanks", endAt + 3 * 3_600_000);
  return out;
}

export type { StayItem };
