import { basicAuth } from "../../../src/connectors/http";
import { fakeToken, TOKEN_DENIED, WRONG_CREDENTIALS } from "../../fixtures/property/hostaway/auth";
import { calendarDay, priceDetails } from "../../fixtures/property/hostaway/calendar";
import { type FakeListing, listingObject } from "../../fixtures/property/hostaway/listings";
import {
  BLOCKING,
  BOOKING_COM,
  DIRECT,
  type FakeReservation,
  OTA_GUEST,
  reservationObject,
} from "../../fixtures/property/hostaway/reservations";
import { deliveryBody, RATE_LIMITED, rateLimitHeaders } from "../../fixtures/property/hostaway/webhooks";
import { type FakePlatform, type FakeRequest, fakePlatform } from "../platform";

/**
 * Hostaway, as a fake (ADR-033 §8): a small in-memory account speaking the documented paths of
 * <https://api.hostaway.com/documentation> (see the fixtures' headers for each excerpt), and never the
 * real API. It issues tokens that work a second after they are issued and stop working when told
 * (403), counts requests in a sliding 10-second window and answers 429 with the documented headers,
 * keeps listings, their calendars and reservations, refuses, takes, or takes as declined a night it has
 * no room for (`mode.protection`), and delivers unified webhooks with the login and password it was given.
 *
 * It also watches what it is sent: `forceOverbooking`, a card field, a commission, a reservation
 * deleted, or a host other than the API's own are kept in `violations`, which every test expects empty.
 */

export const HOST = "api.hostaway.com";
const BASE = `https://${HOST}/v1`;

/** Keys that never go to a property's system from this inbox: a card, a payment method, a commission. */
const FORBIDDEN_KEY = /card|cvc|cvv|iban|stripe|paymentmethod|ccnumber|commission|markup/i;

export interface FakeWebhook {
  readonly id: number;
  isEnabled: number;
  url: string;
  login: string | null;
  password: string | null;
}

export interface HostawayFake {
  readonly platform: FakePlatform;
  readonly accountId: string;
  readonly clock: { now: number };
  readonly listings: FakeListing[];
  readonly reservations: Map<number, FakeReservation>;
  readonly webhooks: Map<number, FakeWebhook>;
  /** Nights a person closed, `listing|night`. */
  readonly blocked: Set<string>;
  /** A night's own price, `listing|night` → price. */
  readonly nightPrice: Map<string, number>;
  /** Units a person blocked on a multi-unit listing's night, `listing|night` → how many. */
  readonly blockedUnits: Map<string, number>;
  readonly violations: string[];
  /** Every wait the adapter asked for, in ms. */
  readonly waits: number[];
  readonly mode: {
    /**
     * Overbooking protection: refuse a night with no room (`refuses`), take it (`off`), or answer 2xx
     * and store the reservation as `declined`, holding nothing (`declines`): one shape the undocumented
     * protection could take.
     */
    protection: "refuses" | "off" | "declines";
    /** A create that is stored and then never answered (`lands_then_times_out`), or a 503 (`down`). */
    write: "ok" | "lands_then_times_out" | "down";
    /** Requests per sliding 10 seconds. */
    limit: number;
    /** Runs just before a create is decided: another channel's booking landing a moment before ours. */
    beforeCreate: (() => void) | null;
    /** Runs on every calendar read, after it was answered. */
    afterCalendar: (() => void) | null;
    /** A cancellation Hostaway does not take (`refuse`), as it might for a channel's own booking. */
    cancel: "ok" | "refuse";
  };
  /** The adapter's wait, on the fake's clock. */
  wait(ms: number): Promise<void>;
  /** A token issued long enough ago to work now. */
  issue(): string;
  /** Every token issued so far stops working (403), as an expired one does. */
  expireTokens(): void;
  /** A booking another channel made, straight into the account. */
  otaBooking(listingId: number, arrival: string, departure: string, status?: string): FakeReservation;
  /** Units free on a night, as the calendar counts them. */
  free(listingId: number, night: string): number;
  /** A unified webhook delivery to every enabled webhook, as Hostaway would send it. */
  deliveries(event: string, reservationId: number): { url: string; headers: Headers; body: string }[];
}

function nightsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d < Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

function forbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(FORBIDDEN_KEY.test(k) ? [`${path}${k}`] : []),
    ...forbiddenKeys(v, `${path}${k}.`),
  ]);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function hostawayFake(opts: {
  readonly accountId: string;
  readonly clientSecret: string;
  readonly listings: readonly FakeListing[];
}): HostawayFake {
  const platform = fakePlatform();
  const clock = { now: Date.parse("2026-11-02T09:00:00Z") };
  const tokens = new Map<string, { issuedAt: number; revoked: boolean }>();
  const listings = opts.listings.map((l) => ({ ...l }));
  const reservations = new Map<number, FakeReservation>();
  const webhooks = new Map<number, FakeWebhook>();
  const blocked = new Set<string>();
  const nightPrice = new Map<string, number>();
  const blockedUnits = new Map<string, number>();
  const violations: string[] = [];
  const waits: number[] = [];
  const hits: number[] = [];
  const mode: HostawayFake["mode"] = {
    protection: "refuses",
    write: "ok",
    limit: 200,
    beforeCreate: null,
    afterCalendar: null,
    cancel: "ok",
  };
  let tokenN = 0;
  let reservationN = 41_000;
  let hookN = 0;
  let seq = 0;

  const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", date: new Date(clock.now).toUTCString(), ...headers },
    });
  const ok = (result: unknown, more: Record<string, unknown> = {}) => send(200, { status: "success", result, ...more });
  const fail = (status: number, message: string) => send(status, { status: "fail", result: message });

  const listingOf = (id: unknown) => listings.find((l) => String(l.id) === String(id));
  const unitsOf = (l: FakeListing) => l.units ?? 1;
  /** Units left to sell on a night, before reservations: a multi-unit listing's units less those blocked. */
  const sellable = (l: FakeListing, night: string) =>
    Math.max(0, unitsOf(l) - (blockedUnits.get(`${l.id}|${night}`) ?? 0));
  const holders = (listingId: number, night: string, except?: number) =>
    [...reservations.values()].filter(
      (r) =>
        r.listingMapId === listingId &&
        r.id !== except &&
        BLOCKING.has(r.status) &&
        night >= r.arrivalDate &&
        night < r.departureDate,
    );
  const free = (listingId: number, night: string) => {
    const l = listingOf(listingId);
    if (!l || blocked.has(`${listingId}|${night}`)) return 0;
    return sellable(l, night) - holders(listingId, night).length;
  };
  const fits = (listingId: number, from: string, to: string, except?: number) =>
    nightsBetween(from, to).every((night) => {
      const l = listingOf(listingId);
      if (!l || blocked.has(`${listingId}|${night}`)) return false;
      return holders(listingId, night, except).length < sellable(l, night);
    });

  /** Every request: its host, its limit, its token, and what it carries. */
  const api =
    (handler: (req: FakeRequest) => Response | Promise<Response>, o: { readonly auth?: boolean } = {}) =>
    async (req: FakeRequest): Promise<Response> => {
      if (req.url.host !== HOST) violations.push(`host ${req.url.host}`);
      while (hits.length && hits[0] !== undefined && hits[0] <= clock.now - 10_000) hits.shift();
      if (hits.length >= mode.limit) {
        return send(429, RATE_LIMITED, rateLimitHeaders(clock.now, (hits[0] ?? clock.now) + 10_000));
      }
      hits.push(clock.now);
      if (o.auth !== false) {
        const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
        const t = tokens.get(token);
        if (!t || t.revoked || clock.now - t.issuedAt < 1_000) return send(403, TOKEN_DENIED);
      }
      if (req.url.searchParams.has("forceOverbooking")) violations.push(`forceOverbooking on ${req.url.pathname}`);
      if (req.body && req.headers.get("content-type")?.includes("json")) {
        try {
          for (const k of forbiddenKeys(JSON.parse(req.body)))
            violations.push(`${req.method} ${req.url.pathname}: ${k}`);
        } catch {
          return fail(400, "Invalid JSON");
        }
      }
      return handler(req);
    };

  const issue = (issuedAt: number) => {
    const token = fakeToken(++tokenN);
    tokens.set(token, { issuedAt, revoked: false });
    return token;
  };

  platform
    .on(
      "POST",
      `${BASE}/accessTokens`,
      api(
        (req) => {
          const form = new URLSearchParams(req.body);
          if (
            form.get("grant_type") !== "client_credentials" ||
            form.get("scope") !== "general" ||
            form.get("client_id") !== opts.accountId ||
            form.get("client_secret") !== opts.clientSecret
          ) {
            return send(401, WRONG_CREDENTIALS);
          }
          return send(200, { token_type: "Bearer", expires_in: 63_072_000, access_token: issue(clock.now) });
        },
        { auth: false },
      ),
    )
    .on(
      "DELETE",
      `${BASE}/accessTokens`,
      api(
        (req) => {
          const t = tokens.get(req.url.searchParams.get("token") ?? "");
          if (t) t.revoked = true;
          return ok([]);
        },
        { auth: false },
      ),
    )
    .on(
      "GET",
      `${BASE}/listings`,
      api((req) => {
        const limit = Math.min(Number(req.url.searchParams.get("limit") || 100), 500);
        const offset = Number(req.url.searchParams.get("offset") || 0);
        const active = req.url.searchParams.getAll("specialStatus[]").includes("active");
        const all = listings.filter((l) => !active || l.specialStatus !== "archived");
        const page = all.slice(offset, offset + limit);
        return ok(page.map(listingObject), {
          limit,
          offset,
          count: all.length,
          page: Math.floor(offset / limit) + 1,
          totalPages: Math.max(1, Math.ceil(all.length / limit)),
        });
      }),
    )
    .on(
      "GET",
      `${BASE}/listings/:id/calendar`,
      api((req) => {
        const l = listingOf(req.params.id);
        if (!l) return fail(404, "Listing not found");
        const start = req.url.searchParams.get("startDate") ?? "";
        const end = req.url.searchParams.get("endDate") ?? "";
        if (!DATE.test(start) || !DATE.test(end)) return fail(400, "Invalid dates");
        const withResources = req.url.searchParams.get("includeResources") === "1";
        // endDate included, as the documented month example (09-01 to 09-30) suggests.
        const nights = nightsBetween(
          start,
          new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
        );
        const days = nights.map((night, i) => {
          const h = holders(l.id, night);
          const closed = blocked.has(`${l.id}|${night}`);
          const status = closed
            ? "blocked"
            : h.length >= sellable(l, night)
              ? h.some((r) => r.status === "pending")
                ? "pending"
                : "reserved"
              : "available";
          return calendarDay({
            id: l.id * 1000 + i,
            date: night,
            status,
            price: nightPrice.get(`${l.id}|${night}`) ?? l.price,
            minimumStay: l.minNights,
            multi: l.units
              ? {
                  units: l.units,
                  left: Math.max(0, sellable(l, night) - h.length),
                  pending: h.filter((r) => r.status === "pending").length,
                  blocked: blockedUnits.get(`${l.id}|${night}`) ?? 0,
                }
              : undefined,
            reservations: withResources ? h.map((r) => ({ ...reservationObject(r), ...OTA_GUEST })) : [],
          });
        });
        const answer = ok(days);
        mode.afterCalendar?.();
        return answer;
      }),
    )
    .on(
      "POST",
      `${BASE}/listings/:id/calendar/priceDetails`,
      api((req) => {
        const l = listingOf(req.params.id);
        if (!l) return fail(404, "Listing not found");
        const body = JSON.parse(req.body) as { startingDate?: string; endingDate?: string; version?: number };
        if (body.version !== 2 || !DATE.test(body.startingDate ?? "") || !DATE.test(body.endingDate ?? "")) {
          return fail(400, "Invalid request");
        }
        const prices = nightsBetween(body.startingDate ?? "", body.endingDate ?? "").map(
          (n) => nightPrice.get(`${l.id}|${n}`) ?? l.price,
        );
        return ok(priceDetails(prices, l.cleaningFee, l.weeklyOff));
      }),
    )
    .on(
      "GET",
      `${BASE}/reservations`,
      api((req) => {
        const q = req.url.searchParams;
        const limit = Math.min(Number(q.get("limit") || 100), 500);
        const found = [...reservations.values()]
          .filter((r) => !q.get("listingId") || String(r.listingMapId) === q.get("listingId"))
          .filter((r) => !q.get("channelId") || String(r.channelId) === q.get("channelId"))
          .filter((r) => !q.get("arrivalStartDate") || r.arrivalDate >= (q.get("arrivalStartDate") ?? ""))
          .filter((r) => !q.get("arrivalEndDate") || r.arrivalDate <= (q.get("arrivalEndDate") ?? ""))
          .sort((a, b) => b.updatedOn - a.updatedOn);
        return ok(found.slice(0, limit).map(reservationObject), { limit, offset: 0, count: found.length });
      }),
    )
    .on(
      "GET",
      `${BASE}/reservations/:id`,
      api((req) => {
        const r = reservations.get(Number(req.params.id));
        return r ? ok(reservationObject(r)) : fail(404, "Reservation not found");
      }),
    )
    .on(
      "POST",
      `${BASE}/reservations`,
      api(async (req) => {
        const provider = req.url.searchParams.get("provider");
        if (provider !== null && provider.length > 50) return fail(400, "provider is limited to 50 characters");
        const body = JSON.parse(req.body) as Record<string, unknown>;
        if (![DIRECT, 2002, 2020].includes(Number(body.channelId))) return fail(400, "Unsupported channelId");
        const l = listingOf(body.listingMapId);
        if (!l || l.specialStatus === "archived") return fail(400, "Listing not found");
        const arrival = String(body.arrivalDate ?? "");
        const departure = String(body.departureDate ?? "");
        if (!DATE.test(arrival) || !DATE.test(departure) || arrival >= departure) return fail(400, "Invalid dates");
        if (mode.write === "down") return send(503, { status: "fail", result: "Service unavailable" });
        mode.beforeCreate?.();
        const forced = req.url.searchParams.has("forceOverbooking");
        const room = fits(l.id, arrival, departure);
        if (!room && mode.protection === "refuses" && !forced) {
          return fail(400, "The listing is not available for these dates");
        }
        const r: FakeReservation = {
          id: ++reservationN,
          listingMapId: l.id,
          channelId: Number(body.channelId),
          source: provider,
          status: !room && mode.protection === "declines" && !forced ? "declined" : "new",
          arrivalDate: arrival,
          departureDate: departure,
          previousArrivalDate: null,
          previousDepartureDate: null,
          hostNote: typeof body.hostNote === "string" ? body.hostNote : null,
          guestNote: typeof body.guestNote === "string" ? body.guestNote : null,
          guestName: typeof body.guestName === "string" ? body.guestName : null,
          guestEmail: typeof body.guestEmail === "string" ? body.guestEmail : null,
          phone: typeof body.phone === "string" ? body.phone : null,
          numberOfGuests: Number(body.numberOfGuests ?? 1),
          adults: Number(body.adults ?? 1),
          children: typeof body.children === "number" ? body.children : null,
          totalPrice: typeof body.totalPrice === "number" ? body.totalPrice : null,
          currency: typeof body.currency === "string" ? body.currency : null,
          cancelledBy: null,
          cancellationDate: null,
          updatedOn: ++seq,
        };
        reservations.set(r.id, r);
        if (mode.write === "lands_then_times_out") throw new DOMException("The operation timed out.", "TimeoutError");
        return ok(reservationObject(r));
      }),
    )
    .on(
      "PUT",
      `${BASE}/reservations/:id/statuses/cancelled`,
      api((req) => {
        const r = reservations.get(Number(req.params.id));
        if (!r) return fail(404, "Reservation not found");
        const body = JSON.parse(req.body || "{}") as { cancelledBy?: unknown };
        if (body.cancelledBy !== "host" && body.cancelledBy !== "guest")
          return fail(400, "cancelledBy is host or guest");
        if (mode.cancel === "refuse") return fail(400, "Reservation can not be cancelled");
        r.status = "cancelled";
        r.cancelledBy = body.cancelledBy;
        r.cancellationDate = new Date(clock.now).toISOString().slice(0, 10);
        r.updatedOn = ++seq;
        return ok(reservationObject(r));
      }),
    )
    .on(
      "PUT",
      `${BASE}/reservations/:id`,
      api((req) => {
        const r = reservations.get(Number(req.params.id));
        if (!r) return fail(404, "Reservation not found");
        const body = JSON.parse(req.body) as Record<string, unknown>;
        if (body.listingMapId !== undefined && Number(body.listingMapId) !== r.listingMapId) {
          return fail(400, "It is not possible to update the listingMapId of a reservation");
        }
        const arrival = typeof body.arrivalDate === "string" ? body.arrivalDate : r.arrivalDate;
        const departure = typeof body.departureDate === "string" ? body.departureDate : r.departureDate;
        if (!DATE.test(arrival) || !DATE.test(departure) || arrival >= departure) return fail(400, "Invalid dates");
        const forced = req.url.searchParams.has("forceOverbooking");
        if (!fits(r.listingMapId, arrival, departure, r.id) && mode.protection === "refuses" && !forced) {
          return fail(400, "The listing is not available for these dates");
        }
        if (arrival !== r.arrivalDate || departure !== r.departureDate) {
          r.previousArrivalDate = r.arrivalDate;
          r.previousDepartureDate = r.departureDate;
          r.arrivalDate = arrival;
          r.departureDate = departure;
          if (r.status === "new") r.status = "modified";
        }
        // A subset is sent, as in the documented example: what is not sent is kept.
        for (const k of ["hostNote", "guestNote", "guestName", "guestEmail", "phone", "currency"] as const) {
          if (typeof body[k] === "string") (r as unknown as Record<string, unknown>)[k] = body[k];
        }
        for (const k of ["numberOfGuests", "adults", "children", "totalPrice"] as const) {
          if (typeof body[k] === "number") (r as unknown as Record<string, unknown>)[k] = body[k];
        }
        r.updatedOn = ++seq;
        return ok(reservationObject(r));
      }),
    )
    .on(
      "DELETE",
      `${BASE}/reservations/:id`,
      api((req) => {
        violations.push(`DELETE reservation ${req.params.id}`);
        reservations.delete(Number(req.params.id));
        return ok([]);
      }),
    )
    .on(
      "GET",
      `${BASE}/webhooks/unifiedWebhooks`,
      api(() => ok([...webhooks.values()].map((w) => ({ ...w, password: w.password ? "****" : null })))),
    )
    .on(
      "POST",
      `${BASE}/webhooks/unifiedWebhooks`,
      api((req) => {
        const body = JSON.parse(req.body) as Partial<FakeWebhook>;
        if (typeof body.url !== "string" || !body.url.startsWith("https://")) return fail(400, "Invalid url");
        const w: FakeWebhook = {
          id: ++hookN,
          isEnabled: body.isEnabled === 0 ? 0 : 1,
          url: body.url,
          login: body.login ?? null,
          password: body.password ?? null,
        };
        webhooks.set(w.id, w);
        return ok({ ...w, password: w.password ? "****" : null });
      }),
    )
    .on(
      "GET",
      `${BASE}/webhooks/unifiedWebhooks/:id`,
      api((req) => {
        const w = webhooks.get(Number(req.params.id));
        return w ? ok({ ...w, password: w.password ? "****" : null }) : fail(404, "Webhook not found");
      }),
    )
    .on(
      "PUT",
      `${BASE}/webhooks/unifiedWebhooks/:id`,
      api((req) => {
        const w = webhooks.get(Number(req.params.id));
        if (!w) return fail(404, "Webhook not found");
        const body = JSON.parse(req.body) as Partial<FakeWebhook>;
        if (typeof body.isEnabled === "number") w.isEnabled = body.isEnabled;
        if (typeof body.url === "string") w.url = body.url;
        if (body.login !== undefined) w.login = body.login;
        if (body.password !== undefined) w.password = body.password;
        return ok({ ...w, password: w.password ? "****" : null });
      }),
    )
    .on(
      "DELETE",
      `${BASE}/webhooks/unifiedWebhooks/:id`,
      api((req) => {
        webhooks.delete(Number(req.params.id));
        return ok([]);
      }),
    );

  return {
    platform,
    accountId: opts.accountId,
    clock,
    listings,
    reservations,
    webhooks,
    blocked,
    nightPrice,
    blockedUnits,
    violations,
    waits,
    mode,
    async wait(ms) {
      waits.push(ms);
      clock.now += ms;
    },
    issue: () => issue(clock.now - 60_000),
    expireTokens() {
      for (const t of tokens.values()) t.revoked = true;
    },
    otaBooking(listingId, arrival, departure, status = "new") {
      const r: FakeReservation = {
        id: ++reservationN,
        listingMapId: listingId,
        channelId: BOOKING_COM,
        source: null,
        status,
        arrivalDate: arrival,
        departureDate: departure,
        previousArrivalDate: null,
        previousDepartureDate: null,
        hostNote: null,
        guestNote: null,
        guestName: OTA_GUEST.guestName,
        guestEmail: OTA_GUEST.guestEmail,
        phone: OTA_GUEST.phone,
        numberOfGuests: 2,
        adults: 2,
        children: null,
        totalPrice: 500,
        currency: listingOf(listingId)?.currencyCode ?? null,
        cancelledBy: null,
        cancellationDate: null,
        updatedOn: ++seq,
      };
      reservations.set(r.id, r);
      return r;
    },
    free,
    deliveries(event, reservationId) {
      const r = reservations.get(reservationId);
      return [...webhooks.values()]
        .filter((w) => w.isEnabled)
        .map((w) => ({
          url: w.url,
          headers: new Headers({
            "content-type": "application/json",
            ...(w.login && w.password ? { authorization: basicAuth(w.login, w.password) } : {}),
          }),
          body: deliveryBody({
            event,
            accountId: Number(opts.accountId),
            object: "reservation",
            objectId: reservationId,
            listingMapId: r?.listingMapId ?? null,
            data: r ? reservationObject(r) : null,
          }),
        }));
    },
  };
}
