import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, sqliteView, text, unique } from "drizzle-orm/sqlite-core";

/**
 * The one schema, shared by every runtime. Conventions (ADR-011): TEXT ULID ids, INTEGER
 * milliseconds UTC, INTEGER 0/1 booleans, JSON as TEXT, no BLOB columns (binaries go to Blob
 * storage). Item payloads are JSON with virtual generated columns for what we filter on, so a new
 * item type needs no migration.
 */
const id = () => text("id").primaryKey();
const createdAt = () => integer("created_at").notNull();
const updatedAt = () => integer("updated_at").notNull();

export const business = sqliteTable("business", {
  id: text("id").primaryKey().default("self"),
  name: text("name").notNull().default(""),
  domain: text("domain"),
  timezone: text("timezone").notNull().default("UTC"),
  currency: text("currency").notNull().default("EUR"),
  languages: text("languages", { mode: "json" }).$type<string[]>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const settings = sqliteTable("settings", {
  id: text("id").primaryKey().default("singleton"),
  schemaVersion: integer("schema_version").notNull(),
  doc: text("doc", { mode: "json" }).notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
});

export const locations = sqliteTable("locations", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone"),
  address: text("address", { mode: "json" }),
  createdAt: createdAt(),
});

export const services = sqliteTable(
  "services",
  {
    id: id(),
    locationId: text("location_id").references(() => locations.id),
    name: text("name").notNull(),
    description: text("description"),
    durationMin: integer("duration_min").notNull().default(60),
    bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
    bufferAfterMin: integer("buffer_after_min").notNull().default(0),
    capacity: integer("capacity").notNull().default(1),
    granularityMin: integer("granularity_min").notNull().default(15),
    price: text("price", { mode: "json" }).$type<{
      model: "fixed" | "from" | "quote";
      value?: number;
      currency?: string;
    }>(),
    active: integer("active").notNull().default(1),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("services_active_sort").on(t.active, t.sort)],
);

export const resources = sqliteTable("resources", {
  id: id(),
  locationId: text("location_id").references(() => locations.id),
  name: text("name").notNull(),
  capacity: integer("capacity").notNull().default(1),
  active: integer("active").notNull().default(1),
  createdAt: createdAt(),
});

export const products = sqliteTable(
  "products",
  {
    id: id(),
    locationId: text("location_id").references(() => locations.id),
    sku: text("sku"),
    name: text("name").notNull(),
    description: text("description"),
    price: text("price", { mode: "json" }).$type<{ value: number; currency: string }>().notNull(),
    stock: integer("stock"),
    source: text("source").notNull().default("builtin"),
    externalId: text("external_id"),
    active: integer("active").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("products_sku").on(t.sku), index("products_source_external").on(t.source, t.externalId)],
);

export const availabilityRules = sqliteTable("availability_rules", {
  id: id(),
  serviceId: text("service_id").references(() => services.id),
  resourceId: text("resource_id").references(() => resources.id),
  locationId: text("location_id").references(() => locations.id),
  kind: text("kind").notNull(),
  weekly: text("weekly", { mode: "json" }),
  validFrom: integer("valid_from"),
  validTo: integer("valid_to"),
  createdAt: createdAt(),
});

export const parties = sqliteTable("parties", {
  id: id(),
  kind: text("kind").notNull(),
  displayName: text("display_name"),
  locale: text("locale"),
  contact: text("contact", { mode: "json" }),
  notes: text("notes"),
  erasedAt: integer("erased_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const partyIdentities = sqliteTable(
  "party_identities",
  {
    id: id(),
    partyId: text("party_id")
      .notNull()
      .references(() => parties.id),
    kind: text("kind").notNull(),
    valueNormalized: text("value_normalized").notNull(),
    evidence: text("evidence", { mode: "json" }),
    verifiedAt: integer("verified_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("party_identities_kind_value").on(t.kind, t.valueNormalized),
    index("party_identities_party").on(t.partyId),
  ],
);

export const agents = sqliteTable("agents", {
  id: id(),
  partyId: text("party_id")
    .notNull()
    .references(() => parties.id),
  name: text("name"),
  operator: text("operator"),
  homepageHost: text("homepage_host"),
  jwk: text("jwk", { mode: "json" }),
  jwkThumbprint: text("jwk_thumbprint").unique(),
  tier: text("tier").notNull().default("anonymous"),
  verifiedAt: integer("verified_at"),
  createdAt: createdAt(),
  lastSeenAt: integer("last_seen_at"),
});

export const items = sqliteTable(
  "items",
  {
    id: id(),
    type: text("type").notNull(),
    state: text("state").notNull(),
    version: integer("version").notNull().default(1),
    partyId: text("party_id")
      .notNull()
      .references(() => parties.id),
    locationId: text("location_id").references(() => locations.id),
    channel: text("channel").notNull(),
    subject: text("subject"),
    linkedItemId: text("linked_item_id"),
    accessTokenHash: text("access_token_hash"),
    payload: text("payload", { mode: "json" }).notNull(),
    flags: text("flags", { mode: "json" }).notNull(),
    needsHuman: integer("needs_human").generatedAlwaysAs(sql`json_extract("flags", '$.needsHuman')`, {
      mode: "virtual",
    }),
    sandbox: integer("sandbox").generatedAlwaysAs(sql`json_extract("flags", '$.sandbox')`, { mode: "virtual" }),
    priority: integer("priority").generatedAlwaysAs(sql`json_extract("flags", '$.priority')`, { mode: "virtual" }),
    startAt: text("start_at").generatedAlwaysAs(sql`json_extract("payload", '$.startTime')`, { mode: "virtual" }),
    amountMinor: integer("amount_minor").generatedAlwaysAs(sql`json_extract("payload", '$.totalPrice.value')`, {
      mode: "virtual",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: integer("closed_at"),
  },
  (t) => [
    index("items_type_state").on(t.type, t.state, t.updatedAt),
    index("items_party").on(t.partyId, t.createdAt),
    index("items_start").on(t.type, t.startAt),
    index("items_needs_human").on(t.needsHuman, t.updatedAt),
    index("items_sandbox").on(t.sandbox, t.updatedAt),
    index("items_location").on(t.locationId, t.type, t.state),
    index("items_access_token").on(t.accessTokenHash),
  ],
);

export const itemEvents = sqliteTable(
  "item_events",
  {
    id: id(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    seq: integer("seq").notNull(),
    event: text("event").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason"),
    diff: text("diff", { mode: "json" }),
    meta: text("meta", { mode: "json" }),
    causationId: text("causation_id"),
    depth: integer("depth").notNull().default(0),
    createdAt: createdAt(),
  },
  // The compare-and-set of every write (ADR-007): one event per version, never two.
  (t) => [unique("item_events_item_seq").on(t.itemId, t.seq), index("item_events_created").on(t.createdAt)],
);

export const threadEntries = sqliteTable(
  "thread_entries",
  {
    id: id(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    direction: text("direction").notNull(),
    channel: text("channel").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id"),
    partyId: text("party_id"),
    subject: text("subject"),
    bodyText: text("body_text").notNull(),
    bodyFormat: text("body_format").notNull().default("text"),
    rawBlobKey: text("raw_blob_key"),
    attachments: text("attachments", { mode: "json" }),
    messageId: text("message_id").unique(),
    inReplyTo: text("in_reply_to"),
    createdAt: createdAt(),
  },
  (t) => [index("thread_entries_item").on(t.itemId, t.createdAt)],
);

export const slotClaims = sqliteTable(
  "slot_claims",
  {
    resourceKey: text("resource_key").notNull(),
    bucketStart: integer("bucket_start").notNull(),
    ordinal: integer("ordinal").notNull(),
    itemId: text("item_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.resourceKey, t.bucketStart, t.ordinal] }), index("slot_claims_item").on(t.itemId)],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: integer("status").notNull(),
    response: text("response", { mode: "json" }).notNull(),
    itemId: text("item_id"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] }), index("idempotency_created").on(t.createdAt)],
);

export const receipts = sqliteTable(
  "receipts",
  {
    id: id(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    kind: text("kind").notNull(),
    jws: text("jws").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    kid: text("kid").notNull(),
    subjectHash: text("subject_hash").notNull(),
    issuedAt: integer("issued_at").notNull(),
    ackJws: text("ack_jws"),
    ackAt: integer("ack_at"),
  },
  (t) => [unique("receipts_item_kind").on(t.itemId, t.kind)],
);

/**
 * Whether each network has each receipt yet (ADR-017 §3.3, §8.1): one row per receipt, network
 * (its origin) and stage, `queued` until the network accepts it (`published`) or refuses it for
 * good (`refused`). The hourly publisher per network posts what is still queued, so this table,
 * not a job, is what says a receipt is owed; a job that dies loses nothing.
 */
export const networkPublications = sqliteTable(
  "network_publications",
  {
    receiptId: text("receipt_id").notNull(),
    network: text("network").notNull(),
    stage: text("stage").notNull(),
    state: text("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.receiptId, t.network, t.stage] }),
    index("network_publications_queue").on(t.network, t.state, t.receiptId),
  ],
);

/**
 * What the owner sees per network: registration, the last ping it took, and the last error in a
 * few words. `failures` counts calls that failed in a row, for the circuit breaker; any success
 * resets it and clears `failing_since`.
 */
export const networkStatus = sqliteTable("network_status", {
  network: text("network").primaryKey(),
  registration: text("registration").notNull().default("unregistered"),
  registeredAt: integer("registered_at"),
  lastPingAt: integer("last_ping_at"),
  lastError: text("last_error"),
  lastErrorAt: integer("last_error_at"),
  failingSince: integer("failing_since"),
  failures: integer("failures").notNull().default(0),
  updatedAt: updatedAt(),
});

export const signingKeys = sqliteTable("signing_keys", {
  kid: text("kid").primaryKey(),
  publicJwk: text("public_jwk", { mode: "json" }).notNull(),
  privateJwkEnc: text("private_jwk_enc").notNull(),
  purpose: text("purpose").notNull().default("receipts"),
  createdAt: createdAt(),
  retiredAt: integer("retired_at"),
});

/** Unused since 0000. Publications live in `network_publications`, whose key names the network. */
export const reviewsOutbox = sqliteTable("reviews_outbox", {
  id: id(),
  itemId: text("item_id").notNull(),
  receiptId: text("receipt_id"),
  fact: text("fact", { mode: "json" }).notNull(),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  sentAt: integer("sent_at"),
  createdAt: createdAt(),
});

export const rules = sqliteTable("rules", {
  id: id(),
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  definition: text("definition", { mode: "json" }).notNull(),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A connector is a row, not a setting (ADR-015 §1): settings is one document under one optimistic
 * version, and `get_settings` hands it verbatim to every connected AI, secrets and all.
 */
export const connectors = sqliteTable(
  "connectors",
  {
    id: id(),
    /** The platform: `shopify`, `woocommerce`, `feed`, … */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /** The platform's own identifier for this account: a shop domain, a store id, a feed URL. */
    externalId: text("external_id"),
    /** Credentials, sealed by the secret box. Null for a connector that needs none, like a feed. */
    configEnc: text("config_enc"),
    /** The non-secret mirror, so Settings can list and disconnect even if the instance key is lost. */
    configPublic: text("config_public", { mode: "json" }).notNull().default({}),
    /** Where the last sync got to. Written only by sync jobs, so one never overwrites an owner edit. */
    cursor: text("cursor"),
    /** The unguessable path segment of this connector's inbound URL. */
    inboundToken: text("inbound_token"),
    /** `configured` | `active` | `error` | `disabled`. */
    status: text("status").notNull().default("configured"),
    lastError: text("last_error"),
    lastErrorAt: integer("last_error_at"),
    lastSyncAt: integer("last_sync_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("connectors_kind_external").on(t.kind, t.externalId),
    unique("connectors_inbound_token").on(t.inboundToken),
    index("connectors_status").on(t.status),
  ],
);

/** The inbound mirror of `webhook_deliveries`: what a platform sent us, and what we made of it. */
export const connectorEvents = sqliteTable(
  "connector_events",
  {
    id: id(),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id),
    /** The platform's delivery id. Unique per connector, so a redelivery is ignored, not doubled. */
    externalId: text("external_id").notNull(),
    topic: text("topic").notNull(),
    receivedAt: integer("received_at").notNull(),
    /** `pending` | `handled` | `ignored` | `failed`. */
    status: text("status").notNull().default("pending"),
    itemId: text("item_id"),
    handledAt: integer("handled_at"),
    error: text("error"),
    /** The body exactly as received, so a handler can be fixed and the event replayed. */
    raw: text("raw").notNull(),
  },
  (t) => [
    unique("connector_events_once").on(t.connectorId, t.externalId),
    index("connector_events_pending").on(t.status, t.receivedAt),
  ],
);

/** Where events go (ADR-015 §3–§5): one row per endpoint the owner has added. */
export const webhooks = sqliteTable("webhooks", {
  id: id(),
  url: text("url").notNull(),
  /** The Standard Webhooks signing secret (`whsec_…`), sealed by the secret box. */
  secretEnc: text("secret_enc").notNull(),
  events: text("events", { mode: "json" }).$type<string[]>().notNull(),
  /** `thin` sends a pointer; `full` sends customer data to this address, and says so in Settings. */
  payloadStyle: text("payload_style").notNull().default("thin"),
  active: integer("active").notNull().default(1),
  /** First failure of the current run of failures; five days of them deactivates the endpoint. */
  failingSince: integer("failing_since"),
  disabledAt: integer("disabled_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: id(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id),
    /** The `events_v1` id, which is also the `webhook-id` header the receiver deduplicates on. */
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    /** `pending` | `delivered` | `failed`. */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAt: integer("next_at"),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
    deliveredAt: integer("delivered_at"),
  },
  (t) => [
    unique("webhook_deliveries_once").on(t.webhookId, t.eventId),
    index("webhook_deliveries_due").on(t.status, t.nextAt),
  ],
);

export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  role: text("role").notNull().default("owner"),
  locationId: text("location_id"),
  createdAt: createdAt(),
  lastLoginAt: integer("last_login_at"),
});

export const sessions = sqliteTable("sessions", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  lastSeenAt: integer("last_seen_at"),
});

export const loginTokens = sqliteTable("login_tokens", {
  hash: text("hash").primaryKey(),
  email: text("email").notNull(),
  kind: text("kind").notNull().default("magic_link"),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: createdAt(),
});

export const passkeys = sqliteTable("passkeys", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: text("transports", { mode: "json" }),
  name: text("name"),
  createdAt: createdAt(),
  lastUsedAt: integer("last_used_at"),
});

export const apiKeys = sqliteTable("api_keys", {
  id: id(),
  prefix: text("prefix").notNull(),
  hash: text("hash").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  partyId: text("party_id"),
  userId: text("user_id"),
  rateTier: text("rate_tier"),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
  createdAt: createdAt(),
});

export const oauthClients = sqliteTable("oauth_clients", {
  id: id(),
  name: text("name"),
  redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
  clientUri: text("client_uri"),
  logoUri: text("logo_uri"),
  kind: text("kind").notNull(),
  metadata: text("metadata", { mode: "json" }),
  createdAt: createdAt(),
  lastUsedAt: integer("last_used_at"),
});

export const oauthCodes = sqliteTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scope: text("scope").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource"),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: createdAt(),
});

export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    kind: text("kind").notNull(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource"),
    familyId: text("family_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
    rotatedFrom: text("rotated_from"),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_tokens_family").on(t.familyId)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    runAt: integer("run_at").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    leaseUntil: integer("lease_until"),
    leasedBy: text("leased_by"),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key").unique(),
    createdAt: createdAt(),
    doneAt: integer("done_at"),
  },
  (t) => [index("jobs_due").on(t.status, t.runAt)],
);

export const blobs = sqliteTable("blobs", {
  key: text("key").primaryKey(),
  size: integer("size").notNull(),
  contentType: text("content_type").notNull(),
  sha256: text("sha256"),
  kind: text("kind").notNull(),
  itemId: text("item_id"),
  partyId: text("party_id"),
  createdAt: createdAt(),
  deletedAt: integer("deleted_at"),
});

export const rateLimits = sqliteTable("rate_limits", {
  bucket: text("bucket").primaryKey(),
  tokens: real("tokens").notNull(),
  updatedAt: updatedAt(),
});

export const keyDirectories = sqliteTable("key_directories", {
  origin: text("origin").primaryKey(),
  jwks: text("jwks", { mode: "json" }).notNull(),
  etag: text("etag"),
  fetchedAt: integer("fetched_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  failures: integer("failures").notNull().default(0),
});

export const sigNonces = sqliteTable(
  "sig_nonces",
  {
    keyid: text("keyid").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyid, t.nonce] })],
);

export const actionLinks = sqliteTable("action_links", {
  jti: text("jti").primaryKey(),
  itemId: text("item_id").notNull(),
  action: text("action").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: createdAt(),
});

/**
 * The developer event stream (ADR-015 §6): a view, not a second events table. Both arms have ULID
 * primary keys, so `WHERE id > ? ORDER BY id LIMIT ?` is an index range scan and replay is free —
 * and there is no dual write to keep honest. `item_version` is the version the event produced; on
 * the inbound-message arm, where a thread entry does not bump the version, it is the item's
 * version as it stands.
 */
export const eventsV1 = sqliteView("events_v1", {
  id: text("id").notNull(),
  type: text("type").notNull(),
  createdAt: integer("created_at").notNull(),
  itemId: text("item_id").notNull(),
  itemType: text("item_type").notNull(),
  itemState: text("item_state").notNull(),
  itemVersion: integer("item_version").notNull(),
  partyId: text("party_id").notNull(),
  sandbox: integer("sandbox").notNull(),
  actorKind: text("actor_kind").notNull(),
  actorId: text("actor_id"),
  event: text("event").notNull(),
  source: text("source").notNull(),
}).as(sql`SELECT
  e."id" AS "id",
  i."type" || '.' || e."event" AS "type",
  e."created_at" AS "created_at",
  e."item_id" AS "item_id",
  i."type" AS "item_type",
  e."to_state" AS "item_state",
  e."seq" AS "item_version",
  i."party_id" AS "party_id",
  COALESCE(i."sandbox", 0) AS "sandbox",
  e."actor_kind" AS "actor_kind",
  e."actor_id" AS "actor_id",
  e."event" AS "event",
  'item_event' AS "source"
FROM "item_events" e JOIN "items" i ON i."id" = e."item_id"
UNION ALL
SELECT
  t."id",
  i."type" || '.message',
  t."created_at",
  t."item_id",
  i."type",
  i."state",
  i."version",
  i."party_id",
  COALESCE(i."sandbox", 0),
  t."actor_kind",
  t."actor_id",
  'message',
  'thread_entry'
FROM "thread_entries" t JOIN "items" i ON i."id" = t."item_id"
WHERE t."direction" = 'in'
UNION ALL
SELECT
  r."id",
  i."type" || '.receipt_issued',
  r."issued_at",
  r."item_id",
  i."type",
  i."state",
  i."version",
  i."party_id",
  COALESCE(i."sandbox", 0),
  'system',
  NULL,
  'receipt_issued',
  'receipt'
FROM "receipts" r JOIN "items" i ON i."id" = r."item_id"
UNION ALL
SELECT
  r."id" || ':ack',
  i."type" || '.receipt_acknowledged',
  r."ack_at",
  r."item_id",
  i."type",
  i."state",
  i."version",
  i."party_id",
  COALESCE(i."sandbox", 0),
  'customer_agent',
  NULL,
  'receipt_acknowledged',
  'receipt_ack'
FROM "receipts" r JOIN "items" i ON i."id" = r."item_id"
WHERE r."ack_at" IS NOT NULL`);
