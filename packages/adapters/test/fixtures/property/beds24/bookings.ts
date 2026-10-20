/**
 * Beds24 bookings, as documented. Sources:
 * - https://beds24.com/api/v2/apiV2.yaml (saved copy: scratchpad ext-beds24/apiV2.yaml): `POST /bookings`
 *   (an array of schema `newBooking` + `bookingActions`, with `id` "required to update an existing
 *   booking"; its examples `newBooking` and `multipleNewBookings`, where an existing booking is
 *   cancelled by sending `{"id": …, "status": "cancelled"}`), the answer (an array of
 *   `multiplePostResponse`: success, new, modified, errors, warnings, info), `GET /bookings` (query
 *   `id`, `apiReference`, `roomId`, `arrivalTo`, `departureFrom`, `status`, `includeBookingGroup`; answer
 *   `data` of schema `booking`, which carries `apiReference`, up to 100 characters), the booking
 *   statuses (confirmed, request, new, cancelled, black, inquiry), the action `checkAvailability` ("Do
 *   not save the booking if room has no availability") and `allowWebhooks`.
 * - https://wiki.beds24.com/index.php/API_V2.0: "Prices are not calculated automatically for bookings
 *   created through the API" and "Include the price field in your POST /bookings request to set the
 *   booking total"; the answer's New field holds "the id of a newly created booking".
 * Values are made up for these tests.
 */

/** The OpenAPI file's own `newBooking` example, as given. */
export const newBookingExample = [
  {
    roomId: 1_234_567,
    status: "confirmed",
    arrival: "2021-01-01",
    departure: "2021-01-05",
    numAdult: 2,
    numChild: 1,
    title: "Mr",
    firstName: "John",
    lastName: "Doe",
    email: "johndoe@example.com",
    mobile: 123_456_789,
    address: "123 Fake st",
    city: "Melbourne",
    state: "Victoria",
    postcode: "3000",
    country: "Australia",
  },
];

/** The OpenAPI file's own cancellation, inside its `multipleNewBookings` example. */
export const cancelExample = {
  id: 7_654_321,
  status: "cancelled",
  comment: "This is an existing booking that will be cancelled",
};

/** An answer to a POST that made one booking (schema `multiplePostResponse`, `new` holding its id). */
export const createdAnswer = [{ success: true, new: { id: 90_001_001 }, warnings: [], info: [] }];

/** An answer to a POST Beds24 did not save (`checkAvailability` on a full night). Message made up. */
export const refusedAnswer = [
  { success: false, errors: [{ action: "new", field: "roomId", message: "No availability for these dates" }] },
];

/**
 * Fields a booking can carry that this inbox must never send: card tokens, a deposit Beds24 would
 * record, a commission (schema `newBooking`: `stripeToken`, `pcibookingToken`, `deposit`, `commission`;
 * invoice items of type payment).
 */
export const NEVER_SENT = /card|cvc|cvv|stripe|pcibooking|token|deposit|commission|application_fee|invoiceItems/i;
