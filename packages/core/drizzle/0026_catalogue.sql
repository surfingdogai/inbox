-- The catalogue (ADR-029): what every product search asks of a product, as the owner or its source
-- stated it, and what each network last said of the business's products. Additive: no row changes
-- value, nothing is backfilled, and an inbox that lists nothing writes nothing new.
--
-- `gtin`: the barcode as 14 digits, its check digit verified, never a shop's own code or a coupon
-- (`@surfingdog/spec`'s `normaliseGtin`). `gtin_given`: a barcode as a source gave it that is not the
-- product's barcode, either because it did not pass the check (kept so the owner can read what came
-- in) or because the owner's AI proposed it and the owner has not confirmed it yet; never public.
-- `no_gtin`: the owner says it has none (bread, a print, a repair). `brand` and `mpn` (the maker's part
-- number) at most 70 characters, never guessed from the name. `condition`: new, used or refurbished.
-- `url`: its page, published only when it is on the business's own site. `image_url`: a link to its
-- picture, never copied. `source_category`: what a source said its category was, a hint only and never
-- public. `listed`: the owner's own, 0 keeps it off networks while it stays on sale at the business's
-- own doors.
ALTER TABLE `products` ADD `gtin` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `gtin_given` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `no_gtin` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `brand` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `mpn` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `condition` text DEFAULT 'new' NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `url` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `image_url` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `source_category` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `listed` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Not unique: a new one and a used one share a barcode.
CREATE INDEX IF NOT EXISTS `products_gtin` ON `products` (`gtin`) WHERE `gtin` IS NOT NULL;
--> statement-breakpoint
-- The signed feed's order (`GET /v1/catalogue/changes`): the order products were written in, as the
-- database committed them. Every write that changes what the feed shows of a product sets it to the
-- next number (`NEXT_CATALOGUE_SEQ`, `catalogue/identity.ts`), inside its own statement, so a change a
-- slow batch commits late is never behind what a network has already read. Not a trigger: on D1 a
-- trigger's writes count in a statement's `changes`. Rows from before this migration all hold 0, and
-- are read first, by id.
ALTER TABLE `products` ADD `catalogue_seq` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_catalogue_seq` ON `products` (`catalogue_seq`, `id`);
--> statement-breakpoint
-- What each network was last told of the business's products (`catalogue_listed`: 1, 0, or null for
-- never), and what its answer to a signed ping last said: how many it lists, what it holds back and
-- why (`catalogue_held`, JSON, read leniently), and when; `catalogue_error` is the last thing that went
-- wrong telling it, in a few words.
ALTER TABLE `network_status` ADD `catalogue_listed` integer;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `catalogue_count` integer;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `catalogue_held` text;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `catalogue_at` integer;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `catalogue_error` text;
