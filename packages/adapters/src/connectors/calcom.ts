import {
  type CalendarChoice,
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  field,
  type Interval,
  type LinkState,
  mergeIntervals,
  type OutboundBooking,
  type RunContext,
  secretField,
  subtractIntervals,
} from "@surfingdog/core";
import { z } from "zod";
import { retryAfterMs } from "./http";

/**
 * Cal.com (ADR-022) over its API v2 with the owner's API key. Busy times: the account's own bookings
 * (those this inbox made left out by the ids it keeps for them, never by anything a booking says of
 * itself: anyone who books on the owner's Cal.com page can set a booking's metadata), and the
 * calendars Cal.com checks for conflicts. Bookings: each one the inbox confirms is created in Cal.com
 * on an event type of the same length, moved by Cal.com's reschedule and cancelled by its cancel. The
 * customer is named but given no email, so Cal.com sends them nothing: the business's own inbox has
 * already told them. A booking carries a mark only this inbox can make (`ctx.marker`), by which a run
 * that stopped before noting a booking, or a connection made again, finds it.
 *
 * Cal.com cannot change the name on a booking it has: after a customer is erased, their name stays
 * on Cal.com bookings already made (upcoming ones too). Calendars connected directly lose it.
 *
 * The API versions are the ones Cal.com documented on 18 October 2026, one per endpoint as Cal.com
 * asks; each answer is read leniently, so a field added later changes nothing.
 */

export const CALCOM_API = "https://api.cal.com";
const V_BOOKINGS_WRITE = "2026-02-25";
const V_BOOKINGS_LIST = "2026-05-01";
const V_EVENT_TYPES = "2026-06-12";
/** The destination that picks the event type as long as each booking. */
export const AUTO = "auto";

export const calcomForm = z.object({
  api_key: secretField(
    z
      .string()
      .trim()
      .min(10)
      .max(200)
      .regex(/^cal_[A-Za-z0-9_-]+$/, "a Cal.com API key starts with cal_"),
    {
      label: "API key",
      help: "In Cal.com: Settings → Developer → API keys → New, with Never expires on. Copy it when it is shown.",
      link: { href: "https://app.cal.com/settings/developer/api-keys", text: "Get your API key" },
      placeholder: "cal_live_…",
    },
  ),
  api_url: field(z.string().trim().max(300).optional(), {
    label: "Cal.com API address",
    input: "url",
    placeholder: CALCOM_API,
    help: "Only for a Cal.com you run yourself.",
    advanced: true,
  }),
});

interface Ctx {
  readonly http: ConnectContext["http"];
}

