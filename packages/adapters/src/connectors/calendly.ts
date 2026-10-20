import {
  type CalendarChoice,
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  type HookEvent,
  type Interval,
  type LinkState,
  mergeIntervals,
  type OutboundBooking,
  type RunContext,
  secretField,
  subtractIntervals,
} from "@surfingdog/core";
import { z } from "zod";
import { verifyHexHmac } from "./hook-sign";
import { retryAfterMs } from "./http";

/**
 * Calendly (ADR-030), with the owner's personal access token over Calendly's API v2: the business's own
 * account, its own token, nothing of ours in between.
 *
 * - **Busy times in.** `GET /user_busy_times`: the Calendly events and the events of every calendar
 *   Calendly checks for conflicts, at most seven days a call, so the 92 days ahead are read a week at a
 *   time. Calendly events this inbox made are left out by the ids it keeps for them; their copies in a
 *   connected calendar (which have no id here) by their times.
 * - **Bookings out**, through the Scheduling API (`POST /invitees`), which Calendly opens to its paid
 *   plans only (Standard and above; the Free plan is answered 403): each booking the inbox confirms is
 *   made on a one-on-one event type of the same length. Calendly emails whoever is named as the invitee,
 *   so the invitee is the business itself (the account's own address) under the customer's name: the
 *   slot is held and the customer, whom the inbox has told already, hears nothing from Calendly. A move
 *   is a new event, then the old one cancelled: Calendly has no reschedule in its API. A cancel is
 *   Calendly's cancellation.
 * - **Webhooks are a nudge.** `invitee.created` and `invitee.canceled` at the connection's own address,
 *   signed with a key the inbox makes for it (`Calendly-Webhook-Signature`: HMAC-SHA-256 over
 *   `t.body`, three minutes either way), read busy times again at once. Calendly sends webhooks on paid
 *   plans only; on Free, and before a hosted inbox is live, the five-minute sync is all there is.
 *
 * Calendly cannot rename an invitee: after a customer is erased their name stays on Calendly events
 * already made. A booking made on Calendly blocks its time here; it does not become an inbox booking.
 *
 * Docs, read 20 October 2026:
 * - API reference (OpenAPI): https://developer.calendly.com/openapi/calendly-api.yaml
 * - Personal access tokens and scopes:
 *   https://developer.calendly.com/docs/authentication/how-to-authenticate-with-personal-access-tokens,
 *   https://developer.calendly.com/docs/authentication/scopes
 * - Scheduling API: https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee
 *   and https://developer.calendly.com/schedule-events-with-ai-agents
 * - Busy times: https://developer.calendly.com/api-docs/calendly-api/availability/list-user-busy-times
 * - Webhooks: https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures,
 *   https://developer.calendly.com/docs/getting-started/frequently-asked-questions (paid plans)
 * - Rate limits: https://developer.calendly.com/api-docs/overview/rate-limits
 */

export const CALENDLY_API = "https://api.calendly.com";
/** The destination that picks the event type as long as each booking. */
export const CALENDLY_AUTO = "auto";
/** What the token is made with: reads, booking (`:write` includes `:read`), and its own webhook. */
export const CALENDLY_SCOPES = [
  "users:read",
  "event_types:read",
  "availability:read",
  "scheduled_events:write",
  "webhooks:write",
] as const;
export const CALENDLY_EVENTS = ["invitee.created", "invitee.canceled"] as const;
/** How far a webhook's `t=` may be from now, either way (Calendly's own example uses three minutes). */
export const CALENDLY_TOLERANCE_S = 180;

const WEEK_MS = 7 * 86_400_000;
/** Busy-time calls in one sync: fourteen weeks, past the 92 days the inbox offers. */
const MAX_WEEKS = 14;
/** Event types read: pages of a hundred. */
const MAX_TYPE_PAGES = 5;
const TOKENS = "https://calendly.com/integrations/api_webhooks";

