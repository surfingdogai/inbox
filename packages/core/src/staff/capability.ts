import type { StaffMember } from "@surfingdog/spec";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { assertNoLeak, PUBLISHED } from "../access/leaks";
import type { Weekly } from "../capabilities/availability";
import { currencySchema, weeklySchema } from "../capabilities/setup-types";
import type { SetupSnapshot } from "../connectors/setup-snapshot";
import type { Db } from "../db";
import { ulid } from "../ids";
import { resources, serviceResources, services } from "../schema/tables";
import { type Caller, isCustomer, isPerson, nowOf } from "../write/caller";
import { fromZod, WriteError } from "../write/errors";
import { cleanPhoto } from "./photo";
import { knownServices, type StaffView, staffById, staffViews } from "./store";

/**
 * Staff, as the owner sets them up and as customers' assistants read them (ADR-035).
 *
 * - The owner names each member of staff (their own name stays theirs), the first name customers see,
 *   a photo, the services each gives with their own price and length for any, and their own hours.
 * - Their price is money, so it is the owner's in person: the owner's AI may add someone, name them,
 *   tie them to services and set their hours, never their prices.
 * - Customers see only `list_staff`: a first name, a photo, the services. Never hours, never a surname.
 */

const staffServiceSchema = z.object({
  service_id: z.string().min(1).max(64),
  price_override: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("Minor units, for the whole booking; null: the service's price."),
  duration_override_min: z.number().int().min(5).max(1440).nullable().optional(),
});

export const staffInput = z.object({
  name: z.string().trim().min(1).max(120).describe("Their name, as you know them. Customers never see it."),
  public_name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("What customers see: a first name. Default: the first word of name."),
  photo: z
    .string()
    .max(60_000)
    .nullable()
    .optional()
    .describe("A small JPEG as a data URL (at most 32 KB); null takes it off."),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(10_000).default(0),
  capacity: z.number().int().min(1).max(20).default(1).describe("How many bookings they take at once."),
  services: z.array(staffServiceSchema).max(200).optional().describe("The services they give."),
  hours: weeklySchema.nullable().optional().describe("Their own weekly hours; null: the business's."),
});
export const updateStaffInput = z.object({
  staff_id: z.string().min(1).max(64),
  name: staffInput.shape.name.optional(),
  public_name: z.string().trim().max(60).nullable().optional(),
  photo: staffInput.shape.photo,
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(10_000).optional(),
  capacity: z.number().int().min(1).max(20).optional(),
  services: staffInput.shape.services,
  hours: staffInput.shape.hours,
});
export type StaffInput = z.input<typeof staffInput>;
export type UpdateStaffInput = z.input<typeof updateStaffInput>;

/** What the owner keeps of a tool's snapshot: by the tool's own ids, one press each. */
export const importSetupInput = z.object({
  source: z.string().min(1).max(40),
  currency: currencySchema.optional(),
  services: z.array(z.string().min(1).max(200)).max(500).default([]),
  staff: z.array(z.string().min(1).max(200)).max(200).default([]),
  /** Keep each member of staff's own hours from the tool. */
  hours: z.boolean().default(false),
});
export type ImportSetupInput = z.input<typeof importSetupInput>;

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw fromZod(r.error, "");
  return r.data;
}

function requireOwnerSide(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "setup needs an owner or staff principal");
}

function staffMoney(): WriteError {
  return new WriteError(
    "not_allowed",
    "A member of staff's own price is money, and money is the owner's to set. Tell the owner in a note (reply with internal: true) what you suggest.",
    {
      fields: [{ path: "services", problem: "invalid", message: "only the owner sets prices" }],
      details: { reason: "owner_money", draft_for_owner: true },
    },
  );
}

const PHOTO_WORDS: Record<string, string> = {
  not_jpeg: "That photo is not a JPEG the inbox can read: choose another.",
  too_large: "That photo is too large: choose a smaller one.",
  unreadable: "That photo could not be read: choose another.",
};

export class StaffCapabilities {
  constructor(
    private readonly db: Db,
    /** Where the inbox is reached, for a photo's address. */
    private readonly baseUrl: () => string | undefined = () => undefined,
  ) {}

  /** Every member of staff, with what they give and when, for the owner. */
  async list(caller: Caller, opts: { readonly all?: boolean } = {}): Promise<StaffView[]> {
    requireOwnerSide(caller);
    return staffViews(this.db, { all: opts.all ?? true });
  }

  async create(caller: Caller, raw: StaffInput): Promise<StaffView> {
    requireOwnerSide(caller);
    const input = parse(staffInput, raw);
    await assertNoLeak(this.db, caller, PUBLISHED, [input.public_name ?? input.name.split(/\s+/)[0] ?? ""]);
    const now = nowOf(caller);
    const id = ulid(now);
    const photo = input.photo ? this.photoOf(input.photo) : null;
    if (input.services?.some((s) => s.price_override !== undefined && s.price_override !== null) && !isPerson(caller))
      throw staffMoney();
    await this.db.orm.insert(resources).values({
      id,
      name: input.name,
      kind: "staff",
      publicName: input.public_name ?? null,
      photo,
      active: input.active ? 1 : 0,
      sort: input.sort,
      capacity: input.capacity,
      createdAt: now,
      updatedAt: now,
    });
    if (input.services) await this.setServices(caller, id, input.services, now);
    if (input.hours !== undefined) await this.setHours(id, input.hours as Weekly | null, now);
    return this.view(id);
  }

