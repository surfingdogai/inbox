import {
  closureDaysSchema,
  type ItemType,
  type Profile,
  profileHoursSchema,
  profileSchema,
  profileServiceSchema,
  publishedPayments,
} from "@surfingdog/spec";
import type { z } from "zod";
import type { Db } from "../db";
import type { Settings } from "../settings/schema";
import { lodgingProfile } from "../stays/public";
import { listProperties, readSetup } from "../stays/store";
import { dateLocaliser, readClosures } from "./closures";

/**
 * What the business tells agents and directories about itself, worked out from what it really
 * offers: the item types its manifest and profile say it takes, and the public profile a network's
 * directory shows (ADR-017 A2.5). Nothing here is a promise the inbox cannot keep: a booking is
 * offered only with a service and hours to book it in, an order only with a product.
 */

/** The canonical order the types are listed in. */
const ITEM_TYPES: readonly ItemType[] = ["message", "quote_request", "booking", "order", "refund", "stay"];

/**
 * A place to stay takes stays once it has a room to offer, and its registration where its area
 * requires one (ADR-037): a rental without its number is not bookable. A row when it does; a setup
 * plan's dry run reads the same.
 */
export const STAY_ROOM_OFFERED_SQL = `SELECT 1 FROM room_types r JOIN properties p ON p.id = r.property_id
  WHERE r.active = 1 AND r.offered = 1 AND p.active = 1
    AND NOT (COALESCE(json_extract(p.registration, '$.required'), 0) = 1 AND COALESCE(json_extract(p.registration, '$.number'), '') = '')
  LIMIT 1`;

/**
 * The owner's switches for what agents can do (`settings.doors`). Left out, a door follows what the
 * inbox holds; `false` shuts it; `quoteRequest: true` opens the request for a price with nothing listed.
 */
export interface DoorSwitches {
  readonly booking?: boolean | undefined;
  readonly quoteRequest?: boolean | undefined;
  readonly message?: boolean | undefined;
  readonly stay?: boolean | undefined;
}

/** The switch for a door, by item type; undefined for a door no switch governs (order, refund). */
export function doorSwitch(doors: DoorSwitches, type: ItemType): boolean | undefined {
  if (type === "booking") return doors.booking;
  if (type === "quote_request") return doors.quoteRequest;
  if (type === "message") return doors.message;
  if (type === "stay") return doors.stay;
  return undefined;
}

/**
 * The item types this inbox takes, in canonical order:
 *
 * - `message`, always;
 * - `booking`, with an active service booked at a time (not one asked about for a price, `quote`)
 *   that has weekly hours with at least one window (its own, or the business's when it has none of
 *   its own);
 * - `order`, with an active product;
 * - `quote_request`, with an active service or product to ask about, or switched on (`doors`);
 * - `refund`, with something paid to refund: an order, or a booking of a service with a price.
 *
 * A door the owner switched off (`settings.doors`, false) is never listed, whatever the inbox holds.
 *
 * A kind the business takes somewhere else (`elsewhere`, from `settings.doorsElsewhere`) is not
 * listed, and nor is a refund of it: the manifest names where to go for it instead.
 *
 * Only what is advertised reads this. A kind taken somewhere else is refused to customers by the
 * doors themselves (`createBooking`, `createOrder`, `checkAvailability`), which name where to go.
 */
export async function offeredItemTypes(
  db: Db,
  elsewhere: readonly string[] = [],
  doors: DoorSwitches = {},
): Promise<ItemType[]> {
  const [services, open, products, rooms] = await Promise.all([
    db.client.query({ sql: "SELECT id, price FROM services WHERE active = 1", params: [], method: "all" }),
    db.client.query({
      sql: "SELECT service_id, weekly FROM availability_rules WHERE kind = 'open'",
      params: [],
      method: "all",
    }),
    db.client.query({ sql: "SELECT 1 FROM products WHERE active = 1 LIMIT 1", params: [], method: "all" }),
    db.client.query({ sql: STAY_ROOM_OFFERED_SQL, params: [], method: "all" }),
  ]);
  const base = open.rows.find((r) => r[0] === null || r[0] === undefined);
  const own = new Map(open.rows.filter((r) => r[0] !== null && r[0] !== undefined).map((r) => [String(r[0]), r[1]]));
  // A service's own hours replace the business's, so a service whose own hours are empty is closed.
  const bookable =
    !elsewhere.includes("booking") &&
    doors.booking !== false &&
    services.rows.some((r) => {
      const id = String(r[0]);
      // A service asked about for a price is never booked: it opens a request for a price instead.
      if ((json(r[1]) as { model?: unknown } | null)?.model === "quote") return false;
      return hasWindows(own.has(id) ? own.get(id) : base?.[1]);
    });
  const orderable = !elsewhere.includes("order") && products.rows.length > 0;
  const priced = services.rows.some((r) => {
    const model = (json(r[1]) as { model?: unknown } | null)?.model;
    return model === "fixed" || model === "from";
  });
  const offered = new Set<ItemType>();
  if (doors.message !== false) offered.add("message");
  if (bookable) offered.add("booking");
  if (orderable) offered.add("order");
  // Something can still be asked about here when it is bought or booked somewhere else.
  const askable = doors.quoteRequest === true || services.rows.length > 0 || products.rows.length > 0;
  if (askable && doors.quoteRequest !== false) offered.add("quote_request");
  if (orderable || (bookable && priced)) offered.add("refund");
  if (!elsewhere.includes("stay") && doors.stay !== false && rooms.rows.length > 0) offered.add("stay");
  return ITEM_TYPES.filter((t) => offered.has(t));
}

