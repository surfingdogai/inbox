import {
  AREA_BANDS_KM,
  type AreaCheck,
  type AreaSummary,
  type CheckAreaOutput,
  postalPrefixSchema,
} from "@surfingdog/spec";
import { z } from "zod";
import { moneySchema } from "../domain/types";
import { isPostalCode, normalisePostal, postalMatches, postalPrefixProblem } from "./postal";

export * from "./postal";

/**
 * Where a business works (ADR-039 §3): a radius, postal prefixes, or anywhere, and what happens to a
 * request from outside. The radius is measured from a base the owner chooses as a place, never as
 * numbers typed in: the business's own premises (Settings → General, on the map), or where the
 * owner's device is when they set it ("Where I am now"). The base is never published, never shown to a
 * customer, and never told as a distance: a request's site is told as a band (within 10 km).
 *
 * A device's point is often the tradesperson's home. Anyone may ask whether a site is inside, again
 * and again, so every check measures from the middle of the cell of a grid of about 5 km that the point
 * falls in (`blurredBase`), never from the point, and gives it no band nearer than 10 km: asking round
 * the edge finds that cell at best. The radius edge from a device is therefore approximate, by up to
 * about 4 km. Premises the business publishes are measured as they are.
 *
 * Nothing is geocoded. A postal code is matched as text against the prefixes; a radius needs a point
 * for the site, which the customer's agent sends when it has one. When the area cannot be decided —
 * a radius and no point, a code the country does not shape that way, a country not matched here —
 * the answer is "on request", never "yes".
 *
 * Delivery zones (food, bakeries) are the same matcher in rings: the first zone a site falls in wins,
 * with its fee, minimum and time (`matchZone`).
 */

export const RADIUS_CHOICES_KM = [5, 10, 25, 50, 100] as const;

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type Point = z.infer<typeof pointSchema>;

/**
 * The base a radius is measured from: the business's premises as Settings → Business has them, or a
 * point the owner's device gave (rounded to about 100 m). Never typed in.
 */
export const areaBaseSchema = z.union([
  z.object({ from: z.literal("business") }),
  z.object({
    from: z.literal("device"),
    point: pointSchema,
    /** A few words for the owner, said back in Settings: "Where I was on 21 Oct". */
    label: z.string().max(80).optional(),
  }),
]);
export type AreaBase = z.infer<typeof areaBaseSchema>;

/** One delivery zone: a ring or a set of prefixes, and what delivering there costs and takes. */
export const zoneSchema = z.object({
  name: z.string().min(1).max(60),
  mode: z.enum(["radius", "postal"]),
  radiusKm: z.number().min(0.5).max(200).optional(),
  postal: z.array(postalPrefixSchema).max(50).optional(),
  fee: moneySchema.optional(),
  minimumOrder: moneySchema.optional(),
  etaMin: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
});
export type Zone = z.infer<typeof zoneSchema>;

export const areaSettingsSchema = z
  .object({
    mode: z.enum(["radius", "postal", "anywhere"]).default("anywhere"),
    base: areaBaseSchema.nullable().default(null),
    radiusKm: z.number().int().min(1).max(1000).default(25),
    postal: z
      .array(postalPrefixSchema)
      .max(100)
      .default([])
      .refine((all) => all.every((p) => postalPrefixProblem(p.country, p.prefix) === null), {
        message: "each prefix the start of a postal code in its country",
      }),
    outside: z.enum(["decline", "on_request"]).default("on_request"),
    /** Delivery zones, inside out: the first a site falls in wins. Empty: no delivery. */
    zones: z.array(zoneSchema).max(10).default([]),
  })
  // Postal codes and none of them would turn away every request with a code: refused. On the mode, so
  // a stored area that says it is read as anywhere rather than losing the rest of the settings.
  .refine((a) => a.mode !== "postal" || a.postal.length > 0, {
    path: ["mode"],
    message: "Add at least one postal code, or choose Anywhere.",
  })
  .prefault({});
export type AreaSettings = z.infer<typeof areaSettingsSchema>;

/** What a request's site is, as far as the inbox can tell: a postal code with its country, a point. */
export interface Site {
  readonly postalCode?: string | undefined;
  readonly country?: string | undefined;
  readonly point?: Point | undefined;
}

