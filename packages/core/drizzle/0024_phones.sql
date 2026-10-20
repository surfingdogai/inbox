-- The owner's phones (ADR-026). Three new tables and their indexes; nothing that exists changes, and
-- an inbox nobody pairs a phone with writes no row here.
--
-- `phone_pairings`: the one-time secret a QR code in Settings → Phone carries (`kind` 'qr'), or that
-- a sign-in link emailed to the owner carries ('link', with the PKCE challenge and the device key of
-- the phone that asked for it). Only the secret's hash is kept; it works once, for minutes, and stops
-- after a few wrong tries. `device_id` is the phone it paired.
CREATE TABLE IF NOT EXISTS `phone_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`kind` text DEFAULT 'qr' NOT NULL,
	`user_id` text NOT NULL,
	`code_challenge` text,
	`device_key` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`device_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `phone_pairings_secret` ON `phone_pairings` (`secret_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_pairings_user` ON `phone_pairings` (`user_id`, `created_at`);
--> statement-breakpoint
-- `phone_devices`: a paired phone, the owner it signs in as, the public half of its device key (the
-- private half stays in the phone's keystore and signs every token refresh), what it wants to be told
-- (`notify`, JSON) and how push reaches it: the relay's id for it and, sealed with INBOX_SECRET_KEY,
-- the relay's secret and the phone's push keys (`push_enc`). A phone paired by QR code waits for the
-- owner to confirm it on the computer (`confirmed_at` null, `pair_match` the two digits both screens
-- show) and can do nothing until then. A removed phone keeps its row, `revoked_at` set; one device key
-- belongs to one live phone at a time.
CREATE TABLE IF NOT EXISTS `phone_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`key_jwk` text NOT NULL,
	`key_thumbprint` text NOT NULL,
	`notify` text DEFAULT '{}' NOT NULL,
	`push_state` text DEFAULT 'off' NOT NULL,
	`push_device` text,
	`push_enc` text,
	`push_error` text,
	`pushed_at` integer,
	`pair_match` text,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `phone_devices_key` ON `phone_devices` (`key_thumbprint`) WHERE "phone_devices"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_devices_user` ON `phone_devices` (`user_id`, `revoked_at`);
--> statement-breakpoint
-- `phone_tokens`: a phone's tokens, hashed: access tokens that last minutes, and the refresh token
-- that rotates on every use (a rotated one used again removes the phone). `proof_at` is the time in
-- the proof that spent a refresh token: a lost answer may be asked again only with a newer proof.
CREATE TABLE IF NOT EXISTS `phone_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`device_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`rotated_from` text,
	`revoked_at` integer,
	`proof_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_tokens_device` ON `phone_tokens` (`device_id`, `kind`);
