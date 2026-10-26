import {
  type BookingWriter,
  type BusyRead,
  ConnectorError,
  type Interval,
  type LinkState,
  mergeIntervals,
  type OutboundBooking,
  type RunContext,
  subtractIntervals,
} from "@surfingdog/core";
import { extraOf, locationOf, type ServiceInfo, servicesAt, teamOf, writeLevel } from "./account";
import { arr, iso, msOf, obj, refusal, type SquareApi, sha256, str, why } from "./api";

/**
 * Square Appointments for the inbox (ADR-034): busy times from what Square says is free, and the
 * bookings the inbox confirms written into Square.
 *
 * **Busy times.** Square's own answer to "when is this service free" (`SearchAvailability`) already
 * leaves out every booking, the hours, time off and each team member's own schedule, whichever way the
 * connection came in, so the times Square would not take are every time no available slot covers. It
 * is read for one service Square books at the location (`probeOf`), for the team member the owner
 * chose or whoever is free, 31 days at a time as Square asks.
 *
 * **Bookings.** Square takes them from an access token on Appointments Plus or Premium (it acts as the
 * seller), and from Sign in with Square on every plan (it books as a customer); an access token on the
 * free plan writes none (`writeLevel`). A booking is an availability plus a customer: the team member
 * is the one Square says is free at that time. Square texts and emails the customer of a booking it is
 * given through its API, and asks every customer for a phone number. So each customer of the inbox has
 * a customer record of its own in Square, under their name and the location's own phone number, with
 * no email: the salon's calendar shows who is coming, Square's messages reach the business, and the
 * inbox, which has already told the customer, stays the only one that does.
 *
 * - https://developer.squareup.com/docs/bookings-api/what-it-is
 * - https://developer.squareup.com/docs/bookings-api/use-the-api
 * - https://developer.squareup.com/forums/t/suppress-customer-notification-flag-to-bookings-api/25709
 */

const DAY = 86_400_000;
/** Square's window for `SearchAvailability`: at least a day, at most 31 days. */
const MAX_SEARCH = 31 * DAY;
/** Windows of 31 days read in one sync, at most: 93 days, the inbox's whole way ahead. */
const MAX_SEARCHES = 3;
/** A month of half-hour slots for a large team is a few megabytes. */
const AVAILABILITY_BYTES = 8 * 1024 * 1024;
const CANCELLED = new Set(["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED", "NO_SHOW"]);

type Api = (ctx: RunContext) => Promise<SquareApi>;

interface Slot {
  readonly start: number;
  readonly end: number;
  readonly team: string;
  readonly service: string;
  readonly version: number;
}

/** What Square says is free for a service at a location, from `start` to `end` (at least a day). */
async function availability(
  api: SquareApi,
  q: { location: string; service: string; team: string | null; start: number; end: number },
): Promise<Slot[]> {
  const a = await api.call(
    "POST",
    "/v2/bookings/availability/search",
    {
      query: {
        filter: {
          start_at_range: { start_at: iso(q.start), end_at: iso(Math.max(q.end, q.start + DAY)) },
          location_id: q.location,
          segment_filters: [
            { service_variation_id: q.service, ...(q.team ? { team_member_id_filter: { any: [q.team] } } : {}) },
          ],
        },
      },
    },
    { maxBytes: AVAILABILITY_BYTES, timeoutMs: 25_000 },
  );
  if (a.status !== 200) throw refusal(a, "say when your services are free");
  const out: Slot[] = [];
  for (const av of arr(a.json.availabilities)) {
    const start = msOf(av.start_at);
    const segments = arr(av.appointment_segments);
    const minutes = segments.reduce((sum, s) => sum + Number(s.duration_minutes ?? 0), 0);
    const first = segments[0];
    if (!Number.isFinite(start) || !(minutes > 0) || !first) continue;
    out.push({
      start,
      end: start + minutes * 60_000,
      team: String(first.team_member_id ?? ""),
      service: String(first.service_variation_id ?? q.service),
      version: Number(first.service_variation_version ?? 0),
    });
  }
  return out;
}

/**
 * The service busy times are read for. For one team member, the shortest they take, which fits in any
 * gap of theirs. For whoever is free, the one most of the team take (anyone, when Square does not say),
 * the shortest of those: a service only one person takes would show their day as everyone's.
 */
