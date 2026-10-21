/**
 * Three places to stay as Beds24 would hold them. Sources:
 * - https://beds24.com/api/v2/apiV2.yaml (saved copy: scratchpad ext-beds24/apiV2.yaml): `GET /properties`
 *   (query `id`, `includeAllRooms`, `includeOffers`, `includePriceRules`; answer `data` of schema
 *   `property`: id, name,
 *   currency, roomTypes of schema `room`: id, name, qty, maxPeople, maxAdult, maxChildren, offers of
 *   schema `offer`: offerId, name, enable…), and the calendar's per-day `price1`…`price16`; a room's
 *   `cleaningFee`, `taxPercentage`, `taxPerson` and `securityDeposit`, and a property's `upsellItems`
 *   (query `includeUpsellItems`; index, enable, type of notUsed / optional… / obligatory /
 *   obligatoryCleaning / obligatoryTax / obligatoryPercentTax / obligatoryPercent, amount, per, period);
 *   a room's `priceRules` (schema `priceRules`: id 1–16, name, priceFor { type perPerson / maxCapacity /
 *   upToPerson, upToPersonValue }, extraPerson, extraChild, minimumStay, maximumStay, offer,
 *   minDaysUntilCheckin, maxDaysUntilCheckin, priceLinking { roomId, priceId, offsetMultiplier,
 *   offsetAmount }).
 * - https://wiki.beds24.com/index.php/API_V2.0: "A room can have up to 16 prices"; inventory calls
 *   "will only work if a price is set for the property or room".
 * The properties are made up and rotate the world: a ryokan in Kyoto (JPY, no decimals), an inn in
 * Oaxaca (MXN), a guesthouse in Cusco (PEN) with a shared dormitory that has no price yet, a riad in
 * Marrakesh (MAD) whose room carries a cleaning fee and a tax and whose property adds an obligatory
 * tourist tax, a guesthouse in Amman (JOD, three decimals), and a hostel in Tbilisi (GEL) whose daily
 * prices are per person, for two of three guests with a charge per extra one, and for a week or more.
 */

/** One daily price's rule, as `includePriceRules` gives it. */
export interface FixtureRule {
  readonly id: number;
  readonly priceFor: {
    readonly type: "perPerson" | "maxCapacity" | "upToPerson";
    readonly upToPersonValue: number | null;
  };
  readonly extraPerson?: number;
  readonly extraChild?: number;
  readonly minimumStay?: number;
  readonly maximumStay?: number;
  readonly offer?: number;
  readonly minDaysUntilCheckin?: number;
  readonly maxDaysUntilCheckin?: number;
}

export interface FixtureRoom {
  readonly id: number;
  readonly name: string;
  readonly qty: number;
  readonly maxPeople: number;
  readonly maxAdult: number;
  readonly maxChildren: number;
  /** Daily prices on every night, by calendar slot, in the property's own decimals. */
  readonly prices: Readonly<Record<string, number>>;
  readonly offers: readonly { readonly offerId: number; readonly name: string; readonly enable: string }[];
  /** Each daily price's rule; absent, every price is the whole room's, sold by the offer of its number. */
  readonly rules?: readonly FixtureRule[];
  /** Charges besides the nightly price, as the room schema has them. */
  readonly fees?: {
    readonly cleaningFee?: number;
    readonly taxPercentage?: number;
    readonly taxPerson?: number;
    readonly securityDeposit?: number;
  };
}

export interface FixtureProperty {
  readonly id: number;
  readonly name: string;
  readonly currency: string;
  readonly city: string;
  readonly country: string;
  readonly rooms: readonly FixtureRoom[];
  readonly upsellItems?: readonly {
    readonly index: number;
    readonly enable: boolean;
    readonly type: string;
    readonly amount: number;
    readonly per: string;
    readonly period: string;
  }[];
}

export const RYOKAN_HOSHI: FixtureProperty = {
  id: 241_501,
  name: "Ryokan Hoshi",
  currency: "JPY",
  city: "Kyoto",
  country: "JP",
  rooms: [
    {
      id: 512_001,
      name: "Japanese room, garden view",
      qty: 1,
      maxPeople: 2,
      maxAdult: 2,
      maxChildren: 0,
      prices: { price1: 25_800, price2: 23_200 },
      offers: [
        { offerId: 1, name: "With breakfast", enable: "onlyIfAvailable" },
        { offerId: 2, name: "Room only", enable: "onlyIfAvailable" },
      ],
    },
    {
      id: 512_002,
      name: "Family tatami suite",
      qty: 3,
      maxPeople: 5,
      maxAdult: 4,
      maxChildren: 3,
      prices: { price1: 38_000 },
      offers: [{ offerId: 1, name: "With breakfast", enable: "onlyIfAvailable" }],
    },
  ],
};

