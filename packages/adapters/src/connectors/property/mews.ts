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
  type HookFact,
  instantOf,
  type LinkState,
  minorAmount,
  minorUnits,
  type OutboundStay,
  type RunContext,
  type StayWriteStatus,
  secretField,
  VERSION,
} from "@surfingdog/core";
import { sha256Hex } from "@surfingdog/platform";
import { z } from "zod";
import { retryAfterMs } from "../http";
import { constantTimeEqual, hmacSha256Hex } from "../pay-sign";

/**
 * Mews (ADR-033 §8.4), through its Connector API: https://docs.mews.com/connector-api/.
 *
 * **Switched off until a partner token exists.** Every call carries two tokens and a name
 * (https://docs.mews.com/connector-api/guidelines/authentication): a `ClientToken`, which Mews issues
 * to a certified partner and which is the same for every property (the server's operator holds it, never
 * a property and never this repository), and the property's own `AccessToken`, made when the property
 * connects the integration. Without the first, `ready()` says why and the gallery shows **Needs setup**
 * with nothing to press. Mews's public demo environment (`api.mews-demo.com`, published tokens, "NO REAL
 * DATA") is never called from here: the only host is production, and every test runs against a local
 * fake built from the documentation's own examples.
 *
 * What it does:
 * - **A property** is one of the enterprise's bookable services counted in days (`services/getAll`),
 *   its time zone and currency the enterprise's (`configuration/get`). Rooms are its resource categories,
 *   counted by their active assignments; rates are its public, enabled rates.
 * - **What is free** night by night is `services/getAvailability`; the price of a night is
 *   `rates/getPricing`, gross, per category. A night is a Mews time unit, which starts at midnight in
 *   the enterprise's zone (https://docs.mews.com/connector-api/concepts/time-units).
 * - **A stay is written first** with `reservations/add` and `CheckOverbooking: true`, so Mews refuses a
 *   night it has no room for (`refuses_unavailable`). Mews prices it from its own rate: no price is ever
 *   sent. A stay held or waiting for its deposit is written `Optional` with a `ReleasedUtc`, Mews's own
 *   hold, which Mews lets go by itself if the inbox never confirms it; confirmed is
 *   `reservations/confirm`. Mews sends no email of its own for it (`SendConfirmationEmail: false`): the
 *   property's inbox writes to its guest.
 * - **Found again by its note.** Mews takes no key of ours, so each reservation carries one line in its
 *   notes — the stay's reference, our key and a tag only this inbox can make — and `find` looks for it
 *   among the reservations the Connector API made in the last days (`serviceOrderNotes/getAll`).
 * - **A move** is `reservations/update`, whose documentation promises no overbooking check: the nights
 *   are read again at once, and a move that left one below none is put back and refused.
 * - **Cancelled by status** (`reservations/cancel`, no fee posted, no email), never deleted.
 * - **The guest** goes to Mews only once the stay is confirmed: a customer is added (or found by email)
 *   and set on the reservation. Until then the reservation's customer is a placeholder named by the
 *   stay's reference. No card, no credit card id, no payment is ever sent.
 * - **Limits.** 200 requests per access token in a sliding 30 seconds; a 429 says when to try again
 *   (`Retry-After`), and the inbox waits that long.
 * - **Webhooks** are set up by Mews for the whole integration, with a shared secret in the address
 *   (https://docs.mews.com/connector-api/events/wh-general,
 *   https://docs.mews.com/connector-api/events/wh-faq): the secret is checked in constant time, the
 *   enterprise must be this connection's, and the body is only a hint — each reservation it names is read
 *   back with the property's token.
 */

export const MEWS_API = "https://api.mews.com";
/** The only host this connector calls. Never the demo environment. */
export const MEWS_HOSTS: readonly string[] = ["api.mews.com"];
/** The `Client` every request names: this inbox and its version. */
export const MEWS_CLIENT = `Surfing Dog Inbox ${VERSION}`;
/** A held stay's own release in Mews: the inbox lets it go sooner, at the hold's end (est.). */
export const MEWS_HOLD_RELEASE_MS = 60 * 60_000;
/** A stay written while its deposit is due: released by Mews if the inbox never confirms it (est.). */
export const MEWS_PROVISIONAL_RELEASE_MS = 72 * 3_600_000;
/** The events the integration asks Mews for. */
export const MEWS_EVENTS: readonly string[] = ["ServiceOrderUpdated"];
/** How far back `find` looks for a reservation this inbox made: writes are looked for within minutes. */
const FIND_WINDOW_MS = 3 * 86_400_000;
const PAGE = 1000;
const MAX_PAGES = 20;
/** Mews counts a day service's availability up to 367 days in one call. */
const MAX_NIGHTS = 367;
const ALL_STATES = ["Inquired", "Confirmed", "Started", "Processed", "Canceled", "Optional", "Requested"] as const;
const LIVE_STATES = new Set(["Inquired", "Confirmed", "Started", "Optional", "Requested"]);
const DOCS = "https://surfingdog.ai/docs/connectors/mews/";

