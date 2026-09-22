---
title: Webhooks
description: Signed, retried, replayable events for every booking, order, quote and message — and a polling cursor for anyone who cannot receive them.
---

Your Inbox tells your systems what happened, the moment it happens. A new booking, an order that was paid, a customer's reply: each one is an **event**, and an event is an HTTP `POST` to a URL you own, signed so you can prove it came from your Inbox and retried for a day if your server is down.

There is no platform to join, no OAuth dance and no app to register. You register a URL with one `POST` — or ask your AI to — keep the secret you are shown once, and answer `2xx`.

## What an event is, and when one is sent

An event is one thing that happened to one item. Items are the five kinds of thing an Inbox holds — `message`, `quote_request`, `booking`, `order` and `refund` ([Concepts](/docs/concepts/)) — and every move an item makes is an event: the moment it is created, every transition of its state machine, a flag being changed, and every message a customer sends on it.

Events are emitted for what the Inbox itself records, whoever caused it: a customer's agent calling `create_booking`, you pressing **Confirm** in the app, your AI firing a transition through the owner MCP, a rule expiring a quote at midnight. An event is sent after the write has committed, so by the time you receive one, `GET /v1/owner/items/{id}` already answers with the new state.

Sandbox items ([Concepts](/docs/concepts/)) produce events too — in the full style you can tell them by `data.item.flags.sandbox` — so you can build against a test item without touching anything real.

## The event types

The type is `<item type>.<event>`. Subscribe to the exact types you want, to a whole item type with `booking.*`, or to everything with `*`, which is the default. An endpoint that subscribes to nothing receives nothing: there is no implicit "all".

| Type | Sent when |
| --- | --- |
| `booking.create` | Someone requested a booking. |
| `booking.request_info` | You asked the customer for more details. |
| `booking.provide_info` | The customer answered with the details. |
| `booking.propose` | You proposed another time. |
| `booking.accept` | The customer accepted the time you proposed. |
| `booking.confirm` | You confirmed the booking; the slot is claimed. |
| `booking.decline` | You declined the request. |
| `booking.cancel` | The customer cancelled, within your cancellation window. |
| `booking.cancel_by_business` | You cancelled the booking. |
| `booking.expire` | A rule expired a booking nobody answered. |
| `booking.complete` | The booking happened. |
| `booking.no_show` | The customer did not turn up. |
| `booking.receipt_issued` | The instance signed a receipt for the confirmed booking ([Receipts](/docs/receipts/)). In the full style, `data.receipt` carries it. |
| `booking.receipt_acknowledged` | The customer's agent counter-signed that receipt. |
| `order.create` | An order arrived. |
| `order.request_info` | You asked the customer for more details. |
| `order.provide_info` | The customer answered. |
| `order.accept` | You accepted the order. |
| `order.request_payment` | You asked for payment, optionally with a payment URL. |
| `order.record_payment` | A payment was recorded against the order. |
| `order.start_fulfilment` | You started putting the order together. |
| `order.fulfil` | The order went out. |
| `order.complete` | The order is closed and done. |
| `order.decline` | You declined the order. |
| `order.cancel` | The order was cancelled. |
| `order.receipt_issued` | The instance signed a receipt for the paid order. In the full style, `data.receipt` carries it. |
| `order.receipt_acknowledged` | The customer's agent counter-signed that receipt. |
| `quote_request.create` | Someone asked for a price. |
| `quote_request.request_info` | You asked what exactly they need. |
| `quote_request.provide_info` | They told you. |
| `quote_request.quote` | You sent a quote, with a total and a validity date. |
| `quote_request.accept` | The customer accepted the quote; a booking or an order follows. |
| `quote_request.decline` | The quote was declined. |
| `quote_request.expire` | The quote passed its validity date. |
| `message.create` | A new conversation started. |
| `message.answer` | You replied. |
| `message.close` | The conversation was closed. |
| `message.reopen` | It was reopened. |
| `message.mark_spam` | It was marked as spam. |
| `message.unspam` | It was not spam after all. |
| `refund.create` | A refund was requested. |
| `refund.approve` | You approved it. |
| `refund.reject` | You rejected it. |
| `refund.refund` | The money went back. |
| `<type>.message` | An inbound message arrived on an item of that type — `booking.message`, `order.message`, and so on. |
| `<type>.flags` | A flag changed on an item: `needsHuman` was raised or cleared, or its priority moved. |

One event is not about an item at all: **`inbox.test`**, what `POST /v1/owner/webhooks/{id}/test` sends. It carries `"test": true`, a sentence saying that nothing was created, and a `data.id` with no item behind it. A receiver that matches on the item type ignores it, which is the right behaviour — it is for whoever is checking the endpoint works, not for your integration.

