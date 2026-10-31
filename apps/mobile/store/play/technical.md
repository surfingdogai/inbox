# Technical requirements, checked against the code (31 October 2026)

| Play requirement | The app today | Status |
|---|---|---|
| New apps and updates target **Android 16, API 36**, since 31 August 2026 (developer.android.com/google/play/requirements/target-sdk) | `targetSdkVersion = 36`, `compileSdkVersion = 36` (`android/variables.gradle`), AGP 8.13.0 | Meets it. Play raises the level each August: plan for API 37 by August 2027. |
| **Android App Bundle** (`.aab`) for new apps | `android-release` builds an APK only (`assembleRelease`) | **Blocker 1**: add `bundleRelease` (`signing.md` → What CI needs). |
| An app from Play updates only through Play (Device and Network Abuse policy) | The app reads `surfingdog.ai/phone/latest.json` and shows "A new version is ready … Get it", which opens the download page (`src/lib/update.ts`, `screens/Update.tsx`, Settings → This app) | **Blocker 2**: a copy installed by Play must not check or link there. Proposal: a native `installSource()` in `InboxNativePlugin` (`PackageManager.getInstallSourceInfo(...).getInstallingPackageName()` on API 30+, `getInstallerPackageName` below); when it is `com.android.vending`, `checkForUpdate` returns `NO_UPDATE` and never fetches. Test it in `test/update.test.ts` with an installer argument. Choosing at runtime (not a build flag) is right for choice A in `signing.md`, where one signature covers both channels. |
| Reviewers must be able to use the app (App access) | Nothing works without a connected inbox and a Confirm on a computer | **Blocker 3**: `app-content.md` → App access. |
| **16 KB memory pages** for apps with native code that target Android 15+ (since 1 November 2025) | No native libraries of our own; Capacitor, AndroidX and Firebase Messaging ship Java/Kotlin | Expected to meet it. Check once: `unzip -l app-release.aab \| grep '\.so$'` prints nothing (or every `.so` is 16 KB aligned). |
| Advertising ID declaration | No ads or analytics SDK | Before answering "No": `aapt2 dump badging` (or the `android-release` run summary) lists no `com.google.android.gms.permission.AD_ID`. If a library adds it, remove it with `tools:node="remove"` in the manifest. |
| Permissions needing a declaration form | `INTERNET`, `POST_NOTIFICATIONS`, `CAMERA` (camera not required), `USE_BIOMETRIC`, plus what libraries merge in (Firebase Messaging: `WAKE_LOCK`, `ACCESS_NETWORK_STATE`, the C2DM `RECEIVE`; AndroidX: the app's own `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`) | None needs a form. `test/play-listing.node.test.ts` fails if `AndroidManifest.xml` gains a permission; read the merged list in the `android-release` run summary before each submission. |
| Minimum Android | `minSdkVersion = 24` (Android 7.0) | Fine; the listing says "Android 7.0 or later". |
| Backups and data transfer | `allowBackup="false"`, `data_extraction_rules.xml` excludes everything | Matches the listing's "never backed up". |
| Signing key valid past 22 October 2033 | Release key: check its "Valid until" (`signing.md`) | To check. |

## Android developer verification (also affects the download page)

Since 30 September 2026, certified Android phones in Brazil, Indonesia, Singapore and Thailand install
an app, from any source, only when its package is registered to a verified developer; Google plans the
rest of the world from 2027 (developer.android.com/developer-verification). Owners in those four
countries may already be unable to install the APK from surfingdog.ai/phone. Registering needs the same
organisation identity as Play (D-U-N-S), the package name `ai.surfingdog.inbox` and the signing
certificate(s). Apps published on Play through a verified Play Console account are covered there; the
download APK is covered when it carries a registered certificate (simplest with choice A in
`signing.md`). Confirm the current rules on that page when the account exists.
