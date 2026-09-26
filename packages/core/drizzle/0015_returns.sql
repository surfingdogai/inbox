-- Returns and the right of withdrawal (ADR-018 §3.4, §7). What the law lets a product or service be
-- excepted from withdrawal: `standard` (the right runs), or one of personalised, perishable,
-- sealed_hygiene, sealed_media, mixed, dated_leisure, urgent_repair, digital_started, price_fluctuates.
-- It is shown before the order, so it is public like the rest of the catalogue row; only the owner in
-- person sets it, and feeds never write it.
ALTER TABLE `products` ADD `withdrawal` text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE `services` ADD `withdrawal` text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
-- The returns and refunds of an order or a booking name it as their linked item, and are found by it.
CREATE INDEX IF NOT EXISTS `items_linked` ON `items` (`linked_item_id`) WHERE `linked_item_id` IS NOT NULL;
