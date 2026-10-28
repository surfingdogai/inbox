---
title: "Is your website ready for AI agents? Here's how to check"
description: "What an AI agent reads on a business website, what Cloudflare's Agent Readiness score and our check each look at, and a ten-minute test you can do yourself."
date: 2026-10-28
author: Surfing Dog
coverAnim: agentready
og: /art/og-agentready-v1.png
checkForm: true
---

"Is my website AI ready?" sounds like one question. It's two.

The first is whether an AI can read your site: fetch the pages, be allowed to, and find the words it came for. The second is whether a customer's assistant can do anything there: ask you something, book a time, order, pay, and get an answer.

A site can pass the first and fail the second. Then it's a brochure. The assistant learns all about you, and books somewhere else.

There are free checks for both now. Here's what two of them look at, and how to test your own site by hand.

## Cloudflare's Agent Readiness score

On 17 April 2026 Cloudflare [launched a scanner](https://blog.cloudflare.com/agent-readiness/) at [isitagentready.com](https://isitagentready.com/). You give it an address, it sends requests to the site, and it scores what it finds in four groups:

- **Discoverability**: a robots.txt, a sitemap, and Link headers that point agents to the right places.
- **Content**: whether the site will hand an agent Markdown instead of a full web page when it asks. llms.txt is not checked unless you switch it on.
- **Bot access control**: content signals in robots.txt (whether your pages may be used for training, for answers, for search), rules for AI bots, and Web Bot Auth, a way for real agents to prove who they are.
- **Capabilities**: machine doors such as an MCP server card, an API catalogue, OAuth discovery, Agent Skills and WebMCP.

It also looks for three commerce standards, x402, UCP and ACP, but Cloudflare says those don't count towards the score yet. For each check that fails, it writes a prompt you can hand to a coding agent.

Cloudflare ran the same checks on 200,000 of the most visited domains. About 78% had a robots.txt, but most were written for search engines, not agents. About 4% declared content signals. About 3.9% passed the Markdown check. MCP server cards and API catalogues together turned up on fewer than 15 sites.

It's a good test of the web's plumbing. Most of it is work for whoever runs your hosting.

## What our check looks at

[Our check](/check) asks a narrower question: what can a customer's assistant actually do with this business?

It reads your own site and the doors it publishes, the way an assistant would, and looks for each thing a customer might send one to do: send a message, ask for a quote, book, order, sign up, pay. Then the things that come after: change, cancel, return, track. Every check ends in a score from 0 to 100, worked out by [rules we publish](/guides/#score).

What counts depends on the kind of business. A salon is scored on bookings, a shop on orders, a plumber on quotes. Something that doesn't apply to you is left out, so it never counts against you.

Here's what that looks like across the web. On 28 October 2026 our crawler had checked 2,570,532 business websites. Of those, 86,513 had at least one door an agent could use. Nearly all of them were online shops with a checkout made for agents. Only 66 could take a booking that way, and 501 a message.

So a shop on the right platform may be ready without knowing it. A restaurant, a salon or a plumber almost never is.

## A ten-minute test you can do yourself

You don't need either tool to get a first answer. Open your site in another tab and go down this list.

### 1. Read your robots.txt

Go to yoursite.com/robots.txt. Look for lines that name AI crawlers, such as GPTBot, OAI-SearchBot, ClaudeBot or Claude-SearchBot, and for `Disallow: /` under them. A line written years ago to stop one scraper can shut out an assistant's search today. [The AI crawler checker](/check/ai-crawlers) reads the file for you and shows which line decides each crawler.

Check your host's settings too. Some hosts and firewalls block AI crawlers before robots.txt is even read. Cloudflare [began blocking them by default](https://www.cloudflare.com/press/press-releases/2025/cloudflare-just-changed-how-ai-crawlers-scrape-the-internet-at-large/) in July 2025, and asks each new domain whether to let them in.

### 2. Look at the page without its scripts

Right-click your page and choose View Page Source, or press Ctrl+U (Cmd+Option+U on a Mac). Search for one of your prices and for your opening hours.

If they aren't in the source, many AI crawlers won't see them. Most fetch your HTML and never run the scripts that fill the page in. [Can AI read your website?](/blog/can-ai-read-your-website/) explains which ones do and which don't.

### 3. Look for your details as data

In the same source, search for `application/ld+json`. That's where a site says, as data, what it is: its name, address, opening hours, prices. An assistant trusts that more than a sentence it has to interpret. [The guide to business details](/guides/business-details-for-ai/) shows what to put there.

### 4. Ask an assistant to do the job

This is the most honest test. Open ChatGPT, Claude or Gemini and ask for the thing your customers want, with your name in it:

- "Book me a haircut at [your salon] on Saturday morning."
- "Order two sourdough loaves from [your bakery] for tomorrow."
- "Ask [your company] for a quote to fix a leaking tap."

Watch where it stops. Does it find you? Does it get your prices right? Does it reach a page where it can finish, or does it give up and hand its person your phone number? Wherever it stops is your first thing to fix.

### 5. Find your door

An agent needs a door: an MCP server it can call, or a page that confirms a booking or an order on the spot. A form that emails you and promises a call back is not one. It's a queue. [Make your agent doors findable](/guides/findable-agent-doors/) shows how to point agents to the door once you have one.

## Which score should you trust?

Neither score is a certificate. Each is what one reader found on the day it looked.

They also measure different things. A site can score well on Cloudflare's plumbing and still have no way to take a booking. A small shop can score well on ours through its platform's checkout and still have a robots.txt that shuts out some of the assistants.

Run both. Then fix what matters for your kind of business first:

- **Restaurants, salons, clinics, studios**: real free times, and a door that confirms a booking.
- **Shops**: ask your platform whether it publishes a checkout for agents. On Shopify, eligible stores have one ([Shopify and AI assistants](/guides/shopify-ai-assistants/)).
- **Trades and services**: a door that takes a quote request with the details you need.
- **Everyone**: prices and hours in plain text, and a robots.txt that lets in the assistants you want.

[The AI agent readiness checklist](/guides/) goes through each step in more detail.

If you want a door without building one, [Surfing Dog Inbox](/how-it-works/) is ours: open source, at an address on your own domain, with a booking page and an MCP server that answer from your rules. Run it yourself, or have us host it for free.
