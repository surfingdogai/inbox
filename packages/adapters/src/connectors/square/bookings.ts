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
import { AUTO, extraOf, locationOf, type ServiceInfo, servicesAt, teamOf } from "./account";
import { arr, iso, msOf, obj, refusal, type SquareApi, sha256, str, why } from "./api";

/**
 * Square Appointments for the inbox (ADR-029): busy times from what Square says is free, and the
 * bookings the inbox confirms written into Square.
 *
 * **Busy times.** On the free plan, Square shows an app only the bookings the app made, so the times
 * Square would not take are read from its own answer to "when is this service free"
 * (`SearchAvailability`): every time no available slot covers is busy. The answer already leaves out
 * other bookings, the hours, time off and each team member's own schedule. It is read for the service
 * bookings go to (the shortest one when the inbox matches by service), for the team member the owner
 * chose or whoever is free, 31 days at a time as Square asks.
 *
 * **Bookings.** A booking is an availability plus a customer: the team member is the one Square says
 * is free at that time. Square texts and emails the customer of a booking it is given through its API,
 * and asks every customer for a phone number. So the customer of every booking the inbox writes is one
 * customer record per location that stands for the inbox, with the location's own phone number and no
 * email: Square's messages reach the business, and the inbox, which has already told the customer, stays
 * the only one that does. The booking names who it is for in its note.
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

/** The service busy times are read for: the one bookings go to, or the shortest one Square books here. */
function probeOf(ctx: RunContext, services: readonly ServiceInfo[]): ServiceInfo | null {
  const chosen = ctx.destination && ctx.destination !== AUTO ? services.find((s) => s.id === ctx.destination) : null;
  if (chosen) return chosen;
  return [...services].sort((a, b) => a.minutes - b.minutes)[0] ?? null;
}

/** Busy times: whatever Square would not book, from now to the end of the window (or as far as was read). */
export async function busy(apiOf: Api, ctx: RunContext, window: Interval): Promise<Interval[] | BusyRead> {
  const x = extraOf(ctx);
  // No Square Appointments here: Square holds no bookings, so it makes nothing busy.
  if (!x.booking.enabled) return [];
  const location = locationOf(ctx);
  const team = teamOf(ctx);
  const probe = probeOf(ctx, servicesAt(x, location, team));
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

/** The Square service a booking is written on: the one the owner chose, or the one of the same name and length. */
function serviceFor(ctx: RunContext, booking: OutboundBooking, location: string, team: string | null): ServiceInfo {
  const x = extraOf(ctx);
  const here = servicesAt(x, location, team);
  if (ctx.destination && ctx.destination !== AUTO) {
    const chosen = here.find((s) => s.id === ctx.destination);
    if (!chosen) {
      throw new ConnectorError(
        "refused",
        "The Square service chosen for bookings is not booked at this location any more. Choose another here.",
      );
    }
    if (chosen.minutes !== booking.durationMin) {
      throw new ConnectorError(
        "refused",
        `${chosen.name} is ${chosen.minutes} minutes in Square, and this booking is ${booking.durationMin}. Choose another service here.`,
      );
    }
    return chosen;
  }
  const long = here.filter((s) => s.minutes === booking.durationMin);
  const name = booking.serviceName.trim().toLowerCase();
  const named =
    long.find((s) => s.name.toLowerCase() === name) ?? long.find((s) => s.name.toLowerCase().startsWith(`${name} · `));
  if (named) return named;
  if (long.length === 1 && long[0]) return long[0];
  if (long.length === 0) {
    throw new ConnectorError(
      "refused",
      `No Square service here is ${booking.durationMin} minutes long. Add one in Square, or choose one here.`,
    );
  }
  throw new ConnectorError(
    "refused",
    `Several Square services are ${booking.durationMin} minutes long. Choose one here, or name ${booking.serviceName} the same in both.`,
  );
}

/** Who Square says is free for the service at exactly this time: the team member to book. */
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
  return slots.find((s) => s.start === q.start && s.service === q.service.id) ?? null;
}

/** The note on a booking: who it is for and where it is in the inbox, never the customer's contact details. */
function noteOf(booking: OutboundBooking): string {
  return `${booking.title}\n${booking.description}`.slice(0, 4_000);
}

/**
 * The customer record that stands for the inbox at a location: found by a reference only this inbox can
 * make, and made when `make` says so, with the location's own phone number and no email.
 */