function base(apiUrl: string | undefined): string {
  const raw = (apiUrl ?? "").trim();
  if (!raw) return CALCOM_API;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ConnectorError("config", "That is not a Cal.com address.", { field: "api_url" });
  }
  if (url.protocol !== "https:")
    throw new ConnectorError("config", "Cal.com is reached over https.", { field: "api_url" });
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v2$/, "")}`;
}

async function call(
  ctx: Ctx,
  key: string,
  apiBase: string,
  method: string,
  path: string,
  opts: { version?: string; body?: unknown } = {},
): Promise<{ res: ConnectorHttpResponse; json: unknown }> {
  const res = await ctx.http.request({
    method,
    url: `${apiBase}/v2${path}`,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(opts.version ? { "cal-api-version": opts.version } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let json: unknown = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError("auth", "Cal.com did not take that API key. Make a new one and press Connect again.", {
      field: "api_key",
    });
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Cal.com asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Cal.com is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  return { res, json };
}

function data(json: unknown): unknown {
  return json && typeof json === "object" ? (json as { data?: unknown }).data : undefined;
}

function messageOf(json: unknown): string {
  const j = (json ?? {}) as { error?: { message?: unknown }; message?: unknown };
  const m = j.error?.message ?? j.message;
  return typeof m === "string" ? m.slice(0, 200) : "";
}

interface Me {
  readonly id: number;
  readonly email: string;
  readonly username: string | null;
  readonly name: string | null;
  readonly timeZone: string;
}

async function me(ctx: Ctx, key: string, apiBase: string): Promise<Me> {
  const { res, json } = await call(ctx, key, apiBase, "GET", "/me");
  const d = data(json) as Partial<Me> | undefined;
  if (res.status !== 200 || !d || typeof d.id !== "number" || typeof d.email !== "string") {
    throw new ConnectorError("bad_response", "Cal.com did not say whose key this is.");
  }
  return {
    id: d.id,
    email: d.email,
    username: d.username ?? null,
    name: d.name ?? null,
    timeZone: typeof d.timeZone === "string" ? d.timeZone : "UTC",
  };
}

/** The account's event types as destinations, each with the lengths it takes, and "auto" first. */
async function eventTypes(ctx: Ctx, key: string, apiBase: string): Promise<CalendarChoice[]> {
  const { res, json } = await call(ctx, key, apiBase, "GET", "/event-types", { version: V_EVENT_TYPES });
  if (res.status !== 200) throw new ConnectorError("bad_response", "Cal.com did not list the event types.");
  const d = data(json);
  // Read leniently: a list, or groups of lists as older versions answered.
  const raw: unknown[] = Array.isArray(d)
    ? d
    : Array.isArray((d as { eventTypeGroups?: unknown } | undefined)?.eventTypeGroups)
      ? ((d as { eventTypeGroups: { eventTypes?: unknown[] }[] }).eventTypeGroups.flatMap(
          (g) => g.eventTypes ?? [],
        ) as unknown[])
      : [];
  const out: CalendarChoice[] = [{ id: AUTO, name: "Same length as the booking", writable: true }];
  for (const e of raw) {
    const t = e as {
      id?: unknown;
      title?: unknown;
      lengthInMinutes?: unknown;
      length?: unknown;
      lengthInMinutesOptions?: unknown;
    };
    if (typeof t.id !== "number") continue;
    const length = Number(t.lengthInMinutes ?? t.length);
    const options = Array.isArray(t.lengthInMinutesOptions) ? t.lengthInMinutesOptions.map(Number) : [];
    const lengths = [...new Set([length, ...options].filter((n) => Number.isFinite(n) && n > 0))];
    out.push({
      id: String(t.id),
      name: `${String(t.title ?? "Event type")}${Number.isFinite(length) ? ` · ${length} min` : ""}`.slice(0, 120),
      writable: true,
      lengths,
    });
  }
  return out;
}

function keyOf(ctx: RunContext): { key: string; apiBase: string } {
  const key = ctx.secret.api_key ?? "";
  if (!key) throw new ConnectorError("auth", "The saved API key is missing. Connect Cal.com again.");
  return { key, apiBase: String(ctx.extra.apiBase ?? CALCOM_API) };
}

/** The event type a booking is created on, and the length to ask for when it is not the type's own. */
function eventTypeFor(ctx: RunContext, booking: OutboundBooking): { id: number; lengthInMinutes?: number } {
  const types = ctx.destinations.filter((d) => d.id !== AUTO);
  const chosen = ctx.destination && ctx.destination !== AUTO ? types.find((t) => t.id === ctx.destination) : undefined;
  const fits = (t: CalendarChoice) => (t.lengths ?? []).includes(booking.durationMin);
  const pick = chosen ?? types.find((t) => t.lengths?.[0] === booking.durationMin) ?? types.find(fits);
  if (!pick) {
    throw new ConnectorError(
      "refused",
      `No Cal.com event type is ${booking.durationMin} minutes long. Add one in Cal.com, or choose one here.`,
    );
  }
  if (!fits(pick)) {
    throw new ConnectorError(
      "refused",
      `${pick.name} cannot take a ${booking.durationMin}-minute booking. Choose another event type here.`,
    );
  }
  return pick.lengths?.[0] === booking.durationMin
    ? { id: Number(pick.id) }
    : { id: Number(pick.id), lengthInMinutes: booking.durationMin };
}

const LANGUAGES = new Set([
  "en",
  "pt",
  "es",
  "de",
  "fr",
  "it",
  "nl",
  "pl",
  "sv",
  "da",
  "nb",
  "fi",
  "cs",
  "tr",
  "ja",
  "ko",
  "zh",
]);

interface CalBooking {
  readonly uid?: string;
  readonly start?: string;
  readonly end?: string;
  readonly status?: string;
  readonly eventTypeId?: number;
  readonly eventType?: { readonly id?: number };
  readonly metadata?: Record<string, unknown>;
}

/** Pages of a hundred bookings read in one sync, at most. */
const MAX_PAGES = 20;

/**
 * The account's bookings in the window, by start. `complete` is false when there were more than
 * this reads in one go: the answer then holds every booking that starts before the last one read.
 */
async function listBookings(
  ctx: RunContext,
  window: Interval,
): Promise<{ readonly bookings: CalBooking[]; readonly complete: boolean }> {
  const { key, apiBase } = keyOf(ctx);
  const out: CalBooking[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      afterStart: new Date(window.start).toISOString(),
      beforeEnd: new Date(window.end).toISOString(),
      sortStart: "asc",
      limit: "100",
    });
    if (cursor) q.set("cursor", cursor);
    const { res, json } = await call(ctx, key, apiBase, "GET", `/bookings?${q}`, { version: V_BOOKINGS_LIST });
    if (res.status !== 200) throw new ConnectorError("bad_response", "Cal.com would not list the bookings.");
    const d = data(json);
    if (Array.isArray(d)) out.push(...(d as CalBooking[]));
    const p = (json as { pagination?: { nextCursor?: unknown; hasMore?: unknown } } | null)?.pagination;
    cursor = typeof p?.nextCursor === "string" && p.nextCursor ? p.nextCursor : null;
    if (!cursor) return { bookings: out, complete: true };
  }
  return { bookings: out, complete: false };
}

const BUSY_STATUSES = new Set(["accepted", "pending", "awaiting_host"]);

/** The mark a booking this inbox made carries: of this account's marker and the booking, and nobody else's. */
async function markOf(ctx: RunContext, itemId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ctx.marker}:${itemId}`)),
  );
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function eventTypeOf(b: CalBooking): number | null {
  const id = b.eventTypeId ?? b.eventType?.id;
  return typeof id === "number" ? id : null;
}

