import {
  type CalendarChoice,
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  type HookEvent,
  type Interval,
  type LinkState,
  mergeIntervals,
  type OAuthClient,
  type OutboundBooking,
  type RunContext,
  secretField,
  subtractIntervals,
} from "@surfingdog/core";
import { z } from "zod";
import { constantTimeEqual, hmacSha256Hex } from "./hook-sign";
import { basicAuth, retryAfterMs } from "./http";

/**
 * Calendly (ADR-033) over its API v2, in the business's own account: signed in with Calendly (OAuth, the
 * authorization code flow with PKCE, through the Calendly app of whoever runs the server), or with a
 * personal access token the owner makes and pastes. Nothing of ours in between either way.
 *
 * - **The plan is read when connecting** (`GET /organizations/{uuid}`, its `stage`): on Calendly's Free
 *   plan other apps may read but not book, so a Free account is connected with Add confirmed bookings off
 *   and says so on its line, before the owner relies on it.
 * - **Busy times in.** `GET /user_busy_times`: the Calendly events and the events of every calendar
 *   Calendly checks for conflicts, at most seven days a call, so the 92 days ahead are read a week at a
 *   time. Calendly events this inbox made are left out by the ids it keeps for them; their copies in a
 *   connected calendar (which have no id here) by their times.
 * - **Bookings out**, through the Scheduling API (`POST /invitees`), which Calendly opens to its paid
 *   plans only (Standard and above; the Free plan is answered 403): each booking the inbox confirms is
 *   made on a one-on-one event type of the same length. Calendly emails whoever is named as the invitee,
 *   so the invitee is the business itself (the account's own address) under the customer's name: the
 *   slot is held and the customer, whom the inbox has told already, hears nothing from Calendly. A move
 *   is a new event, then the old one cancelled: Calendly has no reschedule in its API. A move tried
 *   again first looks for the event it may have made already at the new time, by the mark only this
 *   inbox makes, so a run that stopped half-way never leaves two. A cancel is Calendly's cancellation.
 * - **Webhooks are a nudge.** `invitee.created` and `invitee.canceled` at the connection's own address,
 *   signed with a key the inbox makes for it (`Calendly-Webhook-Signature`: HMAC-SHA-256 over
 *   `t.body`, three minutes either way), read busy times again at once. Calendly sends webhooks on paid
 *   plans only; on Free, and before a hosted inbox is live, the five-minute sync is all there is.
 *
 * Calendly cannot rename an invitee: after a customer is erased their name stays on Calendly events
 * already made. A booking made on Calendly blocks its time here; it does not become an inbox booking.
 *
 * Docs, read 20 October 2026:
 * - API reference (OpenAPI): https://developer.calendly.com/openapi/calendly-api.yaml (the plan:
 *   `Organization.stage`, `OrganizationStage`; refusals: `InviteesErrorMessage`, `DeleteScheduledEventErrorMessage`)
 * - Signing in: https://developer.calendly.com/docs/authentication/creating-an-oauth-app,
 *   https://developer.calendly.com/api-docs/calendly-o-auth/o-auth/get-oauth-authorize,
 *   https://developer.calendly.com/api-docs/calendly-o-auth/o-auth/post-oauth-refresh-token (access for two
 *   hours; a refresh token is used once), https://developer.calendly.com/api-docs/calendly-o-auth/o-auth/post-oauth-revoke
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
/** Where an owner signs in with Calendly, and where its codes and refresh tokens become access tokens. */
export const CALENDLY_AUTH = "https://auth.calendly.com";
/** The destination that picks the event type as long as each booking. */
export const CALENDLY_AUTO = "auto";
/** What the token is made with: reads, the plan, booking (`:write` includes `:read`), and its own webhook. */
export const CALENDLY_SCOPES = [
  "users:read",
  "organizations:read",
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
/** How many `v1=` signatures of one delivery are checked: Calendly sends one; a header of thousands is refused. */
const MAX_SIGNATURES = 5;
const TOKENS = "https://calendly.com/integrations/api_webhooks";

/** What the connection's line says when it does less than its card. */
export const CALENDLY_FREE_NOTE = "Calendly Free: busy times only";
export const CALENDLY_NO_TYPES_NOTE =
  "None of your Calendly event types can take bookings from here (one-on-one, no required questions, a place you set). Busy times still work.";

export const calendlyForm = z.object({
  token: secretField(
    z.string().trim().min(20, "a Calendly token is longer").max(4000).regex(/^\S+$/, "a Calendly token has no spaces"),
    {
      label: "Personal access token",
      link: { href: TOKENS, text: "Open Calendly" },
      placeholder: "Paste the token",
      steps: [
        "In Calendly: Integrations & apps → API & webhooks → Generate new token.",
        `Name it Inbox. Under scopes, tick: ${CALENDLY_SCOPES.join(" · ")}`,
        "Create it and copy it: Calendly shows it once.",
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
  const m = [j.message, detail]
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().replace(/([^.!?])$/, "$1."));
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

/** Where the account is in Calendly's plans (`Organization.stage`): `free` books nothing from other apps. */
type Stage = "free" | "trial" | "paid" | null;

/**
 * The account's plan, read from its organization. Null when it cannot be read (a token made without
 * organizations:read): not known, so nothing is switched off for it.
 */
async function stageOf(ctx: Ctx, token: string, who: Pick<Me, "orgUri">): Promise<Stage> {
  const orgId = idOf(who.orgUri, "organizations");
  if (!orgId) return null;
  const { res, json } = await call(ctx, token, "GET", `/organizations/${encodeURIComponent(orgId)}`);
  if (res.status !== 200) return null;
  const stage = resourceOf(json)?.stage;
  return stage === "free" || stage === "trial" || stage === "paid" ? stage : null;
}

/** The line the connection says, when it does less than "Busy times in, bookings out". */
function noteOf(stage: Stage, destinations: readonly CalendarChoice[]): string | null {
  if (stage === "free") return CALENDLY_FREE_NOTE;
  if (!destinations.some((d) => d.id !== CALENDLY_AUTO)) return CALENDLY_NO_TYPES_NOTE;
  return null;
}

/* --- what the connection keeps ------------------------------------------------------------------------- */

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

/** Calendly's documented word for the Free plan (`InviteesErrorMessage`), as against a token without the scope. */
const PAID_ONLY = /paid Calendly plans?|upgrade your (plan|Calendly account)/i;

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
    // The plan, by Calendly's own words for it; anything else is the token's scopes.
    throw new ConnectorError(
      "refused",
      PAID_ONLY.test(messageOf(json))
        ? `Calendly's Free plan doesn't let other apps add bookings, so ${whenOf(ctx, booking.start)} is not blocked on Calendly. Block it there yourself, or switch off Add confirmed bookings.`
        : "Calendly did not let this connection add bookings: it needs scheduled_events:write. Make a token with it and connect again, or switch off Add confirmed bookings.",
    );
  }
  if (res.status === 404) {
    throw new ConnectorError("refused", "That event type is gone from Calendly. Choose another one here.");
  }
  const why = messageOf(json).replace(/[.\s]+$/, "");
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

/**
 * Cancels an event this inbox made. Done, not an error, when it is gone, cancelled already, or over
 * (`DeleteScheduledEventErrorMessage`: "Event is already canceled", "Event in the past"); any other
 * refusal ("You are not allowed to cancel this event") is said, since the event still holds its time.
 */
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
  const refusal = res.status === 400 || res.status === 403;
  if (refusal && /already\s+(been\s+)?cancel/i.test(why)) return;
  if (refusal && link.start !== undefined && link.start <= ctx.now) return;
  throw new ConnectorError("refused", `Calendly would not cancel it${why ? `: ${why}` : "."}`);
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/**
 * An event this inbox made for the booking at its start, found by the mark only it makes, leaving out
 * `except` (the event a move leaves behind). Asked a minute either side of the start, since Calendly
 * names its bounds "after" and "prior to"; only an event at the very start is taken.
 */
async function findMarked(
  ctx: RunContext,
  token: string,
  booking: OutboundBooking,
  except?: string | null | undefined,
): Promise<LinkState | null> {
  const user = userOf(ctx);
  const mark = await markOf(ctx, booking.itemId);
  const q = new URLSearchParams({
    user,
    min_start_time: utcIso(booking.start - 60_000),
    max_start_time: utcIso(booking.start + 60_000),
    status: "active",
    count: "20",
    ...(typeof ctx.extra.email === "string" ? { invitee_email: ctx.extra.email } : {}),
  });
  const { res, json } = await call(ctx, token, "GET", `/scheduled_events?${q}`);
  if (res.status !== 200) return null;
  for (const e of collectionOf(json)) {
    const id = idOf(e.uri, "scheduled_events");
    if (!id || id === except || Date.parse(String(e.start_time)) !== booking.start) continue;
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
}

async function put(
  ctx: RunContext,
  token: string,
  booking: OutboundBooking,
  link: LinkState | null,
): Promise<LinkState> {
  const type = eventTypeFor(ctx, booking);
  // Calendly cannot rename an invitee: the same times on the same event type are left as they are.
  if (link?.externalId && link.calendar === type.id && link.start === booking.start && link.end === booking.end) {
    return link;
  }
  let current = link;
  if (current?.externalId) {
    // A move tried before may have made its new event and stopped before the old one was cancelled, or
    // before its id was kept: that event, already at the new time, is the one to keep, never a second.
    const there = await findMarked(ctx, token, booking, current.externalId);
    if (there) {
      await cancel(ctx, token, current);
      if (there.calendar === type.id) return there;
      current = there;
    }
  }
  let made: LinkState;
  try {
    made = await book(ctx, token, type.id, booking);
  } catch (error) {
    // Moved to a time the old event still holds: it goes first, then the new one is made.
    const old =
      current?.start !== undefined && current.end !== undefined ? { start: current.start, end: current.end } : null;
    if (!(error instanceof SlotRefused) || !current?.externalId || !old || !overlaps(old, booking)) throw error;
    await cancel(ctx, token, current);
    return book(ctx, token, type.id, booking);
  }
  if (current?.externalId && current.externalId !== made.externalId) await cancel(ctx, token, current);
  return made;
}

/* --- busy times in ------------------------------------------------------------------------------------- */

async function busy(
  ctx: RunContext,
  token: string,
  window: Interval,
): Promise<Interval[] | { intervals: Interval[]; until: number }> {
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
      await dropWebhooksWhere(ctx, token, who, (callback) => callback === url);
      continue;
    }
    return { state: "pending" };
  }
  return { state: "pending" };
}

/** Removes the account's webhooks whose address `which` picks. */
async function dropWebhooksWhere(
  ctx: Ctx,
  token: string,
  who: { readonly userUri: string; readonly orgUri: string | null },
  which: (callback: string) => boolean,
): Promise<void> {
  if (!who.orgUri) return;
  const q = new URLSearchParams({ organization: who.orgUri, user: who.userUri, scope: "user", count: "100" });
  const { res, json } = await call(ctx, token, "GET", `/webhook_subscriptions?${q}`);
  if (res.status !== 200) return;
  for (const w of collectionOf(json)) {
    const id = idOf(w.uri, "webhook_subscriptions");
    if (id && typeof w.callback_url === "string" && which(w.callback_url)) await dropWebhook(ctx, token, id);
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

/**
 * Parses `Calendly-Webhook-Signature: t=1492774577,v1=5257a8…` into its time and signatures, a few at
 * most: each one is compared, and a header of thousands would make each delivery that many comparisons.
 */
function signatureParts(header: string | null): { readonly t: string; readonly v1: readonly string[] } | null {
  if (!header || header.length > 2048) return null;
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1" && v && v1.length < MAX_SIGNATURES) v1.push(v.toLowerCase());
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
  // One HMAC over `t.body`, compared with each signature in constant time.
  const expected = await hmacSha256Hex(key, `${parts.t}.${request.body}`);
  let ok = false;
  for (const sig of parts.v1) if (constantTimeEqual(expected, sig)) ok = true;
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

/* --- signing in with Calendly -------------------------------------------------------------------------- */

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function jsonOf(res: ConnectorHttpResponse): Record<string, unknown> {
  try {
    const v = JSON.parse(res.text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A connection's access: a personal access token as pasted, or a signed-in one that is refreshed. */
interface Access {
  /** A token for Calendly's API now, refreshed first when it is about to lapse. */
  bearer(ctx: RunContext): Promise<string>;
  /** The secret as it is now: a signed-in one's refresh token changes each time it is used. */
  current(ctx: Pick<RunContext, "secret">): Promise<Readonly<Record<string, string>>>;
  /** Gives a signed-in connection's access back to Calendly (best effort). */
  revoke(ctx: RunContext): Promise<void>;
  /** Turns a code from the way back into tokens. */
  exchange(
    ctx: ConnectContext,
    p: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
  ): Promise<{
    readonly token: string;
    readonly secret: Readonly<Record<string, string>>;
    readonly owner: string | null;
  }>;
}

function access(client: OAuthClient | null): Access {
  /**
   * Tokens refreshed in this process, by the refresh token they replaced: Calendly takes a refresh token
   * once, so a second call in the same run (or two at once) uses what the first got, never asks again.
   */
  const rotated = new Map<
    string,
    Promise<{ readonly access: string; readonly refresh: string; readonly expiresAt: number }>
  >();

  async function tokenRequest(ctx: ConnectContext, body: Record<string, string>): Promise<Record<string, unknown>> {
    if (!client?.clientId || !client.clientSecret) {
      throw new ConnectorError("config", "Calendly sign-in is not set up on this inbox. Connect with a token instead.");
    }
    const res = await ctx.http.request({
      method: "POST",
      url: `${CALENDLY_AUTH}/oauth/token`,
      headers: {
        // A web app: its id and secret as HTTP Basic, as Calendly asks of web clients.
        authorization: basicAuth(client.clientId, client.clientSecret),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: formBody(body),
    });
    const j = jsonOf(res);
    if (res.status === 400 && j.error === "invalid_grant") {
      throw new ConnectorError("auth", "Calendly stopped this connection. Connect it again.");
    }
    if (res.status === 401 || j.error === "invalid_client" || j.error === "unauthorized_client") {
      throw new ConnectorError("config", "Calendly did not recognise this inbox's sign-in app.");
    }
    if (res.status === 429 || j.error === "temporarily_unavailable") {
      throw new ConnectorError("rate_limited", "Calendly asked this inbox to slow down.", {
        retryAfterMs: retryAfterMs(res.headers) ?? 60_000,
      });
    }
    if (res.status >= 500) {
      throw new ConnectorError(
        "unreachable",
        "Calendly is not answering properly; this inbox tries again in a few minutes.",
      );
    }
    if (res.status !== 200) throw new ConnectorError("bad_response", "Calendly would not finish the sign-in.");
    return j;
  }

  function tokensOf(j: Record<string, unknown>, now: number) {
    const accessToken = typeof j.access_token === "string" ? j.access_token : "";
    const refresh = typeof j.refresh_token === "string" ? j.refresh_token : "";
    if (!accessToken || !refresh) throw new ConnectorError("bad_response", "Calendly did not give lasting access.");
    const seconds = Number(j.expires_in);
    return {
      access: accessToken,
      refresh,
      expiresAt: now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 7200) * 1000,
    };
  }

  async function current(ctx: Pick<RunContext, "secret">): Promise<Readonly<Record<string, string>>> {
    const refresh = ctx.secret.refresh_token;
    const next = refresh ? await rotated.get(refresh)?.catch(() => null) : null;
    return next
      ? {
          ...ctx.secret,
          access_token: next.access,
          refresh_token: next.refresh,
          access_expires_at: String(next.expiresAt),
        }
      : ctx.secret;
  }

  return {
    current,

    async bearer(ctx) {
      if (ctx.secret.token) return ctx.secret.token;
      const expires = Number(ctx.secret.access_expires_at ?? 0);
      if (ctx.secret.access_token && expires > ctx.now + 60_000) return ctx.secret.access_token;
      const refresh = ctx.secret.refresh_token;
      if (!refresh) throw new ConnectorError("auth", "Calendly's lasting access is missing. Connect it again.");
      let pending = rotated.get(refresh);
      if (!pending) {
        pending = tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: refresh }).then(async (j) => {
          const next = tokensOf(j, ctx.now);
          // Kept at once: the refresh token just used is spent, and only the new one works from now on.
          await ctx.saveSecret({
            ...ctx.secret,
            access_token: next.access,
            refresh_token: next.refresh,
            access_expires_at: String(next.expiresAt),
          });
          return next;
        });
        if (rotated.size >= 500) rotated.clear();
        rotated.set(refresh, pending);
        // A refusal is not kept: the next run asks again with what it has.
        pending.catch(() => rotated.delete(refresh));
      }
      const next = await pending;
      if (next.expiresAt <= ctx.now + 60_000) {
        rotated.delete(refresh);
        throw new ConnectorError("unreachable", "Calendly's access lapsed; this inbox tries again in a few minutes.");
      }
      return next.access;
    },

    async revoke(ctx) {
      if (ctx.secret.token || !client?.clientId || !client.clientSecret) return;
      const token = (await current(ctx)).refresh_token;
      if (!token) return;
      try {
        await ctx.http.request({
          method: "POST",
          url: `${CALENDLY_AUTH}/oauth/revoke`,
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: formBody({ client_id: client.clientId, client_secret: client.clientSecret, token }),
        });
      } catch (error) {
        // Best effort: the owner can remove the app in Calendly too.
        if (!(error instanceof ConnectorError)) throw error;
      }
    },

    async exchange(ctx, { code, verifier, redirectUri }) {
      const j = await tokenRequest(ctx, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const next = tokensOf(j, ctx.now);
      return {
        token: next.access,
        owner: typeof j.owner === "string" ? j.owner : null,
        secret: {
          access_token: next.access,
          refresh_token: next.refresh,
          access_expires_at: String(next.expiresAt),
        },
      };
    },
  };
}

/* --- the connector ------------------------------------------------------------------------------------- */

export interface CalendlyOptions {
  /** A hosted inbox, whose Calendly app is ours and on its way: "Soon" rather than "set up". */
  readonly hosted?: boolean | undefined;
}

/**
 * Calendly, with a personal access token (always), and a sign-in with Calendly beside it once the
 * server has its Calendly app (`CALENDLY_CLIENT_ID`, `CALENDLY_CLIENT_SECRET`; ADR-030 §5): until then
 * that way says "Soon" on a hosted inbox and "set up" on one's own server.
 */
export function calendlyConnector(client: OAuthClient | null = null, opts: CalendlyOptions = {}): ConnectorDefinition {
  const auth = access(client);
  const signInReady = () =>
    client?.clientId && client.clientSecret ? (true as const) : "Calendly sign-in is not set up on this inbox yet.";

  /** Reads the account, its plan and event types, and adds the webhook: one way in or the other. */
  async function connectWith(
    ctx: ConnectContext,
    token: string,
    secret: Readonly<Record<string, string>>,
    owner?: string | null,
  ): Promise<Connected> {
    const who = await me(ctx, token);
    if (owner && owner !== who.userUri) {
      throw new ConnectorError("bad_response", "Calendly answered for another account. Try again.");
    }
    const destinations = await eventTypes(ctx, token, who);
    const stage = await stageOf(ctx, token, who);
    const hookUrl = ctx.hookUrl ?? null;
    // Calendly sends no webhooks on its Free plan: none is asked for.
    const webhook: Webhook =
      stage === "free"
        ? { state: "plan" }
        : hookUrl && ctx.hooksLive !== false
          ? await addWebhook(ctx, token, who, hookUrl)
          : { state: "pending" };
    const before = ctx.previous?.extra.webhook === "added" ? ctx.previous.extra.webhook_id : undefined;
    // This inbox's own address for its Calendly webhooks, whatever the connection's token in it.
    const ours = `${ctx.inbox.origin}/v1/hooks/calendly/`;
    return {
      account: accountOf(who),
      externalId: who.userId,
      secret: { ...secret, ...(webhook.state === "added" ? { signing_key: webhook.signingKey } : {}) },
      extra: {
        userUri: who.userUri,
        orgUri: who.orgUri,
        email: who.email,
        schedulingUrl: who.schedulingUrl,
        plan: stage,
        ...webhookExtra(webhook, hookUrl, ctx.now),
      },
      calendars: [],
      destinations,
      // On the Free plan nothing can be added on Calendly: bookings start off, and the line says why.
      defaults: { busy: [], destination: CALENDLY_AUTO, ...(stage === "free" ? { bookings: false } : {}) },
      note: noteOf(stage, destinations),
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
          // Connected again by signing in, with a new address of its own: the old address's webhook goes.
          if (webhook.state === "added" && hookUrl?.startsWith(ours)) {
            await dropWebhooksWhere(ctx, token, who, (callback) => callback.startsWith(ours) && callback !== hookUrl);
          }
        } catch {
          // Best effort, never throws.
        }
      },
    };
  }

  return {
    kind: "calendly",
    title: "Calendly",
    group: "calendars",
    capabilities: ["busy_times", "write_bookings"],
    auth: "form",
    form: calendlyForm,
    note: "Busy times work on every Calendly plan. Adding your bookings to Calendly needs its Standard plan or above.",
    presets: [
      {
        id: "oauth",
        label: "Calendly",
        values: {},
        auth: "oauth",
        action: "Continue with Calendly",
        consent:
          "Calendly will ask to let this inbox see when you are busy, read your event types and add the bookings it confirms.",
        ready: signInReady,
        whenNotReady: opts.hosted
          ? { status: "soon" }
          : {
              status: "setup",
              hint: "Needs a Calendly app on the server.",
              href: "https://surfingdog.ai/docs/connectors/calendly/#sign-in-with-calendly",
            },
      },
    ],
    disconnectNote: "If you made a token for it, revoke it too: Calendly → Integrations & apps → API & webhooks.",

    async connect(ctx, input) {
      const token = (input.token ?? "").trim();
      return connectWith(ctx, token, { token });
    },

    oauth: {
      authorizeUrl({ redirectUri, state, challenge }) {
        const q = new URLSearchParams({
          client_id: client?.clientId ?? "",
          response_type: "code",
          redirect_uri: redirectUri,
          code_challenge_method: "S256",
          code_challenge: challenge,
          state,
        });
        return `${CALENDLY_AUTH}/oauth/authorize?${q}`;
      },

      async exchange(ctx, p) {
        const got = await auth.exchange(ctx, p);
        return connectWith(ctx, got.token, got.secret, got.owner);
      },
    },

    /**
     * Every six hours, and sooner when the webhook is still to add or the inbox moved: the account, its
     * plan and its event types again, and the webhook kept pointing at this inbox. One Calendly switched
     * off (deliveries failed for a day) or that points elsewhere is made again with a new signing key; one
     * still to add is added once the inbox can be reached (and tried again on a plan that may have changed).
     */
    async refresh(ctx) {
      const token = await auth.bearer(ctx);
      const who = await me(ctx, token);
      const destinations = await eventTypes(ctx, token, who);
      const stage = await stageOf(ctx, token, who);
      const base = { account: accountOf(who), calendars: [], destinations, note: noteOf(stage, destinations) };
      const extra = {
        ...ctx.extra,
        userUri: who.userUri,
        orgUri: who.orgUri,
        email: who.email,
        schedulingUrl: who.schedulingUrl,
        plan: stage,
      };
      const hookUrl = ctx.hookUrl ?? null;
      if (!hookUrl || ctx.hooksLive === false) return { ...base, extra };
      // Still on Free: Calendly sends it no webhook, and none is asked for.
      if (stage === "free" && ctx.extra.webhook !== "added") {
        return { ...base, extra: { ...extra, ...webhookExtra({ state: "plan" }, hookUrl, ctx.now) } };
      }
      const id = typeof ctx.extra.webhook_id === "string" ? ctx.extra.webhook_id : null;
      if (ctx.extra.webhook === "added" && id) {
        const got = await call(ctx, token, "GET", `/webhook_subscriptions/${encodeURIComponent(id)}`);
        const w = resourceOf(got.json);
        const fine = got.res.status === 200 && w?.state !== "disabled" && w?.callback_url === hookUrl;
        if (fine || (got.res.status !== 200 && got.res.status !== 404)) return { ...base, extra };
        if (got.res.status === 200) await dropWebhook(ctx, token, id);
      }
      const made = await addWebhook(ctx, token, who, hookUrl);
      // The secret as it is now: a token refreshed in this run is kept, never the one it replaced.
      if (made.state === "added") await ctx.saveSecret({ ...(await auth.current(ctx)), signing_key: made.signingKey });
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

    async busy(ctx, window) {
      return busy(ctx, await auth.bearer(ctx), window);
    },

    bookings: {
      async put(ctx, booking, link) {
        return put(ctx, await auth.bearer(ctx), booking, link);
      },

      async remove(ctx, link) {
        await cancel(ctx, await auth.bearer(ctx), link);
      },

      /**
       * An event this inbox made and kept no id for: one at the booking's start, booked by the business's
       * own address, whose invitee carries the mark only this inbox can make.
       */
      async find(ctx, booking) {
        return findMarked(ctx, await auth.bearer(ctx), booking);
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
      if (ctx.extra.webhook === "added" && typeof id === "string") await dropWebhook(ctx, await auth.bearer(ctx), id);
      await auth.revoke(ctx);
    },
  };
}
