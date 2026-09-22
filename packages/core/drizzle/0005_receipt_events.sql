-- ADR-016. A receipt being issued, and being counter-signed, are things that happened to an item,
-- so they join the developer event stream and the webhooks like any transition: `<type>.receipt_issued`
-- when the job signs one, `<type>.receipt_acknowledged` when the customer's agent counter-signs.
-- The view is recreated rather than altered because SQLite has no ALTER VIEW; the two existing
-- branches are byte-for-byte what 0003 created.
DROP VIEW IF EXISTS `events_v1`;
--> statement-breakpoint
CREATE VIEW `events_v1` AS SELECT
  e."id" AS "id",
  i."type" || '.' || e."event" AS "type",
  e."created_at" AS "created_at",
  e."item_id" AS "item_id",
  i."type" AS "item_type",
  e."to_state" AS "item_state",
  e."seq" AS "item_version",
  i."party_id" AS "party_id",
  COALESCE(i."sandbox", 0) AS "sandbox",
  e."actor_kind" AS "actor_kind",
  e."actor_id" AS "actor_id",
  e."event" AS "event",
  'item_event' AS "source"
FROM "item_events" e JOIN "items" i ON i."id" = e."item_id"
UNION ALL
SELECT
  t."id",
  i."type" || '.message',
  t."created_at",
  t."item_id",
  i."type",
  i."state",
  i."version",
  i."party_id",
  COALESCE(i."sandbox", 0),
  t."actor_kind",
  t."actor_id",
  'message',
  'thread_entry'
FROM "thread_entries" t JOIN "items" i ON i."id" = t."item_id"
WHERE t."direction" = 'in'
UNION ALL
SELECT
  r."id",
  i."type" || '.receipt_issued',
  r."issued_at",
  r."item_id",
  i."type",
  i."state",
  i."version",
  i."party_id",
  COALESCE(i."sandbox", 0),
  'system',
  NULL,
  'receipt_issued',
  'receipt'
FROM "receipts" r JOIN "items" i ON i."id" = r."item_id"
UNION ALL
SELECT
  r."id" || ':ack',
  i."type" || '.receipt_acknowledged',
  r."ack_at",
  r."item_id",
  i."type",
  i."state",
  i."version",
  i."party_id",
  COALESCE(i."sandbox", 0),
  'customer_agent',
  NULL,
  'receipt_acknowledged',
  'receipt_ack'
FROM "receipts" r JOIN "items" i ON i."id" = r."item_id"
WHERE r."ack_at" IS NOT NULL;
