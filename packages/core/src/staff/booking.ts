import { type BookedAddOn, type DatedPolicy, type DepositRule, depositFor, type Policy } from "@surfingdog/spec";
import { slotOffered } from "../capabilities/availability";
import { hasPayLinks } from "../connectors/pay-queue";
import type { Db } from "../db";
import type { Item, Money } from "../domain/types";
import { datePolicy } from "../policy/index";
import { WriteError } from "../write/errors";
import { type PricingFor, servicePricing } from "../write/pricing";
import { leadHours, requiresMet } from "./requires";
import { ANY, addOnsOf, lengthWith, loadService, pickStaff, unknownStaff } from "./slots";
import { type StaffRow, type StaffService, sameTerms, staffForService, termsOf } from "./store";
import { staffWords } from "./words";

/**
 * A customer's booking request made ready before anything binds them (ADR-035): who it is with (the
 * member of staff asked for, or the first free one when they asked for anyone), its add-ons and the
 * length that makes, and — as the business set them for the service — the deposit that keeps it and
 * the cancellation policy dated in the business's zone. All of it is in the summary they confirm.
 *
 * What comes first (`requires`) is checked here too: a customer the inbox knows who has not had it is
 * asked to book it first; one it cannot know is taken, for a person to check (`checkFirst`).
 */

/** How long a deposit's link takes payments: a day, or until the start when that is sooner. */
export const DEPOSIT_WINDOW_MS = 24 * 3_600_000;

export interface PreparedBooking {
  readonly payload: Record<string, unknown>;
  /** A person checks what comes first before it is confirmed: no rule or automation confirms it. */
  readonly checkFirst: boolean;
  /** For the owner, when a person checks it: what to look for. */
  readonly ownerNote?: string | undefined;
}

export async function prepareBooking(
  db: Db,
  input: {
    readonly payload: Record<string, unknown>;
    readonly staffId?: string | undefined;
    readonly addOnIds?: readonly string[] | undefined;
    readonly timezone: string;
    readonly lang: string;
    readonly now: number;
    /** The customer, when the inbox knows them for sure (their access token, an agent key bound to them). */
    readonly partyId?: string | undefined;
    readonly pricing?: PricingFor | undefined;
  },
): Promise<PreparedBooking> {
  // Who it is with is the inbox's to choose, from `staff_id` (or anyone): whatever claim key a request
  // carries is never the customer's to pick.
  const { resourceId: _picked, staffName: _named, anyStaff: _any, ...rest } = input.payload;
  const payload: Record<string, unknown> = { ...rest };
  const reservationFor = payload.reservationFor as { serviceId?: unknown } | undefined;
  const serviceId = typeof reservationFor?.serviceId === "string" ? reservationFor.serviceId : null;
  const start = Date.parse(String(payload.startTime ?? ""));
  if (!serviceId || !Number.isFinite(start)) return { payload, checkFirst: false };
  const service = await loadService(db, serviceId);
  if (!service) return { payload, checkFirst: false };
  const addOns = addOnsOf(service, input.addOnIds);
  const staff = await staffForService(db, service.id);
  const asked = input.staffId;
  if (staff.length === 0) {
    if (asked && asked !== ANY) throw unknownStaff(asked, service.id);
    if (addOns.length > 0) {
      payload.addOns = addOns;
      payload.endTime = new Date(start + lengthWith(service, null, addOns) * 60_000).toISOString();
    }
  } else {
    let chosen = asked && asked !== ANY ? staff.find((s) => s.id === asked) : undefined;
    if (asked && asked !== ANY && !chosen) throw unknownStaff(asked, service.id);
    // Anyone: the first free in the owner's order, picked again when it is confirmed; nobody free, nobody
    // named before it binds: whoever is free then.
    if (!chosen) {
      payload.anyStaff = true;
      chosen = (await pickStaff(db, { service, staff, start, addOns, timezone: input.timezone })) ?? undefined;
    }
    if (chosen) {
      payload.resourceId = chosen.id;
      payload.staffName = chosen.publicName;
    }
    payload.endTime = new Date(start + lengthWith(service, chosen?.terms ?? null, addOns) * 60_000).toISOString();
    if (addOns.length > 0) payload.addOns = addOns;
  }

  // The price as the catalogue gives it for this customer, with them: what a deposit and fees are of.
  const partySize = typeof payload.partySize === "number" ? payload.partySize : undefined;
  const sp = await servicePricing(db, service.id, partySize, input.pricing, {
    resourceId: typeof payload.resourceId === "string" ? payload.resourceId : undefined,
    addOns,
  });
  const total = sp?.customer ?? null;
  const terms = termsFor({
    deposit: service.deposit,
    policy: service.policy,
    total,
    start,
    now: input.now,
    zone: input.timezone,
  });
  if (terms.deposit) payload.deposit = terms.deposit;
  if (terms.policy) payload.policy = terms.policy;
  // The terms it is made on, to date them again wherever it moves.
  if (terms.deposit || terms.policy) {
    payload.terms = {
      ...(terms.policy && service.policy ? { policy: service.policy } : {}),
      ...(terms.deposit && service.deposit ? { deposit: service.deposit } : {}),
    };
  }

  let checkFirst = false;
  let ownerNote: string | undefined;
  if (service.requires) {
    const first = await loadService(db, service.requires.serviceId);
    if (first) {
      const answer = await requiresMet(db, { partyId: input.partyId, requires: service.requires, start });
      const w = staffWords(input.lang);
      const days = service.requires.withinDays;
      const hours = leadHours(service.requires);
      if (answer === "unmet") {
        throw new WriteError(
          "invalid_input",
          `${w.first(service.name, first.name, days, hours)} Nothing was written.`,
          {
            fields: [{ path: "payload.reservationFor.serviceId", problem: "invalid", message: `${first.name} first` }],
            details: { reason: "requires_first", service_id: first.id, within_days: days, at_least_hours: hours },
          },
        );
      }
      if (answer === "unknown") {
        checkFirst = true;
        ownerNote = `${service.name} needs ${first.name} ${hours > 0 ? `between ${days} days and ${hours} hours` : `within ${days} days`} before. Check this client has had it, then confirm.`;
      }
    }
  }
  return { payload, checkFirst, ...(ownerNote ? { ownerNote } : {}) };
}

