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

## The decision: one signature, or two

**A. Give Play the release key we already have (recommended).** In Play Console → Test and release →
App integrity → App signing, choose to use your own key and **export and upload a key from a Java
keystore**: Play shows a download for its encryption tool (PEPK) and the exact command; run it on the
offline machine that holds `android-release.p12`, and upload the encrypted file it writes. Then:

- Play copies and download copies carry the **same certificate**: an owner can move from the download
  to Play (or back) and the update installs over the app, connections and all. The /phone page's line
  "Every copy of the app we publish is signed with the same certificate" stays true.
- One certificate to register for Android developer verification (`technical.md`) and one SHA-1 for the
  Firebase API key restriction (below).
- Cost: Google holds a copy of the release key.
- Check first: `keytool -list -v -keystore android-release.p12 -alias surfingdog-inbox` must show
  "Valid until" after 22 October 2033 (Play refuses an app signing key that ends sooner).
- It is chosen before the first release on Play. After that, Play's key upgrade can only move to a new
  key, never back to ours.

**B. Let Google make a new app signing key.** Simpler on the day, but Play copies get a different
certificate: an owner who installed from the download page cannot update from Play without
uninstalling, which disconnects every inbox. The /phone page must then list two certificates, and the
Firebase key restriction needs both SHA-1s.

## The upload key (both A and B): the account holder makes and keeps it

Separate from the release key, so a leaked upload key never lets anyone sign the app: Google can reset
a lost or leaked upload key on request (Play Console → App integrity → request upload key reset), but
never the app signing key. Make it on the same offline machine:

```sh
keytool -genkeypair -v -storetype PKCS12 -keystore surfingdog-inbox-upload.p12 -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Surfing Dog Inbox upload, O=Surfing Dog"
keytool -export -rfc -keystore surfingdog-inbox-upload.p12 -alias upload -file upload_certificate.pem
```

- Upload `upload_certificate.pem` where Play asks for the upload key certificate (choice A), or let the
  first signed upload register it (choice B).
- Keep `surfingdog-inbox-upload.p12` and its password in two places offline, like the release key.
- Validity 10000 days (about 27 years) is well past Play's minimum (valid beyond 22 October 2033).

## What CI needs

1. A **bundle** build. Today `android-release` runs `assembleRelease` (an APK). Play takes only `.aab`
   for new apps: add `bundleRelease` (the same `release` signingConfig in `app/build.gradle` reads the
   keystore from `ANDROID_RELEASE_KEYSTORE`, `ANDROID_RELEASE_KEYSTORE_PASSWORD`,
   `ANDROID_RELEASE_KEY_ALIAS`, so pointing those at the upload key signs the bundle with it).
2. A GitHub environment for it, for example **`play-release`**: required reviewer, tags `android-v*`
   only, secrets `UPLOAD_KEYSTORE_BASE64` and `UPLOAD_KEYSTORE_PASSWORD` (alias `upload`), plus the
   existing `GOOGLE_SERVICES_JSON_BASE64` (a Play build must have notifications).
3. A pinned upload certificate SHA-256, checked with `jarsigner -verify -verbose -certs` (or
   `keytool -printcert -jarfile`) on the `.aab`, as the APK job pins the release certificate.
4. The R8 `mapping.txt` kept as an artifact and uploaded with the bundle, so Play's crash view (Google's
   own, from phones that opted in) is readable.
5. The same `versionCode` scheme for both channels (major × 10000 + minor × 100 + patch). With choice A
   a Play update and a download update must never reuse a number for different code.

Uploading stays a person's job at first (the first release must be made in Play Console by hand). Later,
optional: a Google Cloud service account with Play Developer API access, its JSON key as a secret, and a
step that uploads the bundle to the internal track. That is the account holder's call.

## Firebase (notifications) on Play

The Firebase API key in the app is restricted to package `ai.surfingdog.inbox` plus certificate SHA-1s
(Google Cloud console → APIs & Services → Credentials). Add the **app signing key's SHA-1** that Play
Console shows under App integrity (with A it is the release key's, which may already be there; with B it
is new). Without it, a Play copy installs and runs but gets no notifications.
