import { APARTMENT_NOT_FOUND, apartmentObject, type FakeApartment } from "../../fixtures/property/smoobu/apartments";
import { UNAUTHORIZED } from "../../fixtures/property/smoobu/auth";
import {
  existsAlready,
  type FakeReservation,
  HOMEPAGE,
  NAMES_REQUIRED,
  NOT_FOUND,
  OTA_GUEST,
  reservationObject,
  UPDATED,
  VERIFICATION_ERROR,
} from "../../fixtures/property/smoobu/reservations";
import {
  ALREADY_REGISTERED,
  REGISTERED_ELSEWHERE,
  rateLimitHeaders,
  WEBHOOK_NOT_FOUND,
} from "../../fixtures/property/smoobu/webhooks";
import { type FakePlatform, type FakeRequest, fakePlatform } from "../platform";

/**
 * Smoobu, as a fake (ADR-037 §8): a small in-memory account speaking the documented paths of
 * <https://docs.smoobu.com/> (see the fixtures' headers for each excerpt), and never the real API.
 *
 * It checks every request the way the documentation says Smoobu does, with its own implementation of
 * the signature (never the adapter's): all four HMAC headers, a timestamp within five minutes of its
 * clock, a nonce used once, and the base64 HMAC-SHA256 under the secret of the canonical string built
 * from the request as it arrived (method, path, the query re-encoded per RFC 3986 and sorted, the
 * timestamp, the nonce, the body's SHA-256, the key). It counts requests in one-minute windows and
 * sends `X-RateLimit-*` on every answer, the window's end as a Unix time; keeps apartments, their
 * rates and bookings; refuses a create on a night a booking holds (`mode.protection: "refuses"`, as
 * the documented 400 does) or takes it (`"off"`); cancels by keeping the booking as a cancellation;
 * and keeps the webhook URLs it is given, for `deliveries`.
 *
 * It also watches what it is sent: the legacy `Api-Key` header, a request not fully signed, a nonce
 * used twice, a card field, a payment status, a fee, a commission, a booking's dates in an update, or a
 * delete of anything but a booking or a webhook are kept in `violations`, which every test expects
 * empty. Requests it refused for the key, the secret or the time are kept in `refusals`.
 *
 * Its bookings list takes the documented filters it is asked for: `from` and `to` (overlap, or arrival
 * in the range with `mode.range: "arrival"`, since the documentation does not say which),
 * `departureFrom`, `arrivalTo` and `created_from` (dropped with `mode.namedFilters: false`, as a Smoobu
 * that ignores them would), `showCancellation`, `apartmentId` and `includeRelated`.
 *
 * Invented here, for fault injection only, and not Smoobu's words: the refusal of a cancellation
 * (`mode.cancel: "refuse"`), "Bookings from this channel are cancelled on the channel."
 */

export const HOST = "login.smoobu.com";
const BASE = `https://${HOST}`;

/** Keys that never go to a property's system from this inbox: a card, a payment, a commission, a fee. */
const FORBIDDEN_KEY = /card|cvc|cvv|iban|stripe|paymentmethod|ccnumber|commission|markup/i;
/** Smoobu's payment fields: the inbox never says what was paid there, nor sets a fee. */
const PAYMENT_KEYS = new Set([
  "priceStatus",
  "prepayment",
  "prepaymentStatus",
  "deposit",
  "depositStatus",
  "priceElements",
]);
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIVE_MIN = 5 * 60_000;

export interface FakeWebhook {
  readonly id: number;
  webhookUrl: string;
  readonly createdAt: string;
}

