import { type DatedPolicy, type DepositRule, depositFor, type Policy } from "@surfingdog/spec";
import type { Db } from "../db";
import type { Money } from "../domain/types";
import { datePolicy } from "../policy/index";
import { WriteError } from "../write/errors";
import { type PricingFor, servicePricing } from "../write/pricing";
import { requiresMet } from "./requires";
import { ANY, addOnsOf, lengthWith, loadService, pickStaff, unknownStaff } from "./slots";
import { staffForService } from "./store";
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
  const payload: Record<string, unknown> = { ...input.payload };
  const reservationFor = payload.reservationFor as { serviceId?: unknown } | undefined;
  const serviceId = typeof reservationFor?.serviceId === "string" ? reservationFor.serviceId : null;
  const start = Date.parse(String(payload.startTime ?? ""));
  if (!serviceId || !Number.isFinite(start)) return { payload, checkFirst: false };
  const service = await loadService(db, serviceId);
  if (!service) return { payload, checkFirst: false };
  const addOns = addOnsOf(service, input.addOnIds);
  const staff = await staffForService(db, service.id);
  const asked =
    input.staffId ??
    (typeof payload.resourceId === "string" && staff.length > 0 ? (payload.resourceId as string) : undefined);
  if (staff.length === 0) {
    if (asked && asked !== ANY) throw unknownStaff(asked, service.id);
    if (addOns.length > 0) {
      payload.addOns = addOns;
      payload.endTime = new Date(start + lengthWith(service, null, addOns) * 60_000).toISOString();
    }
  } else {
    let chosen = asked && asked !== ANY ? staff.find((s) => s.id === asked) : undefined;
    if (asked && asked !== ANY && !chosen) throw unknownStaff(asked, service.id);
    // Anyone: the first free in the owner's order; nobody free, the first, for a person to answer.
    chosen ??= (await pickStaff(db, { service, staff, start, addOns, timezone: input.timezone })) ?? staff[0];
    if (chosen) {
      payload.resourceId = chosen.id;
      payload.staffName = chosen.publicName;
      payload.endTime = new Date(start + lengthWith(service, chosen.terms, addOns) * 60_000).toISOString();
    }
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

  let checkFirst = false;
  let ownerNote: string | undefined;
  if (service.requires) {
    const first = await loadService(db, service.requires.serviceId);
    if (first) {
      const answer = await requiresMet(db, { partyId: input.partyId, requires: service.requires, start });
      const w = staffWords(input.lang);
      if (answer === "unmet") {
        throw new WriteError(
          "invalid_input",
          `${w.first(service.name, first.name, service.requires.withinDays)} Nothing was written.`,
          {
            fields: [{ path: "payload.reservationFor.serviceId", problem: "invalid", message: `${first.name} first` }],
            details: { reason: "requires_first", service_id: first.id, within_days: service.requires.withinDays },
          },
        );
      }
      if (answer === "unknown") {
        checkFirst = true;
        ownerNote = `${service.name} needs ${first.name} within ${service.requires.withinDays} days before. Check this client has had it, then confirm.`;
      }
    }
  }
  return { payload, checkFirst, ...(ownerNote ? { ownerNote } : {}) };
}

/**
 * A service's deposit and dated policy for one booking at `total`. The deposit is due within a day,
 * or by the start when that is sooner; it comes back with a free cancellation unless the policy says
 * it is kept. Nothing when the service is not priced: a person prices it, and says what is due.
 */
export function termsFor(input: {
  readonly deposit: DepositRule | null | undefined;
  readonly policy: Policy | null | undefined;
  readonly total: Money | null;
  readonly start: number;
  readonly now: number;
  readonly zone: string;
}): {
  readonly deposit?: { amount: Money; dueBy: string; refundable: boolean } | undefined;
  readonly policy?: DatedPolicy | undefined;
} {
  const total = input.total;
  if (!total || total.value <= 0) return {};
  const amount = input.deposit ? depositFor(input.deposit, total) : null;
  const deposit = amount
    ? {
        amount,
        dueBy: new Date(Math.min(input.now + DEPOSIT_WINDOW_MS, input.start)).toISOString(),
        refundable: input.policy?.deposit?.refundable ?? true,
      }
    : undefined;
  const policy = input.policy
    ? datePolicy(input.policy, { start: { at: input.start }, zone: input.zone, total, bookedAt: input.now })
    : undefined;
  return { ...(deposit ? { deposit } : {}), ...(policy ? { policy } : {}) };
}
