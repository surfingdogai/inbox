import { type CalendarChoice, type ConnectionChoice, ConnectorError, type RunContext } from "@surfingdog/core";
import { type Answer, arr, obj, type SquareApi, type SquareEnv, str } from "./api";

/**
 * What a Square connection knows of the account (ADR-029), read when it is connected and every few
 * hours after: the seller, its open locations (each with its currency and its own phone number), how
 * it takes bookings, the services it books and the team members who take them. Kept as the
 * connection's `extra`, never a secret: none of it is the customer's.
 *
 * - Merchant: https://developer.squareup.com/reference/square/merchants-api/retrieve-merchant
 * - Locations: https://developer.squareup.com/reference/square/locations-api/list-locations
 * - Booking profile, team: https://developer.squareup.com/docs/bookings-api/use-the-api
 * - Services: https://developer.squareup.com/docs/bookings-api/use-the-api#search-for-bookable-services
 */

/** Where one object of the catalogue is sold: everywhere but some locations, or only at some. */
export interface Place {
  readonly all: boolean;
  readonly at: readonly string[];
  readonly absent: readonly string[];
}

/** Where something is sold: an item and its variation each narrow it, so it is sold where all of them are. */
export type Presence = readonly Place[];

/** A service Square books (a variation of an `APPOINTMENTS_SERVICE` item), as the inbox chooses one. */
export interface ServiceInfo {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly minutes: number;
  readonly presence: Presence;
  /** The team members who take it, when Square says; null for anyone bookable. */
  readonly team: readonly string[] | null;
}

export interface LocationInfo {
  readonly name: string;
  readonly currency: string | null;
  /** The location's own phone number (`Location.phone_number`): the business's, never a customer's. */
  readonly phone: string | null;
  readonly timezone: string | null;
}

/** How the seller takes bookings (`BusinessBookingProfile`). */
export interface BookingInfo {
  /** Square Appointments is on, so bookings can be read and made at all. */
  readonly enabled: boolean;
  /**
   * Appointments Plus or Premium (`support_seller_level_writes`): Square takes bookings from an app
   * that acts as the seller. On the free plan it takes them only from one that books as a customer.
   */
  readonly sellerLevel: boolean;
}

/**
 * How the connection came in: the owner's own access token, or Sign in with Square. Square decides from
 * the token's permissions whether an app acts as the seller or books as a customer
 * (https://developer.squareup.com/docs/bookings-api/what-it-is): a personal access token opens the
 * whole account (https://developer.squareup.com/docs/build-basics/access-tokens), so it always acts as
 * the seller; a sign-in asks for no seller-level permission (`SQUARE_SCOPES`), so it always books as a
 * customer.
 */
export type SquareVia = "token" | "signin";

export interface SquareExtra {
  readonly env: SquareEnv;
  readonly via: SquareVia;
  readonly merchantId: string;
  readonly mainLocation: string | null;
  readonly locations: Readonly<Record<string, LocationInfo>>;
  readonly booking: BookingInfo;
  readonly services: readonly ServiceInfo[];
  /** The webhook subscription: made (`added`), to make once the inbox is live (`pending`), or none (a sign-in). */
  readonly hooks: "added" | "pending" | "none";
  readonly subscriptionId?: string | undefined;
  /** The address the subscription was made for: Square signs it with the body. */
  readonly notificationUrl?: string | undefined;
  /** When making or moving the subscription last failed: tried again an hour on, never on every sync. */
  readonly hooksTriedAt?: number | undefined;
}

/** What the webhook's state is kept as, beside the account. */
export type HookState = Pick<SquareExtra, "hooks" | "subscriptionId" | "notificationUrl" | "hooksTriedAt">;

/**
 * How bookings are written into Square for this connection, or null when Square takes none from it:
 * an access token acts as the seller, which Square allows on Appointments Plus or Premium only (on the
 * free plan it answers 403, "Merchant subscription does not support write operations"); a sign-in books
 * as a customer, on every plan (https://developer.squareup.com/docs/bookings-api/what-it-is).
 */
export function writeLevel(x: Pick<SquareExtra, "via" | "booking">): "seller" | "buyer" | null {
  if (!x.booking.enabled) return null;
  if (x.via === "signin") return "buyer";
  return x.booking.sellerLevel ? "seller" : null;
}

/** The destination that books the service of the same name and length as the booking. */
export const AUTO = "auto";
/** The team choice that books whoever is free. */
export const ANYONE = "any";

export interface AccountRead {
  readonly account: string;
  readonly merchantId: string;
  readonly mainLocation: string | null;
  readonly locations: Record<string, LocationInfo>;
  readonly booking: BookingInfo;
  readonly services: ServiceInfo[];
  readonly team: { readonly id: string; readonly name: string }[];
}

