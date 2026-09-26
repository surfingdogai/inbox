-- The owner's limits (ADR-018 §4). A floor is the lowest price the owner lets automation go to for a
-- product or a service: the owner's alone, so it lives apart from the catalogue rows, which the public
-- doors and the owner's AI read whole. No read of a product or a service can ever carry one.
CREATE TABLE IF NOT EXISTS `price_floors` (
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`floor_minor` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`kind`, `ref_id`)
);
--> statement-breakpoint
-- Whether a customer may suggest a price of their own for it, while price counters are on (Q1).
-- Public like the rest of the row; only the owner in person changes it, and feeds never write it.
ALTER TABLE `products` ADD `negotiable` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `services` ADD `negotiable` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- What the owner's AI, a rule or another system would have offered outside the owner's limits: kept
-- for a person to send or drop, never sent. One per item, the latest; not an offer anyone saw, so it
-- takes no place among the item's offers.
CREATE TABLE IF NOT EXISTS `offer_drafts` (
	`item_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`event` text NOT NULL,
	`input` text NOT NULL,
	`terms` text NOT NULL,
	`breaches` text NOT NULL,
	`item_version` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- Keys handed to another system keep doing what they did: setting prices and recording payments and
-- refunds, as a shop or a till does. From now on a key does that only with `money:write`; without
-- it, it is held to the owner's limits as the owner's AI is.
UPDATE `api_keys` SET `scopes` = json_insert(`scopes`, '$[#]', 'money:write')
 WHERE `kind` = 'integration' AND `revoked_at` IS NULL AND json_valid(`scopes`)
   AND EXISTS (SELECT 1 FROM json_each(`api_keys`.`scopes`) WHERE `value` IN ('inbox:write', '*'))
   AND NOT EXISTS (SELECT 1 FROM json_each(`api_keys`.`scopes`) WHERE `value` = 'money:write');
