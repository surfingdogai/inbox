-- ADR-015 §7.3. A feed's products are identified by (source, external_id), and nothing
-- enforced it, so two imports of one connector running at the same time both read an empty
-- catalogue and both inserted: 60 products became 120, permanently, with both imports
-- reporting success. A unique index makes the second writer lose instead of duplicate.
--
-- Any duplicates a live instance already carries have to go before the index can be built, and
-- a product is never deleted here: the earliest row of each pair keeps its identity, and the
-- later ones are unlinked from the feed and deactivated, so an order that points at one still
-- has its product.
UPDATE `products`
   SET `external_id` = NULL, `active` = 0
 WHERE `external_id` IS NOT NULL
   AND `source` LIKE 'feed:%'
   AND `id` NOT IN (
     SELECT MIN(`id`) FROM `products`
      WHERE `external_id` IS NOT NULL AND `source` LIKE 'feed:%'
      GROUP BY `source`, `external_id`
   );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `products_feed_once` ON `products` (`source`,`external_id`) WHERE `external_id` IS NOT NULL;
