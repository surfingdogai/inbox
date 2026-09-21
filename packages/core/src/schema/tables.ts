import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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

export const signingKeys = sqliteTable("signing_keys", {
  kid: text("kid").primaryKey(),
  publicJwk: text("public_jwk", { mode: "json" }).notNull(),
  privateJwkEnc: text("private_jwk_enc").notNull(),
  purpose: text("purpose").notNull().default("receipts"),
  createdAt: createdAt(),
  retiredAt: integer("retired_at"),
});

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

export const connectors = sqliteTable("connectors", {
  id: id(),
  kind: text("kind").notNull(),
  configEnc: text("config_enc").notNull(),
  status: text("status").notNull().default("configured"),
  lastError: text("last_error"),
  lastSyncAt: integer("last_sync_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const webhooks = sqliteTable("webhooks", {
  id: id(),
  url: text("url").notNull(),
  secretEnc: text("secret_enc").notNull(),
  events: text("events", { mode: "json" }).notNull(),
  active: integer("active").notNull().default(1),
  createdAt: createdAt(),
});

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: id(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id),
    eventId: text("event_id").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAt: integer("next_at"),
    lastStatus: integer("last_status"),
    createdAt: createdAt(),
  },
  (t) => [unique("webhook_deliveries_once").on(t.webhookId, t.eventId)],
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
