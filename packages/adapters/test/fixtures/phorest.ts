/**
 * Phorest's answers, in the shapes its public reference gives them (read 20 October 2026). The field
 * names, nesting, `_embedded` keys, enums and id formats are transcribed from each page's OpenAPI
 * definition and examples; the values are this test's salon, a barber in Toronto on Phorest's US
 * server ("United States, Canada or Australia"), so nothing here is anyone's real data.
 *
 * - https://developer.phorest.com/docs/getting-started.md — servers, basic authentication with the
 *   `global/` username prefix, no webhooks, no payments through the API.
 * - https://developer.phorest.com/reference/getbranches.md — `_embedded.branches[]`: branchId, name,
 *   timeZone, currencyCode, …
 * - https://developer.phorest.com/reference/getservices.md — `_embedded.services[]`: serviceId, name,
 *   internetName, duration (minutes), price (in the currency's units), archived, isAddonOnly,
 *   disqualifiedStaff, userPrices[{userRef, price}], userDurations[{userRef, duration}].
 * - https://developer.phorest.com/reference/getstafflist.md — `_embedded.staffs[]`: staffId, userId,
 *   firstName, lastName, archived, hideFromOnlineBookings, disqualifiedServices.
 * - https://developer.phorest.com/reference/getstaffworktimetables.md — `_embedded.workTimeTables[]`:
 *   staffId, timeSlots[{date, type WORKING|NON_WORKING, startTime/endTime as LocalTime objects}].
 * - https://developer.phorest.com/reference/checkappointmentavailability.md — request
 *   {startTime, endTime, clientServiceSelections[{serviceSelections[{serviceId, staffId?}]}]}, answer
 *   {data[{startTime, clientSchedules[{serviceSchedules[{serviceId, staffId, startTime, endTime}]}]}]}.
 * - https://developer.phorest.com/reference/createbooking.md — request {clientId, bookingStatus,
 *   clientAppointmentSchedules[{clientId, serviceSchedules[…]}]}, 201 with bookingId; 400, 404, 429
 *   ("Current limit set to 100 rps"), 500 as ErrorResponse {statusCode, id, detail, errorCode}.
 * - https://developer.phorest.com/reference/cancelbooking.md — 200; 400 "Either the booking is already
 *   cancelled, or it is too late to cancel as per cancellation policy".
 * - https://developer.phorest.com/reference/getclients.md, createclient.md, getappointments.md.
 */

export const PHOREST_US = "https://api-gateway-us.phorest.com/third-party-api-server";
export const BUSINESS = "f9Kq2WbHTp6nDzLr0aBcEe";
export const BRANCH = "X9QpRsZ3bSvhJAaakg9TXQ";
export const USERNAME = "global/desk@mapleandfade.example";
export const PASSWORD = "phorest-api-password-for-tests";

export const BRANCHES = {
  _embedded: {
    branches: [
      {
        branchId: BRANCH,
        name: "Maple & Fade, Queen West",
        timeZone: "America/Toronto",
        latitude: 43.6465,
        longitude: -79.4094,
        streetAddress1: "800",
        streetAddress2: "Queen St W",
        city: "Toronto",
        state: "ON",
        postalCode: "M6J 1G1",
        country: "Canada",
        currencyCode: "CAD",
        accountId: 1234,
      },
    ],
  },
  page: { size: 200, totalElements: 1, totalPages: 1, number: 0 },
};

export const STAFF_MEI = "G4iZa1VHaKCPcyv6Lt3BoA";
export const STAFF_RAVI = "SE-J0emUgQnya14mOGdQS";
export const STAFF_HIDDEN = "l7fizkAS1JA8TzMoO4iliA";
export const USER_MEI = "cO8vpfkhkHYOhfvZuIcwng";
export const USER_RAVI = "TyfizkAS1JA8TzMoO4iliA";

export const STAFF = {
  _embedded: {
    staffs: [
      {
        staffId: STAFF_MEI,
        branchId: BRANCH,
        userId: USER_MEI,
        staffCategoryName: "Senior Barber",
        firstName: "Mei",
        lastName: "Chen",
        archived: false,
        hideFromOnlineBookings: false,
        disqualifiedServices: [],
      },
      {
        staffId: STAFF_RAVI,
        branchId: BRANCH,
        userId: USER_RAVI,
        staffCategoryName: "Barber",
        firstName: "Ravi",
        lastName: "Sandhu",
        archived: false,
        hideFromOnlineBookings: false,
        disqualifiedServices: ["P7wVb2sQd0qXx1yZ3aBcDd"],
      },
      {
        staffId: STAFF_HIDDEN,
        branchId: BRANCH,
        userId: "hiddenUserId0000000000",
        firstName: "Front",
        lastName: "Desk",
        archived: false,
        hideFromOnlineBookings: true,
      },
    ],
  },
  page: { size: 200, totalElements: 3, totalPages: 1, number: 0 },
};

export const SERVICE_FADE = "C-FYeVKIwfwL3av2WYcYjA";
export const SERVICE_STRAIGHT_RAZOR = "P7wVb2sQd0qXx1yZ3aBcDd";

export const SERVICES = {
  _embedded: {
    services: [
      {
        serviceId: SERVICE_FADE,
        version: 1,
        archived: false,
        categoryId: "category1",
        duration: 30,
        gapTime: 0,
        name: "Skin Fade",
        internetName: "Skin fade",
        price: 45,
        disqualifiedStaff: [],
        internetEnabled: true,
        isAddonOnly: false,
        userPrices: [{ userRef: USER_RAVI, price: 55 }],
        userDurations: [{ userRef: USER_MEI, duration: 45 }],
      },
      {
        serviceId: SERVICE_STRAIGHT_RAZOR,
        version: 3,
        archived: false,
        duration: 20,
        name: "Straight razor shave",
        price: 32.5,
        disqualifiedStaff: [],
        internetEnabled: true,
        isAddonOnly: false,
      },
      {
        serviceId: "addonHotTowel0000000000",
        archived: false,
        duration: 10,
        name: "Hot towel",
        price: 8,
        isAddonOnly: true,
      },
      { serviceId: "archivedOne00000000000", archived: true, duration: 60, name: "Old service", price: 10 },
    ],
  },
  page: { size: 200, totalElements: 4, totalPages: 1, number: 0 },
};

const time = (hourOfDay: number, minuteOfHour = 0) => ({ hourOfDay, minuteOfHour, secondOfMinute: 0 });

/** Rosters for the week from Wednesday 4 November 2026. */
export const ROSTERS = {
  _embedded: {
    workTimeTables: [
      {
        staffId: STAFF_MEI,
        branchId: BRANCH,
        timeSlots: [
          { date: "2026-11-04", type: "WORKING", startTime: time(12), endTime: time(19), branchId: BRANCH },
          {
            date: "2026-11-05",
            type: "WORKING",
            startTime: time(10),
            endTime: time(18),
            timeOffStartTime: time(13),
            timeOffEndTime: time(14),
            branchId: BRANCH,
          },
          { date: "2026-11-08", type: "NON_WORKING", branchId: BRANCH },
        ],
      },
    ],
  },
  page: { size: 1000, totalElements: 1, totalPages: 1, number: 0 },
};

export const CLIENT_ID = "dbNZRQHDqAn6VlVoL2c-iA";
export const BOOKING_ID = "b6xtq-4iX7LJ2_cPQQYDTQ";

export const ERROR_400 = {
  statusCode: 400,
  id: "4c1f0f9e",
  detail: "The selected time is no longer available",
  errorCode: "BOOKING_NOT_AVAILABLE",
};
