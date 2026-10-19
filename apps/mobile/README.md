# Surfing Dog Inbox for Android

The owner's phone app (ADR-026): new requests on the phone, answered from there. The inbox stays on the
business's own website; the app connects to it with a QR code from Settings → Phone.

## Install a test build

Every push that touches the app builds a debug APK in GitHub Actions (workflow **android**). Open the
run, download the artifact `surfingdog-inbox-debug-<run>-<commit>`, unzip it, and open the `.apk` on the
phone (allow installing from your browser or files app when Android asks). A newer build installs over an
older one only when both were signed with the same debug key (see `DEBUG_KEYSTORE_BASE64` below);
otherwise remove the old one first.

Then, on a computer, open your inbox → Settings → Phone → **Add a phone**, and in the app press **Scan
the code**.

## The two repository secrets

Both optional; add them in GitHub → the repository → Settings → Secrets and variables → Actions → New
repository secret.

- **`GOOGLE_SERVICES_JSON`**: the whole text of `google-services.json` for the Android app
  `ai.surfingdog.inbox` (Firebase console → Project settings → Your apps → Android → Download
  google-services.json). Without it the app builds and works, without notifications. With the GitHub
  CLI, from the folder the file is in:

  ```sh
  gh secret set GOOGLE_SERVICES_JSON --repo surfingdogai/inbox < google-services.json
  ```

- **`DEBUG_KEYSTORE_BASE64`**: one debug keystore for every build, so new builds install over old ones:

  ```sh
  keytool -genkeypair -v -keystore debug.keystore -storepass android -alias androiddebugkey \
    -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
  base64 < debug.keystore | gh secret set DEBUG_KEYSTORE_BASE64 --repo surfingdogai/inbox
  ```

Neither file belongs in the repository (`google-services.json` is ignored here), and the workflow never
prints them.

## Build it yourself

You need Node 22 or later, pnpm, JDK 21 and the Android SDK (Android Studio installs both).

```sh
pnpm install --frozen-lockfile
pnpm --filter @surfingdog/mobile build             # the screens, into apps/mobile/dist
pnpm --filter @surfingdog/mobile exec cap sync android
cd apps/mobile/android
./gradlew testDebugUnitTest assembleDebug          # JVM tests, then app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:connectedDebugAndroidTest           # Keystore tests, on a phone or an emulator
```

Put your own `google-services.json` in `apps/mobile/android/app/` for notifications.

To try the screens in a browser with a made-up business: `pnpm --filter @surfingdog/mobile dev`, then
open `http://localhost:5174/?demo` (add `&screen=item`, `today`, `settings`, `inboxes`, `connect`,
`propose` or `confirm`, and `&offline` for the offline banner). The demo never ships in the app.

A test build may connect to an inbox on your own computer over plain http (`http://10.0.2.2:8787` from
the emulator); a release build only ever over https.

## What is where

- `src/lib/session.ts`: pairing, the sign-in link, tokens and the device key's proofs.
- `src/lib/offline.ts`: the encrypted cache and the outbox of what was done offline.
- `src/lib/native.ts` and `android/app/src/main/java/ai/surfingdog/inbox/`: the Keystore, the
  fingerprint or face, and push (decrypted in `PushService`, shown by `Notifier`).
- `docs/protocol/push-relay.md`: how an inbox reaches the phone through the relay.
