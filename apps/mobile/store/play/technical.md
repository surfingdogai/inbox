# Technical requirements, checked against the code (2 November 2026)

| Play requirement | The app today | Status |
|---|---|---|
| New apps and updates target **Android 16, API 36**, since 31 August 2026 (developer.android.com/google/play/requirements/target-sdk) | `targetSdkVersion = 36`, `compileSdkVersion = 36` (`android/variables.gradle`), AGP 8.13.0 | Meets it. Play raises the level each August: plan for API 37 by August 2027. |
| **Android App Bundle** (`.aab`) for new apps | The `play` flavour: `./gradlew bundlePlayRelease`, signed with the upload key (`signing.md`); workflow `android` builds it unsigned on every change | Done (was blocker 1). |
| An app from Play updates only through Play (Device and Network Abuse policy) | The download page's copy reads `surfingdog.ai/phone/latest.json` and shows "A new version is ready … Get it" (`src/lib/update.ts`, `screens/Update.tsx`). The Play copy is built without either: `vite build --mode play` puts `src/channel.play.ts` in place of `src/channel.ts`, and `checkPlayScreens` in `app/build.gradle` refuses to pack screens that mention the release file or the download page. Decided at build time, since the two copies are signed differently (`signing.md`) | Done (was blocker 2). `test/channel.node.test.ts` builds both copies' screens and checks it. |
| Reviewers must be able to use the app (App access) | "Try the demo" on the first screen opens the demo shop at demo.surfingdog.ai, read-only, with no code or sign-in | Done (was blocker 3): `app-content.md` → App access. |
| **16 KB memory pages** for apps with native code that target Android 15+ (since 1 November 2025) | No native libraries of our own. One comes with a dependency: `libdatastore_shared_counter.so` (AndroidX DataStore, through Firebase), in all four ABIs | Meets it: on the 1.0.1 bundle every `.so` has 16 KB LOAD alignment, and the bundle stores them uncompressed at 16 KB (`bundletool dump config`). Check again when a dependency changes: `unzip -l app-play-release.aab \| grep '\.so$'`. |
| Advertising ID declaration | No ads or analytics SDK | Answer "No": the 1.0.1 bundle's merged manifest (`bundletool dump manifest`) has no `com.google.android.gms.permission.AD_ID`. If a library adds it later, remove it with `tools:node="remove"` in the manifest. |
| Permissions needing a declaration form | `INTERNET`, `POST_NOTIFICATIONS`, `CAMERA` (camera not required), `USE_BIOMETRIC`, plus what libraries merge in (Firebase Messaging: `WAKE_LOCK`, `ACCESS_NETWORK_STATE`, the C2DM `RECEIVE`; AndroidX Biometric: `USE_FINGERPRINT`, for Android 9 and earlier; AndroidX: the app's own `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`) | None needs a form. `test/play-listing.node.test.ts` fails if `AndroidManifest.xml` gains a permission; read the merged list in the `android-release` run summary before each submission. |
| Minimum Android | `minSdkVersion = 24` (Android 7.0) | Fine; the listing says "Android 7.0 or later". |
| Backups and data transfer | `allowBackup="false"`, `data_extraction_rules.xml` excludes everything | Matches the listing's "never backed up". |
| Signing key valid past 22 October 2033 | Google makes the app signing key; the upload key is valid until 20 March 2054 (`signing.md`) | Meets it. |

## Android developer verification (also affects the download page)

Since 30 September 2026, certified Android phones in Brazil, Indonesia, Singapore and Thailand install
an app, from any source, only when its package is registered to a verified developer; Google plans the
rest of the world from 2027 (developer.android.com/developer-verification). Owners in those four
countries may already be unable to install the APK from surfingdog.ai/phone. Registering needs the same
organisation identity as Play (D-U-N-S), the package name `ai.surfingdog.inbox` and the signing
certificate(s). Apps published on Play through a verified Play Console account are covered there; the
download APK is covered when its own certificate (the release key's) is registered too, since Google
signs the Play copy with another. Confirm the current rules on that page when the account exists.