function probeOf(services: readonly ServiceInfo[], team: string | null): ServiceInfo | null {
  const reach = (s: ServiceInfo) => (team !== null || s.team === null ? Number.POSITIVE_INFINITY : s.team.length);
  return [...services].sort((a, b) => reach(b) - reach(a) || a.minutes - b.minutes)[0] ?? null;
}

/** Busy times: whatever Square would not book, from now to the end of the window (or as far as was read). */
export async function busy(apiOf: Api, ctx: RunContext, window: Interval): Promise<Interval[] | BusyRead> {
  const x = extraOf(ctx);
  // No Square Appointments here: Square holds no bookings, so it makes nothing busy.
  if (!x.booking.enabled) return [];
  const location = locationOf(ctx);
  const team = teamOf(ctx);
  const probe = probeOf(servicesAt(x, location, team), team);
  if (!probe) return [];
  const api = await apiOf(ctx);
  // What is past is no time anyone books.
  const from = Math.max(window.start, Math.ceil(ctx.now / 60_000) * 60_000);
  const free: Interval[] = [];
  let at = from;
  for (let n = 0; n < MAX_SEARCHES && at < window.end; n++) {
    const end = Math.min(at + MAX_SEARCH, window.end);
    for (const s of await availability(api, { location, service: probe.id, team, start: at, end })) {
      free.push({ start: s.start, end: s.end });
    }
    at = end;
  }
  const read: Interval = { start: from, end: at };
  const gaps = complement(mergeIntervals(free, read), read);
  // This inbox's own bookings are in Square too: they never block the times they hold.
  const intervals = mergeIntervals(subtractIntervals(gaps, ctx.own.spans), window);
  return at >= window.end ? intervals : { intervals, until: at };
}

/** What a window holds that the (merged, sorted) intervals do not. */
function complement(merged: readonly Interval[], window: Interval): Interval[] {
  const out: Interval[] = [];
  let at = window.start;
  for (const i of merged) {
    if (i.start > at) out.push({ start: at, end: i.start });
    at = Math.max(at, i.end);
  }
  if (at < window.end) out.push({ start: at, end: window.end });
  return out;
}

/** The Square service a booking is written on: the one of the same name and length, never a guess. */
function serviceFor(ctx: RunContext, booking: OutboundBooking, location: string, team: string | null): ServiceInfo {
  const here = servicesAt(extraOf(ctx), location, team);
  const long = here.filter((s) => s.minutes === booking.durationMin);
  const name = booking.serviceName.trim().toLowerCase();
  const named =
    long.find((s) => s.name.toLowerCase() === name) ?? long.find((s) => s.name.toLowerCase().startsWith(`${name} · `));
  if (named) return named;
  if (long.length === 1 && long[0]) return long[0];
  if (long.length === 0) {
    throw new ConnectorError(
      "refused",
      `No Square service here is ${booking.durationMin} minutes long. Add one in Square.`,
    );
  }
  throw new ConnectorError(
    "refused",
    `Several Square services are ${booking.durationMin} minutes long. In Square, name one ${booking.serviceName}, as it is here.`,
  );
}

/** Who Square says is free for the service at exactly this time (the given team member, or anyone). */
async function slotAt(
  api: SquareApi,
  q: { location: string; service: ServiceInfo; team: string | null; start: number },
): Promise<Slot | null> {
  const slots = await availability(api, {
    location: q.location,
    service: q.service.id,
    team: q.team,
    start: q.start - DAY / 2,
    end: q.start + DAY / 2,
  });
  return (
    slots.find((s) => s.start === q.start && s.service === q.service.id && (q.team === null || s.team === q.team)) ??
    null
  );
}

/** The note on a booking: who it is for and where it is in the inbox, never the customer's contact details. */
function noteOf(booking: OutboundBooking): string {
  return `${booking.title}\n${booking.description}`.slice(0, 4_000);
}

/** The name a booking's customer record carries: the customer's, whole (names are not split by guess). */
function nameOf(booking: OutboundBooking): string | null {
  const n = booking.customerName?.trim();
  return n ? n.slice(0, 300) : null;
}

/**
 * The customer record of a booking's customer at a location: found by a reference only this inbox can
 * make, of the customer's name, and made when `make` says so, with that name, the location's own phone
 * number and no email. A customer who was erased is one record, "Inbox booking", for all of them.
 */
