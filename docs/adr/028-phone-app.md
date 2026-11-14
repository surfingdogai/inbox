# ADR-028 — The owner's phone app

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

Migration 0025 adds `phone_pairings`, `phone_devices` (with `pair_match` and `confirmed_at`) and
`phone_tokens` (with `proof_at`); a download leaves all three out (phones connect to an inbox, not to a
copy). The owner's item views carry `calendar` on open booking requests and `by_rules` in lists. Store
releases need organisation accounts, which are pending; until then CI builds the `internal` build type
(as a release: not debuggable, shrunk) that a person installs by hand, signed with one key kept as a
repository secret. iOS waits for the Apple account: the same screens, the Keychain where Android has the
Keystore, and APNs behind the same relay.

## Amendment 1 (26 Oct 2026): the Android app by direct download

Until the store accounts exist, the public Android app is an APK attached to a GitHub Release and offered
from `https://surfingdog.ai/phone`, which is `ANDROID_APP_URL`: Settings → Phone, the page a pairing code
opens without the app, and the app's own update line all land there, on the install steps, never on the
file itself.

- **One release key, for good.** A phone installs an update only from the key that signed what it has, so
  the release key (PKCS12, RSA 4096, `CN=Surfing Dog Inbox, O=Surfing Dog`) is not the test key and
  never meets it. Only the workflow `android-release` holds it, in the GitHub environment
  `android-release`, which a reviewer approves; it builds only from a tag `android-v<version>` on `main`
  that matches `apps/mobile/package.json`, and fails unless the APK is signed by the certificate whose
  SHA-256 it pins. Its result is a draft release, published by a person. Test builds keep the test key,
  so neither installs over the other.
- **Version numbers from the tag.** `android-v1.2.3` is versionName `1.2.3` and versionCode `10203`
  (major × 10000 + minor × 100 + patch): always above the test builds, numbered by their CI run.
- **Updates without a store.** `https://surfingdog.ai/phone/latest.json`, published with the page, names
  the newest release, its SHA-256, the certificate, and the oldest version the inbox still works with.
  The app reads it at most twice a day and says "A new version is ready", opening the page in the
  browser; it installs nothing itself and asks for no permission to. A test build never asks.
- **Android's back button** closes an open sheet, then goes back a screen, then puts the app in the
  background.

## Amendment 2 (31 Oct 2026): the iPhone app, prepared

Proposed. The iPhone app is prepared and not yet built (`apps/mobile/IOS.md`): building it needs Xcode
and the organisation's Apple Developer account.

- **The same app.** `@capacitor/ios` beside Android, the same bundled screens, and one native plugin,
  `InboxNative`, with the same methods on both (`ios/Native/App`).
- **Keys.** The device key in the Secure Enclave, made only on an iPhone with a passcode
  (`WhenPasscodeSetThisDeviceOnly`), used only with Face ID, Touch ID or the passcode (`userPresence`),
  and deleted by iOS when the passcode is removed. The five minutes after an unlock are counted by the
  app, which keeps the unlock's context that long; on Android the Keystore counts them. The screens'
  secrets in the Keychain `WhenUnlockedThisDeviceOnly`; the push keys `AfterFirstUnlockThisDeviceOnly`,
  in an access group shared with the notification service extension only.
- **Notifications.** APNs behind the same relay, encrypted the same way: an alert push with a placeholder
  that names nobody, which the extension replaces with the decrypted words. iOS cannot drop a message no
  key opens without Apple's filtering entitlement, so the placeholder shows instead.
- **What iOS cannot do.** A screenshot cannot be prevented; the app covers its screens before the app
  switcher's picture and while the screen is recorded or mirrored. §6's "never in a screenshot" holds on
  Android only. The iPhone's own name needs an entitlement: an iPhone connects as "iPhone".
- **No update line.** The App Store updates the app; the line that points at the Android download page
  shows on Android only.

## Amendment 3 (2 Nov 2026): the Android app on Google Play

Proposed. The Android app goes on Google Play beside the download page (`apps/mobile/store/play/`).

- **Two copies, two Android flavours.** `direct` is the APK on surfingdog.ai/phone, signed with the
  release key, as before. `play` is the bundle for Google Play, signed with an upload key; Google signs
  what it delivers with an app signing key it makes and keeps (Play App Signing). The two carry
  different certificates, so neither installs over the other: moving from the APK to Play means
  removing the app and connecting again, once.
- **No update line on Play.** An app from Play may update only through Play. The Play copy's screens
  are built without the update check (`vite build --mode play` swaps `src/channel.ts` for
  `src/channel.play.ts`), and the Android build refuses to pack either copy's screens into the other.
  Both copies share the version numbers: `1.0.1` is versionCode `10001` on Play and on the page.