  async update(caller: Caller, raw: UpdateStaffInput): Promise<StaffView> {
    requireOwnerSide(caller);
    const input = parse(updateStaffInput, raw);
    const stored = await staffById(this.db, input.staff_id);
    if (!stored) throw unknownStaffId();
    const now = nowOf(caller);
    if (input.public_name || input.name) {
      await assertNoLeak(this.db, caller, PUBLISHED, [input.public_name ?? input.name?.split(/\s+/)[0] ?? ""]);
    }
    const sets: Partial<typeof resources.$inferInsert> = { updatedAt: now };
    if (input.name !== undefined) sets.name = input.name;
    if (input.public_name !== undefined) sets.publicName = input.public_name || null;
    if (input.photo !== undefined) sets.photo = input.photo === null ? null : this.photoOf(input.photo);
    if (input.active !== undefined) sets.active = input.active ? 1 : 0;
    if (input.sort !== undefined) sets.sort = input.sort;
    if (input.capacity !== undefined) sets.capacity = input.capacity;
    await this.db.orm.update(resources).set(sets).where(eq(resources.id, input.staff_id));
    if (input.services) await this.setServices(caller, input.staff_id, input.services, now);
    if (input.hours !== undefined) await this.setHours(input.staff_id, input.hours as Weekly | null, now);
    return this.view(input.staff_id);
  }

  /** Someone who no longer works here: off every public list, their bookings kept as they are. */
  async archive(caller: Caller, staffId: string): Promise<StaffView> {
    return this.update(caller, { staff_id: staffId, active: false });
  }

  /**
   * Who customers can book, as their assistants read it: first names, photos and the services each
   * gives, of the services on offer. Nothing else about anyone.
   */
  async publicList(serviceId?: string | undefined): Promise<StaffMember[]> {
    const views = await staffViews(this.db, { all: false });
    const offered = new Set(
      (await this.db.orm.select({ id: services.id }).from(services).where(eq(services.active, 1))).map((s) => s.id),
    );
    const base = this.baseUrl();
    return views
      .map((v) => ({
        id: v.id,
        name: v.publicName,
        ...(v.photo && base ? { photo_url: `${base}/v1/staff/${v.id}/photo.jpg` } : {}),
        service_ids: v.services.map((s) => s.serviceId).filter((id) => offered.has(id)),
      }))
      .filter((m) => m.service_ids.length > 0 && (!serviceId || m.service_ids.includes(serviceId)));
  }

  /** A photo, as its address serves it: only someone working now, only a photo that was kept. */
  async photo(staffId: string): Promise<string | null> {
    const s = await staffById(this.db, staffId);
    return s?.active && s.photo ? s.photo : null;
  }

  /**
   * What a connected tool sent, kept as the owner chose (ADR-035, `setup_in`): services and staff by the
   * tool's ids, made new or updated in place (a second import changes what the first made, never
   * twice), each service tied to the staff the tool says give it, with their own prices and lengths.
   * Prices are the business's own, copied as the tool holds them: the owner keeps them in person.
   */
  async importSetup(
    caller: Caller,
    snapshot: SetupSnapshot,
    raw: ImportSetupInput,
  ): Promise<{ services: number; staff: number }> {
    requireOwnerSide(caller);
    if (!isPerson(caller)) {
      throw new WriteError(
        "not_allowed",
        "Bringing in services with their prices is the owner's to do, in the app. Tell the owner in a note what you suggest.",
        { details: { reason: "owner_money", draft_for_owner: true } },
      );
    }
    const input = parse(importSetupInput, raw);
    if (input.source !== snapshot.source.kind)
      throw new WriteError("invalid_input", "That is not where this was read from.");
    const now = nowOf(caller);
    const source = snapshot.source.kind;
    const staffIds = new Map<string, string>();
    let staffCount = 0;
    for (const s of snapshot.staff ?? []) {
      if (!input.staff.includes(s.externalId)) continue;
      const [existing] = await this.db.orm
        .select({ id: resources.id })
        .from(resources)
        .where(and(eq(resources.source, source), eq(resources.externalId, s.externalId)));
      const id = existing?.id ?? ulid(now);
      if (existing) {
        await this.db.orm.update(resources).set({ name: s.name, updatedAt: now }).where(eq(resources.id, id));
      } else {
        await this.db.orm.insert(resources).values({
          id,
          name: s.name,
          kind: "staff",
          source,
          externalId: s.externalId,
          active: 1,
          sort: staffCount,
          capacity: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (input.hours && s.hours) await this.setHours(id, s.hours as Weekly, now);
      staffIds.set(s.externalId, id);
      staffCount++;
    }
    let serviceCount = 0;
    for (const svc of snapshot.services ?? []) {
      if (!input.services.includes(svc.externalId)) continue;
      const price = svc.price
        ? { model: "fixed" as const, value: svc.price.value, currency: svc.price.currency }
        : null;
      const [existing] = await this.db.orm
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.source, source), eq(services.externalId, svc.externalId)));
      const id = existing?.id ?? ulid(now);
      if (existing) {
        await this.db.orm
          .update(services)
          .set({ name: svc.name, ...(svc.durationMin ? { durationMin: svc.durationMin } : {}), price, updatedAt: now })
          .where(eq(services.id, id));
      } else {
        await this.db.orm.insert(services).values({
          id,
          name: svc.name,
          durationMin: svc.durationMin ?? 60,
          price,
          source,
          externalId: svc.externalId,
          active: 1,
          sort: serviceCount,
          createdAt: now,
          updatedAt: now,
        });
      }
      for (const ext of svc.staff ?? []) {
        const staffId = staffIds.get(ext);
        if (!staffId) continue;
        const own = svc.overrides?.find((o) => o.staff === ext);
        await this.db.client.query({
          sql: `INSERT INTO service_resources (service_id, resource_id, price_override, duration_override_min, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(service_id, resource_id) DO UPDATE SET price_override = excluded.price_override,
                  duration_override_min = excluded.duration_override_min`,
          params: [id, staffId, own?.price?.value ?? null, own?.durationMin ?? null, now],
          method: "run",
        });
      }
      serviceCount++;
    }
    return { services: serviceCount, staff: staffCount };
  }

