# The push relay: how an inbox reaches its owner's phones

Version 1, 20 October 2026 (ADR-026). The inbox's side is `packages/core/src/phones/relay.ts`; the
phone's side is `apps/mobile/android/.../PushService.java`.

A notification to a phone has to go through the phone maker's push service (Firebase Cloud Messaging
on Android, APNs on iPhone), and only the holder of the app's credentials there can send to it. Those
credentials cannot be given to every inbox, so one relay holds them: Surfing Dog's, at
`https://push.surfingdog.ai`. Every inbox, hosted or on its owner's own server, uses it the same way,
and an operator can point an inbox elsewhere with `INBOX_PUSH_RELAY` (`off` for none).

**The relay can read nothing.** Every message is encrypted on the inbox for one phone, as Web Push
encrypts (RFC 8291, `aes128gcm` of RFC 8188), to an ECDH P-256 key and a 16-byte authentication secret
that the phone made for that inbox and gave only to it. The relay sees which inbox registered a push
token, when it sends, and how many bytes; never who wrote, what about, or to whom. Its collapse keys and
idempotency ids are opaque too (below).

## Who may call

| Call | An inbox on its own server (Node, Workers) | A hosted inbox |
|---|---|---|
| Register a phone, list, forget all | `POST`/`GET`/`DELETE /v1/devices`, signed **sdi-instance/1** | through its host's control plane, which vouches for it |
| Anything about one device (new token, remove, send) | `/v1/devices/{device}…` with `Authorization: Bearer <device secret>` | the same |

**sdi-instance/1** is the signature an inbox already makes when it calls a network (RFC 9421 HTTP
Message Signatures, Ed25519, ADR-017 §2.4): `keyid` a receipt key's `kid` from the inbox's manifest at
`https://<host>/.well-known/agent-inbox.json`; covered `"@method"` `"@authority"` `"@path"` (`"@query"`
when there is one, `"content-digest"` when there is a body) and `"sdi-instance"`, the header holding
the inbox's https origin; `created` and `expires` at most 300 s apart, 60 s of clock skew; each signature
used once. `@authority` is the relay's own host (`push.surfingdog.ai`), so a signature made for anyone
else is no signature here. `signInstanceRequest()` (`packages/core/src/protocol/httpsig.ts`) makes it;
`signedRegistrar()` in `relay.ts` signs every registration anew. Without `INBOX_SECRET_KEY` an inbox has
no receipt key, sends no registration, and has no notifications (Settings → Phone says so).

A hosted inbox may be closed to agents and serve no manifest to verify by, so it never signs: it asks
its host's control plane, which knows the tenant and passes the registration to the relay as coming from
that tenant. Everything after a registration (a new token, removing a phone, a message) a hosted inbox
does itself, with the device's secret, like any inbox.

## Calls

JSON over https. A refusal is `application/problem+json`, `{ "type", "title", "status", "code", "detail" }`,
with `Retry-After` where it says to wait.

### `POST /v1/devices` — register a phone (signed)

```json
{ "app": "ai.surfingdog.inbox", "platform": "android", "token": "<FCM registration token>", "sender": "https://inbox.example.com" }
```

`sender`, when given, must be the inbox that signed. **201** (a new device) or **200** (the same token
from the same inbox again: the same device, a new secret, the old one stops):

```json
{ "device": "pd_…", "secret": "pds_…", "platform": "fcm", "app": "ai.surfingdog.inbox", "created_at": "…", "last_ok_at": null, "created": true }
```

`device` names the registration; `secret` is the only credential for it, held by the inbox alone, sealed
with `INBOX_SECRET_KEY`. The relay keeps a hash of it, never the secret. The inbox hands `device` to the
phone (`relay_device` in its answer to `PUT /v1/phone/push`): every message names it.