Treat the list as open. New events appear as the state machines grow, so match the types you handle and ignore the rest rather than refusing what you do not recognise.

## Add an endpoint

One `POST` to the owner API:

```bash
curl -s -X POST https://your-inbox.example.com/v1/owner/webhooks \
  -H "Authorization: Bearer sdi_own_…" -H "content-type: application/json" \
  -d '{"url":"https://shop.example.com/hooks/inbox","events":["booking.*","order.*"],"payload_style":"thin"}'
```

Three fields, and only the first is required:

- **`url`** — `https` only, and a public host. An IP address, `localhost` or an internal name is refused, which is also why a tunnel (`ngrok`, `cloudflared`) is the way to develop against a machine under your desk;
- **`events`** — the patterns you want; `["*"]`, everything, is the default;
- **`payload_style`** — thin or full, see [thin and full](#thin-and-full) at the bottom of this page. Thin is the default and the right answer for almost everyone; full sends the customer's data to that address.

The **signing secret is in that response and in no other**: `whsec_` and then base64, 32 random bytes. Copy it into your own configuration there and then. It is sealed in the database with your instance key, no endpoint and no tool will ever read it back, and if you lose it you rotate it, which shows you a new one. During a rotation both signatures travel on every delivery for 24 hours, so nothing is dropped while you deploy the new secret.

`POST /v1/owner/webhooks/{id}/test` then sends a real, signed, clearly marked test event — its type is `inbox.test`, it carries `"test": true`, and no item exists behind it — and tells you the status your server answered. It is the fastest way to find out that a framework is redirecting you.

Your AI can do all of it without you writing any of that: on the owner MCP server the same operations are `create_webhook`, `update_webhook`, `rotate_webhook_secret`, `delete_webhook`, `send_test_event`, `list_webhook_deliveries`, `replay_webhook_delivery`, `replay_missing_webhook_deliveries` and `list_events` ([Connect your AI](/docs/connect-your-ai/)). Ask it to connect your shop to your Inbox and it will.

The **Integrations** tab in the owner app, under Settings, does the same from a screen: add an endpoint, read the secret once, send a test and see the status it answered, pause, rotate, remove. It uses the same API above, so nothing is possible from the screen that is not possible from the API.

## The request we send

A `POST`, `content-type: application/json`, three signature headers, and nothing else you need to care about:

```http
POST /hooks/inbox HTTP/1.1
host: shop.example.com
content-type: application/json
accept: application/json
user-agent: surfingdog-inbox/0.0.0
webhook-id: 01K5RJ3B4C5D6E7F8G9H0JKMNP
webhook-timestamp: 1789992000
webhook-signature: v1,ceSnlptw5xQUh4NhglImizWi+wQ7rjsL2Dyjl4kXX9U=
sdi-event-type: booking.create
sdi-delivery-attempt: 1

{"id":"01K5RJ3B4C5D6E7F8G9H0JKMNP","type":"booking.create","timestamp":"2026-09-21T12:00:00.000Z","data":{"id":"01K5RJ2X9Y8Z7W6V5U4T3S2R1Q","type":"booking","state":"requested","version":1,"url":"https://inbox.example.com/v1/owner/items/01K5RJ2X9Y8Z7W6V5U4T3S2R1Q"}}
```

The three `webhook-*` headers are the signature and are all you need. `sdi-event-type` and `sdi-delivery-attempt` are conveniences: route on the first without parsing the body, and log the second, which counts from 1, so a `3` in your logs tells you the first two attempts never landed.

That body, spaced out so you can read it, is a thin event:

```json
{
  "id": "01K5RJ3B4C5D6E7F8G9H0JKMNP",
  "type": "booking.create",
  "timestamp": "2026-09-21T12:00:00.000Z",
  "data": {
    "id": "01K5RJ2X9Y8Z7W6V5U4T3S2R1Q",
    "type": "booking",
    "state": "requested",
    "version": 1,
    "url": "https://inbox.example.com/v1/owner/items/01K5RJ2X9Y8Z7W6V5U4T3S2R1Q"
  }
}
```

`webhook-id` is the event's id and it is stable across retries: **deduplicate on it**. On a transition event `data.version` is the item's version after the event, so one that arrives out of order is one you can drop by comparing it with the version you hold. A `<type>.message` event does not bump the version — it reports the item's version as it stands when we send — so order messages by `webhook-id`, which is a ULID, and never drop one on version.

## Verify it

The signature is [Standard Webhooks](https://www.standardwebhooks.com/) v1.0.0, which is what OpenAI, Anthropic, Twilio, Resend and Clerk already send, so an off-the-shelf library in any language verifies us. The rules, if you would rather write it yourself:

1. the signed content is `{webhook-id}.{webhook-timestamp}.{body}`, over the **raw body bytes exactly as they arrived** — re-serialising a parsed object changes the spacing and the key order, and the signature will not match;
2. `webhook-signature` carries one or more space-separated `v1,<base64>` values; **any one matching is a pass**, which is what lets a secret be rolled without dropping a delivery;
3. `webhook-timestamp` is Unix seconds and must be within five minutes of now, in both directions. Without that check, anyone who captures one request can replay it at you forever;
4. compare in constant time.

With our helper, which is MIT so it costs you no licence, and WebCrypto so it runs in Node, in a Worker, in Deno, in Bun and in a browser. No dependencies, 15 kB:

```bash
npm install @surfingdog/sdk
```

Then:

```ts
import { verifyWebhook, WebhookVerificationError } from "@surfingdog/sdk";

export async function POST(request: Request) {
  const body = await request.text(); // the raw body — never request.json()
  try {
    const event = await verifyWebhook({
      payload: body,
      headers: request.headers,
      secret: process.env.INBOX_WEBHOOK_SECRET!,
    });
    await queue.push(event); // do the slow part after you have answered
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return new Response(error.code, { status: 400 });
    }
    throw error;
  }
}
```

`verifyWebhook` takes the headers as a `Headers`, a plain object, a `Map` or a list of pairs, because your framework will hand you whichever it likes. It returns the parsed event, or throws a `WebhookVerificationError` whose `code` says what was wrong: `missing_header`, `bad_timestamp`, `timestamp_too_old`, `timestamp_too_new`, `bad_signature_header`, `no_matching_signature`, `bad_secret`, `bad_payload`.

With the `standardwebhooks` library, which you may already have, on Express:

```js
const express = require("express");
const { Webhook } = require("standardwebhooks");

const wh = new Webhook(process.env.INBOX_WEBHOOK_SECRET.replace(/^whsec_/, ""));

app.post("/hooks/inbox", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = wh.verify(req.body, req.headers); // req.body is a Buffer: the raw bytes
  } catch {
    return res.sendStatus(400);
  }
  res.sendStatus(204);
  queue.push(event);
});
```

`express.raw` matters: `express.json` hands you an object, and an object cannot be verified.

In another language, any Standard Webhooks library works — Python, Go, Rust, PHP, Ruby, Java, C#, Elixir. Nothing about our deliveries is bespoke.

## What to answer

**Any `2xx`, and answer it quickly.** `204 No Content` is the tidiest. Verify the signature, put the event on a queue or in a table, answer, and do the work afterwards; if you do the work first, a slow third-party API of your own turns into a failed delivery and a retry you did not need. A delivery times out after ten seconds.

**Everything that is not `2xx` is a failure — including a redirect.** This is the commonest integration bug there is: a framework that quietly answers `301` from `/hooks/inbox` to `/hooks/inbox/`, or a proxy bouncing http to https, and the endpoint that "works in the browser" fails every delivery. We do not follow redirects, deliberately: a webhook URL that can be pointed somewhere else by its own answer is a server-side request forgery waiting to happen. Point us at the final URL.

A failed signature check is worth a `400`. It will be retried and will fail again, which is exactly what you want in the log if someone really is posting forgeries at your endpoint.

## Retries, and what happens at the end

Eight attempts over about a day, each with a tenth of jitter so a fleet of endpoints coming back at once does not arrive in lockstep:

| Attempt | Sent |
| --- | --- |
| 1 | immediately |
| 2 | 5 seconds later |
| 3 | 5 minutes later |
| 4 | 30 minutes later |
| 5 | 2 hours later |
| 6 | 5 hours later |
| 7 | 10 hours later |
| 8 | 10 hours later |

The last attempt lands a little over a day after the event, which is long enough to cover a night of downtime nobody noticed. After it, the delivery is marked failed — and kept. An endpoint that has done nothing but fail for five days is deactivated, and it is kept too: never silently deleted, never quietly forgotten. `GET /v1/owner/webhooks` shows it, inactive, with `disabled_at` and the last error that did it, and your failed deliveries are still sitting there waiting to be sent once the address is fixed. (Some platforms drop a subscription after a handful of failures and tell nobody. That is the behaviour this is avoiding.)

## Replay

`GET /v1/owner/webhooks/{id}/deliveries` lists one endpoint's recent deliveries with their status, response code, duration and last error; `GET /v1/owner/deliveries` does the same across every endpoint. Both are keyset paginated, newest first, and both are `list_webhook_deliveries` on the owner MCP.

Two ways to send something again:

- **one delivery**, `POST /v1/owner/deliveries/{id}/replay`, on the row it already has;
- **everything the endpoint missed**, `POST /v1/owner/webhooks/{id}/replay` with `{"since":"2026-09-20T00:00:00Z"}`, which queues every matching event from that instant that this endpoint never received. Turning a deactivated endpoint back on (`PATCH /v1/owner/webhooks/{id}` with `{"active":true}`) clears its failure run first, so run that, then this.

  One call scans at most 500 events. When the answer comes back `"truncated": true` it also carries a `next_after`: call it again with the same `since` and `{"after":"<that value>"}` to take the next window, and keep going until `truncated` is false. Re-sending the same request without `after` reads the same 500 events again and queues nothing new.

A replay is the same event, under the same `webhook-id`, with a fresh timestamp and signature. A thin transition event replays byte for byte. A full event — and a thin `<type>.message` event, because a message does not change the item — is rebuilt from the item as it stands now, so it may show a state later than the one the event announced. If you deduplicate on `webhook-id`, as you should, a replay of something you already handled costs you nothing.

Deliveries are pruned after thirty days. For anything older, use the cursor below — the events themselves are kept as long as their items are.

## Thin and full

A **thin** event carries a pointer: the ids, the type, the new state, the version and a URL. A **full** event is the same envelope with more inside `data`: `item`, the whole item with its typed payload and its flags; `transitions`, the events it accepts right now, each with a label; `human`, a sentence describing it; `party`, the customer, with the name, email address and phone number you hold for them; and, on a `<type>.message` event, `message`, the message itself.

Thin is the default, for two reasons. A thin transition event never goes stale: if a delivery succeeds ten hours late, it still says "booking `01K5…` changed, go and look", whereas a full event would be telling you about a state that has moved on twice since. (A `<type>.message` event is the exception in both styles: a message does not change the item, so its `state` and `version` are the item's as they stand when we send.) And a thin event does not copy a customer's name, email address and phone number to a URL that somebody pasted into a form once, possibly into a no-code tool logging every request body.

Choose full when the receiver genuinely cannot call back — a Zapier or Make step that can only read what it is handed, or a Slack message that needs the customer's name in it. Choose it knowing what it means: `payload_style: "full"` sends your customers' names, email addresses and phone numbers to that address, on every event, for as long as the endpoint exists. To fetch an item from a thin event, `GET` the `data.url` with an owner API key ([API](/docs/api/)); you get the same item, as it stands now.

## If you cannot receive a webhook

Poll instead. `GET /v1/owner/events` is the same stream, read forward from wherever you left off:

```bash
curl -s "https://your-inbox.example.com/v1/owner/events?cursor=01K5RJ3B4C5D6E7F8G9H0JKMNP&limit=100&types=booking.*,order.*" \
  -H "Authorization: Bearer sdi_own_…"
```

```json
{
  "events": [
    {
      "id": "01K5RJ3B4C5D6E7F8G9H0JKMNQ",
      "type": "order.record_payment",
      "timestamp": "2026-09-21T12:04:11.318Z",
      "data": {
        "id": "01K5RJ2X9Y8Z7W6V5U4T3S2R1R",
        "type": "order",
        "state": "paid",
        "version": 4,
        "url": "https://your-inbox.example.com/v1/owner/items/01K5RJ2X9Y8Z7W6V5U4T3S2R1R"
      }
    }
  ],
  "next_cursor": "01K5RJ3B4C5D6E7F8G9H0JKMNQ"
}
```

Events come back oldest first, and the ids are ULIDs, so they sort in the order things happened. The stream trails live by a few seconds: an event's id is minted a moment before its write commits, so holding the newest few seconds back is what lets you treat `next_cursor` as a hard watermark and never miss a row that landed out of order. Send the `next_cursor` of your last page as `cursor` on the next call; omit `cursor` to start at the beginning of time, and expect `null` when you have caught up. There is nothing to acknowledge, so re-reading from an older id is free — which is what makes this the way to backfill after an outage, or to build a copy of your data from scratch. `limit` is 1 to 100 and defaults to 50; `types` takes the same patterns a subscription does, comma-separated or repeated; `since` takes an ISO instant when you would rather start from a time than from an id.

Every event you would have received as a webhook appears here, as the same thin event, whether or not an endpoint exists. The owner MCP exposes it as `list_events`, so the AI you already connected can read the stream too.
