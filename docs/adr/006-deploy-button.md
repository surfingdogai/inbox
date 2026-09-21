# ADR-006 — The Deploy to Cloudflare button

**Status:** accepted (21 Sep 2026), verification pending a public repo

## Decision
Keep one monorepo. Make the button target self-contained: a root-level `wrangler.jsonc` whose
`main` and `assets` point at built output, a root build script, and `.dev.vars.example` for the
secrets the button prompts for. Run the button for real as soon as the repo is public. If the
button chokes on the workspace, publish a CI-generated, prebuilt `inbox-deploy` template repo per
release (also the source of the `npx` tarball).

## Why
The button (`deploy.workers.cloudflare.com/?url=<repo>`) auto-provisions KV, D1, R2, Hyperdrive,
Vectorize, Secrets Store, Durable Objects, Workers AI and Queues from the wrangler config, but not
Email Routing, Email Sending or Workflows; it needs a public GitHub/GitLab repo; a subdirectory
is treated as the repo root and must carry its own dependencies.

## Consequences
The wizard's email step handles routing after deploy. The button flow is part of the first release's
"done when": a fresh deploy reaches a confirmed sandbox booking in under ten minutes.
