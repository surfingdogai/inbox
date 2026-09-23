# @surfingdog/sdk

Verify [Surfing Dog Inbox](https://surfingdog.ai) webhooks and type the events they carry; and, for
an AI agent booking or ordering for a person, carry that person's pass, sign requests, verify
receipts and counter-sign them.

A Surfing Dog Inbox receives bookings, orders, quote requests and messages from people and from
AI agents, and sends you a signed HTTP request when something happens. This package checks that
signature and hands you a typed event. [For agents](#for-agents) is further down.

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

## For agents

An agent that books or orders for a person can carry that person's standing with it: a **network**
knows the person by a key they hold and knows how reliably they keep their bookings, and a business
recognises them when the agent presents a **pass**. Nobody needs an account. The plain-steps guide
is <https://surfingdog.ai/for-agents.md>; these are the helpers for an agent written in code.

**Hold the person's strings.** A pass (`sdpass1_…`) is what you present; a key (`sdkey1_…`) is the
person's own. Keep one pass per network, present it in the `Sdi-Pass` header or the `pass` field,
and never put either in a URL or a message.

```ts
import { keepPasses, passFromKey, sdiPassHeader } from "@surfingdog/sdk";

let held: string[] = [];                         // stored for the person, one per network
const res = await fetch(`${inbox}/v1/bookings`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(held.length ? { "Sdi-Pass": sdiPassHeader(held) } : {}) },
  body: JSON.stringify({ payload, contact: { name, email } }),   // the person's details, not yours
});
const answer = await res.json();
held = keepPasses(held, answer.identity?.passes);   // a first booking hands back a first pass

// Given the person's key instead: trade it once for a pass, keep the pass, forget the key.
const { pass } = await passFromKey({ key: personsKey, label: "Travel assistant" });
```

When `answer.identity.recognised` is `"weak"`, the person gave the email of a customer the business
knows: call `POST /v1/customers/verify` with the item and its access token, ask the person for the
six digits they were emailed, and call it again with `code`.

**Sign your requests** (`sdi-agent/1`, RFC 9421 with Ed25519, compatible with Web Bot Auth). A signed
request counts as verified evidence and lets you carry a pass *reference* instead of the pass, so
nothing copyable travels. Setup is one emailed code: the person signs in at their network and your
key is delegated to their pass.

```ts
import { delegate, generateAgentKey, requestSignInCode, signIn, signRequest } from "@surfingdog/sdk";

const key = await generateAgentKey();            // keep key.privateJwk as you would a password
await requestSignInCode({ network: "network.surfingdog.ai", email });
const { session } = await signIn({ network: "network.surfingdog.ai", email, code });  // the six digits
const { pass_ref } = await delegate({ session, pass, key });                         // the pass stops working alone

const body = JSON.stringify({ payload, contact });
const signed = await signRequest({ method: "POST", url: `${inbox}/v1/bookings`, body, key, passes: [pass_ref] });
await fetch(`${inbox}/v1/bookings`, { method: "POST", body, headers: { "content-type": "application/json", ...signed.headers } });
```

Send the body byte for byte as signed. `signRequest` refuses a URL carrying an access token or a
credential (send the token in `X-Access-Token`) and a secret in the signed `Sdi-Pass`: an inbox
forwards a signed request's base to the person's network, so anything in it travels too. The
inbox answers every request, signed or not, and says in `Sdi-Signature` when a signature did not
verify.

**Receipts.** An inbox signs a receipt for each promise — a booking confirmed, an order accepted or
paid — and another for how it ended. Check it against the keys the inbox publishes, and
counter-sign it so the person's side of the record counts:

```ts
import { signAck, verifyReceipt } from "@surfingdog/sdk";

const manifest = await (await fetch(`${inbox}/.well-known/agent-inbox.json`)).json();
const { claims } = await verifyReceipt(receipt.jws, manifest, { issuer: inbox });
const counter_signature = await signAck({ receipt: receipt.jws, receiptId: receipt.id, key, passRef: pass_ref });
// POST it to the item's acknowledge door (REST, or MCP acknowledge_receipt).
```

`verifyReceipt` throws `ReceiptVerificationError` with the code a network would give:
`malformed`, `bad_alg`, `bad_typ`, `unknown_key`, `bad_signature`, `bad_payload`, `wrong_issuer`,
`not_yet`. Every helper here is checked against the protocol's published vectors
(`packages/spec/vectors`), the same ones the inbox and the network are held to.

## Documentation

- Webhooks: <https://surfingdog.ai/docs/webhooks/>
- The API: <https://surfingdog.ai/docs/api/>
- For agents: <https://surfingdog.ai/for-agents.md>
- Receipts: <https://surfingdog.ai/docs/receipts/>
- Source: <https://github.com/surfingdogai/inbox>

MIT © Surfing Dog Lda
