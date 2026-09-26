-- Offers (ADR-018 §1): what one side put to the other — the customer's request, a time or a quote we
-- proposed, a counter, the changes we suggested to an order — each an immutable snapshot of the terms,
-- fingerprinted. `form` is the kind `terms_sha` names (time, quote, order, request), so a time or a
-- quote fingerprints exactly as the links already sent do. At most one open and one draft per item;
-- every verb closes the open one and opens the next in the batch of its transition.
CREATE TABLE IF NOT EXISTS `item_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`rev` integer NOT NULL,
	`parent_id` text,
	`kind` text NOT NULL,
	`form` text NOT NULL,
	`by` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`valid_through` integer,
	`terms` text NOT NULL,
	`terms_sha` text NOT NULL,
	`changes` text,
	`shown` text,
	`authored` text NOT NULL,
	`binding` integer DEFAULT 1 NOT NULL,
	`reason_code` text,
	`note` text,
	`event_id` text,
	`closed_event_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `item_offers_item_rev` ON `item_offers` (`item_id`, `rev`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `item_offers_one_open` ON `item_offers` (`item_id`) WHERE `status` = 'open';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `item_offers_one_draft` ON `item_offers` (`item_id`) WHERE `status` = 'draft';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `item_offers_due` ON `item_offers` (`status`, `valid_through`);
--> statement-breakpoint
-- A slot held while a time we proposed waits for the customer's answer is an ordinary claim that
-- carries the offer it holds for; the claim of an agreed booking carries ''.
ALTER TABLE `slot_claims` ADD `offer_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slot_claims_offer` ON `slot_claims` (`item_id`, `offer_id`);
--> statement-breakpoint
-- When a request waiting on the business, or on the customer's details, lapses: set by the write
-- path from now on. NULL on every row that exists today, which therefore never lapses on its own.
ALTER TABLE `items` ADD `request_expires_at` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `items_request_expiry` ON `items` (`request_expires_at`) WHERE `request_expires_at` IS NOT NULL;
