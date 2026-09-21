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
  notifications: z
    .object({
      /** Where the owner is told about new items; empty = no owner emails. */
      ownerEmail: z.email().optional(),
      /** Public base URL of the owner app, used in links. */
      appUrl: z.url().optional(),
    })
    .prefault({}),
  email: z
    .object({
      fromAddress: z.email().optional(),
      fromName: z.string().max(100).optional(),
      /** Customers reply here; usually the business mailbox. */
      replyTo: z.email().optional(),
      /** Shared secret for the raw-MIME inbound webhook (Mailgun routes, forwarders). */
      inboundSecret: z.string().min(16).max(200).optional(),
    })
    .prefault({}),
  integrations: z
    .object({
      /** Outbound webhooks (ADR-015 §3–§5): where this inbox sends its events. */
      webhooks: z
        .object({
          enabled: z.boolean().default(true).describe("Off, no endpoint is called and nothing is queued."),
          timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
          /** Attempts at 0s, 5s, 5m, 30m, 2h, 5h, 10h, 10h; the last delay repeats beyond eight. */
          maxAttempts: z.number().int().min(1).max(12).default(8),
          /** An endpoint that has done nothing but fail for this long is deactivated, never deleted. */
          disableAfterDays: z.number().int().min(1).max(30).default(5),
          retainDeliveryDays: z.number().int().min(1).max(90).default(30),
          /**
           * Allows an endpoint on a private, local or plain-http address. Only for a machine you
           * control: it lets anything with owner access make this instance call an internal host.
           */
          allowPrivateTargets: z.boolean().default(false),
        })
        .prefault({}),
      /** Product feeds (ADR-015 ship order 3): a catalogue from a URL, with no credentials at all. */
      feeds: z
        .object({
          enabled: z.boolean().default(true),
          refreshHours: z.number().int().min(1).max(168).default(6),
          maxProducts: z.number().int().min(1).max(50_000).default(5_000),
          /** Archive the products a feed stopped listing instead of leaving them on sale. */
          deactivateMissing: z.boolean().default(true),
        })
        .prefault({}),
      /** Platform connectors (ADR-015 §1): a connector is a row, so only its cadence lives here. */
      connectors: z
        .object({
          enabled: z.boolean().default(true),
          syncMinutes: z.number().int().min(5).max(1_440).default(15),
          retainEventDays: z.number().int().min(1).max(90).default(30),
        })
        .prefault({}),
    })
    .prefault({}),
  network: z
    .object({
      /** The directory this instance reports to and appears in. Any Surfing Dog network works. */
      url: z.url().default("https://network.surfingdog.ai"),
      /** Join the directory: register this instance and send counts-only telemetry every hour. */
      join: z.boolean().default(false),
    })
    .prefault({}),
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
