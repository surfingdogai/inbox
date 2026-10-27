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

How ready is a business for AI agents today? The [free AI agent readiness checker](https://surfingdog.ai/check)
reads any website the way a customer's assistant would and shows what it can do there, and what to add.

## Install

**We host it for you**, free during the pilot, at an address on your own domain:
[get your agent inbox](https://app.surfingdog.ai/start). Or run it yourself, three ways:

**On your own server**: Point a subdomain, such as inbox.yourbusiness.com, at an Ubuntu or Debian server, then run one command. HTTPS, a backup every night, and updates that undo themselves if they fail.

```bash
curl -fsSL https://surfingdog.ai/install.sh | sudo sh
```

**Docker, or a platform you use**: the image `ghcr.io/surfingdogai/inbox`, for amd64 and arm64. The data
lives in the volume. [deploy/](deploy/) has the Compose file with HTTPS, and templates for Coolify,
Fly.io, Render, Railway and a DigitalOcean Droplet. By hand, it answers on the server itself only,
behind a proxy with TLS that drops a `CF-Connecting-IP` the caller sent:

```bash
(umask 077; echo "INBOX_SECRET_KEY=$(openssl rand -base64 32)" > inbox.env)   # keep a copy somewhere safe
docker run -d --name inbox --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -v inbox-data:/opt/inbox/data --env-file inbox.env \
  -e INBOX_OWNER_EMAIL=you@yourbusiness.com -e INBOX_PUBLIC_URL=https://inbox.yourbusiness.com \
  ghcr.io/surfingdogai/inbox:0.1.0
```

**Cloudflare Workers**, with D1, a queue and a cron. Press
[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/surfingdogai/inbox).
What to have ready, and what to do after, is in the
[quickstart](https://surfingdog.ai/docs/quickstart/#deploy-to-cloudflare). By hand, it's path A of
the [install guide](https://surfingdog.ai/install.md).

From source, on **Node** 22.16+, 24 or 26 (one process and one SQLite file):

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox
pnpm install
pnpm --filter @surfingdog/inbox build
node apps/inbox/dist/server.mjs        # http://localhost:8787
```

Or give your AI the install guide and let it do the work: it is written for that, with a check
after every step. The whole guide to running it yourself, with updates and backups:
[surfingdog.ai/docs/run-it-yourself](https://surfingdog.ai/docs/run-it-yourself/).

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

How to send a change, ask for an integration or report a security problem: [CONTRIBUTING.md](CONTRIBUTING.md)
and [SECURITY.md](SECURITY.md).

- `apps/inbox`: the server and the owner app, one codebase for Workers and Node
- `deploy`: the self-host kit: the one-command installer, the Compose file, the `inbox` command, platform templates
- `apps/site`: surfingdog.ai, with the docs. It counts visits with Cloudflare Web Analytics only when built with
  `WEB_ANALYTICS_TOKEN` set, as our deploy does; any other build sends nothing anywhere
- `packages/core`: items, their states, rules and receipts
- `packages/adapters`: REST, MCP, sign-in, email in, webhooks and networks
- `packages/platform`: the database, mail and job seams for each runtime
- `packages/spec`: the discovery manifest and receipt formats, with test vectors
- `packages/sdk`: verify webhooks; sign requests and check receipts from a customer's agent
- `packages/ui`: design tokens and components
- `packages/network-check`: checks a network against the [network protocol](docs/protocol/network.md)
- `examples/network`: a small network of your own, at the protocol's directory level

## Licence

MIT, for everything in this repository: the server, the app, the site, the spec, the SDK, `packages/network-check` and `examples/network`. You can run it, change it and build on it; nothing you build has to be shared. See [LICENSE](LICENSE).
