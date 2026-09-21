---
title: Overview
description: Start here. What the inbox is, how to run it, and how people and AI agents talk to it.
---

Surfing Dog Inbox is an open-source, self-hostable typed inbox for a business. It receives bookings, orders, quote requests and messages from people and from AI agents, through email, a web form, REST and MCP, and turns each one into a typed item with a lifecycle that rules, the owner, or the owner's own AI can handle. It is fully functional with zero AI.

One codebase runs on Cloudflare Workers and on Node. One SQLite database holds everything the business owns. One discovery manifest at `/.well-known/agent-inbox.json` tells an agent which doors are open.

## Where things stand

Written on 21 September 2026. the groundwork (research, decisions, scaffold) is complete and the first release (the self-hosted MVP) is under way. Working today, on both runtimes:

- the core write path: typed items, five state machines, append-only events, idempotency keys and compare-and-set versions;
- the rules engine, with presets for appointments, trades and shops;
- REST with an OpenAPI document, a public MCP server and an owner MCP server;
- owner API keys, owner sign-in by magic link, and an OAuth 2.1 authorization server for the owner MCP;
- the owner app, first version: sign in with an owner key, a three-pane inbox, a typed item view with the valid next actions as buttons, and settings;
- the email door: inbound MIME parsed, deduplicated and threaded onto the right item;
- the job runner for notifications and rules, on cron and queues on Workers and on a loop on Node;
- network membership: an instance joins a network from settings and reports counts-only telemetry every hour;
- a live demo instance at [inbox.surfingdog.ai](https://inbox.surfingdog.ai/.well-known/agent-inbox.json) and the network at [network.surfingdog.ai](https://network.surfingdog.ai/v1/stats).

Still to come: the setup wizard, passkeys and email sign-in in the app (the first release), receipts and connectors (the next release), hosted tenancy and the network's directory, reviews and reputation (a later release). Every page in these docs says which phase a feature belongs to.

## Pages

- [Quickstart](/docs/quickstart/): deploy to Cloudflare, run on your own server, or join the hosted waitlist, then make your first calls.
- [Concepts](/docs/concepts/): items and their states, rules, agent policy and trust tiers, receipts and two-sided reviews.
- [Connect your AI](/docs/connect-your-ai/): let Claude, ChatGPT or any MCP client work your inbox through the owner MCP.
- [API](/docs/api/): every public and owner operation, and the conventions they share.
- [Manifest](/docs/manifest/): the discovery document an instance publishes.
- [Self-hosted vs hosted](/docs/self-hosted-vs-hosted/): an honest comparison.
- [Security and privacy](/docs/security-and-privacy/): what leaves the instance, and what never does.
- [Contributing](/docs/contributing/): licences, the toolchain and the rules of the repo.

The source is at [github.com/surfingdogai/inbox](https://github.com/surfingdogai/inbox); the plan and the architecture decision records live in its `docs/` folder.
