# @surfingdog/sdk

Verify [Surfing Dog Inbox](https://surfingdog.ai) webhooks, and type the events they carry.

A Surfing Dog Inbox receives bookings, orders, quote requests and messages from people and from
AI agents, and sends you a signed HTTP request when something happens. This package checks that
signature and hands you a typed event.

- **No dependencies.** WebCrypto and nothing else.
- **Runs everywhere unchanged** — Node 20+, Cloudflare Workers, Deno, Bun, and the browser.
- **MIT**, on purpose: the Inbox itself is AGPL, and verifying its events should never cost you
  a copyleft dependency.
- **[Standard Webhooks](https://www.standardwebhooks.com) v1.0.0**, so if you would rather use
  another library that reads the same three headers, it will work. Nothing here is branded.

```bash
npm install @surfingdog/sdk
```

## Verify a delivery

```ts
import { verifyWebhook, WebhookVerificationError } from "@surfingdog/sdk";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const event = await verifyWebhook({
        payload: await request.text(),   // the RAW body, before any JSON.parse
        headers: request.headers,
        secret: env.INBOX_WEBHOOK_SECRET, // whsec_… , shown once when you added the endpoint
      });

      if (event.type === "booking.confirm") {
        // event.data is { id, type, state, version, url }
      }
      return new Response("ok");         // 2xx means delivered; anything else is retried
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        console.warn("rejected a delivery:", error.code);
        return new Response("bad signature", { status: 400 });
      }
      throw error;
    }
  },
};
```

Node, with the body as it arrived:

```ts
import express from "express";
import { verifyWebhook } from "@surfingdog/sdk";

const app = express();
app.post("/inbox", express.raw({ type: "application/json" }), async (req, res) => {
  const event = await verifyWebhook({
    payload: req.body,          // a Buffer — not a parsed object
    headers: req.headers,
    secret: process.env.INBOX_WEBHOOK_SECRET!,
  });
  res.sendStatus(200);
});
```

**The raw body matters.** The signature covers the bytes that were sent. `JSON.parse` then
`JSON.stringify` will not reproduce them: key order and spacing change, and the check fails. Read
the body as text or bytes first, verify, and parse afterwards — `verifyWebhook` returns the parsed
event for you.

## What it checks

| | |
|---|---|
| Signature | HMAC-SHA-256 over `{webhook-id}.{webhook-timestamp}.{body}`, compared in constant time |
| Rotation | `webhook-signature` may carry several `v1,…` values; any one matching passes, so a secret rotates without dropping a delivery |
| Replay | `webhook-timestamp` must be within 5 minutes, in both directions. Override with `toleranceSeconds` |
| Result | the parsed event, or a `WebhookVerificationError` whose `code` says which check failed |

`code` is one of `missing_header`, `bad_timestamp`, `timestamp_too_old`, `timestamp_too_new`,
`bad_signature_header`, `no_matching_signature`, `bad_secret`, `bad_payload`. Log it: it is the
difference between a clock that has drifted and a secret that is wrong.

## Events

Every event has `id`, `type`, `timestamp` and `data`. By default `data` is thin — the item's id,
type, state, version and a URL to fetch the rest — so a retry is never stale and no customer detail
is copied to a URL you pasted once. An endpoint can be switched to full payloads if you would
rather have everything inline.

```ts
import { isFullEvent, isTestEvent, RETRY_SCHEDULE_SECONDS } from "@surfingdog/sdk";
```

- `isTestEvent(event)` — the delivery sent by the **Send test** button.
- `isFullEvent(event)` — narrows to the full payload shape.
- `RETRY_SCHEDULE_SECONDS` — when a failed delivery will be retried.

## Retries

A delivery that does not answer `2xx` is retried eight times on a widening schedule, each delay
carrying a tenth of jitter, with the last attempt landing a little over a day after the event. A `3xx` counts as a failure: a redirect from a webhook endpoint is nearly always a
misconfiguration, and following it would post your events somewhere you did not name. An endpoint
that keeps failing is put to sleep, never deleted, and every delivery stays replayable from
Settings.

Deliveries carry `webhook-id`. It is stable across retries of the same event, so use it to
deduplicate.

## Documentation

- Webhooks: <https://surfingdog.ai/docs/webhooks/>
- The API: <https://surfingdog.ai/docs/api/>
- Source: <https://github.com/surfingdogai/inbox>

MIT © Surfing Dog Lda
