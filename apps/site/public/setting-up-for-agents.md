# Setting a business up for agents: guidance

The same page for people: https://surfingdog.ai/docs/setting-up-for-agents/

This page is advice for the AI, or the person, installing Surfing Dog Inbox for a business. It comes from a week of work alongside a UK online grocery shop, including the things we got wrong.

**It is guidance, not a set of rules.** Every recommendation here has alternatives, and a business may use other tools and other ways of doing things. The inbox is built to sit beside them. Where this page and the business's own judgement differ, the business decides.

Written on 9 October 2026. Each section keeps three things apart:

- **Today**: what the inbox does now, in the code you install.
- **Pattern**: something a business builds itself from today's pieces: a webhook, a key, a small script.
- **Coming**: planned, and not built yet.

The step-by-step install is [install.md](https://surfingdog.ai/install.md). The exact calls for connecting software the business already uses are in [connect.md](https://surfingdog.ai/connect.md).

## Two ways to use the inbox

### A business with nothing for agents yet

A plumber, a salon, a small shop with a contact form. Here the inbox is the front door for agents: they send messages, ask for quotes, book and order there, and the business answers from the owner app, with rules, or with its own AI.

**Today** the inbox handles all five kinds of item (message, quote request, booking, order, refund). It answers availability from the business's services and opening hours, prices from its catalogue, and keeps every item's history. Rules, with presets for appointments, trades and shops, can confirm, reply and flag on their own. The owner's AI works inside limits the owner sets in code, not in a prompt ([Your limits](https://surfingdog.ai/docs/api/#your-limits)).

### A business that already has its tools

A shop with its own checkout, a clinic on a booking system, a team on Intercom, Zendesk, Salesforce, HubSpot or Freshdesk, staff who answer on Telegram or WhatsApp, a business with its own AI agent. Here the inbox is a thin, standard door in front of all that:

- it receives what agents send, in one typed shape, over REST, MCP and email;
- it keeps a log: every item, every event, who caused it and through which door, and, when something becomes a promise (a booking confirmed, an order accepted or paid), a signed [receipt](https://surfingdog.ai/docs/receipts/);
- it hands each item to where the business already works, and the business's own systems, people or AI answer.

How it hands things over **today**: signed [webhooks](https://surfingdog.ai/docs/webhooks/), the [owner API](https://surfingdog.ai/docs/api/) and its event stream, and email alerts to the owner. Native connectors for other platforms are **coming**; the connector-style piece that exists now is the [product feed](https://surfingdog.ai/docs/feeds/) import. So handing items to a helpdesk is a **pattern** today: a webhook and a small bridge, described in [Messages with the tools you already have](#messages-with-the-tools-you-already-have).

### Either way

The inbox is the business's own software: open source (MIT), at its own subdomain, on its own Cloudflare account or its own server. Customers and their agents write to the business there. Surfing Dog is not in the middle of a message, a booking, an order or a payment. Joining a network is optional and separate: a network lists the business and records the receipts its inbox signs, and [install.md, Step 5](https://surfingdog.ai/install.md) lists everything a network receives.

## Decide what handles each door

A **door** is something an agent can do: send a message, ask for a quote, book, order, pay, and the steps after (change, cancel, track, return). For each one, decide with the owner what handles it:

1. **The inbox.**
2. **The business's own system**: its own MCP server, API, booking system or checkout, at an address the business controls.
3. **Nobody**: the business does not do this through an agent. Say so plainly, so agents do not try.

What we learned:

- **Do not advertise a door that cannot be fulfilled.** An agent that books a slot nobody honours, or orders from a catalogue nobody ships, costs the business more than an agent that was told "not here".
- **One door per action.** If orders go to the shop's own checkout, the inbox should not offer orders as well. Two order doors with different stock and prices confuse agents and people alike.
- **Pick defaults for the kind of business**, neither everything on nor everything off.

Some starting points, to adjust with the owner:

| Kind of business | Message | Quote | Book | Order | Pay |
| --- | --- | --- | --- | --- | --- |
| Services, nothing yet | inbox | inbox | inbox | nobody | a payment link |
| Small shop, nothing yet | inbox | inbox | nobody | inbox | a payment link |
| Shop with its own checkout | inbox | inbox, for bulk or trade | nobody | its own checkout or agent door | its own checkout |
| Already on a booking system | inbox | inbox, if it quotes | the booking system's door, or the inbox with a person confirming | nobody | at the booking, or a link |
| Trades | inbox | inbox | inbox, after a quote | nobody | a link with the invoice |

**Today** the inbox advertises what it has the means to do: `message` always, `booking` once a service has opening hours, `order` once a product is active, `quote_request` with either ([Manifest](https://surfingdog.ai/docs/manifest/)). So a shop whose orders go to its own checkout leaves products out of the inbox, and the inbox's manifest does not offer orders. If an agent sends an order anyway, the public API still takes it as a request that waits for a person: nothing is promised until someone accepts it.

**Coming**: a setting per door in the inbox: handled by the inbox, handled elsewhere at an address the business owns, or off and declared as unavailable, with sensible defaults for each kind of business. The manifest will then list the doors handled elsewhere too.

## Make every door findable

Agents and crawlers find doors by reading files at known places. Make the list easy to find and hard to misread.

**Keep one list of doors, and repeat it where readers look:**

- **The inbox manifest**, at `/.well-known/agent-inbox.json` on the inbox's subdomain. Today it lists the inbox's own doors (REST, OpenAPI, MCP); doors handled elsewhere join it with the per-door setting that is coming.
- **An MCP server card** for each MCP server the business runs. `/.well-known/mcp/server-card.json` is a proposed convention; a site with several servers can also list them at `/.well-known/mcp.json` as `{"servers": [{"url": "…"}]}`. Readers differ, so publishing a card as well as a list is cheap insurance.
- **`llms.txt`** on the main domain, with a line per door that says what the URL is (example below).
- **schema.org markup** on the pages: the business (`Organization` or `LocalBusiness`), products with an `Offer` (price, currency, availability), opening hours, and policies (see the next section).
- **A product feed** (CSV or Google Merchant XML), which agents can read, and so can the inbox's own [feed import](https://surfingdog.ai/docs/feeds/).
- Optionally, **a DNS record** on the main domain that points at the inbox: `_agent-inbox.example.com. TXT "v=sdi1; manifest=https://inbox.example.com/.well-known/agent-inbox.json"`.

An `llms.txt` section a reader can act on, one door per line, each saying what it is:

```markdown
## For AI agents

- MCP server (streamable HTTP): https://agent.example.com/mcp
- Inbox for messages, quotes and returns: https://inbox.example.com/.well-known/agent-inbox.json
- Product feed (Google Merchant XML): https://example.com/feed.xml
- Basket hand-off (an agent fills the basket, a person pays): https://example.com/basket?add=<sku>:<qty>
- Order lookup API: POST https://example.com/api/orders/lookup
- Returns policy: https://example.com/returns
```

**Keep every door on the business's own domain or a subdomain**, such as `inbox.example.com` or `agent.example.com`. A door on an unrelated host is easy to fake, so careful readers set it aside unless the business's own site leads to it; a network that follows [the network protocol](https://github.com/surfingdogai/inbox/blob/main/docs/protocol/network.md) (§4.8) also wants the door's own document to name the business's domain. A booking platform's page for the business counts once the business's site links to it and the platform's document names the business.

**What we saw with the shop:**

- **A discovery file we could not read.** Its `/.well-known/mcp.json` listed its servers as a list, and our crawler expected a single server card. Ours reads lists now; other readers may not, so publish a card as well.
- **Doors listed in `llms.txt` alone.** Its `llms.txt` named an MCP server on a subdomain, a product feed, a stock API, a basket hand-off link and an order lookup. Our crawler saw that the file was there and read none of the doors in it. It reads such lines now, but a door that also sits in a machine-readable file (a server card, the manifest, an OpenAPI document) is found by more readers.
- **Images on another platform's CDN.** The shop served product images from a large commerce platform's file CDN. A crawler, ours, took that as a sign the shop ran on that platform and went looking for that platform's agent checkout, which was not there. We fixed the crawler; the lesson for a business is to declare its doors outright, so nobody has to guess them from side signals.

Then look from outside: [surfingdog.ai/check](https://surfingdog.ai/check) reads a site the way our crawler does and shows, for each thing an agent can do there, the door it found and when. Any checker will do; the point is to see what a stranger's agent sees.

## Let agents finish the job

A booking or an order is the start of the job, not the end of it.

- If agents can **order**, let them also change the order, cancel it, track it, get a receipt and start a return.
- If they can **book**, let them see availability before they book, change the time and cancel.
- If they can **sign up** for an account, a membership or a class, let them change it or end it.

**Today**, for the items it holds, the inbox's public API covers most of this: `check_availability`; changes to a confirmed booking or an accepted order (`make_offer`, `suggest_time`); `cancel_item`; the status and the conversation (`get_item_status`); signed receipts the agent can counter-sign; and `withdraw_from_contract` and `request_return` for orders and paid bookings ([API](https://surfingdog.ai/docs/api/)). Sign-ups are not an item type in the inbox.

**Pattern**, when the order lives in the business's own system: offer an order lookup there (by order number and email address) and a way to start a return, and list both with the other doors. The inbox cannot yet record an order that happened in another system, so its receipts cover the bookings and orders it holds itself.

**Publish policies in words and in markup**, because agents read both: returns as schema.org `MerchantReturnPolicy` (how many days, who pays postage, how the refund is made), delivery as `OfferShippingDetails`, and the cancellation terms in plain words next to the booking. **Today** the inbox publishes its own return policy at `GET /v1/business` as a `MerchantReturnPolicy`, from the owner's Returns settings.

The Surfing Dog agentic score rewards the full journey: an order counts for more when changing, cancelling, tracking and a receipt follow it ([the published rules](https://surfingdog.ai/v1/score-rules)). The score is a reading, not the aim. The aim is that an agent can finish what its person asked for.

## Payments in the UK and the EU, as of October 2026

This changes month by month. Check the sources at the end of this section before choosing.

**Why an agent should not type a card number.** In the EU (under PSD2) and in the UK, a card payment the customer starts needs Strong Customer Authentication: two of something they know, something they have and something they are. An agent filling in a card number at a checkout stalls at that step, or needs the person there anyway, and it holds a card number it should never see. What works is a credential made for agents: a token or a mandate the person approves once, usually with a passkey or their banking app, limited to a merchant, an amount or a period, which the agent presents and the payment provider checks.

Options, a line each:

- **Stripe Agentic Commerce Suite, with Shared Payment Tokens**: a scoped token an agent hands to the merchant without seeing the card. It implements the Agentic Commerce Protocol's (ACP) delegated payment and carries Mastercard Agent Pay and Visa Intelligent Commerce tokens. The short path for a business already on Stripe.
- **Mollie**: supports ACP's delegated payment API, for European merchants.
- **Adyen Agentic**: catalogue, basket and payment APIs for agent commerce, suited to larger merchants already on Adyen.
- **Mastercard Agent Pay and Visa Intelligent Commerce**: the card networks' own agent tokens, reached through the business's payment provider rather than directly. Mastercard says every issuer in Europe is enabled for Agent Pay at network level; Visa's Agentic Ready programme began in Europe, the UK included, in March 2026, starting with banks.
- **UK pay by bank**: a mandate the payer can limit or revoke at any time, as Direct Debit and, as they open up, Variable Recurring Payments. GoCardless has completed an agent-led pay-by-bank donation inside the FCA's AI Live Testing programme.
- **x402 and stablecoins**: payments over HTTP 402, mostly in stablecoins. Niche for a consumer business today.

**A hand-off link is a fine start.** The agent fills the basket or the order, and a person pays on the business's own checkout; no card details go near the agent. **Today** the inbox supports this: the business's own system asks for payment with a link (`request_payment` with a `paymentUrl`) and records it back with `record_payment`, both with an integration key the owner gave `money:write`. Readers such as our score count a hand-off as "partly": a person still pays, and the agent did the rest.

**Elsewhere.** The same provider products and card-network programmes are offered in other regions, and the rules on authentication differ by country. Wherever the business is, a scoped token or a mandate is safer than an agent holding a card number.

Sources: [Stripe's agentic commerce updates](https://paymentexpert.com/2026/05/01/stripes-agentic-commerce-updates/) (Payment Expert) · [Mollie on agentic commerce in Europe](https://www.mollie.com/news/agentic-commerce-mollie-europe) · [Mastercard: Europe is building the foundations for trusted agentic commerce](https://newsroom.mastercard.com/news/europe/en/perspectives/en/2026/europe-is-building-the-foundations-for-trusted-agentic-commerce/) · [Visa Agentic Ready launches in Europe](https://www.fintechfutures.com/ai-in-fintech/visa-agentic-ready-launches-in-europe) (FinTech Futures) · [GoCardless and Trussell: an agentic payment by bank](https://gocardless.com/blog/uk-first-agentic-payment-trussell) · [Adyen's agentic commerce documentation](https://docs.adyen.com/online-payments/agentic-commerce).

## Messages with the tools you already have

Many businesses already answer customers in a helpdesk, a CRM or a chat app, and some have their own AI that answers. The inbox does not replace any of that. The shape is the same whatever the tool:

1. A customer's agent sends a message, a quote request, a booking or an order to the inbox, over REST, MCP or email.
2. The inbox keeps it as an item with its history, and gives the agent a way to read its status. Promises (a booking confirmed, an order accepted or paid) get signed receipts.
3. A webhook tells the business's bridge (`message.create`, `order.create`, and so on). The bridge reads the item with its own integration key (`GET /v1/owner/items/{id}`) and opens a ticket or a conversation in the business's tool, keeping the inbox item's id on it; most tools have an external id or a custom field for this.
4. A person, or the business's own AI, answers in that tool.
5. The tool's own webhook or automation calls the bridge, which posts the answer back to the inbox item: `POST /v1/owner/items/{id}/replies`, or a move such as `confirm`, `propose` or `request_payment` with `POST /v1/owner/items/{id}/transitions`.
6. The agent reads the answer in the item's conversation (`GET /v1/items/{id}`), and the customer gets the business's email if they gave an address. When the customer writes again, a `<type>.message` event fires and the bridge adds it to the same ticket.

The bridge is the business's own: a small script on any server, a serverless function, or a Zapier, Make or n8n flow. Native connectors for these tools do not exist today. The notes below are patterns, built on each tool's public API:

- **Intercom**: the bridge opens a conversation for the customer through Intercom's API, with the inbox item's id in a conversation attribute. Intercom's webhook for an admin reply (`conversation.admin.replied`) calls the bridge, which posts the reply to the item.
- **Zendesk**: the bridge creates a ticket with the Tickets API, with the item's id as the ticket's `external_id`. A trigger on a public comment by an agent calls a Zendesk webhook pointed at the bridge, which posts the comment as the reply.
- **Salesforce Service Cloud**: the bridge creates a Case through the REST API, with the item's id in a custom field. A record-triggered Flow on a new public reply calls the bridge, by an HTTP callout or a Platform Event the bridge listens for.
- **HubSpot**: the bridge creates a ticket with the CRM tickets API, or uses a custom channel in HubSpot's conversations inbox. A workflow's webhook action, or the app's webhook subscription, tells the bridge when someone replies.
- **Freshdesk**: the bridge creates a ticket with the Tickets API. An automation rule on ticket updates, with a "Trigger webhook" action, calls the bridge when an agent replies.
- **Telegram**, for staff who answer on their phones: the bridge's bot posts each new item to a staff chat (the Bot API's `sendMessage`), with the item's reference. When someone replies to that message, Telegram sends the update to the bridge's webhook, and the bridge maps the replied-to message back to the item and posts the reply.
- **WhatsApp Business**: the same pattern for staff alerts, through the WhatsApp Business Platform (the Cloud API) or a provider such as Twilio. Messages the business starts outside WhatsApp's 24-hour window need approved templates. WhatsApp is a channel for people, not a door for agents: agents write to the inbox.
- **Email**: **today** the inbox emails the owner about new requests at the address in `notifications.ownerEmail`. Point it at a shared mailbox, or at a helpdesk's address, and each request lands there with no code at all. For an answer to reach the customer's agent, it has to go back through the inbox: the owner app, the owner MCP, or `reply` over the API.
- **The business's own AI**: two ways **today**. Connect it to the owner MCP at `https://inbox.example.com/mcp/owner`, where it signs in with OAuth, lists what needs an answer, replies and moves items, inside the limits the owner set ([Connect your AI](https://surfingdog.ai/docs/connect-your-ai/)). Or let it react to webhooks and call the owner API with its own integration key. Either way its replies reach the customer marked as sent automatically, and anything about money outside the owner's limits waits as a draft for a person.

Get these right, whichever tool it is:

- **One integration key per bridge**, made by the owner in Settings → Keys with the narrowest preset that works (`automation` for most bridges).
- **Skip your own echo.** An event whose `data.actor.id` is the bridge's own key is the bridge's own write coming back; acting on it again is how two systems loop.
- **Use the event's id as the idempotency key** on every write back, so a retry does the work once.
- **Thin events**, the default: the bridge reads the item with its key, and no customer data travels to the webhook address.
- **`written_by: "person"`** on a reply a person typed in the helpdesk, so the customer does not see the line saying it was sent automatically.
- **The helpdesk's own tokens stay in the bridge**, never in the inbox's settings, notes or replies.
- **Test both directions with sandbox items** (the `x-sandbox: 1` header) before any real customer.

## A checklist for the installing AI

**Ask the owner**, and do not guess any of these:

- Which tools do you use today for messages, bookings, orders, payments and support? The product names and the plans.
- Does anything already answer AI agents for you: your own MCP server or API, a platform's agent checkout, a booking platform's agent door?
- For each action (message, quote, book, order, pay, change, cancel, track, return): should the inbox handle it, your own system, or nobody?
- How do you take payment, and does your provider offer agent payments yet? If not, is a payment link to your own checkout fine for now?
- Where are your returns, delivery and cancellation policies written, and may we add markup to those pages?
- Who answers: a person, rules, or your own AI? What may automation agree to on its own, for times and for money?
- Do you want to join a network? It is optional, and separate from the inbox.

**Then:**

- Install with [install.md](https://surfingdog.ai/install.md), and set up the doors the business will fulfil, and no others.
- Connect the tools it already uses, with [connect.md](https://surfingdog.ai/connect.md) or a bridge as above.
- List every door on the business's own domain: the manifest, an MCP server card, `llms.txt` lines, schema.org markup, a product feed.
- Test each door end to end with a sandbox item, in each direction a bridge runs.
- Look from outside with a checker.
- Tell the owner, in a few lines, which doors are live and where, which are handled elsewhere, which are off, and what is not built yet.

None of this is required. If the business has a better way, use it, and tell us what worked on the [requests board](https://surfingdog.ai/requests).
