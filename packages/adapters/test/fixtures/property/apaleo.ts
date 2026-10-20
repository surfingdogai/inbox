/**
 * apaleo answers for the apaleo connector's tests (ADR-033 §8.4), in the shapes apaleo's public OpenAPI
 * files define, read 20 October 2026 (saved copies in the build's notes, fetched without credentials):
 *
 * - booking-v1: https://api.apaleo.com/swagger/booking-v1/swagger.json — `POST /booking/v1/bookings`
 *   (`CreateBookingModel`, the `Idempotency-Key` header: "Keys expire after 24 hours"; answer
 *   `BookingCreatedModel`), `GET /booking/v1/reservations` (`externalCode`, `bookingId`),
 *   `GET|PATCH /booking/v1/reservations/{id}`, `PUT /booking/v1/reservation-actions/{id}/amend|cancel`,
 *   `GET /booking/v1/offers` (`StayOffersModel`), 422 `MessageItemCollection`
 * - inventory-v1: https://api.apaleo.com/swagger/inventory-v1/swagger.json — properties, unit groups
 * - availability-v1: https://api.apaleo.com/swagger/availability-v1/swagger.json — unit-group time slices
 * - rateplan-v1: https://api.apaleo.com/swagger/rateplan-v1/swagger.json — rate plans, their rates
 * - account-v1: https://api.apaleo.com/swagger/account-v1/swagger.json — the current account
 * - webhook-v1: https://webhook.apaleo.com/swagger/webhook-v1/swagger.json — subscriptions
 * - OAuth: https://apaleo.dev/guides/oauth-connection/auth-code-grant.html,
 *   https://apaleo.dev/guides/oauth-connection/refresh-token.html
 * - webhook deliveries: https://apaleo.dev/guides/webhook/webhooks-payload.html
 *
 * The property is made up: Whio Lodge, a lodge in Queenstown (NZD, Pacific/Auckland), east of the
 * date line, so its date is a day ahead of UTC for part of every day. Every id, key and code is made up.
 */

const fake = (...parts: string[]) => parts.join("");
export const CLIENT = {
  clientId: "WHIO-CONNECT-FAKE",
  clientSecret: fake("fake", "-apaleo-", "connect-secret-0123456789"),
};
export const AUTH_CODE = fake("fake", "-apaleo-", "authorization-code");
export const OWN_CLIENT = {
  client_id: "WHIO-SIMPLE-FAKE",
  client_secret: fake("fake", "-apaleo-", "simple-secret-9876543210"),
};

export const ACCOUNT = { code: "WHIO", name: "Whio Lodge Ltd" };
export const PROPERTY = {
  id: "WHIO",
  code: "WHIO",
  name: "Whio Lodge Queenstown",
  timeZone: "Pacific/Auckland",
  currencyCode: "NZD",
};

export const LAKE = { id: "WHIO-LKV", code: "LKV", name: "Lake view double", memberCount: 1, maxPersons: 2 };
export const BUNK = { id: "WHIO-BNK", code: "BNK", name: "Bunk room", memberCount: 3, maxPersons: 4 };

/** Sold direct with a 6 pm hold: what the inbox offers. */
export const FLEX_LAKE = { id: "WHIO-FLEX-LKV", code: "FLEX", name: "Flexible", unitGroup: LAKE.id };
export const FLEX_BUNK = { id: "WHIO-FLEX-BNK", code: "FLEX", name: "Flexible", unitGroup: BUNK.id };
/** Needs a card as its guarantee: never offered through the inbox. */
export const CARD_LAKE = { id: "WHIO-CC-LKV", code: "CC", name: "Card guaranteed", unitGroup: LAKE.id };

/** Nightly gross prices in NZD. */
export const PRICES: Readonly<Record<string, number>> = { [LAKE.id]: 245, [BUNK.id]: 120.5 };

/** A delivery as apaleo sends one (`topic`, `type`, `id`, `accountId`, `propertyId`, `data.entityId`). */
export function webhookBody(
  entityId: string,
  opts: { accountId?: string; topic?: string; type?: string } = {},
): string {
  return JSON.stringify({
    topic: opts.topic ?? "Reservation",
    type: opts.type ?? "Changed",
    id: `evt-${entityId}-${opts.type ?? "Changed"}`,
    accountId: opts.accountId ?? ACCOUNT.code,
    propertyId: PROPERTY.id,
    data: { entityId },
    clientId: "some-other-app",
    timestamp: 1_800_000_000,
  });
}
