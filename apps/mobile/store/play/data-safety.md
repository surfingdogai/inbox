# Data safety: the answers, from the code

Play Console → App content → Data safety. Each answer below names the code it comes from, so it can be
checked again when the app changes. `test/play-listing.node.test.ts` fails when the manifest asks for a
permission these answers do not cover.

Google's rule: data is **collected** when the app sends it off the phone, whoever runs the server. The
app talks to the inbox the owner connects (on the business's own server, or hosted by Surfing Dog), so
what it sends there is declared, even though for a self-hosted inbox Surfing Dog never receives it.

## Overview

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** |
| Which of the following methods of account creation does your app support? | **My app does not allow users to create an account.** The app signs in to an inbox whose account was made elsewhere (by a code from the inbox's Settings → Phone, or an emailed link); nothing in the app creates one. |
| Do you provide a way for users to request that their data is deleted? | **Yes** (below) |
| Independent security review | Not done: leave unticked. |

**Encrypted in transit.** A release build talks only over https: `inboxOrigin()` in
`packages/core/src/phones/links.ts` refuses plain http outside a debug build, the manifest allows no
cleartext (target SDK 36, no network security config in `src/main`), `capacitor.config.ts` sets
`allowMixedContent: false`, and Firebase Cloud Messaging uses TLS.

**Deletion.** In the app: Settings → **Remove from this phone** (`Sessions.remove` in
`src/lib/session.ts`) tells the inbox to forget the phone (`DELETE /v1/phone`) and wipes the phone's
tokens, keys and encrypted cache. The inbox then removes its relay registration
(`packages/core/src/phones/phones.ts`, `relay.remove`). The owner can also remove any phone in the
inbox's Settings → Phone. Anything else Surfing Dog holds: privacy@surfingdog.ai.

## Data types collected

Shared with third parties: **none** for every row. Transfers to a service provider (Google's Firebase
Cloud Messaging, for delivery) and to the owner's own inbox, at the owner's action, are not sharing in
Google's definition. None of it is used for advertising, analytics or personalisation.

| Play data type | Collected | Required or optional | Purposes | What and where in the code |
|---|---|---|---|---|
| Personal info → **Email address** | Yes | Optional | App functionality, Account management | Only when the owner taps "Sign in by email": the address they type goes to the inbox (`askForLink`, `POST /v1/phone/link`), which emails a sign-in link. The app also reads `https://<email domain>/.well-known/agent-inbox.json` and `https://inbox.<email domain>/…` to find the inbox (`findInbox`). Scanning the code needs no email. |
| Messages → **Other in-app messages** | Yes | Optional | App functionality | A reply the owner writes to a customer goes to the inbox (`reply`, `POST /v1/owner/items/{id}/replies`). |
| App activity → **App interactions** | Yes | Required | App functionality | What the owner does on a request (accept, propose another time, decline, let in, looks fine, spam: `transition`, `spamAct`), notification choices and quiet hours (`setNotify`), the spam emails switches (`setSpamEmails`), a test notification (`test`). |
| Device or other IDs | Yes | Required | App functionality | To the inbox: the push token, the phone's public keys (device key, and an ECDH key per inbox for encrypted notifications) and its name, the maker and model (`deviceName()` in `InboxNativePlugin.java`, `pair`, `registerPush`). The inbox gives the token to Surfing Dog's push relay. Google's Firebase SDK makes a Firebase installation ID and the push token and sends them to Google. |

The Firebase SDK also sends Google a "Firebase user agent" (SDK and platform versions), which Google says
is never linked to a user or device; it maps to no Play data type. Source: firebase.google.com/docs/android/play-data-disclosure.

**Ephemeral?** Answer **No** for every row: the inbox keeps what it is sent (that is its job), and the
relay keeps the push token (encrypted) until the phone is removed or nothing reached it for 90 days.

## Not collected, and why

| Data | Why it is not collected |
|---|---|
| Photos and videos | The camera reads the pairing code inside the app (`src/lib/scan.ts`, jsQR in the WebView). No frame is stored or sent. |
| Biometrics | `BiometricPrompt` answers yes or no; the app never sees a fingerprint or a face. |
| Messages (customers' requests, names, emails, phone numbers) | The app **receives** them from the inbox to show them, and keeps them on the phone encrypted (`src/lib/offline.ts`). It sends none of them anywhere. |
| In-app search history | Search filters on the phone (`screens/Inbox.tsx`); the words never leave it. |
| Notification contents | Encrypted by the inbox to the phone's key (RFC 8291); the relay and Google carry ciphertext only (`docs/protocol/push-relay.md`). Under Google's rules, end-to-end encrypted data is not collected. |
| Location, contacts, calendar, files, audio, health, financial info, web browsing, installed apps | Nothing in the app reads them, and the manifest asks for no permission that could. |
| App info and performance (crash logs, diagnostics) | No crash reporter or analytics SDK (`app/build.gradle`: Capacitor, AndroidX, Firebase Messaging only). |
| Advertising ID | Not used (see `technical.md`: check the merged manifest has no `AD_ID` permission). |

**The update check.** A copy installed from the download page reads `surfingdog.ai/phone/latest.json`
at most twice a day (`src/lib/update.ts`): an ordinary request carrying nothing but what any request
carries. The copy on Google Play must not do this (`technical.md`, blocker 2), so it is not in the form.