export function calcomConnector(): ConnectorDefinition {
  return {
    kind: "calcom",
    title: "Cal.com",
    group: "calendars",
    capabilities: ["busy_times", "write_bookings"],
    auth: "form",
    form: calcomForm,

    async connect(ctx, input) {
      const key = (input.api_key ?? "").trim();
      const apiBase = base(input.api_url);
      const who = await me(ctx, key, apiBase);
      const destinations = await eventTypes(ctx, key, apiBase);
      const account = who.username ? `${who.name ?? who.username} (${who.username})` : who.email;
      return {
        account,
        externalId: apiBase === CALCOM_API ? String(who.id) : `${new URL(apiBase).host}:${who.id}`,
        secret: { api_key: key },
        extra: { apiBase, email: who.email, userId: who.id },
        calendars: [],
        destinations,
        defaults: { busy: [], destination: AUTO },
      };
    },

    async refresh(ctx) {
      const { key, apiBase } = keyOf(ctx);
      const who = await me(ctx, key, apiBase);
      return {
        account: who.username ? `${who.name ?? who.username} (${who.username})` : who.email,
        calendars: [],
        destinations: await eventTypes(ctx, key, apiBase),
      };
    },

    async busy(ctx, window) {
      // Only the bookings this inbox keeps ids for are its own: what a booking's metadata says is
      // set by whoever booked it.
      const ours = (b: CalBooking) => b.uid !== undefined && ctx.own.ids.has(b.uid);
      const listed = await listBookings(ctx, window);
      const bookings = listed.bookings
        .filter((b) => BUSY_STATUSES.has(String(b.status ?? "").toLowerCase()) && !ours(b))
        .map((b) => ({ start: Date.parse(String(b.start)), end: Date.parse(String(b.end)) }));
      const intervals = mergeIntervals([...bookings, ...(await calendarsBusy(ctx, window))], window);
      if (listed.complete) return intervals;
      // More bookings ahead than one sync reads: known up to the last one read, closed past it.
      const starts = listed.bookings.map((b) => Date.parse(String(b.start))).filter(Number.isFinite);
      return { intervals, until: starts.length ? Math.max(...starts) : window.start };
    },

    bookings: {
      async put(ctx, booking, link) {
        const { key, apiBase } = keyOf(ctx);
        const type = eventTypeFor(ctx, booking);
        const sameTimes = link?.start === booking.start && link?.end === booking.end;
        if (link?.externalId && link.calendar === String(type.id) && sameTimes) return link;
        if (link?.externalId && link.calendar === String(type.id)) {
          const { res, json } = await call(
            ctx,
            key,
            apiBase,
            "POST",
            `/bookings/${encodeURIComponent(link.externalId)}/reschedule`,
            {
              version: V_BOOKINGS_WRITE,
              body: {
                start: new Date(booking.start).toISOString(),
                ...(type.lengthInMinutes ? { lengthInMinutes: type.lengthInMinutes } : {}),
                ...(typeof ctx.extra.email === "string" ? { rescheduledBy: ctx.extra.email } : {}),
                reschedulingReason: "Moved in the inbox",
              },
            },
          );
          if (res.status === 200 || res.status === 201) return linkOf(json, type.id, link);
          // Gone in Cal.com (cancelled there): written again below, as a new booking.
          if (res.status !== 404 && res.status !== 400) throw refusal(res.status, json, booking, ctx);
        } else if (link?.externalId) {
          // Another event type now: the old booking goes, a new one is made.
          await cancel(ctx, key, apiBase, link.externalId);
        }
        const { res, json } = await call(ctx, key, apiBase, "POST", "/bookings", {
          version: V_BOOKINGS_WRITE,
          body: {
            start: new Date(booking.start).toISOString(),
            eventTypeId: type.id,
            ...(type.lengthInMinutes ? { lengthInMinutes: type.lengthInMinutes } : {}),
            attendee: {
              name: booking.customerName ?? booking.serviceName,
              timeZone: ctx.inbox.timezone,
              language: LANGUAGES.has(ctx.inbox.language.slice(0, 2)) ? ctx.inbox.language.slice(0, 2) : "en",
            },
            metadata: { sdi_item: booking.itemId, sdi_mark: await markOf(ctx, booking.itemId) },
          },
        });
        if (res.status !== 200 && res.status !== 201) throw refusal(res.status, json, booking, ctx);
        return linkOf(json, type.id, null);
      },

      async remove(ctx, link) {
        if (!link.externalId) return;
        const { key, apiBase } = keyOf(ctx);
        await cancel(ctx, key, apiBase, link.externalId);
      },

      /**
       * A booking this inbox made and kept no id for: one with its mark, at the booking's exact times,
       * on the event type it would be made on. A booking anyone else made never has the mark.
       */
      async find(ctx, booking) {
        const mark = await markOf(ctx, booking.itemId);
        let type: number | null = null;
        try {
          type = eventTypeFor(ctx, booking).id;
        } catch {
          type = null;
        }
        const { bookings } = await listBookings(ctx, { start: booking.start - 60_000, end: booking.end + 60_000 });
        const found = bookings.find(
          (b) =>
            b.metadata?.sdi_item === booking.itemId &&
            b.metadata?.sdi_mark === mark &&
            Date.parse(String(b.start)) === booking.start &&
            Date.parse(String(b.end)) === booking.end &&
            (type === null || eventTypeOf(b) === null || eventTypeOf(b) === type) &&
            String(b.status ?? "").toLowerCase() !== "cancelled",
        );
        if (!found?.uid) return null;
        const at = eventTypeOf(found);
        return {
          externalId: found.uid,
          etag: null,
          // The event type it is on; when the list does not say, the one it was found on.
          calendar: at !== null ? String(at) : type !== null ? String(type) : null,
          start: booking.start,
          end: booking.end,
        };
      },
    },
  };
}

