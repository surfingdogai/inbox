/**
 * Cloudbeds answers for the Cloudbeds connector's tests (ADR-033 §8.4), in the shapes its developer
 * documentation gives, read 20 October 2026 (saved copies in the build's notes, never fetched with a key):
 *
 * - partner path and evaluation: https://developers.cloudbeds.com/docs/getting-started-as-a-partner-in-5-steps
 * - keys delivered on connecting (`grant_type=urn:ietf:params:oauth:grant-type:api-key`, a `cbat_` key,
 *   a code valid 10 minutes, used once):
 *   https://developers.cloudbeds.com/docs/api-keys-authentication-guide-for-technology-partners
 * - a property's own key (`x-api-key`, kept while used every 30 days):
 *   https://developers.cloudbeds.com/docs/quickstart-guide-api-authentication-for-property-level-users
 * - the consent page and its state: https://developers.cloudbeds.com/docs/alternative-oauth-20-authentication-method,
 *   https://developers.cloudbeds.com/docs/user-authorization-flow-options
 * - webhooks, their events and payloads, retries: https://developers.cloudbeds.com/docs/webhooks-1
 * - reference (v1.3): https://developers.cloudbeds.com/reference/get_gethotels-2,
 *   https://developers.cloudbeds.com/reference/get_gethoteldetails-2,
 *   https://developers.cloudbeds.com/reference/get_getroomtypes-2,
 *   https://developers.cloudbeds.com/reference/get_getrooms-2,
 *   https://developers.cloudbeds.com/reference/get_getrateplans-2,
 *   https://developers.cloudbeds.com/reference/get_getreservations-2,
 *   https://developers.cloudbeds.com/reference/get_getreservation-2,
 *   https://developers.cloudbeds.com/reference/post_postreservation-2,
 *   https://developers.cloudbeds.com/reference/put_putreservation-2,
 *   https://developers.cloudbeds.com/reference/post_postwebhook-2
 *
 * The property is made up: Riad Zellige Rouge in Marrakech (MAD, Africa/Casablanca), a room and two
 * suites around a patio. Every id, key and code is made up.
 */

const fake = (...parts: string[]) => parts.join("");
export const CLIENT = {
  clientId: "fake_riad_client",
  clientSecret: fake("fake", "-cloudbeds-", "client-secret-0123456789"),
};
export const AUTH_CODE = fake("fake", "-cloudbeds-", "authorization-code");
export const API_KEY = fake("cbat", "_", "FAKEfakeFAKEfakeFAKE0123456789");
export const OWN_KEY = fake("cbat", "_", "FAKEownOWNownOWNown9876543210");

export const PROPERTY = {
  propertyID: "48213",
  organizationID: "9071",
  propertyName: "Riad Zellige Rouge",
  propertyTimezone: "Africa/Casablanca",
  propertyCurrency: [{ currencyCode: "MAD", currencySymbol: "DH", currencyPosition: "after" }],
  propertyEmail: "bonjour@riad-zellige.example",
};

export const ATLAS = { roomTypeID: "103981", roomTypeName: "Chambre Atlas", maxGuests: 2, rooms: 1 };
export const PATIO = { roomTypeID: "103982", roomTypeName: "Suite Patio", maxGuests: 4, rooms: 2 };

export const RATE_ATLAS = {
  rateID: "R-ATLAS-STD",
  ratePlanID: "RP-STD",
  ratePlanNamePublic: "Standard",
  roomTypeID: ATLAS.roomTypeID,
};
export const RATE_PATIO = {
  rateID: "R-PATIO-STD",
  ratePlanID: "RP-STD",
  ratePlanNamePublic: "Standard",
  roomTypeID: PATIO.roomTypeID,
};
/** A promotion with a code: never offered through the inbox. */
export const RATE_PROMO = {
  rateID: "R-ATLAS-PROMO",
  ratePlanID: "RP-PROMO",
  ratePlanNamePublic: "Spring",
  roomTypeID: ATLAS.roomTypeID,
  promoCode: "SPRING",
};

/** Nightly rates in MAD, as Cloudbeds gives them: decimal dirhams. */
export const PRICES: Readonly<Record<string, number>> = { [ATLAS.roomTypeID]: 950, [PATIO.roomTypeID]: 1450.5 };

/** A delivery as Cloudbeds sends one (its events reference): ids, dates and spellings as there. */
export function webhookBody(
  reservationId: string,
  event = "reservation/status_changed",
  propertyId = PROPERTY.propertyID,
): string {
  return event === "reservation/dates_changed"
    ? JSON.stringify({
        version: "1.0",
        reservationId,
        subReservations: [{ id: reservationId, startDate: "2030-01-01", endDate: "2030-01-02" }],
        timestamp: 1_801_758_157.431234,
        event,
        propertyId: Number(propertyId),
        propertyId_str: propertyId,
        startDate: "2030-01-01",
        endDate: "2030-01-02",
      })
    : JSON.stringify({
        version: "1.0",
        timestamp: 1_801_758_157.431234,
        event,
        propertyID: Number(propertyId),
        propertyID_str: propertyId,
        reservationID: reservationId,
        status: "confirmed",
      });
}
