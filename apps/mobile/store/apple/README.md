# App Store text and answers

What App Store Connect asks for Surfing Dog Inbox on iPhone (IOS.md), ready to paste once the account and
the app record exist. Every sentence is true of what the app does; check it again against the build that
is submitted, and keep it so when the app changes.

## The text, per language

`en-US.json`, `pt-PT.json`, `es-ES.json`, `fr-FR.json`: name, subtitle, promotional text, description (one
line per array entry, an empty one for a blank line), keywords, and the support, marketing and privacy
addresses. The same English text serves English (U.K.) too; Portuguese (Brazil), Spanish (Mexico) and
French (Canada) can start from these.

`test/store-apple.node.test.ts` holds them to App Store Connect's limits (name and subtitle 30
characters, promotional text 170, description 4000, keywords 100 bytes) and to the rules reviews reject
on: no other platform or store named, no price in the short fields, no keyword spent on a word of the name.

The app's screens are in English; the other languages' descriptions say so. Button names in the text
("Settings → Phone", "Add a phone", "Confirm", "Show details", "Accept") are the app's own, in English.

The keywords are a first pass. Before release, check them against what people search for in each store.

## The rest of the app record

- **Category**: Business (primary), Productivity (secondary).
- **Age rating**: "None" to every question: 4+.
- **Copyright**: 2026 Surfing Dog, Lda.
- **Price**: free, no in-app purchases.
- **Privacy policy**: `https://surfingdog.ai/privacy/#phone-h`, once it describes the iPhone app (IOS.md).
- **Trader status (EU)**: the founder's decision. Under the EU Digital Services Act, Apple shows a
  trader's address, phone number and email on the App Store page in the EU. Surfing Dog, Lda is a company,
  so it is a trader: decide which address, phone and email may be shown before the app is offered in the
  EU.

## App Privacy (the labels)

A starting point drawn from the code; the founder gives the answers in App Store Connect.

- **Tracking**: none. The app shares nothing with anyone for advertising or measurement, and asks no
  tracking permission.
- **Collected, linked to the person, for App Functionality only**:
  - Identifiers → Device ID: the APNs device token (to the inbox and the push relay) and the device key's
    public half (to the inbox).
  - Contact Info → Email Address: only when the owner asks for a sign-in link by email, sent to their own
    inbox.
  - User Content → Other User Content: replies and notes the owner writes to customers, sent to their
    inbox.
- **Not collected**: location, contacts, health, financial information, browsing and search history,
  purchases, usage data, diagnostics, photos or videos (the camera reads the code on the phone; the
  picture never leaves it), audio, sensitive information.
- Customers' names and messages are read from the business's own inbox and shown; the app does not
  collect them from the person using it. An inbox may be on the business's own server, where Surfing Dog
  never sees it, or hosted by Surfing Dog; the labels above count the hosted case.

## Review notes (App Review Information)

Draft, in English; the access part is the founder's decision (IOS.md, "App Store review"):

> Surfing Dog Inbox is the phone app for a business's own Surfing Dog Inbox, a web inbox for booking
> requests, orders, quote requests and messages. The app creates no accounts: it connects to an inbox
> that already exists, by scanning a code shown in that inbox's Settings → Phone on a computer and
> confirming the connection there.
>
> To review: [how the reviewer connects to the review inbox].
>
> Account deletion: the app creates no account. Settings → "Remove from this phone" disconnects the
> iPhone and removes its keys and everything the app kept.
>
> Notifications are optional; the app works without them. The app sells nothing.

The contact named there is seen only by Apple.
