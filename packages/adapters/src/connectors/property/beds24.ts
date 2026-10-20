import {
  type AriRow,
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  CREDIT_RESERVE,
  decimalAmount,
  type ExternalProperty,
  type ExternalRate,
  type ExternalRoom,
  type HookEvent,
  type HookFact,
  type LinkState,
  minorAmount,
  minorUnits,
  type OutboundStay,
  type RunContext,
  type StayPriceQuery,
  type StayWriteStatus,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";

/**
 * Beds24 (ADR-033 §8.2): a place to stay's own channel manager and property system, over its API V2
 * with an invite code the owner makes in Beds24. Rooms and what is free come in; stays are written to
 * Beds24 before the inbox promises anything; Beds24's word that a booking changed is a hint to read
 * again, never a fact.
 *
 * Built from Beds24's own documentation, never against a real account:
 * - the OpenAPI file, https://beds24.com/api/v2/apiV2.yaml (paths, fields, headers, the webhook body);
 * - the wiki, https://wiki.beds24.com/index.php/API_V2.0 (invite codes for 24 hours, tokens for 24
 *   hours, refresh tokens forgotten after 30 days unused, 100 credits per five minutes by default,
 *   "Usage limit exceeded", prices not calculated for bookings made through the API, `allowWebhooks`).
 *
 * What the documentation leaves open, and how this adapter stays safe either way:
 * - Which booking status keeps a room off sale while a deposit is awaited is not documented (D6). So
 *   nothing is ever written as a hold (`hold: "none"`): a stay with something due now is written as
 *   confirmed, flagged "Deposit due", and cancelled by the inbox if it is not paid.
 * - Nothing documents that a write refuses a full night, except `checkAvailability` on a new booking.
 *   So the nights are read live just before every write, `checkAvailability` is asked for, and every
 *   write is read back: as written (its key, dates, room and price) and not oversold, by Beds24's own
 *   count (its calendar's `numAvail` below zero, or more bookings on a night than the room has units).
 * - The setup call is GET in the OpenAPI file and POST in the wiki's FAQ: GET is asked first, POST
 *   when GET is not served.
 * - The credit headers are spelled `x-five-min-limit-remaining` in the wiki and
 *   `X-FiveMinCreditLimit-Remaining` in the OpenAPI file: both are read.
 * - `GET /properties/rooms` is "Coming soon": rooms are read from `GET /properties` with
 *   `includeAllRooms`.
 * - How an offer is priced from the calendar's sixteen daily prices is not documented: the cache keeps
 *   the calendar's own daily prices under their own names (`price1`…`price16`), and the live total
 *   comes from `/inventory/rooms/offers` only where it is not ambiguous.
 *
 * - A stay's price is written and read back only with the `bookings-financial` scope (the wiki: it
 *   "provides access to financial information" on GET and POST /bookings): the code must allow it.
 * - Whether a lookup by id or by our key is held to "upcoming bookings only" (the OpenAPI file's default
 *   for GET /bookings) is not said: every such lookup names a wide arrival date, so a past stay is found.
 * - Which charges besides the nightly price a guest pays (a room's cleaning fee and taxes, a property's
 *   obligatory extras) are not in the calendar's prices: the owner is told of them while matching rooms.
 *
 * Every call goes to https://beds24.com/api/v2 and nowhere else; a next-page link is followed only on
 * that host. The token goes in the `token` header; no card detail, deposit or commission is ever sent.
 * The code asks for read and write on bookings, never `all:` (which also deletes), though an `all:`
 * scope a code already has covers both.
 */

export const BEDS24_HOST = "beds24.com";
export const BEDS24_API = `https://${BEDS24_HOST}/api/v2`;
/** Where the owner makes an invite code (the OpenAPI file's own link). */
export const BEDS24_CODES_URL = "https://beds24.com/control3.php?pagetype=apiv2";
/** What the invite code must allow: an `all:` scope a code has covers its `read:` and `write:` ones. */
export const BEDS24_SCOPES = [
  "read:bookings",
  "write:bookings",
  "read:bookings-personal",
  "read:bookings-financial",
  "write:bookings-financial",
  "read:inventory",
  "read:properties",
] as const;
/** Each scope as the owner chooses it in Beds24. */
const SCOPE_WORDS: Readonly<Record<string, string>> = {
  bookings: "Bookings",
  "bookings-personal": "Bookings personal",
  "bookings-financial": "Bookings financial",
  inventory: "Inventory",
  properties: "Properties",
};
/** Beds24 forgets a refresh token unused for 30 days: it is used at least this often. */
export const BEDS24_REFRESH_EVERY_MS = 7 * 86_400_000;
/** A token is made again this long before Beds24 says it ends. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** What a five-minute credit window is when Beds24 does not say. */
const WINDOW_MS = 5 * 60_000;
const MAX_BYTES = 1_048_576;
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
/** The most rooms one stay is written as: one Beds24 booking each, in a group. */
const MAX_ROOMS = 10;
/** Every status, so a booking is found whatever became of it. */
const ALL_STATUSES = ["confirmed", "request", "new", "cancelled", "black", "inquiry"] as const;
/** The statuses counted as taking a room when the inbox counts bookings against units. */
const BLOCKING = new Set(["confirmed", "request", "new", "black"]);
/** The flag a stay waiting for its deposit carries in Beds24, and only such a stay. */
export const BEDS24_WAITING_FLAG = "Deposit due";
const WAITING_COLOR = "f2c94c";
/** The code of the one info item this inbox keeps on its own bookings: what is due, or paid. */
export const BEDS24_INFO_CODE = "INBOX";
const DEPOSIT_TEXT = "Deposit due: your inbox cancels this stay if it is not paid in time.";
/** The largest amount Beds24 documents for a booking's price (`maximum: 99999999.99`). */
const MAX_PRICE = 99_999_999.99;
/** Words shared with the owner (ready-hotels §12 S2). */
const BUSY = "Beds24 is busy right now. We'll try again in a few minutes.";
const EXPIRED = "Beds24 didn't take that code. Copy it again, or make a new one: a code lasts 24 hours.";
const MISSING = "That booking was not found in Beds24: check it there.";
const GONE = "Beds24 no longer takes this connection. Make a new invite code in Beds24 and connect again.";
const NOT_ANSWERING = "Beds24 is not answering properly; this inbox tries again in a few minutes.";
const NOT_FREE = "Those nights are no longer free in Beds24.";

/** What the code must allow, in the words of Beds24's own choices: the same on the form and the docs. */
export const BEDS24_CHOOSE =
  "Bookings: Read and Write · Bookings personal: Read · Bookings financial: Read and Write · Inventory: Read · Properties: Read";

export const beds24Form = z.object({
  invite_code: secretField(z.string().trim().min(8).max(500), {
    label: "Invite code",
    link: { href: BEDS24_CODES_URL, text: "Open Beds24's API page" },
    placeholder: "Paste the code from Beds24",
    steps: [
      "In Beds24, open Settings → Marketplace → API and press Generate invite code.",
      `Choose ${BEDS24_CHOOSE}. Leave the IP address empty.`,
      "Paste the code here. It works for 24 hours.",
    ],
  }),
});

/* --- dates and money ------------------------------------------------------- */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The nights from `from` up to `to`, `to` excluded. */
function nightsOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Minor units as Beds24 takes money: a number in the currency's own decimals (¥25,800 → 25800). */
export function beds24Amount(amount: { readonly value: number; readonly currency: string }): number {
  return Number(decimalAmount(amount));
}

/**
 * An amount as a booking's price: refused before anything is written when Beds24 could not hold it as
 * given — above its documented maximum, or in a currency of three decimals, which its two-decimal
 * maximum suggests it rounds (a booking it rounded would never read back as written).
 */
export function writableAmount(amount: { readonly value: number; readonly currency: string }): number {
  const e = minorUnits(amount.currency);
  if (e === null || e === undefined || e > 2) {
    throw new ConnectorError(
      "refused",
      `Stays in ${amount.currency} are not written to Beds24 yet: confirm this one there yourself.`,
    );
  }
  const value = beds24Amount(amount);
  if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
    throw new ConnectorError("refused", "That total is more than Beds24 takes for one booking.");
  }
  return value;
}

