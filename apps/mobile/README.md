# Surfing Dog Inbox for Android

The owner's phone app (ADR-028): new requests on the phone, answered from there. The inbox stays on the
business's own website; the app connects to it with a QR code from Settings → Phone.

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