export interface SmoobuFake {
  readonly platform: FakePlatform;
  readonly user: { readonly id: number; readonly firstName: string; readonly lastName: string; readonly email: string };
  readonly apiKey: string;
  readonly clock: { now: number };
  readonly apartments: FakeApartment[];
  readonly reservations: Map<number, FakeReservation>;
  readonly webhooks: Map<number, FakeWebhook>;
  /** A night's own price, `apartment|night` → price (null for none). */
  readonly nightPrice: Map<string, number | null>;
  readonly violations: string[];
  readonly refusals: string[];
  /** Every nonce seen, in order. */
  readonly nonces: string[];
  /** The bodies of every create and update, as received. */
  readonly writes: { method: string; path: string; body: Record<string, unknown> }[];
  /** Bookings Smoobu's lists do not show yet (read by id, they are there). */
  readonly hidden: Set<number>;
  readonly mode: {
    /** Refuse a create onto a night a booking holds (`refuses`, as documented), or take it (`off`). */
    protection: "refuses" | "off";
    /** Requests per one-minute window. */
    limit: number;
    /** Runs just after an availability check is answered: another channel's booking landing then. */
    afterCheck: (() => void) | null;
    /** A create that is stored and then never answered (`lands_then_times_out`), or a 503 (`down`). */
    write: "ok" | "lands_then_times_out" | "down";
    /** The owner's booking tool requires a first and a last name. */
    requireNames: boolean;
    /** Keeps a registered webhook URL without its query, as a stricter Smoobu might. */
    dropQuery: boolean;
    /** Answers a webhook registration as registered by another caller (409). */
    register: "ok" | "conflict";
    /** A cancellation Smoobu does not take (an invented refusal, for fault injection). */
    cancel: "ok" | "refuse";
    /** What `from` and `to` filter bookings on: overlap with the range, or arrival in it. */
    range: "overlap" | "arrival";
    /** Whether `departureFrom`, `arrivalTo` and `created_from` filter the list (false: ignored). */
    namedFilters: boolean;
    /** Runs just before the availability check is answered: time passing, for a slow answer. */
    beforeCheck: (() => void) | null;
    /** The availability check answering its documented authentication failure with a 200 (`unverified`). */
    check: "ok" | "unverified";
  };
  /** A booking another channel made, straight into the account. */
  otaBooking(
    apartmentId: number,
    arrival: string,
    departure: string,
    opts?: { readonly channel?: { id: number; name: string }; readonly blocked?: boolean },
  ): FakeReservation;
  /** Units free on a night, as the rates count them. */
  free(apartmentId: number, night: string): number;
  /** One delivery to every registered URL, as Smoobu would send it. */
  deliveries(body: string): { url: string; headers: Headers; body: string; query: URLSearchParams }[];
}

function nightsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d < Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function forbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(FORBIDDEN_KEY.test(k) || PAYMENT_KEYS.has(k) ? [`${path}${k}`] : []),
    ...forbiddenKeys(v, `${path}${k}.`),
  ]);
}

/* The fake's own signing, written from the documentation and never shared with the adapter. */

const enc = new TextEncoder();