export const calendlyForm = z.object({
  token: secretField(
    z.string().trim().min(20, "a Calendly token is longer").max(4000).regex(/^\S+$/, "a Calendly token has no spaces"),
    {
      label: "Personal access token",
      help: "Calendly shows it once, when it is made: copy it then.",
      link: { href: TOKENS, text: "Make one: Integrations & apps → API & webhooks" },
      placeholder: "eyJraWQiOi…",
      steps: [
        "In Calendly: Integrations & apps → API & webhooks → Generate new token.",
        `Name it after this inbox, and tick ${CALENDLY_SCOPES.join(", ")}.`,
        "Create it, then copy the token.",
      ],
    },
  ),
});

/* --- talking to Calendly ----------------------------------------------------------------------------- */

interface Ctx {
  readonly http: ConnectContext["http"];
}

async function call(
  ctx: Ctx,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ res: ConnectorHttpResponse; json: unknown }> {
  const res = await ctx.http.request({
    method,
    // Paths only, never an address an answer named: the token goes to api.calendly.com and nowhere else.
    url: `${CALENDLY_API}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: unknown = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  if (res.status === 401) {
    throw new ConnectorError("auth", "Calendly did not take that token. Make a new one and press Connect again.", {
      field: "token",
    });
  }
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? "");
    throw new ConnectorError("rate_limited", "Calendly asked this inbox to slow down.", {
      retryAfterMs:
        retryAfterMs(res.headers) ?? (Number.isFinite(reset) && reset > 0 ? Math.min(reset, 3_600) * 1000 : undefined),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Calendly is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  return { res, json };
}

function resourceOf(json: unknown): Record<string, unknown> | null {
  const r = json && typeof json === "object" ? (json as { resource?: unknown }).resource : undefined;
  return r && typeof r === "object" ? (r as Record<string, unknown>) : null;
}

function collectionOf(json: unknown): Record<string, unknown>[] {
  const c = json && typeof json === "object" ? (json as { collection?: unknown }).collection : undefined;
  return Array.isArray(c) ? c.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];
}

function nextToken(json: unknown): string | null {
  const p =
    json && typeof json === "object" ? (json as { pagination?: { next_page_token?: unknown } }).pagination : null;
  return typeof p?.next_page_token === "string" && p.next_page_token ? p.next_page_token : null;
}

/** Calendly's own words for what it refused: its message, and the first detail it gives. */
function messageOf(json: unknown): string {
  const j = (json ?? {}) as { message?: unknown; title?: unknown; details?: { message?: unknown }[] };
  const detail = Array.isArray(j.details) ? j.details.find((d) => typeof d?.message === "string")?.message : undefined;
  const m = [j.message, detail].filter((x): x is string => typeof x === "string" && x.length > 0);
  return m.join(" ").slice(0, 200);
}

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/** The id at the end of a Calendly address (`https://api.calendly.com/event_types/ABC`), of the kind named. */
function idOf(uri: unknown, kind: string): string | null {
  if (typeof uri !== "string") return null;
  const prefix = `${CALENDLY_API}/${kind}/`;
  if (!uri.startsWith(prefix)) return null;
  const id = uri.slice(prefix.length);
  return UUID.test(id) ? id : null;
}

/* --- the account ------------------------------------------------------------------------------------- */

interface Me {
  readonly userUri: string;
  readonly userId: string;
  readonly orgUri: string | null;
  readonly name: string | null;
  readonly email: string;
  readonly schedulingUrl: string | null;
}

async function me(ctx: Ctx, token: string): Promise<Me> {
  const { res, json } = await call(ctx, token, "GET", "/users/me");
  if (res.status === 403) {
    throw new ConnectorError("config", `This token cannot read the account. Make one with ${CALENDLY_SCOPES[0]}.`, {
      field: "token",
    });
  }
  const r = resourceOf(json);
  const userId = idOf(r?.uri, "users");
  if (res.status !== 200 || !r || !userId || typeof r.email !== "string") {
    throw new ConnectorError("bad_response", "Calendly did not say whose token this is.");
  }
  const orgId = idOf(r.current_organization, "organizations");
  return {
    userUri: `${CALENDLY_API}/users/${userId}`,
    userId,
    orgUri: orgId ? `${CALENDLY_API}/organizations/${orgId}` : null,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : null,
    email: r.email,
    schedulingUrl:
      typeof r.scheduling_url === "string" && r.scheduling_url.startsWith("https://") ? r.scheduling_url : null,
  };
}

function accountOf(who: Pick<Me, "name" | "email">): string {
  return (who.name ? `${who.name} (${who.email})` : who.email).slice(0, 200);
}

/** A location Calendly lets the business fix: what the booking is made with, or null for none needed. */
type Location = { readonly kind: string; readonly location?: string } | null;

/** Kinds where Calendly asks the invitee something the inbox does not hold (their phone, their place). */
const INVITEE_LOCATIONS = new Set(["ask_invitee", "outbound_call"]);

/**
 * Whether bookings can be made on an event type from here, and with what location: one-on-one, booked
 * at once (not a poll), the owner's own, with no required question the inbox cannot answer, and a
 * place the business sets. A group event type is left out: its event is shared with others who booked
 * it, and cancelling it would cancel them too.
 */
function usable(t: Record<string, unknown>, userUri: string): { readonly ok: boolean; readonly location: Location } {
  const no = { ok: false, location: null } as const;
  if (t.active === false || t.deleted_at) return no;
  if (t.type !== undefined && t.type !== "StandardEventType") return no;
  if (t.kind !== undefined && t.kind !== "solo") return no;
  if (t.booking_method === "poll") return no;
  const profile = t.profile as { owner?: unknown; type?: unknown } | null | undefined;
  if (profile && typeof profile.owner === "string" && profile.owner !== userUri) return no;
  const questions = Array.isArray(t.custom_questions) ? (t.custom_questions as Record<string, unknown>[]) : [];
  if (questions.some((q) => q?.enabled === true && q?.required === true)) return no;
  const locations = Array.isArray(t.locations) ? (t.locations as Record<string, unknown>[]) : [];
  if (locations.length === 0) return { ok: true, location: null };
  const fixed = locations.find((l) => typeof l?.kind === "string" && !INVITEE_LOCATIONS.has(String(l.kind)));
  if (!fixed) return no;
  const kind = String(fixed.kind);
  // A round robin takes no location from the booking (Calendly's own note on InviteeLocation).
  if (t.pooling_type === "round_robin") return { ok: true, location: null };
  if ((kind === "physical" || kind === "custom") && typeof fixed.location === "string") {
    return { ok: true, location: { kind, location: fixed.location } };
  }
  if (kind === "physical" || kind === "custom") return no;
  return { ok: true, location: { kind } };
}

/** The owner's event types bookings can go to, as destinations, with "Same length as the booking" first. */
async function eventTypes(ctx: Ctx, token: string, who: Me): Promise<CalendarChoice[]> {
  const out: CalendarChoice[] = [{ id: CALENDLY_AUTO, name: "Same length as the booking", writable: true }];
  let page: string | null = null;
  for (let n = 0; n < MAX_TYPE_PAGES; n++) {
    const q = new URLSearchParams({ user: who.userUri, active: "true", count: "100", sort: "position:asc" });
    if (page) q.set("page_token", page);
    const { res, json } = await call(ctx, token, "GET", `/event_types?${q}`);
    if (res.status === 403) {
      throw new ConnectorError("config", "This token cannot read your event types. Make one with event_types:read.", {
        field: "token",
      });
    }
    if (res.status !== 200) throw new ConnectorError("bad_response", "Calendly did not list the event types.");
    for (const t of collectionOf(json)) {
      const id = idOf(t.uri, "event_types");
      const duration = Number(t.duration);
      if (!id || !Number.isFinite(duration) || duration <= 0 || !usable(t, who.userUri).ok) continue;
      out.push({
        id,
        name: `${String(t.name ?? "Event type")} · ${duration} min`.slice(0, 120),
        writable: true,
        // The Scheduling API takes no length: a booking is as long as the event type.
        lengths: [duration],
      });
    }
    page = nextToken(json);
    if (!page) break;
  }
  return out;
}

/* --- what the connection keeps ------------------------------------------------------------------------- */

function tokenOf(ctx: Pick<RunContext, "secret">): string {
  const token = ctx.secret.token ?? "";
  if (!token) throw new ConnectorError("auth", "The saved token is missing. Connect Calendly again.");
  return token;
}

function userOf(ctx: Pick<RunContext, "extra">): string {
  const u = ctx.extra.userUri;
  if (typeof u !== "string" || !idOf(u, "users")) {
    throw new ConnectorError("config", "This connection does not know its Calendly account. Connect Calendly again.");
  }
  return u;
}

/** The event type a booking is made on: the one chosen, else the first of the same length. */
function eventTypeFor(ctx: RunContext, booking: OutboundBooking): CalendarChoice {
  const types = ctx.destinations.filter((d) => d.id !== CALENDLY_AUTO);
  const chosen =
    ctx.destination && ctx.destination !== CALENDLY_AUTO ? types.find((t) => t.id === ctx.destination) : undefined;
  const pick = chosen ?? types.find((t) => t.lengths?.[0] === booking.durationMin);
  if (!pick) {
    throw new ConnectorError(
      "refused",
      `No Calendly event type is ${booking.durationMin} minutes long. Add a one-on-one event type that long in Calendly, or choose one here.`,
    );
  }
  if (pick.lengths?.[0] !== booking.durationMin) {
    throw new ConnectorError(
      "refused",
      `${pick.name} cannot take a ${booking.durationMin}-minute booking. Choose another event type here.`,
    );
  }
  return pick;
}

/** The mark an event this inbox made carries: of this account's marker and the booking, nobody else's. */
async function markOf(ctx: RunContext, itemId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ctx.marker}:calendly:${itemId}`)),
  );
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function utcIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function whenOf(ctx: RunContext, ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: ctx.inbox.timezone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return utcIso(ms);
  }
}

/* --- bookings out ------------------------------------------------------------------------------------- */

/** Calendly would not take the time itself (not the token, nor the plan): another time may do. */
class SlotRefused extends ConnectorError {
  constructor(message: string) {
    super("refused", message);
  }
}

/** Makes the booking on Calendly: its event, as the inbox keeps it. */
async function book(ctx: RunContext, token: string, typeId: string, booking: OutboundBooking): Promise<LinkState> {
  const email = typeof ctx.extra.email === "string" ? ctx.extra.email : "";
  if (!email) throw new ConnectorError("config", "This connection does not know its Calendly address. Connect again.");
  // The event type as it is now: its place may have changed since it was listed.
  const got = await call(ctx, token, "GET", `/event_types/${encodeURIComponent(typeId)}`);
  const type = resourceOf(got.json);
  if (got.res.status === 404 || (got.res.status === 200 && type?.active === false)) {
    throw new ConnectorError("refused", "That event type is gone from Calendly. Choose another one here.");
  }
  if (got.res.status !== 200 || !type)
    throw new ConnectorError("bad_response", "Calendly did not show the event type.");
  const fit = usable(type, userOf(ctx));
  if (!fit.ok) {
    throw new ConnectorError(
      "refused",
      `${String(type.name ?? "That event type")} cannot take bookings from here: it asks the customer something, or is shared. Choose another one here.`,
    );
  }
  const { res, json } = await call(ctx, token, "POST", "/invitees", {
    event_type: `${CALENDLY_API}/event_types/${typeId}`,
    start_time: utcIso(booking.start),
    // The business itself, under the customer's name: Calendly emails the invitee, and the inbox has
    // told the customer already.
    invitee: {
      name: (booking.customerName ?? booking.serviceName).slice(0, 100),
      email,
      timezone: ctx.inbox.timezone,
    },
    ...(fit.location ? { location: fit.location } : {}),
    // A mark only this inbox can make, by which it finds the event again after a run that stopped.
    tracking: { utm_source: "inbox", utm_content: await markOf(ctx, booking.itemId) },
  });
  if (res.status === 201 || res.status === 200) {
    const r = resourceOf(json);
    const eventId = idOf(r?.event, "scheduled_events");
    if (!eventId) throw new ConnectorError("bad_response", "Calendly did not say which event it made.");
    return { externalId: eventId, etag: null, calendar: typeId, start: booking.start, end: booking.end };
  }
  if (res.status === 403) {
    const page = typeof ctx.extra.schedulingUrl === "string" ? ctx.extra.schedulingUrl : null;
    throw new ConnectorError(
      "refused",
      `Calendly would not let this token book. Booking from other apps needs a paid Calendly plan (Standard or above) and a token with scheduled_events:write. Or switch off Add confirmed bookings here and keep Calendly's busy times${page ? `; customers can still book at ${page}` : ""}.`,
    );
  }
  if (res.status === 404) {
    throw new ConnectorError("refused", "That event type is gone from Calendly. Choose another one here.");
  }
  const why = messageOf(json);
  const text = `Calendly would not take ${whenOf(ctx, booking.start)}${why ? `: ${why}` : ""}. Check the hours of the event type in Calendly.`;
  // A refusal that names another field than the time (the name, the place) is not about the slot.
  const named = parametersOf(json);
  throw named.length > 0 && !named.includes("start_time") ? new ConnectorError("refused", text) : new SlotRefused(text);
}

