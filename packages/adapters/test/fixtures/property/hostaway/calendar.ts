/**
 * Hostaway's calendar and its price calculation, as documented. Source:
 * <https://api.hostaway.com/documentation>, sections "Calendar day object", "Calendar day statuses",
 * "Retrieve a calendar" and "Calculate reservation price", read 20 October 2026.
 *
 * Excerpts the adapter is built from:
 * - `GET https://api.hostaway.com/v1/listings/{listingId}/calendar?startDate=…&endDate=…&includeResources=…`:
 *   "An array of calendar day objects." Whether `endDate` is included is not said: the adapter asks
 *   for the night after the last it wants, so either reading answers every night, and keeps only
 *   those. The fake includes it, as the documented month example (09-01 to 09-30) suggests.
 * - Day fields: `date`, `isAvailable` ("used to block/unblock single unit listings"), `status`, `price`
 *   (float), `minimumStay`, `maximumStay`, `closedOnArrival`, `closedOnDeparture`, and for multi-unit
 *   listings only `countAvailableUnits` ("How many units of this unit type exist"),
 *   `availableUnitsToSell` ("How many units are left (available) to sell") and `countBlockedUnits`
 *   (units a person blocked: not for sale, so not capacity); `reservations` only with
 *   `includeResources=1` ("the reservations will be always an empty array [] " otherwise).
 * - Statuses: `available`; `blocked`; `mblocked` (deprecated); `hardBlock`; `reserved` "blocked by
 *   reservation"; `pending` "has pending reservation"; `mreserved` (deprecated).
 * - Booleans "should be considered as integer 0 or 1 value".
 * - `POST https://api.hostaway.com/v1/listings/{listingId}/calendar/priceDetails` with `startingDate`
 *   ("Arrival date"), `endingDate` ("Departure date"), `numberOfGuests` and `version: 2`; it answers
 *   `{ "totalPrice", "components": [{ "type": "price" | "tax" | "fee" | "discount", "name", "total", … }] }`.
 *   A discount is written negative (the documented `monthlyDiscount`: `"value": -31500, "total":
 *   -31500`), and each component carries `isIncludedInTotalPrice` and `isDeleted` (0 or 1).
 *   Its own limit: "400 requests per 10 seconds, per account".
 */

export type CalendarStatus = "available" | "blocked" | "reserved" | "pending";

/** One calendar day as the fake answers it, in the documented shape. */
export function calendarDay(d: {
  readonly id: number;
  readonly date: string;
  readonly status: CalendarStatus;
  readonly price: number;
  readonly minimumStay: number;
  readonly multi?:
    | { readonly units: number; readonly left: number; readonly pending: number; readonly blocked: number }
    | undefined;
  readonly reservations: readonly unknown[];
}) {
  return {
    id: d.id,
    date: d.date,
    isAvailable: d.status === "available" ? 1 : 0,
    isProcessed: 1,
    status: d.status,
    price: d.price,
    minimumStay: d.minimumStay,
    maximumStay: 1125,
    closedOnArrival: null,
    closedOnDeparture: null,
    note: null,
    countAvailableUnits: d.multi ? d.multi.units : null,
    availableUnitsToSell: d.multi ? d.multi.left : null,
    countPendingUnits: d.multi ? d.multi.pending : null,
    countBlockingReservations: null,
    countBlockedUnits: d.multi ? d.multi.blocked : null,
    desiredUnitsToSell: null,
    reservations: d.reservations,
  };
}

/**
 * The price details answer for a stay: nights at their prices, a weekly discount from seven nights on
 * (with one taken off since, deleted), the cleaning fee, nothing else.
 */
export function priceDetails(nights: readonly number[], cleaningFee: number | null, weeklyOff = 0) {
  const base = nights.reduce((a, n) => a + n, 0);
  const off = nights.length >= 7 && weeklyOff > 0 ? Math.round(base * weeklyOff * 100) / 100 : 0;
  const components = [
    { type: "price", name: "baseRate", title: "Base rate", value: base, total: base, isIncludedInTotalPrice: 1 },
    ...(off
      ? [
          {
            type: "discount",
            name: "weeklyDiscount",
            title: "Weekly discount",
            value: -off,
            total: -off,
            isIncludedInTotalPrice: 1,
            isDeleted: 0,
          },
          {
            type: "discount",
            name: "lastMinuteDiscount",
            title: "Last-minute discount",
            value: -50,
            total: -50,
            isIncludedInTotalPrice: 1,
            isDeleted: 1,
          },
        ]
      : []),
    ...(cleaningFee
      ? [
          {
            type: "fee",
            name: "cleaningFee",
            title: "Cleaning fee",
            value: cleaningFee,
            total: cleaningFee,
            isIncludedInTotalPrice: 1,
          },
        ]
      : []),
  ];
  return {
    totalPrice: Math.round((base - off + (cleaningFee ?? 0)) * 100) / 100,
    originalTotalPrice: 0,
    selectedComponentsAmount: 0,
    components,
    extraComponents: [],
    selectedComponents: [],
  };
}
