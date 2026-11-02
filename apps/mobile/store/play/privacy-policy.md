# The privacy policy for the listing

**URL for Play Console:** `https://surfingdog.ai/privacy` (the app's part is `#phone-h`, which the app
already links from Settings → This app → Privacy, as Play requires a link inside the app too).

Play wants the policy public, not a PDF, naming the developer as the listing does, with a contact, and
covering what the app collects. The page has the company line (Surfing Dog, Lda, Portugal, NIPC),
privacy@surfingdog.ai, GDPR rights, and a "The phone app" section (`apps/site/src/pages/privacy.astro`).

## What the phone section already covers

The inbox gets the phone's maker and model, public keys and push token; the camera picture never leaves
the phone; notifications are encrypted by the inbox and carried by the relay and Firebase (what each
keeps, the relay's 90 days); the update check; on-phone data encrypted and never backed up; removing an
inbox or uninstalling clears it; no usage data or crash reports.

## Gaps to close before the listing goes live (drafts, not applied)

1. **Where the app comes from.** It says "The app itself comes from GitHub, under GitHub's privacy
   statement." Once on Play:
   > The app comes from Google Play, under Google's privacy policy, or from GitHub, through this site's
   > download page, under GitHub's privacy statement.
2. **The update check is only for the download copy** (the Play copy is built without it, `technical.md`):
   > **Updates.** A copy from Google Play is updated by Google Play and reads nothing from us. A copy from
   > the download page reads `surfingdog.ai/phone/latest.json` at most twice a day…
3. **The email sign-in.** Not mentioned today:
   > **Signing in by email**, instead of scanning: the address you type goes to your inbox, which emails you
   > a link. To find your inbox, the app first asks your email's domain for
   > `/.well-known/agent-inbox.json`, at the domain and at `inbox.` in front of it.
4. **What you do in the app goes to your inbox**: decisions, replies, notification choices. Implied by
   "talks to the inboxes you connect it to", but the Data safety form declares it, so say it:
   > What you do in the app (accepting, proposing a time, declining, replies, your notification choices)
   > goes to that inbox, as it would from a computer.
5. **Removing a phone clears the relay too** (true in `packages/core/src/phones/phones.ts`):
   > When a phone is removed, in the app or in Settings → Phone, your inbox also asks the relay to forget it.
6. **Try the demo** (new in 1.0.1):
   > **The demo.** "Try the demo" reads made-up examples from our demo shop at demo.surfingdog.ai. It sends
   > nothing about you, and nothing you press in the demo is sent anywhere.

None of these changes what the app does; each makes the page say all of it. Apply them in the site
change that adds the Google Play button (`phone-page.md`), on the day the listing is live, and move
`UPDATED` in `privacy.astro` to that date.
