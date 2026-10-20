import type { BookedAddOn } from "@surfingdog/spec";
import { eq } from "drizzle-orm";
import { findSlots, type Slot, slotOffered } from "../capabilities/availability";
import type { Db } from "../db";
import { services } from "../schema/tables";
import { WriteError } from "../write/errors";
import { type StaffRow, type StaffService, staffForService } from "./store";

/**
 * Times with staff (ADR-035): for a service someone gives, each member of staff's free times — their
 * own hours (else the business's), their own bookings and calendar, their own length for it, the
 * add-ons added — and, asked for anyone, every time at least one of them is free, with who is.
 */

/** A free time, and who is free then: the first named is the one a booking for anyone goes to. */
export interface StaffSlot extends Slot {
  readonly staff: readonly { readonly id: string; readonly name: string; readonly endTime: string }[];
}

/** The id that asks for anyone free. */
export const ANY = "any";

type ServiceRow = typeof services.$inferSelect;

/** The service's add-ons the request names, as the business wrote them; unknown ones are refused. */
export function addOnsOf(
  service: Pick<ServiceRow, "addOns" | "id">,
  ids: readonly string[] | undefined,
): BookedAddOn[] {
  if (!ids || ids.length === 0) return [];
  const offered = service.addOns ?? [];
  const out: BookedAddOn[] = [];
  for (const id of new Set(ids)) {
    const a = offered.find((x) => x.id === id);
    if (!a) {
      throw new WriteError(
        "invalid_input",
        "That service has no add-on with that id: read its add-ons in list_services. Nothing was written.",
        {
          fields: [{ path: "add_ons", problem: "invalid", message: "not an add-on of this service" }],
          details: { reason: "unknown_add_on", add_on: id, service_id: service.id },
        },
      );
    }
    out.push({ id: a.id, name: a.name, durationMin: a.durationMin, ...(a.price ? { price: a.price } : {}) });
  }
  return out;
}

/** The refusal for a member of staff who does not give the service, or is not here. */
export function unknownStaff(staffId: string, serviceId: string): WriteError {
  return new WriteError(
    "invalid_input",
    "Nobody here with that id gives this service: read who does in list_staff, or ask for any. Nothing was written.",
    {
      fields: [{ path: "staff_id", problem: "invalid", message: "not someone who gives this service" }],
      details: { reason: "unknown_staff", staff_id: staffId, service_id: serviceId },
    },
  );
}

/** How long the service takes with one member of staff, the add-ons added. */
export function lengthWith(
  service: Pick<ServiceRow, "durationMin">,
  terms: StaffService | null,
  addOns: readonly BookedAddOn[],
): number {
  return (terms?.durationOverrideMin ?? service.durationMin) + addOns.reduce((n, a) => n + a.durationMin, 0);
}

export async function loadService(db: Db, serviceId: string): Promise<ServiceRow | null> {
  const [row] = await db.orm.select().from(services).where(eq(services.id, serviceId));
  return row ?? null;
}

/**
 * Free times for a service between two instants. With staff: theirs, as above, for the one asked for
 * or anyone. A service nobody is tied to is looked for as it always was, its add-ons added.
 */
