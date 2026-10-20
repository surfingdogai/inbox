# ADR-026 — The owner's phone app

**Status:** proposed, 19 October 2026; revised 20 October 2026 after review (Confirm on the computer,
phone tokens confined to the REST doors, signed relay registration, unlock-bound keys). Android first;
built and tested, with installable test builds from CI. Nothing is published to any store, and no relay
is running yet.

## Context

An owner hears of a booking request by email and answers it at a computer. Most answers are a tap
("Accept 14:00") that the owner would give from their pocket, at once, if their phone told them. The
inbox is the business's own, on its own domain, hosted or on its own server: an app for it must work
with any inbox, keep the inbox where it is, and never put Surfing Dog between the business and its
customers.

## Decision

1. **One app, the screens inside it.** A Capacitor app (`apps/mobile`, package `ai.surfingdog.inbox`)
   whose screens are bundled into it, never a website loaded from somewhere. It reuses the owner app's
   types and its words for dates and money, and draws the approved phone design: Inbox (Needs you, All,
   Handled), the request with Accept, Propose another time and Decline, Today, Connect, Notifications,
   and Your inboxes. It talks to each inbox by native HTTP, so an inbox opens no CORS for it.
2. **Pairing by QR code, nothing to type, and confirmed on the computer.** Settings → Phone in the owner
   app, for the owner signed in on a computer only, shows a code: `https://<inbox>/phone#v=1&pair=<secret>`.
   The secret is one-time, lives five minutes, and is kept only as a hash. The phone first says which
   inbox the code is for ("Connect to inbox.example.com?"); then it makes a device key (ECDSA P-256) in
   the Android Keystore and trades the secret, with a signature over `pair`, the inbox's origin, a hash of
   the secret and the time, for a refresh token (sixty days, rotating) and an access token (ten minutes).
   A code on a screen can be seen by someone else (a screen share, a photo, over a shoulder), so those
   tokens open nothing yet: the phone shows two digits worked out from the secret and its key's
   thumbprint, the owner app shows "Pixel 8 wants to connect · 47", and only the owner's Confirm there
   lets the phone in ("Not mine", or five minutes without an answer, removes it). Until then the phone may
   ask `GET /v1/phone/me` whether it was confirmed, and nothing else. Every refresh is signed with the
   device key, so a copied refresh token is useless anywhere else. A refresh token is spent with a
   compare-and-set, so of two requests at once one wins; one presented again within a minute is a lost
   answer only with a newer proof (`at` later than the proof that spent it), which only the phone's key
   can make, and then what the first answer gave is withdrawn; the same request replayed is refused and
   changes nothing; later, the phone is removed. The owner is emailed each time a phone is connected,
   leading with "Not you? Remove it", the phone's own name for itself quoted. On an Android phone, the
   page a QR code opens hands the code to the app itself, by an `intent://` link pinned to the app's
   package; at phone width, Settings → Phone offers the same as "Open in the app".
3. **Without a camera, a link.** "Email me a sign-in link instead": the phone finds the inbox from the
   owner's address (the domain's `/.well-known/agent-inbox.json`, else `inbox.<domain>`; it asks for the
   inbox's address only when neither answers) and asks for a link with a PKCE challenge and its device
   key. The link opens a page that hands it to the app; only the phone that asked holds the verifier and
   the key, so an app that catches the link gets nothing. The answer is the same for any address, and as
   quick: the email goes after it. The mailbox is the proof here: no Confirm on a computer.
4. **A phone answers the inbox, and nothing else.** A phone's token is resolved on the REST doors only,
   and there only under `/v1/owner/` and `/v1/phone`: on the MCP doors it is refused (401), on every other
   REST path, reading included, forbidden (403). It resolves to the owner in person
   (`Principal.via = "device"`), held at the owner's door to reading and answering items
   (`PHONE_OPERATIONS`) whatever its scopes or `security.enforceScopes` say. Settings, keys, money
   floors, connections, downloads and the owner MCP stay the owner app's on a computer. A phone may list
   its owner's phones and remove one (a lost phone, from another), never a colleague's.
5. **Push through one relay that reads nothing** (docs/protocol/push-relay.md). The relay alone holds
   the push service's credentials, and reaches Google keylessly (workload identity federation with a key
   of its own, under a service account that may only send messages: no service-account key exists). The
   phone makes, per inbox, an ECDH key and an authentication secret; the inbox registers the phone's push
   token with the relay (signed sdi-instance/1 with its receipt key, or, hosted, through its host's
   control plane) and keeps the relay's secret and the phone's keys sealed with `INBOX_SECRET_KEY`
   (without one, there are no notifications, and Settings says so). Each notification is encrypted on the
   inbox for that phone (RFC 8291) and decrypted on the phone by its own code, while the app is closed
   too; its collapse key and idempotency id are opaque HMACs, so neither the relay nor the push service
   sees an item's id. It is minimal by default: the kind, the time or the size, and the business's own
   catalogue name for what is asked for, never a customer's name or words. "Show details" on a phone adds
   the customer's name and first words, still encrypted, and marks the notification private for lock
   screens that hide sensitive content. A booking request offers Accept from the notification only when
   its time is free in the calendar. Per phone: a switch per kind, and quiet hours that hold
   notifications until they end (one dealt with meanwhile is not sent).
6. **The fingerprint or face, and the screen lock behind them.** A phone with no screen lock connects to
   nothing. The device key signs only within five minutes of an unlock (a strong fingerprint or face, or
   the screen lock); past that the app asks once and signs. The refresh tokens and the offline cache's
   key are sealed under a Keystore key usable only while the phone is unlocked; the push keys are not,
   so notifications still open on a locked phone. BiometricPrompt opens the app, again after five minutes
   away, and comes before an Accept from a notification (one prompt, when both are due). A notification's
   action only opens the item with that action chosen, on a confirm sheet, and only with a one-time nonce
   its notification kept: a link another app or a page opens can open an item, never stage an Accept.
   Nothing is ever done from a notification. The app's window is never in Recents or a screenshot.
7. **Offline.** The last state of each inbox is kept encrypted (a key in the Keystore); the app says
   plainly when it is showing it, and from when, or that nothing of that inbox is on the phone yet (never
   "All clear" it does not know). What the owner does offline is kept with the idempotency key it got
   when pressed and sent once the inbox can be reached; what the inbox then refuses is said. An inbox
   removed from the phone, or that removed the phone, takes its cached items and waiting actions with it;
   the last one takes the cache's key; item details nobody opened for a month go.
8. **Several inboxes.** An operator connects each inbox once, each with its own keys.
9. **Item links.** `https://<inbox>/i/<id>` opens the item in the owner app; a notification opens it in
   the phone app by its own scheme, `ai.surfingdog.inbox://i/<id>?o=<inbox>`. Android App Links need
   each inbox's host in the app itself, which a business's own domain cannot be, so the app does not
   claim https links.

## Consequences

Migration 0024 adds `phone_pairings`, `phone_devices` (with `pair_match` and `confirmed_at`) and
`phone_tokens` (with `proof_at`); a download leaves all three out (phones connect to an inbox, not to a
copy). The owner's item views carry `calendar` on open booking requests and `by_rules` in lists. Store
releases need organisation accounts, which are pending; until then CI builds the `internal` build type
(as a release: not debuggable, shrunk) that a person installs by hand, signed with one key kept as a
repository secret. iOS waits for the Apple account: the same screens, the Keychain where Android has the
Keystore, and APNs behind the same relay.
