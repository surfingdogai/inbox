---
title: Surfing Dog Inbox is open
description: An open-source inbox that people and AI agents can both write to.
date: 2026-09-21
author: Tiago Pita
cover: /art/blog-hello.png
coverAlt: A pixel-art dog lying on a surfboard on a calm sea, a striped sun setting behind it
coverAnim: open
og: /art/og-open-v1.png
---

Every small business has an inbox. Bookings land there, and orders, and someone who wants a price for a job you have never priced. It works because a person reads every message.

Some of those messages now come from software. People ask an assistant to book the bike in for a service or order the bread, and the assistant has to reach you somehow. A contact form built for humans is a clumsy way in.

So we built one inbox for both, and put the code on [GitHub](https://github.com/surfingdogai/inbox). You can run it yourself today. The inbox is under the AGPL, and the spec and SDK are under MIT, so you can build on them without asking.

## What it does

Whatever arrives becomes a booking, an order, a quote request or a message. It doesn't matter if it came by email, the web form, or an agent over REST or MCP. Each one has a state, so you can see at a glance what is still waiting for an answer and who didn't turn up.

You set the rules. A bike shop can let small bookings confirm themselves when the slot is free. A plumber can send every quote to a person and bump anything that mentions a leak to the top. The rules handle the routine and you handle the rest, or your own AI does. You don't need any AI to use it.

When a booking is confirmed or an order is paid, the inbox signs a receipt, a small note of what was promised. The customer's agent can counter-sign it, so both sides keep the same record. The customer is named in it only by a code.

Our own inbox is live at [inbox.surfingdog.ai](https://inbox.surfingdog.ai/.well-known/agent-inbox.json). Point an agent at it and it can ask for a half-hour intro call with me.

## The network

Turn on the network in Settings and you're listed in a directory that agents search when someone asks for a bakery nearby. Every hour your inbox sends the network a count of what arrived in the last day, plus a copy of each receipt it signs. Your customers' messages and details stay with you.

The directory has no favourites. Businesses whose inbox is online come first, and the rest are shuffled once a day until they have a record. Nobody can buy a better spot, now or later.

We're building reputation now, earned by keeping promises on both sides of the counter. A small shop that always delivers will be able to rank above a big one that sometimes doesn't. A customer who always turns up might get to skip the deposit. We'll publish the rules before they count.

Anyone can launch a network of their own. A trade body could run one for its members.

We don't host inboxes for anyone else yet. That's coming, and the waitlist is on the [home page](/#run).

If you build agents, point one at our inbox and tell us what's missing.

The dog is on the wave. Let's see where it goes.
