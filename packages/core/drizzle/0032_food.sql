-- Restaurants, takeaways, bakeries and cafés (ADR-040). A product's menu is JSON beside its catalogue
-- columns (`menu`): its section and place in it, its option groups, its allergens (what it contains and
-- may contain, and whether a person at the business confirmed them), its dietary tags, an age limit,
-- the dayparts it is served in, a deal's groups, the notice it needs, how many the inbox may take a day,
-- the days it is made, the dates it is not, whether it is made to order, and a custom order's brief.
-- Null for a product that is not on a menu, which orders as before. `sold_out_on` is the business's
-- local date a café marked it sold out for, so it comes back on the next day by itself.
ALTER TABLE `products` ADD `menu` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `sold_out_on` text;
--> statement-breakpoint
-- A table service counts its places in people (`capacity_unit`: `bookings` | `people`): covers per
-- sitting. `table_rules` holds its largest party, the size above which a request becomes a request for
-- a price, a deposit per person from a party size, the covers set aside for direct bookings that
-- confirm at once, and its own cancellation policy. Null for every other service.
ALTER TABLE `services` ADD `capacity_unit` text DEFAULT 'bookings' NOT NULL;
--> statement-breakpoint
ALTER TABLE `services` ADD `table_rules` text;
--> statement-breakpoint
-- Orders a restaurant took in its own ordering system (GloriaFood), shown to the owner only when they
-- switch it on: the order's lines, how and when it is fulfilled, its total. Never a customer's name,
-- address or phone, never an item of this inbox, never a receipt. Kept two days.
CREATE TABLE IF NOT EXISTS `pos_orders` (
	`connector_id` text NOT NULL,
	`external_id` text NOT NULL,
	`accepted_at` integer NOT NULL,
	`view` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`connector_id`, `external_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pos_orders_created` ON `pos_orders` (`created_at`);