- **Try the demo.** With no inbox connected, the first screen offers the demo shop at
  demo.surfingdog.ai, read-only, with nothing to connect: no code, no sign-in, no key and no screen
  lock. The demo instance answers `/demo/phone/*` for anyone with the examples it is set up with every
  night and nothing anyone sent since; the app sends no write there and keeps nothing of it. It is how
  Play's reviewer, and anyone curious, sees the app before having an inbox.

## Amendment 4 (14 Nov 2026): signing in from the phone, and a phone that confirms a phone

Proposed. An owner whose inbox is hosted connects a phone with an email code, at any mail provider,
with no computer and no QR code.

What it protects, and what it does not. A code read by someone else is no use without the phone that
asked (its verifier). But a phisher who starts the sign-in holds that verifier, so a code read out to
them opens a first phone at once; the owner is told after, by email. Once the owner has a phone that can
say yes, a new phone that signs in with the host's code needs that yes, or a wait while the owner is
told. Two ways around it stay open. An emailed sign-in link (`POST /v1/phone/link`, which a hosted inbox
answers too) connects a phone at once until `emailedLinksWait` is on, so a phisher who gets the owner to
forward that email skips the yes. And the same mailbox's code still signs in to the owner app on the
web, whose QR code a computer confirms with no phone's yes. Whether those paths wait for the phone too
is left open.

- **Sign-in through the host's control plane.** "Sign in with email" asks the host first: Surfing Dog's
  own sign-in for the inboxes it hosts (`apps/mobile/src/lib/account.ts`). The host sends a code only to
  an address that owns an inbox there, and answers every address the same, at once; the code and its
  email are made after the answer. The phone starts with a PKCE challenge, and only the phone that asked
  holds its verifier: confirming the code takes the verifier, so a code read by someone else, or the
  email's button opened by another app, is no use. The email says which kind of phone asked ("An
  Android phone", "An iPhone", "A phone"), never its name, which the app no longer sends the host (its
  platform only); it says never to share the code and that we never ask for it, and keeps the code out
  of the subject; its button only opens the app: by an intent pinned to the app on Android, and on an
  iPhone, where any app may claim a scheme, by showing the code to type until the app has a universal
  link. An inbox on the owner's own server is chosen on the email screen itself, with nothing sent to the
  host (§3).
- **A phone's name, as the owner is shown it.** Whoever holds a phone types its name, and a name can
  pass any rule and still speak to the owner ("Reset at getback dot io"). So no email, and no page an
  email's link opens, ever says it: the inbox's emails (a phone connected, a phone that waits, a phone
  stopped), the stop page and its result say the kind of phone only ("an Android phone"), as the host's
  code email does; this replaces §2's quoted name. The owner's own screens, signed in, still show the
  name: beside the kind on the confirm sheet and in Settings → Phone, on the web and in the app, and in
  an item's history; and only when it reads like a phone's (`ownPhoneName`,
  `packages/core/src/phones/names.ts`): Latin letters, digits, spaces, hyphens and apostrophes, at most
  24 characters, no run of more than four digits and six in all (letters that stand in for digits
  count), and no word of us, of a way to reach someone or of an authority, however it is spelled;
  anything else is shown as its kind. The name is kept as the phone sent it.
- **The host's limits**, each read and spent in one step under a lock on the address that a request
  never waits for. Codes to an address: three an hour and ten a day from one network (the one its
  sign-in began on), six an hour and twenty a day from all of them; five sends for one sign-in, a minute
  apart; five tries a code and ten a sign-in, each try compared with its newest three codes; JSON only,
  never a browser's request from another site; and a day's pause after wrong codes, counted by network
  (ten from one network pause that network, thirty from all pause every network), apart from the web's
  own. A network the owner completed a phone sign-in from in the last thirty days is known: it skips the
  address's ceilings and the pause of every network, and keeps its own counts and its own pause, so
  limits a stranger runs up never hold up the owner's own phone. Only its keyed hash is kept, for thirty
  days from that sign-in. When the address's ceilings or the pause of every network stop a code from a
  network that is not known, the owner is told, once a day, by email and an alert: someone asked for
  many codes to sign in on a phone; nothing to do if it was not them, and no code was used; a phone on a
  network they signed in from before is not held up; and they can still connect a phone on the web,
  from any browser: sign in, then Settings → Phone. Every sign-in is answered alike, for any address,
  before anything is looked up. The address's six and twenty, the ten and thirty wrong codes and the
  thirty days are proposals. Codes go two days on.
