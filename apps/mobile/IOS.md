# Surfing Dog Inbox for iPhone

The same app as on Android (ADR-028), on an iPhone: the same bundled screens, the Keychain and the Secure
Enclave where Android has the Keystore, and APNs behind the same push relay. **It has not been built yet.**
Building it needs a Mac with Xcode and an Apple Developer account in the company's name; this file is
what is ready without them and the exact steps once they exist.

## Where it stands

Ready in this folder:

- `@capacitor/ios` 8.5.3 (the same Capacitor as Android) and the iPhone settings in `capacitor.config.ts`.
- `ios/`: the Xcode project, made by `cap add ios` with Swift Package Manager (no CocoaPods). Bundle id
  `ai.surfingdog.inbox`, version 1.0.0, iPhone only, iOS 15 and later. Its Info.plist has the camera and
  Face ID purpose strings, the `ai.surfingdog.inbox://` scheme (sign-in links and notification taps) and
  the two Keychain access groups. The icon and launch image are the app's own mark
  (`scripts/ios-art.swift` draws them).
- `ios/Native/`: the native code, method for method the twin of `android/app/src/main/java/...`:
  - `Shared/` (the app and its notification extension): RFC 8291 decryption, the Keychain, the push keys,
    the list of inboxes, the actions' one-time nonces, and what a notification says.
  - `App/` (the app): the device key in the Secure Enclave, the `InboxNative` plugin the screens call
    (`src/lib/native.ts`), and the screen that registers it and covers the app when it could be seen
    elsewhere.
  - `NotificationService/`: the notification service extension that decrypts each notification.
  - `Tests/`: the shared code held to RFC 8291's example (`packages/spec/vectors/push.json`, the vector the
    inbox and Android are held to) and to Android's choices of words.
- The screens already know an iPhone: the native plugin is used on `ios` as on `android`, the update line
  (which points at the Android download page) is Android only, the version never says "test build" on an
  iPhone, and the lock is called a passcode there.
- `store/apple/`: the App Store text in English, Portuguese, Spanish and French, and the answers App Store
  Connect asks for.

Checked without Xcode: `pnpm --filter @surfingdog/mobile check:ios` type-checks every native file that needs
only Apple's system frameworks and runs the shared code's tests. The two files that need Capacitor and UIKit
(`App/InboxNativePlugin.swift`, `App/MainViewController.swift`) are first compiled by Xcode.

