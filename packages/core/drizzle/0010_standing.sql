-- ADR-017 §7.3: the hourly ping is signed (sdi-instance/1) when the instance can sign, and a network
-- answers a signed ping with the business's own standing there. The owner sees it per network, as
-- the network last said it; nothing about any customer is in it.
ALTER TABLE `network_status` ADD `standing` text;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `standing_at` integer;
--> statement-breakpoint
-- Whether the last ping was signed and what the network made of it: `verified` (it answered 200),
-- `unsigned` (the inbox could not sign), or `invalid: <reason>` from the network's Sdi-Signature.
ALTER TABLE `network_status` ADD `ping_signature` text;
--> statement-breakpoint
-- The platforms each network recognises (`verified.recognised_platforms` in its `/v1/ranking`, §4),
-- read once a day beside its rules. A key a platform's directory lists vouches for an agent only
-- when a network this inbox reports to recognises that platform; otherwise it is the agent's own.
ALTER TABLE `network_status` ADD `recognised_platforms` text;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `platforms_checked_at` integer;