/** Pages of a hundred services read, at most. */
const SERVICE_PAGES = 10;

/** The seller, its locations, how it books, its services and team: one read of all of it. */
export async function readAccount(api: SquareApi): Promise<AccountRead> {
  const me = obj((await api.must("GET", "/v2/merchants/me", "say whose account this is")).merchant);
  const merchantId = str(me.id);
  if (!merchantId) throw new ConnectorError("bad_response", "Square did not say whose account this is.");
  const listed = await api.must("GET", "/v2/locations", "list your locations");
  const locations: Record<string, LocationInfo> = {};
  for (const l of arr(listed.locations)) {
    const id = str(l.id);
    if (!id || l.status !== "ACTIVE") continue;
    locations[id] = {
      name: (str(l.name) ?? str(l.business_name) ?? id).slice(0, 120),
      currency: str(l.currency)?.toUpperCase() ?? null,
      phone: str(l.phone_number),
      timezone: str(l.timezone),
    };
  }
  if (Object.keys(locations).length === 0) {
    throw new ConnectorError(
      "config",
      "This Square account has no open location. Open one in Square, then connect again.",
    );
  }
  const main = str(me.main_location_id);
  const booking = await readBooking(api);
  const services = booking.enabled ? await readServices(api) : [];
  const team = booking.enabled ? await readTeam(api) : [];
  return {
    account: (str(me.business_name) ?? Object.values(locations)[0]?.name ?? "Square").slice(0, 120),
    merchantId,
    mainLocation: main && locations[main] ? main : (Object.keys(locations)[0] ?? null),
    locations,
    booking,
    services,
    team,
  };
}

/** How the seller takes bookings; off when Square Appointments is not set up (Square answers no profile). */
async function readBooking(api: SquareApi): Promise<BookingInfo> {
  const a: Answer = await api.call("GET", "/v2/bookings/business-booking-profile");
  const off: BookingInfo = { enabled: false, sellerLevel: false };
  if (a.status !== 200) return off;
  const p = obj(a.json.business_booking_profile);
  if (p.booking_enabled !== true) return off;
  return { enabled: true, sellerLevel: p.support_seller_level_writes === true };
}

/**
 * The services Square books: variations of `APPOINTMENTS_SERVICE` items, available for booking, with
 * their length. One with a cancellation fee is left out: Square refuses those through its API.
 */
