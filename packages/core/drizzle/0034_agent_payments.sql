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
-- `state`: creating (the platform is being asked, or never said what it did), processing (it settles
-- the payment later, or waits for the card holder to confirm it), paid, declined (nothing was charged),
-- failed (a token refused, or a payment that did not go through after processing), cancelled (stopped
-- before it was charged: the card holder never confirmed it), unknown (the platform never said, and the
-- owner is told: still read back). One attempt in flight, unknown or paid per order
-- (`agent_payments_live`): two assistants paying at once, one paying again after the first went
-- through, or another token while nobody knows what the first did, make one charge.
--
-- `retry_key` is which idempotency key the platform is asked under: 0 the attempt's own, n its nth new
-- one, taken when the platform keeps a failure under the one before (Stripe answers a 500 again to every
-- retry with its key). `asked_at` is when it was last asked.
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
	`retry_key` integer DEFAULT 0 NOT NULL,
	`asked_at` integer,
	`claim_until` integer,
	`claimed_by` text,
	`checked_at` integer,
	`recorded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`paid_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_payments_live` ON `agent_payments` (`item_id`) WHERE `state` IN ('creating', 'processing', 'unknown', 'paid');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_payments_credential` ON `agent_payments` (`credential_sha`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_payments_external` ON `agent_payments` (`connector_id`, `external_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_payments_item` ON `agent_payments` (`item_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_payments_open` ON `agent_payments` (`connector_id`, `state`, `checked_at`);