/** The fields a Calendly refusal names (`details[].parameter`). */
function parametersOf(json: unknown): string[] {
  const details = (json as { details?: unknown } | null)?.details;
  return Array.isArray(details)
    ? details.map((d) => (d as { parameter?: unknown })?.parameter).filter((p): p is string => typeof p === "string")
    : [];
}

/** Cancels an event this inbox made. Done, not an error, when it is gone, cancelled, or over. */
async function cancel(ctx: RunContext, token: string, link: LinkState): Promise<void> {
  if (!link.externalId) return;
  const { res, json } = await call(
    ctx,
    token,
    "POST",
    `/scheduled_events/${encodeURIComponent(link.externalId)}/cancellation`,
    { reason: "Cancelled in the inbox" },
  );
  if (res.status === 201 || res.status === 200 || res.status === 404) return;
  const why = messageOf(json);
  // Cancelled already, or in the past: nothing is held any more.
  if ((res.status === 400 || res.status === 403) && /cancel/i.test(why)) return;
  if ((res.status === 400 || res.status === 403) && link.start !== undefined && link.start <= ctx.now) return;
  throw new ConnectorError("refused", `Calendly would not cancel it${why ? `: ${why}` : "."}`);
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/* --- busy times in ------------------------------------------------------------------------------------- */

async function busy(ctx: RunContext, window: Interval): Promise<Interval[] | { intervals: Interval[]; until: number }> {
  const token = tokenOf(ctx);
  const user = userOf(ctx);
  // Calendly takes no start in the past: from the next whole minute.
  const from = Math.max(window.start, Math.ceil((ctx.now + 60_000) / 60_000) * 60_000);
  const booked: Interval[] = [];
  const external: Interval[] = [];
  let at = from;
  for (let week = 0; week < MAX_WEEKS && at < window.end; week++) {
    const to = Math.min(at + WEEK_MS, window.end);
    const q = new URLSearchParams({ user, start_time: utcIso(at), end_time: utcIso(to) });
    const { res, json } = await call(ctx, token, "GET", `/user_busy_times?${q}`);
    if (res.status === 403) {
      throw new ConnectorError("config", "This token cannot read busy times. Make one with availability:read.", {
        field: "token",
      });
    }
    if (res.status === 424) {
      throw new ConnectorError(
        "unreachable",
        "Calendly could not read a calendar it checks for conflicts; this inbox tries again in a few minutes.",
      );
    }
    // Never "nothing busy" for an answer that was not read: the last busy times stay, and it says why.
    if (res.status !== 200) throw new ConnectorError("bad_response", "Calendly would not give the busy times.");
    for (const b of collectionOf(json)) {
      const type = String(b.type ?? "");
      const event = b.event as { uri?: unknown } | undefined;
      const id = idOf(event?.uri, "scheduled_events");
      // Only the events this inbox keeps ids for are its own.
      if (id && ctx.own.ids.has(id)) continue;
      const start = Date.parse(String(b.buffered_start_time ?? b.start_time));
      const end = Date.parse(String(b.buffered_end_time ?? b.end_time));
      (type === "external" ? external : booked).push({ start, end });
    }
    at = to;
  }
  // A calendar Calendly checks holds a copy of each booking it made, with no id here: taken out by its times.
  const intervals = mergeIntervals([...booked, ...subtractIntervals(external, ctx.own.spans)], window);
  return at >= window.end ? intervals : { intervals, until: at };
}

/* --- its webhook -------------------------------------------------------------------------------------- */

type Webhook =
  | { readonly state: "added"; readonly id: string; readonly signingKey: string }
  /** To add once the inbox can be reached (a hosted inbox before it is live), or after a refusal. */
  | { readonly state: "pending" }
  /** Calendly sends webhooks on paid plans only (or the token lacks webhooks:write): polling only. */
  | { readonly state: "plan" };

function signingKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Adds the connection's webhook in the account, with a signing key made for it. */
async function addWebhook(
  ctx: Ctx,
  token: string,
  who: { readonly userUri: string; readonly orgUri: string | null },
  url: string,
): Promise<Webhook> {
  if (!who.orgUri) return { state: "pending" };
  const key = signingKey();
  const body = {
    url,
    events: [...CALENDLY_EVENTS],
    organization: who.orgUri,
    user: who.userUri,
    scope: "user",
    signing_key: key,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { res, json } = await call(ctx, token, "POST", "/webhook_subscriptions", body);
    if (res.status === 201 || res.status === 200) {
      const id = idOf(resourceOf(json)?.uri, "webhook_subscriptions");
      return id ? { state: "added", id, signingKey: key } : { state: "pending" };
    }
    if (res.status === 403) return { state: "plan" };
    // One at this address already: this connection's own, from before. It goes, and is made again.
    if (res.status === 409 && attempt === 0) {
      await dropWebhooksAt(ctx, token, who, url);
      continue;
    }
    return { state: "pending" };
  }
  return { state: "pending" };
}

async function dropWebhooksAt(
  ctx: Ctx,
  token: string,
  who: { readonly userUri: string; readonly orgUri: string | null },
  url: string,
): Promise<void> {
  if (!who.orgUri) return;
  const q = new URLSearchParams({ organization: who.orgUri, user: who.userUri, scope: "user", count: "100" });
  const { res, json } = await call(ctx, token, "GET", `/webhook_subscriptions?${q}`);
  if (res.status !== 200) return;
  for (const w of collectionOf(json)) {
    const id = idOf(w.uri, "webhook_subscriptions");
    if (id && w.callback_url === url) await dropWebhook(ctx, token, id);
  }
}

async function dropWebhook(ctx: Ctx, token: string, id: string): Promise<void> {
  try {
    await call(ctx, token, "DELETE", `/webhook_subscriptions/${encodeURIComponent(id)}`);
  } catch (error) {
    // Best effort: a webhook left behind fails its signature here and is switched off by Calendly.
    if (!(error instanceof ConnectorError)) throw error;
  }
}

function webhookExtra(w: Webhook, url: string | null, now: number): Record<string, unknown> {
  return w.state === "added"
    ? { webhook: "added", webhook_id: w.id, hook_url: url, hook_tried_at: now }
    : { webhook: w.state, webhook_id: null, hook_url: null, hook_tried_at: now };
}

/** Parses `Calendly-Webhook-Signature: t=1492774577,v1=5257a8…` into its time and signatures. */
function signatureParts(header: string | null): { readonly t: string; readonly v1: readonly string[] } | null {
  if (!header) return null;
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1" && v) v1.push(v);
  }
  return /^\d{1,12}$/.test(t) && v1.length > 0 ? { t, v1 } : null;
}

