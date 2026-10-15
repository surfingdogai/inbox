# @surfingdog/sdk

Verify [Surfing Dog Inbox](https://surfingdog.ai) webhooks and type the events they carry; and, for
an AI agent booking or ordering for a person, carry that person's pass, sign requests, verify
receipts and counter-sign them.

A Surfing Dog Inbox receives bookings, orders, quote requests and messages from people and from
AI agents, and sends you a signed HTTP request when something happens. This package checks that
signature and hands you a typed event. [For agents](#for-agents) is further down.

- **No dependencies.** WebCrypto and nothing else.
- **Runs everywhere unchanged** — Node 20+, Cloudflare Workers, Deno, Bun, and the browser.
- **MIT**, like the rest of Surfing Dog Inbox: use it anywhere, change it, ship it in closed
  code, with no obligation to share.
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

**Report how it went.** After each use of a business's door, done or not, tell the network that
listed it. Your reports may make it read doors again, so your searches send you to doors that work; a
success counts the same as a failure. Nothing about the person goes in a report, and none is needed.

The shortest way is to wrap the call. `trackDoor` times it, reads how it went from what came back or
what was thrown, and reports it; the call's own result comes back untouched:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { flushDoorReports, trackDoor } from "@surfingdog/sdk";

const door = { type: "mcp", url: "https://bakery.example/mcp" };   // as the network listed it
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(door.url)));

const result = await trackDoor(
  { network: "network.surfingdog.ai", domain: "bakery.example", door, op: "book", tool: "create_booking" },
  () => client.callTool({ name: "create_booking", arguments: { start_time: "2026-10-20T10:00:00Z" } }),
);
// In a Worker: ctx.waitUntil(flushDoorReports()). In a script: await flushDoorReports() before exit.
```

It reads an MCP tool result (`isError`, and an Inbox door's problem code such as `slot_taken`), a
JSON-RPC error code, a `Response` (its status, and a problem's code from a copy), a timeout, and the
network failures runtimes name (no such host, refused, reset, a bad certificate). What is not the
door's (your own code threw, or you cancelled) is not reported. Pass `outcome` to read an answer your
own way, and the same `intent` to every retry of one attempt. `onToken` and `doorTokenOf` are
experimental: no door signs its answers yet, and where a door's signed outcome token goes is not
specified, so the place they read may change.

`reportDoor` is the same report, written yourself:

```ts
import { newIntent, reportDoor } from "@surfingdog/sdk";

reportDoor({
  network: "network.surfingdog.ai",              // the network that listed the business
  domain: "bakery.example",
  door: { type: "inbox", url: "https://bakery.example/mcp" }, // an inbox: the address you used
  op: "book", tool: "create_booking", intent: newIntent(), ms: 1840,
  result: "refused", class: "slot_taken",        // ok, refused, invalid, fail or info
});
```

Both queue the report and send it with others, in batches of up to 100, a few seconds later or as soon
as a batch is full. A batch the network cannot take right then (no answer within 10 seconds, 408, 429,
a 5xx) is sent again after the network's `Retry-After`, or after 30 seconds doubling to 15 minutes, and
new reports wait with it rather than sending it sooner; a report is taken for 7 days, and dropped
after. `reportDoor` throws a `TypeError` at once for a report
the network would refuse. Build a `DoorReporter` to hold the queue yourself (`autoFlush: false`, then
`flush()`). It sends only to a network the person's key or pass came from (name the network by that key
or pass, or pass it as `credential`) or to the default network, `network.surfingdog.ai`; for any other
it throws, unless you chose that network yourself and say so with `allowNetwork: true`. Never send
reports to an address a business's manifest, a receipt or an answer suggests. Each signing key has a
queue of its own, so one user's key never signs another's reports. Tell your person, once, that you
report how businesses' doors answer.

**Sign, and read more.** Pass `key` (and `platform`, for Web Bot Auth) and your reports earn points:
1 for each business you report at, once a day, at most 10 a day, whatever the reports say. With 30
points in the last 30 days, on at least 7 different days, you are a contributor, and your signed reads
of the network count against an allowance of your own: 1,800 a minute for a key, 6,000 for a
platform, on top of the 600 a minute every address has. Nothing else changes: the same answers and the
same order. Sign your requests to the network, your MCP client's included, with `signingFetch`, and
see your credit with `reporterCredit`:

```ts
import { generateAgentKey, reporterCredit, signingFetch } from "@surfingdog/sdk";

