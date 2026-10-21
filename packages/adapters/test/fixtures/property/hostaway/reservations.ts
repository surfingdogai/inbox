/**
 * Hostaway reservations, as documented. Source: <https://api.hostaway.com/documentation>, sections
 * "Reservation object", "Reservation statuses", "Retrieve a reservations list", "Retrieve a
 * reservation", "Create a reservation", "Update a reservation", "Cancel a reservation", "Delete a
 * reservation", "Reservation Channels" and the changelog, read 20 October 2026.
 *
 * Excerpts the adapter is built from:
 * - Create: `POST https://api.hostaway.com/v1/reservations`, "A reservation object should be provided in
 *   the request body." "Only 2000 (direct), 2002 (homeaway) and 2020 (partner) are supported as
 *   channelId when creating a reservation." Query `forceOverbooking` "Ignore overbooking protection";
 *   `provider` "Updates the reservation.source field value … limited to 50 characters; longer values
 *   are rejected." It has "its own rate limit of 200 requests per 10 seconds, per account".
 * - Not documented: what the overbooking protection refuses, and how. The fake refuses a night it has
 *   no room for with 400 and Hostaway's `fail` envelope (`refuses`), or, to prove the read-back, takes
 *   it (`off`). The adapter never sends `forceOverbooking`, and checks the nights itself either way.
 * - Update: `PUT https://api.hostaway.com/v1/reservations/{reservationId}`; "It’s not possible to update
 *   the listingMapId of a reservation with this request." The documented example sends a subset of the
 *   fields, so the fake keeps what is not sent.
 * - Cancel: `PUT https://api.hostaway.com/v1/reservations/{reservationId}/statuses/cancelled` with
 *   `cancelledBy` "host or guest". `DELETE …/reservations/{reservationId}` exists and is never used.
 * - List filters: `listingId`, `channelId`, `arrivalStartDate`, `arrivalEndDate`, `limit` ("default limit
 *   is 100"); "The default order (no sortOrder) is newest first" by `updatedOn`. There is no filter by
 *   a reference of ours, so our key rides in `hostNote`.
 * - Statuses: `new` "blocks calendar"; `modified` "Blocks calendar"; `cancelled` "Does not block
 *   calendar"; `ownerStay`; `pending` and `awaitingPayment` "Airbnb only"; `unconfirmed` "Vrbo only";
 *   `inquiry` "doesn’t block the calendar"; `declined`, `expired`, `inquiryPreapproved`,
 *   `inquiryDenied`, `inquiryTimedout`, `inquiryNotPossible`, `unknown`. And "confirmed reservation
 *   status is deprecated for creating/updating reservations" (2020-12-18).
 * - Channels: 2000 `direct`, 2005 `bookingcom`, 2018 `airbnbOfficial`, 2020 `partner`.
 */

export const DIRECT = 2000;
export const BOOKING_COM = 2005;
export const AIRBNB = 2018;

/** Statuses that hold a listing's nights, in the fake as in the documentation's table. */
export const BLOCKING = new Set([
  "new",
  "modified",
  "ownerStay",
  "pending",
  "awaitingPayment",
  "awaitingGuestVerification",
  "unconfirmed",
]);

export interface FakeReservation {
  readonly id: number;
  listingMapId: number;
  readonly channelId: number;
  readonly source: string | null;
  status: string;
  arrivalDate: string;
  departureDate: string;
  previousArrivalDate: string | null;
  previousDepartureDate: string | null;
  hostNote: string | null;
  guestNote: string | null;
  guestName: string | null;
  guestEmail: string | null;
  phone: string | null;
  numberOfGuests: number;
  adults: number;
  children: number | null;
  totalPrice: number | null;
  currency: string | null;
  cancelledBy: string | null;
  cancellationDate: string | null;
  updatedOn: number;
}

/** The Reservation object as Hostaway answers it, with the fields the adapter reads and some it must not keep. */
export function reservationObject(r: FakeReservation) {
  return {
    id: r.id,
    listingMapId: r.listingMapId,
    channelId: r.channelId,
    source: r.source,
    channelName: r.channelId === DIRECT ? "direct" : r.channelId === BOOKING_COM ? "bookingcom" : "airbnbOfficial",
    reservationId: `${r.listingMapId}-${r.id}`,
    hostawayReservationId: r.id,
    channelReservationId: `${r.listingMapId}-${r.id}`,
    status: r.status,
    arrivalDate: r.arrivalDate,
    departureDate: r.departureDate,
    previousArrivalDate: r.previousArrivalDate,
    previousDepartureDate: r.previousDepartureDate,
    nights: Math.round((Date.parse(r.departureDate) - Date.parse(r.arrivalDate)) / 86_400_000),
    guestName: r.guestName,
    guestEmail: r.guestEmail,
    phone: r.phone,
    numberOfGuests: r.numberOfGuests,
    adults: r.adults,
    children: r.children,
    infants: null,
    pets: null,
    totalPrice: r.totalPrice,
    currency: r.currency,
    hostNote: r.hostNote,
    guestNote: r.guestNote,
    cancelledBy: r.cancelledBy,
    cancellationDate: r.cancellationDate,
    // Never read, never kept.
    doorCode: "0000",
    guestAddress: null,
    customFieldValues: [],
  };
}

/** A booking another channel made: a guest's details the adapter reads past and never keeps. */
export const OTA_GUEST = { guestName: "A. Guest", guestEmail: "guest@example.net", phone: "+10000000000" };
