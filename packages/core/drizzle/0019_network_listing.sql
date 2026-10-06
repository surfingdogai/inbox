-- Being in a network's directory (ADR-017 A2.3): what this inbox last told each network, by the
-- signed `POST /v1/instances/{domain}/listing`. `listed` is the value the network last answered 200
-- to (1 or 0), null while it has never been told; `listed_at` is when. The manifest's
-- `directory.listed` says the same to every network at once, for an inbox that cannot sign.
ALTER TABLE `network_status` ADD `listed` integer;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `listed_at` integer;
