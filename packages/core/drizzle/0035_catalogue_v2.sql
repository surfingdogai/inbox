-- Catalogue version 2 (ADR-next, protocol §4.18 as amended): a product and its variants, how a price is
-- meant, a "was" price, a unit price, more ways to be available, an age checked at handover, and how a
-- product reaches the buyer, with the business's own shipping rate tables and return policies. Additive:
-- every column is null or a default that means what version 1 always meant (one fixed price, available
-- as its stock says, the default policies), so no product's feed item changes and no row is rewritten.
--
-- Two rows are made from what is already there, and nothing else is backfilled:
-- - the return policy `standard`, the default, from the settings' `returns` (its days and who pays the
--   postage), which it goes on following (`follows_settings`) until the owner writes its terms;
-- - one price a product, at its last write, in `product_prices`: the start of the record a "was" price is
--   checked against. A record that starts now holds back a "was" price for 30 days, never shows a false one.
ALTER TABLE `products` ADD `group_id` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `group_position` integer;
--> statement-breakpoint
ALTER TABLE `products` ADD `options` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `price_model` text DEFAULT 'fixed' NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `price_max` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `list_price` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `unit_price` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `tax_included` integer;
--> statement-breakpoint
ALTER TABLE `products` ADD `availability` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `available_from` integer;
--> statement-breakpoint
ALTER TABLE `products` ADD `available_until` integer;
--> statement-breakpoint
ALTER TABLE `products` ADD `few_left` integer;
--> statement-breakpoint
ALTER TABLE `products` ADD `multipack` integer;
--> statement-breakpoint
ALTER TABLE `products` ADD `is_bundle` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `media` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `age_restricted` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `fulfil_methods` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `shipping_profile_id` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `weight` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `return_policy_id` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `timed_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_group` ON `products` (`group_id`, `group_position`) WHERE `group_id` IS NOT NULL;
--> statement-breakpoint
-- The moments time moves a product in the feed: few products have them, so both indexes are partial.
CREATE INDEX IF NOT EXISTS `products_until` ON `products` (`available_until`) WHERE `available_until` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_from` ON `products` (`available_from`) WHERE `available_from` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `product_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`source` text DEFAULT 'builtin' NOT NULL,
	`external_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `product_groups_source_external` ON `product_groups` (`source`, `external_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `product_prices` (
	`product_id` text NOT NULL,
	`at` integer NOT NULL,
	`value` integer NOT NULL,
	`currency` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_prices_product` ON `product_prices` (`product_id`, `at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `shipping_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`zones` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `return_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`terms` text NOT NULL,
	`follows_settings` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Today's returns settings as the default policy: a window of their days, by post, a refund, the postage
-- paid as they say. An inbox with no settings yet takes the settings' own defaults (14 days, the customer).
INSERT OR IGNORE INTO `return_policies` (`id`, `name`, `is_default`, `terms`, `follows_settings`, `created_at`, `updated_at`)
SELECT 'standard', 'Standard', 1,
       json_object('eligibility', 'window',
                   'window_days', COALESCE((SELECT json_extract(`doc`, '$.returns.days') FROM `settings` WHERE `id` = 'singleton'), 14),
                   'resolutions', json_array('refund'),
                   'methods', json_array('by_post'),
                   'return_postage', COALESCE((SELECT json_extract(`doc`, '$.returns.postage') FROM `settings` WHERE `id` = 'singleton'), 'customer')),
       1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000;
--> statement-breakpoint
INSERT INTO `product_prices` (`product_id`, `at`, `value`, `currency`)
SELECT `id`, `updated_at`, json_extract(`price`, '$.value'), upper(json_extract(`price`, '$.currency'))
  FROM `products`
 WHERE json_extract(`price`, '$.value') > 0;
