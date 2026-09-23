---
title: "Ready for the flood of agent enquiries?"
description: AI assistants have started booking, ordering and asking on people's behalf. An open inbox gives a small business a proper door for them, for little or nothing.
date: 2026-09-23
author: Tiago Pita
cover: /art/hero.png
coverAlt: A pixel-art dog surfing a big wave full of envelopes and notes, with three small robots on surfboards behind it
---

People have started handing small jobs to their assistants. Book the bike in for Saturday. Find a plumber who can come tomorrow and ask what it costs.

The assistant then has to reach you, at whatever hour the person asked. Some already do it the clumsy way. In most of the US, Google will phone a business for a customer to book an appointment or check a price, and a business that doesn't want those calls has to opt out ([Google's help page](https://support.google.com/business/answer/16190256)).

Your email and your contact form were built for people who write a paragraph and wait. An agent wants to know if 10am is free and what it costs, and it wants a clear yes.

## What the inbox does

Surfing Dog Inbox gives people and agents one door. Agents can book, order and ask for quotes directly, over MCP or an API, and email comes in too. Every request lands as a booking, an order, a quote request or a message, and the inbox keeps track of where each one stands. The receptionist at a dental practice sees what is still waiting and who didn't turn up, without digging through threads.

You write the rules, and they answer inside your limits. The dentist can let a check-up confirm itself when the slot is free and the practice is open. The plumber can flag any request that mentions a leak, so it shows up under Needs you.

If you already use an AI, connect it and let it work the inbox, after a day of practice in test mode. If two agents want your last Saturday slot at once, one gets it. When a booking is confirmed or an order is paid, the inbox signs a receipt, so you and the customer keep the same record.

Your customers don't need to know any of this. They just contact you.

The software is free and [open source](https://github.com/surfingdogai/inbox), with nothing held back for a paid tier. On a server you already run, it costs nothing extra. On Cloudflare, the documented route is their Workers Paid plan at $5 a month. Receiving email is free. Sending needs that plan or a free Resend key, good for 3,000 emails a month. It runs on a subdomain of your own domain, like inbox.yourbakery.com.

## Everyone is building a door

In March 2026 Shopify made its stores' products discoverable in ChatGPT by default, and its [agentic storefronts](https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts) also reach Google AI Mode, Gemini, Copilot and Meta. Google's agent checkout works only [in the US, Canada and Australia](https://support.google.com/merchants/answer/16837055), for participating merchants who fill in an interest form and set up Google Pay. OpenAI takes product feeds into ChatGPT [from approved partners](https://developers.openai.com/commerce/guides/get-started) only. Meta's [Business Agent](https://about.fb.com/news/2026/06/meta-business-agent/) answers customers on WhatsApp and Messenger.

An eligible Shopify store got the reach without lifting a finger. But each door belongs to one company and works on its own channel, under terms it can change. A bakery with its own website and a paper order book sits outside all of them.

An open inbox gives you the same kind of door on your own terms. It lives on your domain, and your customer records stay in your own database.

Then you can join networks, the directories agents search when someone asks for a bakery nearby. An inbox can join several, in Settings → Networks. [Ours](/network/) has [public ranking rules](https://github.com/surfingdogai/inbox/blob/main/docs/adr/017-reputation-and-ranking.md), in force now. Businesses whose inbox is online come first. Those with a good record of kept promises are ranked by it, and the rest are shuffled once a day. Nobody can buy a place. Records will count once the inbox reports kept promises, which we're still building. And [anyone can launch a network](/blog/launch-your-own-network/), because the protocol is open.

To start, open [surfingdog.ai/install](/install/) and paste the one line there into your AI. It's told to set the inbox up and to ask you before anything that costs money.
