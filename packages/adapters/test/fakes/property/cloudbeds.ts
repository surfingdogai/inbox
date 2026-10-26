import { addLocalDays, daysBetween } from "@surfingdog/core";
import {
  API_KEY,
  ATLAS,
  AUTH_CODE,
  CLIENT,
  DORM,
  OWN_KEY,
  PATIO,
  PRICES,
  PROPERTY,
  RATE_ATLAS,
  RATE_DORM,
  RATE_PATIO,
  RATE_PROMO,
} from "../../fixtures/property/cloudbeds";
import { type FakePlatform, type FakeRequest, fakePlatform, json } from "../platform";

/**
 * A local Cloudbeds (ADR-037 §8.4), answering the v1.3 operations its reference documents
 * (`test/fixtures/property/cloudbeds.ts` names the pages): `x-api-key`, `{success, data}` answers, form
 * bodies with PHP-style arrays, `getRatePlans` with its per-day detail, reservations with their rooms,
 * the key exchange for a code, and webhooks made with a header of the subscriber's. Its documentation
 * describes no refusal of a full night on `postReservation` or `putReservation`, so this fake takes one
 * and its count goes past the rooms; `roomsAvailable` never shows below none, as a system's count may
 * not, so only a count of reservations against rooms can tell. `getReservations` pages 100 at a time and
 * lists each reservation's rooms only with `includeAllRooms`; `getRatePlans` leaves shared rooms (a dorm)
 * out unless `includeSharedRooms`; `getReservation` lists assigned rooms before unassigned ones, its main
 * guest in `guestList`, and its total with the property's taxes and fees. Nothing here is Cloudbeds' code.
 */

const API = "https://api.cloudbeds.com/api/v1.3";

interface Room {
  subReservationID: string;
  roomTypeID: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  rateID: string;
}
interface Reservation {
  reservationID: string;
  guestID: string;
  status: "not_confirmed" | "confirmed" | "canceled" | "checked_in" | "checked_out" | "no_show";
  startDate: string;
  endDate: string;
  thirdPartyIdentifier: string;
  dateCreated: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail?: string;
  guestPhone?: string;
  rooms: Room[];
  /** Sub-reservations a room has been assigned to, listed first by `getReservation`. */
  assigned: Set<string>;
  notes: string[];
}

/** A tax or fee as `getTaxesAndFees` lists it. */
export interface FakeTax {
  type: "tax" | "fee";
  name: string;
  amount: number;
  amountType: string;
  inclusiveOrExclusive: "inclusive" | "exclusive";
  availableFor: string[];
}

export interface FakeCloudbeds {
  readonly platform: FakePlatform;
  readonly reservations: Map<string, Reservation>;
  readonly webhooks: Record<string, string>[];
  /** Keys this Cloudbeds takes. */
  readonly keys: Set<string>;
  /** Called just before a reservation is written: another channel may take the room then. */
  beforeWrite: (() => void) | null;
  sell(roomTypeID: string, night: string, count?: number): void;
  /** Rooms taken on a night, against rooms there are: more than there are means oversold. */
  taken(roomTypeID: string, night: string): number;
  exhaust(): void;
  /** Every form a write sent, parsed, by operation. */
  forms(operation: string): URLSearchParams[];
  /** The property's taxes and fees. */
  readonly taxes: FakeTax[];
  /** The next call to each operation named here answers `success: false`. */
  readonly refuseNext: Set<string>;
  /** A room assigned to a sub-reservation: `getReservation` lists it first from then on. */
  assign(reservationID: string, subReservationID: string): void;
  /** Writes a reservation as another channel would, straight into the property's calendar. */
  add(r: { status: string; roomTypeID: string; startDate: string; endDate: string; id?: string }): string;
}

