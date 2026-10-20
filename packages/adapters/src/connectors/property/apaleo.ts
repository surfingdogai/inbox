import {
  type AriRow,
  addLocalDays,
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  dateIn,
  daysBetween,
  type ExternalProperty,
  type ExternalRate,
  type ExternalRoom,
  field,
  type HookFact,
  type LinkState,
  minorAmount,
  minorUnits,
  type OAuthClient,
  type OutboundStay,
  type RunContext,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { retryAfterMs } from "../http";

/**
 * apaleo (ADR-033 §8.4), built from its public OpenAPI files (booking-v1, inventory-v1, availability-v1,
 * rateplan-v1, account-v1 and webhook-v1, at https://api.apaleo.com/swagger/<api>/swagger.json and
 * https://webhook.apaleo.com/swagger/webhook-v1/swagger.json) and its OAuth guides
 * (https://apaleo.dev/guides/oauth-connection/auth-code-grant.html,
 * https://apaleo.dev/guides/oauth-connection/refresh-token.html).
 *
 * **Switched off until a connect client exists.** A hotel connects by approving this inbox on apaleo's
 * own page (OAuth authorization code, with `offline_access` for a refresh token): the client's id and
 * secret are the operator's, issued when an app is registered as an apaleo connect client, so without
 * them `ready()` says why and the gallery shows **Needs setup**. A hotel making its own "simple client"
 * (client credentials) is a second way, which apaleo calls "only recommended for internal client apps":
 * it is code-complete behind its own switch, off.
 *
 * What it does:
 * - **Rooms** are a property's unit groups of kind `BedRoom`, counted by their members. **Rates** are its
 *   rate plans sold through the `Direct` channel whose least guarantee is a 6 pm hold: a rate that needs
 *   a card or prepayment as its guarantee in apaleo is left out, because the inbox never holds a card.
 * - **What is free** is `/availability/v1/unit-groups`, and the price of a night each rate plan's
 *   `/rates`; a stay's own total is the `/booking/v1/offers` answer. Every time apaleo gives is read as an
 *   instant and turned into the property's own date in its own zone: a lodge east of the date line is a
 *   day ahead of UTC for part of every day, and a night is the date it starts on there.
 * - **A stay is written first**, `POST /booking/v1/bookings`, with an `Idempotency-Key` (apaleo answers
 *   the same request with the same answer for 24 hours) and our key as each reservation's `externalCode`,
 *   so it is found again after that too. apaleo refuses a night it cannot sell unless asked to force it
 *   (`refuses_unavailable`); the `$force` endpoints and their permissions are never used. No price is
 *   sent: apaleo prices the stay from the rate plan. apaleo has no holding state, so a held stay is a
 *   confirmed reservation the inbox cancels when the hold ends.
 * - **Changed** with the amend action, which refuses a night it cannot sell; a stay of several rooms
 *   whose second room is refused has its first put back. **Cancelled** with the cancel action, never
 *   deleted. The guest is set as the primary guest only once the stay is confirmed.
 * - **Never** a payment account, a card, an authorization, or a commission: those endpoints and fields
 *   are not called or sent, and the permission to call them is never asked for.
 * - **Webhooks** (https://apaleo.dev/guides/webhook/webhooks-payload.html) carry no signature: the
 *   connection's own address is the secret, the account must be this connection's, and the reservation
 *   named is read back with the hotel's token. A health check is a ping.
 */

export const APALEO_API = "https://api.apaleo.com";
export const APALEO_IDENTITY = "https://identity.apaleo.com";
export const APALEO_WEBHOOK = "https://webhook.apaleo.com";
/** The only hosts this connector calls. */
export const APALEO_HOSTS: readonly string[] = ["api.apaleo.com", "identity.apaleo.com", "webhook.apaleo.com"];
/**
 * What the hotel is asked to allow: read its rooms, rates and availability, read offers, and read and
 * manage reservations. Never a `force` permission, a payment account or an authorization.
 */
export const APALEO_SCOPES: readonly string[] = [
  "offline_access",
  "openid",
  "profile",
  "unitgroups.read",
  "rateplans.read",
  "rates.read",
  "availability.read",
  "offers.read",
  "reservations.read",
  "reservations.manage",
];
/** The webhook topics this inbox subscribes to. */
export const APALEO_TOPICS: readonly string[] = ["Reservation"];
/** The guarantee every reservation asks for: a 6 pm hold, which needs no card. */
const GUARANTEE = "PM6Hold";
/** Nights read in one call. */
const MAX_NIGHTS = 120;
const DOCS = "https://surfingdog.ai/docs/connectors/apaleo/";

export const apaleoOwnClientForm = z.object({
  client_id: field(z.string().trim().min(3).max(200), {
    label: "Client ID",
    help: "In apaleo: Apps → Connected apps → Add a custom app, as a simple client.",
  }),
  client_secret: secretField(z.string().trim().min(8).max(400), { label: "Client secret" }),
});

type Json = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function minor(value: unknown, currency: string): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const e = minorUnits(currency) ?? 2;
  return minorAmount(String(value), e) ?? Math.round(value * 10 ** e);
}