Refusals: 400 `bad_token`, `bad_platform`, `unknown_app`, `wrong_sender`, `malformed`; 401 `unsigned`,
`bad_signature`, `expired`, `unknown_key`, `unknown_instance`, `replayed_signature`; 409 `device_limit`
(25 phones an inbox); 429 `limited` with `Retry-After` (the limits below, or the relay may not read the
inbox's manifest right now: sign anew and try again after).

### `GET /v1/devices` (signed) → `{ "devices": [ … ] }`, without secrets or tokens.
### `DELETE /v1/devices` (signed) → 204: every phone of this inbox forgotten.

### `PUT /v1/devices/{device}` — the phone's push token changed

`Authorization: Bearer <secret>`, `{ "token": "<new FCM registration token>" }`. 204; 404 when the relay
has no such device or the secret is not its own (the inbox registers again).

### `DELETE /v1/devices/{device}` — forget it

`Authorization: Bearer <secret>`. 204, and 404 when already gone (the inbox takes both as done). The
inbox calls it when the owner removes the phone, and when the phone signs itself out.

### `POST /v1/devices/{device}/messages` — one notification

`Authorization: Bearer <secret>`,

```json
{ "payload": "<base64url of the encrypted message>", "ttl": 86400, "urgency": "high",
  "collapse": "Xq3vT0bq2mKc9fJ1aW7yZA", "id": "n_4fK2pQ9xVb0LmT7sY1cR8e" }
```

- `payload` is the whole `aes128gcm` body: salt (16), record size (4, the inbox writes 4096), key id
  length (1, = 65), the sender's one-time P-256 public key (65), one record. At most 2560 bytes decoded;
  the inbox's plaintext is at most 2048.
- `ttl` is seconds the push service may hold it (0 to 2 419 200). A new booking request's lives no longer
  than until the booking starts: "Accept 14:00" after 14:00 is no use.
- `urgency` is `high` for a new request, `normal` for what rules answered.
- `collapse` (optional) replaces an earlier undelivered message with the same value. It reaches the push
  service in the clear, so it is never an item's id: the inbox sends `b64u(HMAC-SHA256(phone's auth
  secret, "collapse:" + item id))[:22]`, stable for one item and meaningless to anyone else.
- `id` (optional) is an idempotency key for a day: the inbox sends the same one on every try of one
  notification, `"n_" + b64u(HMAC-SHA256(phone's auth secret, "notify:" + job id))[:22]`, so a retry
  after a timeout is not delivered twice.

| Answer | Meaning | The inbox does |
|---|---|---|
| 200 `{"status":"sent"}` | the push service took it (or an earlier try with this `id` did) | nothing more |
| 409 `{"status":"duplicate"}` | an earlier try with this `id` is delivering it | nothing: it is done |
| 410 `gone`, 404 | the phone's app is gone (uninstalled, its token replaced); the relay forgot the device | marks the phone `lost`; it registers again the next time the app opens |
| 429 `limited`, 503 `retry`, with `Retry-After` | a limit, or the push service failed for now | tries again later |
| 400, 413 | not an RFC 8291 message, too large, or refused by the push service | does not try again |

## What the phone receives

A **data-only** FCM message (no `notification` block), so the app's own code decrypts it even while the
app is closed; priority `HIGH` for `urgency: high`, else `NORMAL`; the TTL and the collapse key as given:

```json
{ "sd": "1", "d": "pd_…", "p": "<the payload, exactly as the inbox sent it>" }
```

`d` tells the phone which inbox's keys open `p` (a phone may be connected to several inboxes); a phone
that does not know `d` yet tries each. A message no key opens is dropped. What `p` says is for display
only: its action only opens the item in the app, with the action chosen, after the owner's fingerprint
or face; the app reads the item from the inbox before it shows anything to accept.

## What the relay keeps

Inboxes (origin, or the hosted tenant), and per device: its id, the inbox, the platform, the push token
(encrypted at rest), the secret's hash, the last delivery, failures in a row; for a day, the outcome per
`id`; used signatures until they expire. It keeps no payload, and writes no payload, token or secret to a
log or a metric. A device nothing reached for 90 days is deleted.

## Limits a relay applies

A message spends four buckets, narrowest first: per device 1 every 2 s (burst 20), per inbox 2 a second
(burst 120), per push token 3 a second (burst 60), everyone 200 a second. Registrations: 30 an hour per
inbox (burst 10), 25 devices per inbox; new self-hosted inboxes are limited per registrable domain and per
caller. Failed signatures and wrong secrets are counted against the caller and the device; a device's own
secret is never refused.

## The payload, once decrypted

What the phone shows; written by `packages/core/src/phones/payload.ts`:

```json
{ "v": 1, "t": "item", "item": "<id>", "kind": "booking", "title": "New booking request",
  "body": "Tue 21 Oct, 14:00 · Cut & finish · €48.00", "free": true,
  "action": { "event": "confirm", "label": "Accept 14:00" }, "at": 1792490400000 }
```

Minimal by default: the kind, the time or the size, and the business's own catalogue name for what is
asked for, never a customer's name or anything a customer wrote (a quote request for something not in the
catalogue says "Quote request"). `who` (the customer's name) and `text` (their first words) are there
only when the owner turned on "Show details" on that phone; the phone then marks the notification
private, so a lock screen set to hide sensitive content shows the minimal version. A booking request
offers Accept only when its time is free in the business's calendar (`free`). `t: "test"` is a test from
Settings. A phone never acts on a payload.
