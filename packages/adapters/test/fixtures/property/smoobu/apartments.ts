/**
 * Smoobu apartments and their rates, in the documented shapes. Source: <https://docs.smoobu.com/>,
 * sections "Get Apartment-IDs", "Get Apartment", "Get Rates", "Rate Limit" and "Change Log", read
 * 20 October 2026.
 *
 * Excerpts the adapter is built from:
 * - `GET https://login.smoobu.com/api/apartments` → `{ "apartments": [ { "id": 1, "name": "Property 1" } ] }`
 *   ("With this Call you can get all your properties").
 * - `GET https://login.smoobu.com/api/apartments/<apartmentId>` → `location` (`street`, `zip`, `city`,
 *   `country`, `latitude`, `longitude`), `timeZone` ("Time zone of the apartment. Can be `null` if not
 *   set."), `rooms` (`maxOccupancy` "max number of persons", `bedrooms`, `bathrooms`, `doubleBeds`,
 *   `singleBeds`, `sofaBeds`, `couches`, `childBeds`, `queenSizeBeds`, `kingSizeBeds`), `equipments`,
 *   `currency` ("Currency of the user e.g. ("EUR")"), `price` (`minimal`, `maximal`, strings), `type`.
 * - `GET https://login.smoobu.com/api/rates?apartments[]=398&apartments[]=401&start_date=2019-01-15&end_date=2019-01-30`
 *   → `{ "data": { "398": { "2019-01-15": { "price": 444, "min_length_of_stay": 2, "available": 1 }, … } } }`:
 *   the example answers its `end_date` too. `price` "price of this date. Null if there is no price";
 *   `min_length_of_stay` "Null if there is no value"; `available` "say how often the apartment is
 *   available 0 for not available". An apartment the user does not have answers 500 with
 *   `{ "status": 500, "title": "Internal Server Error", "detail": "Apartment not found for this user" }`.
 *
 * Three places, each its own account, and one account with apartments in two towns: Haveli Rang
 * (Jaipur, INR, Asia/Kolkata, UTC+5:30), Kijiwe Lodge near Arusha (TZS, Africa/Dar_es_Salaam), Gîte du
 * Cap-Blanc (Québec City, CAD, America/Toronto, daylight saving), and two towns in Tanzania with an
 * apartment that has no currency yet and one with no time zone. Names, ids and prices are made up.
 */

export interface FakeApartment {
  readonly id: number;
  readonly name: string;
  readonly city: string;
  readonly country: string;
  readonly currency: string | null;
  readonly timeZone: string | null;
  readonly maxOccupancy: number;
  readonly beds: Readonly<
    Partial<Record<"doubleBeds" | "singleBeds" | "queenSizeBeds" | "kingSizeBeds" | "sofaBeds" | "childBeds", number>>
  >;
  /** The nightly price, in the user's currency, as Smoobu writes it (a double); null for none. */
  readonly price: number | null;
  readonly minStay: number | null;
  /** How often it is available on a free night (`available`): more than one for a grouped apartment. */
  readonly available?: number;
  /** Apartments a booking of this one blocks too (`related`), as grouped apartments are. */
  readonly group?: readonly number[];
}

const apartment = (a: Partial<FakeApartment> & Pick<FakeApartment, "id" | "name" | "city">): FakeApartment => ({
  country: "",
  currency: null,
  timeZone: null,
  maxOccupancy: 2,
  beds: {},
  price: 100,
  minStay: null,
  ...a,
});

export const HAVELI_RANG: readonly FakeApartment[] = [
  apartment({
    id: 52011,
    name: "Jharokha Room",
    city: "Jaipur",
    country: "India",
    currency: "INR",
    timeZone: "Asia/Kolkata",
    maxOccupancy: 2,
    beds: { doubleBeds: 1 },
    price: 6500.5,
    minStay: null,
  }),
  apartment({
    id: 52012,
    name: "Zenana Suite",
    city: "Jaipur",
    country: "India",
    currency: "INR",
    timeZone: "Asia/Kolkata",
    maxOccupancy: 3,
    beds: { kingSizeBeds: 1, singleBeds: 1 },
    price: 11800,
    minStay: 2,
  }),
  apartment({
    id: 52013,
    name: "Courtyard Twin",
    city: "Jaipur",
    country: "India",
    currency: "INR",
    timeZone: "Asia/Kolkata",
    maxOccupancy: 2,
    beds: { singleBeds: 2 },
    price: 5200,
    minStay: null,
  }),
];