Not done: anything that needs Xcode (the extension's target, signing, a build, a device), and the changes
the inbox, the site and the relay need on the day the iPhone app is out (below).

## What it needs

- **A Mac with Xcode 26 or later.** Plan for about 40 GB free: Xcode is over 10 GB installed and its
  download is unpacked beside it; an iOS Simulator runtime adds about 8 GB (not needed when testing on a
  real iPhone over USB), and builds keep a few GB in DerivedData. Command Line Tools alone cannot build an
  iPhone app.
- **The Apple Developer Program, as the organisation** Surfing Dog, Lda (not a person: the App Store shows
  the account's legal name as the seller). Apple asks for the company's D-U-N-S number, a website on the
  company's domain and an email on it, and someone with authority to sign for the company. USD 99 a year,
  or the local price. Enrolment takes from a few days to a few weeks.
- **A real iPhone with a passcode**, for the keys, Face ID and notifications (a Simulator has no Secure
  Enclave and receives no real pushes).

## Once Xcode and the account exist

1. `pnpm install --frozen-lockfile && pnpm --filter @surfingdog/mobile sync:ios`, then open
   `apps/mobile/ios/App/App.xcodeproj` in Xcode.
2. **Target App → Signing & Capabilities**: Team = Surfing Dog, Lda; "Automatically manage signing" on. Add
   **Push Notifications** and **Keychain Sharing** with one group, `ai.surfingdog.inbox.shared` (Xcode
   writes `$(AppIdentifierPrefix)ai.surfingdog.inbox.shared`). The app's own group, its app id, needs no
   entry.
3. **File → Add Files to "App"**: `ios/Native/Shared` and `ios/Native/App`, target App only, "Create
   groups". In `App/SceneDelegate.swift`, make the root `MainViewController()` instead of
   `CAPBridgeViewController()`.
4. **File → New → Target → Notification Service Extension**, named `NotificationService`, embedded in App.
   Delete the `NotificationService.swift` Xcode wrote and add `ios/Native/NotificationService` and
   `ios/Native/Shared` to that target (Shared is in both targets). In its Signing & Capabilities: the same
   Team and **Keychain Sharing** with the same one group. In its Info.plist add `SDIKeychainGroup` =
   `$(AppIdentifierPrefix)ai.surfingdog.inbox.shared`. Deployment target iOS 15. Its bundle id is
   `ai.surfingdog.inbox.NotificationService`.
5. Build and run on the iPhone (Product → Run). Then the checks in "On a real iPhone", below.
6. **App Store Connect → Apps → +**: iOS, name "Surfing Dog Inbox", primary language (founder's call:
   English (U.S.) or English (U.K.)), bundle id `ai.surfingdog.inbox`, SKU `surfingdog-inbox-ios`. Fill
   it from `store/apple/` (the text, App Privacy, review notes).
7. **TestFlight**: set the build number (below), Product → Archive → Distribute App → App Store Connect →
   Upload. Internal testers (people on the team, up to 100) can install it within minutes, without review.
   External testers need Beta App Review for the first build.
8. **Review**: screenshots (6.9-inch iPhone: 1320 × 2868 or 1290 × 2796 pixels; `?demo` in a browser
   shows every screen with a made-up business), then Add for Review → Submit. Release by hand
   ("Manually release this version"), after the launch changes below are live.

**Version numbers.** `MARKETING_VERSION` is `version` in `package.json` (1.0.0). The build number
(`CURRENT_PROJECT_VERSION`) follows Android's versionCode, major × 10000 + minor × 100 + patch (1.0.0 is
10000); a second upload of the same version adds a part: 10000.1, 10000.2. The screens read it as the build.

## Keys and the passcode: Android → iPhone

| What | Android (`Keys.java`, `SecureStore.java`) | iPhone (`ios/Native`) |
|---|---|---|
| Device key (pairs, signs each refresh) | ECDSA P-256 in the Android Keystore, never exported | ECDSA P-256 in the Secure Enclave, never exported (`DeviceKeys.swift`) |
| No screen lock | `isDeviceSecure` false: no key is made | no passcode: `WhenPasscodeSetThisDeviceOnly` makes no key |
| Lock removed | key invalidated: connect again | iOS deletes the key: connect again (`key_gone`) |
| Who may use it | a strong fingerprint or face, or the screen lock; a new enrolment does not end it | `userPresence`: Face ID or Touch ID (any enrolled) or the passcode; a new enrolment does not end it |
| Five minutes after an unlock | counted by the Keystore | counted by the app, which keeps the unlock's context five minutes; the Secure Enclave still refuses any use without an unlock behind it |
| Refresh tokens, cache key | AES-GCM under a Keystore key usable only while unlocked | Keychain, `WhenUnlockedThisDeviceOnly`, the app's own access group |
| Push keys, inboxes, nonces | sealed under a Keystore key with no unlock condition | Keychain, `AfterFirstUnlockThisDeviceOnly`, the group shared with the extension |
| Backups | `allowBackup` off | `…ThisDeviceOnly` items never leave the iPhone; the offline cache (web storage) can be in a backup, but its key cannot, so it opens nowhere else |
| Opening the app, an Accept from a notification | BiometricPrompt | `LAContext` `deviceOwnerAuthentication` |
| Recents, screenshots, recordings | `FLAG_SECURE` | a cover before the app switcher's picture and while the screen is recorded or mirrored; **a screenshot cannot be prevented on an iPhone** |
| The phone's name at the inbox | maker and model ("Pixel 8") | "iPhone" (the iPhone's own name needs an entitlement Apple grants case by case) |

## Notifications

APNs instead of Firebase, through the same relay, encrypted the same way (docs/protocol/push-relay.md):

1. The app asks for permission after connecting, as on Android, and gets an APNs device token (hex).
2. The screens give it to each inbox (`PUT /v1/phone/push`) with the push keys; the inbox registers it
   with the relay as `"platform": "ios"`. Nothing in the inbox or the protocol changes.
3. The relay sends an alert push with a placeholder that names nobody ("Something new in your inbox") and
   `mutable-content`, with `sd`, `d` and `p` beside it. The extension decrypts `p` with the key of the
   inbox `d` names and shows the inbox's own words, before anything is on screen. Out of time, or a
   message no key opens: the placeholder shows.
4. A tap opens the item; Accept (offered only when the time is free in the calendar) opens it with the
   action chosen and a one-time nonce, needs the iPhone unlocked, and the app asks for Face ID before it
   shows anything to accept. Nothing is ever done from a notification.
5. What rules answered arrives quietly (no sound, passive), as Android's quiet channel.

**The relay.** Its APNs sender is written and switched off until it has Apple's key: an **APNs
authentication key** (`.p8`) the account holder makes once in the Apple Developer account (Certificates,
IDs & Profiles → Keys → +, "Apple Push Notifications service (APNs)", environment Sandbox & Production,
restricted to the topic `ai.surfingdog.inbox` if offered). Apple lets it be downloaded **once**. It goes
straight to the relay's own machine, readable only by the relay's service, with the Key ID, the Team ID
and the topic beside it, and never into this repository, a CI secret, a chat, an email or a log. Losing it
costs little: revoke it, make another, install that. TestFlight and App Store builds use APNs' production
service, so the relay runs against production; a build run from Xcode gets development tokens, which
production refuses (the relay then forgets that phone). Test notifications with a TestFlight build, or add
an `environment` to registrations so one relay serves both (open question below).

