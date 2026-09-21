# ADR-008 — Licences

**Status:** accepted by default (21 Sep 2026)

## Decision
AGPL-3.0-only for the server and the app (`apps/*`, `packages/core`, `packages/platform`,
`packages/ui`, channels, adapters, connectors, AI, hosted). MIT for `packages/spec` (manifest,
receipt and review formats with test vectors), `packages/sdk` (typed client) and the connector SDK.

## Why
The product stays open and self-hostable; anyone can implement a compatible instance, agent or
review service, and integrate without licence friction.

## Consequences
Every package carries its own LICENSE; the root LICENSE is AGPL-3.0. Contributions to MIT packages
must not import AGPL code.
