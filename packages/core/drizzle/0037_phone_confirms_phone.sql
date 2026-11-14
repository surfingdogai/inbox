-- A phone confirms a phone (ADR-028 Amendment 4). Four columns on `phone_devices`, empty on every
-- phone there is now; nothing else changes.
--
-- `via`: how the phone came. 'qr', a code from Settings → Phone, which the owner confirms on the
-- computer; 'link', a sign-in link emailed to the owner; 'host', a link the inbox's host made after
-- its own email code to the owner. A phone that came by a link while its owner already has a
-- confirmed phone waits for that phone's yes, with the same two digits on both screens.
-- `confirm_by`: until when such a phone may wait for that yes; past it, it is removed.
-- `wait_until`: "I don't have my other phone": the phone is let in at this time unless one of the
-- owner's phones, or the owner's email, stopped it before. `stop_hash` is the hash of the token in
-- that email's "Not you? Stop it" link.
ALTER TABLE `phone_devices` ADD `via` text;
--> statement-breakpoint
ALTER TABLE `phone_devices` ADD `confirm_by` integer;
--> statement-breakpoint
ALTER TABLE `phone_devices` ADD `wait_until` integer;
--> statement-breakpoint
ALTER TABLE `phone_devices` ADD `stop_hash` text;