  private photoOf(dataUrl: string): string {
    const r = cleanPhoto(dataUrl);
    if ("problem" in r) {
      throw new WriteError("invalid_input", PHOTO_WORDS[r.problem] ?? "That photo cannot be kept.", {
        fields: [{ path: "photo", problem: "invalid", message: r.problem }],
      });
    }
    return r.photo;
  }

  private async setServices(
    caller: Caller,
    staffId: string,
    list: readonly z.infer<typeof staffServiceSchema>[],
    now: number,
  ): Promise<void> {
    const ids = [...new Set(list.map((s) => s.service_id))];
    const known = await knownServices(this.db, ids);
    const bad = ids.find((id) => !known.has(id));
    if (bad) {
      throw new WriteError("invalid_input", "That is not one of your services.", {
        fields: [{ path: "services", problem: "invalid", message: `unknown service ${bad}` }],
      });
    }
    const before = await this.db.orm.select().from(serviceResources).where(eq(serviceResources.resourceId, staffId));
    // Their own prices stay as the owner set them, unless the owner sets them.
    if (!isPerson(caller)) {
      for (const s of list) {
        const was = before.find((b) => b.serviceId === s.service_id)?.priceOverride ?? null;
        if (s.price_override !== undefined && (s.price_override ?? null) !== was) throw staffMoney();
      }
    }
    await this.db.batch([
      { sql: "DELETE FROM service_resources WHERE resource_id = ?", params: [staffId], method: "run" },
      ...list.map((s) => {
        const was = before.find((b) => b.serviceId === s.service_id);
        return {
          sql: `INSERT INTO service_resources (service_id, resource_id, price_override, duration_override_min, created_at)
                VALUES (?, ?, ?, ?, ?)`,
          params: [
            s.service_id,
            staffId,
            s.price_override === undefined ? (was?.priceOverride ?? null) : s.price_override,
            s.duration_override_min === undefined ? (was?.durationOverrideMin ?? null) : s.duration_override_min,
            was?.createdAt ?? now,
          ],
          method: "run" as const,
        };
      }),
    ]);
  }

  private async setHours(staffId: string, hours: Weekly | null, now: number): Promise<void> {
    await this.db.batch([
      {
        sql: "DELETE FROM availability_rules WHERE kind = 'open' AND service_id IS NULL AND resource_id = ?",
        params: [staffId],
        method: "run",
      },
      ...(hours
        ? [
            {
              sql: "INSERT INTO availability_rules (id, service_id, resource_id, kind, weekly, created_at) VALUES (?, NULL, ?, 'open', ?, ?)",
              params: [ulid(now), staffId, JSON.stringify(hours), now],
              method: "run" as const,
            },
          ]
        : []),
    ]);
  }

  private async view(id: string): Promise<StaffView> {
    const v = (await staffViews(this.db, { all: true })).find((s) => s.id === id);
    if (!v) throw unknownStaffId();
    return v;
  }
}

function unknownStaffId(): WriteError {
  return new WriteError("not_found", "No one on your staff has that id.", {
    fields: [{ path: "staff_id", problem: "invalid", message: "unknown member of staff" }],
  });
}

/** The staff tied to services, by service, for the owner app's service list. */
export async function staffByService(db: Db, serviceIds: readonly string[]): Promise<Map<string, string[]>> {
  if (serviceIds.length === 0) return new Map();
  const rows = await db.orm
    .select({ serviceId: serviceResources.serviceId, resourceId: serviceResources.resourceId })
    .from(serviceResources)
    .where(inArray(serviceResources.serviceId, [...serviceIds]));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.serviceId, [...(out.get(r.serviceId) ?? []), r.resourceId]);
  return out;
}
