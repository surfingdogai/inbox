/**
 * Smoobu's webhooks, its webhook management API and its rate limit, as documented. Source:
 * <https://docs.smoobu.com/>, sections "Webhooks", "Webhook Management API", "Delivery", "Rate
 * Limit" and "Change Log", read 20 October 2026.
 *
 * Excerpts the adapter is built from:
 * - A delivery is `{ "action": …, "user": 7, "data": { … } }`. Actions shown: `updateRates` (data:
 *   apartment id → date → `{ price, min_length_of_stay, available }`), `newReservation` ("similar for
 *   updateReservation, cancelReservation, and deleteReservation", data: the booking object, with
 *   `firstname`, `lastname`, `assistant-notice` and `commission-included` besides), `onlineCheckInUpdate`
 *   (`{ "bookingId": 234 }`), `priceElementCreated`, `priceElementUpdated`, `priceElementDeleted` and
 *   `newMessage` (`{ "id", "sender", "booking": { "id" } }`).
 * - "`/api/users/webhooks` lets you manage the webhook URLs that receive outbound events for a Smoobu
 *   user. Every registered URL receives all outbound webhook events for that user — there is no
 *   per-event subscription field." `POST` `{ "webhookUrl": "https://…" }` ("HTTPS callback URL, maximum
 *   2048 characters") → 201 `{ "id": 901, "webhookUrl": …, "createdAt": "2026-04-01T12:00:00Z" }`;
 *   422 `{ "validation_messages": { "webhookUrl": { "already_registered": "Webhook URL is already
 *   registered" } } }`; 409 "Webhook URL is already registered by another caller". `GET` (list, one),
 *   `PATCH` ("Send only `webhookUrl`"), `DELETE` → 204.
 * - No signature, secret or header of Smoobu's own on a delivery is documented.
 * - "Smoobu allows up to 700 request per minute. If this limit exceeded, you will receive HTTP
 *   response with status code `429`." Headers: `X-RateLimit-Limit` (int, "Number of requests allowed in
 *   1 minute window"), `X-RateLimit-Remaining` (int), `X-RateLimit-Retry-After` (int, "Current window
 *   expire time in Unix timestamp. Requests can be made after this time if rate limit exceeded.").
 *   Change log, 17 September 2026: "Rate limit change from 1000 requests per minute to 700."
 */

/** The documented rate-limit headers for a window that ends at `windowEndMs`, served at `nowMs`. */
export function rateLimitHeaders(limit: number, remaining: number, windowEndMs: number, nowMs: number) {
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(Math.max(0, remaining)),
    "X-RateLimit-Retry-After": String(Math.floor(windowEndMs / 1000)),
    date: new Date(nowMs).toUTCString(),
  };
}

/** A delivery's body, as Smoobu sends it to every registered URL. */
export function deliveryBody(action: string, user: number, data: unknown): string {
  return JSON.stringify({ action, user, data });
}

/** The documented newMessage delivery: answered, never read. */
export function newMessage(user: number, bookingId: number): string {
  return deliveryBody("newMessage", user, { id: 1234, sender: "guest", booking: { id: bookingId } });
}

/** The documented onlineCheckInUpdate delivery: answered, never read. */
export function onlineCheckIn(user: number, bookingId: number): string {
  return deliveryBody("onlineCheckInUpdate", user, { bookingId });
}

/** The documented priceElementCreated delivery: answered, never read. */
export function priceElementCreated(user: number, bookingId: number): string {
  return deliveryBody("priceElementCreated", user, {
    id: 1234,
    type: "basePrice",
    name: "Base Price",
    amount: 1,
    quantity: 2300,
    tax: 7.0,
    currencyCode: "EUR|€",
    sortOrder: 51,
    priceIncludedInId: 1,
    booking: { id: bookingId },
  });
}

/** The documented updateRates delivery for one apartment's nights. */
export function updateRates(user: number, apartmentId: number, nights: readonly string[], price: number): string {
  const days: Record<string, unknown> = {};
  for (const n of nights) days[n] = { price, min_length_of_stay: null, available: 1 };
  return deliveryBody("updateRates", user, { [String(apartmentId)]: days });
}

export const ALREADY_REGISTERED = {
  status: 422,
  title: "Bad Request",
  detail: "Failed validation",
  validation_messages: { webhookUrl: { already_registered: "Webhook URL is already registered" } },
};

export const REGISTERED_ELSEWHERE = {
  status: 409,
  title: "Conflict",
  detail: "Webhook URL is already registered by another caller",
};

export const WEBHOOK_NOT_FOUND = { status: 404, title: "Not Found", detail: "Webhook not found" };
