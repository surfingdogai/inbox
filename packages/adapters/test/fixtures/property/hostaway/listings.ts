/**
 * Hostaway listings for the fake, in the documented Listing object's shape. Source:
 * <https://api.hostaway.com/documentation>, sections "Listing object", "Retrieve a listings list" and
 * "Standard Response", read 20 October 2026.
 *
 * Excerpts the adapter is built from:
 * - `GET https://api.hostaway.com/v1/listings` with `limit`, `offset`, `includeResources` ("default is
 *   0") and `specialStatus[]` ("?specialStatus[]=active returns only active (non-archived) listings").
 * - The envelope: `{ "status": "success", "result": …, "limit", "offset", "count", "page", "totalPages" }`.
 * - Listing fields read: `id`, `name`, `internalListingName`, `city`, `personCapacity`,
 *   `maxChildrenAllowed`, `currencyCode`, `timeZoneName`, `specialStatus`, `price` (a float, the
 *   listing's currency). The object also carries a door code, Wi-Fi password and contact details:
 *   the adapter keeps none of them.
 * - "ListingUnits" exist for multi-unit listings; this inbox sells each listing as one unit.
 *
 * Four places, each its own account: Harbourlight Apartments (Hobart, AUD, Australia/Hobart, southern
 * daylight saving), a pousada in Paraty (BRL, America/Sao_Paulo), a guesthouse in Reykjavík (ISK,
 * Atlantic/Reykjavik, no minor unit), and pods in Osaka with a room in Tokyo (JPY, Asia/Tokyo, two
 * towns in one zone, one listing of three units). Names, ids and prices are made up.
 */

export interface FakeListing {
  readonly id: number;
  readonly name: string;
  readonly internalListingName: string | null;
  readonly city: string;
  readonly countryCode: string;
  readonly currencyCode: string | null;
  readonly timeZoneName: string | null;
  readonly personCapacity: number;
  readonly maxChildrenAllowed: number | null;
  /** The nightly price, in the listing's currency, as Hostaway writes it (a float). */
  readonly price: number;
  readonly cleaningFee: number | null;
  readonly minNights: number;
  readonly specialStatus: "archived" | null;
  /** A multi-unit listing's units (the calendar's `countAvailableUnits`); absent for one unit. */
  readonly units?: number;
  /** The part taken off a stay of seven nights or more, as the price calculation's `discount` component. */
  readonly weeklyOff?: number;
}

const listing = (l: Partial<FakeListing> & Pick<FakeListing, "id" | "name" | "city">): FakeListing => ({
  internalListingName: null,
  countryCode: "",
  currencyCode: null,
  timeZoneName: null,
  personCapacity: 2,
  maxChildrenAllowed: null,
  price: 100,
  cleaningFee: null,
  minNights: 1,
  specialStatus: null,
  ...l,
});

export const HARBOURLIGHT: readonly FakeListing[] = [
  listing({
    id: 310021,
    name: "Harbour View Studio",
    internalListingName: "HL-1",
    city: "Hobart",
    countryCode: "AU",
    currencyCode: "AUD",
    timeZoneName: "Australia/Hobart",
    personCapacity: 2,
    price: 245.5,
    cleaningFee: 60,
  }),
  listing({
    id: 310022,
    name: "Wharf Loft",
    internalListingName: "HL-2",
    city: "Hobart",
    countryCode: "AU",
    currencyCode: "AUD",
    timeZoneName: "Australia/Hobart",
    personCapacity: 3,
    maxChildrenAllowed: 1,
    price: 289,
    cleaningFee: 60,
    minNights: 2,
  }),
  listing({
    id: 310023,
    name: "Salamanca Two-Bedroom",
    internalListingName: "HL-3",
    city: "Hobart",
    countryCode: "AU",
    currencyCode: "AUD",
    timeZoneName: "Australia/Hobart",
    personCapacity: 5,
    maxChildrenAllowed: 3,
    price: 412.75,
    cleaningFee: 90,
  }),
  // Archived: never offered, never mapped.
  listing({
    id: 310024,
    name: "Signal Station Cottage",
    city: "Hobart",
    countryCode: "AU",
    currencyCode: "AUD",
    timeZoneName: "Australia/Hobart",
    specialStatus: "archived",
  }),
];

