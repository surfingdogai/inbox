import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Weekly } from "../capabilities/availability";
import type { Db } from "../db";
import { availabilityRules, connectors, resources, serviceResources, services } from "../schema/tables";

/**
 * Staff as the inbox keeps them (ADR-035): the `resources` the schema has had since the start, of kind
 * `staff`, with the services each gives (`service_resources`, with the owner's own price and length for
 * them), their own weekly hours (an `availability_rules` row with their `resource_id`), and their own
 * calendar (a connection tied to them). Customers see a member of staff only by a first name.
 */

export interface StaffService {
  readonly serviceId: string;
  /**
   * Minor units, as the service's own price is: for the whole booking, or for each person on a service
   * priced per person; null: the service's own price.
   */
  readonly priceOverride: number | null;
  /** Null: the service's own length. */
  readonly durationOverrideMin: number | null;
}

export interface StaffRow {
  readonly id: string;
  /** The owner's own name for them: never shown to customers. */
  readonly name: string;
  /** What customers see: a first name, or the name they work under. */
  readonly publicName: string;
  readonly kind: string;
  readonly photo: string | null;
  readonly active: boolean;
  readonly sort: number;
  readonly capacity: number;
  readonly externalId: string | null;
  readonly source: string;
}

export interface StaffView extends StaffRow {
  readonly services: readonly StaffService[];
  /** Their own weekly hours; null: they work the business's (or the service's) hours. */
  readonly hours: Weekly | null;
  /** The calendar connected for them alone, when there is one. */
  readonly calendar: { readonly connectorId: string; readonly name: string } | null;
}

/**
 * The first word of a name, at most 60 characters: what customers see of someone by default. "Mei Chen"
 * is "Mei"; "Ọláolúwa" stays itself.
 */
export function firstName(name: string): string {
  const word = name.trim().split(/\s+/u)[0] ?? "";
  return Array.from(word).slice(0, 60).join("") || "Staff";
}

/**
 * The name customers see: the one the owner chose to show, as they wrote it (a given name of two words,
 * "Thu Hà" or "María José", stays whole), else the first word of their own name.
 */
export function publicNameOf(name: string, chosen: string | null | undefined): string {
  const shown = chosen?.trim();
  return shown ? Array.from(shown).slice(0, 60).join("") : firstName(name);
}

type ResourceRow = typeof resources.$inferSelect;

function rowOf(r: ResourceRow): StaffRow {
  return {
    id: r.id,
    name: r.name,
    publicName: publicNameOf(r.name, r.publicName),
    kind: r.kind,
    photo: r.photo,
    active: r.active === 1,
    sort: r.sort,
    capacity: r.capacity,
    externalId: r.externalId,
    source: r.source,
  };
}

/** Members of staff in the owner's order; only those working now unless `all`. */
export async function readStaff(db: Db, opts: { readonly all?: boolean } = {}): Promise<StaffRow[]> {
  const rows = await db.orm
    .select()
    .from(resources)
    .where(opts.all ? eq(resources.kind, "staff") : and(eq(resources.kind, "staff"), eq(resources.active, 1)))
    .orderBy(asc(resources.sort), asc(resources.name), asc(resources.id));
  return rows.map(rowOf);
}

export async function staffById(db: Db, id: string): Promise<StaffRow | null> {
  const [row] = await db.orm
    .select()
    .from(resources)
    .where(and(eq(resources.id, id), eq(resources.kind, "staff")));
  return row ? rowOf(row) : null;
}

/** Every member of staff with their services, hours and calendar, for the owner. */
export async function staffViews(db: Db, opts: { readonly all?: boolean } = {}): Promise<StaffView[]> {
  const rows = await readStaff(db, opts);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [links, hours, calendars] = await Promise.all([
    db.orm.select().from(serviceResources).where(inArray(serviceResources.resourceId, ids)),
    db.orm
      .select({ resourceId: availabilityRules.resourceId, weekly: availabilityRules.weekly })
      .from(availabilityRules)
      .where(
        and(
          eq(availabilityRules.kind, "open"),
          isNull(availabilityRules.serviceId),
          inArray(availabilityRules.resourceId, ids),
        ),
      ),
    db.orm
      .select({ id: connectors.id, name: connectors.name, resourceId: connectors.resourceId })
      .from(connectors)
      .where(inArray(connectors.resourceId, ids)),
  ]);
  return rows.map((r) => ({
    ...r,
    services: links
      .filter((l) => l.resourceId === r.id)
      .map((l) => ({
        serviceId: l.serviceId,
        priceOverride: l.priceOverride,
        durationOverrideMin: l.durationOverrideMin,
      })),
    hours: (hours.find((h) => h.resourceId === r.id)?.weekly as Weekly | undefined) ?? null,
    calendar: (() => {
      const c = calendars.find((x) => x.resourceId === r.id);
      return c ? { connectorId: c.id, name: c.name } : null;
    })(),
  }));
}

