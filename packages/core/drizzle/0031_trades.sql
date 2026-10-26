-- Trades and projects (ADR-039). Files on a request: a customer's photos and plans are kept in the
-- inbox's own database, in pieces of 512 KB (`attachment_chunks`), so every runtime keeps them the same
-- way and an erasure or a copy of the database takes them with the rest. `blobs` gains the file's name
-- as it is shown, and `expires_at`: a file arrives before the request that names it and is kept an hour
-- for it; a request takes it by naming its item and clearing the hour. What nobody took is swept.
CREATE TABLE IF NOT EXISTS `attachment_chunks` (
	`key` text NOT NULL,
	`seq` integer NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`key`, `seq`)
);
--> statement-breakpoint
ALTER TABLE `blobs` ADD `name` text;
--> statement-breakpoint
ALTER TABLE `blobs` ADD `expires_at` integer;
--> statement-breakpoint
-- Who sent a file no request has taken yet (the bucket address the rate limits use), to hold each
-- sender to its share of the files waiting; cleared when a request takes the file.
ALTER TABLE `blobs` ADD `sent_by` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `blobs_item` ON `blobs` (`item_id`) WHERE `item_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `blobs_unclaimed` ON `blobs` (`kind`, `expires_at`) WHERE `item_id` IS NULL;
