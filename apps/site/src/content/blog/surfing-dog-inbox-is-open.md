---
title: Surfing Dog Inbox is open
description: What it is, what is live today, and what comes next.
date: 2026-09-21
author: Tiago Pita
cover: /art/blog-hello.png
coverAlt: A pixel-art dog lying on a surfboard on a calm sea, a striped sun setting behind it
---

Every small business already has an inbox. It is where the bookings arrive, and the orders, and the "do you do this" questions, and the person who wants a price for something you have never priced before. It works because a human reads it. It stops working the moment something that is not a human starts writing to it, and that moment is here: assistants now book tables, order parts and ask for quotes on behalf of the people who used to do it themselves.

The obvious answer is to give the assistants a form. The better answer, I think, is to give everyone the same inbox and make it typed. That is what Surfing Dog Inbox is: an open-source inbox where every request, whoever or whatever sent it, becomes a booking, an order, a quote request or a message with a state machine behind it. Rules take care of the routine. You take care of the rest, or your own AI does, with the same tools. It is fully usable with no AI at all.

## What is live today

The repository is public at [github.com/surfingdogai/inbox](https://github.com/surfingdogai/inbox) under AGPL-3.0, with the formats and the SDK under MIT so anyone can build an instance, an agent or a review service without asking.

A live instance is running at [inbox.surfingdog.ai](https://inbox.surfingdog.ai/.well-known/agent-inbox.json). It is Surfing Dog's own inbox, and it answers agents right now: a manifest at `/.well-known/agent-inbox.json`, an OpenAPI document, a public MCP server, and an owner MCP server behind OAuth 2.1. You can list its services, check availability, request a booking and read it back with the access token you were given. If you send something malformed it will tell you exactly which field to fix. Oficina Maré, a bicycle workshop in Ericeira, is the seed business a fresh instance can load for a look around.

Under it is the part I care about most. One codebase runs on Cloudflare Workers and on plain Node, from the same tests. Every write is a single batch with unique constraints and a version number deciding who wins, because that is the only model that runs unchanged on D1, on Durable Object SQLite and on `node:sqlite`. Every transition is an event with an actor and a reason. The rules engine is plain JSON, evaluated with no I/O. None of that is visible on a landing page, and all of it is why the thing will still be standing in five years.

There is also a plan, written down, with fourteen decision records behind it. They cover the unglamorous questions: which well-known name to use, how email works on each target, why the network service is Go and Postgres while the inbox is TypeScript, and what the law says about a reputation score. I would rather publish the reasoning than ask anyone to trust the result.

## What is not there yet

Honesty is cheaper than support tickets, so: the owner app, the screens where a person works the inbox, shipped its first version today, with sign-in by an emailed link or an owner key, a three-pane inbox, a typed item view whose next actions are its buttons, and settings, including which network the instance reports to. It is a first version. Passkeys are not in it yet, and the wizard that sets an instance up is not there. Receipts, which I will write about separately, are designed and stubbed but not issued. Connectors to calendars and shops come after that. The hosted edition, for businesses that do not want to run anything, is not open yet, and neither is the review service on the network.

The landing page shows live numbers from the network. Today they are small, and when the network is unreachable they say so calmly instead of pretending. I want that page to stay honest as the numbers grow.

## What comes next

This first stretch ends when a fresh deploy reaches a confirmed sandbox booking through the public MCP in under ten minutes, following only the docs, on both targets. That is the whole definition of done, and it is a good one because it forces the docs, the deploy button, the Node bundle and the agent path to work at the same time.

After that comes the work that makes it useful in the real world: a free-text email becomes a correct typed booking in a calendar, an order placed through the public API reaches the shop it belongs to, and both come with receipts. Then the network: a directory of agent-reachable businesses, receipt-verified reviews with a simultaneous reveal, and hosting.

If you run a business and want an inbox that agents can use without you losing the plot, deploy one, or leave your address on the waitlist. If you build agents, read the manifest and tell me what is missing. If you build software for small businesses, the connector SDK is MIT and the door is open.

The dog is on the wave. Let's see where it goes.
