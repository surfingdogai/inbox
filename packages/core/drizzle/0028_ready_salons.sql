-- Salons, barbers and beauty (ADR-035). Staff are the `resources` the schema has had since the start,
-- now shown to customers by a first name: `kind` (`staff` | `table` | `room` | `vehicle` | `equipment`),
-- `public_name` (the only name customers see), a small `photo` (a JPEG of at most 32 KB, as a data URL,
-- read again before it is kept and kept with no metadata), and `sort`. `external_id` and `source` name
-- a member of staff a salon's own system sent in (`phorest`), so a second import updates them.
ALTER TABLE `resources` ADD `kind` text DEFAULT 'staff' NOT NULL;
--> statement-breakpoint
ALTER TABLE `resources` ADD `public_name` text;
--> statement-breakpoint
ALTER TABLE `resources` ADD `photo` text;
--> statement-breakpoint
ALTER TABLE `resources` ADD `sort` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `resources` ADD `external_id` text;
--> statement-breakpoint
ALTER TABLE `resources` ADD `source` text DEFAULT 'builtin' NOT NULL;
--> statement-breakpoint
ALTER TABLE `resources` ADD `updated_at` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `resources_kind_sort` ON `resources` (`kind`, `active`, `sort`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `resources_source_external` ON `resources` (`source`, `external_id`) WHERE `external_id` IS NOT NULL;
--> statement-breakpoint
-- Who gives which service, at what price and for how long when it is not the service's own (a senior
-- stylist's price): the owner's. A service nobody is tied to is booked as before, without staff.
CREATE TABLE IF NOT EXISTS `service_resources` (
	`service_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`price_override` integer,
	`duration_override_min` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`service_id`, `resource_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `service_resources_resource` ON `service_resources` (`resource_id`);
--> statement-breakpoint
-- A service's add-ons (each a name, the minutes it adds and an optional price), its deposit (`percent` or
-- `amount`), its own cancellation policy (`policySchema`, else the business's default applies) and what
-- must come first (`requires`: another service within N days, checked against this business's own
-- bookings and never shown to anyone). JSON, null for none. `external_id` and `source` as for staff.
ALTER TABLE `services` ADD `add_ons` text;
--> statement-breakpoint
ALTER TABLE `services` ADD `deposit` text;
--> statement-breakpoint
ALTER TABLE `services` ADD `policy` text;
--> statement-breakpoint
ALTER TABLE `services` ADD `requires` text;
--> statement-breakpoint
ALTER TABLE `services` ADD `external_id` text;
--> statement-breakpoint
ALTER TABLE `services` ADD `source` text DEFAULT 'builtin' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `services_source_external` ON `services` (`source`, `external_id`) WHERE `external_id` IS NOT NULL;
--> statement-breakpoint
-- A calendar tied to one member of staff (their own Google, iCloud or Cal.com): its busy times take
-- only their times off, and only their bookings are written to it. Null: the whole business's, as before.
ALTER TABLE `connectors` ADD `resource_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connectors_resource` ON `connectors` (`resource_id`) WHERE `resource_id` IS NOT NULL;