async function customerOf(
  api: SquareApi,
  ctx: RunContext,
  booking: OutboundBooking,
  location: string,
  make: boolean,
): Promise<string | null> {
  const name = nameOf(booking);
  const reference = `inbox-${(await sha256(`${ctx.marker}:customer:${location}:${name?.toLowerCase() ?? ""}`)).slice(0, 24)}`;
  const found = await api.must("POST", "/v2/customers/search", "look up the booking's customer", {
    query: { filter: { reference_id: { exact: reference } } },
    limit: 1,
  });
  const id = str(arr(found.customers)[0]?.id);
  if (id || !make) return id;
  const phone = extraOf(ctx).locations[location]?.phone;
  if (!phone) {
    throw new ConnectorError(
      "refused",
      "Square needs a phone number for bookings. Add your business's number to this location in Square (Dashboard → Locations), then confirm again.",
    );
  }
  const made = await api.must("POST", "/v2/customers", "add the booking's customer", {
    // A day's retries make one record; one deleted in Square is made again the next day.
    idempotency_key: `${reference}:${Math.floor(ctx.now / DAY)}`,
    given_name: name ?? "Inbox booking",
    phone_number: phone,
    reference_id: reference,
    note: "Made by your inbox for its bookings, under your location's own phone number, so Square's texts about them reach you and not your customer.",
  });
  const madeId = str(obj(made.customer).id);
  if (!madeId) throw new ConnectorError("bad_response", "Square did not say which customer record it made.");
  return madeId;
}

/** A booking as Square has it now, or null when it is gone. */
async function bookingOf(api: SquareApi, id: string): Promise<Record<string, unknown> | null> {
  const a = await api.call("GET", `/v2/bookings/${encodeURIComponent(id)}`);
  if (a.status === 404) return null;
  if (a.status !== 200) throw refusal(a, "read a booking");
  return obj(a.json.booking);
}

/** An idempotency key for one write, of this account's marker and what is written. */
async function keyOf(ctx: RunContext, ...parts: readonly (string | number)[]): Promise<string> {
  return `sdi-${(await sha256([ctx.marker, ...parts].join(":"))).slice(0, 40)}`;
}

/** How bookings are written for this connection; never called when Square takes none (the base withholds it). */
function levelOf(ctx: RunContext): "seller" | "buyer" {
  const level = writeLevel(extraOf(ctx));
  if (!level) {
    throw new ConnectorError(
      "refused",
      "Square adds bookings from an access token on Appointments Plus or Premium only. Busy times still come from Square.",
    );
  }
  return level;
}