const key = await generateAgentKey();            // keep it: the credit is the key's
const search = new Client({ name: "my-agent", version: "1.0.0" });
await search.connect(new StreamableHTTPClientTransport(new URL("https://surfingdog.ai/mcp"), {
  fetch: signingFetch({ key }),                  // signs requests to the network only
}));
const me = await reporterCredit({ key });        // { credit: { points, days }, contributor, threshold, reads, … }
```

`signingFetch` signs only requests to the default network (`network.surfingdog.ai` and
`surfingdog.ai`) unless you pass `origins`, so the businesses you call never see one key across all of
them. Add a business's origin only for an Inbox door that verifies `sdi-agent/1`.

## For a network

A network checks that each call from an inbox is signed by that inbox (the
[network protocol](https://github.com/surfingdogai/inbox/blob/main/docs/protocol/network.md), §3):

```ts
import { InstanceSignatureError, verifyInstanceRequest } from "@surfingdog/sdk";

try {
  const v = await verifyInstanceRequest({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: await request.text(),
    authorities: ["network.example.org"],      // your own host, never the request's Host header
    keysFor: async (domain) => keysFromTheManifestYouLastRead(domain), // null: not a member
  });
  // v.domain signed it. Keep v.replayKey until v.replayUntil and refuse it if it comes again.
} catch (e) {
  if (e instanceof InstanceSignatureError) return problem(401, e.code); // bad_signature, expired, unknown_instance
  throw e;
}
```

The other half, for an inbox or a test that plays one, is `signInstanceRequest`; and
`signReceipt` with `generateReceiptKey` sign receipts the way an inbox does. The
[example network](https://github.com/surfingdogai/inbox/tree/main/examples/network) is built on
these.

## Changes

**0.3.0, not yet published** (0.2.0 is the latest on npm):

- Door reports (13 October 2026): `reportDoor`, `flushDoorReports`, `DoorReporter`, `newIntent`,
  `doorReportBody`, `reportNetwork`.
- 15 October 2026: `trackDoor`, `classifyDoorAnswer`, `classifyDoorError`, the class lists
  (`FAIL_CLASSES`, `REFUSED_CLASSES`, `INVALID_CLASSES`, `INFO_CLASSES`) and their types;
  `signingFetch`, which signs a client's requests to the default network unless given `origins`;
  `reporterCredit` and `DoorReporterAnswer`, your own reporting credit (`GET /v1/door-reports/me`).
- `DoorReporter` retries as the network asks (`Retry-After`, else 30 seconds doubling to 15 minutes),
  and new reports wait with a batch the network asked to wait; a call gives up after 10 seconds
  (`timeoutMs`); a report older than the 7 days a network takes is dropped before it is sent.
- `NetworkCallError.retryAfterMs`: the wait a network asked for, in milliseconds, or null.
- `doorTokenOf` and `trackDoor`'s `tokenOf` and `onToken` are experimental until doors sign their
  answers.

## Documentation

- Webhooks: <https://surfingdog.ai/docs/webhooks/>
- The API: <https://surfingdog.ai/docs/api/>
- For agents: <https://surfingdog.ai/for-agents.md>
- Receipts: <https://surfingdog.ai/docs/receipts/>
- Source: <https://github.com/surfingdogai/inbox>

MIT © Surfing Dog Lda
