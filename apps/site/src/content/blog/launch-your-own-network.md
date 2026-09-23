---
title: Run your own network
description: If you build agents or look after a group of local businesses, you can run a network of your own on the same open protocol as ours, with your own ranking rules.
date: 2026-09-23
author: Tiago Pita
cover: /art/cover-networks.png
coverAlt: A pixel-art dog on a surfboard holding up one envelope, with dotted lines running to four small island lighthouses, each shining a different colour
coverAnim: networks
og: /art/og-networks-v1.png
---

When someone asks an assistant to book a haircut or order a birthday cake, the assistant needs somewhere to look. Our network is one of those places. It's a directory of Surfing Dog inboxes that agents can search. I don't want it to be the only one.

Plenty of people already look after a group of businesses. A plumbers' trade body knows which of its members are qualified. A town council knows the shops on its high street. If you build agents, you may want a directory your own agent can trust. Any of you could run a network, and I'd like you to.

## How it fits together

A network is a web service that inboxes report to. An inbox registers with it once. After that it pings every hour and sends the signed receipts for the bookings and orders it has promised. The network lists the business and answers agents who search.

All of this is written down in public. [ADR-017](https://github.com/surfingdogai/inbox/blob/main/docs/adr/017-reputation-and-ranking.md) sets out every call an inbox makes and what a network should answer. It also has our own ranking rules in full. A separate protocol document is coming, written for people who want to build a network. Our network's code stays private, but you don't need it to build one that works with any Surfing Dog inbox.

An inbox can report to several networks at once. The owner types a network's address in Settings, under Networks, and the inbox starts reporting to it within a minute. A bakery can sit in its town's network and in ours at the same time, so we aren't competing with you for businesses.

The bakery's customers never see any of this. They ask their assistant for a loaf on Saturday morning, and the bakery gets the order.

## Your rules, in public

You decide who you list and in what order. You can copy ours or write your own.

[Our rules](/network/) put businesses whose inbox is online first. Among them, those with a good record of kept promises are ranked by it, and the rest are shuffled once a day. Nobody can buy a place. These rules have been in force since 23 September 2026, and agents can read them at [network.surfingdog.ai/v1/ranking](https://network.surfingdog.ai/v1/ranking). A record will only start to count once inboxes report kept and broken promises, and we're still building that part on the inbox side.

A trade body might list only members who passed its checks. A council might list only businesses inside its borders. You can weigh things differently from us too. Just publish your rules, at `/v1/ranking` where agents look and on a page a person can read. Say what counts and what doesn't. Once other businesses are listed with us, we'll announce every change to our rules 15 days ahead. I'd ask you to give the same notice.

Later, surfingdog.ai may check other networks against the rules in ADR-017 and publish a list of the ones it approves. An inbox could use that list to choose. Running a network, or joining one, never needs our approval.

If you start one, open an issue on [GitHub](https://github.com/surfingdogai/inbox/issues) and tell us. If the protocol is missing something you need, ask for it on the [requests board](/requests/). The spec and SDK are under MIT, so you can build on them without asking.

Then share the inbox with the businesses you work with. It's open source, and on a server they already run it costs nothing extra. The dentist and the bike shop on your list can install it themselves, or paste one line from [surfingdog.ai/install](/install/) into their own AI and let it do the setup.

Our own inbox is live at [inbox.surfingdog.ai](https://inbox.surfingdog.ai/.well-known/agent-inbox.json) and listed on our network, if you want something real to test against.