export const PARATY: readonly FakeListing[] = [
  listing({
    id: 420101,
    name: "Suíte Jardim",
    internalListingName: "Jardim",
    city: "Paraty",
    countryCode: "BR",
    currencyCode: "BRL",
    timeZoneName: "America/Sao_Paulo",
    personCapacity: 2,
    price: 480,
    cleaningFee: 80,
    weeklyOff: 0.1,
  }),
  listing({
    id: 420102,
    name: "Suíte do Mar",
    internalListingName: "Mar",
    city: "Paraty",
    countryCode: "BR",
    currencyCode: "BRL",
    timeZoneName: "America/Sao_Paulo",
    personCapacity: 3,
    maxChildrenAllowed: 1,
    price: 620.5,
    cleaningFee: 80,
  }),
];

export const REYKJAVIK: readonly FakeListing[] = [
  listing({
    id: 530301,
    name: "Twin Room",
    internalListingName: "Ljósá 1",
    city: "Reykjavík",
    countryCode: "IS",
    currencyCode: "ISK",
    timeZoneName: "Atlantic/Reykjavik",
    personCapacity: 2,
    price: 24900,
    cleaningFee: 4500,
  }),
  listing({
    id: 530302,
    name: "Attic Double",
    internalListingName: "Ljósá 2",
    city: "Reykjavík",
    countryCode: "IS",
    currencyCode: "ISK",
    timeZoneName: "Atlantic/Reykjavik",
    personCapacity: 2,
    price: 27500,
    cleaningFee: 4500,
  }),
];

/**
 * One account in two towns of one currency and one zone: two properties, by town. The Osaka pods are
 * one multi-unit listing of three (`countAvailableUnits`), which this inbox sells one at a time.
 */
export const JAPAN: readonly FakeListing[] = [
  listing({
    id: 640501,
    name: "Pod Room",
    internalListingName: "Namba pods",
    city: "Osaka",
    countryCode: "JP",
    currencyCode: "JPY",
    timeZoneName: "Asia/Tokyo",
    personCapacity: 1,
    price: 6_800,
    units: 3,
  }),
  listing({
    id: 640502,
    name: "Twin Pod",
    city: "Osaka",
    countryCode: "JP",
    currencyCode: "JPY",
    timeZoneName: "Asia/Tokyo",
    personCapacity: 2,
    price: 11_200,
  }),
  listing({
    id: 640601,
    name: "Garden Tatami Room",
    city: "Tokyo",
    countryCode: "JP",
    currencyCode: "JPY",
    timeZoneName: "Asia/Tokyo",
    personCapacity: 3,
    price: 21_500,
  }),
];

/**
 * One account that runs places in two zones, and one listing with neither a currency nor a zone: the
 * listings become one property per currency, zone and town, and the one without them is left out.
 */
export const MIXED: readonly FakeListing[] = [
  ...HARBOURLIGHT.slice(0, 2),
  listing({
    id: 310030,
    name: "Byron Bay Shack",
    city: "Byron Bay",
    countryCode: "AU",
    currencyCode: "AUD",
    timeZoneName: "Australia/Sydney",
    price: 199,
  }),
  listing({ id: 310031, name: "Unfinished draft", city: "Hobart" }),
];

/** The Listing object as Hostaway answers it: the fields above, and some the adapter must not keep. */
export function listingObject(l: FakeListing) {
  return {
    id: l.id,
    propertyTypeId: 1,
    name: l.name,
    externalListingName: l.name,
    internalListingName: l.internalListingName,
    description: `${l.name}, ${l.city}.`,
    city: l.city,
    countryCode: l.countryCode,
    price: l.price,
    personCapacity: l.personCapacity,
    maxChildrenAllowed: l.maxChildrenAllowed,
    cleaningFee: l.cleaningFee,
    minNights: l.minNights,
    maxNights: 1125,
    currencyCode: l.currencyCode,
    timeZoneName: l.timeZoneName,
    specialStatus: l.specialStatus,
    // Never read, never kept.
    doorSecurityCode: "0000",
    wifiUsername: "guest",
    wifiPassword: "not-a-real-password",
    contactEmail: "host@example.org",
    listingAmenities: [],
    listingBedTypes: [],
    listingImages: [],
  };
}
