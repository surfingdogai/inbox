-- Stays (ADR-033): a place to stay in its own inbox. Ten new tables, nothing that exists changes, and
-- an inbox that is not a place to stay writes no row here. Conventions as ever (ADR-011): text ULIDs,
-- integer milliseconds, JSON as text, 0/1 booleans. Amounts are minor units of the property's
-- currency (ADR-032). Dates are the property's local dates (`YYYY-MM-DD`): a night is the date it
-- starts on, never a span of milliseconds.
--
-- A place to stay: one per location (most inboxes have one; a rental manager up to twenty). `mode` is
-- how it confirms: `request` (each stay answered with a quote), `allotment` (rooms it keeps for direct
-- guests, closed on its other channels, confirm at once) or `connected` (its own system, written to
-- first); `instant` is the owner's own switch for confirming at once from that system. The private
-- arrival details (door codes, wifi) are sealed by the secret box, bound to the row.
CREATE TABLE IF NOT EXISTS `properties` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`kind` text DEFAULT 'guesthouse' NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`check_in_from` text DEFAULT '15:00' NOT NULL,
	`check_in_until` text,
	`check_out_until` text DEFAULT '11:00' NOT NULL,
	`mode` text DEFAULT 'request' NOT NULL,
	`instant` integer DEFAULT 0 NOT NULL,
	`fresh_minutes` integer DEFAULT 15 NOT NULL,
	`answer_hours` integer DEFAULT 12 NOT NULL,
	`quote_valid_hours` integer DEFAULT 24 NOT NULL,
	`pay_within_hours` integer DEFAULT 24 NOT NULL,
	`hold_minutes` integer DEFAULT 20 NOT NULL,
	`max_nights` integer DEFAULT 30 NOT NULL,
	`same_day_until` text,
	`children` text DEFAULT '{"welcome":true}' NOT NULL,
	`pets` text DEFAULT '{"allowed":"no"}' NOT NULL,
	`house_rules` text DEFAULT '{"chips":[]}' NOT NULL,
	`arrival_public` text,
	`arrival_private_enc` text,
	`pre_arrival_text` text,
	`registration` text,
	`prices_include` text,
	`connector_id` text,
	`external_id` text,
	`active` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `properties_location` ON `properties` (`location_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `properties_external` ON `properties` (`connector_id`, `external_id`) WHERE `connector_id` IS NOT NULL;
--> statement-breakpoint
-- A kind of room: "Double room", "Bed in a 6-bed dorm". `units` is how many like it (a dorm: beds).
-- `external_id` is the property system's room id, so a connected property has one copy of its rooms.
CREATE TABLE IF NOT EXISTS `room_types` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`units` integer DEFAULT 1 NOT NULL,
	`capacity` text NOT NULL,
	`beds` text DEFAULT '[]' NOT NULL,
	`size_m2` integer,
	`amenities` text DEFAULT '[]' NOT NULL,
	`accessible` integer DEFAULT 0 NOT NULL,
	`photos` text DEFAULT '[]' NOT NULL,
	`external_id` text,
	`offered` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `room_types_property` ON `room_types` (`property_id`, `active`, `sort`);
--> statement-breakpoint
-- A cancellation policy, as the owner chose it (`preset`) and as data (ADR-032 `policySchema`).
CREATE TABLE IF NOT EXISTS `stay_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`preset` text NOT NULL,
	`policy` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- A rate plan: its meal, its policy, how a stay on it is secured (`deposit`, `balance`, `guarantee`),
-- the room types it is for (NULL: every one), and a plan it is derived from (non-refundable, 10% less).
CREATE TABLE IF NOT EXISTS `rate_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`name` text NOT NULL,
	`meal` text DEFAULT 'room_only' NOT NULL,
	`policy_id` text NOT NULL,
	`deposit` text DEFAULT '{"kind":"none"}' NOT NULL,
	`balance` text DEFAULT '{"when":"at_property"}' NOT NULL,
	`guarantee` text DEFAULT 'none' NOT NULL,
	`room_type_ids` text,
	`derived` text,
	`min_nights` integer DEFAULT 1 NOT NULL,
	`max_nights` integer,
	`external_id` text,
	`offered` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`policy_id`) REFERENCES `stay_policies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Prices per night: a row with `from_date` '' is the base; dated rows are seasons; `weekdays` is a
-- bitmask (Monday 1 … Sunday 64). `nightly` is for `base_guests`; extra adults and children are added.
CREATE TABLE IF NOT EXISTS `rates` (
	`rate_plan_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`from_date` text DEFAULT '' NOT NULL,
	`to_date` text DEFAULT '' NOT NULL,
	`weekdays` integer DEFAULT 127 NOT NULL,
	`nightly` integer NOT NULL,
	`base_guests` integer DEFAULT 2 NOT NULL,
	`extra_adult` integer,
	`extra_child` integer,
	`min_nights` integer,
	PRIMARY KEY(`rate_plan_id`, `room_type_id`, `from_date`, `weekdays`),
	FOREIGN KEY (`rate_plan_id`) REFERENCES `rate_plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_type_id`) REFERENCES `room_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Taxes and fees: every mandatory one is a line in the total, whoever collects it.
CREATE TABLE IF NOT EXISTS `stay_fees` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`basis` text NOT NULL,
	`amount` integer,
	`rate_bp` integer,
	`tiers` text,
	`collected` text DEFAULT 'with_booking' NOT NULL,
	`child_exempt_under` integer,
	`max_nights` integer,
	`active` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Extras a guest may add: on-property items only (vocab/lodging.json `extras`), never travel services.
CREATE TABLE IF NOT EXISTS `stay_extras` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`item` text NOT NULL,
	`name` text NOT NULL,
	`price` integer NOT NULL,
	`basis` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Night claims: what `slot_claims` is for minutes. The primary key arbitrates the last room (ADR-007):
-- one ordinal per unit per night, so two stays never hold the same room on the same night through
-- the inbox. `hold_until` is set while it is held (an agent's hold, a deposit's window, a write in
-- flight); NULL when it is the stay's for good.
CREATE TABLE IF NOT EXISTS `night_claims` (
	`room_type_id` text NOT NULL,
	`night` text NOT NULL,
	`ordinal` integer NOT NULL,
	`item_id` text NOT NULL,
	`hold_until` integer,
	PRIMARY KEY(`room_type_id`, `night`, `ordinal`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `night_claims_item` ON `night_claims` (`item_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `night_claims_hold` ON `night_claims` (`hold_until`) WHERE `hold_until` IS NOT NULL;
--> statement-breakpoint
-- Rooms the owner keeps for direct guests, closed on every other channel (allotment mode). Only a
-- person sets one: `set_by` is a user, never the owner's AI.
CREATE TABLE IF NOT EXISTS `allotments` (
	`room_type_id` text NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`weekdays` integer DEFAULT 127 NOT NULL,
	`units` integer NOT NULL,
	`closed_elsewhere_at` integer NOT NULL,
	`set_by` text NOT NULL,
	PRIMARY KEY(`room_type_id`, `from_date`, `weekdays`),
	FOREIGN KEY (`room_type_id`) REFERENCES `room_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Availability, rates and inventory as a connected system said them, by its own room ids: the cache
-- agents are answered from. `source` is how it was read (`poll`, `hint`, `live`); `fetched_at` how
-- fresh it is. A hint marks a range stale and is never believed: the next read is.
CREATE TABLE IF NOT EXISTS `stay_ari` (
	`connector_id` text NOT NULL,
	`room_ext_id` text NOT NULL,
	`night` text NOT NULL,
	`units` integer NOT NULL,
	`closed` integer DEFAULT 0 NOT NULL,
	`min_stay` integer,
	`max_stay` integer,
	`no_arrival` integer DEFAULT 0 NOT NULL,
	`no_departure` integer DEFAULT 0 NOT NULL,
	`prices` text,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`stale` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`connector_id`, `room_ext_id`, `night`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stay_ari_fetched` ON `stay_ari` (`connector_id`, `fetched_at`);
--> statement-breakpoint
-- Nights the owner closed for a room type (or the whole property, `room_type_id` ''): never sold.
CREATE TABLE IF NOT EXISTS `stay_closures` (
	`property_id` text NOT NULL,
	`room_type_id` text DEFAULT '' NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`property_id`, `room_type_id`, `from_date`),
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
