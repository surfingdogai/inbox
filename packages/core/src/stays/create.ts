import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { dateIn } from "../util/zoned";
import { jobStatement } from "../write/common";
import { WriteError } from "../write/errors";
import { checkDates, stayTimes } from "./nights";
import { readSetup } from "./store";
import { checkGuestPlan, STAY_SWEEP_KIND } from "./transition";

/**
 * What only the property, or the inbox for it, writes on a stay (ADR-033 §2.2): a request never
 * arrives holding a price, a payment, a hold, an outcome or the property's own booking, whoever sends
 * it. The inbox adds what it works out itself (the times, an estimate from the rates) afterwards.
 */
export const STAY_SERVER_FIELDS = [
  "startTime",
  "endTime",
  "quote",
  "estimate",
  "totalPrice",
  "hold",
  "payments",
  "cancellation",
  "availability",
  "external",
  "checkedInAt",
  "checkedOutAt",
  "registration",
  "change",
  "offer",
  "termsSha",
] as const;

/** How often the stays sweep runs while any stay is open. */
export const STAY_SWEEP_PERIOD_MS = 60_000;
export const staySweepKey = (now: number): string => `${STAY_SWEEP_KIND}:${Math.floor(now / STAY_SWEEP_PERIOD_MS)}`;

/**
 * A new stay checked against the property and written with its times: the property takes stays, the
 * dates are real and ahead, every room named is one it offers and sleeps its guests. The payload is
 * changed in place. Answers the statements the create writes beside it (the sweep that watches it).
 */
export async function prepareStay(
  db: Db,
  payload: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> | undefined,
  opts: { readonly now: number; readonly person: boolean },
): Promise<{ readonly locationId: string; readonly statements: Statement[] }> {
  for (const field of STAY_SERVER_FIELDS) delete payload[field];
  const propertyId = String(payload.propertyId);
  const setup = await readSetup(db, propertyId);
  if (!setup?.property.active) {
    throw new WriteError("invalid_input", "There is no such place to stay here.", {
      fields: [{ path: "payload.propertyId", problem: "invalid", message: "a property of this inbox" }],
    });
  }
  const p = setup.property;
  const checkIn = String(payload.checkIn);
  const checkOut = String(payload.checkOut);
  checkDates(p, checkIn, checkOut);
  const today = dateIn(opts.now, p.timezone);
  if (checkIn < today) {
    throw new WriteError("invalid_input", "The arrival date has passed.", {
      fields: [{ path: "payload.checkIn", problem: "invalid", message: `on or after ${today}` }],
    });
  }
  if (p.registration?.required && !p.registration.number && !opts.person) {
    throw new WriteError("not_allowed", "This place cannot take stays here yet.", {
      details: { reason: "registration_missing" },
    });
  }
  const rooms = payload.rooms as {
    roomTypeId?: string;
    roomTypeName?: string;
    adults: number;
    childrenAges: number[];
  }[];
  rooms.forEach((room, i) => {
    if (room.childrenAges.length > 0 && !p.children.welcome) {
      throw new WriteError("invalid_input", "This place takes adults only.", {
        fields: [{ path: `payload.rooms.${i}.childrenAges`, problem: "invalid", message: "adults only" }],
      });
    }
    if (!room.roomTypeId) return;
    const type = setup.rooms.find((r) => r.id === room.roomTypeId && r.active && (r.offered || opts.person));
    if (!type) {
      throw new WriteError("invalid_input", "There is no such room here.", {
        fields: [
          { path: `payload.rooms.${i}.roomTypeId`, problem: "invalid", message: "a room type of this property" },
        ],
      });
    }
    room.roomTypeName = type.name;
    if (!opts.person) checkGuestPlan(setup, room as { roomTypeId?: string; ratePlanId?: string }, `payload.rooms.${i}`);
    const children = room.childrenAges.length;
    if (
      room.adults > type.capacity.adults ||
      children > type.capacity.children ||
      room.adults + children > type.capacity.total
    ) {
      throw new WriteError("invalid_input", `${type.name} sleeps ${type.capacity.total}.`, {
        fields: [{ path: `payload.rooms.${i}`, problem: "invalid", message: `at most ${type.capacity.total} guests` }],
      });
    }
  });
  const { startTime, endTime } = stayTimes(p, checkIn, checkOut);
  payload.startTime = startTime;
  payload.endTime = endTime;
  if (p.registration?.number) payload.registration = p.registration.number;
  // What the inbox worked out for this request (an estimate from the rates), never the request's own.
  if (extra?.estimate) payload.estimate = extra.estimate;
  return {
    locationId: p.locationId,
    statements: [jobStatement(STAY_SWEEP_KIND, {}, opts.now, { dedupeKey: staySweepKey(opts.now) })],
  };
}