/** Kilometres between two points on the Earth (haversine, mean radius). */
export function distanceKm(a: Point, b: Point): number {
  const R = 6371.0088;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The smallest band a distance falls in, when it is within 50 km, and no nearer than `nearest`. */
export function bandOf(km: number, nearest = 0): AreaCheck["within_km"] {
  for (const b of AREA_BANDS_KM) if (km <= b && b >= nearest) return b;
  return undefined;
}

/** A grid cell's side, in degrees of latitude: about 5.6 km. */
const CELL_DEG = 0.05;
/** The nearest band told when the base is a device's point. */
const DEVICE_NEAREST_BAND = 10;

/**
 * The middle of the cell of a grid of about 5 km a device's point falls in: what every check measures
 * from, so the point itself is never what an answer depends on. A cell's width in longitude grows
 * towards the poles, so cells stay about as wide as they are tall.
 */
export function blurredBase(p: Point): Point {
  const row = Math.floor((p.lat + 90) / CELL_DEG);
  const lat = Math.min(90, -90 + (row + 0.5) * CELL_DEG);
  const width = CELL_DEG / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  const col = Math.floor((p.lng + 180) / width);
  const lng = Math.min(180, -180 + (col + 0.5) * width);
  return { lat: Math.round(lat * 10_000) / 10_000, lng: Math.round(lng * 10_000) / 10_000 };
}

/**
 * The base's point as checks measure from it: the premises' as Settings → General keeps it, or the
 * middle of the grid cell a device's point falls in. Null without one.
 */
export function basePoint(area: AreaSettings, premises: Point | null): Point | null {
  if (!area.base) return null;
  if (area.base.from === "business") return premises;
  return blurredBase(area.base.point);
}

function postalInside(prefixes: readonly { country: string; prefix: string }[], site: Site): boolean | null {
  if (!site.postalCode || !site.country) return null;
  const country = site.country.toUpperCase();
  if (isPostalCode(country, site.postalCode) !== true) return null;
  return prefixes.some((p) => p.country === country && postalMatches(country, site.postalCode as string, p.prefix));
}

/**
 * Whether a site is inside the area. A postal area answers from the code alone; a radius from the
 * site's point and the base, as a band. Anything that cannot be told is `unknown`.
 */
export function checkSite(area: AreaSettings, premises: Point | null, site: Site): AreaCheck {
  if (area.mode === "anywhere") return { status: "inside", by: "anywhere" };
  if (area.mode === "postal") {
    const inside = postalInside(area.postal, site);
    return { status: inside === null ? "unknown" : inside ? "inside" : "outside", by: "postal" };
  }
  const base = basePoint(area, premises);
  if (!base || !site.point) return { status: "unknown", by: "radius" };
  const km = distanceKm(base, site.point);
  if (km > area.radiusKm) return { status: "outside", by: "radius" };
  const band = bandOf(km, area.base?.from === "device" ? DEVICE_NEAREST_BAND : 0);
  return { status: "inside", by: "radius", ...(band ? { within_km: band } : {}) };
}

/** What a request from a site gets: taken, declined, or taken for the business to decide. */
export function answerOf(area: AreaSettings, check: AreaCheck): CheckAreaOutput["answer"] {
  if (check.status === "inside") return "inside";
  if (check.status === "outside" && area.outside === "decline") return "outside";
  return "on_request";
}

/** Where the business works, as it may say so in public: never the base. */
export function areaSummary(area: AreaSettings): AreaSummary {
  if (area.mode === "radius") return { mode: "radius", radius_km: area.radiusKm, outside: area.outside };
  if (area.mode === "postal") {
    return {
      mode: "postal",
      postal: area.postal.map((p) => ({ country: p.country, prefix: normalisePostal(p.prefix) })),
      outside: area.outside,
    };
  }
  return { mode: "anywhere", outside: area.outside };
}

/** The words an agent relays, in the business's name. */
export function areaWords(business: string, area: AreaSettings, check: AreaCheck): string {
  const who = business.trim() || "The business";
  const where =
    area.mode === "radius"
      ? `within ${area.radiusKm} km`
      : area.mode === "postal"
        ? `in ${area.postal
            .map((p) => normalisePostal(p.prefix))
            .slice(0, 8)
            .join(", ")}${area.postal.length > 8 ? " and more" : ""}`
        : "anywhere";
  if (check.status === "inside") {
    return check.within_km
      ? `${who} works ${where}: this site is within ${check.within_km} km.`
      : `${who} works ${where}: this site is inside.`;
  }
  if (check.status === "outside") {
    return area.outside === "decline"
      ? `${who} works ${where}, and this site is outside it.`
      : `${who} works ${where}. This site is outside it, so ${who} decides on each request from there.`;
  }
  return area.mode === "radius"
    ? `${who} works ${where}. Send the site's coordinates to check it; without them, ${who} decides on the request.`
    : `${who} works ${where}. That postal code could not be checked, so ${who} decides on the request.`;
}

/** The delivery zone a site falls in: the first that holds it, else null (no delivery there). */
export function matchZone(
  zones: readonly Zone[],
  base: Point | null,
  site: Site,
): { zone: Zone; index: number } | null {
  for (const [index, zone] of zones.entries()) {
    if (zone.mode === "postal") {
      if (postalInside(zone.postal ?? [], site) === true) return { zone, index };
      continue;
    }
    if (!base || !site.point || zone.radiusKm === undefined) continue;
    if (distanceKm(base, site.point) <= zone.radiusKm) return { zone, index };
  }
  return null;
}

/** A point as the owner's device gave it, rounded to about 100 m: the base never needs more. */
export function roundedPoint(p: Point): Point {
  return { lat: Math.round(p.lat * 1000) / 1000, lng: Math.round(p.lng * 1000) / 1000 };
}
