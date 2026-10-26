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
  field,
  type HookEvent,
  type HookFact,
  type InboundRequest,
  type LinkState,
  type OutboundStay,
  parseDecimal,
  type RunContext,
  type StayPriceQuery,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { constantTimeEqual } from "../pay-sign";

/**
 * Hostaway (ADR-037 §8), a vacation-rental property management system, over its Public API v1 with
 * the owner's own account ID and API key. Built from <https://api.hostaway.com/documentation> as it
 * read on 20 October 2026 (the excerpt behind each fixture is kept in its header); never called from
 * here with a real account.
 *
 * - **Access.** The account ID and API key are exchanged for a token (`POST /v1/accessTokens`,
 *   client credentials, scope `general`) that lives about 24 months. It is sealed with the key, and
 *   a new one is used only after "at least" a second (1.5 s here). Hostaway answers 403 both to a token
 *   that stopped working and to a request it will not take (its changelog, 5 October 2026), so a 403
 *   fetches the token again at most once a run, and never for a token issued in the last hour; one
 *   still refused is Hostaway refusing that request. Only `POST /v1/accessTokens` refusing the key
 *   says the key is dead.
 * - **Rooms.** Hostaway has no property above its listings: each listing is one room type of one unit.
 *   The listings are grouped into properties by currency, time zone and town, so a property's prices
 *   and nights are never read in another money or another zone, and flats in two towns are two
 *   properties. A property's id is its first listing's id with that listing's currency and zone
 *   (`310021@AUD@Australia/Hobart`): it holds whichever listings share that listing's currency, zone
 *   and town now, so a town renamed in Hostaway does not lose it, and a currency or zone changed there
 *   is never read as the old one (no night of it carries its currency): the owner chooses it again.
 *   Archived listings, and listings with no currency or zone, are left out.
 * - **What is free.** The listing calendar, night by night: a night is free when Hostaway says it is
 *   available, closed when it is blocked, and priced at its nightly price as the one rate, `nightly`.
 *   Whether the calendar's `endDate` is included is not documented, so the night after the last is
 *   asked for and only the nights wanted are kept. `calendar/priceDetails` gives the nights' own price
 *   for a stay (`price`): its base rate less its discounts, never its fees, taxes or deposit.
 * - **Writing a stay.** `POST /v1/reservations` on the direct channel (2000) with the `provider` tag,
 *   one reservation per room (Hostaway keeps one listing per reservation), at the price the inbox
 *   gives. A stay of several rooms is all or nothing: a room refused takes back the ones written for
 *   it. `forceOverbooking` is never sent. The documents name an overbooking protection but not what it
 *   refuses, nor how, so the write is checked first and read back after (`check_then_write`): each
 *   listing's nights are read live before any is written, and after it the calendar's own reservations
 *   for those nights are counted against the listing's units less any a person blocked (`oversold`);
 *   the inbox takes its own write back on a conflict. A reservation of ours that holds none of its
 *   nights (cancelled, declined, an inquiry) is never a sound write, whatever answered it. There is no
 *   idempotency key: our key (with the room's number, for a stay of several) rides in the reservation's
 *   host note, and a write is looked for by it before it is made again.
 * - **Holds.** Hostaway's holding statuses (`pending`, `awaitingPayment`) are documented for Airbnb
 *   only, and `inquiry` does not block the calendar: there is no hold here. A stay written while its
 *   deposit is due is a normal reservation, which blocks its nights until it is paid or cancelled.
 * - **Cancelling.** `PUT /v1/reservations/{id}/statuses/cancelled` by the host, never `DELETE`. It
 *   is done only when Hostaway shows the reservation gone or holding no nights; anything else is the
 *   owner's to do in Hostaway, and they are told.
 * - **Webhooks.** One unified webhook per connection, made through the API at the connection's own
 *   address with a login and password generated here, sealed, and checked in constant time. The body
 *   is only a hint: the reservation it is about is read back, and its nights are read again. The
 *   documentation names its events only in prose, so a delivery is read by what it is about (a
 *   reservation), whatever its event is called; guest messages, and other objects, are answered and
 *   left alone.
 * - **Limits.** 200 requests per 10 seconds per account and per IP. A 429 carries
 *   `X-RateLimit-Retry-After` as a Unix time in seconds, never a delay, and the inbox waits until then,
 *   with a random part; another 429 soon after doubles the wait each time ("If you get a second 429,
 *   double the wait each time and add a random delay").
 * - **Hosts.** Only `api.hostaway.com`; nothing a response says is ever followed.
 */

export const HOSTAWAY_API = "https://api.hostaway.com";
/** The only hosts this adapter calls: constants, never from input or from an answer (SSRF). */
export const HOSTAWAY_HOSTS: readonly string[] = ["api.hostaway.com"];
/** The direct channel: a stay the business took itself. */
export const HOSTAWAY_DIRECT_CHANNEL = 2000;
/**
 * What Hostaway shows as the reservation's source (`?provider=`, at most 50 characters). Named plainly,
 * so a report by source tells it from Hostaway's own Inbox; guests never see a source.
 */
export const HOSTAWAY_PROVIDER = "Surfing Dog Inbox";
/** The one rate a listing's calendar prices: its nightly price. */
export const HOSTAWAY_RATE = "nightly";
/**
 * The unified webhook events asked for. Assumed: the documentation names them only in prose
 * ("reservation created", "reservation updated"), and its one machine example is `message.received`.
 * Nothing relies on these strings: a delivery about a reservation is read back whatever its event.
 */
export const HOSTAWAY_EVENTS: readonly string[] = ["reservation.created", "reservation.updated"];
/** How long a new token waits before it is used: valid "1 second after being returned", with room. */
export const HOSTAWAY_TOKEN_SETTLE_MS = 1_500;
/** A write's own limit, under the inbox's 20 seconds for the whole write, so the two end together. */
const WRITE_TIMEOUT_MS = 15_000;
/** A token issued this recently that is refused was refused for the request, never for its age. */
const TOKEN_FRESH_MS = 60 * 60_000;

