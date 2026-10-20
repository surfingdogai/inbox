/**
 * Beds24's booking webhook and its credit limits, as documented. Sources:
 * - https://beds24.com/api/v2/apiV2.yaml (saved copy: scratchpad ext-beds24/apiV2.yaml): path
 *   `Webhooks - bookings` ("Alpha - The webhook payload sent to your URL", "Configure under Settings ->
 *   Properties -> Access -> Booking Webhook"; body: timeStamp, booking.id, bookingGroup, masterId,
 *   propertyId, roomId, unitId, roomQty, offerId, status, arrival, departure…), the property's
 *   `webhooks` settings (version one / twoNoPersonalData / twoWithPersonalData; additionalData none /
 *   CVC / token / CVCAndToken; customHeader), and the response headers `X-FiveMinCreditLimit`,
 *   `X-FiveMinCreditLimit-ResetsIn` ("The number of seconds until this 5 minute period is over"),
 *   `X-FiveMinCreditLimit-Remaining` and `X-RequestCost`.
 * - https://wiki.beds24.com/index.php/API_V2.0: the headers spelled `x-five-min-limit-remaining`,
 *   `x-five-min-limit-resets-in` and `x-request-cost`; "by default 100 credits per 5 minutes"; errors
 *   "such as 429 or 'Usage limit exceeded in last 5 minutes'"; no signature is documented.
 * Values are made up for these tests.
 */

export function bookingWebhook(b: {
  id: number;
  propertyId: number;
  roomId: number;
  arrival: string;
  departure: string;
  status?: string;
  timeStamp?: string;
}) {
  return {
    timeStamp: b.timeStamp ?? "2026-10-20T09:14:03Z",
    booking: {
      id: b.id,
      bookingGroup: null,
      masterId: null,
      propertyId: b.propertyId,
      roomId: b.roomId,
      unitId: 1,
      roomQty: 1,
      offerId: 1,
      status: b.status ?? "confirmed",
      subStatus: "none",
      arrival: b.arrival,
      departure: b.departure,
      numAdult: 2,
      numChild: 0,
      country2: "JP",
      comments: "",
      notes: "",
      flagColor: "",
      flagText: "",
      statusCode: 0,
    },
  };
}

/** The credit headers, spelled as the wiki spells them. */
export const wikiHeaders = {
  "x-five-min-limit-remaining": "71",
  "x-five-min-limit-resets-in": "188",
  "x-request-cost": "2",
};

/** The same, spelled as the OpenAPI file spells them. */
export const yamlHeaders = {
  "X-FiveMinCreditLimit": "100",
  "X-FiveMinCreditLimit-Remaining": "71",
  "X-FiveMinCreditLimit-ResetsIn": "188",
  "X-RequestCost": "2",
};

/** The wiki's words for credits spent. */
export const usageLimitAnswer = {
  success: false,
  type: "error",
  code: 429,
  error: "Usage limit exceeded in last 5 minutes",
};
