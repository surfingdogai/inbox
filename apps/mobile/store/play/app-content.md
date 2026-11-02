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
  content; it opens on "Connect your inbox", and its demo is a bike shop's requests.
- Not in the Designed for Families programme.

## The other declarations

| Declaration | Answer |
|---|---|
| Privacy policy | `https://surfingdog.ai/privacy` (see `privacy-policy.md` for what to add first) |
| Ads | **No, my app does not contain ads** |
| App access | **All or some functionality is restricted**: see below (Try the demo). |
| Advertising ID | **No** (confirm first: `technical.md`) |
| Government app | No |
| Financial features | My app doesn't provide any financial features |
| Health | No health features |
| News app | No |
| Photo and video permissions | Not applicable: no `READ_MEDIA_*` permission |
| Foreground service, full-screen intent, exact alarms | Not applicable: none in the manifest |
| Category | **Business** |
| Tags | Business, Productivity (choose from Play's list) |
| Contact details | Email hello@surfingdog.ai (public), website https://surfingdog.ai; no phone number unless the company chooses one |

## App access: how a reviewer gets in

**All or some functionality is restricted**: using the app for real needs the owner's own Surfing Dog
Inbox and a Confirm on a computer. A reviewer has neither, so the first screen offers **Try the demo**:
the app opens Surfing Dog's demo bike shop at https://demo.surfingdog.ai, read-only, with no code, no
sign-in and no screen lock (`DemoClient` in `src/lib/client.ts`; the shop's doors, `/demo/phone/*`, in
`apps/inbox/src/demo.ts`). The shop holds made-up examples only, is set up again every night, and never
shows what anyone else sent it. Nothing pressed in the demo is sent anywhere.

In Play Console → App content → App access → Add instructions:

- **Name**: Try the demo (no sign-in)
- **Username, password**: leave empty
- **Any other information required to access your app**: the text in `app-access.txt`, as it is:

> No account, code, email or payment is needed.
> 1. Open the app. On the first screen, Connect your inbox, tap Try the demo.
> 2. The app opens Oficina Maré, a made-up bike shop we run at demo.surfingdog.ai, with example
>    bookings, orders, quote requests and messages. It is set up again every night.
> 3. Look round Inbox, any request, Today and Settings. The demo is read-only: Confirm, Reply and the
>    switches say so and send nothing.
> 4. To leave: Leave, at the top of the inbox.

Notifications cannot be seen in the demo (it sends none). If Play's review asks for them, the answer is
a review inbox of our own, connected once on a reviewer's phone by a person with the computer; that is
not built, and needs its own security review, as it touches pairing.
