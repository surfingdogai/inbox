-- A customer who asked the business not to use booking networks for them: set on every party that is
-- that customer, so each door and each publisher can tell from the item alone that nothing about it
-- goes to any network.
ALTER TABLE `parties` ADD `networks_off_at` integer;
--> statement-breakpoint
-- Fingerprints (SHA-256) of a stopped customer's email address and phone number, and of their
-- parties, so their next request (a new party) is stopped before any network is called, even after
-- their data was erased. `via`: customer, owner or erased.
CREATE TABLE IF NOT EXISTS `network_stops` (
	`hash` text PRIMARY KEY NOT NULL,
	`via` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- Who wrote a reply, when the request said so: `person` (an integration whose user typed it) or
-- `automation`. Null: judged by who sent it.
ALTER TABLE `thread_entries` ADD `written_by` text;
