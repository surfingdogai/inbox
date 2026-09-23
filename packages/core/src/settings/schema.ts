import { z } from "zod";
import type { Db } from "../db";
import { settings as settingsTable } from "../schema/tables";
import { canonicalNetworkOrigin, networkOriginOfUrl } from "../util/hosts";

/**
 * The settings document: one versioned, Zod-validated JSON. It grows toward the full wizard;
 * these are the fields the write path needs today.
 *
 * What is stored is the raw document the owner wrote, merged key by key (`merge.ts`), never the
 * parsed result: a key this version does not know is kept for the version that does, and a
 * default is never written back as if the owner had chosen it. Reading is lenient
 * (`parseStoredSettings`): a stored value this version rejects falls back to its own default and
 * nothing else moves, so one bad field can never reset the rest of the document.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** The network a fresh instance lists, switched off, so joining it is one switch away. */
export const DEFAULT_NETWORK = "https://network.surfingdog.ai";

/** At most this many networks, the same bound as a receipt's `per` claim (ADR-017 §8.1). */
export const MAX_NETWORKS = 8;

/**
 * One network (ADR-017 §8.1), keyed by its origin in `networks`. Switching one off is
 * `enabled: false`; its receipts stay queued for it, and switching it on again publishes them.
 */
export const networkEntrySchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe("Report to this network: register, ping every hour, and publish what `share` allows."),
  issue: z
    .boolean()
    .default(true)
    .describe("Whether this network may issue a key to a first-time customer through this inbox. Not used yet."),
  share: z
    .object({
      listing: z
        .boolean()
        .default(true)
        .describe(
          "Be listed in the network's directory. A network takes counts and receipts only from an inbox registered with it, so the inbox registers while any of the three is on.",
        ),
      counts: z
        .boolean()
        .default(true)
        .describe("Send the hourly counts of new bookings, orders, quotes and messages."),
      receipts: z
        .boolean()
        .default(true)
        .describe("Publish every receipt and acknowledgement; the manifest names the network under review_services."),
    })
    .prefault({}),
});
export type NetworkEntry = z.infer<typeof networkEntrySchema>;
export type NetworkShare = keyof NetworkEntry["share"];

const disabledNetwork = (): NetworkEntry => networkEntrySchema.parse({});
const defaultNetworks = (): Record<string, NetworkEntry> => ({ [DEFAULT_NETWORK]: disabledNetwork() });

const sections = {
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
  testMode: z.boolean().default(false),
};

export const NETWORK_KEY_RULE =
  "a network is an https origin on a public host, like https://network.example.com: no path, no port other than 443";

/** The top-level keys a settings write may name; `network` is the legacy spelling, translated. */
export const SETTINGS_KEYS: ReadonlySet<string> = new Set([...Object.keys(sections), "networks", "network"]);

/**
 * Reading: keys are canonicalised, anything that is not an https origin is dropped, and at most
 * eight are kept (switched-on ones first), so a hand-edited document can never break the rest.
 * Each entry falls back to a switched-off one when it does not parse (ADR-017 §8.1).
 */
const networksRead = z
  .preprocess(
    cleanNetworks,
    z.record(
      z.string(),
      networkEntrySchema.catch(() => disabledNetwork()),
    ),
  )
  .default(defaultNetworks);

