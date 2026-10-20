/**
 * Smoobu bookings, in the documented shapes. Source: <https://docs.smoobu.com/>, sections "Smoobu
 * Availability", "Create Booking", "Update Booking", "Get Bookings Api", "Get Booking", "Cancel
 * Reservation" and "Channels", read 20 October 2026.
 *
 * Excerpts the adapter is built from:
 * - `POST https://login.smoobu.com/booking/checkApartmentAvailability` with `arrivalDate`,
 *   `departureDate`, `apartments` ("If apartments is empty it check all apartments"), `customerId`
 *   ("Id of the customer/user with the given apartment and the api key", mandatory) and `guests` →
 *   `{ "availableApartments": [3, 14], "prices": { "3": { "price": 36560, "currency": "IDR" } },
 *   "errorMessages": { "2": { "errorCode": 401, "message": "The duration of the booking is too short.",
 *   "minimumLengthOfStay": 50 } } }`. Error codes 400 (guests), 401 (too short), 402 (arrival day),
 *   403 (lead time), 404 (between bookings). The documented example lists apartment 2 as available
 *   and with an error at once: an apartment is free here only when it is listed and has no error.
 * - `POST https://login.smoobu.com/api/reservations`: `arrivalDate`, `departureDate`, `apartmentId`
 *   (mandatory); `channelId` ("Default = 70", Homepage); `firstName`, `lastName`, `email`, `phone`,
 *   `notice`, `arrivalTime`, `address`, `country` ("depend on the user settings … in the booking-tool
 *   settings in 'Form Content'"); `adults`, `children`, `price` ("Total price of the booking", a float,
 *   no currency), `priceStatus`, `prepayment`, `deposit` and their statuses, `language`,
 *   `priceElements`. → `{ "id": 906 }`. Refused, 400: `{ "status": 400, "title": "Bad Request",
 *   "detail": "Failed validation", "validation_messages": { "error": "There exists already a
 *   reservation from 05.09.2019 to 08.09.2019." } }`, or "Channel with id 144 not found for user 7".
 * - `PUT https://login.smoobu.com/api/reservations/<reservationId>`: `arrivalTime`, `departureTime`,
 *   `price`, `priceStatus`, `prepayment`, `deposit` and statuses, `notice`, `assistantNotice`,
 *   `guestName`, `guestEmail`, `guestPhone`, `adults`, `children`, `language`: no dates, no apartment.
 *   → `{ "status": 200, "title": "Resource updated successfully", "detail": "" }`.
 * - `GET https://login.smoobu.com/api/reservations` with `from`, `to` ("show all bookings in the
 *   range"), `showCancellation` ("include cancelled bookings"), `excludeBlocked`, `page`, `pageSize`
 *   ("max 100"), `apartmentId`, `includeRelated` ("returns bookings from grouped apartments") →
 *   `{ "page_count", "page_size", "total_items", "page", "bookings": [ { "id", "reference-id", "type",
 *   "arrival", "departure", "created-at", "modified-at", "apartment": { "id", "name" }, "channel":
 *   { "id", "name" }, "guest-name", "email", "phone", "adults", "children", "check-in", "check-out",
 *   "notice", "price", "price-paid", "prepayment", "prepayment-paid", "deposit", "deposit-paid",
 *   "language", "guest-app-url", "is-blocked-booking", "guestId", "related": [ { "id", "name" } ] } ] }`.
 *   Booking types: "reservation", "modification of booking", "cancellation".
 * - `DELETE https://login.smoobu.com/api/reservations/<reservationId>` → `{ "success": true }`: "The
 *   booking is still in the system as a cancelled booking."
 *
 * Not documented, and chosen for the fake only: the answer to an unknown booking id (404 in the
 * documented error envelope), to a create whose names the booking tool requires, and to an
 * availability check for another user's `customerId` (the documented "verification error").
 */

export interface FakeReservation {
  readonly id: number;
  apartmentId: number;
  arrival: string;
  departure: string;
  type: "reservation" | "modification of booking" | "cancellation";
  channel: { readonly id: number; readonly name: string };
  guestName: string;
  email: string | null;
  phone: string | null;
  adults: number;
  children: number;
  notice: string;
  price: number | null;
  blocked: boolean;
  createdAt: string;
  modifiedAt: string;
  language: string | null;
}

/** Smoobu's default channel for a booking sent through its API, as the channel list names it. */
export const HOMEPAGE = { id: 70, name: "Homepage" } as const;
export const BOOKING_COM = { id: 14, name: "Booking.com" } as const;
export const AIRBNB_ICAL = { id: 1, name: "Airbnb iCal" } as const;
export const BLOCKED_CHANNEL = { id: 11, name: "Blocked channel" } as const;

/** A guest another channel booked: made up. */
export const OTA_GUEST = { name: "Wanjiru Kamau", email: "wanjiru@guest.example", phone: "+254700000000" };

/** The documented booking object, as Get Booking and Get Bookings answer it. */
export function reservationObject(r: FakeReservation, related: readonly { id: number; name: string }[] = []) {
  return {
    id: r.id,
    "reference-id": r.channel.id === HOMEPAGE.id ? null : `REF${r.id}`,
    type: r.type,
    arrival: r.arrival,
    departure: r.departure,
    "created-at": r.createdAt,
    "modified-at": r.modifiedAt,
    apartment: { id: r.apartmentId, name: `Apartment ${r.apartmentId}` },
    channel: r.channel,
    "guest-name": r.guestName,
    email: r.email,
    phone: r.phone,
    adults: r.adults,
    children: r.children,
    "check-in": "14:00",
    "check-out": "11:00",
    notice: r.notice,
    price: r.price,
    "price-paid": "No",
    prepayment: 0,
    "prepayment-paid": "No",
    deposit: 0,
    "deposit-paid": "No",
    language: r.language ?? "en",
    // A link Smoobu gives its guests: never followed by the adapter.
    "guest-app-url": `https://guest.smoobu.com/?t=fake&b=${r.id}`,
    "is-blocked-booking": r.blocked,
    guestId: r.id + 100,
    related,
  };
}

/** Smoobu's documented refusal of a create onto nights a booking holds already. */
export function existsAlready(arrival: string, departure: string) {
  const dmy = (d: string) => d.split("-").reverse().join(".");
  return {
    status: 400,
    title: "Bad Request",
    detail: "Failed validation",
    validation_messages: { error: `There exists already a reservation from ${dmy(arrival)} to ${dmy(departure)}.` },
  };
}

/** A refusal of a create without the names the owner's booking tool requires (undocumented shape). */
export const NAMES_REQUIRED = {
  status: 400,
  title: "Bad Request",
  detail: "Failed validation",
  validation_messages: { firstName: { isEmpty: "Value is required and can't be empty" } },
};

/** The documented answer to an authentication the availability check did not take. */
export const VERIFICATION_ERROR = { title: "Error occurred", detail: "verification error" };

export const UPDATED = { status: 200, title: "Resource updated successfully", detail: "" };
export const NOT_FOUND = { status: 404, title: "Not Found", detail: "Reservation not found" };