export function fakeCloudbeds(): FakeCloudbeds {
  const platform = fakePlatform();
  const reservations = new Map<string, Reservation>();
  const webhooks: Record<string, string>[] = [];
  const keys = new Set([API_KEY, OWN_KEY]);
  const sold = new Map<string, number>();
  const types = [ATLAS, PATIO, DORM];
  const plans = [RATE_ATLAS, RATE_PATIO, RATE_DORM, RATE_PROMO];
  const taxes: FakeTax[] = [];
  const refuseNext = new Set<string>();
  let limit = Number.POSITIVE_INFINITY;
  let n = 4_100_000;
  const fake: FakeCloudbeds = {
    platform,
    reservations,
    webhooks,
    keys,
    beforeWrite: null,
    sell(type, night, count = 1) {
      sold.set(`${type}|${night}`, (sold.get(`${type}|${night}`) ?? 0) + count);
    },
    taken: (type, night) => taken(type, night),
    exhaust() {
      limit = 0;
    },
    forms(op) {
      return platform.seen.filter((r) => r.url.pathname === `/api/v1.3/${op}`).map((r) => new URLSearchParams(r.body));
    },
    taxes,
    refuseNext,
    assign(id, sub) {
      reservations.get(id)?.assigned.add(sub);
    },
    add(x) {
      const id = x.id ?? String(++n);
      reservations.set(id, {
        reservationID: id,
        guestID: `g${id}`,
        status: x.status as Reservation["status"],
        startDate: x.startDate,
        endDate: x.endDate,
        thirdPartyIdentifier: "",
        dateCreated: "2027-01-01 00:00:00",
        guestFirstName: "Other",
        guestLastName: "Channel",
        rooms: [
          {
            subReservationID: `${id}-1`,
            roomTypeID: x.roomTypeID,
            startDate: x.startDate,
            endDate: x.endDate,
            adults: 2,
            children: 0,
            rateID: "",
          },
        ],
        assigned: new Set(),
        notes: [],
      });
      return id;
    },
  };

  const LIVE = new Set(["not_confirmed", "confirmed", "checked_in"]);
  function taken(type: string, night: string): number {
    let used = sold.get(`${type}|${night}`) ?? 0;
    for (const r of reservations.values()) {
      if (!LIVE.has(r.status)) continue;
      for (const room of r.rooms)
        if (room.roomTypeID === type && night >= room.startDate && night < room.endDate) used++;
    }
    return used;
  }
  const units = (type: string) => types.find((t) => t.roomTypeID === type)?.rooms ?? 0;

  /** PHP-style arrays read back: `rooms[0][roomTypeID]=…` → [{roomTypeID: …}]. */
  const arrays = (form: URLSearchParams, name: string): Record<string, string>[] => {
    const out: Record<string, string>[] = [];
    for (const [k, v] of form) {
      const m = new RegExp(`^${name}\\[(\\d+)\\]\\[([A-Za-z]+)\\]$`).exec(k);
      if (!m) continue;
      const i = Number(m[1]);
      out[i] = { ...(out[i] ?? {}), [m[2] ?? ""]: v };
    }
    return out.filter(Boolean);
  };

  const op = (method: string, name: string, handler: (req: FakeRequest, form: URLSearchParams) => Response) =>
    platform.on(method, `${API}/${name}`, (req) => {
      if (!keys.has(req.headers.get("x-api-key") ?? "")) return json({ success: false, message: "Unauthorized" }, 401);
      if (limit <= 0) return json({ success: false, message: "Too many requests" }, 429, { "retry-after": "5" });
      limit--;
      if (refuseNext.delete(name)) return json({ success: false, message: `${name} was not accepted` });
      const form = method === "GET" || method === "DELETE" ? req.url.searchParams : new URLSearchParams(req.body);
      return handler(req, form);
    });

  const roomStatus = (r: Reservation) =>
    r.status === "canceled" ? "cancelled" : r.status === "checked_in" ? "in_house" : "not_checked_in";
  const view = (r: Reservation, allRooms = false) => ({
    propertyID: PROPERTY.propertyID,
    reservationID: r.reservationID,
    dateCreated: r.dateCreated,
    dateModified: r.dateCreated,
    status: r.status,
    guestName: `${r.guestFirstName} ${r.guestLastName}`,
    startDate: r.startDate,
    endDate: r.endDate,
    adults: String(r.rooms.reduce((a, x) => a + x.adults, 0)),
    children: String(r.rooms.reduce((a, x) => a + x.children, 0)),
    thirdPartyIdentifier: r.thirdPartyIdentifier,
    sourceName: "Website/Booking Engine",
    ...(allRooms
      ? {
          rooms: r.rooms.map((room) => ({
            roomTypeID: room.roomTypeID,
            roomTypeName: types.find((t) => t.roomTypeID === room.roomTypeID)?.roomTypeName ?? "",
            subReservationID: room.subReservationID,
            adults: String(room.adults),
            children: String(room.children),
            roomID: r.assigned.has(room.subReservationID) ? `${room.roomTypeID}-0` : null,
            roomCheckIn: room.startDate,
            roomCheckOut: room.endDate,
            roomStatus: roomStatus(r),
          })),
        }
      : {}),
  });
  /** What a reservation comes to, as Cloudbeds totals it: its nights, then the exclusive taxes on them. */
  const grandTotal = (r: Reservation) => {
    const sub = r.rooms.reduce(
      (a, room) => a + (PRICES[room.roomTypeID] ?? 0) * daysBetween(room.startDate, room.endDate),
      0,
    );
    const extra = taxes
      .filter((t) => t.inclusiveOrExclusive === "exclusive" && t.amountType === "percentage")
      .reduce((a, t) => a + (sub * t.amount) / 100, 0);
    return { subTotal: sub, taxesFees: extra, grandTotal: Math.round((sub + extra) * 100) / 100 };
  };

  platform.on("POST", "https://hotels.cloudbeds.com/api/v1.3/access_token", (req) => {
    const f = new URLSearchParams(req.body);
    if (f.get("grant_type") !== "urn:ietf:params:oauth:grant-type:api-key")
      return json({ error: "unsupported_grant_type" }, 400);
    if (f.get("client_id") !== CLIENT.clientId || f.get("client_secret") !== CLIENT.clientSecret) {
      return json({ error: "invalid_client" }, 400);
    }
    if (f.get("code") !== AUTH_CODE)
      return json(
        { error: "invalid_grant", error_description: "The authorization code is invalid or has expired." },
        400,
      );
    return json({ access_token: API_KEY, token_type: "Bearer" });
  });

  op("GET", "getHotels", () =>
    json({
      success: true,
      data: [
        {
          propertyID: PROPERTY.propertyID,
          organizationID: PROPERTY.organizationID,
          propertyName: PROPERTY.propertyName,
          propertyTimezone: PROPERTY.propertyTimezone,
          propertyCurrency: PROPERTY.propertyCurrency,
        },
      ],
      count: 1,
      total: 1,
    }),
  );
  op("GET", "getHotelDetails", () =>
    json({
      success: true,
      data: {
        propertyID: PROPERTY.propertyID,
        propertyName: PROPERTY.propertyName,
        propertyEmail: PROPERTY.propertyEmail,
        propertyCurrency: PROPERTY.propertyCurrency[0],
        propertyAddress: { propertyCity: "Marrakech", propertyCountry: "MA" },
      },
    }),
  );
  op("GET", "getRoomTypes", () =>
    json({
      success: true,
      data: types.map((t) => ({
        roomTypeID: t.roomTypeID,
        propertyID: PROPERTY.propertyID,
        roomTypeName: t.roomTypeName,
        roomTypeNameShort: t.roomTypeName.slice(0, 3).toUpperCase(),
        isPrivate: t.isPrivate,
        maxGuests: t.maxGuests,
        adultsIncluded: 2,
        childrenIncluded: 0,
      })),
    }),
  );
  op("GET", "getRooms", () =>
    json({
      success: true,
      data: [
        {
          propertyID: PROPERTY.propertyID,
          rooms: types.flatMap((t) =>
            Array.from({ length: t.rooms }, (_, i) => ({
              roomID: `${t.roomTypeID}-${i}`,
              roomName: `${t.roomTypeName} ${i + 1}`,
              roomTypeID: t.roomTypeID,
              roomTypeName: t.roomTypeName,
              isPrivate: t.isPrivate,
              isVirtual: false,
              roomBlocked: false,
            })),
          ),
        },
      ],
      count: 1,
      total: 1,
    }),
  );
  op("GET", "getRatePlans", (_req, q) => {
    const start = q.get("startDate") ?? "";
    const end = q.get("endDate") ?? "";
    if (!start || !end || end <= start) return json({ success: false, message: "Invalid dates" });
    const nights = Array.from({ length: daysBetween(start, end) }, (_, i) => addLocalDays(start, i));
    const roomType = q.get("roomTypeID");
    const ids = q.get("rateIDs")?.split(",");
    const promo = q.get("includePromoCode") !== "false";
    const detailed = q.get("detailedRates") === "true";
    const shared = q.get("includeSharedRooms") === "true";
    const found = plans.filter(
      (p) =>
        (!roomType || p.roomTypeID === roomType) &&
        (!ids || ids.includes(p.rateID)) &&
        (promo || !("promoCode" in p)) &&
        (shared || types.find((t) => t.roomTypeID === p.roomTypeID)?.isPrivate !== false),
    );
    return json({
      success: true,
      data: found.map((p) => {
        // Never below none: a full night shows none left, however many were taken.
        const left = nights.map((night) => Math.max(0, units(p.roomTypeID) - taken(p.roomTypeID, night)));
        const rate = PRICES[p.roomTypeID] ?? 0;
        return {
          ...p,
          isDerived: false,
          roomRate: rate * nights.length,
          totalRate: rate * nights.length,
          roomsAvailable: Math.min(...left),
          propertyID: PROPERTY.propertyID,
          ...(detailed
            ? {
                roomRateDetailed: nights.map((night, i) => ({
                  date: night,
                  rateBase: rate,
                  totalRate: rate,
                  roomsAvailable: left[i],
                  closedToArrival: false,
                  closedToDeparture: false,
                  blocked: false,
                  minLos: 1,
                  maxLos: 0,
                  cutOff: 0,
                  lastMinuteBooking: 0,
                })),
              }
            : {}),
        };
      }),
    });
  });
  op("GET", "getReservations", (_req, q) => {
    const from = q.get("resultsFrom");
    const to = q.get("resultsTo");
    const checkInTo = q.get("checkInTo");
    const checkOutFrom = q.get("checkOutFrom");
    const page = Number(q.get("pageNumber") ?? 1);
    const size = Math.min(100, Number(q.get("pageSize") ?? 100));
    const all = [...reservations.values()].filter(
      (r) =>
        (!from || r.dateCreated >= from) &&
        (!to || r.dateCreated <= to) &&
        (!checkInTo || r.startDate <= checkInTo) &&
        (!checkOutFrom || r.endDate >= checkOutFrom),
    );
    const slice = all.slice((page - 1) * size, page * size);
    const rooms = q.get("includeAllRooms") === "true";
    return json({ success: true, data: slice.map((r) => view(r, rooms)), count: slice.length, total: all.length });
  });
  op("GET", "getReservation", (_req, q) => {
    const r = reservations.get(q.get("reservationID") ?? "");
    if (!r) return json({ success: false, message: "Reservation not found" });
    const shape = (room: Room) => ({ ...room, adults: String(room.adults), children: String(room.children) });
    const totals = grandTotal(r);
    return json({
      success: true,
      data: {
        ...view(r),
        total: totals.grandTotal,
        balance: totals.grandTotal,
        balanceDetailed: {
          suggestedDeposit: "0",
          subTotal: totals.subTotal,
          additionalItems: 0,
          taxesFees: totals.taxesFees,
          grandTotal: totals.grandTotal,
          paid: 0,
        },
        // Assigned rooms first, as Cloudbeds lists them.
        assigned: r.rooms.filter((room) => r.assigned.has(room.subReservationID)).map(shape),
        unassigned: r.rooms.filter((room) => !r.assigned.has(room.subReservationID)).map(shape),
        guestList: {
          [r.guestID]: {
            guestID: r.guestID,
            guestFirstName: r.guestFirstName,
            guestLastName: r.guestLastName,
            guestEmail: r.guestEmail ?? "",
            guestPhone: r.guestPhone ?? "",
            isMainGuest: true,
          },
        },
      },
    });
  });
  op("POST", "postReservation", (_req, form) => {
    for (const k of form.keys()) {
      if (/card|authorization/i.test(k)) return json({ success: false, message: `${k} is not accepted` });
    }
    const start = form.get("startDate") ?? "";
    const end = form.get("endDate") ?? "";
    const rooms = arrays(form, "rooms");
    const adults = arrays(form, "adults");
    const children = arrays(form, "children");
    if (!start || !end || end <= start || rooms.length === 0)
      return json({ success: false, message: "Invalid reservation" });
    if (!["cash", "credit", "ebanking", "pay_pal"].includes(form.get("paymentMethod") ?? "")) {
      return json({ success: false, message: "Invalid paymentMethod" });
    }
    fake.beforeWrite?.();
    fake.beforeWrite = null;
    const id = String(++n);
    // Nothing documented refuses a full night: it is taken.
    const r: Reservation = {
      reservationID: id,
      guestID: `g${id}`,
      status: "confirmed",
      startDate: start,
      endDate: end,
      thirdPartyIdentifier: form.get("thirdPartyIdentifier") ?? "",
      dateCreated: new Date().toISOString().slice(0, 19).replace("T", " "),
      guestFirstName: form.get("guestFirstName") ?? "",
      guestLastName: form.get("guestLastName") ?? "",
      ...(form.get("guestEmail") ? { guestEmail: form.get("guestEmail") ?? "" } : {}),
      ...(form.get("guestPhone") ? { guestPhone: form.get("guestPhone") ?? "" } : {}),
      assigned: new Set(),
      notes: [],
      rooms: rooms.map((room, i) => ({
        subReservationID: `${id}-${i + 1}`,
        roomTypeID: room.roomTypeID ?? "",
        startDate: start,
        endDate: end,
        adults: Number(adults[i]?.quantity ?? 1),
        children: Number(children[i]?.quantity ?? 0),
        rateID: room.roomRateID ?? "",
      })),
    };
    reservations.set(id, r);
    return json({ success: true, reservationID: id, status: r.status, startDate: start, endDate: end, grandTotal: 0 });
  });
  op("PUT", "putReservation", (_req, form) => {
    const r = reservations.get(form.get("reservationID") ?? "");
    if (!r) return json({ success: false, message: "Reservation not found" });
    const status = form.get("status");
    if (status) {
      if (!["confirmed", "not_confirmed", "canceled", "checked_in", "checked_out", "no_show"].includes(status)) {
        return json({ success: false, message: "Invalid status" });
      }
      if (r.status === "canceled") return json({ success: false, message: "The reservation is canceled" });
      r.status = status as Reservation["status"];
    }
    const rooms = arrays(form, "rooms");
    for (const room of rooms) {
      const mine = r.rooms.find((x) => x.subReservationID === room.subReservationID);
      if (!mine) return json({ success: false, message: "Invalid subReservationID" });
      mine.roomTypeID = room.roomTypeID ?? mine.roomTypeID;
      mine.startDate = room.checkinDate ?? mine.startDate;
      mine.endDate = room.checkoutDate ?? mine.endDate;
      mine.adults = Number(room.adults ?? mine.adults);
      mine.children = Number(room.children ?? mine.children);
    }
    if (rooms.length > 0) {
      r.startDate = r.rooms.map((x) => x.startDate).sort()[0] ?? r.startDate;
      r.endDate =
        r.rooms
          .map((x) => x.endDate)
          .sort()
          .at(-1) ?? r.endDate;
    }
    return json({ success: true, data: view(r) });
  });
  op("POST", "postReservationNote", (_req, form) => {
    const r = reservations.get(form.get("reservationID") ?? "");
    if (!r) return json({ success: false, message: "Reservation not found" });
    r.notes.push(form.get("reservationNote") ?? "");
    return json({ success: true, reservationNoteID: `note${r.notes.length}` });
  });
  op("PUT", "putGuest", (_req, form) => {
    const r = [...reservations.values()].find((x) => x.guestID === form.get("guestID"));
    if (!r) return json({ success: false, message: "Guest not found" });
    if (form.get("guestFirstName")) r.guestFirstName = form.get("guestFirstName") ?? "";
    if (form.get("guestLastName")) r.guestLastName = form.get("guestLastName") ?? "";
    if (form.get("guestEmail")) r.guestEmail = form.get("guestEmail") ?? "";
    if (form.get("guestPhone")) r.guestPhone = form.get("guestPhone") ?? "";
    return json({ success: true });
  });
  op("GET", "getTaxesAndFees", () =>
    json({
      success: true,
      data: taxes.map((t, i) => ({ ...t, [t.type === "tax" ? "taxID" : "feeID"]: `${t.type}${i}`, isDeleted: false })),
      total: taxes.length,
    }),
  );
  op("POST", "postWebhook", (_req, form) => {
    webhooks.push(Object.fromEntries(form));
    return json({ success: true, data: { subscriptionID: `sub${webhooks.length}` } });
  });
  op("DELETE", "deleteWebhook", () => json({ success: true }));

  return fake;
}
