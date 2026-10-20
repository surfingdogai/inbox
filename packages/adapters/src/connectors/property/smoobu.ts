import {
  type AriRow,
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  decimalOf,
  type ExternalProperty,
  type ExternalRate,
  type ExternalRoom,
  type HookEvent,
  type HookFact,
  type InboundRequest,
  type OutboundStay,
  parseDecimal,
  type RunContext,
  type StayPriceQuery,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { hmacSha256Base64 } from "../hook-sign";
import { constantTimeEqual } from "../pay-sign";

/**
 * Smoobu (ADR-033 §8), a vacation-rental property management system and channel manager, over its
 * REST API with the owner's own HMAC API key and secret. Built from <https://docs.smoobu.com/> as it
 * read on 20 October 2026 (the excerpt behind each fixture is kept in its header); never called from
 * here with a real account, and Smoobu is never contacted by this code.
 *
 * - **Access.** HMAC only (Settings → Advanced → API Keys): every request carries `X-API-Key`,
 *   `X-Timestamp` (UTC, ISO 8601, within five minutes of Smoobu's clock), `X-Nonce` (a UUID v4, never
 *   used twice) and `X-Signature`, the base64 HMAC-SHA256 under the API secret of the canonical string
 *   the documentation's own example builds: method, path, the query sorted with each key and value
 *   encoded per RFC 3986, the timestamp, the nonce, the lowercase hex SHA-256 of the exact body (of
 *   nothing for a request without one) and the API key, one per line (`smoobuCanonical`, pinned by the
 *   documentation's two examples in the tests). The legacy `Api-Key` header stops working on
 *   31 October 2026 and is never sent. A 401 whose answer is dated more than four minutes from the
 *   time we signed is our clock: the request is signed again once on Smoobu's time, with a new nonce.
 * - **Rooms.** Smoobu's apartments are what it rents, one unit each. The apartments that share a
 *   currency, a time zone and a town are one property here, under its first apartment's id (as
 *   Hostaway's listings are), so a pin moved or a town renamed in Smoobu does not lose it. Smoobu says
 *   how many people an apartment sleeps (`maxOccupancy`), not how many may be children, so any of them
 *   but one may be. An apartment with no currency is left out; one with no time zone (documented as
 *   possibly `null`) keeps the property's own.
 * - **What is free.** `GET /api/rates`, one apartment at a time (so the canonical query never holds a
 *   key twice), in pieces of 92 nights: a night is free while `available` is above 0, sold as one unit
 *   whatever the count, with its minimum stay and its nightly price as the one rate, `nightly`.
 *   `end_date` is included (the example answers it), so the last night wanted is asked for.
 * - **Writing a stay.** A live `POST /booking/checkApartmentAvailability` (no `/api` prefix) just
 *   before each write, then `POST /api/reservations` on Smoobu's default channel, at the price the
 *   inbox gives, in the apartment's own currency. The documentation shows a create refused when a
 *   reservation exists already, but does not promise it: every write is read back
 *   (`check_then_write`), counting the bookings on its nights (blocked periods and grouped apartments
 *   included) against the one unit, and the inbox takes its own write back on a conflict. There is no
 *   idempotency key: our key rides in the reservation's `notice`, and a write is looked for by it
 *   before it is made again.
 * - **Holds.** Smoobu documents none (`hold: none`): a stay written while its deposit is due is an
 *   ordinary reservation marked so in its notice, which holds its nights until it is paid or cancelled.
 * - **Changes.** `PUT /api/reservations/{id}` takes guests, the price, the guest's details and notes,
 *   never the dates or the apartment: a change of nights is refused here, the stay keeps its nights
 *   in both places, and the owner makes it in Smoobu, where the inbox reads it back.
 * - **Cancelling.** `DELETE /api/reservations/{id}`, which the documentation says keeps the booking
 *   "in the system as a cancelled booking": a cancellation, never a removal; it is still found by key.
 * - **Webhooks.** Every URL a user registers (`/api/users/webhooks`) receives every event, so this
 *   adapter keeps only reservation and rate events for its own user, and answers the rest unread.
 *   Smoobu documents no delivery signing: the address names the connection by its token, and the
 *   address registered carries a second secret made here (`k`), compared in constant time. The body
 *   is only a hint: what it names is read again with the owner's key.
 * - **Limits.** 700 requests a minute (lowered from 1000 on 17 September 2026), `X-RateLimit-Limit`,
 *   `X-RateLimit-Remaining` and `X-RateLimit-Retry-After`, the window's end as a Unix time, never a
 *   delay; a 429 waits until then.
 * - **Hosts.** Only `login.smoobu.com`; nothing an answer names (a guest app link) is ever followed.
 *
 * **Switched on by one constant** (`SMOOBU_READY`). Smoobu's documentation asks "Please contact us
 * before you start coding", and asks providers with solutions for more than one user to get in touch.
 * Each owner makes their own key for their own inbox, so the connection works without that; the
 * founder may hold it at "Needs setup" until he has spoken with Smoobu by setting it to false.
 */

/** Whether this release offers Smoobu. False: the gallery shows it as Needs setup, with nothing to press. */
export const SMOOBU_READY = true;

export const SMOOBU_API = "https://login.smoobu.com";
/** The only hosts this adapter calls: constants, never from input or from an answer (SSRF). */
export const SMOOBU_HOSTS: readonly string[] = ["login.smoobu.com"];
/** How this adapter guards a write and holds a stay, as ADR-033 names them. */
export const SMOOBU_GUARDS = { writeGuard: "check_then_write", hold: "none" } as const;
/** The one rate an apartment's calendar prices: its nightly price. */
export const SMOOBU_RATE = "nightly";
/** The webhook actions read; every other one (messages, check-in, price elements) is answered unread. */
export const SMOOBU_ACTIONS: readonly string[] = [
  "newReservation",
  "updateReservation",
  "cancelReservation",
  "deleteReservation",
  "updateRates",
];
/** Where the owner reads about it, and why it may say Needs setup. */
export const SMOOBU_DOCS = "https://surfingdog.ai/docs/smoobu/";
/** A request signed more than this far from Smoobu's own clock is signed again on its time (it allows five minutes). */
const SKEW_MS = 4 * 60_000;
/** A write's own limit, under the inbox's 20 seconds for the whole write, so the two end together. */
const WRITE_TIMEOUT_MS = 15_000;
/** At most this many nights in one rates read: the documentation sets no bound, so the answers stay small. */
const RATES_CHUNK = 92;
/** Reservations read back before a write and after it look this far before the stay's first night. */
const LOOK_BEFORE_DAYS = 90;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_APARTMENTS = 200;
const HOOK_DEDUPE_MS = 10 * 60_000;
const WEBHOOK_RETRY_MS = 6 * 3_600_000;
/** The longest stay a webhook's dates are taken as a hint for; anything longer is read from the next months. */
const MAX_HINT_NIGHTS = 400;
/** Our key in the notice: `[sd-…]`. */
const MARKER = /\[(sd-[0-9A-Za-z-]{1,120})\]/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The notice a stay is written with, in the owner's language: what it is, and whether its deposit is due. */
const NOTICE: Readonly<Record<string, readonly [string, string]>> = {
  en: ["Direct booking", "Direct booking, deposit due"],
  es: ["Reserva directa", "Reserva directa, depósito pendiente"],
  fr: ["Réservation directe", "Réservation directe, acompte dû"],
  de: ["Direktbuchung", "Direktbuchung, Anzahlung offen"],
  it: ["Prenotazione diretta", "Prenotazione diretta, acconto dovuto"],
  pt: ["Reserva direta", "Reserva direta, sinal por pagar"],
};
const NOTICE_PREFIXES = Object.values(NOTICE).flat();

export const smoobuForm = z.object({
  api_key: secretField(
    z
      .string()
      .trim()
      .min(8, "the API key Smoobu showed, in full")
      .max(200)
      .regex(/^[A-Za-z0-9._~-]+$/, "the API key Smoobu showed, in full"),
    {
      label: "API key",
      link: { href: "https://login.smoobu.com", text: "Open Smoobu" },
      placeholder: "usr_live_…",
      steps: [
        "In Smoobu, open Settings → Advanced → API Keys.",
        "Press Create API Key and name it Inbox.",
        "Press Generate Secret, then copy the API key and the API secret here. The secret is shown only once.",
      ],
    },
  ),
  api_secret: secretField(
    z
      .string()
      .trim()
      .min(16, "the API secret Smoobu showed, in full")
      .max(400)
      .regex(/^[\x21-\x7e]+$/, "the API secret Smoobu showed, in full"),
    { label: "API secret", help: "Lost it? Generate a new secret in Smoobu." },
  ),
});

export interface SmoobuOptions {
  /** Whether it is offered here; `SMOOBU_READY` unless a test says otherwise. */
  readonly ready?: boolean | undefined;
  /** The clock requests are signed by (milliseconds). Tests pass their own. */
  readonly clock?: (() => number) | undefined;
  /** A new nonce for each request: a UUID v4. Tests pass their own. */
  readonly nonce?: (() => string) | undefined;
}

/* --- signing ------------------------------------------------------------------- */

const encoder = new TextEncoder();

/** A key or a value as RFC 3986 has it: a space is `%20`, never `+`; `[]` is `%5B%5D`. */
export function rfc3986(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A query as it is sent and as it is signed: each key and value encoded per RFC 3986, sorted by key
 * (then value), joined with `&`. The documentation's example sorts `to, from` into `from=…&to=…`.
 */
export function smoobuQuery(params: readonly (readonly [string, string])[]): string {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** A time as Smoobu takes it: UTC, ISO 8601, to the second (`2026-04-01T12:00:00Z`). */
export function smoobuTimestamp(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * The string Smoobu's signature is over, exactly as its documentation's example builds it:
 * `METHOD\nPATH\nQUERY\nTIMESTAMP\nNONCE\nBODY_HASH\nAPI_KEY`, with no line after the last.
 */
export function smoobuCanonical(p: {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodyHash: string;
  readonly apiKey: string;
}): string {
  return [p.method.toUpperCase(), p.path, p.query, p.timestamp, p.nonce, p.bodyHash, p.apiKey].join("\n");
}

/** The four headers a request to Smoobu carries, signed over its method, path, query, time, nonce and body. */
export async function smoobuHeaders(p: {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: string;
  readonly timestamp: string;
  readonly nonce: string;
}): Promise<Record<string, string>> {
  const canonical = smoobuCanonical({
    method: p.method,
    path: p.path,
    query: p.query,
    timestamp: p.timestamp,
    nonce: p.nonce,
    bodyHash: await sha256Hex(p.body),
    apiKey: p.apiKey,
  });
  return {
    "X-API-Key": p.apiKey,
    "X-Timestamp": p.timestamp,
    "X-Nonce": p.nonce,
    "X-Signature": await hmacSha256Base64(p.apiSecret, canonical),
  };
}

/* --- limits -------------------------------------------------------------------- */

/** When the answer was served: its own `Date`, so a clock that is off here does not stretch a wait. */
function servedAt(headers: Headers, now: number): number {
  const d = Date.parse(headers.get("date") ?? "");
  return Number.isFinite(d) ? d : now;
}

/**
 * How long Smoobu asked to wait, from `X-RateLimit-Retry-After`: "Current window expire time in Unix
 * timestamp", never a delay. Measured against the answer's own `Date` when it has one. A value too
 * small to be a time is read as seconds; none at all waits out the one-minute window. Within one
 * second and one hour.
 */
export function smoobuRetryAfterMs(headers: Headers, now: number): number {
  const raw = headers.get("x-ratelimit-retry-after")?.trim() ?? "";
  const at = raw && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  const base = servedAt(headers, now);
  let ms: number;
  if (!Number.isFinite(at)) ms = 60_000;
  else if (at >= 1e12) ms = at - base;
  else if (at >= 1e9) ms = at * 1000 - base;
  else ms = at * 1000;
  return Math.min(Math.max(Math.ceil(ms), 1_000), 3_600_000);
}

/** What the window has left, from any answer's `X-RateLimit-*` headers; null when it carries none. */
export function smoobuBudget(
  headers: Headers,
  now: number,
): { readonly limit: number | null; readonly remaining: number; readonly resetsInMs: number } | null {
  const left = headers.get("x-ratelimit-remaining")?.trim() ?? "";
  if (!/^\d{1,9}$/.test(left)) return null;
  const limit = headers.get("x-ratelimit-limit")?.trim() ?? "";
  return {
    limit: /^\d{1,9}$/.test(limit) ? Number(limit) : null,
    remaining: Number(left),
    resetsInMs: smoobuRetryAfterMs(headers, now),
  };
}

/* --- reading answers ------------------------------------------------------------ */

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** An id Smoobu gave: a positive integer, as a string. */
function idOf(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^[1-9]\d{0,14}$/.test(s) ? s : null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateOf(v: unknown): string | null {
  return typeof v === "string" && DATE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ? v : null;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function nightsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}

/** A night as the owner reads it: "3 Nov 2026", never an ISO date. */
function dayOf(night: string): string {
  const [y, m, d] = night.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** An amount Smoobu gave in currency units (a JSON number) as minor units; null when it is not one. */
export function smoobuMinor(value: unknown, currency: string): number | null {
  const n = num(value);
  if (n === null || n < 0) return null;
  // A JSON number prints as the decimal it was written as (6500.5); a part below the minor unit is refused.
  return parseDecimal(String(n), currency);
}

/** Minor units as the JSON number Smoobu takes (650050 INR → 6500.5); null for a currency without an exponent. */
function smoobuAmount(value: number, currency: string): number | null {
  const d = decimalOf(value, currency);
  return d === null ? null : Number(d);
}

function parsed(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return undefined;
  }
}

/** The first message in Smoobu's `validation_messages`, however deep it is nested. */
function firstMessage(v: unknown, depth = 0): string | null {
  if (typeof v === "string") return str(v);
  if (depth > 3 || !v || typeof v !== "object") return null;
  for (const x of Array.isArray(v) ? v : Object.values(v as Json)) {
    const m = firstMessage(x, depth + 1);
    if (m) return m;
  }
  return null;
}

/** Smoobu's own words, for the owner: never a bare status code. */
function said(json: unknown, otherwise: string): string {
  const j = obj(json);
  const generic = /^(failed validation|bad request|error occurred|internal server error)$/i;
  const detail = str(j?.detail);
  const m =
    firstMessage(j?.validation_messages) ??
    (detail && !generic.test(detail) ? detail : null) ??
    str(j?.message) ??
    detail ??
    str(j?.title);
  return m ? `Smoobu said: ${m.slice(0, 200)}` : otherwise;
}

/* --- what Smoobu keeps ------------------------------------------------------------ */

interface Apartment {
  readonly id: string;
  readonly name: string;
  readonly currency: string | null;
  readonly timezone: string | null;
  readonly city: string | null;
  readonly sleeps: number | null;
  readonly beds: readonly { readonly type: string; readonly count: number }[];
}

/** Smoobu's bed counts, as the inbox names beds. */
const BEDS: readonly (readonly [string, string])[] = [
  ["doubleBeds", "double"],
  ["singleBeds", "single"],
  ["queenSizeBeds", "queen"],
  ["kingSizeBeds", "king"],
  ["sofaBeds", "sofa_bed"],
  ["childBeds", "cot"],
];

function apartmentOf(id: string, name: string, raw: unknown): Apartment {
  const a = obj(raw) ?? {};
  const rooms = obj(a.rooms) ?? {};
  const currency = str(a.currency)?.toUpperCase() ?? null;
  const beds: { type: string; count: number }[] = [];
  for (const [k, type] of BEDS) {
    const n = num(rooms[k]);
    if (n !== null && n > 0 && Number.isInteger(n)) beds.push({ type, count: Math.min(n, 50) });
  }
  const sleeps = num(rooms.maxOccupancy);
  return {
    id,
    name,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    timezone: str(a.timeZone),
    city: str(obj(a.location)?.city),
    sleeps: sleeps !== null && sleeps > 0 && Number.isInteger(sleeps) ? Math.min(sleeps, 100) : null,
    beds,
  };
}

/** Which property an apartment is in: the apartments that share a currency, a time zone and a town. */
function propertyKey(a: Apartment): string | null {
  if (!a.currency) return null;
  const town = (a.city ?? "").normalize("NFC").trim().toLowerCase();
  return `${a.currency}@${a.timezone ?? ""}@${town}`;
}

/** A property's id: its first apartment's id, the one that stays when a town or a zone is edited. */
function anchorOf(as: readonly Apartment[]): Apartment | undefined {
  let first: Apartment | undefined;
  for (const a of as) if (!first || Number(a.id) < Number(first.id)) first = a;
  return first;
}

interface Reservation {
  readonly id: string;
  readonly apartmentId: string | null;
  /** `reservation`, `modification of booking` or `cancellation`. */
  readonly type: string;
  readonly arrival: string | null;
  readonly departure: string | null;
  readonly notice: string | null;
  /** Other apartments this booking blocks (grouped apartments). */
  readonly related: readonly string[];
}

function reservationOf(raw: unknown): Reservation | null {
  const r = obj(raw);
  const id = r ? idOf(r.id) : null;
  if (!r || !id) return null;
  const related: string[] = [];
  for (const x of Array.isArray(r.related) ? (r.related as unknown[]) : []) {
    const a = idOf(obj(x)?.id);
    if (a) related.push(a);
  }
  return {
    id,
    apartmentId: idOf(obj(r.apartment)?.id),
    type: (str(r.type) ?? "reservation").toLowerCase(),
    arrival: dateOf(r.arrival),
    departure: dateOf(r.departure),
    notice: typeof r.notice === "string" ? r.notice : null,
    related,
  };
}

/** Whether a booking holds its nights: every one but a cancellation (an unknown type holds them). */
function holds(r: Reservation): boolean {
  return r.type !== "cancellation";
}

/** Whether a booking holds one apartment's nights: its own, or one it blocks besides (grouped apartments). */
function holdsOn(r: Reservation, apartmentId: string): boolean {
  return holds(r) && (r.apartmentId === apartmentId || r.related.includes(apartmentId));
}

function noticeOf(stay: OutboundStay, key: string, provisional: boolean, language: string): string {
  const words = NOTICE[language.slice(0, 2).toLowerCase()] ?? NOTICE.en ?? ["Direct booking", "Direct booking"];
  const head = `${provisional ? words[1] : words[0]} · ref ${stay.reference} [${key}]`;
  // The guest's own words go only with the guest, once the stay is confirmed.
  return stay.guest && stay.notes ? `${head}\n${stay.notes.slice(0, 2_000)}` : head;
}

/** Whether a notice is one this inbox wrote (and may write again): its own words and a key. */
function ownNotice(notice: string | null): boolean {
  return !!notice && NOTICE_PREFIXES.some((p) => notice.startsWith(p)) && MARKER.test(notice);
}

/** A guest's name as Smoobu's create takes it: the last word as the last name. */
function namesOf(name: string): { firstName?: string; lastName: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const last = words.pop() ?? "";
  return words.length > 0
    ? { firstName: words.join(" ").slice(0, 100), lastName: last.slice(0, 100) }
    : { lastName: last.slice(0, 100) };
}

/* --- secrets ------------------------------------------------------------------- */

function randomPart(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The second secret on the address registered with Smoobu, made here and never shown. */
export function newHookKey(): string {
  return randomPart(32);
}

/** The address registered with Smoobu: the connection's own, with its second secret as `k`. */
export function smoobuWebhookUrl(hookUrl: string, key: string): string {
  const u = new URL(hookUrl);
  u.searchParams.set("k", key);
  return u.toString();
}

/* --- the adapter ----------------------------------------------------------------- */

interface Caller {
  readonly http: ConnectContext["http"];
  readonly now: number;
  readonly secret: Readonly<Record<string, string>>;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
  readonly inbox?: ConnectContext["inbox"] | undefined;
}

interface Answer {
  readonly res: ConnectorHttpResponse;
  readonly json: unknown;
}

type Query = readonly (readonly [string, string])[];

export function smoobuConnector(opts: SmoobuOptions = {}): ConnectorDefinition {
  const enabled = opts.ready ?? SMOOBU_READY;
  const clock = opts.clock ?? (() => Date.now());
  const nonce = opts.nonce ?? (() => crypto.randomUUID());
  /** How far Smoobu's clock is from ours, learnt from a 401 during a run, by the secret it was learnt for. */
  const skews = new WeakMap<object, number>();

  const assertHost = (url: string): string => {
    const host = new URL(url).hostname;
    if (!SMOOBU_HOSTS.includes(host)) throw new ConnectorError("config", `${host} is not Smoobu's API.`);
    return url;
  };

  /**
   * One signed call to Smoobu. A 401 is a key Smoobu does not take, unless the answer's own date says
   * our clock is out: then it is signed again once on Smoobu's time, with a new nonce. Limits and outages
   * become the errors the inbox waits on; what else Smoobu refused is the caller's to read.
   */
  async function call(
    c: Caller,
    method: string,
    path: string,
    o: { readonly query?: Query; readonly body?: unknown; readonly timeoutMs?: number } = {},
  ): Promise<Answer> {
    const apiKey = c.secret.api_key ?? "";
    const apiSecret = c.secret.api_secret ?? "";
    if (!apiKey || !apiSecret) {
      throw new ConnectorError("auth", "Smoobu's saved key is missing. Connect Smoobu again.");
    }
    const query = smoobuQuery(o.query ?? []);
    const url = assertHost(`${SMOOBU_API}${path}${query ? `?${query}` : ""}`);
    const body = o.body === undefined ? "" : JSON.stringify(o.body);
    let skew = skews.get(c.secret) ?? 0;
    for (let attempt = 0; ; attempt++) {
      const signedAt = clock() + skew;
      const signed = await smoobuHeaders({
        apiKey,
        apiSecret,
        method,
        path,
        query,
        body,
        timestamp: smoobuTimestamp(signedAt),
        nonce: nonce(),
      });
      const res = await c.http.request({
        method,
        url,
        headers: {
          ...signed,
          accept: "application/json",
          "cache-control": "no-cache",
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(o.body !== undefined ? { body } : {}),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      });
      if (res.status === 401) {
        const served = Date.parse(res.headers.get("date") ?? "");
        if (attempt === 0 && Number.isFinite(served) && Math.abs(served - signedAt) > SKEW_MS) {
          skew = served - clock();
          skews.set(c.secret, skew);
          continue;
        }
        throw new ConnectorError(
          "auth",
          "Smoobu did not take this API key and secret. Generate a new secret in Smoobu (Settings → Advanced → API Keys) and connect again.",
          { field: "api_secret" },
        );
      }
      if (res.status === 429) {
        throw new ConnectorError("rate_limited", "Smoobu asked us to wait a moment. Trying again shortly.", {
          retryAfterMs: smoobuRetryAfterMs(res.headers, clock()),
        });
      }
      const json = parsed(res.text);
      if (res.status >= 500) {
        // Smoobu answers some refusals with a 500 ("Apartment not found for this user"): those are not an outage.
        const detail = str(obj(json)?.detail) ?? "";
        if (/not found/i.test(detail)) throw new ConnectorError("not_found", said(json, "Smoobu does not show that."));
        throw new ConnectorError("unreachable", "Smoobu isn't answering right now. Trying again shortly.");
      }
      if (res.status >= 300 && res.status < 400) {
        throw new ConnectorError("bad_response", "Smoobu answered with a redirect, which is never followed.");
      }
      if (json === undefined && res.status < 300) {
        throw new ConnectorError("bad_response", "Smoobu answered with something unreadable.");
      }
      return { res, json: json ?? null };
    }
  }

  const ok = (a: Answer): boolean => a.res.status >= 200 && a.res.status < 300;

  /** A read: its body, or the error the inbox acts on. */
  async function read(c: Caller, path: string, query: Query = []): Promise<unknown> {
    const a = await call(c, "GET", path, { query });
    if (a.res.status === 404)
      throw new ConnectorError("not_found", said(a.json, "Smoobu does not show that any more."));
    if (!ok(a)) throw new ConnectorError("bad_response", said(a.json, "Smoobu did not answer that."));
    return a.json;
  }

  /** The user the key belongs to: who `checkApartmentAvailability` is asked for (`customerId`). */
  async function me(c: Caller): Promise<{ id: string; email: string | null }> {
    const j = obj(await read(c, "/api/me"));
    const id = idOf(j?.id);
    if (!id) throw new ConnectorError("bad_response", "Smoobu answered without the account's user id.");
    return { id, email: str(j?.email) };
  }

  async function userOf(c: Caller): Promise<string> {
    return idOf(c.extra?.userId) ?? (await me(c)).id;
  }

  async function apartmentList(c: Caller): Promise<{ id: string; name: string }[]> {
    const j = obj(await read(c, "/api/apartments"));
    const out: { id: string; name: string }[] = [];
    for (const raw of Array.isArray(j?.apartments) ? (j.apartments as unknown[]) : []) {
      const a = obj(raw);
      const id = a ? idOf(a.id) : null;
      if (a && id && out.length < MAX_APARTMENTS)
        out.push({ id, name: (str(a.name) ?? `Apartment ${id}`).slice(0, 120) });
    }
    return out;
  }

  async function apartment(c: Caller, id: string, name: string): Promise<Apartment> {
    return apartmentOf(id, name, await read(c, `/api/apartments/${id}`));
  }

  async function apartments(c: Caller): Promise<Apartment[]> {
    const out: Apartment[] = [];
    for (const a of await apartmentList(c)) out.push(await apartment(c, a.id, a.name));
    return out;
  }

  /**
   * The apartments of a property: those that share its first apartment's currency, zone and town now.
   * Its first apartment gone, the property is gone, and the owner is told to choose it again.
   */
  async function apartmentsOf(c: Caller, propertyId: string): Promise<Apartment[]> {
    const all = await apartments(c);
    const first = all.find((a) => a.id === propertyId);
    const key = first ? propertyKey(first) : null;
    if (!first || !key) {
      throw new ConnectorError(
        "not_found",
        "This property's apartments have changed in Smoobu: choose the property again in Settings → Property.",
      );
    }
    return all.filter((a) => propertyKey(a) === key);
  }

  /** One apartment's rates for the nights from `from` up to `to` (excluded), by night. */
  async function rates(c: Caller, apartmentId: string, from: string, to: string): Promise<Map<string, Json>> {
    const j = obj(
      await read(c, "/api/rates", [
        ["apartments[]", apartmentId],
        ["start_date", from],
        // The example answers its end_date: the last night wanted is the last asked for.
        ["end_date", addDays(to, -1)],
      ]),
    );
    const days = obj(obj(j?.data)?.[apartmentId]) ?? {};
    const out = new Map<string, Json>();
    for (const [night, raw] of Object.entries(days)) {
      const d = obj(raw);
      if (d && dateOf(night) && night >= from && night < to) out.set(night, d);
    }
    return out;
  }

  function rowOf(apartmentId: string, night: string, d: Json, currency: string | null): AriRow {
    // "How often the apartment is available": this inbox sells it as one, and only while one is.
    const available = num(d.available) ?? 0;
    const price = currency ? smoobuMinor(d.price, currency) : null;
    const minStay = num(d.min_length_of_stay);
    return {
      roomId: apartmentId,
      night,
      units: available > 0 ? 1 : 0,
      ...(minStay !== null && minStay > 1 && Number.isInteger(minStay) ? { minStay } : {}),
      ...(price !== null && price > 0 ? { prices: { [SMOOBU_RATE]: price } } : {}),
    };
  }

  /**
   * The nights asked live just before a write (`checkApartmentAvailability`): the apartment must be
   * among the available ones, with no reason against it. Refused otherwise, in Smoobu's words, so
   * nothing is written onto a night another channel took or a stay Smoobu's rules would not take.
   */
  async function requireFree(c: Caller, apartmentId: string, stay: OutboundStay, guests: number): Promise<void> {
    const customerId = await userOf(c);
    const a = await call(c, "POST", "/booking/checkApartmentAvailability", {
      body: {
        arrivalDate: stay.checkIn,
        departureDate: stay.checkOut,
        apartments: [Number(apartmentId)],
        customerId: Number(customerId),
        guests,
      },
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (!ok(a)) throw new ConnectorError("refused", said(a.json, "Smoobu did not say those nights are free."));
    const j = obj(a.json);
    const available = (Array.isArray(j?.availableApartments) ? (j.availableApartments as unknown[]) : []).map(idOf);
    const why = obj(obj(j?.errorMessages)?.[apartmentId]);
    if (why) {
      const message = str(why.message);
      throw new ConnectorError(
        "refused",
        message ? `Smoobu said: ${message.slice(0, 200)}` : "Smoobu's rules do not take that stay.",
      );
    }
    if (!available.includes(apartmentId)) {
      const nights = `${dayOf(stay.checkIn)} to ${dayOf(stay.checkOut)}`;
      throw new ConnectorError("refused", `${nights} isn't free in Smoobu any more.`);
    }
  }

  async function reservation(c: Caller, id: string): Promise<Reservation> {
    const r = reservationOf(await read(c, `/api/reservations/${id}`));
    if (!r) throw new ConnectorError("bad_response", "Smoobu answered without the booking.");
    return r;
  }

  /** Bookings matching a query, every page (up to `pages`). */
  async function reservations(c: Caller, query: Query, pages = MAX_PAGES): Promise<Reservation[]> {
    const out: Reservation[] = [];
    for (let page = 1; page <= pages; page++) {
      const j = obj(
        await read(c, "/api/reservations", [...query, ["page", String(page)], ["pageSize", String(PAGE_SIZE)]]),
      );
      const list = Array.isArray(j?.bookings) ? (j.bookings as unknown[]) : [];
      for (const raw of list) {
        const r = reservationOf(raw);
        if (r) out.push(r);
      }
      const count = num(j?.page_count);
      if (list.length < PAGE_SIZE || (count !== null && page >= count)) break;
    }
    return out;
  }

  /** The one apartment a stay is written to: Smoobu keeps one apartment per booking. */
  function apartmentOfStay(stay: OutboundStay): string {
    if (stay.rooms.length !== 1) {
      throw new ConnectorError(
        "refused",
        "Smoobu keeps one apartment per booking, so a stay of several rooms is not written there: book each room on its own.",
      );
    }
    const id = idOf(stay.rooms[0]?.roomId);
    if (!id) throw new ConnectorError("refused", "That room is not matched to a Smoobu apartment.");
    return id;
  }

  /** What a stay costs and who comes: never a card, a deposit, a payment status, a fee or a commission. */
  function stayFields(stay: OutboundStay, currency: string | null): Json {
    const room = stay.rooms[0];
    if (!room) throw new ConnectorError("refused", "The stay has no room.");
    // Smoobu takes a price without its currency: it is the apartment's, or nothing is written.
    if (!currency) throw new ConnectorError("refused", "Smoobu does not say which currency this apartment is in.");
    if (room.price.currency !== currency) {
      throw new ConnectorError(
        "refused",
        `Smoobu keeps this apartment's prices in ${currency}, and the stay is in ${room.price.currency}.`,
      );
    }
    const total = stay.rooms.reduce((a, r) => a + r.price.value, 0);
    const price = smoobuAmount(total, room.price.currency);
    if (price === null)
      throw new ConnectorError("refused", `Smoobu cannot be given an amount in ${room.price.currency}.`);
    return { adults: room.adults, children: room.childrenAges.length, price };
  }

  /** The booking written under a stay's key, whatever it is now: the one to find, never to write again. */
  async function findReservation(c: Caller, stay: OutboundStay): Promise<Reservation | null> {
    let apartmentId: string;
    try {
      apartmentId = apartmentOfStay(stay);
    } catch {
      return null;
    }
    const marker = `[${stay.key}]`;
    const base: [string, string][] = [
      ["apartmentId", apartmentId],
      ["showCancellation", "true"],
    ];
    // Where it was written (its nights), then among the apartment's bookings: one moved in Smoobu since,
    // or cancelled, is still found by its key.
    const looks: [Query, number][] = [
      [[...base, ["from", stay.checkIn], ["to", stay.checkOut]], 3],
      [base, 5],
    ];
    for (const [q, pages] of looks) {
      for (const r of await reservations(c, q, pages)) {
        if (r.notice?.includes(marker) && (r.apartmentId === null || r.apartmentId === apartmentId)) return r;
      }
    }
    return null;
  }

  async function ensureWebhook(ctx: RunContext): Promise<Readonly<Record<string, unknown>>> {
    const extra = ctx.extra;
    if (!ctx.hookUrl || ctx.hooksLive === false) return extra;
    let key = ctx.secret.hook_key ?? "";
    let secret = ctx.secret;
    const madeNow = !key;
    if (madeNow) {
      key = newHookKey();
      secret = { ...ctx.secret, hook_key: key };
      await ctx.saveSecret(secret);
    }
    const c: Caller = { ...ctx, secret };
    const target = smoobuWebhookUrl(ctx.hookUrl, key);
    const id = idOf(extra.webhookId);
    if (id) {
      try {
        const hook = obj(await read(c, `/api/users/webhooks/${id}`));
        if (hook && hook.webhookUrl === target) {
          return extra.hookUrl === ctx.hookUrl ? extra : { ...extra, hookUrl: ctx.hookUrl, webhookFailed: false };
        }
        if (hook) {
          // At an old address, or with a second secret made again: moved, keeping its id.
          const a = await call(c, "PATCH", `/api/users/webhooks/${id}`, { body: { webhookUrl: target } });
          if (ok(a) && obj(a.json)?.webhookUrl === target) {
            return { ...extra, hookUrl: ctx.hookUrl, webhookTriedAt: ctx.now, webhookFailed: false };
          }
        }
      } catch (error) {
        // Gone: a new one is made below.
        if (!(error instanceof ConnectorError) || error.code !== "not_found") throw error;
      }
    }
    const made = await makeWebhook(c, target);
    if (made) {
      if (id && id !== made) await dropWebhook(c, id);
      return { ...extra, webhookId: made, hookUrl: ctx.hookUrl, webhookTriedAt: ctx.now, webhookFailed: false };
    }
    // Not made: one at the old address is kept until one at the new address exists, and tried again later.
    return { ...extra, webhookId: id, webhookTriedAt: ctx.now, webhookFailed: true };
  }

  /**
   * A new webhook's id; null when Smoobu did not take it, for polling to cover and a later try. One
   * Smoobu keeps without its `k` would never check out, so it is taken away again at once.
   */
  async function makeWebhook(c: Caller, target: string): Promise<string | null> {
    const a = await call(c, "POST", "/api/users/webhooks", { body: { webhookUrl: target } });
    if (ok(a)) {
      const made = obj(a.json);
      const id = idOf(made?.id);
      if (id && made?.webhookUrl === target) return id;
      if (id) await dropWebhook(c, id);
      return null;
    }
    // Registered in this key's scope already (a connection made again): found by its address.
    if (a.res.status === 422) {
      const list = obj(await read(c, "/api/users/webhooks").catch(() => null));
      for (const raw of Array.isArray(list?.webhooks) ? (list.webhooks as unknown[]) : []) {
        const h = obj(raw);
        if (h?.webhookUrl === target) return idOf(h.id);
      }
    }
    return null;
  }

  async function dropWebhook(c: Caller, id: unknown): Promise<void> {
    const hook = idOf(id);
    if (!hook) return;
    try {
      await call(c, "DELETE", `/api/users/webhooks/${hook}`);
    } catch {
      // Best effort: a webhook left behind fails its second secret, and nothing it sends is kept.
    }
  }

  /** Every night of the next two months, for a hint that names no nights: read again, never believed. */
  function nextNights(now: number): { from: string; to: string } {
    const today = new Date(now).toISOString().slice(0, 10);
    return { from: addDays(today, -1), to: addDays(today, 61) };
  }

  const ready = (): true | string =>
    enabled ? true : "Smoobu is held at Needs setup here until this server's operator has spoken with Smoobu.";

  const definition: ConnectorDefinition = {
    kind: "smoobu",
    title: "Smoobu",
    group: "lodging",
    capabilities: ["stay_inventory", "write_stays", "stay_events"],
    auth: "form",
    form: smoobuForm,
    note: "Brings in your apartments and free nights. Every booking goes into Smoobu first, so no night is sold twice.",
    disconnectNote: "To end it in Smoobu too, delete the key in Smoobu's Settings → Advanced → API Keys.",
    ready,
    whenNotReady: {
      status: "setup",
      hint: "Smoobu asks to hear from a provider before it connects many accounts. It shows here once that is done.",
      href: SMOOBU_DOCS,
    },

    async connect(ctx, input) {
      if (!enabled) throw new ConnectorError("config", String(ready()));
      const form = smoobuForm.safeParse(input);
      if (!form.success) {
        const issue = form.error.issues[0];
        throw new ConnectorError("config", issue?.message ?? "Check the API key and secret.", {
          field: String(issue?.path[0] ?? "api_secret"),
        });
      }
      const hookKey = newHookKey();
      const secret = { api_key: form.data.api_key, api_secret: form.data.api_secret, hook_key: hookKey };
      const c: Caller = { http: ctx.http, now: ctx.now, secret };
      const user = await me(c);
      // The key reads the apartments, or it is not one this inbox can use.
      await apartmentList(c);
      let webhookId: string | null = null;
      if (ctx.hookUrl && ctx.hooksLive !== false) {
        try {
          webhookId = await makeWebhook(c, smoobuWebhookUrl(ctx.hookUrl, hookKey));
        } catch (error) {
          // Polling finds everything anyway; the webhook is made again on a later refresh.
          if (!(error instanceof ConnectorError) || error.code === "auth") throw error;
        }
      }
      const previous = ctx.previous?.extra.webhookId;
      const connected: Connected = {
        account: user.email ?? `Smoobu account ${user.id}`,
        externalId: user.id,
        secret,
        extra: {
          userId: user.id,
          webhookId,
          hookUrl: webhookId ? (ctx.hookUrl ?? null) : null,
          webhookTriedAt: ctx.now,
          webhookFailed: webhookId === null,
        },
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
        async settle(kept) {
          // Kept: the old webhook goes now the new one is in place. Refused: the new one goes.
          if (kept && previous !== undefined && idOf(previous) !== webhookId) await dropWebhook(c, previous);
          if (!kept) await dropWebhook(c, webhookId);
        },
      };
      return connected;
    },

    stale(ctx) {
      // A webhook at another address is moved now; one that could not be made, every six hours.
      if (!ctx.hookUrl || ctx.hooksLive === false) return false;
      const tried = typeof ctx.extra.webhookTriedAt === "number" ? ctx.extra.webhookTriedAt : 0;
      const due = ctx.now - tried > WEBHOOK_RETRY_MS;
      const missing = !idOf(ctx.extra.webhookId) || ctx.extra.webhookFailed === true;
      const moved = !missing && ctx.extra.hookUrl !== ctx.hookUrl;
      return missing ? due : moved;
    },

    async refresh(ctx) {
      const extra = await ensureWebhook(ctx);
      const user = await me(ctx);
      return {
        account: user.email ?? `Smoobu account ${user.id}`,
        calendars: [],
        destinations: [],
        extra: { ...extra, userId: user.id },
      };
    },

    async disconnect(ctx) {
      await dropWebhook(ctx, ctx.extra.webhookId);
    },

    stays: {
      async properties(ctx): Promise<ExternalProperty[]> {
        const groups = new Map<string, Apartment[]>();
        for (const a of await apartments(ctx)) {
          const key = propertyKey(a);
          if (!key) continue;
          groups.set(key, [...(groups.get(key) ?? []), a]);
        }
        const out: ExternalProperty[] = [];
        const sizes = new Map<string, number>();
        for (const as of groups.values()) {
          const first = anchorOf(as);
          if (!first) continue;
          sizes.set(first.id, as.length);
          // One apartment goes by its own name; several by their town and how many.
          const name =
            as.length === 1
              ? first.name
              : first.city
                ? `${first.city} · ${as.length} apartments`
                : `${as.length} apartments (${first.currency ?? ""})`;
          out.push({
            id: first.id,
            name,
            ...(first.currency ? { currency: first.currency } : {}),
            ...(first.timezone ? { timezone: first.timezone } : {}),
          });
        }
        return out.sort((a, b) => (sizes.get(b.id) ?? 0) - (sizes.get(a.id) ?? 0) || a.name.localeCompare(b.name));
      },

      async rooms(ctx, propertyId): Promise<ExternalRoom[]> {
        return (await apartmentsOf(ctx, propertyId)).map((a) => ({
          id: a.id,
          name: a.name,
          units: 1,
          ...(a.sleeps !== null
            ? { capacity: { adults: a.sleeps, children: Math.max(0, a.sleeps - 1), total: a.sleeps } }
            : {}),
          ...(a.beds.length > 0 ? { beds: a.beds } : {}),
        }));
      },

      async ratePlans(): Promise<ExternalRate[]> {
        return [{ id: SMOOBU_RATE, name: "Smoobu's nightly price" }];
      },

      async ari(ctx, propertyId, win) {
        const as = await apartmentsOf(ctx, propertyId);
        const rows: AriRow[] = [];
        for (let start = win.from; start < win.to; start = addDays(start, RATES_CHUNK)) {
          const end = addDays(start, RATES_CHUNK) < win.to ? addDays(start, RATES_CHUNK) : win.to;
          const chunk: AriRow[] = [];
          try {
            for (const a of as) {
              const days = await rates(ctx, a.id, start, end);
              for (const night of nightsBetween(start, end)) {
                const d = days.get(night);
                if (d) chunk.push(rowOf(a.id, night, d, a.currency));
              }
            }
          } catch (error) {
            // Asked to wait part of the way: what was read in full stands, and says how far it got.
            if (error instanceof ConnectorError && error.code === "rate_limited" && rows.length > 0) {
              return { rows, until: start };
            }
            throw error;
          }
          rows.push(...chunk);
        }
        return rows;
      },

      async price(ctx, q: StayPriceQuery) {
        const apartmentId = idOf(q.roomId);
        if (!apartmentId || q.checkOut <= q.checkIn) return null;
        const a = (await apartmentsOf(ctx, q.propertyId)).find((x) => x.id === apartmentId);
        if (!a?.currency) return null;
        // Smoobu's own nightly prices for those nights: never its booking tool's extras or discounts.
        const days = await rates(ctx, apartmentId, q.checkIn, q.checkOut);
        const nights: { night: string; amount: number }[] = [];
        for (const night of nightsBetween(q.checkIn, q.checkOut)) {
          const amount = smoobuMinor(days.get(night)?.price, a.currency);
          if (amount === null || amount <= 0) return null;
          nights.push({ night, amount });
        }
        return { subtotal: { value: nights.reduce((s, n) => s + n.amount, 0), currency: a.currency }, nights };
      },

      credits(res) {
        const b = smoobuBudget(res.headers, clock());
        return b ? { remaining: b.remaining, resetsInMs: b.resetsInMs } : null;
      },
    },

    hooks: {
      topics: SMOOBU_ACTIONS,

      async verify(ctx, request: InboundRequest): Promise<HookEvent | null> {
        const expected = ctx.secret.hook_key ?? "";
        const given = request.query.get("k") ?? "";
        // Compared whatever its length, in constant time; no second secret here, nothing checks out.
        const same = constantTimeEqual(given, expected);
        if (!expected || !same) throw new ConnectorError("refused", "The webhook's address does not check out.");
        const body = obj(parsed(request.body));
        if (!body) return null;
        const action = str(body.action) ?? "";
        if (!SMOOBU_ACTIONS.includes(action)) return null;
        // One address receives every event of the user it was registered for: another user's are not ours.
        const user = idOf(body.user);
        const mine = idOf(ctx.extra.userId);
        if (user && mine && user !== mine) return null;
        const data = obj(body.data) ?? {};
        const refs: string[] = [];
        let about = "rates";
        if (action === "updateRates") {
          for (const [apartmentId, raw] of Object.entries(data).slice(0, 50)) {
            const nights = Object.keys(obj(raw) ?? {})
              .filter((n) => dateOf(n))
              .sort();
            const first = nights[0];
            const last = nights[nights.length - 1];
            if (idOf(apartmentId) && first && last) {
              const to = addDays(last, 1);
              refs.push(
                nightsBetween(first, to).length < MAX_HINT_NIGHTS
                  ? `nights:${apartmentId}:${first}:${to}`
                  : `apartment:${apartmentId}`,
              );
            }
          }
          if (refs.length === 0) refs.push("all");
        } else {
          const id = idOf(data.id);
          if (!id) return null;
          about = id;
          refs.push(`reservation:${id}`);
          const apartmentId = idOf(obj(data.apartment)?.id);
          const from = dateOf(data.arrival);
          const to = dateOf(data.departure);
          if (apartmentId && from && to && from < to && nightsBetween(from, to).length < MAX_HINT_NIGHTS) {
            refs.push(`nights:${apartmentId}:${from}:${to}`);
          }
        }
        // Smoobu gives a delivery no id: one sent again within ten minutes is the same one.
        const digest = (await sha256Hex(request.body)).slice(0, 24);
        const bucket = Math.floor(ctx.now / HOOK_DEDUPE_MS);
        return { eventId: `${action}:${about}:${digest}:${bucket}`, topic: action, refs };
      },

      async read(ctx, event): Promise<readonly HookFact[]> {
        const facts: HookFact[] = [];
        const seen = new Set<string>();
        const add = (roomIds: readonly string[] | undefined, from: string, to: string) => {
          const key = `${roomIds?.join(",") ?? "*"}|${from}|${to}`;
          if (from < to && !seen.has(key)) {
            seen.add(key);
            facts.push({ kind: "stay_nights", ...(roomIds ? { roomIds } : {}), from, to });
          }
        };
        const named = event.refs.some((r) => r.startsWith("nights:"));
        for (const ref of event.refs) {
          const [kind, raw, from, to] = ref.split(":");
          const id = idOf(raw);
          if (kind === "reservation" && id) {
            let r: Reservation | null;
            try {
              r = await reservation(ctx, id);
            } catch (error) {
              // Deleted, or not shown yet: the nights the delivery named are read again instead.
              if (!(error instanceof ConnectorError) || error.code !== "not_found") throw error;
              r = null;
            }
            if (r?.apartmentId && r.arrival && r.departure) add([r.apartmentId], r.arrival, r.departure);
            else if (!named) add(undefined, nextNights(ctx.now).from, nextNights(ctx.now).to);
          } else if (kind === "nights" && id && dateOf(from) && dateOf(to)) {
            // The nights the body named: only ever read again, never believed.
            add([id], from as string, to as string);
          } else if (kind === "apartment" && id) {
            add([id], nextNights(ctx.now).from, nextNights(ctx.now).to);
          } else if (kind === "all") {
            add(undefined, nextNights(ctx.now).from, nextNights(ctx.now).to);
          }
        }
        return facts;
      },
    },

    stayWriter: {
      async put(ctx, stay, link, status) {
        if (status === "hold") {
          throw new ConnectorError(
            "refused",
            "Smoobu documents no hold that keeps a night off sale: nothing is held there.",
          );
        }
        const apartmentId = apartmentOfStay(stay);
        const provisional = status !== "confirmed";
        const language = ctx.inbox.language;
        if (!link?.externalId) {
          // No idempotency key in Smoobu: a write already made under this key is found, not made twice;
          // one cancelled in Smoobu since is the owner's word, never written over.
          const found = await findReservation(ctx, stay);
          if (found && !holds(found)) throw new ConnectorError("refused", "It was cancelled in Smoobu.");
          if (found) return { externalId: found.id, etag: null, calendar: apartmentId };
          const place = await apartment(ctx, apartmentId, "");
          const fields = stayFields(stay, place.currency);
          await requireFree(ctx, apartmentId, stay, Number(fields.adults) + Number(fields.children));
          const a = await call(ctx, "POST", "/api/reservations", {
            body: {
              arrivalDate: stay.checkIn,
              departureDate: stay.checkOut,
              apartmentId: Number(apartmentId),
              ...fields,
              notice: noticeOf(stay, stay.key, provisional, language),
              ...(stay.guest
                ? {
                    ...namesOf(stay.guest.name),
                    ...(stay.guest.email ? { email: stay.guest.email } : {}),
                    ...(stay.guest.phone ? { phone: stay.guest.phone } : {}),
                  }
                : {}),
            },
            timeoutMs: WRITE_TIMEOUT_MS,
          });
          if (!ok(a)) throw new ConnectorError("refused", said(a.json, "Smoobu said no."));
          const id = idOf(obj(a.json)?.id);
          if (!id) throw new ConnectorError("bad_response", "Smoobu answered without the booking's id.");
          return { externalId: id, etag: null, calendar: apartmentId };
        }
        const linked = idOf(link.externalId);
        if (!linked) throw new ConnectorError("refused", "That is not a booking Smoobu gave.");
        const current = await reservation(ctx, linked).catch((error: unknown) => {
          if (error instanceof ConnectorError && error.code === "not_found") {
            throw new ConnectorError("refused", "Smoobu does not show this booking any more.");
          }
          throw error;
        });
        // Cancelled in Smoobu: never brought back by a write of ours.
        if (!holds(current)) throw new ConnectorError("refused", "It was cancelled in Smoobu.");
        // Smoobu's update takes neither dates nor an apartment: a change of nights is made in Smoobu.
        if (
          (current.apartmentId !== null && current.apartmentId !== apartmentId) ||
          current.arrival !== stay.checkIn ||
          current.departure !== stay.checkOut
        ) {
          throw new ConnectorError(
            "refused",
            "Smoobu does not let another system move a booking to other nights or another apartment: change it in Smoobu.",
          );
        }
        const place = await apartment(ctx, apartmentId, "");
        const marker = current.notice ? MARKER.exec(current.notice)?.[1] : undefined;
        const a = await call(ctx, "PUT", `/api/reservations/${current.id}`, {
          body: {
            ...stayFields(stay, place.currency),
            // Our own notice says where the stay stands; one the owner wrote is left as it is.
            ...(marker && ownNotice(current.notice) ? { notice: noticeOf(stay, marker, provisional, language) } : {}),
            ...(stay.guest
              ? {
                  guestName: stay.guest.name.slice(0, 200),
                  ...(stay.guest.email ? { guestEmail: stay.guest.email } : {}),
                  ...(stay.guest.phone ? { guestPhone: stay.guest.phone } : {}),
                }
              : {}),
          },
          timeoutMs: WRITE_TIMEOUT_MS,
        });
        if (!ok(a)) throw new ConnectorError("refused", said(a.json, "Smoobu said no."));
        return { externalId: current.id, etag: null, calendar: apartmentId };
      },

      async cancel(ctx, link) {
        const id = idOf(link.externalId);
        if (!id) return;
        const before = await reservation(ctx, id).catch((error: unknown) => {
          if (error instanceof ConnectorError && error.code === "not_found") return null;
          throw error;
        });
        // Gone, or cancelled already: done.
        if (!before || !holds(before)) return;
        // Smoobu's cancellation: "The booking is still in the system as a cancelled booking."
        const a = await call(ctx, "DELETE", `/api/reservations/${id}`, { timeoutMs: WRITE_TIMEOUT_MS });
        if (ok(a) || a.res.status === 404) return;
        throw new ConnectorError("refused", said(a.json, "Smoobu did not take the cancellation."));
      },

      async find(ctx, stay) {
        const r = await findReservation(ctx, stay);
        return r ? { externalId: r.id, etag: null, calendar: r.apartmentId } : null;
      },

      async oversold(ctx, _stay, link) {
        const id = idOf(link.externalId);
        if (!id) throw new ConnectorError("bad_response", "No booking to read back.");
        const ours = await reservation(ctx, id);
        // Ours cancelled already: whatever answered the write, the stay is not booked there.
        if (!holds(ours)) return true;
        if (!ours.apartmentId || !ours.arrival || !ours.departure) {
          throw new ConnectorError("bad_response", "Smoobu answered without the booking's apartment or dates.");
        }
        const apartmentId = ours.apartmentId;
        // Whether `from` and `to` mean overlap or arrival is not said: the window starts well before, and
        // only bookings that hold one of our nights are counted. Grouped apartments' bookings too.
        const others = await reservations(ctx, [
          ["apartmentId", apartmentId],
          ["from", addDays(ours.arrival, -LOOK_BEFORE_DAYS)],
          ["to", ours.departure],
          ["includeRelated", "true"],
        ]);
        if (!others.some((r) => r.id === id)) {
          throw new ConnectorError("bad_response", "Smoobu's bookings do not show it yet.");
        }
        for (const night of nightsBetween(ours.arrival, ours.departure)) {
          const holders = others.filter(
            (r) => holdsOn(r, apartmentId) && r.arrival && r.departure && r.arrival <= night && night < r.departure,
          );
          // One unit per apartment: a second booking on any of our nights is an oversell.
          if (holders.length > 1) return true;
        }
        return false;
      },
    },
  };
  return definition;
}
