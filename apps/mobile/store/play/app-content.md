# App content: the declarations

Play Console → Policy and programs → App content. Data safety has its own file (`data-safety.md`).

## Content rating (IARC questionnaire)

- Email for the rating certificate: hello@surfingdog.ai.
- Category: the one for apps that are not games, social networks or news, the utility, productivity
  and communication category (Play currently words it "All other app types").

| Question | Answer | Why |
|---|---|---|
| Violence, blood, fear, horror | No | The app shows a business's own requests. |
| Sexual content, nudity | No | |
| Profanity or crude humour | No | No content of its own. |
| Controlled substances (drugs, alcohol, tobacco) | No | |
| Gambling, simulated gambling | No | |
| Does the app let users interact or exchange content with other users (text, voice, images)? | **Yes** | The owner reads customers' messages and replies to them (text only). |
| Does the app share the user's current physical location with other users? | No | No location permission. |
| Does the app allow users to purchase digital goods? | No | No purchases of any kind. |
| Is the app a web browser or search engine? | No | |
| Does the app contain or promote content that is restricted to adults? | No | |

Expected result: the lowest age rating everywhere (PEGI 3, ESRB Everyone, USK 0, ClassInd L) with the
interactive element "Users Interact". The real ratings are whatever IARC returns; record them here.

## Target audience and content

- Target age groups: **18 and over** only. The app is for people who run a business.
- Could the app unintentionally appeal to children? **No**: no characters, games or child-directed
  content; it opens on "Connect your inbox".
- Not in the Designed for Families programme.

## The other declarations

| Declaration | Answer |
|---|---|
| Privacy policy | `https://surfingdog.ai/privacy` (see `privacy-policy.md` for what to add first) |
| Ads | **No, my app does not contain ads** |
| App access | **All or some functionality is restricted**: see below. This is a blocker. |
| Advertising ID | **No** (confirm first: `technical.md`) |
| Government app | No |
| Financial features | My app doesn't provide any financial features |
| Health | No health features |
| News app | No |
| Photo and video permissions | Not applicable: no `READ_MEDIA_*` permission |
| Foreground service, full-screen intent, exact alarms | Not applicable: none in the manifest |
| Category | **Business** |
| Tags | Business, Productivity (choose from Play's list) |
| Contact details | Email hello@surfingdog.ai (public), website https://surfingdog.ai/phone; no phone number unless the company chooses one |

## App access: how a reviewer gets in (blocker)

Nothing in the app works without an inbox, and connecting one needs the owner to press **Confirm** on a
computer (or to open an emailed link on the phone that asked for it). A reviewer has neither, so the
app as it is today cannot be reviewed. Play needs instructions that work without us there.

Options, for the company to choose (none is built yet):

1. **A sample business inside the app.** The browser demo (`src/demo.ts`, `?demo`) already draws every
   screen with a made-up business; it is dev-only today ("The demo never ships in the app"). Shipping it
   as "Look around with a sample business" on the Connect screen lets a reviewer, and any new owner, see
   everything. It is a product change, and the listing would then say so.
2. **A review inbox.** A hosted inbox for a made-up business, with no real customers, plus a way to
   connect that needs no Confirm for that one inbox (for example a long-lived code that only that inbox
   accepts). Lets the reviewer see real notifications too. It touches pairing security, so it needs its
   own review, and it must never work on any other inbox.
3. Both: 1 for the listing, 2 for the reviewer.

Whatever is chosen, the App access text then reads, in short: what to tap, the review inbox's address
(if any) and the code or steps, and that nothing needs payment.
