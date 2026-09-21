# ADR-009 — The network is Go + PostgreSQL/PostGIS on our own server

**Status:** accepted (21 Sep 2026)

## Decision
the network app in our private platform repo, one binary at `network.surfingdog.ai`, following the platform's rules
(stdlib `net/http` ServeMux with method patterns, pgx as the only external dependency plus tern
for migrations and River for jobs if adopted, `log/slog`). PostgreSQL 18.6 + PostGIS 3.6.4:
`uuidv7()` primary keys, `geography` + GiST + `ST_DWithin` + KNN for "near me", H3 cell computed
in Go as a bigint cache key (no `h3-pg`), `STORED` generated `name_norm` via an IMMUTABLE unaccent
wrapper with a trigram GIN index. Receipt JWS verification with stdlib `crypto/ed25519` and a
hand-rolled compact-JWS parser (~120 lines) tested against the spec vectors; `go-jose` v4 is the
fallback. RFC 9421 verification with `WebDecoy/web-bot-auth` or `yaronf/httpsign`.

Schema and API as designed in the groundwork: businesses (domain, manifest snapshot, verification,
geo, categories, protocols, maintained counters), key history with rotation grace, principals
(pseudonymous, erasable), receipts with nonce dedup, reviews (sealed → revealed, commitment hash),
fact and outcome code registries, reputation events with decay and contests, give-to-get credits,
jobs with `FOR UPDATE SKIP LOCKED`, an UNLOGGED token-bucket table, an audit log. Instances
authenticate with a signed proof from their manifest key; agents with a self-contained JWK proof.

Ops: pgBackRest to an object-locked object storage bucket plus a second backup target; Postgres
data on a block volume before the network grows; Cloudflare Full (strict) with Caddy DNS-01,
Authenticated Origin Pulls and the Cloudflare IP allowlist; Bot Fight Mode off; edge-cached
directory reads with `s-maxage` and cache tags.

## Why
Tiago: "the review API/directory and core business I prefer if it runs on Go as a strong API with
Postgres, because we need something linked to data, geolocation and become eventually a
directory." The map already lives on this box in PostGIS.

## Consequences
Two languages. The MIT spec package is the contract; a Go conformance test reads the same vectors.
