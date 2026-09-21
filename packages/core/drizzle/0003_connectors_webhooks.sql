-- ADR-015. `connectors`, `webhooks` and `webhook_deliveries` have existed since 0000_init and no
-- code path in the repository has ever written one, so they are empty on every live instance: this
-- drops and recreates them instead of altering, which also makes the whole migration idempotent.
-- Children go first, so the foreign keys never stand in the way.
DROP VIEW IF EXISTS `events_v1`;--> statement-breakpoint
DROP TABLE IF EXISTS `webhook_deliveries`;--> statement-breakpoint
DROP TABLE IF EXISTS `webhooks`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_events`;--> statement-breakpoint
DROP TABLE IF EXISTS `connectors`;--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`external_id` text,
	`config_enc` text,
	`config_public` text DEFAULT '{}' NOT NULL,
	`cursor` text,
	`inbound_token` text,
	`status` text DEFAULT 'configured' NOT NULL,
	`last_error` text,
	`last_error_at` integer,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_kind_external` ON `connectors` (`kind`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_inbound_token` ON `connectors` (`inbound_token`);--> statement-breakpoint
CREATE INDEX `connectors_status` ON `connectors` (`status`);--> statement-breakpoint
CREATE TABLE `connector_events` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`external_id` text NOT NULL,
	`topic` text NOT NULL,
	`received_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`item_id` text,
	`handled_at` integer,
	`error` text,
	`raw` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_events_once` ON `connector_events` (`connector_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `connector_events_pending` ON `connector_events` (`status`,`received_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`secret_enc` text NOT NULL,
	`events` text NOT NULL,
	`payload_style` text DEFAULT 'thin' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`failing_since` integer,
	`disabled_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer,
	`last_status` integer,
	`last_error` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_once` ON `webhook_deliveries` (`webhook_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due` ON `webhook_deliveries` (`status`,`next_at`);--> statement-breakpoint
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
WHERE t."direction" = 'in';
