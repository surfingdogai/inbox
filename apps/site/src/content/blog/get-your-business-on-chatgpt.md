---
title: "How to get your business on ChatGPT: found, recommended, booked"
description: "There's no listing to buy. How ChatGPT finds a business, what it reads before it recommends one, and how a customer's ChatGPT can book or order with you."
date: 2026-10-28
author: Surfing Dog
coverAnim: found
og: /art/og-found-v1.png
checkForm: true
---

"How do I get my business on ChatGPT?" There's no listing to buy, and for most businesses no form to fill in. What people mean by "on ChatGPT" is really three things, one after the other:

1. **Found**: ChatGPT can reach your website and knows you exist.
2. **Recommended**: when someone asks for what you do, near where you are, it names you, and gets your details right.
3. **Booked**: when they say "go on then", it can actually book, order or ask you something.

The first two get you named. The third is where the customer is won or lost.

## 1. Found: let ChatGPT's search in

ChatGPT answers many questions by searching the web, and it has its own crawler for that, OAI-SearchBot. [OpenAI's documentation](https://developers.openai.com/api/docs/bots) is plain about it: sites that block OAI-SearchBot won't be shown in ChatGPT's search answers. To appear, allow it in your robots.txt. OpenAI says a change there takes about a day to count.

It's a separate setting from training. GPTBot is OpenAI's training crawler, and blocking it doesn't keep you out of search. You can allow one and refuse the other.

Two things to check today:

- **Your robots.txt.** [The AI crawler checker](/check/ai-crawlers) shows which AI crawlers your file lets in, and which line decides. [robots.txt and content signals for AI agents](/guides/robots-txt-ai-agents/) explains each setting.
- **Your host's bot settings.** Some hosts and firewalls block AI crawlers before robots.txt is even read. If you use one, look for a setting about AI bots.

There's one more door worth opening. BrightLocal, which [studied ChatGPT's local results](https://www.brightlocal.com/research/uncovering-chatgpt-search-sources/), wrote that ChatGPT's search drew mostly on Bing's index. Adding your site to [Bing Webmaster Tools](https://www.bing.com/webmasters) and claiming your business on [Bing Places](https://www.bingplaces.com) costs nothing, and many businesses have only ever done Google's.

## 2. Recommended: what ChatGPT reads about you

In the same study, BrightLocal ran 800 local searches in ChatGPT, for 20 kinds of business in 20 US cities, and noted the sources behind each answer. 58% were the businesses' own websites. For searches where someone wanted to buy or book, it was 72%. Directories made up 15%, and mentions on other sites, Wikipedia among them, 27%.

That study is from late 2024, and ChatGPT has changed since. Still, your own website is the one source about you that you control. So make it easy to read.

- **Say what you do, in words.** "Dog grooming by the station, from €35, Tuesday to Saturday" beats a slogan. Services, prices, opening hours and where you are, as text on the page.
- **Keep it in the HTML.** Many AI crawlers never run your page's scripts, so a menu in a widget or prices in a photo may be invisible to them. [Can AI read your website?](/blog/can-ai-read-your-website/) shows how to check.
- **Add it as data.** Your name, address, hours and prices in your page's structured data. [Your hours, prices and terms as data](/guides/business-details-for-ai/) shows what to add.
- **Say the same thing everywhere.** If your site says you close at 6 and your listings say 7, an assistant has to pick one. Fix the listings when you change your hours.

Can you pay to be recommended? Not in the answers. ChatGPT now shows ads in some countries, and businesses can buy them, but OpenAI says [ads don't influence ChatGPT's answers](https://openai.com/index/testing-ads-in-chatgpt/) and are labelled as sponsored. Being named in the answer itself comes from what ChatGPT can read.

## 3. Booked: give ChatGPT a way to act

Being recommended is half a win. The person reads your name and says "book it". What happens next depends on the door you have:

- **A booking platform it works with.** Since August 2026 ChatGPT [books tables](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) through OpenTable worldwide, Resy in the US and Yelp in the US and Canada. If you take bookings there, it can probably book you already ([an AI assistant for your restaurant](/blog/ai-assistant-for-restaurants/)).
- **A shop it can send buyers to.** ChatGPT finds and compares products, and the buyer pays in the shop's own checkout. [How to sell on ChatGPT](/guides/sell-on-chatgpt/) covers how products get in.
- **An app or a connector.** Since December 2025 developers can [submit apps](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/) to ChatGPT, each one an MCP server, the standard way assistants plug into a service, with a review behind it. That suits a booking system serving thousands of businesses more than one café. A person on a paid plan can also add an MCP server as a connector, in developer mode ([your business in ChatGPT](/assistants/chatgpt/)).
- **A page that answers.** ChatGPT's agent, and OpenAI's always-on dots, can use a browser. They can finish a booking on your own page, if that page confirms on the spot rather than promising a call back ([OpenAI's dots can book a table](/blog/openai-dots-and-your-business/)).

If none of these is true, ChatGPT can still tell your customer about you. It just can't do anything about it, and a competitor it can book is one question away.

[Surfing Dog Inbox](/how-it-works/), ours, gives a business the last two doors at an address on its own domain: an MCP server for connectors, and a page where people book, ask for a quote or send a message, answered by your rules. It connects to the [booking and shop systems](/integrations/) many businesses already use. It's open source, and we can host it for free.

## A test you can do today

Open ChatGPT and ask three questions, with your business's name and town in them:

1. "What does [your business] in [your town] charge for [your most common service]?"
2. "Is [your business] open on Sunday?"
3. "Book me [the thing you sell] at [your business] for Saturday."

Compare the answers with the truth. A wrong price or wrong hours usually means ChatGPT couldn't read them, or read an old copy: fix your site. "I couldn't find that business" often means it can't reach you: check your robots.txt and Bing. "I can't book that for you, but here's their number" means you have no door yet.

Then [check your business](/check). We read your site the way a customer's assistant would, and show what ChatGPT and the others can do there today, and what's missing.
