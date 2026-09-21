# ADR-011 — SQLite drivers: one async path over our own client

**Status:** accepted (21 Sep 2026)

## Decision
Core uses `drizzle-orm/sqlite-proxy` everywhere, driven by our `SqliteClient { query(stmt),
batch(stmts) }`. Adapters: D1 (`prepare/bind/raw`, `batch`), Durable Object SQLite (`sql.exec`,
`transactionSync`), `node:sqlite` (`DatabaseSync`, `BEGIN IMMEDIATE`, WAL, busy timeout 5 s),
`bun:sqlite`. `db.transaction()` is banned by lint and overridden to throw. Values: TEXT ULIDs,
INTEGER milliseconds UTC, INTEGER booleans, JSON as TEXT, no BLOB columns.

Node engines `^22.16 || ^24 || >=26`; the boot check asserts `ENABLE_FTS5` in
`PRAGMA compile_options`. On macOS, Bun loads Apple's SQLite 3.43 with an FTS5 bug, so dev on Bun
sets `Database.setCustomSQLite`. `better-sqlite3` stays an optional fallback.

## Why
Drizzle 0.45 has no `node:sqlite` driver (only the 1.0 release candidate does), and its sync
drivers have no `batch`. A proxy over our own client gives one async, batch-only code path that
matches ADR-007 on all runtimes with zero native compilation on Node. `node:sqlite` in Node 26
ships SQLite 3.53 with FTS5 and JSON1 (verified locally).

## Consequences
A ~150-line adapter per runtime plus a shared contract test suite (batch atomicity, unique
violation classification, RETURNING, generated columns via EXPLAIN, FTS triggers, parameter
chunking).
