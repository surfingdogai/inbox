---
title: Overview
description: Start here. What the inbox is, how to run it, and how people and AI agents talk to it.
---

Surfing Dog Inbox is an open-source, self-hostable typed inbox for a business. It receives bookings, orders, quote requests and messages from people and from AI agents, through REST, MCP and email, and turns each one into a typed item with a lifecycle that rules, the owner, or the owner's own AI can handle. It is fully functional with zero AI.

One codebase runs on Cloudflare Workers and on Node. One SQLite database holds everything the business owns. One discovery manifest at `/.well-known/agent-inbox.json` tells an agent where the REST, OpenAPI and MCP doors are.

To see what an assistant can already do with your website, before you install anything or after, [check your website for AI agents](/check).

## Where things stand

Written on 31 October 2026, for release 0.2.0. Every page in these docs says whether a feature is live.

- **The inbox**, open source, on Cloudflare Workers and on Node: typed items with their state machines and append-only events; rules with presets for appointments, trades and shops; REST with an OpenAPI document, a public MCP server and an owner MCP server; sign-in by an emailed link or code, owner keys and OAuth for your own AI; the owner app; the email door; the [spam filter](/docs/spam/); signed [receipts](/docs/receipts/) and [webhooks](/docs/webhooks/).
- **Hosted**: <!-- hosted: open -->we run it for you at an address on your own domain, like `inbox.yourbusiness.com` ([Get your agent inbox](/docs/get-your-agent-inbox/)): Free, or Pro at $10, €10 or £9 a month, whose three AI spam filters are on from the start.<!-- hosted: closed -->not open yet; until it is, run it yourself.<!-- hosted: end -->
- **Connections** to calendars, payments, shops, property systems, ordering systems and job tools: built, not yet verified on a live account ([Integrations](/docs/integrations/)).
- **The network** at [network.surfingdog.ai](https://network.surfingdog.ai/v1/stats): the directory, signed hourly pings, and each member's track record, its promises kept, broken and still open, as the business's own word until the network can confirm them with its customers ([Receipts](/docs/receipts/#networks)).
- **Our own inbox**, live at [inbox.surfingdog.ai](https://inbox.surfingdog.ai/.well-known/agent-inbox.json).

Still to come: <!-- hosted: closed -->hosted tenancy and <!-- hosted: end -->customer records on the network, paused until their privacy safeguards are finished.

## Pages

- [Quickstart](/docs/quickstart/): <!-- hosted: open -->let us host it, deploy to Cloudflare, or run it on your own server<!-- hosted: closed -->deploy to Cloudflare, run on your own server, or join the hosted waitlist<!-- hosted: end -->, then make your first calls.
- [Run it yourself](/docs/run-it-yourself/): one command on your own server, the Docker image on a [platform](/docs/platforms/) you use, or Cloudflare Workers; updates that roll back, and [backups](/docs/backups/).
- [Setting a business up for agents](/docs/setting-up-for-agents/): guidance, not rules, from a real installation: the inbox as the front door, or as a thin agent door in front of the tools a business already has; what handles each door; making doors findable; payments; helpdesk bridges.
- [Concepts](/docs/concepts/): items and their states, rules, agent policy and trust tiers, networks, and receipts: promises kept, broken or still open.
- [Spam filter](/docs/spam/): what it keeps off your desk, what it never loses, what leaves your server and when, and connecting your own AI model.
- [Connect your AI](/docs/connect-your-ai/): let Claude, ChatGPT or any MCP client work your inbox through the owner MCP.
- [Integrations](/integrations/): every system the inbox connects to, in one table, and what is coming; each one's steps are in [the docs](/docs/integrations/).
- [API](/docs/api/): every public and owner operation, and the conventions they share.
- [Manifest](/docs/manifest/): the discovery document an instance publishes.
- [Self-hosted vs hosted](/docs/self-hosted-vs-hosted/): an honest comparison.
- [Security and privacy](/docs/security-and-privacy/): what leaves the instance, and what never does.
- [Contributing](/docs/contributing/): the licence, the toolchain and the rules of the repo.

The source is at [github.com/surfingdogai/inbox](https://github.com/surfingdogai/inbox); the plan and the architecture decision records live in its `docs/` folder.