/** Text that keeps whole characters: trimmed, composed, and cut by character, never through one. */
function textOf(raw: string, max: number): string {
  return [...raw.normalize("NFC").trim()].slice(0, max).join("");
}

/** A Beds24 amount back to minor units of its currency; null when it is not one this inbox can hold. */
export function fromBeds24Amount(value: unknown, currency: string): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const e = minorUnits(currency);
  if (e === null || e === undefined) return null;
  return minorAmount(String(value), e);
}

/* --- talking to Beds24 ------------------------------------------------------ */

/** What one answer says of the account's credits: Beds24's headers, in either documented spelling. */
export interface Beds24Budget {
  readonly remaining: number;
  readonly resetsInMs: number;
  readonly cost: number;
}

function headerNumber(headers: Headers, ...names: string[]): number | null {
  for (const n of names) {
    const raw = headers.get(n);
    if (raw === null || raw.trim() === "") continue;
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

export function beds24Budget(headers: Headers): Beds24Budget | null {
  const remaining = headerNumber(headers, "x-five-min-limit-remaining", "x-fivemincreditlimit-remaining");
  if (remaining === null) return null;
  const resets = headerNumber(headers, "x-five-min-limit-resets-in", "x-fivemincreditlimit-resetsin");
  const cost = headerNumber(headers, "x-request-cost", "x-requestcost");
  return {
    remaining,
    // Seconds until the five-minute window is over (the OpenAPI file's own words).
    resetsInMs: resets !== null && resets >= 0 ? Math.min(resets, 3_600) * 1000 : WINDOW_MS,
    cost: cost !== null && cost >= 0 ? cost : 1,
  };
}

/** Whether a URL is Beds24's API, the only place this adapter calls. */
export function isBeds24Url(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === BEDS24_HOST && u.port === "" && u.pathname.startsWith("/api/v2/");
  } catch {
    return false;
  }
}

type Query = Readonly<Record<string, string | number | boolean | readonly (string | number)[] | undefined>>;

function urlOf(path: string, query: Query = {}): string {
  const u = new URL(`${BEDS24_API}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * The next page, as Beds24 names it: followed only when it is Beds24's API itself. A link to anywhere
 * else is refused before anything is asked of it.
 */
export function nextPageUrl(link: unknown, current: string, page: number): string {
  if (typeof link !== "string" || link.trim() === "") {
    const u = new URL(current);
    u.searchParams.set("page", String(page));
    return u.toString();
  }
  const raw = link.trim();
  let candidate: string;
  if (raw.startsWith("/")) candidate = `https://${BEDS24_HOST}${raw}`;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw))
    candidate = raw.replace(/^http:\/\/beds24\.com\//i, `https://${BEDS24_HOST}/`);
  else candidate = `https://${raw}`;
  if (!isBeds24Url(candidate)) {
    throw new ConnectorError("bad_response", "Beds24 named another address for the next page; it was not followed.");
  }
  return candidate;
}

interface Answer {
  readonly res: ConnectorHttpResponse;
  readonly json: unknown;
  readonly budget: Beds24Budget | null;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorText(json: unknown): string {
  const j = (json ?? {}) as { error?: unknown; message?: unknown };
  const m = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : "";
  return m.slice(0, 200);
}

/**
 * Beds24's own way of saying the credits are spent, whatever the status it says it with: 429, or an
 * error answer that says "Usage limit exceeded" (never words inside a booking that happen to).
 */
function limited(res: ConnectorHttpResponse, json: unknown): boolean {
  if (res.status === 429) return true;
  const failed = (json as { success?: unknown } | null)?.success === false;
  if (failed) return /usage limit exceeded/i.test(errorText(json));
  return json === null && res.status >= 400 && /usage limit exceeded/i.test(res.text.slice(0, 500));
}

function waitFor(budget: Beds24Budget | null, res: ConnectorHttpResponse): number {
  if (budget) return Math.max(1_000, budget.resetsInMs);
  const after = Number(res.headers.get("retry-after"));
  return Number.isFinite(after) && after > 0 ? Math.min(after, 3_600) * 1000 : WINDOW_MS;
}

async function send(
  ctx: Pick<ConnectContext, "http">,
  method: "GET" | "POST" | "DELETE",
  url: string,
  headers: Readonly<Record<string, string>>,
  body?: unknown,
): Promise<Answer> {
  // Fixed host, checked before anything leaves: never an address from an answer that is not Beds24's.
  if (!isBeds24Url(url)) throw new ConnectorError("config", "Only Beds24's own address is called.");
  const res = await ctx.http.request({
    method,
    url,
    headers: {
      accept: "application/json",
      ...headers,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    maxBytes: MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
    followRedirects: false,
  });
  const json = parseJson(res.text);
  const budget = beds24Budget(res.headers);
  if (limited(res, json)) {
    throw new ConnectorError("rate_limited", BUSY, { retryAfterMs: waitFor(budget, res) });
  }
  if (res.status >= 500) throw new ConnectorError("unreachable", NOT_ANSWERING);
  if (res.status >= 300 && res.status < 400) {
    throw new ConnectorError("bad_response", "Beds24 answered with a redirect, which is not followed.");
  }
  return { res, json, budget };
}

/** Whether an answer says the token was not taken. */
function refusedToken(a: Answer): boolean {
  if (a.res.status === 401 || a.res.status === 403) return true;
  const code = (a.json as { code?: unknown } | null)?.code;
  return (code === 401 || code === 403) && (a.json as { success?: unknown }).success === false;
}

/* --- the token ------------------------------------------------------------------ */

interface Held {
  token: string;
  expiresAt: number;
}

/** Tokens made during a run, by the run's sealed secret: saved for the next run, used for this one. */
const held = new WeakMap<object, Held>();

async function mintToken(ctx: RunContext): Promise<string> {
  const refreshToken = ctx.secret.refresh_token ?? "";
  if (!refreshToken) throw new ConnectorError("auth", GONE);
  const a = await send(ctx, "GET", urlOf("/authentication/token"), { refreshToken });
  const token = (a.json as { token?: unknown } | null)?.token;
  if (a.res.status !== 200 || typeof token !== "string" || !token) {
    if (a.res.status === 400 || refusedToken(a)) throw new ConnectorError("auth", GONE);
    throw new ConnectorError("bad_response", "Beds24 answered without a token.");
  }
  const expiresIn = Number((a.json as { expiresIn?: unknown }).expiresIn);
  const expiresAt = ctx.now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86_400) * 1000;
  held.set(ctx.secret, { token, expiresAt });
  await ctx.saveSecret({
    ...ctx.secret,
    token,
    token_expires_at: String(expiresAt),
    refresh_used_at: String(ctx.now),
  });
  return token;
}

async function tokenOf(ctx: RunContext): Promise<string> {
  const mine = held.get(ctx.secret);
  if (mine && mine.expiresAt - TOKEN_MARGIN_MS > ctx.now) return mine.token;
  const saved = ctx.secret.token;
  const until = Number(ctx.secret.token_expires_at ?? 0);
  if (saved && Number.isFinite(until) && until - TOKEN_MARGIN_MS > ctx.now) return saved;
  return mintToken(ctx);
}

/** One call with the account's token: made again once when Beds24 no longer takes the one held. */
async function api(
  ctx: RunContext,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  opts: { readonly write?: boolean } = {},
): Promise<Answer> {
  let a = await send(ctx, method, url, { token: await tokenOf(ctx) }, body);
  if (refusedToken(a)) a = await send(ctx, method, url, { token: await mintToken(ctx) }, body);
  if (refusedToken(a)) throw new ConnectorError("auth", GONE);
  if (a.res.status === 404) throw new ConnectorError("not_found", "Beds24 does not have that.");
  if (a.res.status >= 400) {
    const why = errorText(a.json) || `Beds24 answered ${a.res.status}.`;
    // A write Beds24 answered with a refusal did not land; a read it did not take is ours to fix.
    throw new ConnectorError(opts.write ? "refused" : "bad_response", why);
  }
  if ((a.json as { success?: unknown } | null)?.success === false && !opts.write) {
    throw new ConnectorError("bad_response", errorText(a.json) || "Beds24 said it could not.");
  }
  return a;
}

function dataOf(json: unknown): unknown[] {
  const d = (json as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? d : [];
}

/**
 * Every page of a list. With `reserve`, no further page is asked for once the account's credits would
 * fall below the reserve kept for holds and bookings: the answer then says it is incomplete.
 */
async function collect(
  ctx: RunContext,
  path: string,
  query: Query,
  opts: { readonly reserve?: boolean | undefined } = {},
): Promise<{ readonly data: unknown[]; readonly complete: boolean }> {
  let url = urlOf(path, query);
  const data: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const a = await api(ctx, "GET", url);
    data.push(...dataOf(a.json));
    const pages = (a.json as { pages?: { nextPageExists?: unknown; nextPageLink?: unknown } } | null)?.pages;
    if (pages?.nextPageExists !== true) return { data, complete: true };
    if (opts.reserve && a.budget && a.budget.remaining - Math.max(1, a.budget.cost) < CREDIT_RESERVE) {
      return { data, complete: false };
    }
    url = nextPageUrl(pages.nextPageLink, url, page + 1);
  }
  return { data, complete: false };
}

/* --- what Beds24 holds ------------------------------------------------------------ */

interface B24Room {
  readonly id: number;
  readonly name?: string;
  readonly qty?: number;
  readonly maxPeople?: number;
  readonly maxAdult?: number | null;
  readonly maxChildren?: number | null;
  readonly cleaningFee?: number | null;
  readonly taxPercentage?: number | null;
  readonly taxPerson?: number | null;
  readonly securityDeposit?: number | null;
}

interface B24Upsell {
  readonly enable?: boolean;
  readonly type?: string;
  readonly amount?: number;
}

interface B24Property {
  readonly id: number;
  readonly name?: string;
  readonly currency?: string;
  readonly roomTypes?: readonly B24Room[];
  readonly upsellItems?: readonly B24Upsell[];
}

interface B24Info {
  readonly id?: number;
  readonly code?: string;
  readonly text?: string;
}

export interface B24Booking {
  readonly id: number;
  readonly propertyId?: number;
  readonly roomId?: number;
  readonly roomQty?: number;
  readonly status?: string;
  readonly arrival?: string;
  readonly departure?: string;
  readonly price?: number;
  readonly numAdult?: number;
  readonly numChild?: number;
  readonly apiReference?: string;
  readonly masterId?: number | null;
  readonly bookingGroup?: { readonly master?: number; readonly ids?: readonly number[] } | null;
  readonly lastName?: string;
  readonly flagText?: string;
  readonly flagColor?: string;
  readonly infoItems?: readonly B24Info[];
}

const intId = (raw: string): number | null => (/^\d{1,12}$/.test(raw) ? Number(raw) : null);

function idOrRefuse(raw: string, what: string): number {
  const n = intId(raw);
  if (n === null) throw new ConnectorError("config", `That is not a Beds24 ${what}.`);
  return n;
}

async function readProperties(ctx: RunContext, query: Query = {}): Promise<B24Property[]> {
  const { data } = await collect(ctx, "/properties", query);
  return data.filter((p): p is B24Property => typeof (p as B24Property)?.id === "number");
}

async function readProperty(
  ctx: RunContext,
  propertyId: string,
  opts: { readonly upsells?: boolean } = {},
): Promise<B24Property> {
  const id = idOrRefuse(propertyId, "property");
  const [p] = await readProperties(ctx, {
    id: [id],
    includeAllRooms: true,
    ...(opts.upsells ? { includeUpsellItems: true } : {}),
  });
  if (!p || p.id !== id)
    throw new ConnectorError("not_found", "Beds24 does not show that property to this connection.");
  return p;
}

const currencies = new WeakMap<object, Map<string, string>>();

/** The property's currency: what connecting found, else asked once per run. */
async function currencyOf(ctx: RunContext, propertyId: string): Promise<string | null> {
  const known = (ctx.extra.currencies as Record<string, unknown> | undefined)?.[propertyId];
  if (typeof known === "string" && /^[A-Z]{3}$/.test(known)) return known;
  const cache = currencies.get(ctx.secret) ?? new Map<string, string>();
  currencies.set(ctx.secret, cache);
  const hit = cache.get(propertyId);
  if (hit) return hit;
  const c = (await readProperty(ctx, propertyId)).currency?.toUpperCase();
  if (!c || !/^[A-Z]{3}$/.test(c)) return null;
  cache.set(propertyId, c);
  return c;
}

/** Bookings matching a query, every page: by id, by our key, or overlapping some nights. */
async function readBookings(ctx: RunContext, query: Query): Promise<B24Booking[]> {
  const { data } = await collect(ctx, "/bookings", query);
  return data.filter((b): b is B24Booking => typeof (b as B24Booking)?.id === "number");
}

/**
 * The earliest arrival a lookup by id or by our key names: Beds24 answers only upcoming bookings by
 * default, and does not say whether that holds for an id, so a stay already past is still found.
 */
const SINCE = "2000-01-01";

interface CalendarEntry {
  readonly from?: string;
  readonly to?: string;
  readonly numAvail?: number;
  readonly minStay?: number;
  readonly maxStay?: number;
  readonly multiplier?: number;
  readonly override?: string;
  readonly [price: `price${number}`]: number | undefined;
}

interface CalendarRoom {
  readonly roomId?: number;
  readonly calendar?: readonly CalendarEntry[];
}

/** One room's night as the calendar has it. */
interface Night {
  readonly roomId: string;
  readonly night: string;
  readonly entry: CalendarEntry;
}

/** The calendar's nights from `from` up to `to` (`to` excluded), ranges opened out. */
function calendarNights(rooms: readonly unknown[], from: string, to: string): Night[] {
  const out = new Map<string, Night>();
  for (const raw of rooms) {
    const room = raw as CalendarRoom;
    if (typeof room?.roomId !== "number" || !Array.isArray(room.calendar)) continue;
    const roomId = String(room.roomId);
    for (const entry of room.calendar) {
      const a = typeof entry?.from === "string" && DATE.test(entry.from) ? entry.from : null;
      const b = typeof entry?.to === "string" && DATE.test(entry.to) ? entry.to : a;
      if (!a || !b) continue;
      // A range names its last night itself (`to` included).
      for (let d = a < from ? from : a; d <= b && d < to; d = addDays(d, 1)) {
        out.set(`${roomId}|${d}`, { roomId, night: d, entry });
      }
    }
  }
  return [...out.values()];
}

const SLOTS = Array.from({ length: 16 }, (_, i) => `price${i + 1}` as const);

/** The calendar's daily prices on a night, in minor units; none on a night with a multiplier. */
function pricesOf(entry: CalendarEntry, currency: string | null): Record<string, number> | undefined {
  if (!currency) return undefined;
  // A multiplier changes what the night sells for; rather than work out a price, none is given.
  if (entry.multiplier !== undefined && entry.multiplier !== null && entry.multiplier !== 1) return undefined;
  const out: Record<string, number> = {};
  for (const slot of SLOTS) {
    const v = fromBeds24Amount(entry[slot], currency);
    if (v !== null && v > 0) out[slot] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function rowOf(n: Night, currency: string | null): AriRow | null {
  const e = n.entry;
  if (typeof e.numAvail !== "number" || !Number.isFinite(e.numAvail)) return null;
  // An override the documentation does not explain is left out: a night nobody can read is not offered.
  if (e.override === "exception") return null;
  const prices = pricesOf(e, currency);
  return {
    roomId: n.roomId,
    night: n.night,
    units: Math.trunc(e.numAvail),
    ...(e.override === "blackout" ? { closed: true } : {}),
    ...(e.override === "noCheckIn" || e.override === "noCheckInOrCheckOut" ? { noArrival: true } : {}),
    ...(e.override === "noCheckOut" || e.override === "noCheckInOrCheckOut" ? { noDeparture: true } : {}),
    ...(typeof e.minStay === "number" && e.minStay >= 1 ? { minStay: e.minStay } : {}),
    ...(typeof e.maxStay === "number" && e.maxStay >= 1 ? { maxStay: e.maxStay } : {}),
    ...(prices ? { prices } : {}),
  };
}

/** The calendar for some rooms or a property, every page, or as far as the reserve allows. */
async function readCalendar(
  ctx: RunContext,
  where: { readonly propertyId?: number; readonly roomIds?: readonly number[] },
  from: string,
  to: string,
  opts: { readonly prices?: boolean; readonly reserve?: boolean } = {},
): Promise<{ readonly nights: Night[]; readonly complete: boolean }> {
  const { data, complete } = await collect(
    ctx,
    "/inventory/rooms/calendar",
    {
      ...(where.propertyId !== undefined ? { propertyId: [where.propertyId] } : {}),
      ...(where.roomIds?.length ? { roomId: where.roomIds } : {}),
      startDate: from,
      // The last night asked about: the night before `to`.
      endDate: addDays(to, -1),
      includeNumAvail: true,
      includeMinStay: true,
      includeMaxStay: true,
      includeOverride: true,
      ...(opts.prices ? { includePrices: true, includeMultiplier: true } : {}),
    },
    { reserve: opts.reserve },
  );
  return { nights: calendarNights(data, from, to), complete };
}

/* --- the connection ------------------------------------------------------------------ */

function hasScope(scopes: readonly string[], want: string): boolean {
  const [, what] = want.split(":");
  return scopes.includes(want) || scopes.includes(`all:${what}`);
}

/** Missing scopes as the owner chooses them in Beds24: "Bookings financial: Read and Write". */
export function missingWords(missing: readonly string[]): string {
  const byWhat = new Map<string, string[]>();
  for (const s of missing) {
    const [how, what] = s.split(":");
    if (!how || !what) continue;
    byWhat.set(what, [...(byWhat.get(what) ?? []), how === "read" ? "Read" : "Write"]);
  }
  return [...byWhat].map(([what, hows]) => `${SCOPE_WORDS[what] ?? what}: ${hows.join(" and ")}`).join(" · ");
}

/** Exchanges an invite code: GET as the OpenAPI file has it, POST where only that is served. */
async function exchange(
  ctx: ConnectContext,
  code: string,
): Promise<{ token: string; refreshToken: string; expiresIn: number }> {
  const headers = { code, deviceName: "Inbox" };
  let a = await send(ctx, "GET", urlOf("/authentication/setup"), headers);
  if (a.res.status === 404 || a.res.status === 405)
    a = await send(ctx, "POST", urlOf("/authentication/setup"), headers);
  const j = (a.json ?? {}) as { token?: unknown; refreshToken?: unknown; expiresIn?: unknown; success?: unknown };
  if ([400, 401, 403].includes(a.res.status) || j.success === false) {
    throw new ConnectorError("auth", EXPIRED, { field: "invite_code" });
  }
  if (a.res.status !== 200 || typeof j.refreshToken !== "string" || typeof j.token !== "string") {
    throw new ConnectorError("bad_response", "Beds24 did not answer the code as its documentation says.");
  }
  const expiresIn = Number(j.expiresIn);
  return {
    token: j.token,
    refreshToken: j.refreshToken,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86_400,
  };
}

/** Gives a refresh token back: it stops working at once. Best effort. */
async function forget(ctx: Pick<ConnectContext, "http">, refreshToken: string): Promise<void> {
  if (!refreshToken) return;
  try {
    await send(ctx, "DELETE", urlOf("/authentication/token"), { refreshToken });
  } catch {
    // Beds24 forgets an unused refresh token after 30 days anyway.
  }
}

/** The account in a few words: its one property's name, or how many it has (never the first one's). */
function accountOf(props: readonly B24Property[]): string {
  const names = props.map((p) => (p.name ?? "").trim()).filter(Boolean);
  if (props.length === 0) return "Beds24";
  return props.length === 1 && names[0] ? names[0] : `${props.length} properties`;
}

function extraOf(ownerId: string, props: readonly B24Property[]): Record<string, unknown> {
  return {
    owner_id: ownerId,
    property_ids: props.map((p) => String(p.id)),
    currencies: Object.fromEntries(
      props.filter((p) => typeof p.currency === "string").map((p) => [String(p.id), String(p.currency).toUpperCase()]),
    ),
  };
}

async function connect(ctx: ConnectContext, input: Readonly<Record<string, string>>): Promise<Connected> {
  const code = (input.invite_code ?? "").trim();
  if (!code) throw new ConnectorError("config", "Paste the invite code from Beds24.", { field: "invite_code" });
  const made = await exchange(ctx, code);
  const secret: Record<string, string> = {
    refresh_token: made.refreshToken,
    token: made.token,
    token_expires_at: String(ctx.now + made.expiresIn * 1000),
    refresh_used_at: String(ctx.now),
  };
  const run: RunContext = {
    ...ctx,
    secret,
    extra: {},
    calendars: [],
    busyCalendars: [],
    destinations: [],
    destination: null,
    own: { ids: new Set(), spans: [] },
    marker: "",
    async saveSecret(next) {
      Object.assign(secret, next);
    },
  };
  try {
    const details = await api(run, "GET", urlOf("/authentication/details"));
    const t = (details.json as { token?: { ownerId?: unknown; scopes?: unknown } } | null)?.token;
    const scopes = Array.isArray(t?.scopes) ? t.scopes.filter((s): s is string => typeof s === "string") : [];
    const missing = BEDS24_SCOPES.filter((s) => !hasScope(scopes, s));
    if (missing.length) {
      throw new ConnectorError(
        "config",
        `That code is missing ${missingWords(missing)}. Make a new code with ${missing.length === 1 ? "that" : "those"} too.`,
        { field: "invite_code" },
      );
    }
    const props = await readProperties(run);
    const ownerId =
      typeof t?.ownerId === "number"
        ? String(t.ownerId)
        : props
            .map((p) => p.id)
            .sort()
            .join(",");
    if (!ownerId)
      throw new ConnectorError("config", "That Beds24 account shows no property.", { field: "invite_code" });
    return {
      account: accountOf(props),
      externalId: ownerId,
      secret: { ...secret },
      extra: extraOf(ownerId, props),
      calendars: [],
      destinations: [],
      defaults: { busy: [], destination: null },
      // Another connection of this account kept instead: this one's refresh token is given back.
      settle: async (kept) => {
        if (!kept) await forget(ctx, made.refreshToken);
      },
    };
  } catch (error) {
    await forget(ctx, made.refreshToken);
    throw error;
  }
}

/* --- what is free ------------------------------------------------------------------ */

async function properties(ctx: RunContext): Promise<ExternalProperty[]> {
  return (await readProperties(ctx)).map((p) => ({
    id: String(p.id),
    name: (p.name ?? "").trim() || `Property ${p.id}`,
    ...(typeof p.currency === "string" && /^[A-Za-z]{3}$/.test(p.currency)
      ? { currency: p.currency.toUpperCase() }
      : {}),
  }));
}

function today(ctx: RunContext): string {
  return new Date(ctx.now).toISOString().slice(0, 10);
}

/** The rooms with a daily price on some night of the next 60, by id: the others answer nothing. */
async function pricedSlots(ctx: RunContext, propertyId: number): Promise<Map<string, Set<string>>> {
  const from = today(ctx);
  const { nights } = await readCalendar(ctx, { propertyId }, from, addDays(from, 60), { prices: true });
  const out = new Map<string, Set<string>>();
  for (const n of nights) {
    for (const slot of SLOTS) {
      const v = n.entry[slot];
      if (typeof v === "number" && v > 0) {
        const set = out.get(n.roomId) ?? new Set<string>();
        set.add(slot);
        out.set(n.roomId, set);
      }
    }
  }
  return out;
}

type Charge = NonNullable<ExternalRoom["charges"]>[number];

/** What Beds24 adds to a room besides its nightly price: its own fees and taxes, the property's obligatory extras. */
function chargesOf(room: B24Room, upsells: readonly B24Upsell[]): Charge[] {
  const out = new Set<Charge>();
  const set = (v: number | null | undefined) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (set(room.cleaningFee)) out.add("cleaning");
  if (set(room.taxPercentage) || set(room.taxPerson)) out.add("tax");
  if (set(room.securityDeposit)) out.add("deposit");
  for (const u of upsells) {
    if (u.enable === false || !set(u.amount) || !u.type?.startsWith("obligatory")) continue;
    out.add(u.type === "obligatoryCleaning" ? "cleaning" : /Tax$/.test(u.type) ? "tax" : "extra");
  }
  return [...out];
}

async function rooms(ctx: RunContext, propertyId: string): Promise<ExternalRoom[]> {
  const p = await readProperty(ctx, propertyId, { upsells: true });
  const priced = await pricedSlots(ctx, p.id);
  return (p.roomTypes ?? [])
    .filter((r) => typeof r.id === "number")
    .map((r) => {
      const adults = r.maxAdult ?? r.maxPeople ?? null;
      const children = r.maxChildren ?? 0;
      const charges = chargesOf(r, p.upsellItems ?? []);
      return {
        id: String(r.id),
        name: (r.name ?? "").trim() || `Room ${r.id}`,
        units: Math.max(0, Math.trunc(r.qty ?? 1)),
        ...(adults
          ? { capacity: { adults, children, total: Math.max(adults, r.maxPeople ?? adults + children) } }
          : {}),
        ...(priced.has(String(r.id)) ? {} : { unpriced: true }),
        ...(charges.length ? { charges } : {}),
      };
    });
}

async function ratePlans(ctx: RunContext, propertyId: string): Promise<ExternalRate[]> {
  const priced = await pricedSlots(ctx, idOrRefuse(propertyId, "property"));
  const bySlot = new Map<string, string[]>();
  for (const [room, slots] of priced) {
    for (const slot of slots) bySlot.set(slot, [...(bySlot.get(slot) ?? []), room]);
  }
  return SLOTS.filter((s) => bySlot.has(s)).map((s) => ({
    id: s,
    name: `Daily price ${s.slice(5)}`,
    roomIds: bySlot.get(s) ?? [],
  }));
}

async function ari(
  ctx: RunContext,
  propertyId: string,
  window: { readonly from: string; readonly to: string },
): Promise<AriRow[] | { readonly rows: readonly AriRow[]; readonly until: string }> {
  if (!DATE.test(window.from) || !DATE.test(window.to) || window.to <= window.from) return [];
  const id = idOrRefuse(propertyId, "property");
  const currency = await currencyOf(ctx, propertyId);
  const { nights, complete } = await readCalendar(ctx, { propertyId: id }, window.from, window.to, {
    prices: true,
    reserve: true,
  });
  const rows = nights.map((n) => rowOf(n, currency)).filter((r): r is AriRow => r !== null);
  // Stopped to keep credits for holds and bookings: nothing past the start is known to be complete.
  return complete ? rows : { rows, until: window.from };
}

/** Beds24's own total for a stay, where one offer is free for it: never a price worked out here. */
async function price(
  ctx: RunContext,
  q: StayPriceQuery,
): Promise<{ readonly subtotal: { readonly value: number; readonly currency: string } } | null> {
  const roomId = idOrRefuse(q.roomId, "room");
  const currency = await currencyOf(ctx, q.propertyId);
  if (!currency) return null;
  const { data } = await collect(ctx, "/inventory/rooms/offers", {
    roomId: [roomId],
    arrival: q.checkIn,
    departure: q.checkOut,
    numAdults: q.adults,
    numChildren: q.childrenAges.length,
  });
  const offers = data
    .filter((d) => (d as { roomId?: unknown }).roomId === roomId)
    .flatMap((d) => ((d as { offers?: unknown }).offers as unknown[] | undefined) ?? [])
    .map((o) => o as { offerId?: unknown; price?: unknown; unitsAvailable?: unknown })
    .filter((o) => typeof o.price === "number" && o.price > 0 && Number(o.unitsAvailable ?? 0) > 0);
  // Which offer a daily price belongs to is not documented: a total is given only when one offer is free.
  if (offers.length !== 1) return null;
  const value = fromBeds24Amount(offers[0]?.price, currency);
  return value === null ? null : { subtotal: { value, currency } };
}

/* --- writing stays ------------------------------------------------------------------ */

/** A key a change, a confirmation or a release is written under: the booking keeps the one it was made with. */
const MODIFY_KEY = /^sd-[0-9A-Za-z]+-(change|confirm|release)-/;

/** Our key for one room of a stay: the first room carries the stay's own, the others `~2`, `~3`… */
function roomKey(base: string, i: number): string {
  return i === 0 ? base : `${base}~${i + 1}`;
}

/** A room's key back to its stay's: `sd-01J…~2` → `sd-01J…`. */
function baseKey(ref: string): string {
  return ref.replace(/~\d{1,2}$/, "");
}

/** Which room of its stay a booking is, by its key: 0 for the stay's own, 1 for `~2`… */
function roomIndex(ref: string): number {
  const m = /~(\d{1,2})$/.exec(ref);
  return m?.[1] ? Number(m[1]) - 1 : 0;
}

/** Every key a stay's rooms can carry. */
function roomKeys(base: string): string[] {
  return Array.from({ length: MAX_ROOMS }, (_, i) => roomKey(base, i));
}

function amountWords(a: { readonly value: number; readonly currency: string }): string {
  return `${a.currency} ${decimalAmount(a)}`;
}

/** What the front desk reads on a stay paid here: amounts only, never a card or a commission. */
function amountsText(stay: OutboundStay): string | null {
  const a = stay.amounts;
  if (!a) return null;
  return `Paid in your inbox: ${amountWords(a.paid)}. Due at the property: ${amountWords(a.atProperty)}.`;
}

/** Our own info item on a booking, if it has one. */
function infoOf(b: B24Booking): B24Info | undefined {
  return (b.infoItems ?? []).find((x) => x.code === BEDS24_INFO_CODE && typeof x.id === "number");
}

/**
 * Our info item for one room of a stay: the deposit due while it waits, what was paid and is left once
 * confirmed (on its first room); added, changed by its id, or taken off where it no longer applies. The
 * owner's own notes are never written over.
 */
function infoItems(stay: OutboundStay, i: number, waiting: boolean, mine: B24Info | undefined) {
  const text = waiting ? DEPOSIT_TEXT : i === 0 ? amountsText(stay) : null;
  if (text) return [{ ...(mine?.id !== undefined ? { id: mine.id } : { code: BEDS24_INFO_CODE }), text }];
  // A room of a stay now confirmed, whose deposit note is out of date: taken off (an item with its id alone).
  if (mine?.id !== undefined && mine.text === DEPOSIT_TEXT) return [{ id: mine.id }];
  return null;
}

/** What one room of a stay is in Beds24: a booking. Never a card, a deposit or a commission. */
function bookingBody(
  stay: OutboundStay,
  i: number,
  status: StayWriteStatus,
  opts: {
    readonly id?: number;
    readonly key?: string;
    readonly masterId?: number;
    readonly group?: boolean;
    readonly clearFlag?: boolean;
    readonly info?: B24Info | undefined;
  },
): Record<string, unknown> {
  const r = stay.rooms[i];
  if (!r) throw new ConnectorError("config", "That stay has no such room.");
  const waiting = status === "provisional";
  const creating = opts.id === undefined;
  const guest = stay.guest;
  const info = infoItems(stay, i, waiting, opts.info);
  const name = guest ? textOf(guest.name, 100) : "";
  return {
    ...(creating ? {} : { id: opts.id }),
    roomId: idOrRefuse(r.roomId, "room"),
    // Written confirmed in every case: no status Beds24 documents is known to keep a room off sale.
    status: "confirmed",
    arrival: stay.checkIn,
    departure: stay.checkOut,
    numAdult: r.adults,
    numChild: r.childrenAges.length,
    // Beds24 does not price what an API writes: the inbox's own price for the room, in Beds24's decimals.
    price: writableAmount(r.price),
    ...(creating && opts.key ? { apiReference: opts.key } : {}),
    ...(creating && opts.masterId !== undefined ? { masterId: opts.masterId } : {}),
    // The owner's own notes and the guest's words are written once, when it is made, never written over.
    ...(creating ? { notes: `Written by your inbox · ${stay.reference}` } : {}),
    ...(creating && stay.notes ? { comments: textOf(stay.notes, 1000) } : {}),
    ...(info ? { infoItems: info } : {}),
    ...(waiting ? { flagText: BEDS24_WAITING_FLAG, flagColor: WAITING_COLOR } : {}),
    ...(!waiting && opts.clearFlag ? { flagText: "", flagColor: "" } : {}),
    // The guest's name whole, as they gave it: a name is not ordered the same way everywhere.
    ...(guest && name
      ? {
          lastName: name,
          ...(guest.email ? { email: textOf(guest.email, 100) } : {}),
          ...(guest.phone ? { phone: textOf(guest.phone, 100) } : {}),
        }
      : {}),
    actions: {
      allowWebhooks: true,
      ...(creating ? { checkAvailability: true } : {}),
      ...(creating && opts.group ? { makeGroup: true } : {}),
    },
  };
}

/** A booking as it was read a moment ago: what puts it back after part of a change did not go through. */
function asItWas(b: B24Booking): Record<string, unknown> {
  return {
    id: b.id,
    ...(typeof b.roomId === "number" ? { roomId: b.roomId } : {}),
    ...(typeof b.status === "string" ? { status: b.status } : {}),
    ...(typeof b.arrival === "string" ? { arrival: b.arrival } : {}),
    ...(typeof b.departure === "string" ? { departure: b.departure } : {}),
    ...(typeof b.numAdult === "number" ? { numAdult: b.numAdult } : {}),
    ...(typeof b.numChild === "number" ? { numChild: b.numChild } : {}),
    ...(typeof b.price === "number" ? { price: b.price } : {}),
    flagText: b.flagText ?? "",
    flagColor: b.flagColor ?? "",
    actions: { allowWebhooks: true },
  };
}

interface PostResult {
  readonly ok: boolean;
  readonly id: number | null;
  readonly why: string;
}

function postResults(json: unknown): PostResult[] {
  if (!Array.isArray(json)) return [];
  return json.map((raw) => {
    const r = (raw ?? {}) as {
      success?: unknown;
      new?: { id?: unknown } | null;
      modified?: { id?: unknown } | null;
      id?: unknown;
      errors?: { message?: unknown }[];
    };
    const id = [r.new?.id, r.modified?.id, r.id].find((x) => typeof x === "number" && Number.isInteger(x)) as
      | number
      | undefined;
    const why = (Array.isArray(r.errors) ? r.errors : [])
      .map((e) => (typeof e?.message === "string" ? e.message : ""))
      .filter(Boolean)
      .join("; ")
      .slice(0, 200);
    return { ok: r.success === true, id: id ?? null, why };
  });
}

async function postBookings(ctx: RunContext, body: Record<string, unknown>[]): Promise<PostResult[]> {
  const a = await api(ctx, "POST", urlOf("/bookings"), body, { write: true });
  const results = postResults(a.json);
  if (results.length !== body.length) {
    // An answer that cannot be read may hide a write that landed: looked for by its key.
    throw new ConnectorError("bad_response", "Beds24 answered the booking in a way that could not be read.");
  }
  return results;
}

/**
 * Puts back what part of a write did: bookings as they were, or the ones just made, cancelled. When
 * Beds24 does not take all of it, or its answer cannot be read, nothing is said to be refused: the
 * write may still stand there (`bad_response`), and the owner is given the bookings to look at.
 */
async function undo(ctx: RunContext, body: Record<string, unknown>[]): Promise<void> {
  if (body.length === 0) return;
  let done = false;
  try {
    done = (await postBookings(ctx, body)).every((r) => r.ok);
  } catch {
    done = false;
  }
  if (!done) {
    const ids = body.map((b) => b.id).filter((x) => typeof x === "number");
    throw new ConnectorError(
      "bad_response",
      `Beds24 took part of this and did not take all of it back: check booking${ids.length === 1 ? "" : "s"} ${ids.join(", ")} there.`,
    );
  }
}

/** Whether an error says for certain that nothing it was asked to do was done. */
function surelyNotDone(error: unknown): boolean {
  return (
    error instanceof ConnectorError &&
    (error.code === "rate_limited" ||
      error.code === "auth" ||
      error.code === "refused" ||
      error.code === "config" ||
      error.code === "not_found")
  );
}

/** Units the calendar says are free on each night of each room, below which the write is refused. */
async function checkFree(
  ctx: RunContext,
  need: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ours: (roomId: string, night: string) => number,
): Promise<void> {
  if (need.size === 0) return;
  const roomIds = [...need.keys()].map((r) => idOrRefuse(r, "room"));
  const all = [...need.values()].flatMap((m) => [...m.keys()]).sort();
  const from = all[0];
  const last = all[all.length - 1];
  if (!from || !last) return;
  const { nights } = await readCalendar(ctx, { roomIds }, from, addDays(last, 1));
  for (const [roomId, perNight] of need) {
    for (const [night, units] of perNight) {
      const n = nights.find((x) => x.roomId === roomId && x.night === night);
      // A room Beds24 says nothing of (one with no price there) is never written to blind.
      if (typeof n?.entry.numAvail !== "number") {
        throw new ConnectorError(
          "refused",
          "Beds24 says nothing of that room on those nights: give it a price in Beds24.",
        );
      }
      const free = n.entry.override === "blackout" ? 0 : n.entry.numAvail;
      if (free + ours(roomId, night) < units) throw new ConnectorError("refused", NOT_FREE);
    }
  }
}

/** Rooms by night: how many of each room a stay takes on each of its nights. */
function needOf(stay: OutboundStay): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of stay.rooms) {
    const m = out.get(r.roomId) ?? new Map<string, number>();
    for (const night of nightsOf(stay.checkIn, stay.checkOut)) m.set(night, (m.get(night) ?? 0) + 1);
    out.set(r.roomId, m);
  }
  return out;
}

function checkStay(stay: OutboundStay): void {
  if (!DATE.test(stay.checkIn) || !DATE.test(stay.checkOut) || stay.checkOut <= stay.checkIn) {
    throw new ConnectorError("config", "That stay has no nights.");
  }
  if (stay.rooms.length === 0 || stay.rooms.length > MAX_ROOMS) {
    throw new ConnectorError("refused", `Beds24 is written up to ${MAX_ROOMS} rooms a stay.`);
  }
}

const byRoom = (a: B24Booking, b: B24Booking) =>
  roomIndex(a.apiReference ?? "") - roomIndex(b.apiReference ?? "") || a.id - b.id;

/**
 * The bookings a link names: the stay's own rooms in their order. Found by our key, the stay's rooms
 * are every booking under it (`key`, `key~2`…), whichever Beds24 still groups and even with the first
 * one gone; a booking the inbox did not write is its own group's, as Beds24 joins them.
 */
async function members(ctx: RunContext, externalId: string): Promise<B24Booking[]> {
  const id = intId(externalId);
  if (id === null) return [];
  const [first] = (
    await readBookings(ctx, {
      id: [id],
      status: ALL_STATUSES,
      arrivalFrom: SINCE,
      includeBookingGroup: true,
      includeInfoItems: true,
    })
  ).filter((b) => b.id === id);
  if (!first) return [];
  const base = baseKey(first.apiReference ?? "");
  if (base) {
    const ours = (
      await readBookings(ctx, {
        apiReference: roomKeys(base),
        status: ALL_STATUSES,
        arrivalFrom: SINCE,
        includeInfoItems: true,
      })
    ).filter((b) => baseKey(b.apiReference ?? "") === base);
    if (!ours.some((b) => b.id === id)) ours.push(first);
    return ours.sort(byRoom);
  }
  const others = (first.bookingGroup?.ids ?? []).filter((x) => typeof x === "number" && x !== id);
  if (others.length === 0) return [first];
  const rest = (await readBookings(ctx, { id: others, status: ALL_STATUSES, arrivalFrom: SINCE })).sort(
    (a, b) => a.id - b.id,
  );
  return [first, ...rest];
}

/**
 * The bookings under a stay's key, its own first then its other rooms' (`~2`…), the live ones before
 * the cancelled: what `find` answers, so a stay whose first room is missing is still found.
 */
async function keyed(ctx: RunContext, key: string): Promise<B24Booking[]> {
  if (!key) return [];
  const found = await readBookings(ctx, {
    apiReference: roomKeys(key),
    status: ALL_STATUSES,
    arrivalFrom: SINCE,
  });
  return found
    .filter((b) => baseKey(b.apiReference ?? "") === key)
    .sort((a, b) => Number(a.status === "cancelled") - Number(b.status === "cancelled") || byRoom(a, b));
}

async function create(ctx: RunContext, stay: OutboundStay, status: StayWriteStatus): Promise<LinkState> {
  // Written once under our key, however often it is sent: the live booking under it is the answer.
  const already = (await keyed(ctx, stay.key)).find((b) => b.apiReference === stay.key && b.status !== "cancelled");
  if (already) return { externalId: String(already.id), etag: null, calendar: null };
  await checkFree(ctx, needOf(stay), () => 0);
  const group = stay.rooms.length > 1;
  const body = stay.rooms.map((_, i) => bookingBody(stay, i, status, { key: roomKey(stay.key, i), group }));
  const results = await postBookings(ctx, body);
  const made = results.filter((r) => r.ok && r.id !== null).map((r) => r.id as number);
  if (made.length !== results.length) {
    // Part of a group is no stay: what was made is taken back, by status; if that fails, it may stand.
    await undo(
      ctx,
      made.map((id) => ({ id, status: "cancelled" })),
    );
    if (results.some((r) => r.ok && r.id === null)) {
      throw new ConnectorError("bad_response", "Beds24 took the booking without saying its number.");
    }
    throw new ConnectorError("refused", results.find((r) => !r.ok)?.why || NOT_FREE);
  }
  return { externalId: String(made[0]), etag: null, calendar: null };
}

/**
 * Moves a stay it wrote to these dates and rooms. The rooms it adds are made first, each refused by
 * Beds24 itself when its room is gone, so nothing the stay holds has moved yet; then the rooms it keeps
 * are moved and the ones it drops cancelled, in one write. If Beds24 refuses any of that, every part
 * that went through is put back as it was read a moment ago, and the rooms just made are cancelled;
 * what cannot be put back is never called refused. With `restore`, the stay goes back to what it held
 * a moment ago: those nights are its own, and not checked again.
 */
async function move(
  ctx: RunContext,
  stay: OutboundStay,
  link: LinkState,
  status: StayWriteStatus,
  opts: { readonly restore?: boolean } = {},
): Promise<LinkState> {
  const current = await members(ctx, link.externalId ?? "");
  if (current.length === 0) throw new ConnectorError("refused", MISSING);
  const live = current.filter((b) => b.status !== "cancelled");
  if (live.length === 0) throw new ConnectorError("refused", "That booking is cancelled in Beds24.");
  if (!opts.restore) {
    // The nights this stay holds already count as its own: only what it adds must be free.
    const ours = (roomId: string, night: string) =>
      live.filter(
        (b) =>
          String(b.roomId) === roomId &&
          typeof b.arrival === "string" &&
          typeof b.departure === "string" &&
          night >= b.arrival &&
          night < b.departure,
      ).length;
    await checkFree(ctx, needOf(stay), ours);
  }
  const base = baseKey(current[0]?.apiReference ?? "");
  const masterId = live[0]?.id;
  // 1. The rooms it adds, made first.
  const adding = stay.rooms.map((_, i) => i).filter((i) => !live[i]);
  const made: number[] = [];
  if (adding.length) {
    const results = await postBookings(
      ctx,
      adding.map((i) =>
        bookingBody(stay, i, status, {
          ...(base ? { key: roomKey(base, i) } : {}),
          ...(masterId !== undefined ? { masterId } : {}),
        }),
      ),
    );
    for (const r of results) if (r.ok && r.id !== null) made.push(r.id);
    if (made.length !== results.length) {
      await undo(
        ctx,
        made.map((id) => ({ id, status: "cancelled" })),
      );
      if (results.some((r) => r.ok && r.id === null)) {
        throw new ConnectorError("bad_response", "Beds24 took the booking without saying its number.");
      }
      throw new ConnectorError("refused", results.find((r) => !r.ok)?.why || NOT_FREE);
    }
  }
  // 2. The rooms it keeps, moved, and the ones it drops, cancelled: only once every new room is made.
  const changes = [
    ...live.slice(0, stay.rooms.length).map((m, i) => ({
      before: m,
      body: bookingBody(stay, i, status, {
        id: m.id,
        clearFlag: m.flagText === BEDS24_WAITING_FLAG,
        info: infoOf(m),
      }),
    })),
    ...live.slice(stay.rooms.length).map((m) => ({ before: m, body: { id: m.id, status: "cancelled" } })),
  ];
  let results: PostResult[];
  try {
    results = await postBookings(
      ctx,
      changes.map((c) => c.body),
    );
  } catch (error) {
    // Asked of nothing: the rooms just made are taken back. No answer: it may have landed, and stands.
    if (surelyNotDone(error)) {
      await undo(
        ctx,
        made.map((id) => ({ id, status: "cancelled" })),
      );
    }
    throw error;
  }
  const failed = results.find((r) => !r.ok);
  if (failed) {
    await undo(ctx, [
      ...changes.filter((_, j) => results[j]?.ok).map((c) => asItWas(c.before)),
      ...made.map((id) => ({ id, status: "cancelled" })),
    ]);
    throw new ConnectorError("refused", failed.why || NOT_FREE);
  }
  return link;
}

/**
 * Whether the stay written (`link`) reads back as written and leaves no night oversold, by Beds24's own
 * count: its calendar's `numAvail` below zero (the OpenAPI file: "may be negative … if a room is
 * overbooked"), or more bookings that take the room on a night than it has units. Throws when it
 * cannot tell, or when the booking is not as it was written: nothing is then promised. The guest's
 * name is not part of it: a name Beds24 trimmed or escaped sells no room twice.
 */
async function oversold(ctx: RunContext, stay: OutboundStay, link: LinkState): Promise<boolean> {
  const current = (await members(ctx, link.externalId ?? "")).filter((b) => b.status !== "cancelled");
  if (current.length !== stay.rooms.length) throw new Error("the booking does not read back as written");
  const currency = stay.rooms[0]?.price.currency ?? "";
  current.forEach((b, i) => {
    const r = stay.rooms[i];
    const written =
      r &&
      String(b.roomId) === r.roomId &&
      b.arrival === stay.checkIn &&
      b.departure === stay.checkOut &&
      fromBeds24Amount(b.price, currency) === r.price.value;
    if (!written) throw new Error("the booking does not read back as written");
  });
  // A stay made under this key must be found again by it: else a write that timed out could be made twice.
  if (!MODIFY_KEY.test(stay.key) && current[0]?.apiReference !== stay.key) {
    throw new Error("the booking does not carry the key it was written with");
  }
  const roomIds = [...new Set(stay.rooms.map((r) => r.roomId))];
  const nights = nightsOf(stay.checkIn, stay.checkOut);
  const { nights: cal } = await readCalendar(
    ctx,
    { roomIds: roomIds.map((r) => idOrRefuse(r, "room")) },
    stay.checkIn,
    stay.checkOut,
  );
  for (const roomId of roomIds) {
    for (const night of nights) {
      const n = cal.find((x) => x.roomId === roomId && x.night === night);
      if (typeof n?.entry.numAvail !== "number") throw new Error("Beds24's calendar does not say");
      if (n.entry.numAvail < 0) return true;
    }
  }
  // Its count of bookings against its rooms: every booking that takes the room on one of these nights.
  const propertyId = current[0]?.propertyId;
  if (typeof propertyId !== "number") throw new Error("the booking names no property");
  const prop = await readProperty(ctx, String(propertyId));
  // Bounds wide by a day each way, which holds whether Beds24 counts "before" and "after" with the day
  // itself or without: the nights are matched exactly below.
  const overlapping = await readBookings(ctx, {
    roomId: roomIds.map((r) => idOrRefuse(r, "room")),
    arrivalTo: stay.checkOut,
    departureFrom: stay.checkIn,
    status: [...BLOCKING],
  });
  for (const roomId of roomIds) {
    const units = prop.roomTypes?.find((r) => String(r.id) === roomId)?.qty;
    if (typeof units !== "number") throw new Error("Beds24 does not say how many units the room has");
    for (const night of nights) {
      const taken = overlapping
        .filter(
          (b) =>
            String(b.roomId) === roomId &&
            BLOCKING.has(b.status ?? "") &&
            typeof b.arrival === "string" &&
            typeof b.departure === "string" &&
            night >= b.arrival &&
            night < b.departure,
        )
        .reduce((a, b) => a + Math.max(1, b.roomQty ?? 1), 0);
      if (taken > units) return true;
    }
  }
  return false;
}

/**
 * Cancels the stay's bookings by status, never deleting: Beds24 keeps them, as cancelled. Done when
 * they are cancelled already; refused, for the owner to look, when Beds24 does not have them at all.
 */
async function cancel(ctx: RunContext, link: LinkState): Promise<void> {
  let current: B24Booking[];
  try {
    current = await members(ctx, link.externalId ?? "");
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "not_found") throw new ConnectorError("refused", MISSING);
    throw error;
  }
  if (current.length === 0) throw new ConnectorError("refused", MISSING);
  const live = current.filter((b) => b.status !== "cancelled");
  if (live.length === 0) return;
  const results = await postBookings(
    ctx,
    live.map((b) => ({ id: b.id, status: "cancelled" })),
  );
  const failed = results.find((r) => !r.ok);
  if (failed) throw new ConnectorError("refused", failed.why || "Beds24 did not take the cancellation.");
}

/* --- Beds24's word that a booking changed ---------------------------------------------- */

/**
 * A booking webhook (Settings → Properties → Access → Booking webhook), at the connection's own
 * address. Beds24 documents no signature: the address's token is the credential, checked by the
 * inbox before this is asked. The body is only read for what to look at again — the booking's id, and
 * its room and dates as nights to read again — and is refused when it is not a Beds24 booking webhook
 * for a property this connection sees.
 */
/** Whether a body carries anything of a card, whatever Beds24 calls it: never taken, never kept. */
function carriesCard(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/card|cvc|cvv|token/i.test(k)) return true;
    if (carriesCard(v, depth + 1)) return true;
  }
  return false;
}

async function verify(ctx: RunContext, request: { readonly body: string }): Promise<HookEvent | null> {
  const parsed = parseJson(request.body);
  // Beds24 can add a card's CVC or token to its webhook (its "additional data"): such a body is refused
  // whole, before anything of it is kept. The owner chooses additional data "none".
  if (carriesCard(parsed)) {
    throw new ConnectorError(
      "refused",
      "That webhook carries card details: in Beds24, choose additional data none for it.",
    );
  }
  const body = parsed as {
    timeStamp?: unknown;
    booking?: { id?: unknown; propertyId?: unknown; roomId?: unknown; arrival?: unknown; departure?: unknown };
  } | null;
  const b = body?.booking;
  const id = b?.id;
  if (!body || typeof body !== "object" || typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new ConnectorError("refused", "That is not a Beds24 booking webhook.");
  }
  const seen = Array.isArray(ctx.extra.property_ids) ? (ctx.extra.property_ids as unknown[]).map(String) : null;
  if (b?.propertyId !== undefined && seen && !seen.includes(String(b.propertyId))) {
    throw new ConnectorError("refused", "That webhook is for a property this connection does not see.");
  }
  const stamp = typeof body.timeStamp === "string" ? body.timeStamp.replace(/[^0-9A-Za-z:.+-]/g, "").slice(0, 40) : "";
  const refs = [`booking:${id}`];
  if (
    typeof b?.roomId === "number" &&
    typeof b.arrival === "string" &&
    typeof b.departure === "string" &&
    DATE.test(b.arrival) &&
    DATE.test(b.departure) &&
    b.departure > b.arrival
  ) {
    refs.push(`nights:${b.roomId}:${b.arrival}:${b.departure}`);
  }
  return { eventId: `booking:${id}:${stamp || "-"}`, topic: "booking", refs };
}

/**
 * What a webhook names, as nights to read again. Where its body named the room and dates, those are
 * the nights, and Beds24 is not asked anything (each booking read costs credits, and a burst of
 * webhooks would spend the ones kept for guests booking). Only a webhook that named no nights has its
 * booking read back with the account's token, for the nights Beds24 holds it on.
 */
async function read(ctx: RunContext, event: HookEvent): Promise<readonly HookFact[]> {
  const facts = new Map<string, HookFact>();
  const add = (roomId: string, from: string, to: string) => {
    if (DATE.test(from) && DATE.test(to) && to > from) {
      facts.set(`${roomId}|${from}|${to}`, { kind: "stay_nights", roomIds: [roomId], from, to });
    }
  };
  const named = event.refs.some((r) => r.startsWith("nights:"));
  for (const ref of event.refs) {
    const m = /^booking:(\d{1,12})$/.exec(ref);
    if (m?.[1]) {
      if (named) continue;
      for (const b of await members(ctx, m[1])) {
        if (typeof b.roomId === "number" && typeof b.arrival === "string" && typeof b.departure === "string") {
          add(String(b.roomId), b.arrival, b.departure);
        }
      }
      continue;
    }
    // The nights the body named: only ever read again, never believed.
    const n = /^nights:(\d{1,12}):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(ref);
    if (n?.[1] && n[2] && n[3]) add(n[1], n[2], n[3]);
  }
  return [...facts.values()];
}

/* --- keeping the connection alive ------------------------------------------------------- */

/**
 * Called every few hours: the refresh token is used at least weekly, so a quiet property never reaches
 * Beds24's 30 days unused; the properties are read again for their names and currencies.
 */
async function refresh(ctx: RunContext) {
  const used = Number(ctx.secret.refresh_used_at ?? 0);
  if (!Number.isFinite(used) || ctx.now - used >= BEDS24_REFRESH_EVERY_MS) await mintToken(ctx);
  const props = await readProperties(ctx);
  const ownerId = typeof ctx.extra.owner_id === "string" ? ctx.extra.owner_id : "";
  return { account: accountOf(props), calendars: [], destinations: [], extra: extraOf(ownerId, props) };
}

async function disconnect(ctx: RunContext): Promise<void> {
  await forget(ctx, ctx.secret.refresh_token ?? "");
}

export function beds24Connector(): ConnectorDefinition {
  return {
    kind: "beds24",
    title: "Beds24",
    group: "lodging",
    capabilities: ["stay_inventory", "write_stays", "stay_events"],
    auth: "form",
    form: beds24Form,
    action: "Connect",
    ready: () => true,
    connect,
    refresh,
    disconnect,
    stays: {
      properties,
      rooms,
      ratePlans,
      ari,
      price,
      credits(res) {
        const b = beds24Budget(res.headers);
        return b ? { remaining: b.remaining, resetsInMs: b.resetsInMs } : null;
      },
    },
    stayWriter: {
      writeGuard: "check_then_write",
      hold: "none",
      async put(ctx, stay, link, status) {
        if (status === "hold") {
          throw new ConnectorError(
            "refused",
            "Beds24 has no hold known to keep a room off sale: nothing is held there.",
          );
        }
        checkStay(stay);
        return link?.externalId ? move(ctx, stay, link, status) : create(ctx, stay, status);
      },
      cancel,
      async find(ctx, stay) {
        // The stay's own booking, or one of its other rooms' where the first is missing.
        const [b] = await keyed(ctx, stay.key);
        return b ? { externalId: String(b.id), etag: null, calendar: null } : null;
      },
      oversold,
      async restore(ctx, stay, link) {
        checkStay(stay);
        return move(ctx, stay, link, "confirmed", { restore: true });
      },
    },
    hooks: { topics: ["booking"], verify, read },
  };
}
