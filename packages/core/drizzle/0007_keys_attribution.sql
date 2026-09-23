-- Keys, scopes and attribution. Keys minted in the product are named, scoped and revocable, may
-- expire, and say who minted them; `last4` lets the owner tell two apart without the key itself.
ALTER TABLE `api_keys` ADD `expires_at` integer;
--> statement-breakpoint
ALTER TABLE `api_keys` ADD `created_by` text;
--> statement-breakpoint
ALTER TABLE `api_keys` ADD `last4` text;
--> statement-breakpoint
-- What a key or an AI app called outside its scopes, counted per principal and operation: the
-- record the owner reads while scopes are logged rather than enforced.
CREATE TABLE IF NOT EXISTS `scope_refusals` (
	`principal_id` text NOT NULL,
	`operation` text NOT NULL,
	`principal_kind` text NOT NULL,
	`principal_name` text,
	`scope` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`enforced` integer DEFAULT 0 NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`principal_id`, `operation`)
);
--> statement-breakpoint
-- Extra request headers per webhook endpoint, sealed like the signing secret; the names in the clear.
ALTER TABLE `webhooks` ADD `headers_enc` text;
--> statement-breakpoint
ALTER TABLE `webhooks` ADD `header_names` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
-- Every event says who caused it and through which door, so a two-way sync can skip its own echo.
-- The view is recreated rather than altered because SQLite has no ALTER VIEW; the arms are those
-- of 0005 with two columns added: `actor_name` and `channel`.
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