export function bookingWriter(apiOf: Api): BookingWriter {
  const linkOf = (b: Record<string, unknown>, service: string, booking: OutboundBooking): LinkState => {
    const id = str(b.id);
    if (!id) throw new ConnectorError("bad_response", "Square did not say which booking it made.");
    return { externalId: id, etag: null, calendar: service, start: booking.start, end: booking.end };
  };

  /** Cancels a booking: null when it is gone, or was gone already; Square's words when it would not. */
  const cancel = async (api: SquareApi, ctx: RunContext, id: string): Promise<string | null> => {
    const now = await bookingOf(api, id);
    if (!now || CANCELLED.has(String(now.status))) return null;
    const a = await api.call("POST", `/v2/bookings/${encodeURIComponent(id)}/cancel`, {
      idempotency_key: await keyOf(ctx, "cancel", id, Number(now.version ?? 0)),
      booking_version: Number(now.version ?? 0),
    });
    if (a.status === 200 || a.status === 404) return null;
    if (a.status === 403) throw refusal(a, "cancel bookings");
    return why(a.errors).replace(/\.$/, "") || "Square said no";
  };

  const create = async (
    api: SquareApi,
    ctx: RunContext,
    booking: OutboundBooking,
    replacing: string | null = null,
  ): Promise<LinkState> => {
    const seller = levelOf(ctx) === "seller";
    const location = locationOf(ctx);
    const team = teamOf(ctx);
    const service = serviceFor(ctx, booking, location, team);
    const slot = await slotAt(api, { location, service, team, start: booking.start });
    if (!slot) throw notFree(ctx, service, booking);
    const customer = await customerOf(api, ctx, booking, location, true);
    const a = await api.call("POST", "/v2/bookings", {
      // Of the booking it replaces too: a booking moved back to a time it once had is a new one.
      idempotency_key: await keyOf(ctx, "booking", booking.itemId, booking.start, service.id, replacing ?? "first"),
      booking: {
        start_at: iso(booking.start),
        location_id: location,
        customer_id: customer,
        // As the seller, a note the client never sees; as a customer, the customer's own note, which
        // goes to the business's number like the rest (Square reads `seller_note` from a seller only).
        ...(seller ? { seller_note: noteOf(booking) } : { customer_note: noteOf(booking) }),
        appointment_segments: [
          {
            service_variation_id: service.id,
            service_variation_version: slot.version || service.version,
            team_member_id: slot.team,
            // Read-only to an app that books as a customer: the service's own length then.
            ...(seller ? { duration_minutes: service.minutes } : {}),
          },
        ],
      },
    });
    if (a.status !== 200) throw refusal(a, "take this booking");
    return linkOf(obj(a.json.booking), service.id, booking);
  };

  return {
    async put(ctx, booking, link) {
      const api = await apiOf(ctx);
      if (!link?.externalId) return create(api, ctx, booking);
      const sameTimes = link.start === booking.start && link.end === booking.end;
      const now = await bookingOf(api, link.externalId);
      if (!now || CANCELLED.has(String(now.status))) return create(api, ctx, booking, link.externalId);
      if (sameTimes) return link;
      const location = locationOf(ctx);
      const service = serviceFor(ctx, booking, location, teamOf(ctx));
      const segment = arr(now.appointment_segments)[0];
      const member = str(segment?.team_member_id);
      // The same service, and its team member free at the new time as Square says (Square does not
      // check for an app that moves a booking): moved in place. Anything else is a booking of its own,
      // since an app that books as a customer cannot change a booking's service or team member.
      if (member && segment?.service_variation_id === service.id) {
        const free = await slotAt(api, { location, service, team: member, start: booking.start });
        if (free) {
          const a = await api.call("PUT", `/v2/bookings/${encodeURIComponent(link.externalId)}`, {
            idempotency_key: await keyOf(ctx, "move", link.externalId, booking.start, Number(now.version ?? 0)),
            booking: { version: Number(now.version ?? 0), start_at: iso(booking.start) },
          });
          if (a.status === 200) return linkOf(obj(a.json.booking), service.id, booking);
          if (a.status !== 400 && a.status !== 409 && a.status !== 422) throw refusal(a, "move this booking");
        }
      }
      // Made first, so the old one goes only once the new one is in place.
      const made = await create(api, ctx, booking, link.externalId);
      const refused = await cancel(api, ctx, link.externalId);
      if (refused === null) return made;
      // The old one stays (its cancellation window has closed, say): the new one goes again, so one
      // booking of the inbox never holds two times in Square. Should that fail too, the new one is
      // kept and named, and the old one is the owner's to cancel in Square.
      if ((await cancel(api, ctx, String(made.externalId)).catch(() => "kept")) !== null) return made;
      throw new ConnectorError("refused", `Square would not let the old time go: ${refused}. Move it in Square.`);
    },

    async remove(ctx, link) {
      if (!link.externalId) return;
      const refused = await cancel(await apiOf(ctx), ctx, link.externalId);
      if (refused !== null)
        throw new ConnectorError("refused", `Square would not cancel it: ${refused}. Cancel it in Square.`);
    },

    /**
     * A booking this inbox made and kept no id for: one for this customer's record, at the booking's
     * start, on a service it would be written on. A booking anyone else made is never on that record.
     */
    async find(ctx, booking) {
      const api = await apiOf(ctx);
      const location = locationOf(ctx);
      const customer = await customerOf(api, ctx, booking, location, false);
      if (!customer) return null;
      const q = new URLSearchParams({
        location_id: location,
        customer_id: customer,
        start_at_min: iso(booking.start - 60_000),
        start_at_max: iso(booking.start + 60_000),
        limit: "50",
      });
      const listed = await api.must("GET", `/v2/bookings?${q}`, "list the inbox's bookings");
      const services = new Set(servicesAt(extraOf(ctx), location, null).map((s) => s.id));
      const found = arr(listed.bookings).find(
        (b) =>
          msOf(b.start_at) === booking.start &&
          b.customer_id === customer &&
          !CANCELLED.has(String(b.status)) &&
          services.has(String(arr(b.appointment_segments)[0]?.service_variation_id)),
      );
      if (!found) return null;
      return linkOf(found, String(arr(found.appointment_segments)[0]?.service_variation_id ?? ""), booking);
    },
  };
}

function notFree(ctx: RunContext, service: ServiceInfo, booking: OutboundBooking): ConnectorError {
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: ctx.inbox.timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(booking.start));
  return new ConnectorError(
    "refused",
    `Square has nobody free for ${service.name} at ${when}. Check the hours and the team's schedule in Square.`,
  );
}
