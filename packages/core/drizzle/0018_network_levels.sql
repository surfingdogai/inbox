-- Network levels (protocol §10): what a network says it offers in its rules' `protocol`, read daily
-- with the rules. `level` is `directory` or `full`; `claims` the receipt claims it takes (1, 2 or 6).
-- Both null for a network that says nothing, which is read as before: full, claims by rules version.
ALTER TABLE `network_status` ADD `level` text;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `claims` integer;
