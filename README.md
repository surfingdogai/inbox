# Surfing Dog Inbox

An inbox for the bookings, orders, quote requests and messages that people and their AI agents send
a business. Your rules answer the routine ones, and you see the rest. Open source, and you run it.

## Try it in 60 seconds

Add our demo bike shop to Claude or ChatGPT as a custom connector (an MCP server):

```
https://demo.surfingdog.ai/mcp
```

Then ask it: *"Book a bike service with Oficina Maré on Saturday morning."* Watch the booking arrive,
and the shop confirm it, at https://demo.surfingdog.ai/demo/live. The demo never emails anyone who uses
it, shows no names and is wiped every night.

The same with curl, step by step: https://surfingdog.ai/try/

## Install

**Node** 22.16+, 24 or 26. One process and one SQLite file.

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox
pnpm install
pnpm --filter @surfingdog/inbox build
node apps/inbox/dist/server.mjs        # http://localhost:8787
```

**Docker**, built from this repository. The database lives in the volume.

```bash
docker build -t surfingdog-inbox .
docker run -p 8787:8787 -v inbox-data:/opt/inbox/data surfingdog-inbox
```

**Cloudflare Workers**, with D1, a queue and a cron. Press
[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/surfingdogai/inbox).
What to have ready, and what to do after, is in the
[quickstart](https://surfingdog.ai/docs/quickstart/#deploy-to-cloudflare). By hand, it's path A of
the [install guide](https://surfingdog.ai/install.md).

Or give your AI the install guide and let it do the work: it is written for that, with a check
after every step.

## Docs

- [Quickstart](https://surfingdog.ai/docs/quickstart/): every setting, Docker, and a public demo of your own
- [Connect your AI](https://surfingdog.ai/docs/connect-your-ai/): the owner's MCP server
- [API](https://surfingdog.ai/docs/api/): REST and MCP; every instance also serves `/openapi.json`
- [Decision records](docs/adr/): read these before changing how things work

## Working on it

```bash
pnpm dev               # the server on Node, http://localhost:8787
pnpm dev:workers       # the same app on workerd
pnpm test              # every test, on Node and on Workers
./scripts/verify.sh    # everything CI runs
```

- `apps/inbox`: the server and the owner app, one codebase for Workers and Node
- `apps/site`: surfingdog.ai, with the docs
- `packages/core`: items, their states, rules and receipts
- `packages/adapters`: REST, MCP, sign-in, email in, webhooks and networks
- `packages/platform`: the database, mail and job seams for each runtime
- `packages/spec`: the discovery manifest and receipt formats, with test vectors
- `packages/sdk`: verify webhooks; sign requests and check receipts from a customer's agent
- `packages/ui`: design tokens and components

## Licence

AGPL-3.0 for the server and the app. MIT for `packages/spec` and `packages/sdk`.
