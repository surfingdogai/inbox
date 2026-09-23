-- ADR-017 §3 and §8: a promise now closes with an outcome, and receipts carry claims v2.
-- A receipt is one per item, kind and outcome: promises keep `outcome` = '', so every receipt
-- issued before this migration is unchanged and still unique, and an item may now also hold one
-- receipt per outcome it reached (a no-show and its correction, say). The unique index is swapped
-- in the same batch, so there is no moment in which two receipts of one kind could be written.
ALTER TABLE `receipts` ADD `outcome` text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- base64url(SHA-256(jws)), the name a network gives a receipt in reports and acknowledgements.
-- SQL has no SHA-256, so older rows are filled by the lifecycle sweep, a few hundred at a time.
ALTER TABLE `receipts` ADD `sha` text;
--> statement-breakpoint
DROP INDEX IF EXISTS `receipts_item_kind`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `receipts_item_kind_outcome` ON `receipts` (`item_id`,`kind`,`outcome`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `receipts_sha` ON `receipts` (`sha`);
--> statement-breakpoint
-- When a booking ends, in Unix seconds, for the sweep that completes confirmed bookings after it.
ALTER TABLE `items` ADD `end_at` integer GENERATED ALWAYS AS (unixepoch(json_extract("payload", '$.endTime'))) VIRTUAL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `items_end` ON `items` (`type`,`state`,`end_at`);
--> statement-breakpoint
-- A booking or an order promised before this migration was promised under the rules of the day
-- (R18): the sweep never completes or lapses it, nothing it comes to is recorded as an outcome for
-- a network, and its one-time corrections are not offered. Its owner still closes it by hand. That
-- covers the promises still open and those already kept or broken, which could still be corrected
-- or charged back.
ALTER TABLE `items` ADD `legacy_promise` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `items` SET `legacy_promise` = 1
 WHERE (`type` = 'booking' AND `state` IN ('confirmed', 'completed', 'no_show'))
    OR (`type` = 'order' AND `state` IN ('accepted', 'awaiting_payment', 'payment_failed', 'paid', 'fulfilling', 'fulfilled', 'completed'));
--> statement-breakpoint
-- Which rules each network applies, read daily from its `/v1/ranking`: v2 receipts go only to a
-- network whose version, or announced next version, is 3 or later (§2.5).
ALTER TABLE `network_status` ADD `rules_version` integer;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `rules_next_version` integer;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `rules_next_at` integer;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `rules_checked_at` integer;
--> statement-breakpoint
-- The presentation each network made for an item's customer (§7.2), named in the item's receipts
-- as `per`. One per item and network; nothing here is a secret.
CREATE TABLE IF NOT EXISTS `item_presentations` (
	`item_id` text NOT NULL,
	`network` text NOT NULL,
	`presentation_id` text NOT NULL,
	`ppid` text,
	`person` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `network`)
);
--> statement-breakpoint
-- An instance that existed before late cancellations were recorded keeps refusing them until its
-- owner decides otherwise (§8.1): set where the stored document does not say, never overwritten.
UPDATE `settings` SET `doc` = json_set(`doc`, '$.booking.lateCancellation', 'refuse')
 WHERE json_valid(`doc`) AND json_type(`doc`, '$.booking') = 'object'
   AND json_type(`doc`, '$.booking.lateCancellation') IS NULL;
--> statement-breakpoint
UPDATE `settings` SET `doc` = json_set(`doc`, '$.booking', json('{"lateCancellation":"refuse"}'))
 WHERE json_valid(`doc`) AND json_type(`doc`) = 'object'
   AND (json_type(`doc`, '$.booking') IS NULL OR json_type(`doc`, '$.booking') <> 'object');
--> statement-breakpoint
-- An instance with items but no settings row has only ever run on the defaults: it gets a row that
-- says `refuse`, so the new default does not change its policy either.
INSERT INTO `settings` (`id`, `schema_version`, `doc`, `version`, `updated_at`)
SELECT 'singleton', 1, '{"booking":{"lateCancellation":"refuse"}}', 1, unixepoch() * 1000
 WHERE NOT EXISTS (SELECT 1 FROM `settings`) AND EXISTS (SELECT 1 FROM `items`);
