# Surfing Dog Inbox on Google Play: the pack

Everything the Play listing needs, prepared from the app as it is today (version 1.0.0). Nothing here is
submitted, and no account exists yet. Every sentence in the store text is true of what the app does now;
change the text when the app changes, never the other way round.

| File | What it holds |
|---|---|
| `listing/<locale>/title.txt`, `short_description.txt`, `full_description.txt`, `changelogs/10000.txt` | The store text in English (`en-US`, the default), Portuguese (`pt-PT`, `pt-BR`), Spanish (`es-ES`) and French (`fr-FR`). The layout is the one fastlane `supply` reads, so it can be uploaded by tool later. The app itself is in English, and the translations say so. |
| `data-safety.md` | The Data safety answers, each traced to the code. |
| `app-content.md` | Content rating questionnaire, target audience, ads, app access and the other declarations. |
| `privacy-policy.md` | The policy URL, and five gaps on the privacy page to close on launch day. |
| `technical.md` | Target API level against Play's requirement, the App Bundle, 16 KB pages, Advertising ID, developer verification. |
| `signing.md` | Play App Signing, the upload key, what CI needs. |
| `screenshots.md` | Which screens, at what size, and how to capture them honestly. |
| `phone-page.md` | What surfingdog.ai/phone should say once the app is on Play (drafted, not applied). |

`apps/mobile/test/play-listing.node.test.ts` checks Play's length limits (title 30, short 80, full 4000,
release notes 500), that every locale has every file, that no listing has emoji, ranking words or another
platform (the app is Android-only), that each translation says the app is in English, that the
manifest's permissions are the ones `data-safety.md` covers, and that the target SDK meets Play's level.

## Before the first upload: three blockers in the code (`technical.md`)

1. **An App Bundle.** CI builds only an APK; Play takes `.aab`.
2. **No self-update on Play.** The "A new version is ready … Get it" line must not show, nor
   `latest.json` be read, in a copy installed from Play.
3. **A way in for the reviewer.** The app does nothing until an inbox is connected with a Confirm on a
   computer; the reviewer needs a sample business in the app, a review inbox, or both (`app-content.md`).

## Decisions only the account holder can make

1. **Signing: one certificate or two** (`signing.md`). Recommended: give Play the existing release key,
   so Play and download copies install over each other.
2. **The public developer details.** For an organisation account, Google Play shows the **legal name,
   legal address, developer email and developer phone** on the listing (support.google.com/googleplay/android-developer/answer/13628312).
   The address is the company's registered one, from D-U-N-S. This goes against "no postal address in
   anything public": accept it for Play, or don't publish there. The phone number shown must be one the
   company is happy to publish.
3. **Reviewer access**: sample business in the app, review inbox, or both (`app-content.md`).
4. **Countries**: all, or a list. Nothing in the app is country-specific; developer verification
   (`technical.md`) already limits the download APK in four countries.
5. **Automated uploads later** (a Play Developer API service account in CI), or uploads by hand.

## The account holder's steps, in order

| # | Step | Cost | Time |
|---|---|---|---|
| 1 | Get a **D-U-N-S number** for Surfing Dog, Lda (NIPC 517113325), from Dun & Bradstreet (free; Apple's D-U-N-S lookup page also requests one for free). The same number serves Apple. | Free | Up to 30 days; often about a week |
| 2 | Make a **Google account for the company** (an address at surfingdog.ai, never a personal one) and, with it, a **Play Console developer account, type Organisation**: D-U-N-S, the website surfingdog.ai (verified in Search Console, which the company already uses), a private contact, and the public developer email and phone. | US$25 once | Sign-up an hour; Google's verification a few days |
| 3 | Decide signing (decision 1). Check the release key's "Valid until"; make the **upload key** and keep it offline in two places (`signing.md`). | Free | 30 minutes |
| 4 | Add the CI secrets for the bundle (`UPLOAD_KEYSTORE_BASE64`, `UPLOAD_KEYSTORE_PASSWORD` in a `play-release` environment) once blockers 1 and 2 are merged. | Free | 15 minutes |
| 5 | In Play Console, **create the app**: name "Surfing Dog Inbox", default language English (United States), App, Free. Set up Play App Signing as decided. | Free | 30 minutes |
| 6 | **App content**: privacy policy URL, App access (decision 3), Ads, Content rating, Target audience, Data safety, and the rest, from `app-content.md` and `data-safety.md`. | Free | About an hour |
| 7 | **Store listing**: paste the text from `listing/` for each language, upload the icon, the feature graphic and the screenshots (`screenshots.md`), category Business, contact email hello@surfingdog.ai, website https://surfingdog.ai/phone. | Free | About an hour, plus making the images |
| 8 | Add the **app signing key's SHA-1** (Play Console → App integrity) to the Firebase API key's Android restriction (`signing.md` → Firebase). | Free | 10 minutes |
| 9 | Upload the signed `.aab` to the **internal testing** track; install it from Play on two real phones; connect, get a notification, accept from it. | Free | A day |
| 10 | Promote to **production** and send for review. Organisation accounts are not held to the 12-tester, 14-day closed test that new personal accounts need. | Free | Review: usually a few days, up to 7 or more for a new app |
| 11 | The day it is live: apply `phone-page.md` and the privacy gaps (`privacy-policy.md`) in one site change. | Free | Under an hour |