/** A time apaleo gives (a date, or a date and time in UTC or with an offset) as the property's own date. */
export function apaleoNight(value: string, zone: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const at = Date.parse(value);
  return Number.isFinite(at) ? dateIn(at, zone) : null;
}

export interface ApaleoOptions {
  readonly hosted?: boolean | undefined;
  /** The way a hotel makes its own simple client (client credentials). Off unless the operator says so. */
  readonly ownClient?: boolean | undefined;
}

export function apaleoConnector(client: OAuthClient | null | undefined, opts: ApaleoOptions = {}): ConnectorDefinition {
  const connectClient = client?.clientId && client.clientSecret ? client : null;
  const ownClient = opts.ownClient === true;

  async function token(ctx: Pick<ConnectContext, "http">, form: Record<string, string>): Promise<Json> {
    let res: ConnectorHttpResponse;
    try {
      res = await ctx.http.request({
        method: "POST",
        url: `${APALEO_IDENTITY}/connect/token`,
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        timeoutMs: 15_000,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("unreachable", "apaleo could not be reached.");
    }
    if (res.status === 400 || res.status === 401) {
      throw new ConnectorError("auth", "apaleo did not take this inbox's access: approve it again in apaleo.");
    }
    if (res.status === 429) {
      throw new ConnectorError("rate_limited", "apaleo asked to wait.", {
        retryAfterMs: retryAfterMs(res.headers) ?? 30_000,
      });
    }
    if (res.status !== 200) throw new ConnectorError("unreachable", `apaleo's sign-in answered ${res.status}.`);
    try {
      return JSON.parse(res.text) as Json;
    } catch {
      throw new ConnectorError("bad_response", "apaleo's sign-in answered with something that is not JSON.");
    }
  }

  /** A bearer token for this connection: the one kept while it lasts, else a fresh one, kept sealed. */
  async function bearer(ctx: RunContext, force = false): Promise<string> {
    const kept = ctx.secret.access_token ?? "";
    const until = Number(ctx.secret.access_expires_at ?? 0);
    if (kept && !force && until > ctx.now + 60_000) return kept;
    let j: Json;
    if (ctx.secret.refresh_token) {
      if (!connectClient) throw new ConnectorError("config", "apaleo needs this server's connect client.");
      j = await token(ctx, {
        grant_type: "refresh_token",
        refresh_token: ctx.secret.refresh_token,
        client_id: connectClient.clientId,
        client_secret: connectClient.clientSecret,
      });
    } else if (ctx.secret.client_id && ctx.secret.client_secret) {
      if (!ownClient) throw new ConnectorError("config", "A hotel's own apaleo client is off on this server.");
      j = await token(ctx, {
        grant_type: "client_credentials",
        client_id: ctx.secret.client_id,
        client_secret: ctx.secret.client_secret,
      });
    } else {
      throw new ConnectorError("auth", "This connection holds no apaleo access: connect it again.");
    }
    const access = str(j.access_token);
    if (!access) throw new ConnectorError("bad_response", "apaleo gave no access token.");
    const next: Record<string, string> = {
      ...ctx.secret,
      access_token: access,
      access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
      ...(str(j.refresh_token) ? { refresh_token: str(j.refresh_token) } : {}),
    };
    await ctx.saveSecret(next);
    return access;
  }

  async function request(
    ctx: Pick<ConnectContext, "http">,
    accessToken: string,
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ConnectorHttpResponse> {
    try {
      return await ctx.http.request({
        method,
        url,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        timeoutMs: 20_000,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("unreachable", "apaleo could not be reached.");
    }
  }

  function failed(res: ConnectorHttpResponse): never {
    const messages = () => {
      try {
        const j = JSON.parse(res.text) as Json;
        const list = Array.isArray(j.messages) ? (j.messages as unknown[]).map(str) : [str(j.message)];
        return list.filter(Boolean).join(" ").slice(0, 300);
      } catch {
        return "";
      }
    };
    if (res.status === 401)
      throw new ConnectorError("auth", "apaleo did not take this inbox's access: connect it again.");
    if (res.status === 403) {
      throw new ConnectorError("auth", "apaleo did not allow it: the connection lacks a permission. Connect it again.");
    }
    if (res.status === 404) throw new ConnectorError("not_found", "apaleo has no such thing.");
    if (res.status === 409 || res.status === 422 || res.status === 400) {
      throw new ConnectorError("refused", messages() || "apaleo did not take it.");
    }
    if (res.status === 429) {
      throw new ConnectorError("rate_limited", "apaleo asked to wait.", {
        retryAfterMs: retryAfterMs(res.headers) ?? 30_000,
      });
    }
    if (res.status >= 500 || res.status === 499)
      throw new ConnectorError("unreachable", "apaleo is not answering properly.");
    throw new ConnectorError("bad_response", `apaleo answered ${res.status}.`);
  }

  /** One call with this connection's token, tried once more with a fresh one if apaleo no longer takes it. */
  async function api(
    ctx: RunContext,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: Json }> {
    const url = path.startsWith("https://") ? path : `${APALEO_API}${path}`;
    let res = await request(ctx, await bearer(ctx), method, url, body, headers);
    if (res.status === 401) res = await request(ctx, await bearer(ctx, true), method, url, body, headers);
    if (res.status === 204) return { status: 204, json: {} };
    if (res.status < 200 || res.status >= 300) failed(res);
    if (!res.text) return { status: res.status, json: {} };
    try {
      return { status: res.status, json: JSON.parse(res.text) as Json };
    } catch {
      throw new ConnectorError("bad_response", "apaleo answered with something that is not JSON.");
    }
  }

  const list = (j: Json, key: string): Json[] => (Array.isArray(j[key]) ? (j[key] as Json[]) : []);

  async function zoneOf(ctx: RunContext, propertyId: string): Promise<string> {
    const { json } = await api(ctx, "GET", `/inventory/v1/properties/${encodeURIComponent(propertyId)}`);
    const zone = str(json.timeZone);
    if (!zone) throw new ConnectorError("bad_response", "apaleo did not give the property's time zone.");
    return zone;
  }

  async function ratePlans(ctx: RunContext, propertyId: string): Promise<(ExternalRate & { roomId: string })[]> {
    const q = new URLSearchParams({ propertyId, channelCodes: "Direct", pageSize: "500" });
    const { json } = await api(ctx, "GET", `/rateplan/v1/rate-plans?${q}`);
    return list(json, "ratePlans")
      .filter(
        (r) =>
          r.isArchived !== true &&
          r.minGuaranteeType === GUARANTEE &&
          (!Array.isArray(r.channelCodes) || (r.channelCodes as unknown[]).includes("Direct")),
      )
      .map((r) => {
        const roomId = str((r.unitGroup as Json | undefined)?.id);
        return { id: str(r.id), name: str(r.name) || str(r.code), roomIds: roomId ? [roomId] : [], roomId };
      });
  }

  /** Units free by unit group and night, from `from` for `count` nights. */
  async function availability(
    ctx: RunContext,
    propertyId: string,
    zone: string,
    from: string,
    count: number,
  ): Promise<Map<string, Map<string, number>>> {
    const q = new URLSearchParams({
      propertyId,
      from,
      to: addLocalDays(from, count - 1),
      unitGroupTypes: "BedRoom",
      pageSize: "500",
    });
    const { json } = await api(ctx, "GET", `/availability/v1/unit-groups?${q}`);
    const out = new Map<string, Map<string, number>>();
    for (const slice of list(json, "timeSlices")) {
      const night = apaleoNight(str(slice.from), zone);
      if (!night) continue;
      for (const g of list(slice, "unitGroups")) {
        const id = str((g.unitGroup as Json | undefined)?.id);
        const available = typeof g.availableCount === "number" ? g.availableCount : null;
        const sellable = typeof g.sellableCount === "number" ? g.sellableCount : available;
        if (!id || available === null || sellable === null) continue;
        if (!out.has(id)) out.set(id, new Map());
        // What the hotel may overbook on its own is its own: through the inbox, never past its rooms.
        out.get(id)?.set(night, Math.min(available, sellable));
      }
    }
    return out;
  }

  function codeOf(stay: OutboundStay, index: number): string {
    return stay.rooms.length > 1 ? `${stay.key}-${index + 1}` : stay.key;
  }

  function isOurs(code: string, key: string): boolean {
    if (code === key) return true;
    return code.startsWith(`${key}-`) && /^\d{1,2}$/.test(code.slice(key.length + 1));
  }

  function personOf(guest: NonNullable<OutboundStay["guest"]>): Json {
    const parts = guest.name.trim().split(/\s+/).filter(Boolean);
    const last = parts.length > 1 ? (parts.pop() ?? "") : (parts[0] ?? guest.name);
    return {
      ...(parts.length > 0 ? { firstName: parts.join(" ") } : {}),
      lastName: last,
      ...(guest.email ? { email: guest.email } : {}),
      ...(guest.phone ? { phone: guest.phone } : {}),
    };
  }

  function stayDetails(stay: OutboundStay, room: OutboundStay["rooms"][number]): Json {
    if (!room.rateId) throw new ConnectorError("config", "Each room needs an apaleo rate plan: map one in Rates.");
    const nights = daysBetween(stay.checkIn, stay.checkOut);
    return {
      arrival: stay.checkIn,
      departure: stay.checkOut,
      adults: room.adults,
      ...(room.childrenAges.length > 0 ? { childrenAges: [...room.childrenAges] } : {}),
      timeSlices: Array.from({ length: nights }, () => ({ ratePlanId: room.rateId })),
    };
  }

  async function reservationsOf(ctx: RunContext, bookingId: string): Promise<Json[]> {
    const q = new URLSearchParams({ bookingId, pageSize: "100" });
    const { json } = await api(ctx, "GET", `/booking/v1/reservations?${q}`);
    return list(json, "reservations").sort((a, b) => str(a.externalCode).localeCompare(str(b.externalCode)));
  }

  async function account(ctx: RunContext): Promise<{ code: string; name: string }> {
    const { json } = await api(ctx, "GET", "/account/v1/accounts/current");
    const code = str(json.code);
    if (!code) throw new ConnectorError("bad_response", "apaleo did not say which account this is.");
    return { code, name: str(json.name) || code };
  }

  /** A connection run from what an exchange or a form gave, before it is kept. */
  function firstRun(
    ctx: ConnectContext,
    secret: Record<string, string>,
    saved: { secret: Record<string, string> },
  ): RunContext {
    return {
      ...ctx,
      secret,
      extra: {},
      calendars: [],
      busyCalendars: [],
      destinations: [],
      destination: null,
      own: { ids: new Set(), spans: [] },
      marker: "",
      saveSecret: async (next) => {
        saved.secret = { ...next };
      },
    };
  }

  /** Webhooks for reservations, at the connection's own address, once the address can be reached. */
  async function subscribe(ctx: RunContext): Promise<string | null> {
    if (!ctx.hookUrl || ctx.hooksLive === false) return null;
    try {
      const { json } = await api(ctx, "POST", `${APALEO_WEBHOOK}/v1/subscriptions`, {
        endpointUrl: ctx.hookUrl,
        topics: [...APALEO_TOPICS],
        propertyIds: [],
      });
      return str(json.id) || null;
    } catch {
      // Polling finds everything anyway; the next connect tries again.
      return null;
    }
  }

  async function connected(ctx: ConnectContext, secret: Record<string, string>): Promise<Connected> {
    const saved = { secret };
    const run = firstRun(ctx, secret, saved);
    const who = await account(run);
    const subscription = await subscribe({ ...run, secret: saved.secret });
    return {
      account: who.name,
      externalId: who.code,
      secret: saved.secret,
      extra: { accountId: who.code, ...(subscription ? { subscriptionId: subscription } : {}) },
      calendars: [],
      destinations: [],
      defaults: { busy: [], destination: null },
    };
  }

  const reason = "apaleo needs this server's connect client";
  const ready = (): true | string => (connectClient || ownClient ? true : reason);

  return {
    kind: "apaleo",
    title: "apaleo",
    group: "lodging",
    capabilities: ["stay_inventory", "write_stays", "stay_events"],
    auth: connectClient ? "oauth" : "form",
    form: apaleoOwnClientForm,
    note: "Rooms, rates and what's free from apaleo; each stay written to apaleo before it is confirmed.",
    consent:
      "apaleo will ask to let this inbox read your rooms, rates and availability, and make and change reservations.",
    ready,
    whenNotReady: {
      status: "setup",
      hint: opts.hosted
        ? "Needs an apaleo partner app, which this service does not have yet. Until then, use each room's calendar link."
        : "Needs an apaleo connect client on this server. Until then, use each room's calendar link.",
      href: DOCS,
    },
    presets: [
      {
        id: "own_client",
        label: "Your own apaleo client",
        values: {},
        auth: "form",
        ready: () => (ownClient ? true : "A hotel's own apaleo client is off on this server"),
        whenNotReady: {
          status: "setup",
          hint: "Off on this server: apaleo recommends a hotel's own client only for its internal apps.",
          href: DOCS,
        },
      },
    ],

    async connect(ctx, input) {
      if (!ownClient) throw new ConnectorError("config", "A hotel's own apaleo client is off on this server.");
      const secret = { client_id: (input.client_id ?? "").trim(), client_secret: (input.client_secret ?? "").trim() };
      const j = await token(ctx, { grant_type: "client_credentials", ...secret });
      const access = str(j.access_token);
      if (!access) throw new ConnectorError("bad_response", "apaleo gave no access token.");
      return connected(ctx, {
        ...secret,
        access_token: access,
        access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
      });
    },

    oauth: {
      authorizeUrl({ redirectUri, state, challenge }) {
        const q = new URLSearchParams({
          response_type: "code",
          client_id: connectClient?.clientId ?? "",
          redirect_uri: redirectUri,
          scope: APALEO_SCOPES.join(" "),
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        return `${APALEO_IDENTITY}/connect/authorize?${q}`;
      },
      async exchange(ctx, { code, verifier, redirectUri }) {
        if (!connectClient) throw new ConnectorError("config", reason);
        const j = await token(ctx, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          client_id: connectClient.clientId,
          client_secret: connectClient.clientSecret,
        });
        const access = str(j.access_token);
        const refresh = str(j.refresh_token);
        if (!access || !refresh)
          throw new ConnectorError("bad_response", "apaleo did not give lasting access. Try again.");
        const granted = str(j.scope).split(/\s+/);
        if (granted.some((s) => /force|payment|authori[sz]ation/i.test(s))) {
          throw new ConnectorError("refused", "apaleo gave more access than this inbox asks for: it was not kept.");
        }
        return connected(ctx, {
          access_token: access,
          refresh_token: refresh,
          access_expires_at: String(ctx.now + Number(j.expires_in ?? 3600) * 1000),
        });
      },
    },

    async disconnect(ctx) {
      const id = str(ctx.extra.subscriptionId);
      if (!id) return;
      try {
        await api(ctx, "DELETE", `${APALEO_WEBHOOK}/v1/subscriptions/${encodeURIComponent(id)}`);
      } catch {
        // Best effort: the hotel can remove the app in apaleo.
      }
    },
    disconnectNote: "In apaleo, the hotel can also remove this app under Apps → Connected apps.",

    stays: {
      async properties(ctx): Promise<ExternalProperty[]> {
        const { json } = await api(ctx, "GET", "/inventory/v1/properties?pageSize=100");
        return list(json, "properties")
          .filter((p) => p.isArchived !== true && p.isTemplate !== true)
          .map((p) => ({
            id: str(p.id),
            name: str(p.name) || str(p.code),
            currency: str(p.currencyCode).toUpperCase(),
            timezone: str(p.timeZone),
          }));
      },

      async rooms(ctx, propertyId): Promise<ExternalRoom[]> {
        const q = new URLSearchParams({ propertyId, unitGroupTypes: "BedRoom", pageSize: "500" });
        const { json } = await api(ctx, "GET", `/inventory/v1/unit-groups?${q}`);
        return list(json, "unitGroups").map((g) => {
          const max = typeof g.maxPersons === "number" ? g.maxPersons : 0;
          return {
            id: str(g.id),
            name: str(g.name) || str(g.code),
            units: typeof g.memberCount === "number" ? g.memberCount : 0,
            ...(max > 0 ? { capacity: { adults: max, children: 0, total: max } } : {}),
          };
        });
      },

      async ratePlans(ctx, propertyId): Promise<ExternalRate[]> {
        return (await ratePlans(ctx, propertyId)).map(({ id, name, roomIds }) => ({ id, name, roomIds }));
      },

      async ari(ctx, propertyId, window) {
        const zone = await zoneOf(ctx, propertyId);
        const total = daysBetween(window.from, window.to);
        if (total < 1) return [];
        const count = Math.min(total, MAX_NIGHTS);
        const avail = await availability(ctx, propertyId, zone, window.from, count);
        interface Row {
          roomId: string;
          night: string;
          units: number;
          prices: Record<string, number>;
          rates: number;
          closed: number;
          noArrival: number;
          noDeparture: number;
          minStay?: number;
          maxStay?: number;
        }
        const rows = new Map<string, Row>();
        for (const [roomId, nights] of avail) {
          for (const [night, units] of nights) {
            rows.set(`${roomId}|${night}`, {
              roomId,
              night,
              units,
              prices: {},
              rates: 0,
              closed: 0,
              noArrival: 0,
              noDeparture: 0,
            });
          }
        }
        for (const plan of await ratePlans(ctx, propertyId)) {
          const q = new URLSearchParams({
            from: window.from,
            to: addLocalDays(window.from, count - 1),
            pageSize: "500",
          });
          const { json } = await api(ctx, "GET", `/rateplan/v1/rate-plans/${encodeURIComponent(plan.id)}/rates?${q}`);
          for (const rate of list(json, "rates")) {
            const night = apaleoNight(str(rate.from), zone);
            const row = night ? rows.get(`${plan.roomId}|${night}`) : undefined;
            if (!row) continue;
            const r = (rate.restrictions ?? {}) as Json;
            row.rates++;
            if (r.closed === true) {
              row.closed++;
              continue;
            }
            if (r.closedOnArrival === true) row.noArrival++;
            if (r.closedOnDeparture === true) row.noDeparture++;
            if (typeof r.minLengthOfStay === "number")
              row.minStay = Math.min(row.minStay ?? r.minLengthOfStay, r.minLengthOfStay);
            if (typeof r.maxLengthOfStay === "number")
              row.maxStay = Math.max(row.maxStay ?? r.maxLengthOfStay, r.maxLengthOfStay);
            const price = (rate.price ?? {}) as Json;
            const amount = minor(price.amount, str(price.currency));
            if (amount !== null) row.prices[plan.id] = amount;
          }
        }
        const out: AriRow[] = [...rows.values()]
          .filter((r) => r.night >= window.from && r.night < window.to)
          .map((r) => ({
            roomId: r.roomId,
            night: r.night,
            units: r.units,
            ...(r.rates > 0 && r.closed === r.rates ? { closed: true } : {}),
            ...(r.rates > 0 && r.noArrival + r.closed === r.rates && r.noArrival > 0 ? { noArrival: true } : {}),
            ...(r.rates > 0 && r.noDeparture + r.closed === r.rates && r.noDeparture > 0 ? { noDeparture: true } : {}),
            ...(r.minStay !== undefined ? { minStay: r.minStay } : {}),
            ...(r.maxStay !== undefined ? { maxStay: r.maxStay } : {}),
            prices: r.prices,
          }));
        return count < total ? { rows: out, until: addLocalDays(window.from, count) } : out;
      },

      async price(ctx, q) {
        if (!q.rateId) return null;
        const zone = await zoneOf(ctx, q.propertyId);
        const p = new URLSearchParams({
          propertyId: q.propertyId,
          arrival: q.checkIn,
          departure: q.checkOut,
          adults: String(q.adults),
          channelCode: "Direct",
          unitGroupIds: q.roomId,
        });
        for (const age of q.childrenAges) p.append("childrenAges", String(age));
        const { status, json } = await api(ctx, "GET", `/booking/v1/offers?${p}`);
        if (status === 204) return null;
        const offer = list(json, "offers").find((o) => str((o.ratePlan as Json | undefined)?.id) === q.rateId);
        if (!offer) return null;
        const total = (offer.totalGrossAmount ?? {}) as Json;
        const currency = str(total.currency).toUpperCase();
        const value = minor(total.amount, currency);
        if (value === null || !currency) return null;
        const nights = list(offer, "timeSlices").flatMap((s) => {
          const night = apaleoNight(str(s.from), zone);
          const amount = minor(((s.totalGrossAmount ?? {}) as Json).amount, currency);
          return night && amount !== null ? [{ night, amount }] : [];
        });
        return { subtotal: { value, currency }, ...(nights.length > 0 ? { nights } : {}) };
      },
    },

    stayWriter: {
      async put(ctx, stay, link, status): Promise<LinkState> {
        if (link?.externalId) return move(ctx, stay, link, status);
        const guest = status === "confirmed" ? stay.guest : undefined;
        const comment = `Inbox stay ${stay.reference}`;
        // The same key with the same body is answered the same for 24 hours: a retry never books twice.
        const { json } = await api(
          ctx,
          "POST",
          "/booking/v1/bookings",
          {
            booker: guest ? personOf(guest) : { lastName: stay.reference },
            comment,
            reservations: stay.rooms.map((room, i) => ({
              ...stayDetails(stay, room),
              channelCode: "Direct",
              externalCode: codeOf(stay, i),
              guaranteeType: GUARANTEE,
              comment,
              ...(guest ? { primaryGuest: personOf(guest) } : {}),
            })),
          },
          { "idempotency-key": stay.key },
        );
        const id = str(json.id);
        const reservations = Array.isArray(json.reservationIds) ? json.reservationIds : [];
        if (!id || reservations.length !== stay.rooms.length) {
          throw new ConnectorError("bad_response", "apaleo did not say which reservations it made.");
        }
        return { externalId: id, etag: null, calendar: null };
      },

      async cancel(ctx, link) {
        if (!link.externalId) return;
        let reservations: Json[];
        try {
          reservations = await reservationsOf(ctx, link.externalId);
        } catch (error) {
          if (error instanceof ConnectorError && error.code === "not_found") return;
          throw error;
        }
        for (const r of reservations) {
          if (r.status !== "Confirmed") continue;
          await api(ctx, "PUT", `/booking/v1/reservation-actions/${encodeURIComponent(str(r.id))}/cancel`);
        }
      },

      async find(ctx, stay) {
        const q = new URLSearchParams({ propertyIds: stay.propertyId, externalCode: stay.key, pageSize: "100" });
        const { json } = await api(ctx, "GET", `/booking/v1/reservations?${q}`);
        const mine = list(json, "reservations").find((r) => isOurs(str(r.externalCode), stay.key));
        const booking = str(mine?.bookingId);
        return booking ? { externalId: booking, etag: null, calendar: null } : null;
      },

      // No `oversold`: apaleo refuses a night it cannot sell, both on a booking and on an amend, unless
      // forced, which this inbox never does.
    },

    hooks: {
      topics: APALEO_TOPICS,
      async verify(ctx, request) {
        let body: Json;
        try {
          body = JSON.parse(request.body) as Json;
        } catch {
          throw new ConnectorError("refused", "The webhook is not JSON.");
        }
        const accountId = str(ctx.extra.accountId);
        if (!accountId || str(body.accountId) !== accountId) {
          throw new ConnectorError("refused", "The webhook is about another account.");
        }
        const topic = str(body.topic);
        // The health check apaleo sends when the subscription is made: answered, nothing to read.
        if (topic.toLowerCase() === "system") return null;
        const entity = str((body.data as Json | undefined)?.entityId ?? body.entityId);
        const id = str(body.id);
        if (topic !== "Reservation" || !/^[A-Za-z0-9_-]{1,100}$/.test(entity) || !id) return null;
        return {
          eventId: `apaleo-${id}`.slice(0, 200),
          topic: `Reservation/${str(body.type)}`.slice(0, 60),
          refs: [entity],
        };
      },
      async read(ctx, event): Promise<HookFact[]> {
        const out: HookFact[] = [];
        for (const ref of event.refs) {
          let json: Json;
          try {
            json = (await api(ctx, "GET", `/booking/v1/reservations/${encodeURIComponent(ref)}`)).json;
          } catch (error) {
            if (error instanceof ConnectorError && error.code === "not_found") continue;
            throw error;
          }
          const property = str((json.property as Json | undefined)?.id);
          if (!property) continue;
          const zone = await zoneOf(ctx, property);
          const from = apaleoNight(str(json.arrival), zone);
          const to = apaleoNight(str(json.departure), zone);
          const room = str((json.unitGroup as Json | undefined)?.id);
          if (!from || !to) continue;
          out.push({
            kind: "stay_nights",
            ...(room ? { roomIds: [room] } : {}),
            from,
            to: to > from ? to : addLocalDays(from, 1),
          });
        }
        return out;
      },
    },
  };

  /** A booking written already, moved to these nights and rooms, room by room; the guest set once confirmed. */
  async function move(ctx: RunContext, stay: OutboundStay, link: LinkState, status: string): Promise<LinkState> {
    const booking = link.externalId ?? "";
    const current = (await reservationsOf(ctx, booking)).filter(
      (r) => r.status === "Confirmed" || r.status === "InHouse",
    );
    if (current.length === 0) throw new ConnectorError("not_found", "That stay is not in apaleo any more.");
    if (current.length !== stay.rooms.length) {
      throw new ConnectorError("refused", "The stay has another number of rooms in apaleo: change it there.");
    }
    const zone = await zoneOf(ctx, stay.propertyId);
    const done: { id: string; before: Json }[] = [];
    for (const [i, r] of current.entries()) {
      const room = stay.rooms[i];
      if (!room) continue;
      const wanted = stayDetails(stay, room);
      const arrival = apaleoNight(str(r.arrival), zone);
      const departure = apaleoNight(str(r.departure), zone);
      const plan = str((r.ratePlan as Json | undefined)?.id);
      const same =
        arrival === stay.checkIn &&
        departure === stay.checkOut &&
        plan === room.rateId &&
        r.adults === room.adults &&
        JSON.stringify(r.childrenAges ?? []) === JSON.stringify(room.childrenAges);
      if (same) continue;
      const before: Json = {
        arrival,
        departure,
        adults: r.adults,
        ...(Array.isArray(r.childrenAges) && r.childrenAges.length > 0 ? { childrenAges: r.childrenAges } : {}),
        timeSlices: Array.from({ length: arrival && departure ? daysBetween(arrival, departure) : 0 }, () => ({
          ratePlanId: plan,
        })),
      };
      try {
        await api(ctx, "PUT", `/booking/v1/reservation-actions/${encodeURIComponent(str(r.id))}/amend`, {
          ...wanted,
          requote: true,
        });
        done.push({ id: str(r.id), before });
      } catch (error) {
        // A room refused: the rooms moved before it are put back, so the stay is as it was.
        for (const d of done.reverse()) {
          await api(ctx, "PUT", `/booking/v1/reservation-actions/${encodeURIComponent(d.id)}/amend`, {
            ...d.before,
            requote: true,
          }).catch(() => undefined);
        }
        throw error;
      }
    }
    if (status === "confirmed" && stay.guest) {
      for (const r of current) {
        await api(ctx, "PATCH", `/booking/v1/reservations/${encodeURIComponent(str(r.id))}`, [
          { op: "replace", path: "/primaryGuest", value: personOf(stay.guest) },
        ]);
      }
    }
    return { externalId: booking, etag: null, calendar: null };
  }
}
