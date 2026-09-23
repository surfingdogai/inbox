-- Links in the business's emails that open the customer's page (ADR-018 §5): one per email and
-- action, signed, expiring, used once. A GET only shows; a POST acts. `terms_sha` is the fingerprint
-- of the terms the email carried (for a details link, the question it answers), `lang` the
-- language the page speaks, and `mail_key` the email the link went out in, which its siblings share.
ALTER TABLE `action_links` ADD `terms_sha` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `action_links` ADD `lang` text NOT NULL DEFAULT 'en';
--> statement-breakpoint
ALTER TABLE `action_links` ADD `mail_key` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `action_links_item` ON `action_links` (`item_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `action_links_mail` ON `action_links` (`mail_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `action_links_expires` ON `action_links` (`expires_at`);