function encode3986(s: string): string {
  let out = "";
  for (const byte of enc.encode(s)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

async function hex256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64(secret: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
  return btoa(String.fromCharCode(...sig));
}

/** The canonical string for a request as it arrived. */
export async function canonicalOf(req: { method: string; url: URL; headers: Headers; body: string }): Promise<string> {
  const pairs = [...req.url.searchParams.entries()].map(([k, v]) => [encode3986(k), encode3986(v)] as const);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return [
    req.method.toUpperCase(),
    req.url.pathname,
    pairs.map(([k, v]) => `${k}=${v}`).join("&"),
    req.headers.get("x-timestamp") ?? "",
    req.headers.get("x-nonce") ?? "",
    await hex256(req.body),
    req.headers.get("x-api-key") ?? "",
  ].join("\n");
}

export function smoobuFake(opts: {
  readonly user: { readonly id: number; readonly firstName: string; readonly lastName: string; readonly email: string };
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly apartments: readonly FakeApartment[];
}): SmoobuFake {
  const platform = fakePlatform();
  const clock = { now: Date.parse("2026-11-02T09:00:00Z") };
  const apartments = opts.apartments.map((a) => ({ ...a }));
  const reservations = new Map<number, FakeReservation>();
  const webhooks = new Map<number, FakeWebhook>();
  const nightPrice = new Map<string, number | null>();
  const violations: string[] = [];
  const refusals: string[] = [];
  const nonces: string[] = [];
  const nonceAt = new Map<string, number>();
  const writes: SmoobuFake["writes"] = [];
  const hidden = new Set<number>();
  const windows = new Map<number, number>();
  const mode: SmoobuFake["mode"] = {
    protection: "refuses",
    limit: 700,
    afterCheck: null,
    write: "ok",
    requireNames: false,
    dropQuery: false,
    register: "ok",
    cancel: "ok",
    range: "overlap",
    namedFilters: true,
    beforeCheck: null,
    check: "ok",
  };
  let reservationN = 9_000;
  let hookN = 900;

  const stamp = () => new Date(clock.now).toISOString().slice(0, 16).replace("T", " ");
  const apartmentById = (id: number) => apartments.find((a) => a.id === id);
  /** The apartments a booking of `id` holds: its own, and those grouped with it. */
  const heldBy = (id: number) => [id, ...(apartmentById(id)?.group ?? [])];
  const holders = (apartmentId: number, night: string, except?: number) =>
    [...reservations.values()].filter(
      (r) =>
        r.id !== except &&
        r.type !== "cancellation" &&
        heldBy(r.apartmentId).includes(apartmentId) &&
        r.arrival <= night &&
        night < r.departure,
    );
  const free = (apartmentId: number, night: string) =>
    holders(apartmentId, night).length > 0 ? 0 : (apartmentById(apartmentId)?.available ?? 1);

  const answer = (status: number, body: unknown, extra: Record<string, string> = {}) => {
    const start = Math.floor(clock.now / 60_000) * 60_000;
    const used = windows.get(start) ?? 0;
    const headers = { ...rateLimitHeaders(mode.limit, mode.limit - used, start + 60_000, clock.now), ...extra };
    return status === 204
      ? new Response(null, { status, headers })
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };

  /** Why Smoobu would refuse the request's signature; null when it checks out. */
  async function refusalOf(req: FakeRequest): Promise<string | null> {
    if (req.headers.has("api-key")) {
      violations.push(`legacy Api-Key header on ${req.method} ${req.url.pathname}`);
      return "legacy key";
    }
    const missing = ["x-api-key", "x-timestamp", "x-nonce", "x-signature"].filter((h) => !req.headers.get(h));
    if (missing.length > 0) {
      violations.push(`unsigned ${req.method} ${req.url.pathname}: no ${missing.join(", ")}`);
      return "missing header";
    }
    const ts = req.headers.get("x-timestamp") ?? "";
    const nonce = req.headers.get("x-nonce") ?? "";
    nonces.push(nonce);
    if (!ISO_SECOND.test(ts)) violations.push(`timestamp not ISO 8601 UTC to the second: ${ts}`);
    if (!UUID_V4.test(nonce)) violations.push(`nonce not a UUID v4: ${nonce}`);
    if (req.headers.get("x-api-key") !== opts.apiKey) return "API key not found or revoked";
    if (Math.abs(Date.parse(ts) - clock.now) > FIVE_MIN) return "expired timestamp";
    const seen = nonceAt.get(nonce);
    if (seen !== undefined && clock.now - seen <= FIVE_MIN) {
      violations.push(`nonce used twice: ${nonce}`);
      return "replayed nonce";
    }
    nonceAt.set(nonce, clock.now);
    const expected = await hmacBase64(opts.apiSecret, await canonicalOf(req));
    if (expected !== req.headers.get("x-signature")) return "invalid signature";
    return null;
  }

  type Handler = (req: FakeRequest, body: Record<string, unknown> | null) => Response | Promise<Response>;

  const route = (method: string, path: string, handler: Handler) =>
    platform.on(method, `${BASE}${path}`, async (req) => {
      const start = Math.floor(clock.now / 60_000) * 60_000;
      const used = (windows.get(start) ?? 0) + 1;
      windows.set(start, used);
      if (used > mode.limit)
        return answer(429, { status: 429, title: "Too Many Requests", detail: "Rate limit exceeded" });
      const no = await refusalOf(req);
      if (no) {
        refusals.push(no);
        return answer(401, UNAUTHORIZED);
      }
      let body: Record<string, unknown> | null = null;
      if (req.body) {
        try {
          body = JSON.parse(req.body) as Record<string, unknown>;
        } catch {
          return answer(400, { status: 400, title: "Bad Request", detail: "Malformed JSON" });
        }
        for (const k of forbiddenKeys(body)) violations.push(`${method} ${path} sent ${k}`);
      }
      return handler(req, body);
    });

  const intOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
  const dateOf = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

  const relatedOf = (r: FakeReservation) =>
    (apartmentById(r.apartmentId)?.group ?? []).map((id) => ({
      id,
      name: apartmentById(id)?.name ?? `Apartment ${id}`,
    }));
  const objectOf = (r: FakeReservation) => reservationObject(r, relatedOf(r));

  route("GET", "/api/me", () => answer(200, opts.user));

  route("GET", "/api/apartments", () =>
    answer(200, { apartments: apartments.map((a) => ({ id: a.id, name: a.name })) }),
  );

  route("GET", "/api/apartments/:id", (req) => {
    const a = apartmentById(Number(req.params.id));
    return a ? answer(200, apartmentObject(a)) : answer(500, APARTMENT_NOT_FOUND);
  });

  route("GET", "/api/rates", (req) => {
    const ids = req.url.searchParams.getAll("apartments[]").map(Number);
    const start = req.url.searchParams.get("start_date") ?? "";
    const end = req.url.searchParams.get("end_date") ?? "";
    if (ids.length === 0 || !dateOf(start) || !dateOf(end)) {
      return answer(400, { status: 400, title: "Bad Request", detail: "Failed validation" });
    }
    const data: Record<string, Record<string, unknown>> = {};
    for (const id of ids) {
      const a = apartmentById(id);
      if (!a) return answer(500, APARTMENT_NOT_FOUND);
      const days: Record<string, unknown> = {};
      for (const night of nightsBetween(start, addDays(end, 1))) {
        const key = `${id}|${night}`;
        days[night] = {
          price: nightPrice.has(key) ? (nightPrice.get(key) ?? null) : a.price,
          min_length_of_stay: a.minStay,
          available: free(id, night),
        };
      }
      data[String(id)] = days;
    }
    return answer(200, { data });
  });

  route("POST", "/booking/checkApartmentAvailability", (_req, body) => {
    const before = mode.beforeCheck;
    mode.beforeCheck = null;
    before?.();
    if (mode.check === "unverified") return answer(200, VERIFICATION_ERROR);
    const arrival = dateOf(body?.arrivalDate);
    const departure = dateOf(body?.departureDate);
    if (intOf(body?.customerId) !== opts.user.id || !arrival || !departure || departure <= arrival) {
      return answer(400, VERIFICATION_ERROR);
    }
    const asked = Array.isArray(body?.apartments) ? (body.apartments as unknown[]).map(Number) : [];
    const ids = asked.length > 0 ? asked : apartments.map((a) => a.id);
    const guests = intOf(body?.guests);
    const availableApartments: number[] = [];
    const prices: Record<string, unknown> = {};
    const errorMessages: Record<string, unknown> = {};
    const nights = nightsBetween(arrival, departure);
    for (const id of ids) {
      const a = apartmentById(id);
      if (!a) continue;
      if (nights.some((n) => free(id, n) === 0)) continue;
      if (a.minStay !== null && nights.length < a.minStay) {
        errorMessages[String(id)] = {
          errorCode: 401,
          message: "The duration of the booking is too short.",
          minimumLengthOfStay: a.minStay,
        };
        continue;
      }
      if (guests !== null && guests > a.maxOccupancy) {
        errorMessages[String(id)] = {
          errorCode: 400,
          message: "The number of guests exceeds the limit of the apartment.",
          numberOfGuest: a.maxOccupancy,
        };
        continue;
      }
      availableApartments.push(id);
      const total = nights.reduce((s, n) => s + (nightPrice.get(`${id}|${n}`) ?? a.price ?? 0), 0);
      prices[String(id)] = { price: Math.round(total), currency: a.currency };
    }
    const res = answer(200, { availableApartments, prices, errorMessages });
    const after = mode.afterCheck;
    mode.afterCheck = null;
    after?.();
    return res;
  });

  route("POST", "/api/reservations", (req, body) => {
    writes.push({ method: "POST", path: req.url.pathname, body: body ?? {} });
    const arrival = dateOf(body?.arrivalDate);
    const departure = dateOf(body?.departureDate);
    const apartmentId = intOf(body?.apartmentId);
    const a = apartmentId !== null ? apartmentById(apartmentId) : undefined;
    if (!arrival || !departure || departure <= arrival || !a || apartmentId === null) {
      return answer(400, {
        status: 400,
        title: "Bad Request",
        detail: "Failed validation",
        validation_messages: { apartmentId: { notFound: "Apartment not found" } },
      });
    }
    const channelId = body?.channelId;
    if (channelId !== undefined && ![70, 13, 14, 1, 11].includes(Number(channelId))) {
      return answer(400, {
        status: 400,
        title: "Bad Request",
        detail: "Failed validation",
        validation_messages: { error: `Channel with id ${String(channelId)} not found for user ${opts.user.id}` },
      });
    }
    if (mode.requireNames && (!body?.firstName || !body?.lastName)) return answer(400, NAMES_REQUIRED);
    if (mode.write === "down") return answer(503, { status: 503, title: "Service Unavailable", detail: "" });
    if (
      mode.protection === "refuses" &&
      nightsBetween(arrival, departure).some((n) => holders(apartmentId, n).length > 0)
    ) {
      return answer(400, existsAlready(arrival, departure));
    }
    const id = ++reservationN;
    const name = [body?.firstName, body?.lastName].filter((x) => typeof x === "string" && x).join(" ");
    reservations.set(id, {
      id,
      apartmentId,
      arrival,
      departure,
      type: "reservation",
      channel: HOMEPAGE,
      guestName: name,
      email: typeof body?.email === "string" ? body.email : null,
      phone: typeof body?.phone === "string" ? body.phone : null,
      adults: intOf(body?.adults) ?? 1,
      children: intOf(body?.children) ?? 0,
      notice: typeof body?.notice === "string" ? body.notice : "",
      price: typeof body?.price === "number" ? body.price : null,
      blocked: false,
      createdAt: stamp(),
      modifiedAt: stamp(),
      language: typeof body?.language === "string" ? body.language : null,
    });
    if (mode.write === "lands_then_times_out") throw new DOMException("The operation timed out.", "TimeoutError");
    return answer(200, { id });
  });

  route("PUT", "/api/reservations/:id", (req, body) => {
    writes.push({ method: "PUT", path: req.url.pathname, body: body ?? {} });
    const r = reservations.get(Number(req.params.id));
    if (!r) return answer(404, NOT_FOUND);
    for (const k of ["arrivalDate", "departureDate", "apartmentId", "arrival", "departure"]) {
      if (body && k in body) violations.push(`PUT ${req.url.pathname} carried ${k}, which the update does not take`);
    }
    if (typeof body?.adults === "number") r.adults = body.adults;
    if (typeof body?.children === "number") r.children = body.children;
    if (typeof body?.price === "number") r.price = body.price;
    if (typeof body?.notice === "string") r.notice = body.notice;
    if (typeof body?.guestName === "string") r.guestName = body.guestName;
    if (typeof body?.guestEmail === "string") r.email = body.guestEmail;
    if (typeof body?.guestPhone === "string") r.phone = body.guestPhone;
    r.type = r.type === "cancellation" ? r.type : "modification of booking";
    r.modifiedAt = stamp();
    return answer(200, UPDATED);
  });

  route("DELETE", "/api/reservations/:id", (req) => {
    const r = reservations.get(Number(req.params.id));
    if (!r) return answer(404, NOT_FOUND);
    if (mode.cancel === "refuse") {
      return answer(400, {
        status: 400,
        title: "Bad Request",
        detail: "Failed validation",
        validation_messages: { error: "Bookings from this channel are cancelled on the channel." },
      });
    }
    // "The booking is still in the system as a cancelled booking."
    r.type = "cancellation";
    r.modifiedAt = stamp();
    return answer(200, { success: true });
  });

  route("GET", "/api/reservations/:id", (req) => {
    const r = reservations.get(Number(req.params.id));
    return r ? answer(200, objectOf(r)) : answer(404, NOT_FOUND);
  });

  route("GET", "/api/reservations", (req) => {
    const q = req.url.searchParams;
    const apartmentId = q.has("apartmentId") ? Number(q.get("apartmentId")) : null;
    const related = q.get("includeRelated") === "true";
    const from = q.get("from");
    const to = q.get("to");
    const named = (k: string) => (mode.namedFilters ? q.get(k) : null);
    const departureFrom = named("departureFrom");
    const arrivalTo = named("arrivalTo");
    const createdFrom = named("created_from");
    const cancelled = q.get("showCancellation") === "true";
    const page = Math.max(1, Number(q.get("page") ?? 1));
    const size = Math.min(100, Math.max(1, Number(q.get("pageSize") ?? 25)));
    const all = [...reservations.values()]
      .filter((r) => !hidden.has(r.id))
      .filter((r) => cancelled || r.type !== "cancellation")
      .filter((r) => {
        if (apartmentId === null) return true;
        if (r.apartmentId === apartmentId) return true;
        return related && (heldBy(r.apartmentId).includes(apartmentId) || heldBy(apartmentId).includes(r.apartmentId));
      })
      .filter((r) =>
        mode.range === "arrival"
          ? (!from || r.arrival >= from) && (!to || r.arrival <= to)
          : (!from || r.departure > from) && (!to || r.arrival <= to),
      )
      .filter((r) => (!departureFrom || r.departure >= departureFrom) && (!arrivalTo || r.arrival <= arrivalTo))
      .filter((r) => !createdFrom || r.createdAt.slice(0, 10) >= createdFrom)
      .sort((a, b) => a.id - b.id);
    const pageOf = all.slice((page - 1) * size, page * size);
    return answer(200, {
      page_count: Math.max(1, Math.ceil(all.length / size)),
      page_size: size,
      total_items: all.length,
      page,
      bookings: pageOf.map(objectOf),
    });
  });

  route("GET", "/api/users/webhooks", () => answer(200, { webhooks: [...webhooks.values()] }));

  route("POST", "/api/users/webhooks", (_req, body) => {
    const url = typeof body?.webhookUrl === "string" ? body.webhookUrl : "";
    if (!url.startsWith("https://") || url.length > 2048) {
      return answer(422, {
        status: 422,
        title: "Bad Request",
        detail: "Failed validation",
        validation_messages: { webhookUrl: { invalid: "URL must use HTTPS in production" } },
      });
    }
    const kept = mode.dropQuery ? url.replace(/\?.*$/, "") : url;
    if ([...webhooks.values()].some((w) => w.webhookUrl === kept)) return answer(422, ALREADY_REGISTERED);
    if (mode.register === "conflict") return answer(409, REGISTERED_ELSEWHERE);
    const hook = {
      id: ++hookN,
      webhookUrl: kept,
      createdAt: new Date(clock.now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    webhooks.set(hook.id, hook);
    return answer(201, hook);
  });

  route("GET", "/api/users/webhooks/:id", (req) => {
    const w = webhooks.get(Number(req.params.id));
    return w ? answer(200, w) : answer(404, WEBHOOK_NOT_FOUND);
  });

  route("PATCH", "/api/users/webhooks/:id", (req, body) => {
    const w = webhooks.get(Number(req.params.id));
    if (!w) return answer(404, WEBHOOK_NOT_FOUND);
    if (typeof body?.webhookUrl === "string")
      w.webhookUrl = mode.dropQuery ? body.webhookUrl.replace(/\?.*$/, "") : body.webhookUrl;
    return answer(200, w);
  });

  route("DELETE", "/api/users/webhooks/:id", (req) => {
    if (!webhooks.delete(Number(req.params.id))) return answer(404, WEBHOOK_NOT_FOUND);
    return answer(204, null);
  });

  // Anything else deleted is something the adapter must never delete.
  platform.on("DELETE", `${BASE}/*`, (req) => {
    violations.push(`DELETE ${req.url.pathname}`);
    return answer(404, NOT_FOUND);
  });

  return {
    platform,
    user: opts.user,
    apiKey: opts.apiKey,
    clock,
    apartments,
    reservations,
    webhooks,
    nightPrice,
    violations,
    refusals,
    nonces,
    writes,
    hidden,
    mode,
    otaBooking(apartmentId, arrival, departure, o = {}) {
      const id = ++reservationN;
      const r: FakeReservation = {
        id,
        apartmentId,
        arrival,
        departure,
        type: "reservation",
        channel: o.channel ?? { id: 14, name: "Booking.com" },
        guestName: o.blocked ? "" : OTA_GUEST.name,
        email: o.blocked ? null : OTA_GUEST.email,
        phone: o.blocked ? null : OTA_GUEST.phone,
        adults: 2,
        children: 0,
        notice: "",
        price: o.blocked ? null : 300,
        blocked: o.blocked === true,
        createdAt: stamp(),
        modifiedAt: stamp(),
        language: "en",
      };
      reservations.set(id, r);
      return r;
    },
    free,
    deliveries(body) {
      return [...webhooks.values()].map((w) => ({
        url: w.webhookUrl,
        headers: new Headers({ "content-type": "application/json" }),
        body,
        query: new URL(w.webhookUrl).searchParams,
      }));
    },
  };
}
