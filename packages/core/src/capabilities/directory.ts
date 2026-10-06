import {
  closureDaysSchema,
  type ItemType,
  type Profile,
  profileHoursSchema,
  profileSchema,
  profileServiceSchema,
} from "@surfingdog/spec";
import type { z } from "zod";
import type { Db } from "../db";
import type { Settings } from "../settings/schema";
import { dateLocaliser, readClosures } from "./closures";

/**
 * What the business tells agents and directories about itself, worked out from what it really
 * offers: the item types its manifest and profile say it takes, and the public profile a network's
 * directory shows (ADR-017 A2.5). Nothing here is a promise the inbox cannot keep: a booking is
 * offered only with a service and hours to book it in, an order only with a product.
 */

/** The canonical order the types are listed in. */
const ITEM_TYPES: readonly ItemType[] = ["message", "quote_request", "booking", "order", "refund"];

/**
 * The item types this inbox takes, in canonical order:
 *
 * - `message`, always;
 * - `booking`, with an active service that has weekly hours with at least one window (its own, or
 *   the business's when it has none of its own);
 * - `order`, with an active product;
 * - `quote_request`, with an active service or product to ask about;
 * - `refund`, with something paid to refund: an order, or a booking of a service with a price.
 *
 * Only what is advertised reads this. No write path depends on it: a door still takes what it took.
 */
export async function offeredItemTypes(db: Db): Promise<ItemType[]> {
  const [services, open, products] = await Promise.all([
    db.client.query({ sql: "SELECT id, price FROM services WHERE active = 1", params: [], method: "all" }),
    db.client.query({
      sql: "SELECT service_id, weekly FROM availability_rules WHERE kind = 'open'",
      params: [],
      method: "all",
    }),
    db.client.query({ sql: "SELECT 1 FROM products WHERE active = 1 LIMIT 1", params: [], method: "all" }),
  ]);
  const base = open.rows.find((r) => r[0] === null || r[0] === undefined);
  const own = new Map(open.rows.filter((r) => r[0] !== null && r[0] !== undefined).map((r) => [String(r[0]), r[1]]));
  // A service's own hours replace the business's, so a service whose own hours are empty is closed.
  const bookable = services.rows.some((r) => {
    const id = String(r[0]);
    return hasWindows(own.has(id) ? own.get(id) : base?.[1]);
  });
  const orderable = products.rows.length > 0;
  const priced = services.rows.some((r) => {
    const model = (json(r[1]) as { model?: unknown } | null)?.model;
    return model === "fixed" || model === "from";
  });
  const offered = new Set<ItemType>(["message"]);
  if (bookable) offered.add("booking");
  if (orderable) offered.add("order");
  if (services.rows.length > 0 || orderable) offered.add("quote_request");
  if (orderable || (bookable && priced)) offered.add("refund");
  return ITEM_TYPES.filter((t) => offered.has(t));
}

/**
 * The public profile the manifest carries for a directory (ADR-017 A2.5), or nothing while the
 * business has no name. It holds only what the business publishes about itself: the name and
 * languages, what the owner filled in under `directory` (each part only when it is not empty), its
 * weekly hours and the closures that have not ended, and up to thirty active services by name.
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
  const hours = await publicHours(db, input.timezone, input.now);
  if (hours) fields.hours = hours;
  const services = await publicServices(db);
  if (services.length) fields.services = services;

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