/** What the server's operator holds as a Mews partner: never a property's, never in the repository. */
export interface MewsPartner {
  /** The `ClientToken` Mews issues to a certified integration. */
  readonly clientToken: string;
  /** The shared secret Mews puts in the webhook address (`?token=`), when one was agreed with Mews. */
  readonly webhookToken?: string | undefined;
}

export const mewsForm = z.object({
  access_token: secretField(
    z
      .string()
      .trim()
      .min(16)
      .max(400)
      .regex(/^[A-Za-z0-9-]+$/, "a Mews access token is letters, digits and dashes"),
    {
      label: "Access token",
      help: "Mews makes it when your property connects this inbox in Mews Marketplace, and sends it to whoever runs this server.",
      link: { href: DOCS, text: "How Mews connects" },
    },
  ),
});

/* --- small things ---------------------------------------------------------- */

type Json = Record<string, unknown>;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** An ISO 8601 duration as milliseconds ("PT15H", "P0M0DT12H0M0S", "-PT2H"); null when it counts months or years. */
export function durationMs(value: string): number | null {
  const m = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    value.trim(),
  );
  if (!m || value.trim() === "P" || value.trim() === "PT") return null;
  if (Number(m[2] ?? 0) !== 0 || Number(m[3] ?? 0) !== 0) return null;
  const ms =
    Number(m[4] ?? 0) * 7 * 86_400_000 +
    Number(m[5] ?? 0) * 86_400_000 +
    Number(m[6] ?? 0) * 3_600_000 +
    Number(m[7] ?? 0) * 60_000 +
    Math.round(Number(m[8] ?? 0) * 1000);
  return m[1] ? -ms : ms;
}

/** A gross amount Mews gives (a decimal number in its currency) as minor units of that currency. */
function minor(value: unknown, currency: string): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const e = minorUnits(currency) ?? 2;
  return minorAmount(String(value), e) ?? Math.round(value * 10 ** e);
}

function localName(names: unknown, language: string): string {
  if (!names || typeof names !== "object") return "";
  const entries = Object.entries(names as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v);
  const lang = language.toLowerCase().slice(0, 2);
  const mine = entries.find(([k]) => k.toLowerCase().startsWith(lang)) ?? entries.find(([k]) => k.startsWith("en"));
  return String((mine ?? entries[0])?.[1] ?? "");
}

/* --- the connector --------------------------------------------------------- */