async function readServices(api: SquareApi): Promise<ServiceInfo[]> {
  const out: ServiceInfo[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SERVICE_PAGES; page++) {
    const a: Answer = await api.call("POST", "/v2/catalog/search-catalog-items", {
      product_types: ["APPOINTMENTS_SERVICE"],
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (a.status !== 200) return out;
    for (const item of arr(a.json.items)) {
      if (item.is_deleted === true) continue;
      const data = obj(item.item_data);
      if (data.is_archived === true) continue;
      const variations = arr(data.variations).filter((v) => v.is_deleted !== true);
      for (const v of variations) {
        const vd = obj(v.item_variation_data);
        const id = str(v.id);
        const minutes = Math.round(Number(vd.service_duration) / 60_000);
        const fee = Number(obj(vd.no_show_fee).amount ?? 0);
        if (!id || vd.available_for_booking !== true || !(minutes > 0) || fee > 0) continue;
        const itemName = str(data.name) ?? "Service";
        const variation = str(vd.name);
        const name = variation && variations.length > 1 ? `${itemName} · ${variation}` : itemName;
        const team = Array.isArray(vd.team_member_ids)
          ? vd.team_member_ids.filter((t): t is string => typeof t === "string")
          : null;
        out.push({
          id,
          version: Number(v.version ?? 0),
          name: name.slice(0, 120),
          minutes,
          presence: presenceOf(item, v),
          team: team && team.length > 0 ? team : null,
        });
      }
    }
    cursor = str(a.json.cursor);
    if (!cursor) break;
  }
  return out;
}

/** The team members a booking can be given to (`is_bookable`). */
async function readTeam(api: SquareApi): Promise<{ id: string; name: string }[]> {
  const a = await api.call("GET", "/v2/bookings/team-member-booking-profiles?bookable_only=true&limit=100");
  if (a.status !== 200) return [];
  return arr(a.json.team_member_booking_profiles)
    .filter((t) => t.is_bookable !== false && typeof t.team_member_id === "string")
    .map((t) => ({
      id: String(t.team_member_id),
      name: (str(t.display_name) ?? "Team member").slice(0, 80),
    }));
}

/** Where an item and its variation are sold (`present_at_all_locations`, `present_at_location_ids`, `absent_at_location_ids`). */
export function presenceOf(...objects: readonly Record<string, unknown>[]): Presence {
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return objects.map((o) => ({
    all: o.present_at_all_locations !== false,
    at: ids(o.present_at_location_ids),
    absent: ids(o.absent_at_location_ids),
  }));
}

/** Whether something is sold at a location: where every part of it is. */
export function isAt(p: Presence, location: string): boolean {
  return p.every((part) => (part.all ? !part.absent.includes(location) : part.at.includes(location)));
}

/* --- what a run reads of it ---------------------------------------------- */

export function extraOf(ctx: Pick<RunContext, "extra">): SquareExtra {
  const e = ctx.extra as Partial<SquareExtra>;
  return {
    env: e.env === "sandbox" ? "sandbox" : "production",
    via: e.via === "signin" ? "signin" : "token",
    merchantId: String(e.merchantId ?? ""),
    mainLocation: typeof e.mainLocation === "string" ? e.mainLocation : null,
    locations: (e.locations ?? {}) as Record<string, LocationInfo>,
    booking: e.booking ?? { enabled: false, sellerLevel: false },
    services: Array.isArray(e.services) ? e.services : [],
    hooks: e.hooks === "added" || e.hooks === "pending" ? e.hooks : "none",
    subscriptionId: typeof e.subscriptionId === "string" ? e.subscriptionId : undefined,
    notificationUrl: typeof e.notificationUrl === "string" ? e.notificationUrl : undefined,
    hooksTriedAt: typeof e.hooksTriedAt === "number" ? e.hooksTriedAt : undefined,
  };
}

/** The location the owner chose, or the main one. */
export function locationOf(ctx: Pick<RunContext, "extra" | "choices">): string {
  const x = extraOf(ctx);
  const chosen = ctx.choices?.location;
  if (chosen && x.locations[chosen]) return chosen;
  const loc = x.mainLocation ?? Object.keys(x.locations)[0];
  if (!loc) throw new ConnectorError("config", "This Square connection has no location. Connect Square again.");
  return loc;
}

/** The team member the owner chose, or null for whoever is free. */
export function teamOf(ctx: Pick<RunContext, "choices">): string | null {
  const chosen = ctx.choices?.team;
  return chosen && chosen !== ANYONE ? chosen : null;
}

/** The services bookable at a location (and by the chosen team member, when Square says who takes them). */
export function servicesAt(x: SquareExtra, location: string, team: string | null): ServiceInfo[] {
  return x.services.filter(
    (s) => isAt(s.presence, location) && (team === null || s.team === null || s.team.includes(team)),
  );
}

/**
 * Where bookings go: each to the Square service of its own name and length, one by one. A single
 * service for every booking would send a colour to the haircut, so there is nothing else to choose.
 */
export function destinationsOf(services: readonly ServiceInfo[]): CalendarChoice[] {
  return services.length === 0 ? [] : [{ id: AUTO, name: "Matched by name", writable: true }];
}

/**
 * The choosers drawn once connected. The location, where there is more than one to choose: it sets
 * the prices, the stock, where orders are paid and where bookings go. A location Square cannot book
 * for yet, for want of its phone number, says so in its name, before a booking is refused for it.
 * Who takes bookings, when Square books: a choice about bookings only.
 */
export function choicesOf(read: AccountRead, via: SquareVia): ConnectionChoice[] {
  const books = writeLevel({ via, booking: read.booking }) !== null;
  const locations = Object.entries(read.locations);
  const phoneless = books && locations.some(([, l]) => !l.phone);
  const out: ConnectionChoice[] = [];
  if (locations.length > 1 || phoneless) {
    out.push({
      key: "location",
      label: "Location",
      options: locations.map(([id, l]) => ({
        id,
        name: books && !l.phone ? `${l.name} · add a phone in Square to take bookings` : l.name,
      })),
      value: read.mainLocation,
    });
  }
  if (read.booking.enabled && read.team.length > 0) {
    out.push({
      key: "team",
      label: "Bookings go to",
      options: [{ id: ANYONE, name: "Whoever is free" }, ...read.team],
      value: ANYONE,
      bookings: true,
    });
  }
  return out;
}

/** What is kept of the account, beside the webhook's state. */
export function extraFrom(read: AccountRead, env: SquareEnv, via: SquareVia, hooks: HookState): SquareExtra {
  return {
    env,
    via,
    merchantId: read.merchantId,
    mainLocation: read.mainLocation,
    locations: read.locations,
    booking: read.booking,
    services: read.services,
    hooks: hooks.hooks,
    ...(hooks.subscriptionId ? { subscriptionId: hooks.subscriptionId } : {}),
    ...(hooks.notificationUrl ? { notificationUrl: hooks.notificationUrl } : {}),
    ...(hooks.hooksTriedAt ? { hooksTriedAt: hooks.hooksTriedAt } : {}),
  };
}