export const CASA_VENTANA: FixtureProperty = {
  id: 241_502,
  name: "Casa Ventana",
  currency: "MXN",
  city: "Oaxaca de Juárez",
  country: "MX",
  rooms: [
    {
      id: 512_011,
      name: "Habitación doble",
      qty: 4,
      maxPeople: 2,
      maxAdult: 2,
      maxChildren: 1,
      prices: { price1: 1_850 },
      offers: [{ offerId: 1, name: "Tarifa flexible", enable: "onlyIfAvailable" }],
    },
    {
      id: 512_012,
      name: "Suite con terraza",
      qty: 1,
      maxPeople: 3,
      maxAdult: 2,
      maxChildren: 1,
      prices: { price1: 2_900.5 },
      offers: [{ offerId: 1, name: "Tarifa flexible", enable: "onlyIfAvailable" }],
    },
  ],
};

export const INTI_WASI: FixtureProperty = {
  id: 241_503,
  name: "Hospedaje Inti Wasi",
  currency: "PEN",
  city: "Cusco",
  country: "PE",
  rooms: [
    {
      id: 512_021,
      name: "Matrimonial",
      qty: 2,
      maxPeople: 2,
      maxAdult: 2,
      maxChildren: 0,
      prices: { price1: 180 },
      offers: [{ offerId: 1, name: "Con desayuno", enable: "onlyIfAvailable" }],
    },
    {
      id: 512_022,
      name: "Familiar",
      qty: 1,
      maxPeople: 4,
      maxAdult: 2,
      maxChildren: 2,
      prices: { price1: 265.9 },
      offers: [{ offerId: 1, name: "Con desayuno", enable: "onlyIfAvailable" }],
    },
    {
      // No daily price set yet: Beds24's inventory calls answer nothing for it.
      id: 512_023,
      name: "Dormitorio compartido",
      qty: 6,
      maxPeople: 1,
      maxAdult: 1,
      maxChildren: 0,
      prices: {},
      offers: [],
    },
  ],
};

export const RIAD_ZITOUN: FixtureProperty = {
  id: 241_504,
  name: "Riad Zitoun",
  currency: "MAD",
  city: "Marrakesh",
  country: "MA",
  rooms: [
    {
      id: 512_031,
      name: "Chambre patio",
      qty: 3,
      maxPeople: 2,
      maxAdult: 2,
      maxChildren: 0,
      prices: { price1: 980 },
      offers: [{ offerId: 1, name: "Petit-déjeuner inclus", enable: "onlyIfAvailable" }],
      fees: { cleaningFee: 150, taxPercentage: 10 },
    },
    {
      id: 512_032,
      name: "Suite terrasse",
      qty: 1,
      maxPeople: 3,
      maxAdult: 2,
      maxChildren: 1,
      prices: { price1: 1_640.5 },
      offers: [{ offerId: 1, name: "Petit-déjeuner inclus", enable: "onlyIfAvailable" }],
    },
  ],
  upsellItems: [
    { index: 1, enable: true, type: "obligatoryTax", amount: 30, per: "person", period: "daily" },
    { index: 2, enable: true, type: "optional", amount: 250, per: "booking", period: "oneTime" },
  ],
};

export const BEIT_AMMAN: FixtureProperty = {
  id: 241_505,
  name: "Beit Jabal Amman",
  currency: "JOD",
  city: "Amman",
  country: "JO",
  rooms: [
    {
      id: 512_041,
      name: "Courtyard room",
      qty: 2,
      maxPeople: 2,
      maxAdult: 2,
      maxChildren: 0,
      prices: { price1: 45.125 },
      offers: [{ offerId: 1, name: "With breakfast", enable: "onlyIfAvailable" }],
    },
  ],
};

export const PROPERTIES = [RYOKAN_HOSHI, CASA_VENTANA, INTI_WASI, RIAD_ZITOUN, BEIT_AMMAN] as const;

/**
 * A hostel whose prices are mostly not the whole room's for a night: a dormitory bed priced per person,
 * a twin priced for two with a charge for a third and a price for the whole room besides, and a studio
 * priced for a week or more. Only the twin's whole-room price can be quoted from the cache.
 */