/**
 * A service's deposit and dated policy for one booking at `total`. The deposit's time to pay opens once
 * the booking is confirmed, and only where a payment platform takes it (`keepTermsInStep`): a request
 * is only told a deposit holds it. It comes back with a free cancellation unless the policy says it is
 * kept. Nothing when the service is not priced: a person prices it, and says what is due.
 */
export function termsFor(input: {
  readonly deposit: DepositRule | null | undefined;
  readonly policy: Policy | null | undefined;
  readonly total: Money | null;
  readonly start: number;
  readonly now: number;
  readonly zone: string;
}): {
  readonly deposit?: { amount: Money; refundable: boolean } | undefined;
  readonly policy?: DatedPolicy | undefined;
} {
  const total = input.total;
  if (!total || total.value <= 0) return {};
  const amount = input.deposit ? depositFor(input.deposit, total) : null;
  const deposit = amount ? { amount, refundable: input.policy?.deposit?.refundable ?? true } : undefined;
  const policy = input.policy
    ? datePolicy(input.policy, { start: { at: input.start }, zone: input.zone, total, bookedAt: input.now })
    : undefined;
  return { ...(deposit ? { deposit } : {}), ...(policy ? { policy } : {}) };
}

type Deposit = { amount: Money; dueBy?: string | undefined; refundable: boolean };
type Terms = { policy?: Policy | undefined; deposit?: DepositRule | undefined };

/**
 * A booking's deposit and policy at a new start and price (ADR-035): the terms it was made on, dated
 * again against when it was booked, the deposit worked out on the new price and never due after the
 * start. Nothing for a booking that has neither, or that kept no terms to date.
 */
export function termsMoved(
  p: {
    readonly terms?: Terms | undefined;
    readonly deposit?: Deposit | undefined;
    readonly policy?: DatedPolicy | undefined;
    readonly totalPrice?: Money | undefined;
  },
  at: { readonly start: number; readonly total: Money | undefined; readonly bookedAt: number },
): { deposit?: Deposit | undefined; policy?: DatedPolicy | undefined } {
  const total = at.total ?? p.totalPrice;
  const policy =
    p.policy && p.terms?.policy && total && total.value > 0
      ? datePolicy(p.terms.policy, { start: { at: at.start }, zone: p.policy.zone, total, bookedAt: at.bookedAt })
      : p.policy;
  let deposit = p.deposit;
  if (deposit) {
    const amount = p.terms?.deposit && total ? (depositFor(p.terms.deposit, total) ?? deposit.amount) : deposit.amount;
    const due = deposit.dueBy ? Math.min(Date.parse(deposit.dueBy), at.start) : null;
    deposit = {
      amount,
      refundable: deposit.refundable,
      ...(due !== null && Number.isFinite(due) ? { dueBy: new Date(due).toISOString() } : {}),
    };
  }
  return { ...(deposit ? { deposit } : {}), ...(policy ? { policy } : {}) };
}

