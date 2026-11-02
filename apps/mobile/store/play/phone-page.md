# surfingdog.ai/phone once the app is on Google Play (draft, not applied)

Apply on the day the Play listing is public, in one site change with the privacy edits
(`privacy-policy.md`). The address stays: Settings → Phone, the page a pairing code opens, and the app's
own links all land on `/phone` (`ANDROID_APP_URL` in `packages/core/src/phones/links.ts`), so nothing in
the inbox or the app has to change for it.

## The changes to `apps/site/src/pages/phone.astro`

1. **A Google Play button first, the download beside it.** In `.get-main`, above the current download:

   ```astro
   const PLAY_URL = "https://play.google.com/store/apps/details?id=ai.surfingdog.inbox";
   …
   <p class="get-buttons">
     <a class="play" href={PLAY_URL}>
       <img src="/phone/google-play-badge.svg" width="180" height="53" alt="Get it on Google Play" />
     </a>
     {released && (
       <a class="btn" href={latest.url} download>Download the APK</a>
     )}
   </p>
   <p class="hint">
     Version {latest.versionName}{size && <> · {size}</>} · Android 7.0 or later ·
     <a class="link" href={NOTES}>Release notes</a>
   </p>
   ```

   The badge must be Google's official artwork (play.google.com/intl/en/badges), unaltered, in the
   language of the page, and never smaller than any other store's badge on the page (the App Store's, later); download it into
   `apps/site/public/phone/` and keep Google's attribution line in the page footer or under it:
   "Google Play and the Google Play logo are trademarks of Google LLC."

2. **Lede and install steps.** The lede stays. The "Install it" section opens with:

   > On most phones, get it from Google Play: it installs and updates like any other app. No Google Play,
   > or would rather not use it? Download the APK below; Android asks you to allow it once.

   and the five numbered steps become the steps for the APK, under a small heading "Installing the APK".

3. **Updates.**

   > From Google Play, the app updates itself like any other. Installed from this page, the app tells you
   > when a new version is ready and opens this page; install it over the one you have and your
   > connections stay.

   Google makes the Play copy's signing key (`signing.md`), so add: "The copy on Google Play is signed
   by Google, so it does not install over a downloaded copy: remove one before installing the other,
   then connect again."

4. **Check the file.** The certificate list gets a second row: "On Google Play, signing certificate
   SHA-256: …" (from Play Console → App integrity → App signing). The line "Every copy of the app we
   publish is signed with the same certificate" becomes "Every copy from this page is signed with the
   same certificate".

5. **"iPhone soon."** Unchanged until the iPhone app exists.

6. **`description` in `<Layout>`**: "The phone app for your Surfing Dog Inbox: new requests as
   notifications, answered from your phone. Get it on Google Play or download it for Android, and connect
   it with one scan."

Nothing else on the page changes; every other line stays true of both copies.