const refused = () => new ConnectorError("refused", "The signature does not check out.");

async function verify(ctx: RunContext, request: { headers: Headers; body: string }): Promise<HookEvent | null> {
  const key = ctx.secret.signing_key ?? "";
  const parts = signatureParts(request.headers.get("calendly-webhook-signature"));
  if (!key || !parts) throw refused();
  // A delivery from more than three minutes away, either way, is a replay or a clock gone wrong.
  if (Math.abs(Math.floor(ctx.now / 1000) - Number(parts.t)) > CALENDLY_TOLERANCE_S) throw refused();
  let ok = false;
  for (const sig of parts.v1) {
    if (await verifyHexHmac(key, `${parts.t}.${request.body}`, sig)) ok = true;
  }
  if (!ok) throw refused();
  let parsed: { event?: unknown; payload?: { uri?: unknown; event?: unknown } } = {};
  try {
    parsed = JSON.parse(request.body) as typeof parsed;
  } catch {
    return null;
  }
  const topic = typeof parsed.event === "string" ? parsed.event : "";
  if (!(CALENDLY_EVENTS as readonly string[]).includes(topic)) return null;
  // The invitee's address: `…/scheduled_events/<event>/invitees/<invitee>`.
  const uri = typeof parsed.payload?.uri === "string" ? parsed.payload.uri : "";
  const m =
    /^https:\/\/api\.calendly\.com\/scheduled_events\/([A-Za-z0-9_-]{1,64})\/invitees\/([A-Za-z0-9_-]{1,64})$/.exec(
      uri,
    );
  if (!m?.[1] || !m[2]) return null;
  // An invitee is made once and cancelled at most once: the pair is the delivery, sent again or not.
  return { eventId: `${topic}:${m[2]}`, topic, refs: [m[1], m[2]] };
}