/** Statuses that do not hold a listing's nights (the documentation's "Reservation statuses"). */
const NOT_BLOCKING = new Set([
  "cancelled",
  "declined",
  "expired",
  "inquiry",
  "inquiryPreapproved",
  "inquiryDenied",
  "inquiryTimedout",
  "inquiryNotPossible",
]);
/** Calendar statuses a person or a channel closed, not a reservation. */
const CLOSED = new Set(["blocked", "hardBlock", "mblocked"]);
/** At most this many nights in one calendar read: the documentation sets no bound, so the answers stay small. */
const CALENDAR_CHUNK = 92;
const LISTING_PAGE = 50;
const MAX_LISTING_PAGES = 40;
const HOOK_DEDUPE_MS = 10 * 60_000;
const WEBHOOK_RETRY_MS = 6 * 3_600_000;
/** Our key in the host note: `[sd-…]`. */
const MARKER = /\[(sd-[0-9A-Za-z-]{1,120})\]/;
const NOTE_PREFIXES = ["Booked direct via Surfing Dog Inbox", "Booked direct via Surfing Dog Inbox, deposit due"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A property's id: its first listing's id, its currency and its zone (`310021@AUD@Australia/Hobart`). */
const PROPERTY_ID = /^([1-9]\d{0,14})@([A-Z]{3})@([^@\s]{1,80})$/;
/** At most this many rooms in one stay: one reservation each, all or nothing. */
const MAX_ROOMS = 10;
/** A 429 this soon after the last one is "a second 429": the wait doubles. */
const BACKOFF_RESET_MS = 10 * 60_000;

export const hostawayForm = z.object({
  account_id: field(
    z
      .string()
      .trim()
      // As Hostaway gives it: digits, never a leading zero (the webhook's `accountId` is compared to it).
      .regex(/^[1-9]\d{0,11}$/, "your Hostaway account ID, in digits"),
    {
      label: "Account ID",
      // Step 1 begins with the link's own words, so the link is the step.
      link: { href: "https://dashboard.hostaway.com", text: "Open Hostaway" },
      steps: [
        "Open Hostaway → Settings → Hostaway API → Create.",
        "Name it Surfing Dog Inbox and pick Hostaway Public API as the partner.",
        "Copy the account ID and the API key here. The key is shown only once.",
      ],
    },
  ),
  client_secret: secretField(
    z
      .string()
      .trim()
      .min(16, "the API key Hostaway showed, in full")
      .max(200)
      .regex(/^[A-Za-z0-9._~-]+$/, "the API key Hostaway showed, in full"),
    { label: "API key", help: "Lost it? Create a new key in Hostaway." },
  ),
});

export interface HostawayOptions {
  /** How the adapter waits a moment (a new token's first second). Tests pass their own clock. */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  /** A number from 0 up to 1, for the random part of a wait after a 429. Tests pass their own. */
  readonly random?: (() => number) | undefined;
}

/* --- reading answers ---------------------------------------------------------- */

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

/** An id Hostaway gave: a positive integer, as a string. */
function idOf(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^[1-9]\d{0,14}$/.test(s) ? s : null;
}

function truthy(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateOf(v: unknown): string | null {
  return typeof v === "string" && DATE.test(v) ? v : null;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function nightsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}

/** An amount Hostaway gave in currency units (a JSON number) as minor units; null when it is not one. */
export function hostawayMinor(value: unknown, currency: string): number | null {
  const n = num(value);
  if (n === null || n < 0) return null;
  // A JSON number prints as the decimal it was written as (211.62); a part below the minor unit is refused.
  return parseDecimal(String(n), currency);
}

/** A signed amount (a discount is negative) as minor units; null when it is not one. */
function signedMinor(value: unknown, currency: string): number | null {
  const n = num(value);
  return n === null ? null : parseDecimal(String(n), currency);
}

/**
 * How long to wait after a 429: until Hostaway's own time the first time, twice that for each 429
 * that follows it closely ("double the wait each time"), and a random part of up to a fifth on top
 * ("add a random delay"), so the polls and writes of one account do not all come back at once. At
 * most an hour.
 */
export function hostawayBackoffMs(baseMs: number, repeats: number, random: number): number {
  const doubled = baseMs * 2 ** Math.min(Math.max(0, repeats), 8);
  const jitter = Math.floor(Math.min(Math.max(random, 0), 1) * Math.min(doubled / 5, 30_000));
  return Math.min(doubled + jitter, 3_600_000);
}

/** Minor units as the JSON number Hostaway takes (4500 KWD → 4.5); null for a currency without an exponent. */
function hostawayAmount(value: number, currency: string): number | null {
  const d = decimalOf(value, currency);
  return d === null ? null : Number(d);
}

/**
 * How long Hostaway asked to wait, from a 429's `X-RateLimit-Retry-After`: a Unix time in seconds, not
 * a delay ("Important: X-RateLimit-Retry-After holds a Unix timestamp in seconds, not a delay in
 * seconds"). Measured against the answer's own `Date` when it has one, so a clock that is off here
 * does not stretch or shorten the wait. A value too small to be a time is read as seconds; none at all
 * waits out the 10-second window. Within one second and one hour.
 */
export function hostawayRetryAfterMs(headers: Headers, now: number): number {
  const raw = headers.get("x-ratelimit-retry-after")?.trim() ?? "";
  const at = raw && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  const served = Date.parse(headers.get("date") ?? "");
  const base = Number.isFinite(served) ? served : now;
  let ms: number;
  if (!Number.isFinite(at)) ms = 10_000;
  else if (at >= 1e12) ms = at - base;
  else if (at >= 1e9) ms = at * 1000 - base;
  else ms = at * 1000;
  return Math.min(Math.max(Math.ceil(ms), 1_000), 3_600_000);
}

function messageOf(json: unknown): string {
  const j = obj(json);
  const m = j ? (str(j.message) ?? str(j.result) ?? str(j.error)) : null;
  return m ? m.slice(0, 200) : "";
}

/** Hostaway's own words, for the owner: never a bare status code. */
function said(json: unknown, otherwise: string): string {
  const m = messageOf(json);
  return m ? `Hostaway said: ${m}` : otherwise;
}

function parsed(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return undefined;
  }
}

/** A night as the owner reads it: "3 Nov 2026", never an ISO date. */
function dayOf(night: string): string {
  const [y, m, d] = night.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/* --- the connection's own words ------------------------------------------------ */

interface Listing {
  readonly id: string;
  readonly name: string;
  readonly currency: string | null;
  readonly timezone: string | null;
  readonly city: string | null;
  readonly capacity: number | null;
  readonly children: number | null;
}

function listingOf(raw: unknown): Listing | null {
  const l = obj(raw);
  const id = l ? idOf(l.id) : null;
  if (!l || !id) return null;
  if (str(l.specialStatus) === "archived") return null;
  const name = str(l.name) ?? str(l.externalListingName) ?? `Listing ${id}`;
  const internal = str(l.internalListingName);
  const currency = str(l.currencyCode)?.toUpperCase() ?? null;
  return {
    id,
    // The owner knows a listing by its internal name as well as by the one guests see.
    name: (internal && internal !== name ? `${name} (${internal})` : name).slice(0, 120),
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    timezone: str(l.timeZoneName),
    city: str(l.city),
    capacity: num(l.personCapacity),
    children: num(l.maxChildrenAllowed),
  };
}

/** Which property a listing is in: the listings that share a currency, a time zone and a town. */
function propertyKey(l: Listing): string | null {
  if (!l.currency || !l.timezone) return null;
  const town = (l.city ?? "").normalize("NFC").trim().toLowerCase();
  return `${l.currency}@${l.timezone}${town ? `@${town}` : ""}`;
}

/** A property's first listing: the one its id is made from. */
function anchorOf(ls: readonly Listing[]): Listing | undefined {
  let first: Listing | undefined;
  for (const l of ls) if (!first || Number(l.id) < Number(first.id)) first = l;
  return first;
}

/** A property's id: its first listing's id, currency and zone, so neither is ever read as another. */
function propertyIdOf(anchor: Listing): string | null {
  if (!anchor.currency || !anchor.timezone) return null;
  const id = `${anchor.id}@${anchor.currency}@${anchor.timezone}`;
  return PROPERTY_ID.test(id) && id.length <= 120 ? id : null;
}

function parsePropertyId(id: string): { anchor: string; currency: string; timezone: string } | null {
  const m = PROPERTY_ID.exec(id);
  return m?.[1] && m[2] && m[3] ? { anchor: m[1], currency: m[2], timezone: m[3] } : null;
}

interface Reservation {
  readonly id: string;
  readonly listingId: string | null;
  readonly status: string;
  readonly arrival: string | null;
  readonly departure: string | null;
  readonly previousArrival: string | null;
  readonly previousDeparture: string | null;
  readonly hostNote: string | null;
  /** What a write of ours sends, as it stands now: what a change put back writes again. */
  readonly written: Json;
}

/** The fields a write of ours sends (`stayFields`, the host note): the only ones it ever puts back. */
const WRITTEN = [
  "arrivalDate",
  "departureDate",
  "numberOfGuests",
  "adults",
  "children",
  "totalPrice",
  "currency",
  "guestName",
  "guestEmail",
  "phone",
  "guestNote",
  "hostNote",
] as const;

function reservationOf(raw: unknown): Reservation | null {
  const r = obj(raw);
  const id = r ? idOf(r.id) : null;
  if (!r || !id) return null;
  const written: Json = {};
  for (const k of WRITTEN) if (typeof r[k] === "string" || typeof r[k] === "number") written[k] = r[k];
  return {
    id,
    listingId: idOf(r.listingMapId),
    status: str(r.status) ?? "unknown",
    arrival: dateOf(r.arrivalDate),
    departure: dateOf(r.departureDate),
    previousArrival: dateOf(r.previousArrivalDate),
    previousDeparture: dateOf(r.previousDepartureDate),
    hostNote: typeof r.hostNote === "string" ? r.hostNote : null,
    written,
  };
}

/** The reservations a link names: one id, or one per room of a stay of several (`41001,41002`). */
function idsOf(externalId: string | null): string[] | null {
  if (!externalId) return null;
  const ids = externalId.split(",").map((s) => idOf(s));
  if (ids.length > MAX_ROOMS || ids.some((x) => x === null) || new Set(ids).size !== ids.length) return null;
  return ids as string[];
}

/** Whether a reservation holds its nights: every status but the ones documented not to (and unknown ones do). */
function blocks(status: string): boolean {
  return !NOT_BLOCKING.has(status);
}

/** What the owner is told of a reservation of ours that no longer holds its nights. */
function notHeld(status: string): string {
  return status === "cancelled" ? "It was cancelled in Hostaway." : "Hostaway no longer holds its nights.";
}

/** How many reservations a night can hold: one, or a multi-unit listing's units less those blocked by hand. */
function capacityOf(d: Json): number {
  const units = num(d.countAvailableUnits);
  if (units === null || units <= 1) return 1;
  return Math.max(0, units - Math.max(0, num(d.countBlockedUnits) ?? 0));
}

/**
 * The host note a stay is written with: what it is, its reference, which room of how many, and our key
 * to find it by.
 */
function noteOf(stay: OutboundStay, key: string, provisional: boolean, room = 0): string {
  const what = provisional ? NOTE_PREFIXES[1] : NOTE_PREFIXES[0];
  const which = stay.rooms.length > 1 ? ` · room ${room + 1} of ${stay.rooms.length}` : "";
  return `${what} · ref ${stay.reference}${which} [${key}]`;
}

/** The key each room's reservation carries: the stay's own for one room, with the room's number for several. */
function roomKeys(stay: OutboundStay): string[] {
  return stay.rooms.length === 1 ? [stay.key] : stay.rooms.map((_, i) => `${stay.key}-room${i + 1}`);
}

function ownNote(note: string | null): boolean {
  return !!note && NOTE_PREFIXES.some((p) => note.startsWith(p)) && MARKER.test(note);
}

/* --- secrets ------------------------------------------------------------------- */

function randomPart(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A login and password for the connection's webhook, made here and never shown. */
export function newHookCredentials(): { readonly login: string; readonly password: string } {
  return { login: `inbox-${randomPart(9)}`, password: randomPart(32) };
}

/** The user and password of a `Basic` header, as UTF-8; null when it is not one. */
function parseBasic(header: string | null): { user: string; pass: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]{1,1024})\s*$/i.exec(header ?? "");
  if (!m?.[1]) return null;
  let text: string;
  try {
    const binary = atob(m[1]);
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const at = text.indexOf(":");
  return at < 0 ? null : { user: text.slice(0, at), pass: text.slice(at + 1) };
}

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
}

/* --- the adapter ----------------------------------------------------------------- */

interface Caller {
  readonly http: ConnectContext["http"];
  readonly now: number;
  readonly secret: Readonly<Record<string, string>>;
  readonly saveSecret?: RunContext["saveSecret"] | undefined;
}

interface Answer {
  readonly res: ConnectorHttpResponse;
  readonly json: unknown;
}

export function hostawayConnector(opts: HostawayOptions = {}): ConnectorDefinition {
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  /** The token fetched again during a run, by the secret it replaced: every later call of the run uses it. */
  const renewed = new WeakMap<object, string>();
  /** Each account's last 429 here: how many came close after one another, and until when it waits. */
  const throttled = new Map<string, { repeats: number; until: number }>();

  /** Asked to wait: until Hostaway's own time, doubled for each 429 close after another, with a random part. */
  const limited = (account: string, res: ConnectorHttpResponse, now: number): ConnectorError => {
    const last = throttled.get(account);
    const repeats = last && now < last.until + BACKOFF_RESET_MS ? last.repeats + 1 : 0;
    const ms = hostawayBackoffMs(hostawayRetryAfterMs(res.headers, now), repeats, random());
    throttled.set(account, { repeats, until: now + ms });
    return new ConnectorError("rate_limited", "Hostaway asked your Inbox to wait. Trying again shortly.", {
      retryAfterMs: ms,
    });
  };

  const assertHost = (url: string): string => {
    const host = new URL(url).hostname;
    if (!HOSTAWAY_HOSTS.includes(host)) throw new ConnectorError("config", `${host} is not Hostaway's API.`);
    return url;
  };

  /** A token for the account's ID and API key, ready to use (a second after it was issued). */
  async function issueToken(c: Pick<Caller, "http" | "now">, accountId: string, clientSecret: string) {
    const res = await c.http.request({
      method: "POST",
      url: assertHost(`${HOSTAWAY_API}/v1/accessTokens`),
      headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: accountId,
        client_secret: clientSecret,
        scope: "general",
      }).toString(),
    });
    if (res.status === 429) throw limited(accountId, res, c.now);
    throttled.delete(accountId);
    if (res.status >= 500) {
      throw new ConnectorError("unreachable", "Hostaway isn't answering right now. Trying again shortly.");
    }
    const token = str(obj(parsed(res.text))?.access_token);
    if (res.status < 200 || res.status >= 300 || !token) {
      // The one place a key is known not to work: Hostaway's own exchange refusing it.
      throw new ConnectorError(
        "auth",
        "Hostaway did not take that account ID and API key. Create a new key in Hostaway (Settings → Hostaway API) and connect again.",
        { field: "client_secret" },
      );
    }
    await wait(HOSTAWAY_TOKEN_SETTLE_MS);
    return token;
  }

  async function renew(c: Caller): Promise<string> {
    const accountId = c.secret.account_id ?? "";
    const clientSecret = c.secret.client_secret ?? "";
    if (!accountId || !clientSecret) {
      throw new ConnectorError("auth", "Hostaway's saved access is missing. Connect Hostaway again.");
    }
    const token = await issueToken(c, accountId, clientSecret);
    renewed.set(c.secret, token);
    await c.saveSecret?.({ ...c.secret, access_token: token, token_at: String(c.now) });
    return token;
  }

  /** Whether the connection's token was issued so recently that a 403 cannot mean it is old. */
  const freshToken = (c: Caller): boolean => {
    const at = Number(c.secret.token_at ?? "");
    return Number.isFinite(at) && at > 0 && c.now - at < TOKEN_FRESH_MS;
  };

  /**
   * One call to Hostaway, with the connection's token. A 403 may be a token that no longer works, or a
   * request Hostaway will not take: the token is fetched again at most once a run, never when it was
   * issued in the last hour, and the call made again; still refused, it is a refusal of this request
   * (a write) or an answer that cannot be used (a read), never a dead key. Limits and outages become
   * the errors the inbox waits on; what else Hostaway refused is the caller's to read.
   */
  async function call(
    c: Caller,
    method: string,
    path: string,
    o: { readonly body?: unknown; readonly timeoutMs?: number } = {},
  ): Promise<Answer> {
    const url = assertHost(`${HOSTAWAY_API}/v1${path}`);
    let token = renewed.get(c.secret) ?? c.secret.access_token ?? "";
    for (let attempt = 0; ; attempt++) {
      const res = await c.http.request({
        method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "cache-control": "no-cache",
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      });
      if (res.status === 403 || res.status === 401) {
        if (attempt === 0 && !renewed.has(c.secret) && !freshToken(c)) {
          token = await renew(c);
          continue;
        }
        const why = said(parsed(res.text), "Hostaway did not allow that.");
        throw new ConnectorError(method === "GET" ? "bad_response" : "refused", why);
      }
      if (res.status === 429) throw limited(c.secret.account_id ?? "", res, c.now);
      throttled.delete(c.secret.account_id ?? "");
      if (res.status >= 500) {
        throw new ConnectorError("unreachable", "Hostaway isn't answering right now. Trying again shortly.");
      }
      if (res.status >= 300 && res.status < 400) {
        // A redirect is never followed (SSRF): only api.hostaway.com is ever called.
        throw new ConnectorError(
          "bad_response",
          "Hostaway answered in a way your Inbox can't use. Trying again later.",
        );
      }
      const json = parsed(res.text);
      if (json === undefined && res.status < 300) {
        throw new ConnectorError("bad_response", "Hostaway answered with something unreadable.");
      }
      return { res, json: json ?? null };
    }
  }

  const succeeded = (a: Answer): boolean => a.res.status >= 200 && a.res.status < 300 && obj(a.json)?.status !== "fail";

  /** A read: its `result`, or the error the inbox acts on. */
  async function read(c: Caller, path: string): Promise<unknown> {
    const a = await call(c, "GET", path);
    if (a.res.status === 404) throw new ConnectorError("not_found", "Hostaway does not show that any more.");
    if (!succeeded(a)) throw new ConnectorError("bad_response", said(a.json, "Hostaway did not answer that."));
    return obj(a.json)?.result;
  }

  async function listings(c: Caller): Promise<Listing[]> {
    const out: Listing[] = [];
    for (let page = 0; page < MAX_LISTING_PAGES; page++) {
      const q = new URLSearchParams({
        limit: String(LISTING_PAGE),
        offset: String(page * LISTING_PAGE),
        includeResources: "0",
      });
      q.append("specialStatus[]", "active");
      const a = await call(c, "GET", `/listings?${q.toString()}`, { timeoutMs: 20_000 });
      if (!succeeded(a)) throw new ConnectorError("bad_response", said(a.json, "Hostaway did not list the listings."));
      const body = obj(a.json);
      const list = Array.isArray(body?.result) ? (body.result as unknown[]) : [];
      for (const raw of list) {
        const l = listingOf(raw);
        if (l) out.push(l);
      }
      const pages = num(body?.totalPages);
      if (list.length < LISTING_PAGE || (pages !== null && page + 1 >= pages)) break;
    }
    return out;
  }

  /**
   * The listings of a property: those that share its first listing's currency, zone and town now. Its
   * first listing gone or archived, or its currency or zone not the property's any more, the property
   * is gone, and the owner is told to choose it again: never left with a property that quietly offers
   * nothing, nor with nights priced in a money that is not the property's.
   */
  async function listingsOf(c: Caller, propertyId: string): Promise<Listing[]> {
    const want = parsePropertyId(propertyId);
    const all = want ? await listings(c) : [];
    const first = want ? all.find((l) => l.id === want.anchor) : undefined;
    const key = first ? propertyKey(first) : null;
    if (!want || !first || !key || first.currency !== want.currency || first.timezone !== want.timezone) {
      throw new ConnectorError(
        "not_found",
        "This property's listings have changed in Hostaway: choose the property again in Settings → Property.",
      );
    }
    return all.filter((l) => propertyKey(l) === key);
  }

  /** The listing's calendar days for the nights from `from` up to `to` (excluded), by night. */
  async function calendar(
    c: Caller,
    listingId: string,
    from: string,
    to: string,
    withReservations: boolean,
  ): Promise<Map<string, Json>> {
    const q = new URLSearchParams({
      startDate: from,
      // The documentation does not say whether endDate is included: the night after the last is asked
      // for, so every night wanted comes back either way, and only those are kept.
      endDate: to,
      includeResources: withReservations ? "1" : "0",
    });
    const result = await read(c, `/listings/${listingId}/calendar?${q.toString()}`);
    const days = new Map<string, Json>();
    for (const raw of Array.isArray(result) ? result : []) {
      const d = obj(raw);
      const night = d ? dateOf(d.date) : null;
      if (d && night && night >= from && night < to) days.set(night, d);
    }
    return days;
  }

  function rowOf(listingId: string, night: string, d: Json, currency: string | null): AriRow {
    const status = str(d.status);
    const closed = status !== null && CLOSED.has(status);
    // A multi-unit listing says how many are left; this inbox sells it as one, and only while one is.
    const left = num(d.availableUnitsToSell);
    const open = left !== null ? left > 0 : truthy(d.isAvailable) && (status === null || status === "available");
    const price = currency ? hostawayMinor(d.price, currency) : null;
    const minStay = num(d.minimumStay);
    const maxStay = num(d.maximumStay);
    return {
      roomId: listingId,
      night,
      units: open && !closed ? 1 : 0,
      ...(closed ? { closed: true } : {}),
      ...(minStay !== null && minStay > 0 ? { minStay } : {}),
      ...(maxStay !== null && maxStay > 0 ? { maxStay } : {}),
      ...(truthy(d.closedOnArrival) ? { noArrival: true } : {}),
      ...(truthy(d.closedOnDeparture) ? { noDeparture: true } : {}),
      ...(price !== null && price > 0 ? { prices: { [HOSTAWAY_RATE]: price } } : {}),
    };
  }

  /** The blocking reservations a calendar day shows, by id. */
  function holdersOf(d: Json): string[] {
    const list = Array.isArray(d.reservations) ? (d.reservations as unknown[]) : [];
    const out: string[] = [];
    for (const raw of list) {
      const r = obj(raw);
      const id = r ? idOf(r.id) : null;
      if (r && id && blocks(str(r.status) ?? "unknown")) out.push(id);
    }
    return out;
  }

  /**
   * The nights read live just before a write: each one must be free, or held only by the reservation
   * being moved (`own`). Refused otherwise, so nothing is written onto a night another channel took.
   */
  async function requireFree(c: Caller, listingId: string, checkIn: string, checkOut: string, own: string | null) {
    const days = await calendar(c, listingId, checkIn, checkOut, own !== null);
    for (const night of nightsBetween(checkIn, checkOut)) {
      const d = days.get(night);
      if (!d) throw new ConnectorError("refused", `${dayOf(night)} isn't shown in Hostaway for this listing.`);
      const status = str(d.status);
      if (status !== null && CLOSED.has(status)) {
        throw new ConnectorError("refused", `${dayOf(night)} is closed in Hostaway.`);
      }
      const free = rowOf(listingId, night, d, null).units > 0;
      if (free) continue;
      const holders = own === null ? [] : holdersOf(d);
      if (own !== null && holders.length > 0 && holders.every((h) => h === own)) continue;
      throw new ConnectorError("refused", `${dayOf(night)} isn't free in Hostaway any more.`);
    }
  }

  async function reservation(c: Caller, id: string): Promise<Reservation> {
    const r = reservationOf(await read(c, `/reservations/${id}`));
    if (!r) throw new ConnectorError("bad_response", "Hostaway answered without the reservation.");
    return r;
  }

  /**
   * The listing each room of a stay is written to, in the stay's own order: one reservation per room,
   * since Hostaway keeps one listing per reservation, and each listing at most once (it is one place).
   */
  function listingsOfStay(stay: OutboundStay): string[] {
    if (stay.rooms.length === 0) throw new ConnectorError("refused", "The stay has no room.");
    if (stay.rooms.length > MAX_ROOMS) {
      throw new ConnectorError("refused", `A stay of more than ${MAX_ROOMS} rooms is booked in Hostaway itself.`);
    }
    const ids: string[] = [];
    for (const room of stay.rooms) {
      const id = idOf(room.roomId);
      if (!id) throw new ConnectorError("refused", "That room is not matched to a Hostaway listing.");
      if (ids.includes(id))
        throw new ConnectorError("refused", "A Hostaway listing is one place: it is booked once a stay.");
      ids.push(id);
    }
    return ids;
  }

  /**
   * What one room of a stay costs, its guests and, once confirmed, its guest: never a card, a fee or a
   * commission. Each room's reservation carries the room's own share of the price.
   */
  function stayFields(stay: OutboundStay, i = 0): Json {
    const room = stay.rooms[i];
    if (!room) throw new ConnectorError("refused", "The stay has no room.");
    const children = room.childrenAges.length;
    const amount = hostawayAmount(room.price.value, room.price.currency);
    if (amount === null)
      throw new ConnectorError("refused", `Hostaway cannot be given an amount in ${room.price.currency}.`);
    return {
      arrivalDate: stay.checkIn,
      departureDate: stay.checkOut,
      numberOfGuests: room.adults + children,
      adults: room.adults,
      children,
      totalPrice: amount,
      currency: room.price.currency,
      ...(stay.guest
        ? {
            guestName: stay.guest.name.slice(0, 200),
            ...(stay.guest.email ? { guestEmail: stay.guest.email } : {}),
            ...(stay.guest.phone ? { phone: stay.guest.phone } : {}),
            ...(stay.notes ? { guestNote: stay.notes.slice(0, 2_000) } : {}),
          }
        : {}),
    };
  }

  /** The reservation written under a key, whatever its status now: the one to find, never to write again. */
  async function findByKey(c: Caller, listingId: string, checkIn: string, key: string): Promise<Reservation | null> {
    const marker = `[${key}]`;
    const base = { listingId, channelId: String(HOSTAWAY_DIRECT_CHANNEL), limit: "100", includeResources: "0" };
    // Where it was written first (its arrival), then among the listing's latest: a stay moved since, or
    // cancelled, is still found by its key.
    const looks = [
      new URLSearchParams({ ...base, arrivalStartDate: checkIn, arrivalEndDate: checkIn }),
      new URLSearchParams(base),
    ];
    for (const q of looks) {
      const result = await read(c, `/reservations?${q.toString()}`);
      for (const raw of Array.isArray(result) ? result : []) {
        const r = reservationOf(raw);
        if (r?.hostNote?.includes(marker) && (r.listingId === null || r.listingId === listingId)) return r;
      }
    }
    return null;
  }

  /** The reservation of each room of a stay written under its key, in the stay's order; null where none is. */
  async function findRooms(c: Caller, stay: OutboundStay): Promise<(Reservation | null)[]> {
    let listingIds: string[];
    try {
      listingIds = listingsOfStay(stay);
    } catch {
      return [];
    }
    const keys = roomKeys(stay);
    const out: (Reservation | null)[] = [];
    for (const [i, listingId] of listingIds.entries()) {
      out.push(await findByKey(c, listingId, stay.checkIn, keys[i] ?? stay.key));
    }
    return out;
  }

  /**
   * A stay written under its key, found: every room's reservation that is there, even when only some
   * are, so that what landed of a stay of several is read back (never sound) and taken back, never left.
   */
  async function find(c: Caller, stay: OutboundStay): Promise<LinkState | null> {
    const found = (await findRooms(c, stay)).filter((r): r is Reservation => r !== null);
    if (found.length === 0) return null;
    return {
      externalId: found.map((r) => r.id).join(","),
      etag: null,
      calendar: found.map((r) => r.listingId ?? "").join(","),
    };
  }

  /**
   * Cancels one reservation of ours as the host: null when done (Hostaway took it, or shows it gone or
   * holding no nights), else why it is still to be done in Hostaway. Hostaway not answering is thrown,
   * so the job tries again.
   */
  async function cancelOne(c: Caller, id: string): Promise<string | null> {
    // As the host: the business cancels it, whoever asked (the seam carries no reason yet).
    const a = await call(c, "PUT", `/reservations/${id}/statuses/cancelled`, {
      body: { cancelledBy: "host" },
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (succeeded(a)) return null;
    // Not taken, or not found by that path: done only when Hostaway shows it gone, or holding no
    // nights; still holding them, it is the owner's to cancel in Hostaway.
    const now = await reservation(c, id).catch((error: unknown) => {
      if (error instanceof ConnectorError && error.code === "not_found") return null;
      throw error;
    });
    if (!now || !blocks(now.status)) return null;
    return (a.res.status === 404 ? null : refusal(a)) ?? "Hostaway did not take it.";
  }

  /**
   * Takes back what was written of a stay of several rooms that cannot be written whole: all or
   * nothing. Answers what could not be taken back, for the owner to cancel in Hostaway.
   */
  async function takeBack(c: Caller, ids: readonly string[]): Promise<string[]> {
    const left: string[] = [];
    for (const id of ids) {
      try {
        if (await cancelOne(c, id)) left.push(id);
      } catch {
        left.push(id);
      }
    }
    return left;
  }

  /** What the owner is told of reservations of ours that are still to be cancelled in Hostaway. */
  const cancelThere = (ids: readonly string[]): string =>
    ids.length === 1
      ? `Cancel reservation ${ids[0]} in Hostaway: it still holds its nights.`
      : `Cancel reservations ${ids.join(", ")} in Hostaway: they still hold their nights.`;

  /** Whether a write was refused by Hostaway (its own "fail", or a 4xx): the reason in its words. */
  function refusal(a: Answer): string | null {
    if (succeeded(a)) return null;
    if (a.res.status === 404) return "Hostaway does not show that reservation.";
    return said(a.json, "Hostaway said no.");
  }

  async function ensureWebhook(ctx: RunContext): Promise<Readonly<Record<string, unknown>>> {
    const extra = ctx.extra;
    if (!ctx.hookUrl || ctx.hooksLive === false) return extra;
    let login = ctx.secret.hook_login ?? "";
    let password = ctx.secret.hook_password ?? "";
    let secret = ctx.secret;
    const madeNow = !login || !password;
    if (madeNow) {
      ({ login, password } = newHookCredentials());
      secret = { ...ctx.secret, hook_login: login, hook_password: password };
      await ctx.saveSecret(secret);
    }
    const c: Caller = { ...ctx, secret };
    const id = idOf(extra.webhookId);
    if (id && extra.hookUrl === ctx.hookUrl) {
      try {
        const hook = obj(await read(c, `/webhooks/unifiedWebhooks/${id}`));
        if (hook && truthy(hook.isEnabled) && hook.url === ctx.hookUrl && !madeNow) return extra;
        if (hook) {
          // Switched off (the documentation: "we will be disabling webhooks that fail for 5 consecutive
          // days"), or its login just made again: on, with the login it is checked against.
          const a = await call(c, "PUT", `/webhooks/unifiedWebhooks/${id}`, {
            body: { isEnabled: 1, url: ctx.hookUrl, login, password },
          });
          if (succeeded(a)) return extra;
        }
      } catch (error) {
        // Gone, or not taken: a new one is made below.
        if (!(error instanceof ConnectorError) || (error.code !== "not_found" && error.code !== "refused")) throw error;
      }
    }
    const made = await makeWebhook(c, ctx.hookUrl, login, password);
    if (made) {
      // One webhook at a time: the one before it (at the old address, or one that would not take our
      // login) goes once the new one is in place.
      if (id && id !== made) await dropWebhook(c, id);
      return { ...extra, webhookId: made, hookUrl: ctx.hookUrl, webhookTriedAt: ctx.now, webhookFailed: false };
    }
    // Not made: one at the old address is kept until one at the new address exists, and tried again later.
    const moved = id !== null && extra.hookUrl !== ctx.hookUrl;
    return {
      ...extra,
      webhookId: moved ? id : null,
      hookUrl: moved ? (extra.hookUrl ?? null) : null,
      webhookTriedAt: ctx.now,
      webhookFailed: true,
    };
  }

  /** A new webhook's id; null when Hostaway did not take it, for polling to cover and a later try. */
  async function makeWebhook(c: Caller, url: string, login: string, password: string): Promise<string | null> {
    try {
      const a = await call(c, "POST", "/webhooks/unifiedWebhooks", {
        body: { isEnabled: 1, url, login, password },
      });
      return succeeded(a) ? idOf(obj(obj(a.json)?.result)?.id) : null;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "refused") return null;
      throw error;
    }
  }

  async function dropWebhook(c: Caller, id: unknown): Promise<void> {
    const hook = idOf(id);
    if (!hook) return;
    try {
      await call(c, "DELETE", `/webhooks/unifiedWebhooks/${hook}`);
    } catch {
      // Best effort: a webhook left behind is answered 401, and Hostaway disables a webhook that fails
      // for five days running.
    }
  }

  /** Every night of the next two months, for a hint that names no stay: read again, never believed. */
  function nextNights(now: number): { from: string; to: string } {
    const today = new Date(now).toISOString().slice(0, 10);
    return { from: addDays(today, -1), to: addDays(today, 61) };
  }

  /** Whether our reservation left any of its nights oversold, by the calendar's own count; throws when it cannot tell. */
  async function oversoldOne(c: Caller, id: string): Promise<boolean> {
    const r = await reservation(c, id);
    // Ours holds none of its nights (cancelled, declined, an inquiry): whatever answered the write,
    // the stay is not booked there, so it is never taken as sound; the inbox takes it back.
    if (!blocks(r.status)) return true;
    if (!r.listingId || !r.arrival || !r.departure) {
      throw new ConnectorError("bad_response", "Hostaway answered without the reservation's listing or dates.");
    }
    const days = await calendar(c, r.listingId, r.arrival, r.departure, true);
    for (const night of nightsBetween(r.arrival, r.departure)) {
      const d = days.get(night);
      const holders = d ? holdersOf(d) : [];
      // Not on the calendar yet: it cannot tell, and the inbox promises nothing until it can.
      if (!d || !holders.includes(id)) {
        throw new ConnectorError("bad_response", `Hostaway's calendar does not show it on ${dayOf(night)} yet.`);
      }
      if (holders.length > capacityOf(d)) return true;
    }
    return false;
  }

  /**
   * Puts the reservations a change already reached back as they were, when another room of the stay
   * refused it: only the fields it sent, at their old values. Answers the ids it could not put back.
   */
  async function putBack(c: Caller, changed: readonly { readonly r: Reservation; readonly sent: Json }[]) {
    const stuck: string[] = [];
    for (const { r, sent } of changed) {
      const old: Json = {};
      for (const k of Object.keys(sent))
        if (r.written[k] !== undefined && r.written[k] !== sent[k]) old[k] = r.written[k];
      if (Object.keys(old).length === 0) continue;
      try {
        const a = await call(c, "PUT", `/reservations/${r.id}`, { body: old, timeoutMs: WRITE_TIMEOUT_MS });
        if (refusal(a)) stuck.push(r.id);
      } catch {
        stuck.push(r.id);
      }
    }
    return stuck;
  }

  const definition: ConnectorDefinition = {
    kind: "hostaway",
    title: "Hostaway",
    group: "lodging",
    capabilities: ["stay_inventory", "write_stays", "stay_events"],
    auth: "form",
    form: hostawayForm,
    note: "Brings in your listings and free nights. Every booking goes into Hostaway first, so no night is sold twice.",
    disconnectNote: "To end it in Hostaway too, delete the Surfing Dog Inbox key in Settings → Hostaway API.",

    async connect(ctx, input) {
      const parsed = hostawayForm.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ConnectorError("config", issue?.message ?? "Check the account ID and API key.", {
          field: String(issue?.path[0] ?? "client_secret"),
        });
      }
      const { account_id: accountId, client_secret: clientSecret } = parsed.data;
      const token = await issueToken(ctx, accountId, clientSecret);
      const hook = newHookCredentials();
      const secret = {
        account_id: accountId,
        client_secret: clientSecret,
        access_token: token,
        token_at: String(ctx.now),
        hook_login: hook.login,
        hook_password: hook.password,
      };
      const c: Caller = { http: ctx.http, now: ctx.now, secret };
      // The token reads the listings, or the key is not one this inbox can use.
      await listings(c);
      let webhookId: string | null = null;
      if (ctx.hookUrl && ctx.hooksLive !== false) {
        try {
          webhookId = await makeWebhook(c, ctx.hookUrl, hook.login, hook.password);
        } catch (error) {
          // Polling finds everything anyway; the webhook is made again on the next refresh.
          if (!(error instanceof ConnectorError) || error.code === "auth") throw error;
        }
      }
      const previous = ctx.previous?.extra.webhookId;
      // A token fetched again while connecting is the one kept.
      const kept = renewed.get(secret);
      const connected: Connected = {
        account: `Hostaway account ${accountId}`,
        externalId: accountId,
        secret: kept ? { ...secret, access_token: kept } : secret,
        extra: {
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
      // A webhook at another address is made again now; one that could not be made, every six hours.
      if (!ctx.hookUrl || ctx.hooksLive === false) return false;
      const tried = typeof ctx.extra.webhookTriedAt === "number" ? ctx.extra.webhookTriedAt : 0;
      const due = ctx.now - tried > WEBHOOK_RETRY_MS;
      const missing = !idOf(ctx.extra.webhookId);
      const moved = !missing && ctx.extra.hookUrl !== ctx.hookUrl;
      return missing ? due : moved && (ctx.extra.webhookFailed !== true || due);
    },

    async refresh(ctx) {
      const extra = await ensureWebhook(ctx);
      return {
        account: `Hostaway account ${ctx.secret.account_id ?? ""}`.trim(),
        calendars: [],
        destinations: [],
        extra,
      };
    },

    async disconnect(ctx) {
      await dropWebhook(ctx, ctx.extra.webhookId);
      const token = renewed.get(ctx.secret) ?? ctx.secret.access_token;
      if (!token) return;
      try {
        await ctx.http.request({
          method: "DELETE",
          url: assertHost(`${HOSTAWAY_API}/v1/accessTokens?${new URLSearchParams({ token }).toString()}`),
          headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
        });
      } catch {
        // Best effort: the owner can delete the key in Hostaway.
      }
    },

    stays: {
      async properties(ctx): Promise<ExternalProperty[]> {
        const groups = new Map<string, Listing[]>();
        for (const l of await listings(ctx)) {
          const key = propertyKey(l);
          if (!key) continue;
          groups.set(key, [...(groups.get(key) ?? []), l]);
        }
        const out: { readonly property: ExternalProperty; readonly size: number }[] = [];
        for (const ls of groups.values()) {
          const first = anchorOf(ls);
          const id = first ? propertyIdOf(first) : null;
          if (!first || !id) continue;
          // One listing goes by its own name; several by their town and how many.
          const city = first.city;
          const name =
            ls.length === 1
              ? first.name
              : city
                ? `${city} · ${ls.length} listings`
                : `${ls.length} listings (${first.currency ?? ""})`;
          out.push({
            property: { id, name, currency: first.currency ?? undefined, timezone: first.timezone ?? undefined },
            size: ls.length,
          });
        }
        return out
          .sort((a, b) => b.size - a.size || a.property.name.localeCompare(b.property.name))
          .map((x) => x.property);
      },

      async rooms(ctx, propertyId): Promise<ExternalRoom[]> {
        return (await listingsOf(ctx, propertyId)).map((l) => ({
          id: l.id,
          name: l.name,
          units: 1,
          ...(l.capacity !== null && l.capacity > 0
            ? {
                capacity: {
                  adults: l.capacity,
                  children: Math.max(0, Math.min(l.children ?? 0, l.capacity)),
                  total: l.capacity,
                },
              }
            : {}),
        }));
      },

      async ratePlans(): Promise<ExternalRate[]> {
        return [{ id: HOSTAWAY_RATE, name: "Hostaway's nightly price" }];
      },

      async ari(ctx, propertyId, win) {
        const ls = await listingsOf(ctx, propertyId);
        const rows: AriRow[] = [];
        for (let start = win.from; start < win.to; start = addDays(start, CALENDAR_CHUNK)) {
          const end = addDays(start, CALENDAR_CHUNK) < win.to ? addDays(start, CALENDAR_CHUNK) : win.to;
          const chunk: AriRow[] = [];
          try {
            for (const l of ls) {
              const days = await calendar(ctx, l.id, start, end, false);
              for (const night of nightsBetween(start, end)) {
                const d = days.get(night);
                if (d) chunk.push(rowOf(l.id, night, d, l.currency));
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
        const listingId = idOf(q.roomId);
        if (!listingId) return null;
        const currency = (await listingsOf(ctx, q.propertyId)).find((l) => l.id === listingId)?.currency;
        if (!currency) return null;
        const a = await call(ctx, "POST", `/listings/${listingId}/calendar/priceDetails`, {
          body: {
            startingDate: q.checkIn,
            endingDate: q.checkOut,
            numberOfGuests: q.adults + q.childrenAges.length,
            version: 2,
          },
        });
        if (!succeeded(a)) return null;
        // The nights' own price: the components of type `price` (the base rate) less those of type
        // `discount` (a weekly or monthly discount, written negative). Hostaway's total also holds its
        // cleaning fee, taxes and a refundable deposit, which the inbox adds, or not, itself. A component
        // deleted, or not in the total, is not counted.
        const result = obj(obj(a.json)?.result);
        const parts = Array.isArray(result?.components) ? (result.components as unknown[]) : [];
        let subtotal = 0;
        let priced = false;
        for (const raw of parts) {
          const part = obj(raw);
          const type = part ? str(part.type) : null;
          if (!part || (type !== "price" && type !== "discount")) continue;
          if (truthy(part.isDeleted)) continue;
          if (part.isIncludedInTotalPrice === 0 || part.isIncludedInTotalPrice === "0") continue;
          const value = type === "price" ? hostawayMinor(part.total, currency) : signedMinor(part.total, currency);
          if (value === null) return null;
          // A discount is taken off, whichever sign it is written with.
          subtotal += type === "discount" ? -Math.abs(value) : value;
          priced ||= type === "price";
        }
        return priced && subtotal > 0 ? { subtotal: { value: subtotal, currency } } : null;
      },

      credits(res) {
        // Hostaway says what is left only when it is spent: a 429 and when to come back.
        if (res.status !== 429) return null;
        return { remaining: 0, resetsInMs: hostawayRetryAfterMs(res.headers, Date.now()) };
      },
    },

    hooks: {
      topics: HOSTAWAY_EVENTS,

      async verify(ctx, request: InboundRequest): Promise<HookEvent | null> {
        const login = ctx.secret.hook_login ?? "";
        const password = ctx.secret.hook_password ?? "";
        const given = parseBasic(request.headers.get("authorization"));
        // Both compared, whatever the first says, each in constant time.
        const userOk = constantTimeEqual(given?.user ?? "", login);
        const passOk = constantTimeEqual(given?.pass ?? "", password);
        if (!login || !password || !given || !userOk || !passOk) {
          throw new ConnectorError("refused", "The webhook's login does not check out.");
        }
        let body: Json | null;
        try {
          body = obj(JSON.parse(request.body));
        } catch {
          body = null;
        }
        if (!body) return null;
        const event = str(body.event) ?? "";
        const object = (str(body.object) ?? "").toLowerCase();
        // Guest messages stay in Hostaway: answered, and nothing read.
        if (/^(message|conversation)/i.test(event) || /message|conversation/.test(object)) return null;
        const account = body.accountId;
        if (account !== undefined && account !== null && idOf(account) !== (ctx.secret.account_id ?? "")) return null;
        const data = obj(body.data) ?? obj(body.payload) ?? body;
        // Read by what it is about, whatever its event is called (the documented names are prose only):
        // a reservation, or a delivery whose own envelope names one. Another object, or an event added
        // later about something else, is answered and left alone.
        const about = object === "reservation" || /^reservation/i.test(event);
        const id = (about ? (idOf(body.objectId) ?? idOf(data.id)) : null) ?? idOf(body.reservationId);
        if (!about && !id) return null;
        const listing = idOf(body.listingMapId) ?? idOf(data.listingMapId);
        const refs = id ? [`reservation:${id}`] : listing ? [`listing:${listing}`] : ["all"];
        const topic = event || "reservation";
        // Hostaway gives a delivery no id: one sent again within ten minutes is the same one.
        const digest = (await sha256Hex(request.body)).slice(0, 24);
        const bucket = Math.floor(ctx.now / HOOK_DEDUPE_MS);
        return { eventId: `${topic}:${id ?? listing ?? "all"}:${digest}:${bucket}`, topic, refs };
      },

      async read(ctx, event): Promise<readonly HookFact[]> {
        const facts: HookFact[] = [];
        for (const ref of event.refs) {
          const [kind, raw] = ref.split(":");
          const id = idOf(raw);
          if (kind === "reservation" && id) {
            let r: Reservation;
            try {
              r = await reservation(ctx, id);
            } catch (error) {
              // Named before Hostaway shows it (webhooks come out of order): read again later, never dropped.
              if (error instanceof ConnectorError && error.code === "not_found") {
                throw new ConnectorError("unreachable", `Hostaway does not show reservation ${id} yet.`);
              }
              throw error;
            }
            const roomIds = r.listingId ? [r.listingId] : undefined;
            const spans: [string | null, string | null][] = [
              [r.arrival, r.departure],
              [r.previousArrival, r.previousDeparture],
            ];
            for (const [from, to] of spans) {
              if (from && to && from < to)
                facts.push({ kind: "stay_nights", ...(roomIds ? { roomIds } : {}), from, to });
            }
          } else if (kind === "listing" && id) {
            facts.push({ kind: "stay_nights", roomIds: [id], ...nextNights(ctx.now) });
          } else if (kind === "all") {
            facts.push({ kind: "stay_nights", ...nextNights(ctx.now) });
          }
        }
        return facts;
      },
    },

    stayWriter: {
      async put(ctx, stay, link, status) {
        const listingIds = listingsOfStay(stay);
        const provisional = status !== "confirmed";
        if (!link?.externalId) {
          // No idempotency key in Hostaway: what was written already under a room's key is found, never
          // made twice; one cancelled in Hostaway since is the owner's word, never written over.
          const found = await findRooms(ctx, stay);
          const ours = found.filter((r): r is Reservation => r !== null);
          const gone = ours.find((r) => !blocks(r.status));
          if (gone) {
            // A stay is all or nothing: the rooms still held go with the one the owner cancelled.
            const left = await takeBack(
              ctx,
              ours.filter((r) => blocks(r.status)).map((r) => r.id),
            );
            throw new ConnectorError(
              "refused",
              [notHeld(gone.status), left.length ? cancelThere(left) : ""].join(" ").trim(),
            );
          }
          const keys = roomKeys(stay);
          const ids: (string | null)[] = listingIds.map((_, i) => found[i]?.id ?? null);
          try {
            // Every room's nights read live before any room is written, so nothing is written onto a
            // night another channel took, and a stay that cannot be whole writes nothing.
            for (const [i, listingId] of listingIds.entries()) {
              if (!ids[i]) await requireFree(ctx, listingId, stay.checkIn, stay.checkOut, null);
            }
            for (const [i, listingId] of listingIds.entries()) {
              if (ids[i]) continue;
              const q = new URLSearchParams({ provider: HOSTAWAY_PROVIDER });
              const a = await call(ctx, "POST", `/reservations?${q.toString()}`, {
                body: {
                  channelId: HOSTAWAY_DIRECT_CHANNEL,
                  listingMapId: Number(listingId),
                  ...stayFields(stay, i),
                  hostNote: noteOf(stay, keys[i] ?? stay.key, provisional, i),
                },
                timeoutMs: WRITE_TIMEOUT_MS,
              });
              const no = refusal(a);
              if (no) throw new ConnectorError("refused", no);
              const id = idOf(obj(obj(a.json)?.result)?.id);
              if (!id) throw new ConnectorError("bad_response", "Hostaway answered without the reservation's id.");
              ids[i] = id;
            }
          } catch (error) {
            const written = ids.filter((x): x is string => x !== null);
            if (error instanceof ConnectorError && (error.code === "refused" || error.code === "config")) {
              // One room refused: the rooms written for this stay are taken back, so none is left holding.
              const left = await takeBack(ctx, written);
              throw new ConnectorError(
                "refused",
                [error.message, left.length ? cancelThere(left) : ""].join(" ").trim(),
              );
            }
            // Asked to wait part of the way through: what was written is looked for by its key, read back as
            // not whole, and taken back, never left behind (a 429 alone is settled as never written).
            if (written.length > 0 && error instanceof ConnectorError && error.code === "rate_limited") {
              throw new ConnectorError("unreachable", error.message);
            }
            throw error;
          }
          return { externalId: ids.join(","), etag: null, calendar: listingIds.join(",") };
        }
        const linked = idsOf(link.externalId);
        if (!linked) throw new ConnectorError("refused", "That is not a reservation Hostaway gave.");
        if (linked.length !== listingIds.length) {
          throw new ConnectorError(
            "refused",
            "Hostaway keeps one reservation per room, so a room is added to or taken from this stay in Hostaway.",
          );
        }
        const current: Reservation[] = [];
        for (const id of linked) {
          current.push(
            await reservation(ctx, id).catch((error: unknown) => {
              if (error instanceof ConnectorError && error.code === "not_found") {
                throw new ConnectorError("refused", `Hostaway does not show reservation ${id} any more.`);
              }
              throw error;
            }),
          );
        }
        // Cancelled, declined or an inquiry now: never brought back by a write of ours.
        const gone = current.find((r) => !blocks(r.status));
        if (gone) throw new ConnectorError("refused", notHeld(gone.status));
        // Each room to its own reservation, by its listing: never moved to another listing ("not possible
        // to update the listingMapId").
        const mine: Reservation[] = [];
        for (const listingId of listingIds) {
          const r =
            current.find((x) => x.listingId === listingId) ??
            (current.length === 1 && current[0]?.listingId === null ? current[0] : undefined);
          if (!r || mine.includes(r)) {
            throw new ConnectorError(
              "refused",
              "Hostaway does not move a reservation to another listing: change it in Hostaway.",
            );
          }
          mine.push(r);
        }
        // Every room's new nights read live before any is changed.
        for (const [i, r] of mine.entries()) {
          if (r.arrival !== stay.checkIn || r.departure !== stay.checkOut) {
            await requireFree(ctx, listingIds[i] ?? "", stay.checkIn, stay.checkOut, r.id);
          }
        }
        const changed: { readonly r: Reservation; readonly sent: Json }[] = [];
        for (const [i, r] of mine.entries()) {
          const marker = r.hostNote ? MARKER.exec(r.hostNote)?.[1] : undefined;
          // Whether a PUT keeps what it is not sent is not documented, so only what this write is about
          // is sent. Our own note says where the stay stands; one the owner wrote is left as it is.
          const sent: Json = {
            ...stayFields(stay, i),
            ...(marker && ownNote(r.hostNote) ? { hostNote: noteOf(stay, marker, provisional, i) } : {}),
          };
          let no: string | null;
          try {
            no = refusal(await call(ctx, "PUT", `/reservations/${r.id}`, { body: sent, timeoutMs: WRITE_TIMEOUT_MS }));
          } catch (error) {
            // Not answered, or asked to wait: thrown as it is, and the owner is told to check if it stays so.
            if (!(error instanceof ConnectorError && error.code === "refused")) throw error;
            no = error.message;
          }
          if (no) {
            // One room refused: the rooms already changed are put back as they were, so the stay keeps
            // its dates in Hostaway as here.
            const stuck = await putBack(ctx, changed);
            throw new ConnectorError(
              "refused",
              stuck.length === 0
                ? no
                : stuck.length === 1
                  ? `${no} Reservation ${stuck[0]} took the new dates and could not be put back: check it in Hostaway.`
                  : `${no} Reservations ${stuck.join(", ")} took the new dates and could not be put back: check them in Hostaway.`,
            );
          }
          changed.push({ r, sent });
        }
        return { externalId: mine.map((r) => r.id).join(","), etag: null, calendar: listingIds.join(",") };
      },

      async cancel(ctx, link) {
        const ids = idsOf(link.externalId);
        if (!ids) return;
        const left: string[] = [];
        let why: string | null = null;
        for (const id of ids) {
          const no = await cancelOne(ctx, id);
          if (no) {
            left.push(id);
            why ??= no;
          }
        }
        if (left.length === 0) return;
        throw new ConnectorError(
          "refused",
          ids.length === 1 ? (why ?? "Hostaway did not take it.") : `${why} ${cancelThere(left)}`,
        );
      },

      find(ctx, stay) {
        return find(ctx, stay);
      },

      async oversold(ctx, stay, link) {
        const ids = idsOf(link.externalId);
        if (!ids) throw new ConnectorError("bad_response", "No reservation to read back.");
        // A stay of several rooms with only some of them there is not booked: it cannot be sound, and it
        // is taken back once the resolver has looked.
        if (ids.length !== stay.rooms.length) {
          throw new ConnectorError(
            "bad_response",
            `Hostaway shows ${ids.length} of the ${stay.rooms.length} rooms of this stay.`,
          );
        }
        let unknown: ConnectorError | null = null;
        for (const id of ids) {
          try {
            if (await oversoldOne(ctx, id)) return true;
          } catch (error) {
            if (!(error instanceof ConnectorError)) throw error;
            // One room it cannot tell yet: the others are still read, since one oversold is definite.
            unknown ??= error;
          }
        }
        if (unknown) throw unknown;
        return false;
      },
    },
  };
  return definition;
}
