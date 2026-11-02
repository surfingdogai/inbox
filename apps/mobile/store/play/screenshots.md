# Screenshots and graphics

Every image shows the app as it is: its real screens, unedited, with the demo's made-up bike shop and
made-up customers (never a real business's requests). No device frames, no captions, nothing drawn over
a screen.

## What is in `graphics/`

| File | Size | What it is |
|---|---|---|
| `icon-512.png` | 512 × 512, 32-bit PNG | The launcher icon: `ic_launcher_foreground.xml` on its `#f6f5ff` ground, the part a launcher shows. Play rounds the corners itself. |
| `feature-graphic.png` | 1024 × 500, 24-bit PNG, no alpha | The mark, the app's name and "New requests on your phone, answered from there." on the app's ground. No phone mock-up, nothing near the edges. |
| `phone/light/01-inbox.png` … `06-connect.png` | 1080 × 1920 (9:16), 24-bit PNG, no alpha | Six screens, light. |
| `phone/dark/01-inbox.png` … `06-connect.png` | the same | The same six, dark. |

The six screens, in the order the listing shows them:

1. **Inbox, Needs you**: the demo shop's open requests, under the line that says it is the demo.
2. **A booking request**: Accept, Propose another time, Decline.
3. **Propose another time**: the free times the shop offers on the day the customer asked for.
4. **Today**: the day's bookings and the orders to prepare.
5. **Settings → Notifications**: the kinds, quiet hours, the lock screen switch.
6. **Connect your inbox**: the first screen, with Scan the code and Try the demo.

Upload the six light ones in this order, then the dark Inbox and the dark request: eight, Play's
maximum for phones. Four or more at 1080 px or wider make the app eligible for Play's larger
placements. Play refuses a screenshot with one side more than twice the other, so a phone's full
1080 × 2400 cannot be used as it is. The app is a phone app: leave the tablet sections empty. The same
images serve every language, since the app itself is in English.

## How they are made

```sh
pnpm --filter @surfingdog/inbox play-graphics     # apps/inbox/scripts/play-graphics.mjs
```

It builds the Play copy's screens (`vite build --mode play`), starts the inbox server as a demo shop
(`INBOX_DEMO=1`, on a temporary database, seeded the way demo.surfingdog.ai is every night), opens the
screens in Chrome at 360 × 640 and device pixel ratio 3 (exactly 1080 × 1920), sends the app's requests
for https://demo.surfingdog.ai to that demo shop, presses **Try the demo**, and photographs each screen
in light and dark. The icon and the feature graphic are drawn from the app's own mark
(`apps/inbox/public/favicon.svg`, the same drawing as the launcher icon). Times and dates in the screens
are those of the run. Needs Google Chrome and ImageMagick.

A browser shows no Android status bar and no notification shade, so a notification is not among them.
To add one, take it on a real phone with a test inbox holding a made-up business, with Show details off
and the system demo mode on (Developer options → System UI demo mode), at 1080 × 1920:

```sh
adb shell wm size 1080x1920 && adb shell wm density 420
adb exec-out screencap -p > notification.png
adb shell wm size reset && adb shell wm density reset
```
