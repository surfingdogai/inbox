-- Every email this inbox sends, what it said and what became of it: a send that failed is visible
-- on its item and is never shown as sent. One row per email (`job_key`: the notify job, or
-- `key:<item>` for the code email); a retry sends the same row. `recipient` is `customer` or
-- `owner`; `status` one of queued, sent, retrying, failed, skipped (`skip_reason`: no_address,
-- no_sender, test_item).
CREATE TABLE IF NOT EXISTS `outbound_mail` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text,
	`job_key` text NOT NULL,
	`recipient` text NOT NULL,
	`template` text NOT NULL,
	`lang` text NOT NULL,
	`entry_id` text,
	`event_id` text,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`message_ref` text NOT NULL,
	`provider_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`skip_reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `outbound_mail_job` ON `outbound_mail` (`job_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `outbound_mail_item` ON `outbound_mail` (`item_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `outbound_mail_status` ON `outbound_mail` (`status`, `updated_at`);
--> statement-breakpoint
-- The ids a customer's reply names in In-Reply-To and References, and the item each belongs to:
-- the item's anchor (first in the References of every email about it), each email's own ref, and
-- the id the mail service gave the email. A reply that names any of them lands on that item.
CREATE TABLE IF NOT EXISTS `mail_refs` (
	`ref` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mail_refs_item` ON `mail_refs` (`item_id`, `kind`);
