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
 * Google Calendar (ADR-022) over its API, with an OAuth sign-in: the authorization code flow with
 * PKCE (S256) and offline access, so the inbox keeps working after the owner closes the tab. Two
 * calendar scopes and no more: `calendar.freebusy` to read when the owner is busy (times only, never
 * what the events are), and `calendar.events.owned` to add, move and remove the bookings it confirms
 * on the owner's own calendars; and `openid email`, which are not sensitive, so the account is known
 * by Google's own id for it, never by a calendar's name. Busy times come from the free/busy query;
 * the bookings this inbox wrote are taken out by their times, since that answer carries no ids.
 *
 * Until the instance has a Google client (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET) it
 * shows as "Soon" on a hosted inbox, where ours is on its way, and as "set up" on one's own server.
 */

/** The calendar scopes: what the owner is asked to allow, and what must come back allowed. */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;

/** Everything asked for: the calendar scopes, and who the account is (`openid email`). */
export const GOOGLE_SCOPES = ["openid", "email", ...GOOGLE_CALENDAR_SCOPES] as const;

const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

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

/**
 * Who the account is, from the ID token Google's token endpoint answered with: its `sub` (Google's
 * own id, which never changes) and its address. Taken straight from Google over TLS with the client's
 * secret, so its issuer, audience and expiry are what is checked (OpenID Connect Core §3.1.3.7).
 */
export function idTokenClaims(
  token: string,
  clientId: string,
  now: number,
): { readonly sub: string; readonly email: string | null } | null {
  const part = token.split(".")[1];
  if (!part) return null;
  let claims: { iss?: unknown; aud?: unknown; exp?: unknown; sub?: unknown; email?: unknown; email_verified?: unknown };
  try {
    const b64 = part.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")), (c) =>
      c.charCodeAt(0),
    );
    claims = JSON.parse(new TextDecoder().decode(bytes)) as typeof claims;
  } catch {
    return null;
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ISSUERS.has(String(claims.iss)) || !audiences.includes(clientId)) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 300_000) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  const email = typeof claims.email === "string" && claims.email_verified !== false ? claims.email : null;
  return { sub: claims.sub, email };
}

export interface GoogleOptions {
  /** A hosted inbox, whose Google client is ours and on its way: "Soon" rather than "set up". */
  readonly hosted?: boolean | undefined;
}

export function googleCalendarConnector(client: OAuthClient | null, opts: GoogleOptions = {}): ConnectorDefinition {
  const ready = () =>
    client?.clientId && client.clientSecret ? (true as const) : "Google sign-in is not set up on this inbox yet.";
  /**
   * Access tokens refreshed in this process, by refresh token: a run that refreshed once uses the new
   * token for every call after, rather than asking Google again and sealing it again each time.
   */
  const fresh = new Map<string, { readonly token: string; readonly expiresAt: number }>();

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
    if (res.status >= 500) {
      throw new ConnectorError(
        "unreachable",
        "Google is not answering properly; this inbox tries again in a few minutes.",
      );
    }
    if (res.status !== 200) throw new ConnectorError("bad_response", "Google would not finish the sign-in.");
    return j;
  }

  /** A fresh access token: the saved one while it lasts a minute more, else one from the refresh token. */
  async function accessToken(ctx: RunContext): Promise<string> {
    const expires = Number(ctx.secret.access_expires_at ?? 0);
    if (ctx.secret.access_token && expires > ctx.now + 60_000) return ctx.secret.access_token;
    const refresh = ctx.secret.refresh_token;
    if (!refresh) throw new ConnectorError("auth", "Google's lasting access is missing. Connect it again.");
    const cached = fresh.get(refresh);
    if (cached && cached.expiresAt > ctx.now + 60_000) return cached.token;
    const j = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: refresh });
    const token = typeof j.access_token === "string" ? j.access_token : "";
    if (!token) throw new ConnectorError("bad_response", "Google did not send an access token.");
    const expiresAt = ctx.now + Number(j.expires_in ?? 3600) * 1000;
    if (fresh.size >= 500) fresh.clear();
    fresh.set(refresh, { token, expiresAt });
    await ctx.saveSecret({ ...ctx.secret, access_token: token, access_expires_at: String(expiresAt) });
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
    if (res.status === 401) {
      // The token was refused: not kept for the next call.
      if (ctx.secret.refresh_token) fresh.delete(ctx.secret.refresh_token);
      throw new ConnectorError("auth", "Google stopped this connection. Connect it again.");
    }
    if (res.status === 429 || (res.status === 403 && /rateLimit/i.test(res.text))) {
      throw new ConnectorError("rate_limited", "Google asked this inbox to slow down.", {
        retryAfterMs: retryAfterMs(res.headers),
      });
    }
    if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project/i.test(res.text)) {
      throw new ConnectorError("config", "The Google Calendar API is not switched on for this inbox's Google client.");
    }
    if (res.status === 403) {
      throw new ConnectorError("auth", "Google did not allow this. Connect again and allow the calendar.");
    }
    if (res.status >= 500) {
      throw new ConnectorError(
        "unreachable",
        "Google is not answering properly; this inbox tries again in a few minutes.",
      );
    }
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
      extendedProperties: { private: { sdiItem: booking.itemId, sdiInbox: ctx.inbox.id } },
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
    whenNotReady: opts.hosted
      ? { status: "soon" }
      : {
          status: "setup",
          hint: "Needs a Google client on the server.",
          href: "https://surfingdog.ai/docs/calendars/#google-calendar",
        },

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
        if (!GOOGLE_CALENDAR_SCOPES.every((s) => granted.includes(s))) {
          throw new ConnectorError("refused", "Google gave access without the calendar. Connect again and allow both.");
        }
        if (!refresh || !access)
          throw new ConnectorError("bad_response", "Google did not give lasting access. Try again.");
        const who =
          typeof j.id_token === "string" && client ? idTokenClaims(j.id_token, client.clientId, ctx.now) : null;
        if (!who) throw new ConnectorError("bad_response", "Google did not say which account this is. Try again.");
        const secret = {
          refresh_token: refresh,
          access_token: access,
          access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
        };
        // The calendar is asked for once, so a client without the Calendar API says so now.
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
          saveSecret: async () => {},
        };
        const probe = await api(run, "GET", `${calendarPath("primary")}?maxResults=1&fields=summary,timeZone`);
        if (probe.res.status !== 200) throw new ConnectorError("bad_response", "Google did not show the calendar.");
        const summary = typeof probe.json.summary === "string" ? probe.json.summary : "";
        const account = who.email || summary || "Google Calendar";
        const calendars = [{ id: "primary", name: summary || account, writable: true, primary: true }];
        return {
          account,
          // Google's own id for the account: the same however its calendars are named.
          externalId: who.sub,
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
        if (res.status !== 200) throw new ConnectorError("bad_response", "Google would not give the busy times.");
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

function refused(_status: number): ConnectorError {
  return new ConnectorError("refused", "Google would not take the booking.");
}
