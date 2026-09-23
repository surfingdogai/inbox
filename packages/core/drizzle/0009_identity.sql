-- ADR-017 §2 and §8: people carried by their agents, customers the business already knows, and the
-- rules that may read either. Every statement is additive: an instance that never enables a network
-- and never meets a signed agent writes nothing new but its customers' contacts.
--
-- Who created an item, as the doors established it: the signed agent's key thumbprint, whether a
-- platform vouched for it (`vouched`), it held its own key (`self`) or nothing verified (`none`), and
-- the platform's origin; and how sure the inbox is that the customer is one it knows.
ALTER TABLE `items` ADD `agent_thumbprint` text;
--> statement-breakpoint
ALTER TABLE `items` ADD `agent_level` text;
--> statement-breakpoint
ALTER TABLE `items` ADD `agent_directory` text;
--> statement-breakpoint
ALTER TABLE `items` ADD `customer_match` text;
--> statement-breakpoint
-- On a weak match (the same email or phone as a customer the business knows, nothing more) the item
-- keeps a party of its own and names the known one here, for the owner and for a one-time code.
ALTER TABLE `items` ADD `possible_party_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `items_possible_party` ON `items` (`possible_party_id`);
--> statement-breakpoint
-- A party a one-time code proved to be another: its items, thread and links moved there in one batch.
ALTER TABLE `parties` ADD `merged_into` text;
--> statement-breakpoint
-- Every email and phone a party gave, normalised. A value may belong to many parties (unlike
-- `party_identities`, which is unique per value and was only ever read for the verified badge).
CREATE TABLE IF NOT EXISTS `party_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`party_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `party_contacts_party_value` ON `party_contacts` (`party_id`,`kind`,`value`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `party_contacts_value` ON `party_contacts` (`kind`,`value`,`created_at`);
--> statement-breakpoint
-- Whatever `party_identities` holds keeps its verified badge. The rest of `parties.contact` is
-- normalised by a resumable job (SQL cannot punycode a domain), queued below.
INSERT OR IGNORE INTO `party_contacts` (`id`, `party_id`, `kind`, `value`, `verified_at`, `created_at`)
SELECT `id`, `party_id`, `kind`, `value_normalized`, `verified_at`, `created_at` FROM `party_identities`
 WHERE `kind` IN ('email', 'phone');
--> statement-breakpoint
-- A party's person at a network: the pairwise id (ppid) that network gave this business, the hash of
-- the pass that last presented it, and the standing it last returned. One party per ppid.
CREATE TABLE IF NOT EXISTS `person_links` (
	`party_id` text NOT NULL,
	`network` text NOT NULL,
	`ppid` text NOT NULL,
	`pass_hash` text,
	`person` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`party_id`, `network`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `person_links_ppid` ON `person_links` (`network`,`ppid`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `person_links_pass` ON `person_links` (`pass_hash`);
--> statement-breakpoint
-- What networks answered, for a while, keyed by hashes only.
CREATE TABLE IF NOT EXISTS `network_cache` (
	`network` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`network`, `kind`, `key`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `network_cache_expires` ON `network_cache` (`expires_at`);
--> statement-breakpoint
-- A first contact's issuance per network; the key and first pass sealed until delivered, seven days at most.
CREATE TABLE IF NOT EXISTS `pending_identity` (
	`item_id` text NOT NULL,
	`network` text NOT NULL,
	`state` text NOT NULL,
	`key_enc` text,
	`pass_enc` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `network`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pending_identity_key` ON `pending_identity` (`delivered_at`,`created_at`);
--> statement-breakpoint
-- One-time codes for customers the business knows: hashed, by the hash of the address they went to.
CREATE TABLE IF NOT EXISTS `customer_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`destination_hash` text NOT NULL,
	`item_id` text NOT NULL,
	`party_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_codes_destination` ON `customer_codes` (`destination_hash`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_codes_item` ON `customer_codes` (`item_id`,`created_at`);
--> statement-breakpoint
-- The signed agents that carried customers here, by key thumbprint: recorded, never trusted.
CREATE TABLE IF NOT EXISTS `carrying_agents` (
	`thumbprint` text PRIMARY KEY NOT NULL,
	`level` text NOT NULL,
	`platform` text,
	`label` text,
	`items` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
-- The contacts backfill: one job walking `parties` by id, 200 at a time, each run queueing the next.
INSERT OR IGNORE INTO `jobs` (`id`, `kind`, `payload`, `run_at`, `status`, `attempts`, `max_attempts`, `dedupe_key`, `created_at`)
SELECT 'party_contacts_backfill_0009', 'party_contacts_backfill', '{"after":""}', unixepoch() * 1000, 'queued', 0, 8,
       'party_contacts_backfill:', unixepoch() * 1000
 WHERE EXISTS (SELECT 1 FROM `parties`);
--> statement-breakpoint
-- A rule that reads a customer's record and wanted to refuse them is held back (§8.3), and the item's
-- history says so for the owner (`rule_skipped`). That is a note to the owner, not something that
-- happened to the item: the developer event stream and webhooks leave it out, so the view is the
-- one of 0007 with that one line added.
DROP VIEW IF EXISTS `events_v1`;
--> statement-breakpoint
CREATE VIEW `events_v1` AS SELECT
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
  json_extract(e."meta", '$.actor_name') AS "actor_name",
  COALESCE(json_extract(e."meta", '$.channel'), i."channel") AS "channel",
  e."event" AS "event",
  'item_event' AS "source"
FROM "item_events" e JOIN "items" i ON i."id" = e."item_id"
WHERE e."event" <> 'rule_skipped'
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
  NULL,
  t."channel",
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
  NULL,
  'system',
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
  NULL,
  NULL,
  'receipt_acknowledged',
  'receipt_ack'
FROM "receipts" r JOIN "items" i ON i."id" = r."item_id"
WHERE r."ack_at" IS NOT NULL;
