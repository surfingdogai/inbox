-- The spam filter (ADR-041). A request from a sender this business has no history with is screened
-- once, as it arrives: delivered, delivered with a label, held until the sender confirms or a person
-- lets it in, or put aside. `screen` sits beside `state`, so no machine, receipt or network rule
-- changes for a hold. NULL: never screened (the business's own, a known customer, a reply, or an item
-- older than this).
-- 'pending' | 'delivered' | 'warned' | 'held' | 'aside' | 'released'
ALTER TABLE `items` ADD `screen` text;
--> statement-breakpoint
ALTER TABLE `items` ADD `screen_at` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `items_screen` ON `items` (`screen`, `created_at`) WHERE `screen` IN ('pending', 'held');
--> statement-breakpoint
-- What screening found: codes and numbers, never words. The AI check's answer is enums only;
-- `quotes` are passages of the sender's own masked text that the code found word for word.
CREATE TABLE IF NOT EXISTS `spam_verdicts` (
	`item_id` text PRIMARY KEY NOT NULL,
	`door` text NOT NULL,
	`verdict` text NOT NULL,
	`cause` text,
	`certain` integer DEFAULT 0 NOT NULL,
	`score` real NOT NULL,
	`signals` text NOT NULL,
	`ai` text DEFAULT 'none' NOT NULL,
	`answer` text,
	`quotes` text,
	`learning` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`ms` integer,
	`owner_verdict` text,
	`owner_at` integer,
	`released_by` text,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_verdicts_time` ON `spam_verdicts` (`verdict`, `created_at`);
--> statement-breakpoint
-- The owner's lists: Let through and Always put aside. Values in the clear (the owner reads and edits
-- them), with the party they came from, so erasing a customer erases their rows.
CREATE TABLE IF NOT EXISTS `spam_lists` (
	`list` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`party_id` text,
	`item_id` text,
	`by_user` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`list`, `kind`, `value`)
);
--> statement-breakpoint
-- Prints of normalised text, for repeats and for the owner's marks: hashes and domains, never words.
-- `sender` is a keyed hash of who sent it, to count different senders; `sim` a 64-bit SimHash kept
-- as eight 8-bit bands for an indexed near-duplicate lookup: two prints up to seven bits apart always
-- share one.
CREATE TABLE IF NOT EXISTS `spam_prints` (
	`item_id` text PRIMARY KEY NOT NULL,
	`sender` text NOT NULL,
	`sha` text NOT NULL,
	`sim` text NOT NULL,
	`b0` integer NOT NULL,
	`b1` integer NOT NULL,
	`b2` integer NOT NULL,
	`b3` integer NOT NULL,
	`b4` integer NOT NULL,
	`b5` integer NOT NULL,
	`b6` integer NOT NULL,
	`b7` integer NOT NULL,
	`link_domains` text NOT NULL,
	`mark` integer DEFAULT 0 NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_sha` ON `spam_prints` (`sha`, `at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_b0` ON `spam_prints` (`b0`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_b1` ON `spam_prints` (`b1`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_b2` ON `spam_prints` (`b2`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_b3` ON `spam_prints` (`b3`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_b4` ON `spam_prints` (`b4`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_b5` ON `spam_prints` (`b5`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_b6` ON `spam_prints` (`b6`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_b7` ON `spam_prints` (`b7`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_prints_time` ON `spam_prints` (`at`);
--> statement-breakpoint
-- Who asked, as handles this inbox keeps its own history on: an agent's key, a network pass, a
-- mailbox, a mail domain, a network's code for whom it carried a request. Mailboxes and domains are
-- keyed hashes; keys and passes are public already. Never a client's network address.
CREATE TABLE IF NOT EXISTS `spam_handles` (
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`day` text,
	`firsts` integer DEFAULT 0 NOT NULL,
	`proven_at` integer,
	`trusted_at` integer,
	`marked_at` integer,
	`party_id` text,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `ref`)
);
--> statement-breakpoint
-- When each filter was on, and how: the filter-days a hosted inbox would be charged by are recounted
-- from these. 'basic' is the free protection's own learning week, from the day this migration ran.
CREATE TABLE IF NOT EXISTS `spam_filter_spans` (
	`id` text PRIMARY KEY NOT NULL,
	`filter` text NOT NULL,
	`choice` text DEFAULT 'aside' NOT NULL,
	`from_at` integer NOT NULL,
	`to_at` integer,
	`learning_until` integer,
	`by_kind` text NOT NULL,
	`by_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_filter_spans_filter` ON `spam_filter_spans` (`filter`, `from_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `spam_filter_spans` (`id`, `filter`, `choice`, `from_at`, `to_at`, `learning_until`, `by_kind`, `by_id`)
VALUES ('basic', 'basic', 'aside', unixepoch() * 1000, NULL, unixepoch() * 1000 + 604800000, 'system', 'migration');
--> statement-breakpoint
-- Counters by UTC day: judged, reused, capped, failed, tokens_in, tokens_out, aside, held, warned,
-- released, brought_back, marked, trap_over_cap. Metering: never purged with items.
CREATE TABLE IF NOT EXISTS `spam_days` (
	`day` text NOT NULL,
	`key` text NOT NULL,
	`n` integer NOT NULL,
	PRIMARY KEY(`day`, `key`)
);
--> statement-breakpoint
-- The AI check's answer for a text seen again within seven days, so a mass mailing costs one check;
-- and whether a mail domain takes mail at all, for thirty days.
CREATE TABLE IF NOT EXISTS `spam_cache` (
	`sha` text PRIMARY KEY NOT NULL,
	`answer` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `spam_domains` (
	`domain` text PRIMARY KEY NOT NULL,
	`mail` integer,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
-- The owner's own AI model on their own server (Settings → Integrations → Your AI model): which
-- provider and model, and the key they pasted once, sealed (`model-key`). One row; never downloaded.
CREATE TABLE IF NOT EXISTS `spam_model` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,          -- 'anthropic' | 'openai' | 'gemini'
	`model` text NOT NULL,
	`key_enc` text NOT NULL,
	`by_user` text NOT NULL,
	`set_at` integer NOT NULL,
	`tested_at` integer,
	`test` text                        -- JSON {"pitch":true,"customer":true}: what the last Test found
);
--> statement-breakpoint
-- A held request is nobody's event yet: the developer event stream (and so a webhook replay) leaves
-- out what happened to an item while it is held, and shows it once a person or the sender lets it in.
-- Otherwise the view of 0009, unchanged.
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
WHERE e."event" <> 'rule_skipped' AND COALESCE(i."screen", '') <> 'held'
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
WHERE t."direction" = 'in' AND COALESCE(i."screen", '') <> 'held'
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
