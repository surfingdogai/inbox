# Signing for Google Play

## What exists today

- **The release key** (`apps/mobile/README.md` → Releases): PKCS12, alias `surfingdog-inbox`, RSA 4096,
  `CN=Surfing Dog Inbox, O=Surfing Dog`, SHA-256
  `98:94:60:20:92:35:DB:AD:49:62:3F:5F:C2:11:69:C3:47:F9:8A:90:02:5A:92:36:E8:99:88:1A:E4:75:27:BF`.
  It signs the APK on surfingdog.ai/phone (1.0.0). The workflow `android-release` pins it.
- **The test key** (`DEBUG_KEYSTORE_BASE64`) signs CI test builds. It never goes near Play.

## How Play signs

Every new app on Play uses **Play App Signing**: we upload an Android App Bundle (`.aab`) signed with an
**upload key**; Google checks that signature, then signs the APKs it delivers with the **app signing
key**, which Google keeps. A phone only installs an update signed like the app it has.

## Decided: Google makes the app signing key

Play App Signing with a key **Google makes and keeps** (choice B of the two there were). We keep only
the upload key. So:

- The copy on Google Play is signed by Google's key, the download page's by the release key: two
  certificates. Neither installs over the other. Someone who installed the APK from surfingdog.ai/phone
  and moves to Google Play removes the app first and connects their inboxes again, once.
- The /phone page lists both certificates once the Play listing is live (`phone-page.md`); Play Console
  shows the app signing key's SHA-256 and SHA-1 under Test and release → App integrity → App signing.
- The Firebase API key restriction needs the app signing key's SHA-1 added (below).
- Because the two copies never install over each other, the Play copy decides its own updates at build
  time: it is the `play` flavour, built without the update check (`apps/mobile/README.md`).
- A leaked or lost upload key is not the end: Google can reset it on request (Play Console → App
  integrity → request upload key reset). The app signing key never leaves Google.

## The upload key

Made for Surfing Dog Inbox on 2 November 2026 and kept by the account holder, off the repository, with
its password:

| | |
|---|---|
| Keystore | PKCS12, alias `upload`, RSA 4096, one password for the store and the key |
| Certificate | `CN=Surfing Dog Inbox upload, O=Surfing Dog`, valid until 20 March 2054 (Play needs past 22 October 2033) |
| SHA-256 | `A7:F8:37:5D:D1:4F:AF:00:82:03:35:8D:D9:DB:10:A3:67:78:62:57:05:B1:C5:7A:1A:50:3D:29:91:5D:08:7E` |
| SHA-1 | `43:73:09:FC:3E:8E:26:A3:D7:D2:0A:D5:0D:96:94:A1:12:C0:96:8A` |

Its certificate (`upload_certificate.pem`) is kept beside it, for when Play asks for it. The first
bundle uploaded registers the key; every later one must be signed with it. Check a bundle before it
goes up: `keytool -printcert -jarfile app-play-release.aab` must show the SHA-256 above, and no other.

The Gradle build reads the key from the environment only (`app/build.gradle`, signing config `upload`):
`ANDROID_UPLOAD_KEYSTORE` (the file), `ANDROID_UPLOAD_STORE_PASSWORD`, `ANDROID_UPLOAD_KEY_PASSWORD`
(the same password, for PKCS12) and `ANDROID_UPLOAD_KEY_ALIAS` (default `upload`).

## Building the bundle

`apps/mobile/README.md` → Build it yourself: `pnpm --filter @surfingdog/mobile sync:play`, then
`./gradlew bundlePlayRelease` with the upload key and the release's numbers in the environment
(`ANDROID_VERSION_CODE`, `ANDROID_VERSION_NAME`; major × 10000 + minor × 100 + patch, the same as the
download page's copy of that version). The bundle carries R8's `mapping.txt` inside it, so Play's crash
view is readable without uploading it separately.

CI (workflow `android`) builds the Play bundle unsigned on every change, to show it still builds and that
its screens carry no update check. It never holds the upload key: uploading stays a person's job, and the
first release must be made in Play Console by hand. Later, optional: a Google Cloud service account with
Play Developer API access, in a GitHub environment `play-release` with a required reviewer, and a step
that signs and uploads the bundle to the internal track. That is the account holder's call.

## Firebase (notifications) on Play

The Firebase API key in the app is restricted to package `ai.surfingdog.inbox` plus certificate SHA-1s
(Google Cloud console → APIs & Services → Credentials). Add the **app signing key's SHA-1** that Play
Console shows under App integrity: it is Google's, so it is new. Without it, a Play copy installs and runs
but gets no notifications.
