---
title: Contributing
description: Licences, the toolchain, and the rules every change must respect.
---

The repository is [github.com/surfingdogai/inbox](https://github.com/surfingdogai/inbox). Read the decision records in `docs/adr/` before changing architecture; they are short and they explain why things are the way they are.

## Licences

- **AGPL-3.0-only** for the server and the app: `apps/*`, `packages/core`, `packages/platform`, `packages/adapters`, `packages/ui`, and the channels, connectors, AI and hosted packages as they arrive.
- **MIT** for `packages/spec` (the manifest, receipt and review formats with test vectors), `packages/sdk` (the typed client) and the connector SDK, so anyone can implement a compatible instance, agent, review service or integration.

Every package carries its own `LICENSE`. Contributions to the MIT packages must not import AGPL code.

## Toolchain

pnpm 11 and Node 22.16, 24 or 26 (`node:sqlite` needs FTS5, which arrived in 22.16). TypeScript stays on 5.9 because TypeScript 7 has no JavaScript API for the tooling yet.

```bash
pnpm install
pnpm check && pnpm typecheck
pnpm test:node && pnpm test:workers   # the same suite on Node and inside workerd
pnpm dev                              # the inbox on Node, no database set-up needed
pnpm dev:workers                      # the inbox in wrangler dev
pnpm kit                              # the design kit
```

## Rules of the repo

- **One codebase, two runtimes.** Every change must pass `pnpm test:node` and `pnpm test:workers`. Files ending in `.node.test.ts` run only on Node, `.workers.test.ts` only inside workerd; everything else runs on both.
- **Web-standard APIs only** in core packages: `fetch`, `Request`, `Response`, Web Crypto, streams. Node APIs live only in `packages/platform/src/node` and `apps/inbox/src/node.ts`.
- **Zod 4 schemas are the single source of truth** for types, validation, the JSON Schema of MCP tools and the OpenAPI document.
- **No interactive database transactions.** D1 is batch-only; use `batch()`, unique constraints and compare-and-set. `db.transaction()` is banned by lint.
- **`pnpm check` (Biome) and `pnpm typecheck` must be clean.**
- Every protocol is a thin adapter over one capability set; adapters pin their spec version and ship fixtures and a conformance suite, and can be disabled per instance.

## Layout

```
apps/inbox         the product: a Hono server that runs on Workers and on Node
apps/site          this website: Astro, Starlight for the docs
packages/core      domain model, state machines, rules, jobs, receipts (AGPL)
packages/platform  the runtime interfaces (Db, Blob, Jobs, MailIn, MailOut) and their adapters
packages/adapters  the doors: REST + OpenAPI, MCP, email, OAuth, sessions
packages/spec      manifest, receipt and review formats with test vectors (MIT)
packages/sdk       typed client for the public and owner APIs (MIT)
packages/ui        design tokens, glass utilities and the kit page
docs/              the plan and the ADRs
```

## Pull requests

Small, with a test on both runtimes when behaviour changes. If a change needs a decision, write the ADR first: a page with the decision, the why and the consequences, numbered after the last one.
