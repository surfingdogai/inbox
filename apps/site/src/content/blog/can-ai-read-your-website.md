---
title: "Can AI read your website? What it sees without JavaScript"
description: "Most AI crawlers fetch a page's HTML and never run its scripts. What ChatGPT, Claude and Gemini see on a business website, and how to test yours in a minute."
date: 2026-10-28
author: Surfing Dog
coverAnim: rawhtml
og: /art/og-rawhtml-v1.png
checkForm: true
---

Ask an assistant when your shop opens on Sunday, and sometimes it gets it wrong. It isn't always making things up. Often it never saw the page you see.

Your browser loads a page, runs its scripts, and fills in the menu, the prices and the booking calendar. Most AI crawlers do the first step and stop. They read the HTML your server sends, and whatever a script would have added later simply isn't there for them.

## Four kinds of AI visitor

AI companies send different visitors for different jobs. Each has its own name, which your server logs and your robots.txt can see.

- **Training crawlers** collect pages that may be used to train future models. OpenAI's is GPTBot and Anthropic's is ClaudeBot.
- **Search crawlers** build the index an assistant searches when someone asks a question. OpenAI's is OAI-SearchBot, Anthropic's is Claude-SearchBot. Google's AI Mode and Gemini rely on Google's own crawler.
- **Fetchers on request** come when a person asks an assistant to look at a page: ChatGPT-User, Claude-User. [OpenAI notes](https://developers.openai.com/api/docs/bots) that robots.txt rules may not apply to ChatGPT-User, because a person asked.
- **Agents with a browser**, such as ChatGPT's agent, OpenAI's dots or Claude in Chrome, open your site in a real browser to get something done. They run your scripts like any visitor, but they come later, when someone wants to book or buy, and usually after search found you, or when a person sends them straight to your address.

Blocking one doesn't block the others. [Anthropic's own page](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler) describes its three separately, and so does [OpenAI's](https://developers.openai.com/api/docs/bots).

## What the crawlers actually see

In December 2024 Vercel and MERJ [looked at a month of AI crawler traffic](https://vercel.com/blog/the-rise-of-the-ai-crawler) across Vercel's network. None of the major AI crawlers ran JavaScript. OpenAI's crawlers, ClaudeBot, PerplexityBot and Meta's crawler all read the HTML as it arrived. ChatGPT's crawler downloaded script files in 11.5% of its requests and Claude's in 23.8%, but neither ran them.

The exceptions were Gemini, which uses Google's crawler and so gets Google's full rendering, and Apple's crawler, which also renders pages in a browser.

A test by RESONEO [in January 2026](https://think.resoneo.com/sentinel/geo-llm-crawler-report.html) found the same for fetchers. ChatGPT and Claude, sent to a test page, read its raw HTML and missed everything a script had added. So did Gemini, once it actually fetched the page.

These are snapshots. Crawlers change without notice. But the safe plan hasn't changed: whatever you want an assistant to know should be in the HTML itself.

## Where small business sites lose their words

Most website builders put your main text in the HTML. The trouble is usually in the parts added on top:

- **Booking widgets.** The free times often live in a calendar that a script loads from another company's site. A crawler sees an empty box, or nothing.
- **Menus and price lists as pictures or PDFs.** A crawler reading HTML gets a file name, not your prices.
- **Prices and stock filled in by a script.** Some shop themes load them after the page arrives.
- **Opening hours in a map embed.** The hours are inside a map loaded from another site.
- **"Loading…" pages.** Sites built entirely in the browser can send almost nothing but a script tag and a placeholder.
- **Cookie walls** that hold the page back until someone clicks.

Say a café has a lovely site with its menu as a photo, its hours in a map and its tables in a booking widget. To a human it's all there. To most AI crawlers it's a name, an address and a nice paragraph about coffee.

## Test yours in a minute

You don't need any tools for a first look.

1. **View the source.** Right-click your page and choose View Page Source, or press Ctrl+U (Cmd+Option+U on a Mac). That's roughly what a crawler gets. Search it for one of your prices, your opening hours and a dish or a service. If they aren't there, most AI crawlers can't see them.
2. **Switch JavaScript off.** In your browser's site settings, block JavaScript for your site and reload. What's left is close to what a crawler reads.
3. **Fetch it plainly.** If you're comfortable with a terminal, `curl https://yoursite.com` shows the HTML your server sends. Some firewalls answer this differently from a browser, which is worth knowing too.
4. **Check who's allowed in.** [The AI crawler checker](/check/ai-crawlers) reads your robots.txt and shows which AI companies' crawlers may visit, and which line decides.

## How to fix it

You rarely need a new website. Usually it's a few parts:

- **Put the words in the page.** Your menu, services, prices and hours as text, not only as images, PDFs or widgets. Keep the PDF if you like, but write the essentials on the page as well.
- **Ask your builder or developer about server rendering.** Most modern builders send full HTML for ordinary pages. For a site built entirely in the browser, the fix is to render pages on the server or ahead of time. It's a known, ordinary change.
- **Describe your business as data.** Your name, address, opening hours and prices in your page's structured data, which crawlers read without running anything. [Your hours, prices and terms as data](/guides/business-details-for-ai/) shows how.
- **Let in the crawlers you want.** A robots.txt that blocks OAI-SearchBot keeps you out of ChatGPT's search answers, [OpenAI says](https://developers.openai.com/api/docs/bots). You can still keep your pages out of training: GPTBot and OAI-SearchBot are separate settings. [robots.txt and content signals for AI agents](/guides/robots-txt-ai-agents/) walks through it.
- **Check your host's bot settings.** Some hosts and firewalls block AI crawlers before robots.txt is even read. Cloudflare [began blocking them by default](https://www.cloudflare.com/press/press-releases/2025/cloudflare-just-changed-how-ai-crawlers-scrape-the-internet-at-large/) in July 2025, and asks each new domain whether to let them in.

## Reading isn't booking

A site every crawler can read still can't take a booking by being read. Once an assistant knows your prices and hours, its person usually wants the next step: a table, an appointment, an order. That needs a door an agent can use, a page that confirms on the spot or an MCP server it can call.

[Is your website ready for AI agents?](/blog/is-your-website-ready-for-ai-agents/) covers that half, and [our check](/check) shows what an assistant finds on your site for both: what it can read, and what it can do.
