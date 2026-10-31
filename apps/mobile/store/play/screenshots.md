# Screenshots and graphics

Every image must show the app as it is: its real screens, unedited, with a made-up business and made-up
customers (never a real business's requests). No device frames with features the app lacks, no
captions that promise more than the listing says.

## What Play takes

| Asset | Size | Notes |
|---|---|---|
| App icon | 512 × 512 PNG, 32-bit, ≤ 1 MB | Draw it from the launcher icon (`android/app/src/main/res/drawable/ic_launcher_foreground.xml` on `ic_launcher_background`). `apps/site/public/icon-512.png` is the site's mark: use it only if it is the same picture. Play adds the rounded mask itself. |
| Feature graphic | 1024 × 500 JPEG or 24-bit PNG, no alpha | Required. The mark and the line "New requests on your phone, answered from there." on the site's paper background. No phone mock-up. |
| Phone screenshots | 2 to 8; **1080 × 1920** (9:16) | Play refuses a side more than twice the other, so a modern phone's 1080 × 2400 must be cropped. Four or more at 1080 px+ makes the app eligible for Play's larger placements. JPEG or 24-bit PNG, no alpha. |
| Tablet screenshots | Not needed | The app is a phone app; leave tablet sections empty. |

## Which screens, in order

1. **Inbox, "Needs you"**: three or four open requests (a booking, an order, a quote) from the sample
   business. Shows what the app is for.
2. **A booking request**: the request with **Accept**, **Propose another time** and **Decline**.
3. **Propose another time**: the free times the inbox offers for that service.
4. **A notification** on the phone's shade, with Show details off (no customer name), and its Accept
   action. Must be a real notification from a test inbox, not drawn.
5. **Today**: the day's bookings.
6. **Settings → Notifications**: the kinds, quiet hours ("Hold until morning"), the lock screen switch.
7. **Your inboxes**: two sample businesses.
8. **Connect**: "Connect your inbox" with Scan the code, or the two digits waiting for Confirm.

## How to make them (nothing is generated here)

Best, on a real phone or an emulator with the release build, connected to a test inbox holding a
made-up business:

```sh
adb shell wm size 1080x1920        # the phone draws at 9:16
adb shell wm density 420           # Pixel-like text size; adjust to taste
adb exec-out screencap -p > 01-inbox.png
adb shell wm size reset && adb shell wm density reset
```

Turn on the system demo mode first (Developer options → System UI demo mode) so the status bar shows a
clean clock and full battery; it changes nothing in the app.

Without a phone: the same screens in a browser, which the app bundles unchanged. `pnpm --filter
@surfingdog/mobile dev`, open `http://localhost:5174/?demo` (`&screen=item`, `today`, `settings`,
`inboxes`, `connect`, `propose`) in a 360 × 640 viewport at device pixel ratio 3, which gives exactly
1080 × 1920. These lack Android's status bar; the notification (4) can only come from a phone.
