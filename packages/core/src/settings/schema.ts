import { z } from "zod";
import type { Db } from "../db";
import { settings as settingsTable } from "../schema/tables";

/**
 * The settings document: one versioned, Zod-validated JSON. the first release grows this to the full
 * wizard; these are the fields the write path needs today. Unknown keys are kept on read so a
 * newer document survives an older reader.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

export const settingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION).default(SETTINGS_SCHEMA_VERSION),
  business: z
    .object({
      name: z.string().max(200).default(""),
      timezone: z.string().max(64).default("UTC"),
      currency: z.string().length(3).default("EUR"),
      languages: z.array(z.string().max(12)).default(["en"]),
    })
    .prefault({}),
  booking: z
    .object({
      /** Minutes before the start time until which a customer may cancel a confirmed booking. */
      cancellationWindowMin: z
        .number()
        .int()
        .min(0)
        .default(24 * 60),
      /** Hold the slot while a proposal is pending. */
      holdOnPropose: z.boolean().default(false),
      /** Requests nobody answered expire after this many hours. */
      autoExpireHours: z.number().int().min(1).default(72),
    })
    .prefault({}),
  orders: z.object({ maxValueWithoutApprovalMinor: z.number().int().min(0).default(0) }).prefault({}),
  testMode: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export async function readSettings(db: Db): Promise<Settings> {
  const [row] = await db.orm.select({ doc: settingsTable.doc }).from(settingsTable).limit(1);
  if (!row) return DEFAULT_SETTINGS;
  const parsed = settingsSchema.safeParse(row.doc);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}
