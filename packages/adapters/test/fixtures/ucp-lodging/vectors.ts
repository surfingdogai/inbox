import type { PropertySetup, StayLang } from "@surfingdog/core";
import type { BookingParts, StayQuote, Subject, UcpBooking } from "../../../src/ucp-lodging";
import kijani from "./kijani-house.json" with { type: "json" };
import maple from "./maple-hollow.json" with { type: "json" };
import ryokan from "./ryokan-hoshi.json" with { type: "json" };

/**
 * The UCP Lodging vectors (ucp-lodging.ts): three fictional properties' quotes and the booking session
 * the inbox answers for each. Ryokan Hoshi (Kyoto, JPY) holds a room with a first-night deposit and a
 * tax paid at the property; Kijani House (Nairobi, KES) is paid at the property and waits for its lead;
 * Maple Hollow B&B (Nova Scotia, CAD) is booked, its balance due a week before, in French. Sources: the
 * UCP Lodging draft at commit f2626c28b8288976eee5bda77f3a9b1ddc0132b1, named in each file's `_sources`.
 */
export interface Vector {
  readonly name: string;
  readonly id: string;
  readonly status: UcpBooking["status"];
  readonly lang: string;
  readonly now: string;
  readonly origin: string;
  readonly expires_at?: string;
  readonly property: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
    readonly timezone: string;
    readonly locality: string;
    readonly checkInFrom: string;
    readonly checkOutUntil: string;
    readonly children: { readonly welcome: boolean; readonly fromAge?: number; readonly freeUnder?: number };
  };
  readonly rooms: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    readonly capacity: { readonly adults: number; readonly children: number; readonly total: number };
  }[];
  readonly plans: readonly { readonly id: string; readonly name: string }[];
  readonly fees: readonly {
    readonly name: string;
    readonly kind: string;
    readonly collected: string;
    readonly childExemptUnder: number | null;
    readonly maxNights: number | null;
  }[];
  readonly subject: Subject;
  readonly quote: StayQuote;
  readonly booker?: Record<string, unknown>;
  readonly guests?: readonly Record<string, unknown>[];
  readonly assignments?: readonly (readonly { readonly guest_id: string; readonly role?: string }[])[];
  readonly messages?: readonly Record<string, unknown>[];
  readonly confirmation?: { readonly id: string; readonly label: string };
  readonly booking?: UcpBooking;
}

export const VECTORS = [ryokan, kijani, maple] as unknown as readonly Vector[];

export const VECTOR_FILES = ["ryokan-hoshi.json", "kijani-house.json", "maple-hollow.json"] as const;

/** A vector's property as the stays store reads one, with the defaults a set-up place has. */
export function setupOf(v: Vector): PropertySetup {
  const p = v.property;
  return {
    property: {
      id: p.id,
      locationId: "loc_main",
      kind: "guesthouse",
      name: p.name,
      currency: p.currency,
      timezone: p.timezone,
      checkInFrom: p.checkInFrom,
      checkInUntil: null,
      checkOutUntil: p.checkOutUntil,
      mode: "allotment",
      instant: false,
      freshMinutes: 15,
      answerHours: 12,
      quoteValidHours: 24,
      payWithinHours: 24,
      holdMinutes: 30,
      maxNights: 30,
      sameDayUntil: null,
      children: p.children,
      pets: { allowed: "no" },
      houseRules: { chips: [] },
      arrivalPublic: null,
      hasArrivalPrivate: false,
      preArrivalText: null,
      registration: null,
      pricesInclude: null,
      connectorId: null,
      externalId: null,
      active: true,
      locality: p.locality,
    },
    rooms: v.rooms.map((r, i) => ({
      id: r.id,
      propertyId: p.id,
      name: r.name,
      description: r.description,
      units: 2,
      capacity: r.capacity,
      beds: [],
      sizeM2: null,
      amenities: [],
      accessible: false,
      photos: [],
      externalId: null,
      offered: true,
      active: true,
      sort: i,
    })),
    plans: v.plans.map((x, i) => ({
      id: x.id,
      propertyId: p.id,
      name: x.name,
      meal: "breakfast",
      policyId: `pol_${x.id}`,
      policy: { steps: [], after: { kind: "none" }, noShow: { kind: "none" } },
      policyPreset: "free_until",
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
      sort: i,
    })),
    rates: [],
    fees: v.fees.map((f, i) => ({
      id: `fee_${i}`,
      name: f.name,
      kind: f.kind === "tax" ? "tax" : "fee",
      basis: "per_stay",
      amount: null,
      rateBp: null,
      tiers: null,
      collected: f.collected === "at_property" ? "at_property" : "with_booking",
      childExemptUnder: f.childExemptUnder,
      maxNights: f.maxNights,
      active: true,
    })),
    extras: [],
    allotments: [],
    closures: [],
  };
}

/** What `ucpBookingOf` is given for a vector: the parts the doors put together from the stay. */
export function partsOf(v: Vector): BookingParts {
  return {
    id: v.id,
    status: v.status,
    subject: v.subject,
    quote: v.quote,
    setup: setupOf(v),
    lang: v.lang as StayLang,
    now: Date.parse(v.now),
    origin: v.origin,
    messages: (v.messages ?? []) as BookingParts["messages"] & object,
    expiresAt: v.expires_at,
    booker: v.booker,
    guests: v.guests,
    assignments: v.assignments,
    ...(v.confirmation ? { confirmation: v.confirmation } : {}),
  };
}
