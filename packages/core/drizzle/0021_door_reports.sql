-- Door reports (network protocol §4.15): how agents got on at the business's own doors, and what the
-- network's own reads saw, as a network's answer to a signed ping last said it (its `doors` block,
-- JSON, read leniently), and when. Counts, states and plain lines only: no customer, no agent and no
-- key is ever in it.
ALTER TABLE `network_status` ADD `doors` text;
--> statement-breakpoint
ALTER TABLE `network_status` ADD `doors_at` integer;