/* --- the connector ------------------------------------------------------------------------------------- */

export function calendlyConnector(): ConnectorDefinition {
  return {
    kind: "calendly",
    title: "Calendly",
    group: "calendars",
    capabilities: ["busy_times", "write_bookings"],
    auth: "form",
    form: calendlyForm,
    disconnectNote: "Revoke the token too, in Calendly → Integrations & apps → API & webhooks.",

    async connect(ctx, input) {
      const token = (input.token ?? "").trim();
      const who = await me(ctx, token);
      const destinations = await eventTypes(ctx, token, who);
      const hookUrl = ctx.hookUrl ?? null;
      const webhook: Webhook =
        hookUrl && ctx.hooksLive !== false ? await addWebhook(ctx, token, who, hookUrl) : { state: "pending" };
      const before = ctx.previous?.extra.webhook === "added" ? ctx.previous.extra.webhook_id : undefined;
      return {
        account: accountOf(who),
        externalId: who.userId,
        secret: { token, ...(webhook.state === "added" ? { signing_key: webhook.signingKey } : {}) },
        extra: {
          userUri: who.userUri,
          orgUri: who.orgUri,
          email: who.email,
          schedulingUrl: who.schedulingUrl,
          ...webhookExtra(webhook, hookUrl, ctx.now),
        },
        calendars: [],
        destinations,
        defaults: { busy: [], destination: CALENDLY_AUTO },
        async settle(kept) {
          try {
            if (!kept) {
              // Refused after all: what was just made goes, and what worked before stays.
              if (webhook.state === "added") await dropWebhook(ctx, token, webhook.id);
              return;
            }
            if (typeof before === "string" && (webhook.state !== "added" || before !== webhook.id)) {
              await dropWebhook(ctx, token, before);
            }
          } catch {
            // Best effort, never throws.
          }
        },
      };
    },

    /**
     * Every six hours, and sooner when the webhook is still to add or the inbox moved: the account and
     * its event types again, and the webhook kept pointing at this inbox. One Calendly switched off
     * (deliveries failed for a day) or that points elsewhere is made again with a new signing key; one
     * still to add is added once the inbox can be reached (and tried again on a plan that may have changed).
     */
    async refresh(ctx) {
      const token = tokenOf(ctx);
      const who = await me(ctx, token);
      const base = { account: accountOf(who), calendars: [], destinations: await eventTypes(ctx, token, who) };
      const extra = {
        ...ctx.extra,
        userUri: who.userUri,
        orgUri: who.orgUri,
        email: who.email,
        schedulingUrl: who.schedulingUrl,
      };
      const hookUrl = ctx.hookUrl ?? null;
      if (!hookUrl || ctx.hooksLive === false) return { ...base, extra };
      const id = typeof ctx.extra.webhook_id === "string" ? ctx.extra.webhook_id : null;
      if (ctx.extra.webhook === "added" && id) {
        const got = await call(ctx, token, "GET", `/webhook_subscriptions/${encodeURIComponent(id)}`);
        const w = resourceOf(got.json);
        const fine = got.res.status === 200 && w?.state !== "disabled" && w?.callback_url === hookUrl;
        if (fine || (got.res.status !== 200 && got.res.status !== 404)) return { ...base, extra };
        if (got.res.status === 200) await dropWebhook(ctx, token, id);
      }
      const made = await addWebhook(ctx, token, who, hookUrl);
      if (made.state === "added") await ctx.saveSecret({ ...ctx.secret, signing_key: made.signingKey });
      return { ...base, extra: { ...extra, ...webhookExtra(made, hookUrl, ctx.now) } };
    },

    /** Read again now: the inbox moved since its webhook was made, or can now be reached with one still to add. */
    stale(ctx) {
      if (!ctx.hookUrl || ctx.hooksLive === false) return false;
      if (ctx.extra.webhook === "added") return ctx.extra.hook_url !== ctx.hookUrl;
      // Still to add: at most every half hour, and a plan that sends none only on the six-hour read.
      const tried = typeof ctx.extra.hook_tried_at === "number" ? ctx.extra.hook_tried_at : 0;
      return ctx.extra.webhook !== "plan" && ctx.now - tried > 30 * 60_000;
    },

    busy,

    bookings: {
      async put(ctx, booking, link) {
        const token = tokenOf(ctx);
        const type = eventTypeFor(ctx, booking);
        const sameTimes = link?.start === booking.start && link?.end === booking.end;
        // Calendly cannot rename an invitee: the same times on the same event type are left as they are.
        if (link?.externalId && link.calendar === type.id && sameTimes) return link;
        let made: LinkState;
        try {
          made = await book(ctx, token, type.id, booking);
        } catch (error) {
          // Moved to a time the old event still holds: it goes first, then the new one is made.
          const old = link?.start !== undefined && link.end !== undefined ? { start: link.start, end: link.end } : null;
          if (!(error instanceof SlotRefused) || !link?.externalId || !old || !overlaps(old, booking)) throw error;
          await cancel(ctx, token, link);
          return book(ctx, token, type.id, booking);
        }
        if (link?.externalId && link.externalId !== made.externalId) await cancel(ctx, token, link);
        return made;
      },

      async remove(ctx, link) {
        await cancel(ctx, tokenOf(ctx), link);
      },

      /**
       * An event this inbox made and kept no id for: one at the booking's exact start, booked by the
       * business's own address, whose invitee carries the mark only this inbox can make.
       */
      async find(ctx, booking) {
        const token = tokenOf(ctx);
        const user = userOf(ctx);
        const mark = await markOf(ctx, booking.itemId);
        const q = new URLSearchParams({
          user,
          min_start_time: utcIso(booking.start),
          max_start_time: utcIso(booking.start + 1000),
          status: "active",
          count: "20",
          ...(typeof ctx.extra.email === "string" ? { invitee_email: ctx.extra.email } : {}),
        });
        const { res, json } = await call(ctx, token, "GET", `/scheduled_events?${q}`);
        if (res.status !== 200) return null;
        for (const e of collectionOf(json)) {
          const id = idOf(e.uri, "scheduled_events");
          if (!id || Date.parse(String(e.start_time)) !== booking.start) continue;
          const listed = await call(
            ctx,
            token,
            "GET",
            `/scheduled_events/${encodeURIComponent(id)}/invitees?${new URLSearchParams({ status: "active", count: "20" })}`,
          );
          if (listed.res.status !== 200) continue;
          const ours = collectionOf(listed.json).some(
            (i) => (i.tracking as { utm_content?: unknown } | null | undefined)?.utm_content === mark,
          );
          if (!ours) continue;
          return {
            externalId: id,
            etag: null,
            calendar: idOf(e.event_type, "event_types"),
            start: booking.start,
            end: Date.parse(String(e.end_time)) || booking.end,
          };
        }
        return null;
      },
    },

    hooks: {
      topics: [...CALENDLY_EVENTS],
      verify,
      /** A booking made or cancelled on Calendly: its busy times are read again now, with the business's token. */
      async read() {
        return [{ kind: "busy" }];
      },
    },

    async disconnect(ctx) {
      const id = ctx.extra.webhook_id;
      if (ctx.extra.webhook !== "added" || typeof id !== "string") return;
      await dropWebhook(ctx, tokenOf(ctx), id);
    },
  };
}
