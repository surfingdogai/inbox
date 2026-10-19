# The push relay: how an inbox reaches its owner's phones

Version 1, 19 October 2026 (ADR-026). The inbox's side is `packages/core/src/phones/relay.ts`; the
phone's side is `apps/mobile/android/.../PushService.java`.

A notification to a phone has to go through the phone maker's push service (Firebase Cloud Messaging
on Android, APNs on iPhone), and only the holder of the app's credentials there can send to it. Those
credentials cannot be given to every inbox, so one relay holds them: Surfing Dog's, at
`https://push.surfingdog.ai`. Every inbox, hosted or on its owner's own server, uses it the same way,
and an operator can point an inbox elsewhere with `INBOX_PUSH_RELAY` (`off` for none).

**The relay can read nothing.** Every message is encrypted on the inbox for one phone, as Web Push
encrypts (RFC 8291, `aes128gcm` of RFC 8188), to an ECDH P-256 key and a 16-byte authentication secret
that the phone made for that inbox and gave only to it. The relay sees which inbox registered a push
token, when it sends, and how many bytes; never who wrote, what about, or to whom.

## Calls

JSON over https. Errors are `{ "error": "<code>", "detail": "<sentence>" }` with the status below.

### `POST /v1/devices` — register a phone

```json
{ "app": "ai.surfingdog.inbox", "platform": "android", "token": "<FCM registration token>", "sender": "https://inbox.example.com" }
```

`201 { "device": "pd_…", "secret": "ps_…" }`. `device` names the registration; `secret` is the only
credential for it, held by the inbox alone: the relay keeps a hash of it, never the secret. `sender` is
the inbox's origin, kept to limit and to answer abuse reports, never shown to anyone. The relay may
check the token with the push service (an FCM `validate_only` send) and answer `422 invalid_token`.
`400` for an app it does not serve; `429` with `Retry-After` past its limits.

### `PUT /v1/devices/{device}` — the phone's push token changed

`Authorization: Bearer <secret>`, `{ "token": "<new FCM registration token>" }`. `200`; `401` for a
wrong secret; `404` for a registration the relay no longer has (the inbox registers again).

### `DELETE /v1/devices/{device}` — forget it

`Authorization: Bearer <secret>`. `204`, and `404` when already gone (the inbox takes both as done).
The inbox calls it when the owner removes the phone, and when the phone signs itself out.

### `POST /v1/devices/{device}/messages` — one notification

`Authorization: Bearer <secret>`,

```json
{ "payload": "<base64url of the encrypted message>", "ttl": 86400, "urgency": "high", "collapse": "<item id>" }
```

`payload` is the whole `aes128gcm` body (salt, record size, the sender's one-time public key, one
record), at most 3 072 base64url characters. `ttl` is seconds the push service may hold it (0 to
2 419 200). `urgency` is `high` for a new request, `normal` for what rules answered. `collapse`, when
given, replaces an earlier undelivered message with the same value.

`202 { "id": "…" }`. `410 gone` when the push service says the token is no longer registered (the app
was uninstalled or its token replaced): the inbox marks the phone `lost` and stops, until the phone
registers again. `401` wrong secret, `404` unknown device, `413` payload too large, `429` with
`Retry-After` past the limits (the inbox tries again later).

The relay sends it to FCM as a **data-only** message, so the phone's own code decrypts it even while
the app is closed:

```json
{ "message": { "token": "…", "data": { "v": "1", "p": "<payload>" },
  "android": { "priority": "HIGH", "ttl": "86400s", "collapse_key": "<collapse>" } } }
```

`priority` is `HIGH` for `urgency: high`, `NORMAL` otherwise. Nothing else goes in `data`; there is no
`notification` block.

## What the relay keeps

The device id, the push token (encrypted at rest), the platform, the sender origin, the secret's hash,
when it was registered and last used, and counts for its limits. It keeps no payload, and writes no
payload, token or secret to a log.

## Limits a relay applies

Per device: 60 messages an hour. Per sender origin: 600 registrations a day and 10 000 messages an
hour. Per address: a flood guard on registrations. A device unused for 90 days is forgotten.

## The payload, once decrypted

What the phone shows; written by `packages/core/src/phones/payload.ts`:

```json
{ "v": 1, "t": "item", "item": "<id>", "kind": "booking", "title": "New booking request",
  "body": "Tue 21 Oct, 14:00 · Cut & finish · €48.00",
  "action": { "event": "confirm", "label": "Accept 14:00" }, "at": 1792490400000 }
```

`who` (the customer's name) and `text` (their first words) are there only when the owner turned on
"Show details" on that phone. `t: "test"` is a test from Settings. A phone never acts on a payload: its
action only opens the item in the app with that action chosen, and asks for the owner's fingerprint or
face first.