/**
 * The public profile the manifest carries for a directory (ADR-017 A2.5), or nothing while the
 * business has no name. It holds only what the business publishes about itself: the name and
 * languages, what the owner filled in under `directory` (each part only when it is not empty), its
 * weekly hours and the closures that have not ended, up to thirty active services by name, and how it is paid
 * (`settings.payments`).
 * Never a contact email, a phone or the legal address. Each field is checked alone against the
 * spec's profile, as a network checks it, and one it would reject is left out on its own.
 */
export async function directoryProfile(
  db: Db,
  input: {
    readonly name: string;
    readonly languages: readonly string[];
    readonly timezone: string;
    readonly directory: Settings["directory"];
    /** How it is paid (`settings.payments.accepted`): published as `payments`. */
    readonly payments?: readonly string[] | undefined;
    /** Attributes of a network's vocabulary the business declares (ADR-034: free estimates, emergencies). */
    readonly attributes?: Readonly<Record<string, true>> | undefined;
    readonly now: number;
  },
): Promise<Profile | undefined> {
  const name = input.name.trim();
  if (!name) return undefined;
  const d = input.directory;
  const fields: Record<string, unknown> = { name, languages: [...input.languages] };
  const description = d.description.trim();
  if (description) fields.description = description;
  const categories = d.categories.map((c) => c.trim()).filter(Boolean);
  if (categories.length) fields.categories = categories;
  if (d.url) fields.url = d.url;
  const address = Object.fromEntries(
    Object.entries(d.address)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v),
  );
  if (Object.keys(address).length) fields.address = address;
  if (d.geo) fields.geo = d.geo;
  if (input.attributes && Object.keys(input.attributes).length) fields.attributes = { ...input.attributes };
  const hours = await publicHours(db, input.timezone, input.now);
  if (hours) fields.hours = hours;
  const services = await publicServices(db);
  if (services.length) fields.services = services;
  const payments = publishedPayments(input.payments ?? []);
  if (payments.length) fields.payments = payments;
  // A place to stay that takes stays here (ADR-037 §6.3): its kind, how it confirms, how soon it answers.
  const types = await offeredItemTypes(db);
  if (types.includes("stay")) {
    const property = (await listProperties(db, { active: true }))[0];
    const setup = property ? await readSetup(db, property.id) : null;
    if (setup) fields.lodging = lodgingProfile(setup);
  }

  const shape = profileSchema.shape as unknown as Record<string, z.ZodType>;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const checked = shape[key]?.safeParse(value);
    if (checked?.success) kept[key] = checked.data;
  }
  const profile = profileSchema.safeParse(kept);
  return profile.success ? profile.data : undefined;
}

/**
 * The business's weekly hours, in its zone, with its closures that have not ended (whole days, the
 * reason left out: it is the owner's note). Nothing when it has set no hours with a window: the
 * hours a booking falls back to without any are not the business saying when it is open.
 */
async function publicHours(db: Db, timezone: string, now: number): Promise<z.infer<typeof profileHoursSchema> | null> {
  const { rows } = await db.client.query({
    sql: "SELECT weekly FROM availability_rules WHERE kind = 'open' AND service_id IS NULL LIMIT 1",
    params: [],
    method: "all",
  });
  const weekly = json(rows[0]?.[0]);
  if (!hasWindows(weekly)) return null;
  let today: string;
  try {
    today = dateLocaliser(timezone)(now);
  } catch {
    // A zone the runtime does not know: a directory could not read the hours in it either.
    return null;
  }
  const closures = (await readClosures(db))
    .filter((c) => c.to >= today)
    .map((c) => closureDaysSchema.safeParse({ from: c.from, to: c.to }))
    .flatMap((c) => (c.success ? [c.data] : []))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    .slice(0, 100);
  const hours = profileHoursSchema.safeParse({ timezone, weekly, closures });
  return hours.success ? hours.data : null;
}

/** Active services in the owner's order, at most thirty, by name and how each is taken. */
async function publicServices(db: Db): Promise<z.infer<typeof profileServiceSchema>[]> {
  const { rows } = await db.client.query({
    sql: "SELECT name, price FROM services WHERE active = 1 ORDER BY sort, name, id LIMIT 30",
    params: [],
    method: "all",
  });
  return rows.flatMap((r) => {
    const model = (json(r[1]) as { model?: unknown } | null)?.model;
    const service = profileServiceSchema.safeParse({
      name: String(r[0] ?? "").trim(),
      type: model === "quote" ? "quote_request" : "booking",
    });
    return service.success ? [service.data] : [];
  });
}

/** Whether a stored weekly-hours value has at least one window on some day. */
function hasWindows(value: unknown): boolean {
  const weekly = json(value);
  if (typeof weekly !== "object" || weekly === null || Array.isArray(weekly)) return false;
  return Object.values(weekly).some((day) => Array.isArray(day) && day.length > 0);
}

/** A JSON column as it comes back: text on SQLite and D1, parsed leniently; anything else as it is. */
function json(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
