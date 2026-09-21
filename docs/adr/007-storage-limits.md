# ADR-007 — Storage limits shape the data model

**Status:** accepted (21 Sep 2026)

## Decision
- **No interactive transactions anywhere in core.** Every write is one atomic `batch()` of
  precomputed statements plus unique constraints and compare-and-set.
- **The event sequence number is the compare-and-set:** `item_events` has `UNIQUE(item_id, seq)`
  and every write inserts the event with `seq = version + 1`, then updates the item `WHERE version
  = ?`. A stale writer fails on the unique index; a failed batch is diagnosed by re-query into
  `idempotent replay`, `idempotency_key_reused`, `version_conflict` or `slot_taken`.
- Idempotency rows are inserted first in the same batch (`PRIMARY KEY(scope, key)`, stored
  response replayed on repeat). Booking slots are rows in `slot_claims` with `PRIMARY KEY
  (resource_key, bucket_start, ordinal)` so capacity and races are arbitrated by the database.
- Item payloads are JSON with virtual generated columns and indexes for type, state, start time,
  party, amount, flags; a new indexed path is `ALTER TABLE ADD COLUMN … VIRTUAL` plus an index, no
  data migration. FTS5 with triggers on thread entries.
- Raw MIME and attachments go to Blob storage, never SQLite. Migrations are forward-only, embedded
  in TypeScript, run lazily on first request, one atomic batch each.
- Batches stay under 20 statements and 100 bound parameters; heavy work (email parsing, extraction,
  rules fan-out) runs in job consumers, not in the request.

## Why
D1 is auto-commit plus `batch()`, no interactive transactions, 10 GB per database, 100 bound
parameters, 2 MB rows, 50 queries per invocation on the free plan and hard-failing daily limits;
Durable Object SQLite has synchronous transactions; `node:sqlite` has `BEGIN IMMEDIATE`. The only
model that runs unchanged on all three is "one batch, constraints decide". Free-plan Workers give
10 ms of CPU per request.