export async function findStaffSlots(
  db: Db,
  input: {
    readonly serviceId: string;
    readonly staffId?: string | undefined;
    readonly addOnIds?: readonly string[] | undefined;
    readonly from: string;
    readonly to: string;
    readonly timezone: string;
    readonly now: number;
    readonly minNoticeMin: number;
    readonly limit?: number | undefined;
  },
): Promise<{ service: { id: string; name: string; durationMin: number }; slots: (Slot | StaffSlot)[] }> {
  const service = await loadService(db, input.serviceId);
  const addOns = service ? addOnsOf(service, input.addOnIds) : [];
  const staff = service ? await staffForService(db, service.id) : [];
  const asked = input.staffId && input.staffId !== ANY ? input.staffId : null;
  const base = {
    serviceId: input.serviceId,
    from: input.from,
    to: input.to,
    timezone: input.timezone,
    now: input.now,
    minNoticeMin: input.minNoticeMin,
  };
  if (!service || staff.length === 0) {
    if (asked) throw unknownStaff(asked, input.serviceId);
    const added = addOns.reduce((n, a) => n + a.durationMin, 0);
    return findSlots(db, {
      ...base,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(service && added > 0 ? { durationMin: service.durationMin + added } : {}),
    });
  }
  const who = asked ? staff.filter((s) => s.id === asked) : staff;
  if (who.length === 0) throw unknownStaff(asked ?? "", input.serviceId);
  const merged = new Map<string, { endTime: string; staff: { id: string; name: string; endTime: string }[] }>();
  let view: { id: string; name: string; durationMin: number } | null = null;
  for (const s of who) {
    const r = await findSlots(db, {
      ...base,
      resource: { id: s.id, capacity: s.capacity, durationMin: lengthWith(service, s.terms, addOns) },
    });
    view ??= { ...r.service, durationMin: lengthWith(service, null, addOns) };
    for (const slot of r.slots) {
      const at = merged.get(slot.startTime) ?? { endTime: slot.endTime, staff: [] };
      at.staff.push({ id: s.id, name: s.publicName, endTime: slot.endTime });
      merged.set(slot.startTime, at);
    }
  }
  const limit = input.limit ?? 200;
  const slots: StaffSlot[] = [...merged.entries()]
    .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
    .slice(0, limit)
    .map(([startTime, v]) => ({ startTime, endTime: v.endTime, available: v.staff.length, staff: v.staff }));
  return { service: view ?? { id: service.id, name: service.name, durationMin: service.durationMin }, slots };
}

/**
 * Who a booking for anyone goes to at a time: the first in the owner's order who gives the service and
 * is free for its whole length with them. Null when nobody is.
 */
export async function pickStaff(
  db: Db,
  input: {
    readonly service: ServiceRow;
    readonly staff: readonly (StaffRow & { readonly terms: StaffService })[];
    readonly start: number;
    readonly addOns: readonly BookedAddOn[];
    readonly timezone: string;
    readonly exceptItemId?: string | undefined;
  },
): Promise<(StaffRow & { readonly terms: StaffService }) | null> {
  for (const s of input.staff) {
    const end = input.start + lengthWith(input.service, s.terms, input.addOns) * 60_000;
    const free = await slotOffered(db, {
      serviceId: input.service.id,
      start: input.start,
      end,
      timezone: input.timezone,
      exceptItemId: input.exceptItemId ?? "",
      resource: { id: s.id, capacity: s.capacity },
    });
    if (free) return s;
  }
  return null;
}

/**
 * A booking system's own free times (ADR-035, `availability_in`) as the inbox offers them: each with the
 * member of staff the system names, as customers know them here; times the system names for someone
 * the inbox does not list, or inside the minimum notice, are left out. Advisory: the write the system
 * takes first is what binds.
 */
export async function fromSystem(
  db: Db,
  input: {
    readonly service: ServiceRow;
    readonly slots: readonly { readonly start: number; readonly end: number; readonly staffExternalId: string }[];
    readonly source: string;
    readonly now: number;
    readonly minNoticeMin: number;
    readonly limit?: number | undefined;
  },
): Promise<{ service: { id: string; name: string; durationMin: number }; slots: StaffSlot[] }> {
  const staff = await staffForService(db, input.service.id);
  const byExternal = new Map(
    staff.filter((s) => s.source === input.source && s.externalId).map((s) => [s.externalId as string, s]),
  );
  const earliest = input.now + input.minNoticeMin * 60_000;
  const merged = new Map<number, { end: number; staff: { id: string; name: string; endTime: string }[] }>();
  for (const slot of input.slots) {
    const s = byExternal.get(slot.staffExternalId);
    if (!s || slot.start < earliest || !(slot.end > slot.start)) continue;
    const at = merged.get(slot.start) ?? { end: slot.end, staff: [] };
    if (!at.staff.some((x) => x.id === s.id))
      at.staff.push({ id: s.id, name: s.publicName, endTime: new Date(slot.end).toISOString() });
    merged.set(slot.start, at);
  }
  const slots = [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, input.limit ?? 200)
    .map(([start, v]) => ({
      startTime: new Date(start).toISOString(),
      endTime: new Date(v.end).toISOString(),
      available: v.staff.length,
      staff: v.staff,
    }));
  return {
    service: { id: input.service.id, name: input.service.name, durationMin: input.service.durationMin },
    slots,
  };
}
