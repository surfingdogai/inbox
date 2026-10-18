-- Calendars (ADR-020). What a connected calendar says is busy, the bookings this inbox keeps in step
-- in it, and the sign-ins with a platform that are on their way. Three new tables and two columns on
-- `connectors`; nothing that exists is changed, and an instance with no calendar writes no row here.
--
-- `connector_busy` holds one generation of busy times per connector: a sync writes its rows under a
-- generation of its own, moves `connectors.busy_gen` to it only if it is newer than the one there,
-- and deletes every other generation. Readers join on `busy_gen`, so a slow sync that finishes after
-- a newer one never puts old times back, and a half-written generation is never read.
ALTER TABLE `connectors` ADD `busy_gen` integer;
--> statement-breakpoint
ALTER TABLE `connectors` ADD `busy_at` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `connector_busy` (
	`connector_id` text NOT NULL,
	`gen` integer NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	PRIMARY KEY(`connector_id`, `gen`, `start_ms`, `end_ms`),
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connector_busy_span` ON `connector_busy` (`end_ms`, `start_ms`);
--> statement-breakpoint
-- One row per booking a connector keeps in step. `claim_until` is the compare-and-set that lets one
-- job, and only one, call the platform for a booking at a time: two syncs never create it twice.
CREATE TABLE IF NOT EXISTS `connector_links` (
	`connector_id` text NOT NULL,
	`item_id` text NOT NULL,
	`external_id` text,
	`etag` text,
	`calendar` text,
	`synced_hash` text,
	`synced_start` integer,
	`synced_end` integer,
	`state` text DEFAULT 'pending' NOT NULL,
	`claim_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connector_id`, `item_id`),
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connector_links_item` ON `connector_links` (`item_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connector_links_retry` ON `connector_links` (`connector_id`, `state`, `retry_at`);
--> statement-breakpoint
-- A sign-in with a platform the owner started (OAuth with PKCE): the state's SHA-256, never the state,
-- and the verifier sealed by the secret box. Used once, gone after ten minutes.
CREATE TABLE IF NOT EXISTS `connector_auth` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`verifier_enc` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`return_to` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
