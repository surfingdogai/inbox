# ADR-001 — Repositories and layout

**Status:** accepted (21 Sep 2026)

## Decision
- The Inbox is a new repository, `surfingdogai/inbox` (GitHub org `surfingdogai`, created by Tiago on
  21 Sep 2026; private until he makes it public), a pnpm monorepo: `apps/inbox` (Hono server + React SPA), `apps/site` (Astro + Starlight,
  the first release), `packages/{core,platform,spec,sdk,ui,channels,adapters,connectors,ai,hosted}`.
- The network service is an app in our **private platform repo**, deployed
  to `network.surfingdog.ai`. It is not part of the OSS repo.
- `packages/spec` (MIT) holds the wire formats and test vectors; the Go service copies the vectors
  with a pinned tag and sha256 check.

## Why
The Inbox is TypeScript, AGPL and public; our Go monoliths have
different stacks, licences and audiences. Our private platform already provides a server, PostgreSQL 18 +
PostGIS, Cloudflare DNS, Caddy, systemd, magic-link sign-in and Stripe — the network gets all of
it for free, and its geo data sits next to the map's.

## Consequences
Two repos to release in step; the spec package is the contract between them. Local path `~/surfingdog-inbox`.