/**
 * A salon's booking kept in step as it moves (ADR-035), on every transition: another time we propose,
 * and a change one side asks for, carry its deposit and policy dated for that time, so the customer
 * confirms them as they will apply; wherever it lands (a time accepted, a change made, their own other
 * time), they are dated for it; and once it is confirmed, the deposit's day to pay opens, where a
 * payment platform takes it.
 */
export async function keepTermsInStep(
  db: Db,
  input: {
    readonly item: Item;
    readonly payload: Record<string, unknown>;
    readonly confirms: boolean;
    readonly now: number;
  },
): Promise<void> {
  if (input.item.type !== "booking") return;
  const p = input.payload as {
    startTime: string;
    totalPrice?: Money;
    terms?: Terms;
    deposit?: Deposit;
    policy?: DatedPolicy;
    proposed?: { startTime: string; totalPrice?: Money; deposit?: unknown; policy?: unknown };
    change?: { startTime: string; totalPrice?: Money; deposit?: unknown; policy?: unknown };
  };
  if (!p.deposit && !p.policy) return;
  const bookedAt = Date.parse(input.item.createdAt);
  for (const offer of [p.proposed, p.change]) {
    if (!offer) continue;
    const at = termsMoved(p, { start: Date.parse(offer.startTime), total: offer.totalPrice, bookedAt });
    if (at.deposit) offer.deposit = { amount: at.deposit.amount, refundable: at.deposit.refundable };
    if (at.policy) offer.policy = at.policy;
  }
  const before = input.item.payload;
  const moved =
    p.startTime !== before.startTime ||
    p.totalPrice?.value !== before.totalPrice?.value ||
    p.totalPrice?.currency !== before.totalPrice?.currency;
  if (moved) {
    const at = termsMoved(p, { start: Date.parse(p.startTime), total: p.totalPrice, bookedAt });
    if (at.deposit) p.deposit = at.deposit;
    if (at.policy) p.policy = at.policy;
  }
  // Confirmed: a day to pay the deposit from now (the start, when sooner), where a link can ask for it.
  if (input.confirms && p.deposit && !p.deposit.dueBy && p.deposit.amount.value > 0 && (await hasPayLinks(db))) {
    const start = Date.parse(p.startTime);
    p.deposit.dueBy = new Date(Math.min(input.now + DEPOSIT_WINDOW_MS, start)).toISOString();
  }
}

/**
 * A booking for anyone, as it is confirmed (ADR-035): with whoever it went to when they are still free,
 * else with the first free in the owner's order at the same price and length, so what the customer
 * confirmed stays true. Nobody such: as it was, for the confirm to say the time is taken; with nobody,
 * when the one it went to has left.
 */
export async function repickAnyone(
  db: Db,
  input: { readonly itemId: string; readonly payload: Record<string, unknown>; readonly timezone: string },
): Promise<void> {
  const p = input.payload as AnyonePayload;
  if (p.anyStaff !== true) return;
  const service = await loadService(db, p.reservationFor.serviceId);
  if (!service) return;
  const staff = await staffForService(db, service.id);
  const start = Date.parse(p.startTime);
  const current = staff.find((s) => s.id === p.resourceId);
  if (current) {
    const end = start + lengthWith(service, current.terms, p.addOns ?? []) * 60_000;
    const free = await slotOffered(db, {
      serviceId: service.id,
      start,
      end,
      timezone: input.timezone,
      exceptItemId: input.itemId,
      resource: { id: current.id, capacity: current.capacity },
    });
    if (free) return;
  }
  const next = await pickStaff(db, {
    service,
    staff: await sameAs(db, service.id, staff, current, p.resourceId),
    start,
    addOns: p.addOns ?? [],
    timezone: input.timezone,
    exceptItemId: input.itemId,
  });
  if (!next) {
    // It went to someone who no longer gives it here, and nobody else can: it is with nobody, so the
    // confirm says the time is taken (`nobodyToTake`), never confirms it with them.
    if (p.resourceId && !current && staff.length > 0) {
      delete p.resourceId;
      delete p.staffName;
    }
    return;
  }
  p.resourceId = next.id;
  p.staffName = next.publicName;
  p.endTime = new Date(start + lengthWith(service, next.terms, p.addOns ?? []) * 60_000).toISOString();
}

type AnyonePayload = {
  anyStaff?: boolean;
  resourceId?: string;
  staffName?: string;
  startTime: string;
  endTime: string;
  addOns?: BookedAddOn[];
  reservationFor: { serviceId: string };
};

/**
 * Who else may take a booking for anyone (ADR-035): those who give the service on the terms it was
 * made on — the price and the length of whoever it went to (as the owner set them, when that person
 * has left), or the service's own when it went to nobody — so what the customer confirms stays true.
 */
