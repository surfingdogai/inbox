-- Agent payments (ADR-042): one row per attempt by a customer's assistant to pay an accepted order
-- directly, with a one-time token its platform got for this business (a Stripe shared payment token),
-- charged once on the business's own payment account. Nothing that exists changes, and an inbox whose
-- owner never switches agent payments on writes no row. Conventions as ever (ADR-011): text ULIDs,
-- integer milliseconds, money in the currency's own minor unit (ADR-036).
--
-- The token itself is never kept: only its SHA-256 (`credential_sha`), so the same token sent twice is
-- one attempt and one charge. `terms_sha` is the fingerprint of the terms the customer confirmed, which
-- the charge was made against. `connector_id` is not a foreign key, as for `connector_payments`: a paid
-- row is the business's record of where the money went, and stays after a disconnect. No row holds a
-- customer's name, email or address.
--
-- `state`: creating (the platform is being asked), processing (it settles the payment later), paid,
-- declined (nothing was charged), failed (a token refused, or a payment that did not go through after
-- processing), cancelled (stopped before it was charged: the card asked its holder), unknown (the
-- platform never said). One attempt in flight, or one paid, per order (`agent_payments_live`): two
-- assistants paying at once, or one paying again after the first went through, make one charge.
CREATE TABLE IF NOT EXISTS `agent_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`kind` text NOT NULL,
	`handler` text NOT NULL,
	`door` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`livemode` integer NOT NULL,
	`terms_sha` text NOT NULL,
	`credential_sha` text NOT NULL,
	`state` text DEFAULT 'creating' NOT NULL,
	`external_id` text,
	`method` text,
	`paid_amount` integer,
	`paid_currency` text,
	`dashboard_url` text,
	`failure` text,
	`last_error` text,
	`last_error_at` integer,
	`note` text,
	`claim_until` integer,
	`claimed_by` text,
	`checked_at` integer,
	`recorded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`paid_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_payments_live` ON `agent_payments` (`item_id`) WHERE `state` IN ('creating', 'processing', 'paid');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_payments_credential` ON `agent_payments` (`credential_sha`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_payments_external` ON `agent_payments` (`connector_id`, `external_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_payments_item` ON `agent_payments` (`item_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_payments_open` ON `agent_payments` (`connector_id`, `state`, `checked_at`);