async function cancel(ctx: RunContext, key: string, apiBase: string, uid: string): Promise<void> {
  const { res, json } = await call(ctx, key, apiBase, "POST", `/bookings/${encodeURIComponent(uid)}/cancel`, {
    version: V_BOOKINGS_WRITE,
    body: { cancellationReason: "Cancelled in the inbox" },
  });
  if (res.status === 200 || res.status === 201 || res.status === 404) return;
  // Cancelled already is done.
  if (res.status === 400 && /cancel/i.test(messageOf(json))) return;
  const why = messageOf(json);
  throw new ConnectorError("refused", `Cal.com would not cancel it${why ? `: ${why}` : "."}`);
}

function linkOf(json: unknown, eventTypeId: number, previous: LinkState | null): LinkState {
  const d = data(json);
  const b = (Array.isArray(d) ? d[0] : d) as CalBooking | undefined;
  const uid = typeof b?.uid === "string" ? b.uid : previous?.externalId;
  if (!uid) throw new ConnectorError("bad_response", "Cal.com did not say which booking it made.");
  return { externalId: uid, etag: null, calendar: String(eventTypeId) };
}

/** Cal.com's own words about a time it would not take, pointing at its hours only when that is the reason. */
function refusal(_status: number, json: unknown, booking: OutboundBooking, ctx: RunContext): ConnectorError {
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: ctx.inbox.timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(booking.start));
  const why = messageOf(json);
  const hours = !why || /availab|outside|hours|no_available/i.test(why);
  return new ConnectorError(
    "refused",
    `Cal.com would not take ${when}${why ? `: ${why}` : ""}.${hours ? " Check the hours in Cal.com." : ""}`,
  );
}

