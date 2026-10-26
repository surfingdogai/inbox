-- Payment schedules (ADR-036). An item may now have a link per entry of its payment schedule — a
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
--> statement-breakpoint
-- Write first (ADR-036): every attempt at writing to a business's own system (a property system, a
-- booking system) before anything is promised, journalled. `idem_key` is the key the system is sent and
-- the marker a write is found by after a timeout; `request_sha` the fingerprint of what was written,
-- never the request (it may name the guest); `outcome` is `pending` | `written` | `refused` | `unknown`
-- (no answer, not found yet: a job looks again until `resolve_after`'s window ends) | `rolled_back`
-- (ours oversold the system, and was taken back). `owner` names who settles an unknown one (`stays`).
CREATE TABLE IF NOT EXISTS `connector_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`item_id` text NOT NULL,
	`op` text NOT NULL,
	`owner` text NOT NULL,
	`attempt` integer NOT NULL,
	`idem_key` text NOT NULL,
	`request_sha` text NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`external_id` text,
	`detail` text,
	`resolve_after` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `connector_writes_attempt` ON `connector_writes` (`connector_id`, `item_id`, `attempt`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connector_writes_key` ON `connector_writes` (`connector_id`, `item_id`, `op`, `idem_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connector_writes_unknown` ON `connector_writes` (`outcome`, `resolve_after`) WHERE `outcome` = 'unknown';
