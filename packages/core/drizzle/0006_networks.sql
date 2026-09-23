-- ADR-017 §2.7 and §8.1: an inbox reports to several networks. One row per receipt, network and
-- stage says whether that network has it yet, so evidence never dies with an eight-attempt job:
-- the hourly publisher for each network posts whatever is still queued, oldest first, which is
-- the first publication, the backfill when a network is switched on and the catch-up after an
-- outage, all at once. `network_status` is what the owner sees per network: when it last took a
-- ping, whether it has verified this instance, and the last error in a few words.
-- No foreign key on `receipt_id`: rows are only ever inserted from a SELECT on `receipts`, and a
-- receipt is never deleted. `reviews_outbox` (0000) stays unused; its key has no network in it.
CREATE TABLE IF NOT EXISTS `network_publications` (
	`receipt_id` text NOT NULL,
	`network` text NOT NULL,
	`stage` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`receipt_id`, `network`, `stage`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `network_publications_queue` ON `network_publications` (`network`,`state`,`receipt_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `network_status` (
	`network` text PRIMARY KEY NOT NULL,
	`registration` text DEFAULT 'unregistered' NOT NULL,
	`registered_at` integer,
	`last_ping_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`failing_since` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