export const HOSTEL_TBILISI: FixtureProperty = {
  id: 241_506,
  name: "Old Town Hostel",
  currency: "GEL",
  city: "Tbilisi",
  country: "GE",
  rooms: [
    {
      id: 512_051,
      name: "Six-bed dormitory",
      qty: 1,
      maxPeople: 6,
      maxAdult: 6,
      maxChildren: 0,
      prices: { price1: 38 },
      offers: [{ offerId: 1, name: "Bed only", enable: "onlyIfAvailable" }],
      rules: [{ id: 1, priceFor: { type: "perPerson", upToPersonValue: null }, offer: 1 }],
    },
    {
      id: 512_052,
      name: "Twin room",
      qty: 2,
      maxPeople: 3,
      maxAdult: 3,
      maxChildren: 0,
      prices: { price1: 110, price2: 140 },
      offers: [
        { offerId: 1, name: "For two", enable: "onlyIfAvailable" },
        { offerId: 2, name: "Whole room", enable: "onlyIfAvailable" },
      ],
      rules: [
        { id: 1, priceFor: { type: "upToPerson", upToPersonValue: 2 }, extraPerson: 30, offer: 1 },
        { id: 2, priceFor: { type: "maxCapacity", upToPersonValue: null }, offer: 2 },
      ],
    },
    {
      id: 512_053,
      name: "Studio, weekly",
      qty: 1,
      maxPeople: 2,
      maxAdult: 2,
      maxChildren: 0,
      prices: { price1: 95 },
      offers: [{ offerId: 1, name: "Weekly", enable: "onlyIfAvailable" }],
      rules: [{ id: 1, priceFor: { type: "maxCapacity", upToPersonValue: null }, minimumStay: 7, offer: 1 }],
    },
  ],
};

/** A room's price rules as Beds24 gives them, every field named (blank ones as Beds24 has them blank). */
function rulesOf(r: FixtureRoom) {
  const rules: readonly FixtureRule[] =
    r.rules ??
    Object.keys(r.prices).map((slot) => {
      const id = Number(slot.slice(5));
      return { id, priceFor: { type: "maxCapacity" as const, upToPersonValue: null }, offer: id };
    });
  return rules.map((x) => ({
    id: x.id,
    name: `Daily price ${x.id}`,
    priceFor: x.priceFor,
    extraPerson: x.extraPerson ?? 0,
    extraChild: x.extraChild ?? 0,
    minimumStay: x.minimumStay ?? 1,
    maximumStay: x.maximumStay ?? 365,
    offer: x.offer ?? x.id,
    minDaysUntilCheckin: x.minDaysUntilCheckin ?? 0,
    maxDaysUntilCheckin: x.maxDaysUntilCheckin ?? 0,
    color: "",
    priceLinking: { roomId: null, priceId: null, offsetMultiplier: 1, offsetAmount: null },
  }));
}

/** One property as `GET /properties?includeAllRooms=true&includeOffers=true` gives it (schema `property`). */
export function propertyAnswer(
  p: FixtureProperty,
  opts: { rooms: boolean; offers: boolean; upsells?: boolean; rules?: boolean },
) {
  return {
    id: p.id,
    name: p.name,
    propertyType: "hotel",
    currency: p.currency,
    city: p.city,
    country: p.country,
    ...(opts.rooms
      ? {
          roomTypes: p.rooms.map((r) => ({
            id: r.id,
            propertyId: p.id,
            name: r.name,
            roomType: "double",
            qty: r.qty,
            maxPeople: r.maxPeople,
            maxAdult: r.maxAdult,
            maxChildren: r.maxChildren,
            minStay: 1,
            ...(r.fees ?? {}),
            ...(opts.offers ? { offers: r.offers } : {}),
            ...(opts.rules ? { priceRules: rulesOf(r) } : {}),
          })),
        }
      : {}),
    ...(opts.upsells ? { upsellItems: p.upsellItems ?? [] } : {}),
  };
}

/**
 * A calendar answer exactly as the OpenAPI file's example writes one (`GET /inventory/rooms/calendar`,
 * schema `calendar`): ranges with `from` and `to`, each naming its last night itself.
 */
export const calendarExample = {
  success: true,
  type: "calendar",
  count: 1,
  pages: { nextPageExists: false, nextPageLink: null },
  data: [
    {
      roomId: 512_012,
      propertyId: 241_502,
      calendar: [
        { from: "2027-03-01", to: "2027-03-02", numAvail: 1, minStay: 2, price1: 2_900.5 },
        { from: "2027-03-03", to: "2027-03-03", numAvail: 0, override: "blackout", price1: 2_900.5 },
        { from: "2027-03-04", to: "2027-03-04", numAvail: 1, override: "noCheckIn", price1: 3_100 },
        { from: "2027-03-05", to: "2027-03-05", numAvail: 1, multiplier: 1.2, price1: 2_900.5 },
        { from: "2027-03-06", to: "2027-03-06", numAvail: 1, override: "exception", price1: 2_900.5 },
        { from: "2027-03-07", to: "2027-03-07", numAvail: -1, price1: 2_900.5 },
      ],
    },
  ],
};
