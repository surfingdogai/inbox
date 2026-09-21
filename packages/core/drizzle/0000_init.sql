CREATE TABLE `action_links` (
	`jti` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`action` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`party_id` text NOT NULL,
	`name` text,
	`operator` text,
	`homepage_host` text,
	`jwk` text,
	`jwk_thumbprint` text,
	`tier` text DEFAULT 'anonymous' NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_jwk_thumbprint_unique` ON `agents` (`jwk_thumbprint`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`scopes` text NOT NULL,
	`party_id` text,
	`user_id` text,
	`rate_tier` text,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE TABLE `availability_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text,
	`resource_id` text,
	`location_id` text,
	`kind` text NOT NULL,
	`weekly` text,
	`valid_from` integer,
	`valid_to` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`key` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`content_type` text NOT NULL,
	`sha256` text,
	`kind` text NOT NULL,
	`item_id` text,
	`party_id` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `business` (
	`id` text PRIMARY KEY DEFAULT 'self' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`domain` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`config_enc` text NOT NULL,
	`status` text DEFAULT 'configured' NOT NULL,
	`last_error` text,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` integer NOT NULL,
	`response` text NOT NULL,
	`item_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_created` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `item_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text,
	`diff` text,
	`meta` text,
	`causation_id` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `item_events_created` ON `item_events` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `item_events_item_seq` ON `item_events` (`item_id`,`seq`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`party_id` text NOT NULL,
	`location_id` text,
	`channel` text NOT NULL,
	`subject` text,
	`linked_item_id` text,
	`payload` text NOT NULL,
	`flags` text NOT NULL,
	`needs_human` integer GENERATED ALWAYS AS (json_extract("flags", '$.needsHuman')) VIRTUAL,
	`sandbox` integer GENERATED ALWAYS AS (json_extract("flags", '$.sandbox')) VIRTUAL,
	`priority` integer GENERATED ALWAYS AS (json_extract("flags", '$.priority')) VIRTUAL,
	`start_at` text GENERATED ALWAYS AS (json_extract("payload", '$.startTime')) VIRTUAL,
	`amount_minor` integer GENERATED ALWAYS AS (json_extract("payload", '$.totalPrice.value')) VIRTUAL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `items_type_state` ON `items` (`type`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `items_party` ON `items` (`party_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `items_start` ON `items` (`type`,`start_at`);--> statement-breakpoint
CREATE INDEX `items_needs_human` ON `items` (`needs_human`,`updated_at`);--> statement-breakpoint
CREATE INDEX `items_sandbox` ON `items` (`sandbox`,`updated_at`);--> statement-breakpoint
CREATE INDEX `items_location` ON `items` (`location_id`,`type`,`state`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`run_at` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`lease_until` integer,
	`leased_by` text,
	`last_error` text,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	`done_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_key_unique` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `key_directories` (
	`origin` text PRIMARY KEY NOT NULL,
	`jwks` text NOT NULL,
	`etag` text,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text,
	`address` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_tokens` (
	`hash` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`kind` text DEFAULT 'magic_link' NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`redirect_uris` text NOT NULL,
	`client_uri` text,
	`logo_uri` text,
	`kind` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`code_challenge` text NOT NULL,
	`resource` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`resource` text,
	`family_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`rotated_from` text,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_tokens_family` ON `oauth_tokens` (`family_id`);--> statement-breakpoint
CREATE TABLE `parties` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`locale` text,
	`notes` text,
	`erased_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `party_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`party_id` text NOT NULL,
	`kind` text NOT NULL,
	`value_normalized` text NOT NULL,
	`evidence` text,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `party_identities_party` ON `party_identities` (`party_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `party_identities_kind_value` ON `party_identities` (`kind`,`value_normalized`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`name` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text,
	`sku` text,
	`name` text NOT NULL,
	`description` text,
	`price` text NOT NULL,
	`stock` integer,
	`source` text DEFAULT 'builtin' NOT NULL,
	`external_id` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `products_source_external` ON `products` (`source`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_sku` ON `products` (`sku`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`tokens` real NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`jws` text NOT NULL,
	`payload` text NOT NULL,
	`kid` text NOT NULL,
	`subject_hash` text NOT NULL,
	`issued_at` integer NOT NULL,
	`ack_jws` text,
	`ack_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_item_kind` ON `receipts` (`item_id`,`kind`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text,
	`name` text NOT NULL,
	`capacity` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reviews_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`receipt_id` text,
	`fact` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`definition` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text,
	`name` text NOT NULL,
	`description` text,
	`duration_min` integer DEFAULT 60 NOT NULL,
	`buffer_before_min` integer DEFAULT 0 NOT NULL,
	`buffer_after_min` integer DEFAULT 0 NOT NULL,
	`capacity` integer DEFAULT 1 NOT NULL,
	`granularity_min` integer DEFAULT 15 NOT NULL,
	`price` text,
	`active` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `services_active_sort` ON `services` (`active`,`sort`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`schema_version` integer NOT NULL,
	`doc` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sig_nonces` (
	`keyid` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`keyid`, `nonce`)
);
--> statement-breakpoint
CREATE TABLE `signing_keys` (
	`kid` text PRIMARY KEY NOT NULL,
	`public_jwk` text NOT NULL,
	`private_jwk_enc` text NOT NULL,
	`purpose` text DEFAULT 'receipts' NOT NULL,
	`created_at` integer NOT NULL,
	`retired_at` integer
);
--> statement-breakpoint
CREATE TABLE `slot_claims` (
	`resource_key` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`item_id` text NOT NULL,
	PRIMARY KEY(`resource_key`, `bucket_start`, `ordinal`)
);
--> statement-breakpoint
CREATE INDEX `slot_claims_item` ON `slot_claims` (`item_id`);--> statement-breakpoint
CREATE TABLE `thread_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`direction` text NOT NULL,
	`channel` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`party_id` text,
	`subject` text,
	`body_text` text NOT NULL,
	`body_format` text DEFAULT 'text' NOT NULL,
	`raw_blob_key` text,
	`attachments` text,
	`message_id` text,
	`in_reply_to` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_entries_message_id_unique` ON `thread_entries` (`message_id`);--> statement-breakpoint
CREATE INDEX `thread_entries_item` ON `thread_entries` (`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`role` text DEFAULT 'owner' NOT NULL,
	`location_id` text,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer,
	`last_status` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_once` ON `webhook_deliveries` (`webhook_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`secret_enc` text NOT NULL,
	`events` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