- **A link for the phone, redeemed at the inbox.** A confirmed code gives a grant that opens, once and
  for ten minutes, a link to one of that address's inboxes. The host's runtime makes it at the inbox's
  canonical origin only, with a fresh challenge and the device key the phone made for that inbox, and
  sends no email (`phones.hostLink`, the admin call `POST /admin/v1/tenants/{id}/phone-link`). The phone
  redeems it there exactly as an emailed link is redeemed (`POST /v1/phone/link/redeem`). An inbox nobody
  has signed in to yet makes the owner the host names its owner then, as a first handoff does. A closed,
  closing or paused inbox gives no link.
- **A phone confirms a phone.** When the owner already has a phone that can say yes (confirmed, signed
  in within its refresh token's two months, and with an app that can: one that came by the host's link,
  which only that app uses, or one whose app has looked for new phones, `answers_at`), a new phone that
  came by the host's link waits for that phone's yes, as a QR code waits for the computer's: the same two
  digits on both screens, worked out from the link and the new phone's key. A phone unused for two
  months, long reinstalled, or still on the app released before (1.0.x, which has no sheet to say yes
  on) makes nobody wait. An emailed link waits the same way only once `emailedLinksWait` is on: the app
  released before keeps a phone that waits as connected, and is stuck. The app that waits on an emailed
  link is 1.1.0 (versionCode 10100), the next release; the inbox turns emailed links' wait on once the
  update check and Play have moved owners onto it, and not before. The owner's
  phones are told by a notification that names nobody ("A new phone wants to connect"), and the app asks
  on a sheet, after the fingerprint or face, never from the notification. Confirm is signed by the
  confirming phone's device key (`proofStatement("confirm", …)`), which signs only shortly after an
  unlock; "Not mine" removes the new phone. Until the yes, the new phone may ask whether it came
  (`GET /v1/phone/me`), give up, or wait a day, and nothing else; it waits fifteen minutes at most.
  It asks every two seconds, only while the app is in front, and never for the fingerprint or face:
  once its first token (ten minutes) cannot be renewed without one, it stops and shows "Check now",
  whose press may ask once; a wait that runs out, or Cancel, asks nothing. A phone waiting out its day
  looks the same way, and its "Check again" may ask once.
  New calls: `GET /v1/phone/pairings`, `POST /v1/phone/pairings/{id}/confirm`, `…/refuse`.
- **The owner without their other phone.** "I don't have my other phone" (`POST /v1/phone/wait`) lets the
  new phone in a day later, or three days later when none of the owner's phones would hear of it at once
  (notifications off, or not heard from in a month): the owner then has time to open the app on one,
  where the sheet asks. Meanwhile every phone of the owner is told and can stop it, and the owner's
  email leads with "Not you? Stop it": a page of the inbox (`/auth/phone/stop`) whose button, never the
  link alone, removes the waiting phone. Its times are the business's own, as its notifications are.
  Back after its wait, the new phone is let in only if nothing stopped it, and the owner is emailed as
  for any phone connected. One not back within a week goes.
