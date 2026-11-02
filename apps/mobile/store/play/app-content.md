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

Before the app is sent for review, the demo must answer: its doors (`/demo/phone/*`) are there once
the inbox server that has them is deployed to demo.surfingdog.ai. Check, changing nothing:

```sh
curl -s https://demo.surfingdog.ai/demo/phone/me | jq -r .business.name        # Oficina Maré, not a 404
curl -s https://demo.surfingdog.ai/demo/phone/items | jq '.items | length'      # more than 0
```

The demo is read-only and sends no notifications, so it cannot show what the listing is about:
connecting, a notification arriving, and an Accept or a Reply that goes. A short video shows those on a
real phone: the phone's own screen recording of connecting to a test inbox (the two digits), a
notification arriving, and an Accept from it. The test inbox holds made-up requests only, never a real
customer's, with Show details off. It goes up unlisted, from a Surfing Dog account, and its short link
(`youtu.be/…`) replaces `<video link>` in `app-access.txt`.

In Play Console → App content → App access → Add instructions:

- **Name**: Try the demo (no sign-in)
- **Username, password**: leave empty
- **Any other information required to access your app**: the text in `app-access.txt` with the video's
  link in it, 500 characters at most:

> No account, code or payment is needed.
> 1. On the first screen, tap Try the demo.
> 2. It opens Oficina Maré, a made-up bike shop at demo.surfingdog.ai: example bookings, orders, quotes
>    and messages, reset nightly.
> 3. Look round Inbox, a request, Today and Settings. It is read-only: Accept, Reply and the switches
>    send nothing.
> 4. To leave: Leave, at the top of the inbox.
> 5. A real inbox on video (connecting, a notification, an Accept): `<video link>`

## The review inbox: specified, not built

Play asks for "all other resources needed to review your app". If its review answers "need login
credentials" or "functionality not accessible", or if the account holder wants it in place before the
first review, the way in is a review inbox. It is built only when the account holder says so.

- **What it is**: a hosted Surfing Dog Inbox of its own, for a made-up business, holding made-up
  requests only: never the demo shop, never a real business. Its made-up customers' addresses end in
  `.invalid`, which takes no mail, so a Reply reaches no one. It is set up again every night, like the demo.
- **The way in**: a QR code, an image linked from App access (Play names a QR code as something it
  accepts), made from that inbox's Settings → Phone → Add a phone, that confirms itself: no two digits, no computer. It
  works on that inbox only, for at most five phones, until a date set when it is made (the end of the
  review). Each phone it connects is listed in Settings → Phone, and removed when the review is over.
- **Notifications**: a made-up request arrives a minute after a phone connects, then every ten minutes
  while one is connected, so the reviewer sees one arrive and can Accept it from the notification.
- **The risk**: a code that confirms itself is what pairing is built to prevent. It must be impossible
  on any other inbox: off by default, on only for an inbox the hosted platform marks as its review
  inbox, refused everywhere else (self-hosted inboxes included), rate-limited and logged. It needs its own
  security review before it ships, as it touches pairing.
