import {
  type AriRow,
  addLocalDays,
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  dateIn,
  daysBetween,
  decimalAmount,
  type ExternalProperty,
  type ExternalRate,
  type ExternalRoom,
  type HookFact,
  type LinkState,
  minorAmount,
  minorUnits,
  type OAuthClient,
  type OutboundStay,
  type PayAmount,
  type RunContext,
  type StayWriteStatus,
  secretField,
} from "@surfingdog/core";
import { sha256Hex } from "@surfingdog/platform";
import { z } from "zod";
import { retryAfterMs } from "../http";
import { constantTimeEqual } from "../pay-sign";
import { matchRooms } from "./match";

/**
 * Cloudbeds (ADR-037 §8.4), built from its developer documentation (https://developers.cloudbeds.com/):
 * the partner guides (getting started in 5 steps, API keys for technology partners, the property-level
 * quickstart, the alternative OAuth method, user authorization flows, webhooks) and the API reference of
 * `getHotels`, `getHotelDetails`, `getRoomTypes`, `getRooms`, `getRatePlans`, `getTaxesAndFees`,
 * `getReservations`, `getReservation`, `postReservation`, `putReservation`, `postReservationNote`,
 * `putGuest` and `postWebhook` (v1.3).
 *
 * **Switched off until Cloudbeds approves a partner app.** Cloudbeds asks for an evaluation by its
 * Partnerships team before development and certification, and recommends delivering a property's API key
 * automatically when it connects the app: Cloudbeds sends the property's browser back with a code, which
 * is exchanged (`grant_type=urn:ietf:params:oauth:grant-type:api-key`) for the property's own key. The
 * client id and secret for that are the operator's; without them `ready()` says why and the gallery shows
 * **Needs setup**. A property pasting a key it made itself is a second way, code-complete behind its own
 * switch and off until Cloudbeds' partner team answers.
 *
 * What it does:
 * - **Rooms** are a property's room types, shared ones (a hostel's dorm beds) too, counted by their rooms;
 *   **rates** are their rate plans without a promo code. **What is free** and the price of each night
 *   come from `getRatePlans` with its per-day detail (`roomsAvailable`, `rateBase`, the arrival and
 *   departure closures, the least and most nights), `includeSharedRooms` on.
 * - **Prices before tax are no quote.** `getRatePlans` says its rates are "base rates and additional costs
 *   from extra guests": a property's own taxes and fees come on top. A property with an exclusive tax or
 *   fee on its rates (`getTaxesAndFees`) has its nights read without prices, so the inbox never quotes a
 *   guest less than the folio; the owner prices those stays. After each write, the reservation's own
 *   total (`balanceDetailed.grandTotal`) is read back, and the owner is told when it differs from what the
 *   guest agreed.
 * - **Written first, checked before and after** (`check_then_write`). Cloudbeds documents no refusal of a
 *   full night on `postReservation`, so the nights are read live just before the write, and refused here
 *   when they are full; after the write, the inbox counts the reservations against the rooms on each night
 *   (`oversold`): every page of `getReservations` with each one's rooms (`includeAllRooms`), its own among
 *   them or it cannot tell, and takes its own back if another channel took the last room in between.
 * - **Our key** goes as the reservation's `thirdPartyIdentifier`, and `find` looks for it among the
 *   reservations made in the last days; one found again is the stay written only while it is live. Cloudbeds sends no email of its own (`sendEmailConfirmation`
 *   false). The payment method is `cash` — what the property is paid outside Cloudbeds — never `credit`,
 *   and never a card token or an authorization code. A note on the reservation (`postReservationNote`)
 *   carries the stay's reference and the total the guest agreed.
 * - **The guest.** A stay written before it is paid holds only its reference as the guest's name; once it
 *   is confirmed, the guest's name, email and phone are set on the reservation's main guest (`putGuest`),
 *   so the desk has them at check-in.
 * - **Moved** with `putReservation` and its rooms, after the same live check, each room the property holds
 *   paired with the stay's by its type and its people, never by position; **cancelled** by status
 *   (`canceled`), never deleted. No price is sent: Cloudbeds prices it from the rate.
 * - **Webhooks** carry no signature of Cloudbeds' own, but `postWebhook` sends a header of ours with every
 *   delivery (`authHeaderName`, `authHeaderValue`): a secret made for the connection, sealed, compared in
 *   constant time. The body is a hint: the reservation it names is read back with the property's key.
 */

export const CLOUDBEDS_API = "https://api.cloudbeds.com/api/v1.3";
export const CLOUDBEDS_AUTH = "https://hotels.cloudbeds.com/api/v1.3";
/** The only hosts this connector calls. */
export const CLOUDBEDS_HOSTS: readonly string[] = ["api.cloudbeds.com", "hotels.cloudbeds.com"];
/** The webhooks a connection makes: object and action, as `postWebhook` takes them. */
export const CLOUDBEDS_EVENTS: readonly (readonly [string, string])[] = [
  ["reservation", "created"],
  ["reservation", "status_changed"],
  ["reservation", "dates_changed"],
  ["reservation", "accommodation_type_changed"],
  ["reservation", "deleted"],
];
/** The header each delivery carries, with the connection's own secret. */
export const CLOUDBEDS_HOOK_HEADER = "x-inbox-hook";
/** The scopes a key needs, chosen on Cloudbeds' own page when the key or the app is made. */
export const CLOUDBEDS_SCOPES: readonly string[] = [
  "read:hotel",
  "read:room",
  "read:rate",
  "read:taxesAndFees",
  "read:reservation",
  "write:reservation",
  "write:guest",
];
/** How far back `find` looks for a reservation this inbox made. */
const FIND_DAYS = 3;
/** Nights read in one call. */
const MAX_NIGHTS = 90;
/** Pages of 100 reservations read at most for one count; more, and the inbox promises nothing. */
const MAX_PAGES = 50;
const PAGE = 100;
const LIVE = new Set(["confirmed", "not_confirmed", "checked_in"]);
/** A room of a live reservation that holds its nights no longer. */
const ROOM_GONE = new Set(["cancelled", "checked_out"]);
const DOCS = "https://surfingdog.ai/docs/connectors/cloudbeds/";