export const KIJIWE_LODGE: readonly FakeApartment[] = [
  apartment({
    id: 61001,
    name: "Banda Moja",
    city: "Arusha",
    country: "Tanzania",
    currency: "TZS",
    timeZone: "Africa/Dar_es_Salaam",
    maxOccupancy: 2,
    beds: { doubleBeds: 1 },
    price: 185000,
    minStay: null,
  }),
  apartment({
    id: 61002,
    name: "Family Banda",
    city: "Arusha",
    country: "Tanzania",
    currency: "TZS",
    timeZone: "Africa/Dar_es_Salaam",
    maxOccupancy: 5,
    beds: { doubleBeds: 1, singleBeds: 2, childBeds: 1 },
    price: 420000,
    minStay: 2,
  }),
];

export const CAP_BLANC: readonly FakeApartment[] = [
  apartment({
    id: 70501,
    name: "Chambre Champlain",
    city: "Québec",
    country: "Canada",
    currency: "CAD",
    timeZone: "America/Toronto",
    maxOccupancy: 2,
    beds: { queenSizeBeds: 1 },
    price: 189,
    minStay: null,
  }),
  apartment({
    id: 70502,
    name: "Chambre Saint-Laurent",
    city: "Québec",
    country: "Canada",
    currency: "CAD",
    timeZone: "America/Toronto",
    maxOccupancy: 2,
    beds: { doubleBeds: 1, sofaBeds: 1 },
    price: 214.5,
    minStay: null,
  }),
];

/** Two towns, one apartment without a currency, and one without a time zone. */
export const TWO_TOWNS: readonly FakeApartment[] = [
  apartment({ id: 80010, name: "Moshi Loft", city: "Moshi", currency: "TZS", timeZone: "Africa/Dar_es_Salaam" }),
  apartment({
    id: 80003,
    name: "Arusha Garden Flat",
    city: "Arusha",
    currency: "TZS",
    timeZone: "Africa/Dar_es_Salaam",
  }),
  apartment({ id: 80004, name: "Arusha Rooftop", city: "arusha ", currency: "TZS", timeZone: "Africa/Dar_es_Salaam" }),
  apartment({ id: 80020, name: "Unfinished Cottage", city: "Moshi", currency: null, timeZone: "Africa/Dar_es_Salaam" }),
  apartment({ id: 80030, name: "Kilimanjaro View", city: "Moshi", currency: "TZS", timeZone: null }),
];

/** The documented Get Apartment object for a fake apartment. */
export function apartmentObject(a: FakeApartment): Record<string, unknown> {
  return {
    location: { street: "", zip: "", city: a.city, country: a.country, latitude: "0", longitude: "0" },
    timeZone: a.timeZone,
    rooms: {
      maxOccupancy: a.maxOccupancy,
      bedrooms: 1,
      bathrooms: 1,
      doubleBeds: a.beds.doubleBeds ?? null,
      singleBeds: a.beds.singleBeds ?? null,
      sofaBeds: a.beds.sofaBeds ?? null,
      couches: null,
      childBeds: a.beds.childBeds ?? null,
      queenSizeBeds: a.beds.queenSizeBeds ?? null,
      kingSizeBeds: a.beds.kingSizeBeds ?? null,
    },
    equipments: ["Internet", "Heating"],
    currency: a.currency,
    price: { minimal: a.price === null ? null : String(a.price), maximal: a.price === null ? null : String(a.price) },
    type: { id: 2, name: "Holiday rental" },
  };
}

/** The documented 500 for an apartment the user does not have. */
export const APARTMENT_NOT_FOUND = {
  status: 500,
  title: "Internal Server Error",
  detail: "Apartment not found for this user",
};