export function mewsConnector(
  partner: MewsPartner | null | undefined,
  opts: { readonly hosted?: boolean | undefined } = {},
): ConnectorDefinition {
  const clientToken = partner?.clientToken?.trim() ?? "";

  const tokens = (accessToken: string) => ({ ClientToken: clientToken, AccessToken: accessToken, Client: MEWS_CLIENT });

  /** One operation: always a POST of JSON to `/api/connector/v1/<operation>`, its tokens in the body. */
  async function call(
    ctx: Pick<ConnectContext, "http">,
    accessToken: string,
    operation: string,
    body: Json,
  ): Promise<Json> {
    if (!clientToken) throw new ConnectorError("config", "Mews needs a partner token on this server.");
    let res: ConnectorHttpResponse;
    try {
      res = await ctx.http.request({
        method: "POST",
        url: `${MEWS_API}/api/connector/v1/${operation}`,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...tokens(accessToken), ...body }),
        timeoutMs: 20_000,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("unreachable", "Mews could not be reached.");
    }
    const message = () => {
      try {
        return str((JSON.parse(res.text) as Json).Message).slice(0, 300);
      } catch {
        return "";
      }
    };
    if (res.status === 401) {
      throw new ConnectorError(
        "auth",
        "Mews did not take the access token: it was withdrawn, or the integration is off for this property.",
      );
    }
    if (res.status === 429) {
      throw new ConnectorError("rate_limited", "Mews asked to wait before more requests.", {
        retryAfterMs: retryAfterMs(res.headers) ?? 30_000,
      });
    }
    // 403 is a rule Mews applies (a night it has no room for, a reservation it will not change).
    if (res.status === 403 || res.status === 409 || res.status === 400) {
      throw new ConnectorError("refused", message() || "Mews did not take it.");
    }
    if (res.status === 408 || res.status >= 500)
      throw new ConnectorError("unreachable", "Mews is not answering properly.");
    if (res.status === 204) return {};
    if (res.status !== 200) throw new ConnectorError("bad_response", `Mews answered ${res.status}.`);
    try {
      const json = JSON.parse(res.text) as unknown;
      if (!json || typeof json !== "object") throw new Error("not an object");
      return json as Json;
    } catch {
      throw new ConnectorError("bad_response", "Mews answered with something that is not JSON.");
    }
  }

  const run = (ctx: RunContext, operation: string, body: Json) =>
    call(ctx, ctx.secret.access_token ?? "", operation, body);

  /** Every page of a paged operation (a `Cursor` to the next), up to a bound. */
  async function all(ctx: RunContext, operation: string, body: Json, key: string): Promise<Json[]> {
    const out: Json[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const j = await run(ctx, operation, {
        ...body,
        Limitation: { Count: PAGE, ...(cursor ? { Cursor: cursor } : {}) },
      });
      const items = Array.isArray(j[key]) ? (j[key] as Json[]) : [];
      out.push(...items);
      cursor = str(j.Cursor) || null;
      if (!cursor || items.length < PAGE) return out;
    }
    throw new ConnectorError("bad_response", "Mews kept sending pages: the read was stopped.");
  }

  interface Enterprise {
    readonly id: string;
    readonly name: string;
    readonly zone: string;
    readonly currency: string;
    readonly email: string;
    readonly website: string;
    readonly portfolio: boolean;
  }

  function enterpriseOf(j: Json): Enterprise {
    const e = (j.Enterprise ?? {}) as Json;
    const currencies = Array.isArray(e.Currencies) ? (e.Currencies as Json[]) : [];
    const currency = str(
      currencies.find((c) => c.IsDefault === true)?.Currency ?? currencies[0]?.Currency,
    ).toUpperCase();
    const zone = str(e.TimeZoneIdentifier);
    if (!str(e.Id) || !zone) throw new ConnectorError("bad_response", "Mews did not say which property this is.");
    return {
      id: str(e.Id),
      name: str(e.Name) || "Mews property",
      zone,
      currency,
      email: str(e.Email),
      website: str(e.WebsiteUrl),
      portfolio: e.IsPortfolio === true,
    };
  }

  async function zoneOf(ctx: RunContext): Promise<string> {
    const kept = str(ctx.extra.timezone);
    if (kept) return kept;
    return enterpriseOf(await run(ctx, "configuration/get", {})).zone;
  }

  /** A bookable service's own start and end offsets: when a night's stay starts and ends. */
  async function offsetsOf(ctx: RunContext, serviceId: string): Promise<{ start: number; end: number }> {
    const services = await all(ctx, "services/getAll", { ServiceIds: [serviceId] }, "Services");
    const value = ((services.find((s) => s.Id === serviceId)?.Data as Json | undefined)?.Value ?? {}) as Json;
    const start = durationMs(str(value.StartOffset));
    const end = durationMs(str(value.EndOffset));
    if (start === null || end === null)
      throw new ConnectorError("bad_response", "Mews did not say when a stay starts and ends.");
    return { start, end };
  }

  /** When a stay from `checkIn` to `checkOut` starts and ends in Mews: each date's time unit, with the service's offsets. */
  function span(checkIn: string, checkOut: string, zone: string, offsets: { start: number; end: number }) {
    return {
      start: instantOf(checkIn, "00:00", zone) + offsets.start,
      end: instantOf(checkOut, "00:00", zone) + offsets.end,
    };
  }

  async function ageCategories(ctx: RunContext, serviceId: string) {
    const list = await all(
      ctx,
      "ageCategories/getAll",
      { ServiceIds: [serviceId], ActivityStates: ["Active"] },
      "AgeCategories",
    );
    const active = list.filter((a) => a.IsActive !== false);
    const adult = active.find((a) => a.Classification === "Adult");
    if (!adult) throw new ConnectorError("config", "Mews has no adult age category for this service.");
    const children = active.filter((a) => a.Classification === "Child");
    return (adults: number, childrenAges: readonly number[]) => {
      const counts = new Map<string, number>([[str(adult.Id), adults]]);
      for (const age of childrenAges) {
        const fits = children.find(
          (c) =>
            (typeof c.MinimalAge !== "number" || age >= c.MinimalAge) &&
            (typeof c.MaximalAge !== "number" || age <= c.MaximalAge),
        );
        const id = str(fits?.Id ?? adult.Id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return [...counts].filter(([, n]) => n > 0).map(([AgeCategoryId, Count]) => ({ AgeCategoryId, Count }));
    };
  }

  /** Availability by category, night by night, for the nights from `from` (local) for `count` nights. */
  async function availability(
    ctx: RunContext,
    serviceId: string,
    zone: string,
    from: string,
    count: number,
  ): Promise<Map<string, Map<string, number>>> {
    const j = await run(ctx, "services/getAvailability", {
      ServiceId: serviceId,
      FirstTimeUnitStartUtc: iso(instantOf(from, "00:00", zone)),
      LastTimeUnitStartUtc: iso(instantOf(addLocalDays(from, count - 1), "00:00", zone)),
    });
    const starts = Array.isArray(j.TimeUnitStartsUtc) ? (j.TimeUnitStartsUtc as unknown[]).map(str) : [];
    const out = new Map<string, Map<string, number>>();
    for (const c of Array.isArray(j.CategoryAvailabilities) ? (j.CategoryAvailabilities as Json[]) : []) {
      const nights = new Map<string, number>();
      const values = Array.isArray(c.Availabilities) ? (c.Availabilities as unknown[]) : [];
      starts.forEach((s, i) => {
        const at = Date.parse(s);
        const v = values[i];
        if (Number.isFinite(at) && typeof v === "number") nights.set(dateIn(at, zone), v);
      });
      out.set(str(c.CategoryId), nights);
    }
    return out;
  }

  /** The tag a reservation's note carries: our key, and a mark only this inbox can make for it. */
  async function noteTag(ctx: RunContext, stay: OutboundStay): Promise<string> {
    const mark = (await hmacSha256Hex(ctx.marker || ctx.inbox.id, stay.key)).slice(0, 16);
    return `${stay.key}#${mark}`;
  }

  async function reservationsOfGroup(ctx: RunContext, groupId: string): Promise<Json[]> {
    return all(
      ctx,
      "reservations/getAll/2023-06-06",
      { ReservationGroupIds: [groupId], States: [...ALL_STATES] },
      "Reservations",
    );
  }

  /** A customer for the guest: the one Mews has with that email, or a new one. Only for a confirmed stay. */
  async function customerFor(ctx: RunContext, stay: OutboundStay): Promise<string> {
    const guest = stay.guest;
    if (guest?.email) {
      const found = await run(ctx, "customers/getAll", {
        Emails: [guest.email],
        Extent: { Customers: true },
        Limitation: { Count: 1 },
      });
      const id = str((Array.isArray(found.Customers) ? (found.Customers as Json[]) : [])[0]?.Id);
      if (id) return id;
    }
    const parts = (guest?.name ?? "").trim().split(/\s+/).filter(Boolean);
    const last = parts.length > 1 ? (parts.pop() ?? "") : (parts[0] ?? "");
    const added = await run(ctx, "customers/add", {
      // Before the stay is confirmed, the guest's details stay in the inbox: the reservation's customer
      // is named by the stay's reference until then.
      LastName: guest ? last || stay.reference : stay.reference,
      ...(guest && parts.length > 0 ? { FirstName: parts.join(" ") } : guest ? {} : { FirstName: "Guest" }),
      ...(guest?.email ? { Email: guest.email } : {}),
      ...(guest?.phone ? { Phone: guest.phone } : {}),
      OverwriteExisting: false,
    });
    const id = str(added.Id ?? (added.Customer as Json | undefined)?.Id);
    if (!id) throw new ConnectorError("bad_response", "Mews did not say which customer it added.");
    return id;
  }

  /** When Mews lets an unconfirmed reservation go by itself: after the inbox would, never after arrival. */
  function releaseAt(now: number, status: StayWriteStatus, start: number): string {
    const wait = status === "hold" ? MEWS_HOLD_RELEASE_MS : MEWS_PROVISIONAL_RELEASE_MS;
    return iso(Math.max(now + 15 * 60_000, Math.min(now + wait, start - 60_000)));
  }

  async function oversoldNights(ctx: RunContext, stay: OutboundStay): Promise<boolean> {
    const zone = await zoneOf(ctx);
    const nights = daysBetween(stay.checkIn, stay.checkOut);
    if (nights < 1) return false;
    const avail = await availability(ctx, stay.propertyId, zone, stay.checkIn, nights);
    for (const room of stay.rooms) {
      const byNight = avail.get(room.roomId);
      if (!byNight) throw new ConnectorError("bad_response", "Mews did not say what is free for that room.");
      for (let i = 0; i < nights; i++) {
        const v = byNight.get(addLocalDays(stay.checkIn, i));
        if (v === undefined) throw new ConnectorError("bad_response", "Mews did not say what is free on those nights.");
        if (v < 0) return true;
      }
    }
    return false;
  }

  async function ratePlans(ctx: RunContext, serviceId: string): Promise<ExternalRate[]> {
    const rates = await all(
      ctx,
      "rates/getAll",
      {
        ServiceIds: [serviceId],
        ActivityStates: ["Active"],
        Extent: { Rates: true, AvailabilityBlockAssignments: false },
      },
      "Rates",
    );
    // Only rates the property sells to anyone: a private rate needs a voucher this inbox never has.
    return rates
      .filter((r) => r.IsActive !== false && r.IsEnabled !== false && r.IsPublic !== false)
      .map((r) => ({ id: str(r.Id), name: str(r.Name) || str(r.ShortName) || str(r.Id) }));
  }

  async function find(ctx: RunContext, stay: OutboundStay): Promise<LinkState | null> {
    const tag = await noteTag(ctx, stay);
    const made = (
      await all(
        ctx,
        "reservations/getAll/2023-06-06",
        {
          ServiceIds: [stay.propertyId],
          CreatedUtc: { StartUtc: iso(ctx.now - FIND_WINDOW_MS), EndUtc: iso(ctx.now + 3_600_000) },
          States: [...ALL_STATES],
        },
        "Reservations",
      )
    ).filter((r) => r.Origin === undefined || r.Origin === "Connector");
    for (let i = 0; i < made.length; i += PAGE) {
      const ids = made.slice(i, i + PAGE).map((r) => str(r.Id));
      const notes = await all(ctx, "serviceOrderNotes/getAll", { ServiceOrderIds: ids }, "ServiceOrderNotes");
      const mine = notes.find((n) => str(n.Text).split(/\s+/).includes(tag));
      if (mine) {
        const r = made.find((x) => x.Id === mine.OrderId);
        const group = str(r?.GroupId);
        if (group) return { externalId: group, etag: null, calendar: null };
      }
    }
    return null;
  }

  const ready = (): true | string => (clientToken ? true : "Mews needs a partner token on this server");

  return {
    kind: "mews",
    title: "Mews",
    group: "lodging",
    capabilities: ["stay_inventory", "write_stays", "stay_events"],
    auth: "form",
    form: mewsForm,
    note: "Rooms, rates and what's free from Mews; each stay written to Mews before it is confirmed.",
    disconnectNote: "In Mews, the property can also switch this integration off in its Marketplace settings.",
    ready,
    whenNotReady: {
      status: "setup",
      hint: opts.hosted
        ? "Needs a Mews partner account, which this service does not have yet. Until then, use each room's calendar link."
        : "Needs a Mews partner token on this server. Until then, use each room's calendar link.",
      href: DOCS,
    },

    async connect(ctx, input): Promise<Connected> {
      const token = (input.access_token ?? "").trim();
      const e = enterpriseOf(await call(ctx, token, "configuration/get", {}));
      if (e.portfolio) {
        throw new ConnectorError(
          "config",
          "That token covers several properties. Use the token of this property alone.",
          {
            field: "access_token",
          },
        );
      }
      return {
        account: e.name,
        externalId: e.id,
        secret: { access_token: token },
        extra: { enterpriseId: e.id, timezone: e.zone, currency: e.currency },
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
      };
    },

    stays: {
      async properties(ctx): Promise<ExternalProperty[]> {
        const e = enterpriseOf(await run(ctx, "configuration/get", {}));
        const services = await all(ctx, "services/getAll", {}, "Services");
        const nightly = services.filter((s) => {
          const data = (s.Data ?? {}) as Json;
          const value = (data.Value ?? {}) as Json;
          return (
            s.IsActive !== false &&
            data.Discriminator === "Bookable" &&
            (value.TimeUnitPeriod ?? value.TimeUnit) === "Day"
          );
        });
        return nightly.map((s) => ({
          id: str(s.Id),
          name: nightly.length > 1 ? `${e.name} · ${localName(s.Names, ctx.inbox.language) || str(s.Name)}` : e.name,
          currency: e.currency,
          timezone: e.zone,
        }));
      },

      async rooms(ctx, serviceId): Promise<ExternalRoom[]> {
        const categories = (
          await all(
            ctx,
            "resourceCategories/getAll",
            { ServiceIds: [serviceId], ActivityStates: ["Active"] },
            "ResourceCategories",
          )
        ).filter((c) => c.IsActive !== false && (c.ServiceId === undefined || c.ServiceId === serviceId));
        if (categories.length === 0) return [];
        const assignments = await all(
          ctx,
          "resourceCategoryAssignments/getAll",
          { ResourceCategoryIds: categories.map((c) => str(c.Id)), ActivityStates: ["Active"] },
          "ResourceCategoryAssignments",
        );
        const units = new Map<string, number>();
        for (const a of assignments) {
          if (a.IsActive === false) continue;
          units.set(str(a.CategoryId), (units.get(str(a.CategoryId)) ?? 0) + 1);
        }
        return categories.map((c) => {
          const adults = typeof c.Capacity === "number" ? c.Capacity : 0;
          const extra = typeof c.ExtraCapacity === "number" ? c.ExtraCapacity : 0;
          return {
            id: str(c.Id),
            name: localName(c.Names, ctx.inbox.language) || str(c.Id),
            units: units.get(str(c.Id)) ?? 0,
            ...(adults > 0 ? { capacity: { adults, children: extra, total: adults + extra } } : {}),
          };
        });
      },

      ratePlans,

      async ari(ctx, serviceId, window) {
        const zone = await zoneOf(ctx);
        const total = daysBetween(window.from, window.to);
        if (total < 1) return [];
        const count = Math.min(total, MAX_NIGHTS);
        const avail = await availability(ctx, serviceId, zone, window.from, count);
        const rows = new Map<
          string,
          { roomId: string; night: string; units: number; prices: Record<string, number> }
        >();
        for (const [roomId, nights] of avail) {
          for (const [night, units] of nights) rows.set(`${roomId}|${night}`, { roomId, night, units, prices: {} });
        }
        const first = iso(instantOf(window.from, "00:00", zone));
        const last = iso(instantOf(addLocalDays(window.from, count - 1), "00:00", zone));
        for (const rate of await ratePlans(ctx, serviceId)) {
          const j = await run(ctx, "rates/getPricing", {
            RateId: rate.id,
            FirstTimeUnitStartUtc: first,
            LastTimeUnitStartUtc: last,
          });
          const starts = Array.isArray(j.TimeUnitStartsUtc) ? (j.TimeUnitStartsUtc as unknown[]).map(str) : [];
          for (const c of Array.isArray(j.CategoryPrices) ? (j.CategoryPrices as Json[]) : []) {
            const prices = Array.isArray(c.AmountPrices) ? (c.AmountPrices as Json[]) : [];
            starts.forEach((s, i) => {
              const at = Date.parse(s);
              const p = prices[i];
              if (!Number.isFinite(at) || !p) return;
              const row = rows.get(`${str(c.CategoryId)}|${dateIn(at, zone)}`);
              const amount = minor(p.GrossValue, str(p.Currency) || str(j.Currency));
              if (row && amount !== null) row.prices[rate.id] = amount;
            });
          }
        }
        const out: AriRow[] = [...rows.values()]
          .filter((r) => r.night >= window.from && r.night < window.to)
          .map((r) => ({ roomId: r.roomId, night: r.night, units: r.units, prices: r.prices }));
        return count < total ? { rows: out, until: addLocalDays(window.from, count) } : out;
      },

      async price(ctx, q) {
        if (!q.rateId) return null;
        const zone = await zoneOf(ctx);
        const offsets = await offsetsOf(ctx, q.propertyId);
        const people = await ageCategories(ctx, q.propertyId);
        const when = span(q.checkIn, q.checkOut, zone, offsets);
        const j = await run(ctx, "reservations/price", {
          ServiceId: q.propertyId,
          Reservations: [
            {
              Identifier: "1",
              StartUtc: iso(when.start),
              EndUtc: iso(when.end),
              RequestedCategoryId: q.roomId,
              RateId: q.rateId,
              PersonCounts: people(q.adults, q.childrenAges),
            },
          ],
        });
        const priced = (Array.isArray(j.ReservationPrices) ? (j.ReservationPrices as Json[]) : [])[0];
        const amount = (priced?.TotalAmount ?? priced?.Total) as Json | undefined;
        const currency = str(amount?.Currency).toUpperCase();
        const value = minor(amount?.GrossValue, currency);
        return value === null || !currency ? null : { subtotal: { value, currency } };
      },
    },

    stayWriter: {
      async put(ctx, stay, link, status): Promise<LinkState> {
        const zone = await zoneOf(ctx);
        const offsets = await offsetsOf(ctx, stay.propertyId);
        const when = span(stay.checkIn, stay.checkOut, zone, offsets);
        if (link?.externalId) return move(ctx, stay, link, status, when);
        // Mews takes no key of ours: a stay already written under this key is the one answered.
        const found = await find(ctx, stay);
        if (found) return found;
        const people = await ageCategories(ctx, stay.propertyId);
        const customer = await customerFor(ctx, status === "confirmed" ? stay : { ...stay, guest: undefined });
        const tag = await noteTag(ctx, stay);
        const confirmed = status === "confirmed";
        const j = await run(ctx, "reservations/add", {
          ServiceId: stay.propertyId,
          CheckOverbooking: true,
          CheckRateApplicability: true,
          SendConfirmationEmail: false,
          Reservations: stay.rooms.map((room, i) => ({
            Identifier: String(i + 1),
            State: confirmed ? "Confirmed" : "Optional",
            StartUtc: iso(when.start),
            EndUtc: iso(when.end),
            ...(confirmed ? {} : { ReleasedUtc: releaseAt(ctx.now, status, when.start) }),
            CustomerId: customer,
            RequestedCategoryId: room.roomId,
            ...(room.rateId ? { RateId: room.rateId } : {}),
            PersonCounts: people(room.adults, room.childrenAges),
            Notes: `Inbox stay ${stay.reference} · ${tag}`,
          })),
        });
        const added = (Array.isArray(j.Reservations) ? (j.Reservations as Json[]) : [])
          .map((r) => (r.Reservation ?? {}) as Json)
          .filter((r) => str(r.Id));
        const group = str(added[0]?.GroupId);
        if (!group || added.length !== stay.rooms.length) {
          throw new ConnectorError("bad_response", "Mews did not say which reservations it made.");
        }
        return { externalId: group, etag: null, calendar: null, start: when.start, end: when.end };
      },

      async cancel(ctx, link) {
        if (!link.externalId) return;
        const live = (await reservationsOfGroup(ctx, link.externalId)).filter((r) => LIVE_STATES.has(str(r.State)));
        if (live.length === 0) return;
        await run(ctx, "reservations/cancel", {
          ReservationIds: live.map((r) => str(r.Id)),
          PostCancellationFee: false,
          SendEmail: false,
          Notes: "Cancelled from the property's inbox",
        });
      },

      find,

      async oversold(ctx, stay) {
        return oversoldNights(ctx, stay);
      },
    },

    hooks: {
      topics: MEWS_EVENTS,
      async verify(ctx, request) {
        const expected = partner?.webhookToken ?? "";
        const given = request.query.get("token") ?? "";
        if (!expected || !constantTimeEqual(given, expected)) {
          throw new ConnectorError("refused", "The webhook's secret does not check out.");
        }
        let body: Json;
        try {
          body = JSON.parse(request.body) as Json;
        } catch {
          throw new ConnectorError("refused", "The webhook is not JSON.");
        }
        const enterprise = str(ctx.extra.enterpriseId);
        if (!enterprise || !constantTimeEqual(str(body.EnterpriseId), enterprise)) {
          throw new ConnectorError("refused", "The webhook is about another property.");
        }
        const refs = (Array.isArray(body.Events) ? (body.Events as Json[]) : [])
          .filter((e) => e.Discriminator === "ServiceOrderUpdated")
          .map((e) => str((e.Value as Json | undefined)?.Id))
          .filter((id) => /^[A-Za-z0-9-]{1,100}$/.test(id));
        if (refs.length === 0) return null;
        const digest = await sha256Hex(new TextEncoder().encode(request.body));
        return {
          eventId: `mews-${digest.slice(0, 40)}`,
          topic: "ServiceOrderUpdated",
          refs: [...new Set(refs)].slice(0, 100),
        };
      },
      async read(ctx, event): Promise<HookFact[]> {
        const zone = await zoneOf(ctx);
        const found = await all(
          ctx,
          "reservations/getAll/2023-06-06",
          { ReservationIds: event.refs.slice(0, PAGE), States: [...ALL_STATES] },
          "Reservations",
        );
        const out: HookFact[] = [];
        for (const r of found) {
          const start = Date.parse(str(r.ScheduledStartUtc ?? r.StartUtc));
          const end = Date.parse(str(r.ScheduledEndUtc ?? r.EndUtc));
          if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
          const from = dateIn(start, zone);
          const last = dateIn(end, zone);
          const to = last > from ? last : addLocalDays(from, 1);
          const room = str(r.RequestedResourceCategoryId ?? r.RequestedCategoryId);
          out.push({ kind: "stay_nights", ...(room ? { roomIds: [room] } : {}), from, to });
        }
        return out;
      },
    },
  };

  /** A stay written already, moved to these nights and rooms, and confirmed when it is. */
  async function move(
    ctx: RunContext,
    stay: OutboundStay,
    link: LinkState,
    status: StayWriteStatus,
    when: { start: number; end: number },
  ): Promise<LinkState> {
    const group = link.externalId ?? "";
    const current = (await reservationsOfGroup(ctx, group)).filter((r) => LIVE_STATES.has(str(r.State)));
    if (current.length === 0) throw new ConnectorError("not_found", "That stay is not in Mews any more.");
    if (current.length !== stay.rooms.length) {
      throw new ConnectorError("refused", "The stay has another number of rooms in Mews: change it there.");
    }
    const people = await ageCategories(ctx, stay.propertyId);
    const before = current.map((r) => ({
      ReservationId: str(r.Id),
      StartUtc: { Value: str(r.ScheduledStartUtc ?? r.StartUtc) },
      EndUtc: { Value: str(r.ScheduledEndUtc ?? r.EndUtc) },
      RequestedCategoryId: { Value: str(r.RequestedResourceCategoryId ?? r.RequestedCategoryId) },
    }));
    const changed = current.some(
      (r, i) =>
        Date.parse(str(r.ScheduledStartUtc ?? r.StartUtc)) !== when.start ||
        Date.parse(str(r.ScheduledEndUtc ?? r.EndUtc)) !== when.end ||
        str(r.RequestedResourceCategoryId ?? r.RequestedCategoryId) !== stay.rooms[i]?.roomId,
    );
    if (changed) {
      await run(ctx, "reservations/update", {
        Reprice: true,
        ApplyCancellationFee: false,
        Reason: "Changed from the property's inbox",
        ReservationUpdates: current.map((r, i) => {
          const room = stay.rooms[i];
          return {
            ReservationId: str(r.Id),
            StartUtc: { Value: iso(when.start) },
            EndUtc: { Value: iso(when.end) },
            ...(room ? { RequestedCategoryId: { Value: room.roomId } } : {}),
            ...(room?.rateId ? { RateId: { Value: room.rateId } } : {}),
            ...(room ? { PersonCounts: { Value: people(room.adults, room.childrenAges) } } : {}),
          };
        }),
      });
      // Mews documents no overbooking check on an update: the nights are read again, and a move that
      // left one below none is put back as it was, and refused.
      let over: boolean;
      try {
        over = await oversoldNights(ctx, stay);
      } catch {
        over = true;
      }
      if (over) {
        await run(ctx, "reservations/update", {
          Reprice: true,
          ApplyCancellationFee: false,
          Reason: "Put back by the property's inbox",
          ReservationUpdates: before,
        });
        throw new ConnectorError("refused", "Mews has no room for those nights.");
      }
    }
    if (status === "confirmed") {
      const optional = current.filter((r) => r.State === "Optional").map((r) => str(r.Id));
      if (optional.length > 0) {
        await run(ctx, "reservations/confirm", { ReservationIds: optional, SendConfirmationEmail: false });
      }
      if (stay.guest) {
        const customer = await customerFor(ctx, stay);
        for (const r of current) {
          if (str(r.AccountId ?? r.CustomerId) === customer) continue;
          await run(ctx, "reservations/updateCustomer", { ReservationId: str(r.Id), CustomerId: customer });
        }
      }
    }
    return { externalId: group, etag: null, calendar: null, start: when.start, end: when.end };
  }
}
