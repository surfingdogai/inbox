# ADR-026 — The owner's phone app

**Status:** proposed, 19 October 2026. Android first; built and tested, with debug builds from CI.
Nothing is published to any store, and no relay is running yet.

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
2. **Pairing by QR code, nothing to type.** Settings → Phone in the owner app, for the owner signed in on
   a computer only, shows a code: `https://<inbox>/phone#v=1&pair=<secret>`. The secret is one-time,
   lives five minutes, and is kept only as a hash. The phone makes a device key (ECDSA P-256) in the
   Android Keystore, and trades the secret, with a signature over `pair`, the inbox's origin, a hash of
   the secret and the time, for a refresh token (sixty days, rotating) and an access token (ten minutes).
   Every refresh is signed with the same key, so a copied refresh token is useless anywhere else. A
   rotated token used again within a minute, by the phone itself, is a lost answer and gets fresh tokens;
   later, the phone is removed. The owner is emailed each time a phone is connected.
3. **Without a camera, a link.** "Email me a sign-in link instead": the phone finds the inbox from the
   owner's address (the domain's `/.well-known/agent-inbox.json`, else `inbox.<domain>`; it asks for the
   inbox's address only when neither answers) and asks for a link with a PKCE challenge and its device
   key. The link opens a page that hands it to the app; only the phone that asked holds the verifier and
   the key, so an app that catches the link gets nothing. The answer is the same for any address.
4. **A phone answers the inbox, and nothing else.** A phone's token resolves to the owner in person
   (`Principal.via = "device"`), held at the owner's door to reading and answering items
   (`PHONE_OPERATIONS`) whatever its scopes or `security.enforceScopes` say. Settings, keys, money
   floors, connections, downloads and the owner MCP stay the owner app's on a computer. A phone may list
   the owner's phones and remove one (a lost phone, from another), never a colleague's.
5. **Push through one relay that reads nothing** (docs/protocol/push-relay.md). The relay alone holds
   the push service's credentials. The phone makes, per inbox, an ECDH key and an authentication secret;
   the inbox registers the phone's push token with the relay and keeps the relay's secret and the
   phone's keys sealed with `INBOX_SECRET_KEY` (without one, there are no notifications, and Settings
   says why). Each notification is encrypted on the inbox for that phone (RFC 8291) and decrypted on the
   phone by its own code, while the app is closed too. It is minimal by default: the kind, the time or
   the size, never a name or a word. "Show details" on a phone adds the customer's name and first words,
   still encrypted. Per phone: a switch per kind, and quiet hours that hold notifications until they end
   (one dealt with meanwhile is not sent).
6. **The fingerprint or face.** BiometricPrompt (or the screen lock) opens the app, again after a minute
   away, and comes before an Accept from a notification. A notification's action only opens the item
   with that action chosen, on a confirm sheet: nothing is ever done from a notification.
7. **Offline.** The last state of each inbox is kept encrypted (a key in the Keystore); the app says
   plainly when it is showing it, and from when. What the owner does offline is kept with the
   idempotency key it got when pressed and sent once the inbox can be reached; what the inbox then
   refuses is said.
8. **Several inboxes.** An operator connects each inbox once, each with its own keys.
9. **Item links.** `https://<inbox>/i/<id>` opens the item in the owner app; a notification opens it in
   the phone app by its own scheme, `ai.surfingdog.inbox://i/<id>?o=<inbox>`. Android App Links need
   each inbox's host in the app itself, which a business's own domain cannot be, so the app does not
   claim https links.

## Consequences

Migration 0024 adds `phone_pairings`, `phone_devices` and `phone_tokens`; a download leaves all three out
(phones connect to an inbox, not to a copy). Store releases need organisation accounts (Surfing Dog Lda),
which are pending; until then CI builds a debug APK a person installs by hand. iOS waits for the Apple
account: the same screens, the Keychain where Android has the Keystore, and APNs behind the same relay.
