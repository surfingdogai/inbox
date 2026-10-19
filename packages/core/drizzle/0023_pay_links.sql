-- Pay links (ADR-023). One row per link an order was given to pay in the business's own Stripe or
-- Mollie account: what it asks for, where the customer pays, and what the platform said about it. One
-- new table and its indexes; nothing that exists changes, and an inbox with no payment platform
-- connected writes no row here.
--
-- `connector_id` names the connection that made the link but is not a foreign key: a paid link is
-- the business's record of where the money went (and where to refund it), and stays after the
-- platform is disconnected. `kind` says which platform, for that same reason.
--
-- At most one link per order is live at a time (`creating` or `open`): the partial unique index is
-- what makes two jobs that meet create one link, never two. `claim_until` and `claimed_by` are the
-- compare-and-set that lets one job, and only one, ask the platform for it.
CREATE TABLE IF NOT EXISTS `connector_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`livemode` integer NOT NULL,
	`state` text DEFAULT 'creating' NOT NULL,
	`external_id` text,
	`url` text,
	`payment_id` text,
	`method` text,
	`paid_amount` integer,
	`paid_currency` text,
	`dashboard_url` text,
	`claim_until` integer,
	`claimed_by` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`checked_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`paid_at` integer,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `connector_payments_live` ON `connector_payments` (`item_id`) WHERE `state` IN ('creating', 'open');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connector_payments_item` ON `connector_payments` (`item_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `connector_payments_external` ON `connector_payments` (`connector_id`, `external_id`);
--> statement-breakpoint
-- The links still waiting for their payment, read back from the platform now and then in case a
-- webhook never came: by connection, state and when each was last asked about.
CREATE INDEX IF NOT EXISTS `connector_payments_open` ON `connector_payments` (`connector_id`, `state`, `checked_at`);
