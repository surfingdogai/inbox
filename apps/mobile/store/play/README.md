# Surfing Dog Inbox on Google Play: the pack

Everything the Play listing needs, prepared from the app as it is today (version 1.0.1, the first on
Play). Nothing here is submitted. Every sentence in the store text is true of what the app does now;
change the text when the app changes, never the other way round.

| File | What it holds |
|---|---|
| `listing/<locale>/title.txt`, `short_description.txt`, `full_description.txt`, `changelogs/<versionCode>.txt` | The store text in English (`en-US`, the default), Portuguese (`pt-PT`, `pt-BR`), Spanish (`es-ES`) and French (`fr-FR`). The layout is the one fastlane `supply` reads, so it can be uploaded by tool later. The app itself is in English, and the translations say so. |
| `data-safety.md` | The Data safety answers, each traced to the code. |
| `app-content.md` | Content rating questionnaire, target audience, ads, app access and the other declarations. |
| `app-access.txt` | What Play's reviewer is told, to paste into App access as it is. |
| `privacy-policy.md` | The policy URL, and five gaps on the privacy page to close on launch day. |
| `technical.md` | Target API level against Play's requirement, the App Bundle, 16 KB pages, Advertising ID, developer verification. |
| `signing.md` | Play App Signing, the upload key, what CI needs. |
| `screenshots.md` | Which screens, at what size, and how to capture them honestly. |
| `phone-page.md` | What surfingdog.ai/phone should say once the app is on Play (drafted, not applied). |

`apps/mobile/test/play-listing.node.test.ts` checks Play's length limits (title 30, short 80, full 4000,
release notes 500), that every locale has every file, that no listing has emoji, ranking words or another
platform (the app is Android-only), that each translation says the app is in English, that the
manifest's permissions are the ones `data-safety.md` covers, and that the target SDK meets Play's level.

## The three blockers in the code: done

1. **An App Bundle**: the `play` flavour, `./gradlew bundlePlayRelease`, signed with the upload key
   (`signing.md`, `apps/mobile/README.md` → Build it yourself).
2. **No self-update on Play**: the Play copy's screens are built without the update check or any link
   to the download page, and the Android build refuses screens that have them (`technical.md`).
3. **A way in for the reviewer**: "Try the demo" on the first screen (`app-content.md` → App access).

## Decided

1. **The account**: an organisation account, Surfing Dog, Lda, D-U-N-S 449647554.
2. **Signing**: Google makes and keeps the app signing key; we keep the upload key (`signing.md`). The
   Play copy and the download page's do not install over each other.
3. **Reviewer access**: the demo shop, read-only.

## Still for the account holder

1. **The public developer details.** For an organisation account, Google Play shows the **legal name,
   legal address, developer email and developer phone** on the listing (support.google.com/googleplay/android-developer/answer/13628312).
   The address is the company's registered one, from D-U-N-S. This goes against "no postal address in
   anything public": accept it for Play, or don't publish there. The phone number shown must be one the
   company is happy to publish.
2. **Countries**: all, or a list. Nothing in the app is country-specific; developer verification
   (`technical.md`) already limits the download APK in four countries.
3. **Automated uploads later** (a Play Developer API service account in CI), or uploads by hand.

## The account holder's steps, in order

| # | Step | Cost | Time |
|---|---|---|---|
| 1 | **D-U-N-S number** for Surfing Dog, Lda: 449647554. | Done | |
| 2 | **Play Console developer account, type Organisation**, for Surfing Dog, Lda: D-U-N-S, the website surfingdog.ai (verified in Search Console), a private contact, and the public developer email and phone. | US$25 once | Google's verification a few days |
| 3 | **The upload key**: made (`signing.md`). Keep the keystore and its password in two places offline. | Done | |
| 4 | **The signed bundle**: built from the `play` flavour with the upload key (`signing.md` → Building the bundle), checked: signed by the upload certificate only, minSdk 24, targetSdk 36, not debuggable. | Done for 1.0.1 | |
| 5 | In Play Console, **create the app**: name "Surfing Dog Inbox", default language English (United States), App, Free. Play App Signing: let Google make the app signing key. | Free | 30 minutes |
| 6 | **App content**: privacy policy URL, App access (`app-access.txt`), Ads, Content rating, Target audience, Data safety, and the rest, from `app-content.md` and `data-safety.md`. | Free | About an hour |
| 7 | **Store listing**: paste the text from `listing/` for each language, upload the icon, the feature graphic and the screenshots (`screenshots.md`), category Business, contact email hello@surfingdog.ai, website https://surfingdog.ai. | Free | About an hour, plus making the images |
| 8 | Add the **app signing key's SHA-1** (Play Console → App integrity) to the Firebase API key's Android restriction (`signing.md` → Firebase). | Free | 10 minutes |
| 9 | Upload the signed `.aab` to the **internal testing** track; install it from Play on two real phones; connect, get a notification, accept from it. | Free | A day |
| 10 | Promote to **production** and send for review. Organisation accounts are not held to the 12-tester, 14-day closed test that new personal accounts need. | Free | Review: usually a few days, up to 7 or more for a new app |
| 11 | The day it is live: apply `phone-page.md` and the privacy gaps (`privacy-policy.md`) in one site change. | Free | Under an hour |
