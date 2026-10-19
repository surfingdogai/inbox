-- The email channel (ADR-026). Four new tables; nothing that exists changes.
--
-- `mail_tokens`: the secret part of a conversation's own address (`name+t…@domain`), of the address
-- the owner answers an alert at (`name+o…`), and of a forwarding check (`name+c…`). One token per
-- item and kind, made the first time an email about the item goes out, and kept: a reply can come
-- weeks later. A token is never the item's id, so knowing an item's id writes into nobody's thread.
CREATE TABLE IF NOT EXISTS `mail_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`item_id` text,
	`forward_id` text,
	`created_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `mail_tokens_item_kind` ON `mail_tokens` (`item_id`, `kind`) WHERE `item_id` IS NOT NULL;
--> statement-breakpoint
-- `email_forwards`: an address the business already has (support@its-domain), forwarded to the
-- inbox's own address. Where it stands: `setup` (the owner is setting it up), `confirm` (the provider
-- sent a confirmation, shown to the owner, never acted on), `working` (a check came back through it,
-- or mail to it arrived), `not_yet` (a check did not come back in time). `plus_ok`: a check sent to its
-- plus address came back too, so a conversation's address can be the business's own.
CREATE TABLE IF NOT EXISTS `email_forwards` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`provider` text NOT NULL,
	`state` text DEFAULT 'setup' NOT NULL,
	`plus_ok` integer DEFAULT 0 NOT NULL,
	`confirm_from` text,
	`confirm_code` text,
	`confirm_url` text,
	`confirm_at` integer,
	`check_sent_at` integer,
	`check_plain` integer DEFAULT 0 NOT NULL,
	`check_seen_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `email_forwards_address` ON `email_forwards` (`address`);
--> statement-breakpoint
-- `mail_attachments`: what came attached to an email, with what became of it: `kept` (its bytes are in
-- `mail_attachment_chunks`, 256 KiB a row, so no row is near any database's limit), `too_large`,
-- `refused` (a kind of file that runs, which nobody needs from a customer) or `full` (the inbox holds
-- all the attachments it keeps). Only the owner reads them.
CREATE TABLE IF NOT EXISTS `mail_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`entry_id` text,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text,
	`state` text NOT NULL,
	`chunks` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mail_attachments_item` ON `mail_attachments` (`item_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mail_attachment_chunks` (
	`attachment_id` text NOT NULL,
	`n` integer NOT NULL,
	`data` blob NOT NULL,
	PRIMARY KEY(`attachment_id`, `n`)
);
