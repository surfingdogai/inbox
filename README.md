# Surfing Dog Inbox

An open-source, self-hostable **typed inbox for businesses**. It receives messages, quote
requests, orders and bookings from people and from AI agents — through email, a web form, REST
and MCP (and every agent protocol we can reasonably speak) — and turns them into structured
items with a lifecycle that can be handled by rules, by the owner, or by the owner's own AI.

Status: **the groundwork complete** (research, decisions, scaffold, design kit). Nothing here is usable yet.
Read the ADRs in [docs/adr/](docs/adr/) first.

```bash
pnpm install
pnpm check && pnpm typecheck
pnpm test:node && pnpm test:workers   # the same suite on Node and inside workerd
pnpm kit                             # builds the design kit into packages/ui/dist/kit
```

- `apps/inbox` — the product: a Hono server + React SPA that runs on Cloudflare Workers and on Node/Bun.
- `packages/core` — domain model, state machines, rules, receipts (AGPL-3.0).
- `packages/platform` — the five runtime interfaces (Db, Blob, Jobs, MailIn, MailOut) and their adapters.
- `packages/spec` — manifest, receipt and review formats with test vectors (MIT).
- `packages/sdk` — typed client for the public and owner APIs (MIT).
- `packages/ui` — design tokens, glass utilities and the kit page.
- `docs/` — ADRs and plans.

Licence: AGPL-3.0 for the server and app; MIT for `packages/spec`, `packages/sdk` and the connector SDK.
