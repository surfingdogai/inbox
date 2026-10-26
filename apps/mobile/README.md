# Surfing Dog Inbox for Android

The owner's phone app (ADR-028): new requests on the phone, answered from there. The inbox stays on the
business's own website; the app connects to it with a QR code from Settings → Phone.

## Get the app

The public app is on [surfingdog.ai/phone](https://surfingdog.ai/phone): the APK, its SHA-256, the
signing certificate and the steps to install it. The app says when a new version is ready.

## Install a test build

Every push that touches the app builds a test APK in GitHub Actions (workflow **android**): the
`internal` build type, built as a release is (not debuggable, shrunk), signed with the repository's key.
Open the run, download the artifact `surfingdog-inbox-<run>-<commit>`, unzip it, and open the `.apk` on
the phone (allow installing from your browser or files app when Android asks). A newer build installs over
an older one when both were signed with the same key (`DEBUG_KEYSTORE_BASE64` below); the run's summary
says when it was not.

The phone needs a screen lock (PIN, pattern or password): the app's keys rely on it. Then, on a computer,
open your inbox → Settings → Phone → **Add a phone**, and in the app press **Scan the code**. The app asks
"Connect to <your inbox>?" and then shows two digits; the computer shows "<your phone> wants to connect"
with the same two: press **Confirm** there.

A test build is signed with the test key, the public app with the release key: neither installs over
the other. Remove one before installing the other, then connect again.

## The two repository secrets

Add them in GitHub → the repository → Settings → Secrets and variables → Actions → New repository secret.

1. **`DEBUG_KEYSTORE_BASE64`** (set this first): one signing keystore for every test build, so new builds
   install over old ones. Without it each run signs with a new key, and installing a newer build means
   removing the older one first, which disconnects the phone from every inbox. With the GitHub CLI:

   ```sh
   keytool -genkeypair -v -keystore debug.keystore -storepass android -alias androiddebugkey \
     -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
   base64 < debug.keystore | gh secret set DEBUG_KEYSTORE_BASE64 --repo surfingdogai/inbox
   ```

   Keep `debug.keystore` somewhere safe and out of the repository. Its SHA-1 (`keytool -list -v
   -keystore debug.keystore -storepass android`) is what the Firebase API key is restricted to (below).

2. **`GOOGLE_SERVICES_JSON_BASE64`**: `google-services.json` for the Android app `ai.surfingdog.inbox`
   (Firebase console → Project settings → Your apps → Android → Download google-services.json), base64,
   since GitHub cannot reliably mask a JSON secret in logs. Without it the app builds and works, without
   notifications.

   ```sh
   base64 -i google-services.json | gh secret set GOOGLE_SERVICES_JSON_BASE64 --repo surfingdogai/inbox
   ```

   An APK always carries the Firebase API key in it, so restrict that key first: Google Cloud console →
   APIs & Services → Credentials → the Android key Firebase made → API restrictions: Firebase
   Installations API and FCM Registration API only; Application restrictions: Android apps, package
   `ai.surfingdog.inbox` with the keystore's SHA-1.

Neither file belongs in the repository (`google-services.json` is ignored here), and the workflow never
prints them.

## Releases

The public app is built by the workflow **android-release** (`.github/workflows/android-release.yml`),
only from a tag `android-v<version>` on `main` whose version is `version` in this folder's
`package.json`. versionName is that version; versionCode is major × 10000 + minor × 100 + patch
(`1.0.0` → `10000`), above every test build.

**The release key** signs every public build for good: a phone installs an update only from the same
key, so a lost key means everyone uninstalls and connects again. It is a PKCS12 keystore, alias
`surfingdog-inbox`, RSA 4096, certificate `CN=Surfing Dog Inbox, O=Surfing Dog`, SHA-256
`98:94:60:20:92:35:DB:AD:49:62:3F:5F:C2:11:69:C3:47:F9:8A:90:02:5A:92:36:E8:99:88:1A:E4:75:27:BF`.
Keep it, and its password, in two places offline. The workflow pins that SHA-256 and fails on any other.

Once, in GitHub → Settings → Environments, make the environment **`android-release`**: a required
reviewer, and deployments only from tags `android-v*`. Its two secrets:

```sh
base64 -i android-release.p12 | gh secret set RELEASE_KEYSTORE_BASE64 --env android-release --repo surfingdogai/inbox
printf '%s' "$PASSWORD" | gh secret set RELEASE_KEYSTORE_PASSWORD --env android-release --repo surfingdogai/inbox
```

`GOOGLE_SERVICES_JSON_BASE64` (below) must be set too: a release never goes out without notifications.

Each release:

1. Set `version` in `apps/mobile/package.json` and merge it to `main`.
2. `git tag android-v<version> <commit on main> && git push origin android-v<version>`, then approve the
   run's `android-release` environment in GitHub.
3. The run builds and signs the APK, checks its certificate, package, version and permissions (in the
   run's summary), opens it on an emulator, and makes a **draft** GitHub Release with
   `surfingdog-inbox-<version>.apk`, its `.sha256`, `latest.json` and a build attestation.
4. Install the draft's APK on real phones and try it, then publish the release (keep it from being
   marked Latest: the repository's Latest is the inbox).
5. Copy the release's `latest.json` over `apps/site/public/phone/latest.json` and publish the site:
   the download page then offers it, and installed apps say "A new version is ready". Raise
   `minSupported` there only when older versions no longer work with inboxes.

## Build it yourself

You need Node 22 or later, pnpm, JDK 21 and the Android SDK (Android Studio installs both).

```sh
pnpm install --frozen-lockfile
pnpm --filter @surfingdog/mobile build             # the screens, into apps/mobile/dist
pnpm --filter @surfingdog/mobile exec cap sync android
cd apps/mobile/android
./gradlew testDebugUnitTest assembleInternal       # JVM tests, then app/build/outputs/apk/internal/app-internal.apk
./gradlew :app:connectedDebugAndroidTest           # Keystore tests, on a phone or an emulator with a screen lock
```

Put your own `google-services.json` in `apps/mobile/android/app/` for notifications.

To try the screens in a browser with a made-up business: `pnpm --filter @surfingdog/mobile dev`, then
open `http://localhost:5174/?demo` (add `&screen=item`, `today`, `settings`, `inboxes`, `connect`,
`propose` or `confirm`, and `&offline` for the offline banner). The demo never ships in the app.

A debug build (`assembleDebug`, for development) may connect to an inbox on your own computer over plain
http (`http://10.0.2.2:8787` from the emulator); the test build and a release only ever over https. The
debug build is debuggable: never use it as your everyday app.

## What is where

- `src/lib/session.ts`: pairing, the sign-in link, tokens and the device key's proofs.
- `src/lib/offline.ts`: the encrypted cache and the outbox of what was done offline.
- `src/lib/native.ts` and `android/app/src/main/java/ai/surfingdog/inbox/`: the Keystore, the
  fingerprint or face, and push (decrypted in `PushService`, shown by `Notifier`).
- `docs/protocol/push-relay.md`: how an inbox reaches the phone through the relay.
