-- Owner sign-in (ADR-004): a sign-in email carries a link and a six-digit code, either of which signs
-- in once. `code_hash` is the code's, hashed with the row's own hash; `attempts` counts the tries at
-- it, and after five the code stops working (the link, which nobody can guess, still does). The same
-- columns hold the step-up codes the owner gets before changing their address. `user_id` is the
-- owner a step-up code or an address change is for, and `detail` what a row is about beyond its
-- address: an address change's old and new address, or the origin a handoff signs in at.
ALTER TABLE `login_tokens` ADD `code_hash` text;
--> statement-breakpoint
ALTER TABLE `login_tokens` ADD `attempts` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `login_tokens` ADD `user_id` text;
--> statement-breakpoint
ALTER TABLE `login_tokens` ADD `detail` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `login_tokens_email` ON `login_tokens` (`email`, `kind`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `login_tokens_user` ON `login_tokens` (`user_id`, `kind`, `created_at`);
