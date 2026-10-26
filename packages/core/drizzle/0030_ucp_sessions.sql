-- UCP Lodging's booking sessions (ADR-038): one row per session a platform opened at a place to stay,
-- written only while INBOX_UCP_LODGING is on. Nothing that exists changes. Conventions as ever
-- (ADR-011): text ULIDs, integer milliseconds.
--
-- The platform holds the session's id (`bks_` and 32 random bytes); the inbox keeps its SHA-256 alone,
-- as it does an item's access token. `item_id` is the stay the session holds or booked, null until the
-- lead is named; the row lives as long as that stay and goes with it when its guest is erased. A row
-- that never held a room goes two days after it was made. `state_enc` is the last request the session
-- accepted (who is coming, and the ids the platform gave each guest), sealed by the secret box and bound
-- to the row, so the session answers from it and nothing else keeps those ids. `totals` is the
-- fingerprint of the money last shown, `holds` how many holds it made (a few at most), and
-- `canceled_at` when the platform cancelled a session that held nothing.
CREATE TABLE IF NOT EXISTS `ucp_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`property_id` text NOT NULL,
	`item_id` text,
	`state_enc` text NOT NULL,
	`totals` text NOT NULL,
	`lang` text NOT NULL,
	`holds` integer DEFAULT 0 NOT NULL,
	`canceled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ucp_sessions_token` ON `ucp_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ucp_sessions_item` ON `ucp_sessions` (`item_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ucp_sessions_created` ON `ucp_sessions` (`created_at`) WHERE `item_id` IS NULL;
