## What an assistant needs

An assistant compares before it books or buys. If your prices live in a photo of a menu, or your hours in a sentence on the contact page, it may skip you, or get them wrong. It reads data more reliably than prose:

- **Who and where**: your name, address and opening hours, as `LocalBusiness` markup with the most specific type that fits (`Restaurant`, `HairSalon`, `Dentist`, `Store` and so on), and `openingHoursSpecification` for the hours.
- **What you offer, and for how much**: each product, service or menu item with an `Offer` that has a price and a currency, on pages linked from your homepage.
- **Your terms**: cancellation, deposit, no-show and returns, in plain words next to the button that books or buys and on a policy page your pages link to, with `MerchantReturnPolicy` markup for returns.
- **How payment works**: `paymentAccepted` in your business markup (more in [payments](/guides/ai-assistant-payments/)).

We read your homepage and up to three more of your own pages about what you offer, so link your services, menu or products from the homepage.

<h2 id="kind">Your kind of business</h2>

The score weighs what matters for your kind of business: a salon on bookings, a shop on orders, a trade on quotes. We tell your kind from the most specific type in your own markup, or from the category you give when you claim your listing. A live checkout for agents, or three or more priced products in your markup, makes a site a shop.

Without any of these we score a business of unknown kind, as most sites are today, and count booking, ordering and signing up there as one. To be scored for what you are, add the most specific `LocalBusiness` or `Organization` type to your homepage's markup, or [claim your listing](/bot) and give your category.

## What counts in the check

- **Who and where**: `LocalBusiness` markup with your name, address and `openingHoursSpecification`. Selling online counts in place of an address (a UCP, ACP or Shopify checkout, shipping, a basket). A `get_business_profile` tool counts too.
- **Catalogue**: schema.org `Product`, `Service`, `Menu` or `MenuItem` with an `Offer` price and currency on pages we read, a UCP catalogue, or a tool such as `list_services`, `list_products` or `search_catalog`. Items without prices, or prices on your pages but not as data, count as partly.
- **Policies**: `MerchantReturnPolicy` markup, a policy page linked from your pages that states its terms ("free cancellation up to 24 hours before"), or a `get_policies` tool. A linked page that states no terms counts as partly.
- **Free times or stock**: `availability` on your offers counts as partly; a tool such as `check_availability` or `check_stock` counts in full (see [bookings](/guides/ai-assistant-bookings/)).

Which of these count depends on your kind of business: a shop is scored on its catalogue, and a plumber isn't.
