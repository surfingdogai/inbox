# ADR-031 — Booked or ordered elsewhere: doors that name their platform

**Status:** proposed, 20 October 2026. Builds on ADR-024 (owners in control), ADR-025 (carried requests) and
ADR-026 (the connectors' shared base, which leaves this track no base API of its own). Spec 0.9.0.

## Context

Many businesses already take bookings or orders somewhere that works for them: a salon on Fresha or Booksy, a
restaurant on OpenTable or TableCheck, a takeaway on its own Toast or ChowNow page, a shop in its own Shopify
checkout, a guesthouse in its booking engine. Since spec 0.3.1 a manifest could say so (`doors_elsewhere`: a kind of
request and a URL), but:

- the owner app had no field for it, only a way to take it back;
- an agent and the business's own page could only name the page by its host (`Book at www.fresha.com`);
- nothing stopped a link that was the platform's home page, a stranger's shop, or a link carrying someone's
  tracking or affiliate tag.

## Decisions

### 1. A door, not a connector

There is no API, nothing to sign in to and no key: a door elsewhere is a link the business already gives its
customers. The inbox never calls the platform, never writes there and never changes the link. It has no gallery
card and is never called an integration or a connection: copy says "Book at Fresha", never "connect Fresha".

### 2. The platforms: `vocab/door-platforms.json`, version 1

Each platform has a token (`fresha`, `opentable`, `toast`, `shopify`…), a name, a group (salons and wellness,
appointments, restaurant tables, food ordering, shops and websites, trades, booking engines), the kinds of request it
takes (`booking`, `order`), its hosts, how a business's own page there is told apart from the platform's own pages
(`page`: a path other than `/`, a name under the host other than `www`, or either), whether it also serves pages on
the business's own domain (`own_site`), and the public page its hosts were read from (`source`). The list holds
35 platforms, and its examples, vectors and tests rotate businesses across continents.

- **In it:** a platform where a business has its own booking or ordering page.
- **Not in it:** delivery and booking marketplaces that take a share of each sale (Uber Eats, DoorDash, Deliveroo,
  Just Eat, iFood, Rappi, Swiggy, Zomato, Glovo, Grab, Talabat, Booking.com, Airbnb, Expedia). A business may still
  give any page of its own as **Another page**; nobody promotes a marketplace for it.
- **Hosts** were read from each platform's own public pages and help, without signing in. Where a platform's pages
  live on the business's own website (Flipdish, GloriaFood, WooCommerce, Tradify's enquiry form), it has no host of
  its own and takes a page on the business's domain only.
- **Tokens are never removed or renamed.** A token is the same id a network gives the platform's own door type,
  `platform:<id>` (network protocol §4.8), so a door a crawler reads on the business's site matches the one the
  business declares.

### 3. Spec 0.9.0: `platform` on a door elsewhere

`doors_elsewhere[].platform` is optional. `readDoorsElsewhere` keeps it only when the vocabulary knows the token, the
platform takes that kind of request, and the URL is the business's own page there (or, for an `own_site` platform,
anywhere: the domain is the writer's to check). Otherwise it drops the platform alone and keeps the door: a door is
never lost for its name. A 0.8 reader ignores `platform`; a 0.8 manifest reads as before. `checkManifest` warns
(`platform_dropped`) of a platform a reader drops and (`tracking`) of a door that carries tracking. `doorPlatformOf`,
`doorPlatformFit`, `doorPlace`, `doorTrackingParams` and `cleanDoorUrl` are exported, zod-free, so the owner app
uses the same rules as the server. The vectors are in `vectors/doors-elsewhere.json` (`cases`, `detect`, `clean`).

The spec's own examples no longer default to one country: the time zone example names three continents and the
money example no longer says euros.

### 4. The business's own page: what a write accepts

- **A platform's page** is on one of its hosts and past the platform's own pages (`https://www.fresha.com/` is
  refused, `https://www.fresha.com/a/…` is taken).
- **A shop's own checkout** on an `own_site` platform is on the business's own domain or a name under it, or on the
  platform's own host for the business (`*.myshopify.com`). The write is checked against the business's domain when it
  has one, so a stranger's shop is never named as this business's checkout.
- **No tracking or affiliate parameters** (`tracking_params`: `utm_*`, `gclid`, `fbclid`, `ref`, `aff_id`…). The write
  refuses them; the owner app takes them off as the link is pasted; a setup plan's door is cleaned, never refused.
- **Another page** is any https page on a public host, as before.

The owner in person, or a key with `settings:write`, sets it; the owner's AI never does (`settings/guard.ts`, as
since 0.3.1): a customer's message must not get the owner's AI to send people somewhere else.

### 5. Named everywhere, the same way

The platform the owner picked, or else the platform a page is plainly on (a Fresha page saved as Another page still
says Fresha), is published in the manifest, in the business profile (`GET /v1/business`, MCP
`get_business_profile`), and in the refusal a customer's booking or order of that kind gets
(`details.platform`, `details.place`; "This business takes bookings at Fresha (https://…), not here"). The business's
own page says **Book at Fresha** / **Order at Toast**; a page on the business's own website is named by its host
(`Order at shop.example.co.ke`), never by the platform behind it. Never a platform for a page on the business's own
website that the owner did not name.

### 6. The owner's way: Settings → General → What agents can do

Under the three switches, one line per kind sent elsewhere ("Bookings at **Fresha** · fresha.com/a/… · Change · Bring
back here") and a quiet **Booked or ordered somewhere else?** The editor is two fields: where (a chooser grouped as the
vocabulary groups it, the likeliest first, **Another page** last) and the link, which starts from what the inbox
already knows: the link saved, else the page a network found for this business on that platform (the last signed
ping's `doors` block, by `platform:<id>` or by host), else the business's own website for a shop's own checkout. A
link pasted from a platform picks it. What is wrong with a link is said before saving, in the owner's words.

### 7. A setup plan

A plan's `doors_elsewhere` entry may name `platform`. It is kept only when the page is on it; otherwise the
platform the page is plainly on is named, or none. Tracking is taken off.

## Consequences

- Agents and people read "Book at Fresha" wherever an inbox from this release names a door elsewhere; older readers
  see the URL as before.
- A network learns the token from the manifest. What a network does with it (§4.17 `elsewhere`, a listing's doors,
  the census) is the network's to build; the follow-up is written in this change's pull request.
- The list grows by a change to the vocabulary, which raises its version. A host that turns out wrong costs a label,
  never a door: the owner picks Another page.
- The business's own page speaks the languages its copy has today; "Book at …" follows them.

## Sources

Hosts and page shapes were read from each platform's own public pages, the `source` of each entry, among them:
Phorest, where a salon finds its link
(https://phorest.helpjuice.com/44083-online-booking-GB/370324-where-can-i-get-my-online-bookings-link-url); Timely
(https://help.gettimely.com/hc/en-gb/articles/1500002156921); Toast
(https://support.toasttab.com/en/article/How-do-my-customers-order-online-through-Toast-1493067051465); SiteMinder
(https://help-classic.siteminder.com/en/articles/8673807-booking-engine-integrate-the-booking-engine-with-your-website-using-links-and-widgets);
SimplyBook.me's own domains (https://help.simplybook.me/wiki/Custom_Domain_custom_feature); Setmore
(https://intercom.help/setmorehelp/en/articles/491016-add-the-book-now-button-to-your-website); Wix Bookings
(https://support.wix.com/en/article/adi-accessing-your-wix-bookings-pages); GloriaFood, which no longer takes new
sign-ups and is kept for the restaurants that use it (https://www.gloriafood.com/).
