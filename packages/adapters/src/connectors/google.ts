import {
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  type Interval,
  type LinkState,
  mergeIntervals,
  type OAuthClient,
  type OutboundBooking,
  type RunContext,
  subtractIntervals,
} from "@surfingdog/core";
import { retryAfterMs } from "./http";

/**
 * Google Calendar (ADR-020) over its API, with an OAuth sign-in: the authorization code flow with
 * PKCE (S256) and offline access, so the inbox keeps working after the owner closes the tab. Two
 * scopes and no more: `calendar.freebusy` to read when the owner is busy (times only, never what the
 * events are), and `calendar.events.owned` to add, move and remove the bookings it confirms on the
 * owner's own calendars. Busy times come from the free/busy query; the bookings this inbox wrote are
 * taken out by their times, since that answer carries no ids.
 *
 * Shown as "Soon" until the instance has a Google client (GOOGLE_OAUTH_CLIENT_ID and
 * GOOGLE_OAUTH_CLIENT_SECRET): ours on hosted, the self-hoster's own otherwise.
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";
/** Google answers a free/busy query for a bounded range; longer windows are asked for in pieces. */
const FREEBUSY_SPAN_MS = 30 * 86_400_000;

function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function json(res: ConnectorHttpResponse): Record<string, unknown> {
  try {
    const v = JSON.parse(res.text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The event id Google keeps for a booking: ours to choose, so a retry finds the one it made. */
export function googleEventId(itemId: string): string {
  let hex = "";
  for (const b of new TextEncoder().encode(itemId)) hex += b.toString(16).padStart(2, "0");
  // base32hex allows 0-9 and a-v; hex is inside it.
  return `sdi${hex}`;
}

export function googleCalendarConnector(client: OAuthClient | null): ConnectorDefinition {
  const ready = () =>
    client?.clientId && client.clientSecret ? (true as const) : "Google sign-in is not set up on this inbox yet.";

  async function tokenRequest(ctx: ConnectContext, body: Record<string, string>): Promise<Record<string, unknown>> {
    if (!client) throw new ConnectorError("config", "Google sign-in is not set up on this inbox.");
    const res = await ctx.http.request({
      method: "POST",
      url: TOKEN,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form({ ...body, client_id: client.clientId, client_secret: client.clientSecret }),
    });
    const j = json(res);
    if (res.status === 400 && j.error === "invalid_grant") {
      throw new ConnectorError("auth", "Google stopped this connection. Connect it again.");
    }
    if (res.status === 401 || j.error === "invalid_client") {
      throw new ConnectorError("config", "Google did not recognise this inbox's sign-in client.");
    }
    if (res.status !== 200) throw new ConnectorError("bad_response", `Google answered ${res.status} for the sign-in.`);
    return j;
  }

  /** A fresh access token: the saved one while it lasts a minute more, else one from the refresh token. */
  async function accessToken(ctx: RunContext): Promise<string> {
    const expires = Number(ctx.secret.access_expires_at ?? 0);
    if (ctx.secret.access_token && expires > ctx.now + 60_000) return ctx.secret.access_token;
    const refresh = ctx.secret.refresh_token;
    if (!refresh) throw new ConnectorError("auth", "Google's lasting access is missing. Connect it again.");
    const j = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: refresh });
    const token = typeof j.access_token === "string" ? j.access_token : "";
    if (!token) throw new ConnectorError("bad_response", "Google did not send an access token.");
    const next = {
      ...ctx.secret,
      access_token: token,
      access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
    };
    await ctx.saveSecret(next);
    return token;
  }

  async function api(
    ctx: RunContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ res: ConnectorHttpResponse; json: Record<string, unknown> }> {
    const token = await accessToken(ctx);
    const res = await ctx.http.request({
      method,
      url: `${API}${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) throw new ConnectorError("auth", "Google stopped this connection. Connect it again.");
    if (res.status === 429 || (res.status === 403 && /rateLimit/i.test(res.text))) {
      throw new ConnectorError("rate_limited", "Google asked us to slow down.", {
        retryAfterMs: retryAfterMs(res.headers),
      });
    }
    if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project/i.test(res.text)) {
      throw new ConnectorError("config", "The Google Calendar API is not switched on for this inbox's Google client.");
    }
    if (res.status === 403) {
      throw new ConnectorError("auth", "Google did not allow this. Connect again and allow the calendar.");
    }
    if (res.status >= 500) throw new ConnectorError("unreachable", `Google answered ${res.status}. It is tried again.`);
    return { res, json: json(res) };
  }

  function eventBody(booking: OutboundBooking, ctx: RunContext): Record<string, unknown> {
    return {
      summary: booking.title,
      description: booking.description,
      start: { dateTime: new Date(booking.start).toISOString() },
      end: { dateTime: new Date(booking.end).toISOString() },
      transparency: "opaque",
      status: "confirmed",
      extendedProperties: { private: { sdiItem: booking.itemId, sdiInbox: ctx.inbox.host } },
      ...(booking.url ? { source: { title: "Inbox", url: booking.url } } : {}),
    };
  }

  const calendarPath = (calendar: string) => `/calendars/${encodeURIComponent(calendar)}/events`;

  return {
    kind: "google_calendar",
    title: "Google Calendar",
    group: "calendars",
    capabilities: ["busy_times", "write_bookings"],
    auth: "oauth",
    ready,

    oauth: {
      authorizeUrl({ redirectUri, state, challenge }) {
        const q = new URLSearchParams({
          client_id: client?.clientId ?? "",
          redirect_uri: redirectUri,
          response_type: "code",
          scope: GOOGLE_SCOPES.join(" "),
          access_type: "offline",
          // Asked every time, so Google sends a refresh token even to an account that connected before.
          prompt: "consent",
          include_granted_scopes: "false",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        return `${AUTHORIZE}?${q}`;
      },

      async exchange(ctx, { code, verifier, redirectUri }) {
        const j = await tokenRequest(ctx, {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        });
        const refresh = typeof j.refresh_token === "string" ? j.refresh_token : "";
        const access = typeof j.access_token === "string" ? j.access_token : "";
        const granted = String(j.scope ?? "").split(/\s+/);
        if (!GOOGLE_SCOPES.every((s) => granted.includes(s))) {
          throw new ConnectorError("refused", "Google gave access without the calendar. Connect again and allow both.");
        }
        if (!refresh || !access)
          throw new ConnectorError("bad_response", "Google did not give lasting access. Try again.");
        const secret = {
          refresh_token: refresh,
          access_token: access,
          access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
        };
        // The primary calendar's name is its owner's address: what the owner recognises it by.
        const run: RunContext = {
          ...ctx,
          secret,
          extra: {},
          calendars: [],
          busyCalendars: [],
          destinations: [],
          destination: null,
          own: { ids: new Set(), spans: [] },
          saveSecret: async () => {},
        };
        const probe = await api(run, "GET", `${calendarPath("primary")}?maxResults=1&fields=summary,timeZone`);
        if (probe.res.status !== 200 || typeof probe.json.summary !== "string") {
          throw new ConnectorError("bad_response", "Google did not show the calendar.");
        }
        const account = probe.json.summary;
        const calendars = [{ id: "primary", name: account, writable: true, primary: true }];
        return {
          account,
          externalId: account.toLowerCase(),
          secret,
          extra: {},
          calendars,
          destinations: calendars,
          defaults: { busy: ["primary"], destination: "primary" },
        };
      },
    },

    async busy(ctx, window) {
      const ids = ctx.busyCalendars.length ? ctx.busyCalendars : [];
      if (ids.length === 0) return [];
      const out: Interval[] = [];
      for (let from = window.start; from < window.end; from += FREEBUSY_SPAN_MS) {
        const to = Math.min(window.end, from + FREEBUSY_SPAN_MS);
        const { res, json: j } = await api(ctx, "POST", "/freeBusy", {
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString(),
          timeZone: "UTC",
          items: ids.map((id) => ({ id })),
        });
        if (res.status !== 200)
          throw new ConnectorError("bad_response", `Google answered ${res.status} for busy times.`);
        const calendars = (j.calendars ?? {}) as Record<string, { busy?: { start?: string; end?: string }[] }>;
        for (const id of ids) {
          for (const b of calendars[id]?.busy ?? []) {
            out.push({ start: Date.parse(String(b.start)), end: Date.parse(String(b.end)) });
          }
        }
      }
      return mergeIntervals(subtractIntervals(out, ctx.own.spans), window);
    },

    bookings: {
      async put(ctx, booking, link) {
        const calendar = ctx.destination ?? "primary";
        const id = googleEventId(booking.itemId);
        // Moved to another calendar: out of the old one first.
        if (link?.externalId && link.calendar && link.calendar !== calendar) {
          await remove(ctx, link);
        }
        const body = eventBody(booking, ctx);
        if (link?.externalId && link.calendar === calendar) {
          const patched = await api(ctx, "PATCH", `${calendarPath(calendar)}/${id}?sendUpdates=none`, body);
          if (patched.res.status === 200) return linkOf(patched.json, id, calendar);
          if (patched.res.status !== 404 && patched.res.status !== 410) throw refused(patched.res.status);
        }
        const created = await api(ctx, "POST", `${calendarPath(calendar)}?sendUpdates=none`, { id, ...body });
        if (created.res.status === 200) return linkOf(created.json, id, calendar);
        // The id is in use: a run that stopped after writing, or a booking removed here and booked again.
        if (created.res.status === 409) {
          const patched = await api(ctx, "PATCH", `${calendarPath(calendar)}/${id}?sendUpdates=none`, body);
          if (patched.res.status === 200) return linkOf(patched.json, id, calendar);
          throw refused(patched.res.status);
        }
        throw refused(created.res.status);
      },
      remove: (ctx, link) => remove(ctx, link),
    },

    async disconnect(ctx) {
      const token = ctx.secret.refresh_token;
      if (!token) return;
      await ctx.http.request({
        method: "POST",
        url: REVOKE,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ token }),
        timeoutMs: 5_000,
      });
    },
  };

  async function remove(ctx: RunContext, link: LinkState): Promise<void> {
    if (!link.externalId) return;
    const calendar = link.calendar ?? "primary";
    const { res } = await api(
      ctx,
      "DELETE",
      `${calendarPath(calendar)}/${encodeURIComponent(link.externalId)}?sendUpdates=none`,
    );
    if (res.status === 200 || res.status === 204 || res.status === 404 || res.status === 410) return;
    throw refused(res.status);
  }
}

function linkOf(j: Record<string, unknown>, id: string, calendar: string): LinkState {
  return {
    externalId: typeof j.id === "string" ? j.id : id,
    etag: typeof j.etag === "string" ? j.etag : null,
    calendar,
  };
}

function refused(status: number): ConnectorError {
  return new ConnectorError("refused", `Google answered ${status} when the booking was written.`);
}
