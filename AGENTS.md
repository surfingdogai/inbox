# Working in this repo (for coding agents)

- Read `docs/adr/` before changing architecture.
- One codebase, two runtimes: every change must pass `pnpm test:node` and `pnpm test:workers`.
- Core packages use web-standard APIs only (fetch, Request/Response, Web Crypto, streams). No Node
  APIs outside `packages/platform/src/node` and `apps/inbox/src/node.ts`.
- Zod 4 schemas are the single source of truth (types, validation, JSON Schema for MCP, OpenAPI).
- No interactive DB transactions: D1 is batch-only. Use `batch()` + unique constraints + compare-and-set.
- `pnpm check` (Biome) and `pnpm typecheck` must be clean.
