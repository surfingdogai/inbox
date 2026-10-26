-- Connectors: the shared base (ADR-026). The columns the shop, booking and calendar-link connectors
-- share; nothing that exists changes meaning, and an inbox that connects none of them writes nothing
-- new here.
--
-- A connection's own address: `connectors.inbound_token` (since 0003) keeps the SHA-256 of the
-- unguessable segment of `POST /v1/hooks/<kind>/<token>` and `GET /v1/feeds/<kind>/<token>`, so a
-- request reaches one connection and the database never holds what opens it; `inbound_enc` keeps the
-- segment sealed by the secret box, for the connector to name its address with and the owner to see
-- a link again.
ALTER TABLE `connectors` ADD `inbound_enc` text;
--> statement-breakpoint
-- A sign-in that asks something first (a store's address) keeps it for the way back, and a platform
-- that POSTs the key itself (WooCommerce's authorize endpoint) leaves the connection it made, or what
-- went wrong, for the owner's browser to find when it returns.
ALTER TABLE `connector_auth` ADD `input` text;
--> statement-breakpoint
ALTER TABLE `connector_auth` ADD `connector_id` text;
--> statement-breakpoint
ALTER TABLE `connector_auth` ADD `message` text;
--> statement-breakpoint
-- When a product's source last sent it in: a complete pass of a feed or a shop takes off sale what it
-- did not see. Null for a product somebody typed in, which no pass ever touches.
ALTER TABLE `products` ADD `seen_at` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_source_seen` ON `products` (`source`, `seen_at`);
--> statement-breakpoint
-- What a shop said an order comes to, with the tax or delivery it adds itself. A link whose shop total
-- is not what the customer accepted is `held`: made in the shop, never sent, until the owner proposes
-- the shop's total and the customer accepts it. A held link is live, so the one-live-link index takes
-- it in: two jobs that meet still make one link per order, never two.
ALTER TABLE `connector_payments` ADD `shop_total` integer;
--> statement-breakpoint
ALTER TABLE `connector_payments` ADD `shop_currency` text;
--> statement-breakpoint
DROP INDEX IF EXISTS `connector_payments_live`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `connector_payments_live` ON `connector_payments` (`item_id`) WHERE `state` IN ('creating', 'open', 'held');