async function sameAs(
  db: Db,
  serviceId: string,
  staff: Awaited<ReturnType<typeof staffForService>>,
  current: Awaited<ReturnType<typeof staffForService>>[number] | undefined,
  resourceId: string | undefined,
): Promise<Awaited<ReturnType<typeof staffForService>>> {
  const was = current?.terms ?? (resourceId ? await termsOf(db, serviceId, resourceId) : null);
  return staff.filter((s) => s.id !== current?.id && sameTerms(s.terms, was));
}

/** Who would take a time for a booking for anyone (`anyoneAt`), and on whose terms. */
export interface AnyoneTake {
  readonly id: string;
  readonly capacity: number;
  /** The owner's own name for them. */
  readonly name: string;
  /** What customers see. */
  readonly publicName: string;
  /** Their own price and length for the service, as the owner set them. */
  readonly terms: StaffService;
  /**
   * On the price and length the booking was made on (`sameAs`). Else theirs go with the time, for the
   * customer to confirm before it binds (`termsWith`).
   */
  readonly sameTerms: boolean;
}

/**
 * Who a time for a booking for anyone would go to (ADR-035), as a time we propose for it, or the
 * customer's own other time, is judged: whoever it is with when they are free then, else the first free
 * in the owner's order on the same terms (`sameAs`), else — as the free times list them — whoever else
 * gives it and is free then at their own length, on their own terms. One person, so a time we hold for
 * it holds one place, not every stylist's. Undefined for a booking that is not for anyone on a service
 * staff give; null when nobody who gives it is free. Who it is with is still picked when it is confirmed
 * (`repickAnyone`).
 */
export async function anyoneAt(
  db: Db,
  input: {
    readonly itemId: string;
    readonly payload: Record<string, unknown>;
    readonly start: number;
    readonly end: number;
    readonly timezone: string;
  },
): Promise<AnyoneTake | null | undefined> {
  const p = input.payload as AnyonePayload;
  if (p.anyStaff !== true) return undefined;
  const service = await loadService(db, p.reservationFor.serviceId);
  if (!service) return undefined;
  const staff = await staffForService(db, service.id);
  if (staff.length === 0) return undefined;
  const at = { start: input.start, end: input.end, timezone: input.timezone, exceptItemId: input.itemId };
  const take = (s: StaffRow & { readonly terms: StaffService }, sameTerms: boolean): AnyoneTake => ({
    id: s.id,
    capacity: s.capacity,
    name: s.name,
    publicName: s.publicName,
    terms: s.terms,
    sameTerms,
  });
  const current = staff.find((s) => s.id === p.resourceId);
  if (
    current &&
    (await slotOffered(db, { serviceId: service.id, ...at, resource: { id: current.id, capacity: current.capacity } }))
  ) {
    return take(current, true);
  }
  const addOns = p.addOns ?? [];
  const same = await sameAs(db, service.id, staff, current, p.resourceId);
  const next = await pickStaff(db, { service, staff: same, addOns, ...at });
  if (next) return take(next, true);
  const rest = staff.filter((s) => s.id !== current?.id && !same.some((x) => x.id === s.id));
  const other = await pickStaff(db, {
    service,
    staff: rest,
    start: input.start,
    addOns,
    timezone: input.timezone,
    exceptItemId: input.itemId,
  });
  return other ? take(other, false) : null;
}

/**
 * A booking for anyone at `start` with someone on other terms than it was made on (ADR-035): their own
 * length, the add-ons added, and their price for it, as the free times and the services list say them.
 * What the customer confirms before it binds; the price is null where the catalogue does not price it.
 */
export async function termsWith(
  db: Db,
  input: {
    readonly payload: Record<string, unknown>;
    readonly who: Pick<AnyoneTake, "id" | "terms">;
    readonly start: number;
    readonly pricing?: PricingFor | undefined;
  },
): Promise<{
  readonly endTime: string;
  readonly minutes: number;
  readonly total: Money | null;
  readonly personalised?: { readonly listPrice: Money; readonly says?: string } | undefined;
}> {
  const p = input.payload as AnyonePayload & { partySize?: number };
  const service = await loadService(db, p.reservationFor.serviceId);
  const addOns = p.addOns ?? [];
  const minutes = service ? lengthWith(service, input.who.terms, addOns) : 0;
  const sp = await servicePricing(db, p.reservationFor.serviceId, p.partySize, input.pricing, {
    resourceId: input.who.id,
    addOns,
  });
  const says = sp?.reward?.says;
  return {
    endTime: new Date(input.start + minutes * 60_000).toISOString(),
    minutes,
    total: sp?.customer ?? null,
    ...(sp?.reward && sp.list ? { personalised: { listPrice: sp.list, ...(says ? { says } : {}) } } : {}),
  };
}
