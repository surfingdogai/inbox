-- Rules version 6 (ADR-017 Amendment 3): a change both sides agreed to a promise is a receipt of its
-- own, kind `amended`, one per change. A receipt is now one per item, kind, outcome and the agreed
-- change it records: every receipt issued before this migration keeps `offer_id` = '' and is unchanged
-- and still unique. The unique index is swapped in the same batch, as 0008 swapped it, so there is no
-- moment in which two receipts of one kind could be written.
ALTER TABLE `receipts` ADD `offer_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `receipts_item_kind_outcome`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `receipts_item_kind_outcome_offer` ON `receipts` (`item_id`,`kind`,`outcome`,`offer_id`);
