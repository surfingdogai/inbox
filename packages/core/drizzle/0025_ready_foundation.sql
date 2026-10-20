-- Payment schedules (ADR-032). An item may now have a link per entry of its payment schedule — a
-- deposit and a balance open at once — not only one for an order's whole total. `schedule_id` names
-- the entry ('' for an order's own link, as every link before this was), `purpose` says what it is for
-- (`pay` | `deposit` | `balance` | `guarantee` | `difference`), and `expires_at` when it stops taking
-- payments (a deposit's pay window): the inbox closes it on the platform then. Nothing that exists
-- changes meaning, and an inbox that takes only orders writes the defaults.
ALTER TABLE `connector_payments` ADD `schedule_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `connector_payments` ADD `purpose` text DEFAULT 'pay' NOT NULL;
--> statement-breakpoint
ALTER TABLE `connector_payments` ADD `expires_at` integer;
--> statement-breakpoint
-- One live link per item and schedule entry: an order keeps exactly one (its entry is ''), and two jobs
-- that meet still make one link per entry, never two.
DROP INDEX IF EXISTS `connector_payments_live`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `connector_payments_live` ON `connector_payments` (`item_id`, `schedule_id`) WHERE `state` IN ('creating', 'open', 'held');
--> statement-breakpoint
-- Links whose window closes, found by the reconciliation that closes them.
CREATE INDEX IF NOT EXISTS `connector_payments_expiry` ON `connector_payments` (`state`, `expires_at`) WHERE `expires_at` IS NOT NULL;
