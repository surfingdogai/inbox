-- Open again, as listed: a message or a quote request opened again before a reopen cleared `closed_at`
-- (a customer's reply to a closed conversation, the owner's Reopen, Not spam) kept the time it was
-- closed, so it was listed under Done, out of what is open, though open. A notice brought back with Not
-- spam then went to Done when moved to the inbox. Data only, no schema change.
--
-- Whatever sets `closed_at` on these two types moves the item out of these states: a message closed is
-- `closed`, one put aside `spam`; a quote request accepted, declined or expired stays so for good, one put
-- aside is `spam`. So an open one with a `closed_at` was opened again, and nothing closed is touched.
-- Running it twice changes nothing more.
UPDATE `items` SET `closed_at` = NULL
 WHERE `closed_at` IS NOT NULL
   AND ((`type` = 'message' AND `state` IN ('open', 'answered'))
     OR (`type` = 'quote_request' AND `state` IN ('received', 'needs_info', 'quoted')));