## The day the iPhone app is out

Before release, in the same change:

- **The page a code or sign-in link opens** (`packages/adapters/src/phone.ts`): today it hands the link to
  the app only on Android (`intent://`) and says "iPhone soon." elsewhere. On an iPhone it should open
  `ai.surfingdog.inbox://link?o=…&s=…` (and `…://pair?…` for a code), and offer the App Store when the app
  is not installed. iOS cannot pin a scheme to one app; ADR-028 §3 already makes a caught link useless (the
  PKCE verifier and the device key are on the phone that asked). Until this ships, the emailed sign-in link
  does not reach the iPhone app, which is why the App Store text does not mention it.
- `packages/core/src/phones/links.ts`: the App Store address beside `ANDROID_APP_URL`, for Settings → Phone.
- The site: `/phone` says "iPhone soon."; it should link the App Store. The privacy page's "The phone app"
  part speaks of Android only; it needs the iPhone: notifications go through the relay to Apple's Push
  Notification service, which sees the device token, when each message arrives and how big it is; no
  update check (the App Store updates the app); what the app keeps is in the iPhone's Keychain, never
  backed up in a form another device can open.
- The relay: the APNs key installed and the sender on.

## App Store review

What a reviewer may raise, and the answer this app has:

- **Signing in (2.1).** A reviewer must be able to use the app. Connecting needs an inbox and a Confirm on
  a computer, which a reviewer cannot press. Founder's decision: a review inbox (hosted, with made-up
  requests) plus either the emailed sign-in link to a mailbox the reviewer can open (after the page change
  above), or a demo video of connecting and a person on call to press Confirm. Put it in the review notes
  (`store/apple/README.md`).
- **Account deletion (5.1.1(v)).** Applies to apps that create accounts. This app creates none: it
  connects to an inbox that exists. "Remove from this phone" in Settings disconnects it, and removes its
  keys and everything it kept. Say so in the review notes.
- **Sign in with Apple (4.8).** Not required: the app uses the inbox's own sign-in, no third-party login.
- **A website in a wrapper (4.2).** The screens are bundled in the app, not loaded from a site; the app
  uses the Secure Enclave, the Keychain, Face ID, the camera, encrypted notifications decrypted on the
  phone, and works offline.
- **Purchases (3.1.1).** The app sells nothing and links to no purchase.
- **Other platforms (2.3.10).** The iPhone app and its store text never mention Android; the update line
  that points at the Android download is off on an iPhone (`App.tsx`).
- **Notifications (4.5.4).** Optional (the app works without them) and never marketing.
- **Purpose strings.** Camera (scanning the code) and Face ID, in `ios/App/App/Info.plist`.
- **Encryption export questions.** The app uses standard algorithms (ECDSA and ECDH on P-256, AES-GCM,
  HMAC-SHA256, HTTPS) through Apple's frameworks, to authenticate and to protect the owner's data. The
  answers, and whether to set `ITSAppUsesNonExemptEncryption` in Info.plist, are the founder's to give in
  App Store Connect.
- **Privacy labels.** Answers drawn from the code, in `store/apple/README.md`.

## On a real iPhone

Before the first TestFlight build goes to anyone:

- Connect with no passcode set: refused, "Set a passcode first". Set one: connects.
- Away more than five minutes, then a refresh: the app asks for Face ID once, then signs.
- Remove the passcode: the inbox asks to connect again (the device key is gone).
- A notification while the iPhone is locked; with "Show details" on and Show Previews "When Unlocked": no
  name on the lock screen.
- Accept from a notification: needs the iPhone unlocked, then Face ID, then the confirm sheet.
- A notification after "Remove from this phone": the placeholder, never the old inbox's words.
- The app switcher shows the cover; a screen recording shows the cover.
- Offline: the last state and from when; an action is sent once back online.

## Open questions

- Per-registration APNs environment in the relay (development builds from Xcode receive no notifications
  from a production relay), or test notifications on TestFlight only.
- Apple's notification-filtering entitlement, to drop a message no key opens instead of showing the
  placeholder (Android drops it). Requested from Apple; granted case by case.
- iPad: off for 1.0 (iPhone only; an iPad runs it as an iPhone app). On would need iPad screenshots and
  layouts.
- "Accept 14:00" in the notification itself: iOS fixes an action's title in advance, so it says "Accept"
  and the time is in the text.
- The phone's name at the inbox is "iPhone" for every iPhone.