async function holderOf(api: SquareApi, ctx: RunContext, location: string, make: boolean): Promise<string | null> {
  const reference = `inbox-${(await sha256(`${ctx.marker}:holder:${location}`)).slice(0, 24)}`;
  const found = await api.must("POST", "/v2/customers/search", "look up the inbox's bookings", {
    query: { filter: { reference_id: { exact: reference } } },
    limit: 1,
  });
  const id = str(arr(found.customers)[0]?.id);
  if (id || !make) return id;
  const phone = extraOf(ctx).locations[location]?.phone;
  if (!phone) {
    throw new ConnectorError(
      "refused",
      "Square needs a phone number on every booking. Add your phone number to this location in Square (your Square Dashboard, under Locations): this inbox puts it on the bookings it makes, so Square's texts reach you, never your customer.",
    );
  }
  const made = await api.must("POST", "/v2/customers", "keep the inbox's bookings together", {
    idempotency_key: reference,
    given_name: "Inbox",
    family_name: "bookings",
    company_name: ctx.inbox.name.slice(0, 100),
    phone_number: phone,
    reference_id: reference,
    note: "Holds the bookings your own inbox makes, under your own phone number, so Square's texts about them reach you and not your customer. Each booking's note says who it is for.",
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

export function bookingWriter(apiOf: Api): BookingWriter {
  const linkOf = (b: Record<string, unknown>, service: string, booking: OutboundBooking): LinkState => {
    const id = str(b.id);
    if (!id) throw new ConnectorError("bad_response", "Square did not say which booking it made.");
    return { externalId: id, etag: null, calendar: service, start: booking.start, end: booking.end };
  };

  const cancel = async (api: SquareApi, ctx: RunContext, id: string): Promise<void> => {
    const now = await bookingOf(api, id);
    if (!now || CANCELLED.has(String(now.status))) return;
    const a = await api.call("POST", `/v2/bookings/${encodeURIComponent(id)}/cancel`, {
      idempotency_key: await keyOf(ctx, "cancel", id, Number(now.version ?? 0)),
      booking_version: Number(now.version ?? 0),
    });
    if (a.status === 200 || a.status === 404) return;
    const detail = why(a.errors);
    throw new ConnectorError(
      "refused",
      `Square would not cancel it${detail ? `: ${detail.replace(/\.$/, "")}` : ""}. Cancel it in Square.`,
    );
  };

  const create = async (
    api: SquareApi,
    ctx: RunContext,
    booking: OutboundBooking,
    replacing: string | null = null,
  ): Promise<LinkState> => {
    const location = locationOf(ctx);
    const team = teamOf(ctx);
    const service = serviceFor(ctx, booking, location, team);
    const slot = await slotAt(api, { location, service, team, start: booking.start });
    if (!slot) throw notFree(ctx, service, booking);
    const customer = await holderOf(api, ctx, location, true);
    const seller = extraOf(ctx).booking.sellerLevel;
    const a = await api.call("POST", "/v2/bookings", {
      // Of the booking it replaces too: a booking moved back to a time it once had is a new one.
      idempotency_key: await keyOf(ctx, "booking", booking.itemId, booking.start, service.id, replacing ?? "first"),
      booking: {
        start_at: iso(booking.start),
        location_id: location,
        customer_id: customer,
        // A note the seller sees and the client does not, where Square lets the inbox write one.
        ...(seller ? { seller_note: noteOf(booking) } : { customer_note: noteOf(booking) }),
        appointment_segments: [
          {
            service_variation_id: service.id,
            service_variation_version: slot.version || service.version,
            team_member_id: slot.team,
            // Read-only to an app that books as a customer (buyer-level): the service's own length then.
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
      const team = teamOf(ctx);
      const service = serviceFor(ctx, booking, location, team);
      const segment = arr(now.appointment_segments)[0];
      // The same service with the same team member: moved in place, and Square says whether the new
      // time is free. Anything else is a booking of its own (an app that books as a customer cannot
      // change a booking's service or team member): made first, so the old one goes only once it is.
      if (str(segment?.team_member_id) && segment?.service_variation_id === service.id) {
        const a = await api.call("PUT", `/v2/bookings/${encodeURIComponent(link.externalId)}`, {
          idempotency_key: await keyOf(ctx, "move", link.externalId, booking.start, Number(now.version ?? 0)),
          booking: { version: Number(now.version ?? 0), start_at: iso(booking.start) },
        });
        if (a.status === 200) return linkOf(obj(a.json.booking), service.id, booking);
        if (a.status !== 400 && a.status !== 409 && a.status !== 422) throw refusal(a, "move this booking");
      }
      const made = await create(api, ctx, booking, link.externalId);
      await cancel(api, ctx, link.externalId);
      return made;
    },

    async remove(ctx, link) {
      if (!link.externalId) return;
      await cancel(await apiOf(ctx), ctx, link.externalId);
    },

    /**
     * A booking this inbox made and kept no id for: one for the inbox's own customer record, at the
     * booking's start, on a service it would be written on. A booking anyone else made is never on it.
     */
    async find(ctx, booking) {
      const api = await apiOf(ctx);
      const location = locationOf(ctx);
      const holder = await holderOf(api, ctx, location, false);
      if (!holder) return null;
      const q = new URLSearchParams({
        location_id: location,
        customer_id: holder,
        start_at_min: iso(booking.start - 60_000),
        start_at_max: iso(booking.start + 60_000),
        limit: "50",
      });
      const listed = await api.must("GET", `/v2/bookings?${q}`, "list the inbox's bookings");
      const services = new Set(servicesAt(extraOf(ctx), location, null).map((s) => s.id));
      const found = arr(listed.bookings).find(
        (b) =>
          msOf(b.start_at) === booking.start &&
          b.customer_id === holder &&
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
