import { type Caller, Capabilities, type Db, PRESETS, schema, ulid } from "@surfingdog/core";
import { eq } from "drizzle-orm";

/**
 * A demo business so a fresh instance has something to show: Oficina Maré, a bicycle workshop in
 * Ericeira. Idempotent; never touches an instance that already has a business row.
 */
export async function seedDemo(db: Db, now = Date.now()): Promise<{ seeded: boolean }> {
  const [existing] = await db.orm
    .select({ id: schema.business.id })
    .from(schema.business)
    .where(eq(schema.business.id, "self"));
  if (existing) return { seeded: false };
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    domain: "oficinamare.pt",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    createdAt: now,
    updatedAt: now,
  });
  const full = ulid();
  const puncture = ulid();
  await db.orm.insert(schema.services).values([
    {
      id: full,
      name: "Full service",
      description: "Brakes, gears, wheels, bearings, a clean and a test ride.",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      price: { model: "fixed", value: 4500, currency: "EUR" },
      sort: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: puncture,
      name: "Puncture repair",
      description: "Tube or tubeless, while you wait.",
      durationMin: 30,
      capacity: 2,
      granularityMin: 15,
      price: { model: "fixed", value: 1200, currency: "EUR" },
      sort: 2,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.orm.insert(schema.products).values([
    {
      id: ulid(),
      sku: "SM-700-35",
      name: "Schwalbe Marathon 700×35",
      price: { value: 3920, currency: "EUR" },
      stock: 6,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: ulid(),
      sku: "CH-9",
      name: "Chain, 9-speed",
      price: { value: 1850, currency: "EUR" },
      stock: 12,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const hours: [string, string][] = [["09:00", "18:00"]];
  await db.orm.insert(schema.availabilityRules).values({
    id: ulid(),
    kind: "open",
    weekly: { mon: hours, tue: hours, wed: hours, thu: hours, fri: hours, sat: [["09:00", "13:00"]] },
    createdAt: now,
  });
  await db.orm.insert(schema.rules).values(
    (PRESETS.appointments ?? []).map((p) => ({
      id: ulid(),
      name: p.name,
      priority: p.priority,
      enabled: 1,
      definition: p.definition,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const caps = new Capabilities(db);
  const system: Caller = {
    actor: { kind: "system", id: "seed", channel: "system" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
  };
  await caps.updateSettings(system, {
    doc: {
      business: { name: "Oficina Maré", timezone: "Europe/Lisbon", currency: "EUR", languages: ["pt", "en"] },
      booking: { cancellationWindowMin: 120 },
    },
  });
  return { seeded: true };
}