/** Who gives a service, working now, in the owner's order, with their own terms for it. */
export async function staffForService(
  db: Db,
  serviceId: string,
): Promise<(StaffRow & { readonly terms: StaffService })[]> {
  const rows = await db.orm
    .select({ r: resources, l: serviceResources })
    .from(serviceResources)
    .innerJoin(resources, eq(resources.id, serviceResources.resourceId))
    .where(and(eq(serviceResources.serviceId, serviceId), eq(resources.kind, "staff"), eq(resources.active, 1)))
    .orderBy(asc(resources.sort), asc(resources.name), asc(resources.id));
  return rows.map(({ r, l }) => ({
    ...rowOf(r),
    terms: { serviceId, priceOverride: l.priceOverride, durationOverrideMin: l.durationOverrideMin },
  }));
}

/** Whether a service is booked with staff: someone working now gives it. */
export async function isStaffed(db: Db, serviceId: string): Promise<boolean> {
  return (await staffForService(db, serviceId)).length > 0;
}

/** Someone's own terms for a service as the owner set them, whether or not they still work here. */
export async function termsOf(db: Db, serviceId: string, resourceId: string): Promise<StaffService | null> {
  const [l] = await db.orm
    .select()
    .from(serviceResources)
    .where(and(eq(serviceResources.serviceId, serviceId), eq(serviceResources.resourceId, resourceId)));
  return l ? { serviceId, priceOverride: l.priceOverride, durationOverrideMin: l.durationOverrideMin } : null;
}

/** Whether two members of staff give a service on the same terms: the same price and the same length. */
export function sameTerms(a: StaffService | null | undefined, b: StaffService | null | undefined): boolean {
  return (
    (a?.priceOverride ?? null) === (b?.priceOverride ?? null) &&
    (a?.durationOverrideMin ?? null) === (b?.durationOverrideMin ?? null)
  );
}

/**
 * Why nobody here can take a booking's time (ADR-035 §2), else null:
 *
 * - `nobody_free`: for anyone, it went to nobody, for a service staff give. Nobody who gives it was free,
 *   so its time is taken; a person answers it. It is never claimed under the service's own key, where
 *   the staff's other bookings would not be seen.
 * - `not_here`: it is with a member of staff who no longer works here (archived), or no longer gives the
 *   service. Nobody confirms it with them, a rule least of all.
 */
export async function nobodyToTake(
  db: Db,
  payload: Record<string, unknown>,
): Promise<"nobody_free" | "not_here" | null> {
  const serviceId = (payload.reservationFor as { serviceId?: unknown } | undefined)?.serviceId;
  if (typeof serviceId !== "string") return null;
  const resourceId = payload.resourceId;
  if (typeof resourceId !== "string") {
    return payload.anyStaff === true && (await isStaffed(db, serviceId)) ? "nobody_free" : null;
  }
  const [r] = await db.orm
    .select({ kind: resources.kind, active: resources.active })
    .from(resources)
    .where(eq(resources.id, resourceId));
  if (r?.kind !== "staff") return null;
  if (r.active !== 1) return "not_here";
  return (await termsOf(db, serviceId, resourceId)) ? null : "not_here";
}

/** Whether nobody here can take a booking's time (`nobodyToTake`): its time is taken, for a person. */
export async function nobodyFree(db: Db, payload: Record<string, unknown>): Promise<boolean> {
  return (await nobodyToTake(db, payload)) !== null;
}

/** Whether the business lists any staff now: the tools that name them are offered only then. */
export async function hasStaff(db: Db): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM resources r JOIN service_resources l ON l.resource_id = r.id
            JOIN services s ON s.id = l.service_id AND s.active = 1
           WHERE r.kind = 'staff' AND r.active = 1 LIMIT 1`,
    params: [],
    method: "all",
  });
  return rows.length > 0;
}

/** Each member of staff's own weekly hours, by id; absent: they work the business's hours. */
export async function staffHours(db: Db, ids: readonly string[]): Promise<Map<string, Weekly>> {
  if (ids.length === 0) return new Map();
  const rows = await db.orm
    .select({ resourceId: availabilityRules.resourceId, weekly: availabilityRules.weekly })
    .from(availabilityRules)
    .where(
      and(
        eq(availabilityRules.kind, "open"),
        isNull(availabilityRules.serviceId),
        inArray(availabilityRules.resourceId, [...ids]),
      ),
    );
  return new Map(rows.flatMap((r) => (r.resourceId ? [[r.resourceId, r.weekly as Weekly] as const] : [])));
}

/** The services that exist, by id, for checking what a member of staff is tied to. */
export async function knownServices(db: Db, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.orm
    .select({ id: services.id })
    .from(services)
    .where(inArray(services.id, [...ids]));
  return new Set(rows.map((r) => r.id));
}