- **A phone stopped.** "Not mine", or the email's "Stop it", removes the new phone, makes no new link
  (the host's or an emailed one) for a day, and tells the owner that someone used a code or link sent to
  them, so they secure their email. The host is answered `phone_paused` meanwhile; Settings → Phone on
  the web, from any browser, can still connect a phone. Wherever the owner is told to remove an old
  phone (the stop email, the app's waiting screens, the host's answers and emails), it says so in those
  words, and at phone width Settings → Phone puts each phone's Send a test and Remove under its lines.
- **The app.** The confirm sheet asks for any inbox on the phone, naming it when there are several: the
  app asks every inbox when it opens, comes back, or every half minute while it is in front (never in
  the background), and a notification about an inbox opens that inbox. Those looks never ask for the
  fingerprint or face, so an owner who leaves the app open is never prompted for nothing: an inbox
  whose token cannot be renewed without an unlock is looked at again after the next one. Only a
  notification about a new phone, once opened, may ask. The app never asks for an unlock in the
  background, and gives up on one that does not answer within a minute. The sheet is a dialog that takes
  the focus, and a tap beside it answers nothing; "Later" asks again when the app next comes to the
  front, or when that notification is opened.
- **Kept.** Migration 0037 adds `via`, `confirm_by`, `wait_until`, `stop_hash`, `stopped_at` and
  `answers_at` to `phone_devices`. The owner's email for a phone connected says how: the computer, a link, a code, the
  other phone, or the wait. What a phone may do once in is unchanged (`PHONE_OPERATIONS`).
- **Deploy order.** The inbox and the host's runtime first, then the host's control plane (its
  `phone_paused` and `not_owner` answers need the runtime's), then this app as 1.1.0 (versionCode 10100).
  Emailed links' wait stays off until 1.1.0 is the oldest in use; then `minSupported` 10100 is published
  in `apps/site/public/phone/latest.json`, so the download page's copy asks older ones to update.

## Amendment 5 (14 Nov 2026): answering fast

Proposed. Most requests are answered with a price, a yes or a short sentence. The phone gives each of
them in one or two taps, from facts and from the owner's own words, with no AI, and what a phone may do
stays as it was (`PHONE_OPERATIONS`, unchanged; a test holds it).

- **Price chips.** On a request for a price, chips with the matching prices from the inbox's public list
  of services (`GET /v1/services`), which the app reads with no token, as any assistant does: the service
  the request names, when it names one, else one of the same name, else one whose whole name is within
  the request's or the other way round ("€35 · Lunch for one", "From €12 a person · Tasting menu"). A
  service priced on request has none. `apps/mobile/src/lib/chips.ts`.
- **The price sheet.** A chip opens it with the amount filled in (times the people, or the number asked
  for); "Send a price" opens it empty. A "from" price says it is the least the list asks. The sheet says
  until when the price holds (the inbox's `offerValidHours`, from `GET /v1/phone/me`). Its Send makes the
  offer the item's state takes, as the inbox builds it with every check it makes
  (`POST /v1/owner/items/{id}/offers`): for a request for a price, a quote the customer, or their
  assistant, can accept.
- **Drafted offers.** A draft the owner's AI, a rule or another system made outside the owner's limits,
  or one a person must look at first (a stay's quote from the rates), shows on the item with every term
  the customer would read (its time, each line with its amount and choices, the total, a stay's lines,
  its rate plan, what it includes, what is paid when, its cancellation and whether a card holds it, and
  the people, delivery, fees, stages, tax and until when it holds), why it was not sent ("Not sent yet"
  when no limit kept it), "Send as it is" (`…/offers/draft/send`), and Drop it. The card is worded from
  what the draft keeps, which is what is sent: an order's lines with each choice by the name the customer
  reads ("Large (36 cm), ½ Piña"), kept in a draft's terms only, so no fingerprint a customer or a link
  holds changes; a stay's whole quote but its source. A draft with its own words to the customer opens
  them in full first: no person wrote them.
- **Quick replies.** On a message, the owner's saved replies, in their own words: after a reply typed on
  a message, the app asks "Save as a quick reply?", only for words that hold nothing of that customer
  (their name, address or phone, nor a number from their request) and short enough to show whole (120
  characters); Settings → Answers lists and removes them. A chip and its Undo show every word. They
  are kept on the phone only, sealed in the offline box per inbox (`apps/mobile/src/lib/replies.ts`), and
  go with the inbox when it is removed from the phone; they move into the inbox later, to follow the
  owner from phone to phone. Two default chips, "Yes, we can." and "Sorry, not that day.", appear only
  in a language we write for customers (English or Portuguese), and only when the business's own
  languages (`GET /v1/business`) include it: in the customer's language when the business speaks it (the
  item's party carries its `locale`), both when it speaks both and theirs is unknown. The public prices
  and languages are kept on the phone too, so the chips are there offline.
- **Undo.** A chip, the price sheet's Send and a draft's Send wait the six seconds the spam presses wait
  (`src/lib/undo.ts`) before anything leaves the phone; Undo drops them. Then they go through the outbox
  with the idempotency key they were given, so an answer pressed offline goes once, when the inbox
  answers.
- **Answer times** (`packages/core/src/answers`). For each day, on the business's own date: the requests
  customers and their assistants sent through the inbox's own doors, how many were answered and who
  answered first (a person, a rule, anything else; the owner's AI on the owner's MCP door is anything
  else, whatever key it holds), and of those that came in opening hours and not while every phone that
  would have told the owner was in its quiet hours, how many were first answered within 5, 15 and 60
  minutes, with the median. The first answer is a reply or a transition that answers
  (a price, Accept, Propose, Decline, a question back); a note, Spam or closing without a word is none,
  nor a rule's reply that leaves the request for a person (a rule answers only by a transition).
  Test items (the host's own probes among them), what the spam filter held, put aside or is screening,
  Spam, notices, account mail and the business's own entries are never counted. Counts only: a day and
  numbers, never a word, a name or an address. A hosted inbox reports them with its monthly usage
  (`answers` on the admin `GET …/usage`), counting only what came since its door opened (`since`).
