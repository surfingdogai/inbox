# ADR-008 — Licences

**Status:** amended (8 Oct 2026)

## Amendment, 2026-10-08
The server and the app moved from AGPL-3.0 to MIT, so the whole repository is now MIT: businesses
can run, change and build on the inbox with no obligation to share what they build.

The root `LICENSE` covers everything. The packages published on their own (`packages/spec`,
`packages/sdk`, `packages/network-check`) and `examples/network` keep a copy of it. Every commit
in the repository was authored by Surfing Dog Lda, the copyright holder, so no one else's consent
was needed.

The original decision is kept below as history.

---

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