export const cloudbedsKeyForm = z.object({
  api_key: secretField(
    z
      .string()
      .trim()
      .min(16)
      .max(400)
      .regex(/^cbat_[A-Za-z0-9_-]+$/, "a Cloudbeds API key starts with cbat_"),
    {
      label: "API key",
      help: "In Cloudbeds: Account → Apps & Marketplace → API Credentials, with the scopes below.",
      steps: CLOUDBEDS_SCOPES.map((s) => `Scope ${s}`),
    },
  ),
});

type Json = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function minor(value: unknown, currency: string): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const e = minorUnits(currency) ?? 2;
  return minorAmount(String(n), e) ?? Math.round(n * 10 ** e);
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** A form body as Cloudbeds reads arrays: `rooms[0][roomTypeID]=…`. */
function formOf(fields: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) add(`${key}[${i}]`, v);
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Json)) add(`${key}[${k}]`, v);
    } else {
      out.append(key, String(value));
    }
  };
  for (const [k, v] of Object.entries(fields)) add(k, v);
  return out.toString();
}

export interface CloudbedsOptions {
  readonly hosted?: boolean | undefined;
  /** The way a property pastes a key it made itself. Off until Cloudbeds' partner team answers. */
  readonly propertyKey?: boolean | undefined;
}

export function cloudbedsConnector(
  client: OAuthClient | null | undefined,
  opts: CloudbedsOptions = {},
): ConnectorDefinition {
  const partner = client?.clientId && client.clientSecret ? client : null;
  const propertyKey = opts.propertyKey === true;

  async function call(
    ctx: Pick<ConnectContext, "http">,
    apiKey: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    operation: string,
    fields: Record<string, unknown> = {},
  ): Promise<{ res: ConnectorHttpResponse; json: Json }> {
    const query = method === "GET" || method === "DELETE" ? formOf(fields) : "";
    let res: ConnectorHttpResponse;
    try {
      res = await ctx.http.request({
        method,
        url: `${CLOUDBEDS_API}/${operation}${query ? `?${query}` : ""}`,
        headers: {
          "x-api-key": apiKey,
          accept: "application/json",
          ...(method === "POST" || method === "PUT" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(method === "POST" || method === "PUT" ? { body: formOf(fields) } : {}),
        timeoutMs: 20_000,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("unreachable", "Cloudbeds could not be reached.");
    }
    if (res.status === 401)
      throw new ConnectorError("auth", "Cloudbeds did not take the key: it was removed, or not used for 30 days.");
    if (res.status === 403) throw new ConnectorError("auth", "Cloudbeds did not allow it: the key lacks a scope.");
    if (res.status === 404) throw new ConnectorError("not_found", "Cloudbeds has no such thing.");
    if (res.status === 429) {
      throw new ConnectorError("rate_limited", "Cloudbeds asked to wait.", {
        retryAfterMs: retryAfterMs(res.headers) ?? 30_000,
      });
    }
    if (res.status >= 500) throw new ConnectorError("unreachable", "Cloudbeds is not answering properly.");
    if (res.status !== 200 && res.status !== 201)
      throw new ConnectorError("bad_response", `Cloudbeds answered ${res.status}.`);
    try {
      const json = JSON.parse(res.text) as Json;
      return { res, json };
    } catch {
      throw new ConnectorError("bad_response", "Cloudbeds answered with something that is not JSON.");
    }
  }

  const run = (
    ctx: RunContext,
    method: "GET" | "POST" | "PUT" | "DELETE",
    operation: string,
    fields: Record<string, unknown> = {},
  ) => call(ctx, ctx.secret.api_key ?? "", method, operation, fields);

  /** A read: its data, or why Cloudbeds would not give it. */
  async function read(ctx: RunContext, operation: string, fields: Record<string, unknown> = {}): Promise<Json> {
    const { json } = await run(ctx, "GET", operation, fields);
    if (json.success === false) {
      const message = str(json.message);
      if (/not found|does not exist/i.test(message)) throw new ConnectorError("not_found", message);
      throw new ConnectorError("bad_response", message || "Cloudbeds would not answer that.");
    }
    return json;
  }

  /** A write: Cloudbeds' answer, or its no. */
  async function write(
    ctx: RunContext,
    method: "POST" | "PUT",
    operation: string,
    fields: Record<string, unknown>,
  ): Promise<Json> {
    const { json } = await run(ctx, method, operation, fields);
    if (json.success !== true)
      throw new ConnectorError("refused", str(json.message).slice(0, 300) || "Cloudbeds did not take it.");
    return json;
  }

  const data = (j: Json): Json[] => (Array.isArray(j.data) ? (j.data as Json[]) : []);

  async function hotels(ctx: RunContext): Promise<Json[]> {
    return data(await read(ctx, "getHotels", { pageSize: PAGE }));
  }

  async function properties(ctx: RunContext): Promise<ExternalProperty[]> {
    return (await hotels(ctx)).map((h) => ({
      id: str(h.propertyID),
      name: str(h.propertyName),
      currency: str(
        ((Array.isArray(h.propertyCurrency) ? h.propertyCurrency : [])[0] as Json | undefined)?.currencyCode,
      ).toUpperCase(),
      timezone: str(h.propertyTimezone),
    }));
  }

  async function zoneOf(ctx: RunContext, propertyId: string): Promise<string> {
    const h = (await hotels(ctx)).find((x) => str(x.propertyID) === propertyId);
    const zone = str(h?.propertyTimezone);
    if (!zone) throw new ConnectorError("bad_response", "Cloudbeds did not give the property's time zone.");
    return zone;
  }

  /** Rooms of each room type, as Cloudbeds lists them. */
  async function roomCounts(ctx: RunContext, propertyId: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (let page = 1; page <= 20; page++) {
      const j = await read(ctx, "getRooms", { propertyIDs: propertyId, pageNumber: page, pageSize: PAGE });
      let seen = 0;
      for (const p of data(j)) {
        for (const r of Array.isArray(p.rooms) ? (p.rooms as Json[]) : []) {
          seen++;
          if (r.isVirtual === true) continue;
          counts.set(str(r.roomTypeID), (counts.get(str(r.roomTypeID)) ?? 0) + 1);
        }
      }
      if (seen < PAGE) break;
    }
    return counts;
  }

  /** Rate plans with their per-day detail, for the nights from `from` up to `to` (excluded). */
  async function rates(
    ctx: RunContext,
    propertyId: string,
    from: string,
    to: string,
    extra: Record<string, unknown> = {},
  ): Promise<Json[]> {
    return data(
      await read(ctx, "getRatePlans", {
        propertyIDs: propertyId,
        startDate: from,
        endDate: to,
        detailedRates: "true",
        includePromoCode: "false",
        includeSharedRooms: "true",
        ...extra,
      }),
    ).filter((r) => !str(r.promoCode));
  }

  /**
   * Whether a rate's price is what a guest pays: false when the property adds a tax or a fee of its own on
   * top of its rates (exclusive), which `getRatePlans` leaves out. Then no price is read at all.
   */
  async function pricesAreWhole(ctx: RunContext, propertyId: string): Promise<boolean> {
    const items = data(await read(ctx, "getTaxesAndFees", { propertyID: propertyId }));
    return !items.some((t) => {
      if (t.isDeleted === true) return false;
      const on = Array.isArray(t.availableFor) ? (t.availableFor as unknown[]).map(str) : ["rate"];
      return str(t.inclusiveOrExclusive) !== "inclusive" && on.includes("rate");
    });
  }

  /** Rooms free for each room type on each night, the least any of its rates says. */
  async function freeRooms(
    ctx: RunContext,
    propertyId: string,
    from: string,
    to: string,
  ): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    for (const r of await rates(ctx, propertyId, from, to)) {
      const room = str(r.roomTypeID);
      if (!out.has(room)) out.set(room, new Map());
      const nights = out.get(room) as Map<string, number>;
      for (const d of Array.isArray(r.roomRateDetailed) ? (r.roomRateDetailed as Json[]) : []) {
        const night = str(d.date);
        if (night < from || night >= to || typeof d.roomsAvailable !== "number") continue;
        nights.set(night, Math.min(nights.get(night) ?? Number.POSITIVE_INFINITY, d.roomsAvailable));
      }
    }
    return out;
  }

  /** Whether each night of a stay has a room for each of its rooms, leaving out what the stay holds itself. */
  async function checkFree(
    ctx: RunContext,
    stay: OutboundStay,
    own: { roomTypeID: string; startDate: string; endDate: string }[] = [],
  ): Promise<void> {
    const free = await freeRooms(ctx, stay.propertyId, stay.checkIn, stay.checkOut);
    const nights = daysBetween(stay.checkIn, stay.checkOut);
    const wanted = new Map<string, number>();
    for (const room of stay.rooms) wanted.set(room.roomId, (wanted.get(room.roomId) ?? 0) + 1);
    for (const [room, count] of wanted) {
      for (let i = 0; i < nights; i++) {
        const night = addLocalDays(stay.checkIn, i);
        const held = own.filter((o) => o.roomTypeID === room && night >= o.startDate && night < o.endDate).length;
        const left = free.get(room)?.get(night);
        if (left === undefined || left === Number.POSITIVE_INFINITY || left + held < count) {
          throw new ConnectorError("refused", "Cloudbeds has no room for those nights.");
        }
      }
    }
  }

  interface Booked {
    readonly id: string;
    readonly status: string;
    readonly rooms: {
      subReservationID: string;
      roomTypeID: string;
      startDate: string;
      endDate: string;
      adults: number;
      children: number;
    }[];
    /** The reservation's main guest, as Cloudbeds holds them. */
    readonly guest: { id: string; firstName: string; lastName: string; email: string; phone: string } | null;
    /** Its own total, taxes and fees in (`balanceDetailed.grandTotal`, else `total`), in Cloudbeds' decimals. */
    readonly total: number | null;
  }

  async function reservation(ctx: RunContext, propertyId: string, id: string): Promise<Booked> {
    const j = await read(ctx, "getReservation", {
      reservationID: id,
      ...(propertyId ? { propertyID: propertyId } : {}),
    });
    const d = (j.data ?? {}) as Json;
    const rooms = [
      ...(Array.isArray(d.assigned) ? (d.assigned as Json[]) : []),
      ...(Array.isArray(d.unassigned) ? (d.unassigned as Json[]) : []),
    ].map((r) => ({
      subReservationID: str(r.subReservationID),
      roomTypeID: str(r.roomTypeID),
      startDate: str(r.startDate) || str(d.startDate),
      endDate: str(r.endDate) || str(d.endDate),
      adults: Number(r.adults ?? 0),
      children: Number(r.children ?? 0),
    }));
    const guests = Object.values(
      d.guestList && typeof d.guestList === "object" ? (d.guestList as Record<string, Json>) : {},
    );
    const main = guests.find((g) => g.isMainGuest === true) ?? guests[0];
    const detailed = (Array.isArray(d.balanceDetailed) ? d.balanceDetailed[0] : d.balanceDetailed) as Json | undefined;
    const total = Number(detailed?.grandTotal ?? d.total);
    return {
      id: str(d.reservationID) || id,
      status: str(d.status),
      rooms,
      guest: main
        ? {
            id: str(main.guestID),
            firstName: str(main.guestFirstName),
            lastName: str(main.guestLastName),
            email: str(main.guestEmail),
            phone: str(main.guestPhone),
          }
        : null,
      total: (detailed?.grandTotal ?? d.total) !== undefined && Number.isFinite(total) && total >= 0 ? total : null,
    };
  }

  /** A reservation's own total as the inbox counts money, in the property's currency; null when it gives none. */
  async function totalOf(ctx: RunContext, booked: Booked, propertyId: string): Promise<PayAmount | null> {
    if (booked.total === null) return null;
    const currency = (await properties(ctx)).find((p) => p.id === propertyId)?.currency ?? "";
    const value = currency ? minor(booked.total, currency) : null;
    return value === null ? null : { value, currency };
  }

  /** Reservations made in the last days, a page at a time: what `find` looks through. */
  async function recent(ctx: RunContext, propertyId: string): Promise<Json[]> {
    const out: Json[] = [];
    const from = new Date(ctx.now - FIND_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    const to = new Date(ctx.now + 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    for (let page = 1; page <= 20; page++) {
      const j = await read(ctx, "getReservations", {
        propertyID: propertyId,
        resultsFrom: from,
        resultsTo: to,
        pageNumber: page,
        pageSize: PAGE,
      });
      const items = data(j);
      out.push(...items);
      if (items.length < PAGE) return out;
    }
    return out;
  }

  /**
   * The system's own count of bookings against its rooms, night by night: true when one night has more.
   * Every page of the reservations on those nights is read, each with its rooms (`includeAllRooms`), so a
   * page full of cancelled ones never hides a live one; past `MAX_PAGES` it cannot tell, and throws. The
   * reservation just written (`link`) must be among them: a list that has not caught up yet says nothing.
   */
  async function oversoldNights(ctx: RunContext, stay: OutboundStay, link: LinkState): Promise<boolean> {
    const units = await roomCounts(ctx, stay.propertyId);
    const nights = daysBetween(stay.checkIn, stay.checkOut);
    const types = new Set(stay.rooms.map((r) => r.roomId));
    const count = new Map<string, number>();
    let ours = false;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        throw new ConnectorError("unreachable", "Too many reservations on those nights to count them.");
      }
      const j = await read(ctx, "getReservations", {
        propertyID: stay.propertyId,
        checkInTo: addLocalDays(stay.checkOut, -1),
        checkOutFrom: addLocalDays(stay.checkIn, 1),
        includeAllRooms: "true",
        pageNumber: page,
        pageSize: PAGE,
      });
      const rows = data(j);
      for (const r of rows) {
        if (!LIVE.has(str(r.status))) continue;
        if (!Array.isArray(r.rooms)) {
          throw new ConnectorError("bad_response", "Cloudbeds did not list a reservation's rooms.");
        }
        if (link.externalId && str(r.reservationID) === link.externalId) ours = true;
        for (const room of r.rooms as Json[]) {
          const type = str(room.roomTypeID);
          if (!types.has(type) || ROOM_GONE.has(str(room.roomStatus))) continue;
          const from = str(room.roomCheckIn) || str(r.startDate);
          const to = str(room.roomCheckOut) || str(r.endDate);
          for (let i = 0; i < nights; i++) {
            const night = addLocalDays(stay.checkIn, i);
            if (night >= from && night < to) count.set(`${type}|${night}`, (count.get(`${type}|${night}`) ?? 0) + 1);
          }
        }
      }
      if (rows.length < PAGE) break;
    }
    if (!ours) throw new ConnectorError("unreachable", "Cloudbeds does not list the reservation just written yet.");
    for (const [key, n] of count) {
      if (n > (units.get(key.split("|")[0] ?? "") ?? 0)) return true;
    }
    return false;
  }

  async function find(ctx: RunContext, stay: OutboundStay): Promise<LinkState | null> {
    const mine = (await recent(ctx, stay.propertyId)).find((r) => str(r.thirdPartyIdentifier) === stay.key);
    const id = str(mine?.reservationID);
    return id ? { externalId: id, etag: null, calendar: null } : null;
  }

  function people(room: OutboundStay["rooms"][number]): { adults: number; children: number } {
    return { adults: room.adults, children: room.childrenAges.length };
  }

  /** The line the desk reads on the reservation: the stay's reference, and what the guest agreed. */
  function noteOf(stay: OutboundStay): string {
    const first = stay.rooms[0]?.price;
    const total = stay.rooms.reduce((a, r) => a + r.price.value, 0);
    return first
      ? `Inbox stay ${stay.reference} · agreed with the guest: ${first.currency} ${decimalAmount({ value: total, currency: first.currency })}`
      : `Inbox stay ${stay.reference}`;
  }

  /** The guest's name, email and phone on the reservation's main guest, once the stay is confirmed. */
  async function nameGuest(ctx: RunContext, stay: OutboundStay, booked: Booked): Promise<void> {
    const guest = stay.guest;
    if (!guest || !booked.guest?.id) return;
    const names = guest.name.trim().split(/\s+/).filter(Boolean);
    const last = names.length > 1 ? (names.pop() ?? "") : (names[0] ?? "");
    const first = names.join(" ") || last;
    const same =
      booked.guest.firstName === first &&
      booked.guest.lastName === last &&
      (!guest.email || booked.guest.email === guest.email) &&
      (!guest.phone || booked.guest.phone === guest.phone);
    if (same) return;
    await write(ctx, "PUT", "putGuest", {
      propertyID: stay.propertyId,
      guestID: booked.guest.id,
      guestFirstName: first,
      guestLastName: last,
      ...(guest.email ? { guestEmail: guest.email } : {}),
      ...(guest.phone ? { guestPhone: guest.phone } : {}),
    });
  }

  /** The reservation's own total, read back after a write; nothing when Cloudbeds would not say. */
  async function totalAfter(ctx: RunContext, stay: OutboundStay, id: string): Promise<{ total?: PayAmount }> {
    try {
      const total = await totalOf(ctx, await reservation(ctx, stay.propertyId, id), stay.propertyId);
      return total ? { total } : {};
    } catch {
      return {};
    }
  }

  async function setStatus(
    ctx: RunContext,
    stay: OutboundStay,
    id: string,
    now: string,
    status: StayWriteStatus,
    fresh = false,
  ) {
    const want = status === "confirmed" ? "confirmed" : "not_confirmed";
    if (now === want) return;
    // A stay just written waits, unconfirmed, for its deposit; one confirmed in Cloudbeds since (by the
    // property, say) is never made unconfirmed again by the inbox.
    if (now === "confirmed" && want === "not_confirmed" && !fresh) return;
    await write(ctx, "PUT", "putReservation", {
      propertyID: stay.propertyId,
      reservationID: id,
      status: want,
      sendStatusChangeEmail: "false",
    });
  }

  /** The webhooks for a connection's own address, each with our header: their ids, or none at all. */
  async function subscribe(ctx: RunContext, hookUrl: string): Promise<string[]> {
    const ids: string[] = [];
    for (const [object, action] of CLOUDBEDS_EVENTS) {
      const j = await write(ctx, "POST", "postWebhook", {
        object,
        action,
        endpointUrl: hookUrl,
        authHeaderName: CLOUDBEDS_HOOK_HEADER,
        authHeaderValue: ctx.secret.hook_secret ?? "",
      });
      const id = str((j.data as Json | undefined)?.subscriptionID);
      if (id) ids.push(id);
    }
    return ids;
  }

  async function unsubscribe(ctx: RunContext): Promise<void> {
    const ids = Array.isArray(ctx.extra.subscriptions) ? (ctx.extra.subscriptions as unknown[]).map(str) : [];
    for (const id of ids) {
      try {
        await run(ctx, "DELETE", "deleteWebhook", { subscriptionID: id });
      } catch {
        // Best effort: the property can remove the app in Cloudbeds.
      }
    }
  }

  /** Webhooks are made once the connection is kept (its first sync), and made again when its address moved. */
  const WEBHOOK_TRIES = 5;
  function webhookDue(ctx: RunContext): boolean {
    if (!ctx.hookUrl || ctx.hooksLive === false || !ctx.secret.hook_secret) return false;
    if (ctx.extra.webhook === "added") return ctx.extra.hook_url !== ctx.hookUrl;
    return Number(ctx.extra.webhook_tries ?? 0) < WEBHOOK_TRIES;
  }

  async function connected(ctx: ConnectContext, apiKey: string): Promise<Connected> {
    const secret = { api_key: apiKey, hook_secret: randomSecret() };
    const runCtx: RunContext = {
      ...ctx,
      secret,
      extra: {},
      calendars: [],
      busyCalendars: [],
      destinations: [],
      destination: null,
      own: { ids: new Set(), spans: [] },
      marker: "",
      saveSecret: async () => {},
    };
    const list = await hotels(runCtx);
    const first = list[0];
    if (!first) throw new ConnectorError("bad_response", "Cloudbeds shows no property for this key.");
    const org = str(first.organizationID);
    return {
      account: list.length > 1 ? `${str(first.propertyName)} and ${list.length - 1} more` : str(first.propertyName),
      externalId: org ? `org:${org}` : `property:${str(first.propertyID)}`,
      secret,
      // The webhooks wait for the connection to be kept: its first sync makes them (`refresh`).
      extra: { propertyIds: list.map((h) => str(h.propertyID)), webhook: "pending" },
      calendars: [],
      destinations: [],
      defaults: { busy: [], destination: null },
    };
  }

  const reason = "Cloudbeds needs this server's partner app";
  const ready = (): true | string => (partner || propertyKey ? true : reason);

  return {
    kind: "cloudbeds",
    title: "Cloudbeds",
    group: "lodging",
    capabilities: ["stay_inventory", "write_stays", "stay_events"],
    auth: partner ? "oauth" : "form",
    form: cloudbedsKeyForm,
    note: "Rooms, rates and what's free from Cloudbeds; each stay written to Cloudbeds before it is confirmed.",
    consent:
      "Cloudbeds will ask to let this inbox read your rooms, rates, taxes and reservations, and make and change reservations and their guests.",
    ready,
    // Hosted, nothing for an owner to do: Soon. On one's own server, what its operator sets.
    whenNotReady: opts.hosted
      ? { status: "soon" }
      : {
          status: "setup",
          hint: "Needs a Cloudbeds partner app on this server. Until then, you confirm each stay yourself.",
          href: DOCS,
        },
    presets: [
      {
        id: "property_key",
        label: "A key you made in Cloudbeds",
        values: {},
        auth: "form",
        ready: () => (propertyKey ? true : "A property's own Cloudbeds key is off on this server"),
        whenNotReady: {
          status: "setup",
          hint: "Off on this server until Cloudbeds' partner team agrees to it.",
          href: DOCS,
        },
      },
    ],
    disconnectNote: "In Cloudbeds, the property can also remove this app or its key under Apps & Marketplace.",

    async connect(ctx, input) {
      if (!propertyKey) throw new ConnectorError("config", "A property's own Cloudbeds key is off on this server.");
      return connected(ctx, (input.api_key ?? "").trim());
    },

    oauth: {
      authorizeUrl({ redirectUri, state }) {
        const q = new URLSearchParams({
          client_id: partner?.clientId ?? "",
          redirect_uri: redirectUri,
          response_type: "code",
          state,
        });
        return `${CLOUDBEDS_API}/oauth?${q}`;
      },
      async exchange(ctx, { code, redirectUri }) {
        if (!partner) throw new ConnectorError("config", reason);
        let res: ConnectorHttpResponse;
        try {
          res = await ctx.http.request({
            method: "POST",
            url: `${CLOUDBEDS_AUTH}/access_token`,
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:api-key",
              client_id: partner.clientId,
              client_secret: partner.clientSecret,
              redirect_uri: redirectUri,
              code,
            }).toString(),
            timeoutMs: 15_000,
          });
        } catch (error) {
          if (error instanceof ConnectorError) throw error;
          throw new ConnectorError("unreachable", "Cloudbeds could not be reached.");
        }
        let j: Json = {};
        try {
          j = JSON.parse(res.text) as Json;
        } catch {
          // read below
        }
        const key = str(j.access_token);
        if (res.status !== 200 || !key.startsWith("cbat_")) {
          throw new ConnectorError(
            "auth",
            "Cloudbeds did not give a key: the code lapsed after 10 minutes, or was used. Connect again.",
          );
        }
        return connected(ctx, key);
      },
    },

    async disconnect(ctx) {
      await unsubscribe(ctx);
    },

    stale: (ctx) => webhookDue(ctx),

    /**
     * The key still works and the property is still there; and the webhooks, once the connection is kept
     * and the inbox can be reached (a hosted inbox before it goes live cannot), made at its own address,
     * or made again when that address moved. Polling finds everything meanwhile.
     */
    async refresh(ctx) {
      const list = await hotels(ctx);
      const first = list[0];
      if (!first) throw new ConnectorError("config", "Cloudbeds shows no property for this key any more.");
      const account =
        list.length > 1 ? `${str(first.propertyName)} and ${list.length - 1} more` : str(first.propertyName);
      const base = { account, calendars: [], destinations: [] };
      if (!webhookDue(ctx) || !ctx.hookUrl) return base;
      if (ctx.extra.webhook === "added") await unsubscribe(ctx);
      try {
        const subscriptions = await subscribe(ctx, ctx.hookUrl);
        return { ...base, extra: { ...ctx.extra, webhook: "added", hook_url: ctx.hookUrl, subscriptions } };
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "auth") throw error;
        const tries = Number(ctx.extra.webhook_tries ?? 0) + 1;
        const { subscriptions: _gone, ...rest } = ctx.extra;
        return { ...base, extra: { ...rest, webhook: "pending", webhook_tries: tries } };
      }
    },

    stays: {
      properties,

      async rooms(ctx, propertyId): Promise<ExternalRoom[]> {
        const units = await roomCounts(ctx, propertyId);
        const types = data(await read(ctx, "getRoomTypes", { propertyIDs: propertyId, pageSize: PAGE }));
        return types.map((t) => {
          const max = Number(t.maxGuests ?? 0);
          return {
            id: str(t.roomTypeID),
            name: str(t.roomTypeName) || str(t.roomTypeNameShort),
            units: units.get(str(t.roomTypeID)) ?? 0,
            ...(max > 0 ? { capacity: { adults: max, children: 0, total: max } } : {}),
          };
        });
      },

      async ratePlans(ctx, propertyId): Promise<ExternalRate[]> {
        const today = dateIn(ctx.now, await zoneOf(ctx, propertyId));
        const seen = new Map<string, ExternalRate>();
        for (const r of await rates(ctx, propertyId, today, addLocalDays(today, 1))) {
          const id = str(r.rateID);
          if (!id || seen.has(id)) continue;
          seen.set(id, {
            id,
            name: str(r.ratePlanNamePublic) || str(r.ratePlanNamePrivate) || "Standard",
            ...(str(r.roomTypeID) ? { roomIds: [str(r.roomTypeID)] } : {}),
          });
        }
        return [...seen.values()];
      },

      async ari(ctx, propertyId, window) {
        const total = daysBetween(window.from, window.to);
        if (total < 1) return [];
        const count = Math.min(total, MAX_NIGHTS);
        const to = addLocalDays(window.from, count);
        const currency = (await properties(ctx)).find((p) => p.id === propertyId)?.currency ?? "";
        // A rate before the property's own taxes and fees is no price to quote: the nights come without.
        const whole = await pricesAreWhole(ctx, propertyId);
        interface Row {
          roomId: string;
          night: string;
          units: number;
          prices: Record<string, number>;
          rates: number;
          blocked: number;
          noArrival: number;
          noDeparture: number;
          minStay?: number;
          maxStay?: number;
        }
        const rows = new Map<string, Row>();
        for (const r of await rates(ctx, propertyId, window.from, to)) {
          const roomId = str(r.roomTypeID);
          for (const d of Array.isArray(r.roomRateDetailed) ? (r.roomRateDetailed as Json[]) : []) {
            const night = str(d.date);
            if (night < window.from || night >= to || typeof d.roomsAvailable !== "number") continue;
            const key = `${roomId}|${night}`;
            const row =
              rows.get(key) ??
              ({
                roomId,
                night,
                units: d.roomsAvailable,
                prices: {},
                rates: 0,
                blocked: 0,
                noArrival: 0,
                noDeparture: 0,
              } as Row);
            rows.set(key, row);
            row.units = Math.min(row.units, d.roomsAvailable);
            row.rates++;
            if (d.blocked === true) {
              row.blocked++;
              continue;
            }
            if (d.closedToArrival === true) row.noArrival++;
            if (d.closedToDeparture === true) row.noDeparture++;
            if (typeof d.minLos === "number" && d.minLos > 0) row.minStay = Math.min(row.minStay ?? d.minLos, d.minLos);
            if (typeof d.maxLos === "number" && d.maxLos > 0) row.maxStay = Math.max(row.maxStay ?? d.maxLos, d.maxLos);
            const amount = whole ? minor(d.rateBase, currency) : null;
            if (amount !== null) row.prices[str(r.rateID)] = amount;
          }
        }
        const out: AriRow[] = [...rows.values()].map((r) => ({
          roomId: r.roomId,
          night: r.night,
          units: r.units,
          ...(r.blocked === r.rates ? { closed: true } : {}),
          ...(r.noArrival > 0 && r.noArrival + r.blocked === r.rates ? { noArrival: true } : {}),
          ...(r.noDeparture > 0 && r.noDeparture + r.blocked === r.rates ? { noDeparture: true } : {}),
          ...(r.minStay !== undefined ? { minStay: r.minStay } : {}),
          ...(r.maxStay !== undefined ? { maxStay: r.maxStay } : {}),
          prices: r.prices,
        }));
        return count < total ? { rows: out, until: to } : out;
      },

      async price(ctx, q) {
        if (!q.rateId) return null;
        if (!(await pricesAreWhole(ctx, q.propertyId))) return null;
        const currency = (await properties(ctx)).find((p) => p.id === q.propertyId)?.currency ?? "";
        const found = (
          await rates(ctx, q.propertyId, q.checkIn, q.checkOut, {
            roomTypeID: q.roomId,
            rateIDs: q.rateId,
            adults: q.adults,
            children: q.childrenAges.length,
          })
        ).find((r) => str(r.rateID) === q.rateId);
        const value = minor(found?.totalRate ?? found?.roomRate, currency);
        return value === null || !currency ? null : { subtotal: { value, currency } };
      },
    },

    stayWriter: {
      async put(ctx, stay, link, status): Promise<LinkState> {
        if (link?.externalId) {
          const booked = await reservation(ctx, stay.propertyId, link.externalId);
          if (!LIVE.has(booked.status))
            throw new ConnectorError("not_found", "That stay is not live in Cloudbeds any more.");
          if (booked.rooms.length !== stay.rooms.length) {
            throw new ConnectorError("refused", "The stay has another number of rooms in Cloudbeds: change it there.");
          }
          // Each room Cloudbeds holds is one of the stay's by its type and its people, never by its place
          // in the list: Cloudbeds lists the assigned rooms first.
          const match = matchRooms(
            booked.rooms.map((r) => ({ type: r.roomTypeID, people: `${r.adults}+${r.children}` })),
            stay.rooms.map((r) => ({ type: r.roomId, people: `${r.adults}+${r.childrenAges.length}` })),
          );
          const moved = booked.rooms.some((r) => r.startDate !== stay.checkIn || r.endDate !== stay.checkOut);
          if (moved || !match.same) {
            // The same live check as a new stay, counting the nights this stay holds already as its own.
            await checkFree(ctx, stay, booked.rooms);
            await write(ctx, "PUT", "putReservation", {
              propertyID: stay.propertyId,
              reservationID: link.externalId,
              rooms: booked.rooms.map((r, i) => {
                const room = stay.rooms[match.pairs[i] ?? i] as OutboundStay["rooms"][number];
                return {
                  subReservationID: r.subReservationID,
                  roomTypeID: room.roomId,
                  checkinDate: stay.checkIn,
                  checkoutDate: stay.checkOut,
                  ...people(room),
                  ...(room.rateId ? { rateID: room.rateId } : {}),
                };
              }),
            });
          }
          await setStatus(ctx, stay, link.externalId, booked.status, status);
          if (status === "confirmed") await nameGuest(ctx, stay, booked);
          return { ...link, ...(await totalAfter(ctx, stay, link.externalId)) };
        }
        // Cloudbeds takes no key of ours: a stay already written under this key is the one answered, while
        // it is live. One cancelled in Cloudbeds since holds no room: the stay was not written.
        const found = await find(ctx, stay);
        if (found?.externalId) {
          const booked = await reservation(ctx, stay.propertyId, found.externalId);
          if (!LIVE.has(booked.status)) {
            throw new ConnectorError("refused", "Cloudbeds holds that stay as cancelled: it was not written again.");
          }
          return { ...found, ...(await totalAfter(ctx, stay, found.externalId)) };
        }
        await checkFree(ctx, stay);
        const guest = status === "confirmed" ? stay.guest : undefined;
        const names = (guest?.name ?? "").trim().split(/\s+/).filter(Boolean);
        const last = names.length > 1 ? (names.pop() ?? "") : (names[0] ?? "");
        const j = await write(ctx, "POST", "postReservation", {
          propertyID: stay.propertyId,
          startDate: stay.checkIn,
          endDate: stay.checkOut,
          // Until the stay is confirmed, the guest's details stay in the inbox: Cloudbeds holds its reference.
          guestFirstName: guest ? names.join(" ") || last : "Guest",
          guestLastName: guest ? last : stay.reference,
          ...(guest?.email ? { guestEmail: guest.email } : {}),
          ...(guest?.phone ? { guestPhone: guest.phone } : {}),
          rooms: stay.rooms.map((r) => ({
            roomTypeID: r.roomId,
            quantity: 1,
            ...(r.rateId ? { roomRateID: r.rateId } : {}),
          })),
          adults: stay.rooms.map((r) => ({ roomTypeID: r.roomId, quantity: r.adults })),
          children: stay.rooms.map((r) => ({ roomTypeID: r.roomId, quantity: r.childrenAges.length })),
          paymentMethod: "cash",
          thirdPartyIdentifier: stay.key,
          sendEmailConfirmation: "false",
        });
        const id = str(j.reservationID ?? (j.data as Json | undefined)?.reservationID);
        if (!id) throw new ConnectorError("bad_response", "Cloudbeds did not say which reservation it made.");
        // Written: from here on nothing is refused, or the inbox would tell the guest no while Cloudbeds
        // holds the room. A status or a note Cloudbeds did not take leaves the reservation as it made it,
        // holding the room; the next write for the stay (paid, or let go) puts the status right.
        try {
          await setStatus(ctx, stay, id, str(j.status), status, true);
        } catch {
          // As above.
        }
        try {
          await write(ctx, "POST", "postReservationNote", {
            propertyID: stay.propertyId,
            reservationID: id,
            reservationNote: noteOf(stay),
          });
        } catch {
          // A note is for the desk: the stay stands without it.
        }
        return { externalId: id, etag: null, calendar: null, ...(await totalAfter(ctx, stay, id)) };
      },

      async cancel(ctx, link) {
        if (!link.externalId) return;
        let booked: Booked;
        try {
          booked = await reservation(ctx, "", link.externalId);
        } catch (error) {
          if (error instanceof ConnectorError && error.code === "not_found") return;
          throw error;
        }
        if (!LIVE.has(booked.status) || booked.status === "checked_in") return;
        await write(ctx, "PUT", "putReservation", {
          reservationID: link.externalId,
          status: "canceled",
          sendStatusChangeEmail: "false",
        });
      },

      find,

      async oversold(ctx, stay, link) {
        return oversoldNights(ctx, stay, link);
      },
    },

    hooks: {
      topics: CLOUDBEDS_EVENTS.map(([o, a]) => `${o}/${a}`),
      async verify(ctx, request) {
        const expected = ctx.secret.hook_secret ?? "";
        const given = request.headers.get(CLOUDBEDS_HOOK_HEADER) ?? "";
        if (!expected || !constantTimeEqual(given, expected)) {
          throw new ConnectorError("refused", "The webhook's header does not check out.");
        }
        let body: Json;
        try {
          body = JSON.parse(request.body) as Json;
        } catch {
          throw new ConnectorError("refused", "The webhook is not JSON.");
        }
        // Cloudbeds spells it both ways (its own events reference says so).
        const property = str(body.propertyID ?? body.propertyId ?? body.propertyID_str ?? body.propertyId_str);
        const mine = Array.isArray(ctx.extra.propertyIds) ? (ctx.extra.propertyIds as unknown[]).map(str) : [];
        if (!property || !mine.includes(property))
          throw new ConnectorError("refused", "The webhook is about another property.");
        const id = str(body.reservationID ?? body.reservationId);
        const event = str(body.event);
        if (!/^reservation\//.test(event) || !/^[A-Za-z0-9-]{1,40}$/.test(id)) return null;
        const digest = await sha256Hex(new TextEncoder().encode(request.body));
        return { eventId: `cloudbeds-${digest.slice(0, 40)}`, topic: event.slice(0, 60), refs: [`${property}:${id}`] };
      },
      async read(ctx, event): Promise<HookFact[]> {
        const out: HookFact[] = [];
        for (const ref of event.refs) {
          const [property = "", id = ""] = ref.split(":");
          try {
            const booked = await reservation(ctx, property, id);
            for (const room of booked.rooms) {
              if (!room.startDate || !room.endDate) continue;
              out.push({ kind: "stay_nights", roomIds: [room.roomTypeID], from: room.startDate, to: room.endDate });
            }
          } catch (error) {
            if (!(error instanceof ConnectorError && error.code === "not_found")) throw error;
            // Gone (deleted in Cloudbeds): what was it holding cannot be read, so the next months are read again.
            const today = dateIn(ctx.now, await zoneOf(ctx, property));
            out.push({ kind: "stay_nights", from: today, to: addLocalDays(today, 120) });
          }
        }
        return out;
      },
    },
  };
}