/** Writing: the same shape, strict — a bad key or entry is a field error, never a silent "off". */
const networksWrite = z
  .record(z.string(), networkEntrySchema)
  .superRefine((networks, ctx) => {
    for (const key of Object.keys(networks)) {
      if (canonicalNetworkOrigin(key) !== key) {
        ctx.addIssue({ code: "custom", path: [key], message: NETWORK_KEY_RULE });
      }
    }
    if (Object.keys(networks).length > MAX_NETWORKS) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${MAX_NETWORKS} networks; remove one that is switched off first`,
      });
    }
  })
  .default(defaultNetworks);

/** The settings as every reader sees them. Parse stored documents with `parseStoredSettings`. */
export const settingsSchema = z.preprocess(migrateLegacyNetwork, z.object({ ...sections, networks: networksRead }));
/** The strict form a write is checked against before anything is stored. */
export const settingsWriteSchema = z.preprocess(
  migrateLegacyNetwork,
  z.object({ ...sections, networks: networksWrite }),
);
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/**
 * Before `networks` there was one network: `network: { url, join }`. When a stored document has
 * no `networks` yet, the legacy pair is read as a map with one entry, so an instance that had
 * joined keeps reporting to the same network after the upgrade with nothing for the owner to do.
 * A legacy URL that was never usable (not https on a public host) yields no entry, as it never
 * reached a network before either.
 */
export function legacyNetworks(legacy: unknown): Record<string, unknown> {
  const l = isPlainObject(legacy) ? legacy : {};
  const origin = l.url === undefined ? DEFAULT_NETWORK : networkOriginOfUrl(l.url);
  if (!origin) return {};
  return {
    [origin]: { enabled: l.join === true, issue: true, share: { listing: true, counts: true, receipts: true } },
  };
}

function migrateLegacyNetwork(raw: unknown): unknown {
  if (!isPlainObject(raw) || raw.networks !== undefined || !isPlainObject(raw.network)) return raw;
  return { ...raw, networks: legacyNetworks(raw.network) };
}

function cleanNetworks(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const kept: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(raw)) {
    const origin = canonicalNetworkOrigin(key);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    kept.push([origin, entry]);
  }
  if (kept.length > MAX_NETWORKS) {
    const on = (e: unknown) => isPlainObject(e) && e.enabled === true;
    const keep = new Set([...kept.filter(([, e]) => on(e)), ...kept.filter(([, e]) => !on(e))].slice(0, MAX_NETWORKS));
    return Object.fromEntries(kept.filter((k) => keep.has(k)));
  }
  return Object.fromEntries(kept);
}

/**
 * A stored document as this version reads it. A value it rejects is left out, so its default
 * applies, and only that value: the rest of the document stands. `ignored` names what was left
 * out (`booking.autoExpireHours`), for whoever wants to tell the owner.
 */
export function parseStoredSettings(raw: unknown): { settings: Settings; ignored: string[] } {
  let doc: unknown = isPlainObject(raw) ? structuredClone(raw) : {};
  const ignored: string[] = [];
  // Each pass removes at least one offending value, so this ends; the bound is only a backstop.
  for (let pass = 0; pass < 50; pass++) {
    const parsed = settingsSchema.safeParse(doc);
    if (parsed.success) return { settings: parsed.data, ignored };
    let removed = false;
    for (const issue of parsed.error.issues) {
      // An array is one value to the owner: a bad element drops the list, not the element.
      const cut = issue.path.findIndex((p) => typeof p !== "string");
      const path = (cut === -1 ? issue.path : issue.path.slice(0, cut)).map(String);
      if (path.length === 0) {
        doc = {};
        removed = true;
        break;
      }
      if (deleteAt(doc, path)) {
        ignored.push(path.join("."));
        removed = true;
      }
    }
    if (!removed) break;
  }
  return { settings: DEFAULT_SETTINGS, ignored: [...ignored, "(the whole document)"] };
}

function deleteAt(doc: unknown, path: readonly string[]): boolean {
  let node: unknown = doc;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(node)) return false;
    node = node[key];
  }
  const last = path[path.length - 1];
  if (!isPlainObject(node) || last === undefined || !(last in node)) return false;
  delete node[last];
  return true;
}

export async function readSettings(db: Db): Promise<Settings> {
  const [row] = await db.orm.select({ doc: settingsTable.doc }).from(settingsTable).limit(1);
  if (!row) return DEFAULT_SETTINGS;
  return parseStoredSettings(row.doc).settings;
}

/**
 * The networks that are switched on, by origin, sorted. With `share`, only those that share that:
 * `"receipts"` is who receipts are published to and who the manifest names.
 */
export function enabledNetworks(settings: Settings, share?: NetworkShare): string[] {
  return Object.entries(settings.networks)
    .filter(([, n]) => n.enabled && (share === undefined || n.share[share]))
    .map(([origin]) => origin)
    .sort();
}

/** Whether a switched-on network gets anything at all: with nothing to share there is no reason to call it. */
export function reportsTo(entry: NetworkEntry | undefined): entry is NetworkEntry {
  return !!entry?.enabled && (entry.share.listing || entry.share.counts || entry.share.receipts);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