/**
 * Busy times from the calendars Cal.com checks for conflicts. Cal.com writes the bookings this inbox
 * makes into one of them, and its answer has times but no ids, so those are taken out by their times.
 */
async function calendarsBusy(ctx: RunContext, window: Interval): Promise<Interval[]> {
  const { key, apiBase } = keyOf(ctx);
  const { res, json } = await call(ctx, key, apiBase, "GET", "/calendars");
  // Never "nothing busy" for an answer that was not read: the last busy times stay, and it says why.
  if (res.status !== 200) throw new ConnectorError("bad_response", "Cal.com would not list its calendars.");
  const connected = ((data(json) as { connectedCalendars?: unknown } | undefined)?.connectedCalendars ?? []) as {
    credentialId?: unknown;
    calendars?: { externalId?: unknown; isSelected?: unknown; credentialId?: unknown }[];
  }[];
  const q = new URLSearchParams({
    dateFrom: new Date(window.start).toISOString().slice(0, 10),
    dateTo: new Date(window.end).toISOString().slice(0, 10),
    timeZone: "UTC",
  });
  let any = false;
  for (const c of connected) {
    for (const cal of c.calendars ?? []) {
      if (cal.isSelected !== true || typeof cal.externalId !== "string") continue;
      const credential = cal.credentialId ?? c.credentialId;
      if (typeof credential !== "number") continue;
      q.append("calendar", `${credential},${cal.externalId}`);
      any = true;
    }
  }
  if (!any) return [];
  const busy = await call(ctx, key, apiBase, "GET", `/calendars/busy-times?${q}`);
  if (busy.res.status !== 200) {
    throw new ConnectorError("bad_response", "Cal.com would not give the busy times of its calendars.");
  }
  const list = (data(busy.json) ?? []) as { start?: unknown; end?: unknown }[];
  const intervals = (Array.isArray(list) ? list : []).map((b) => ({
    start: Date.parse(String(b.start)),
    end: Date.parse(String(b.end)),
  }));
  return subtractIntervals(intervals, ctx.own.spans);
}
