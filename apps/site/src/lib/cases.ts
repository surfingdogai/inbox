/**
 * One example per kind of business, on the /inbox page and each on its own page at /inbox/for/<slug>/:
 * what reaches the owner, and what the inbox does with the system that business already runs.
 * Examples, said as examples: no business is named, nobody is quoted, nothing is counted. Every
 * sentence is what the inbox does today, as its docs (`doc`) and its connectors say; every system is
 * one it connects to today (src/lib/integrations.ts). test/integrations.node.test.ts holds them to
 * both. A name whose owner asks for a mark on its first use carries it where the page first says it
 * (WooCommerce®, in the label).
 */
import { type Integration, integration } from "./integrations";

export interface Case {
  readonly slug: string;
  /** The example, as the /inbox page heads it: a kind of business and the system it runs on. */
  readonly label: string;
  /** The kind of business, for its page: "Restaurants and cafés". */
  readonly kind: string;
  /** The system the example runs on, from src/lib/integrations.ts. */
  readonly system: string;
  /** What reaches the owner. */
  readonly arrives: string;
  /** What the inbox does with it, in that system, in one sentence: the /inbox page's. */
  readonly short: string;
  /** What the inbox does with it, in full: its own page's. */
  readonly does: string;
  /** Its own page. */
  readonly title: string;
  readonly description: string;
  readonly lede: string;
  /** What the inbox does for this kind of business, a line each, from `doc`. */
  readonly points: readonly string[];
  /** Everything it works with for this kind of business, from src/lib/integrations.ts. */
  readonly works: readonly string[];
  /** The docs page these come from. */
  readonly doc: { readonly label: string; readonly href: string };
}

export const CASES: readonly Case[] = [
  {
    slug: "restaurants",
    label: "A café on Flipdish",
    kind: "Restaurants and cafés",
    system: "flipdish",
    arrives: "A customer's assistant orders two flat whites, one with oat milk, and a croissant to collect at 8:20.",
    short:
      "The inbox offers only times your kitchen can make, from the menu you brought in from Flipdish, paid on your own link.",
    does: "The inbox offers only times your kitchen can make, from the menu you brought in from Flipdish, and the order is paid on your own payment link. Busy? Pause, and your Flipdish store can close too.",
    title: "AI orders for restaurants and cafés · Surfing Dog",
    description:
      "Take orders from your customers' AI assistants, at times your kitchen can make, paid on your own link. Works with GloriaFood, Flipdish, Stripe and Mollie.",
    lede: "Customers' assistants can read your menu, pick a time your kitchen can make, and order. The order comes to your own inbox, at your own address, and the money to your own payment account.",
    points: [
      "Your menu, with its options and what each adds. Start from the menu in GloriaFood or Flipdish, then keep the dishes you want.",
      "Allergens are never guessed. Only you or your staff confirm them; until then, assistants tell people to ask you.",
      "Slots inside your opening hours, with how many orders each takes. A slot is never sold twice.",
      "Collection, delivery zones with their own fees, or eating in.",
      "Pause for 15, 30 or 60 minutes when the kitchen is full, from your phone too.",
      "Nobody takes a share of an order. You are paid on your own Stripe or Mollie link, tips included.",
    ],
    works: ["gloriafood", "flipdish", "stripe", "mollie"],
    doc: { label: "Restaurants, bakeries and cafés", href: "/docs/ordering/" },
  },
  {
    slug: "salons",
    label: "A barber on Calendly",
    kind: "Salons and barbers",
    system: "calendly",
    arrives: "A customer's assistant asks for a cut and beard trim on Saturday morning.",
    short:
      "Times booked on Calendly, or busy in a calendar it checks, are not offered; on paid plans, confirmed bookings can be held there.",
    does: "Times booked on Calendly, or busy in a calendar Calendly checks, are not offered. On Calendly's Standard plan and above, a booking you or your rule confirms is held on Calendly too, on a one-on-one event type of the same length, so nobody books that time there.",
    title: "AI bookings for salons and barbers · Surfing Dog",
    description:
      "Let your customers' AI assistants book a cut, a colour or a treatment, not at a time your calendar shows busy. Works with Calendly and Cal.com.",
    lede: "Customers' assistants can see your services and your free times, and book. The booking comes to your own inbox, and into iCloud Calendar, Cal.com or Calendly's paid plans when you keep one.",
    points: [
      "Your services, with how long each takes and its price. Agents book from these.",
      "Times your calendar shows busy are not offered.",
      "Bookings you confirm go into iCloud Calendar, Cal.com, or Calendly on its paid plans. A calendar's link, from Google Calendar or Outlook, blocks busy times only.",
      "Your rules answer the routine requests within the limits you set. You see what needs a person.",
      "Already take bookings on another site? Agents can send people there by name, and messages still come to your inbox.",
    ],
    works: ["calendly", "calcom", "google-calendar", "icloud", "outlook"],
    doc: { label: "Calendars", href: "/docs/calendars/" },
  },
  {
    slug: "guesthouses",
    label: "A guesthouse on Beds24",
    kind: "Guesthouses and small hotels",
    system: "beds24",
    arrives: "A guest's assistant asks for two nights for two people next month.",
    short:
      "The inbox quotes your Beds24 price for nights Beds24 shows free, and writes each stay there first, so no room sells twice.",
    does: "The inbox quotes your Beds24 price for nights Beds24 shows free, taxes in the total. Accepted, the stay goes into Beds24 first, marked deposit due, so the room is off sale on every channel; the deposit is paid on your own Stripe or Mollie link.",
    title: "AI bookings for guesthouses and small hotels · Surfing Dog",
    description:
      "Take stays from guests' AI assistants at your own rates and policy, written to your property system first. Works with Beds24, Hostaway, Stripe and Mollie.",
    lede: "Guests' assistants ask for dates, see your total and your cancellation policy, and book. Stays come to your own inbox, and deposits to your own payment account.",
    points: [
      "Rooms, plans, prices, taxes and fees, set once. Every tax and fee is in the total a guest sees.",
      "With Beds24 or Hostaway connected, a stay is written there first and checked, so a room is never sold twice.",
      "Deposits and balances on your own Stripe or Mollie link, or paid at the property.",
      "A calendar link from another booking site marks a night as likely taken, and asks you to look.",
      "Door codes and Wi-Fi go only to confirmed guests, two days before they arrive unless you choose otherwise.",
    ],
    works: ["beds24", "hostaway", "stripe", "mollie"],
    doc: { label: "A place to stay", href: "/docs/stays/" },
  },
  {
    slug: "shops",
    label: "A shop on WooCommerce®",
    kind: "Shops",
    system: "woocommerce",
    arrives: "A customer's assistant asks whether a jacket is in stock in medium, and orders one.",
    short:
      "The inbox answers from your WooCommerce products and stock; an order you accept goes in as pending, paid at your own checkout.",
    does: "The inbox answers from the products and stock it reads from WooCommerce. The order you accept goes into WooCommerce as pending, and your customer pays at your shop's own checkout.",
    title: "AI orders for your online shop · Surfing Dog",
    description:
      "Let customers' AI assistants ask about products and stock, and order, paid at your own checkout. Works with WooCommerce®, Shopify, Square, Stripe and Mollie.",
    lede: "Customers' assistants can ask what you sell, whether it is in stock, and order. Orders come to your own inbox, and the money to your own checkout or payment account.",
    points: [
      "Products and stock read from your WooCommerce shop, and kept up to date within minutes.",
      "Orders you accept go into WooCommerce as pending, paid at your own checkout. Nobody pays more than they accepted.",
      "On Shopify or Square, products come in the same way, and an order you accept is paid at your Shopify or Square checkout.",
      "On another platform? Your catalogue can come from the product feed your shop already publishes for Google, paid on your own Stripe or Mollie link.",
      "Questions and requests for a price land in the same inbox.",
    ],
    works: ["woocommerce", "shopify", "square", "stripe", "mollie"],
    doc: { label: "WooCommerce", href: "/docs/connectors/woocommerce/" },
  },
  {
    slug: "trades",
    label: "A plumber on ServiceM8",
    kind: "Plumbers and trades",
    system: "servicem8",
    arrives:
      "A customer's assistant asks for a price: a leak under the sink, the postal code, when suits, and three photos.",
    short:
      "The inbox checks the postal code is in your area; once you quote it, it is a ServiceM8 job, with its photos.",
    does: "The inbox checks the postal code is in your area and puts an emergency first. Once you quote it, it is a ServiceM8 job in Quote status, with the photos.",
    title: "AI quote requests for plumbers and trades · Surfing Dog",
    description:
      "Get quote requests from your customers' AI assistants with the job, the place, when suits and photos, and send the ones you take on to ServiceM8.",
    lede: "Customers' assistants can describe the job, say where and when, and send photos. The request comes to your own inbox, ready to price.",
    points: [
      "Where you work, by postal code or by distance. A request from outside is yours to decide, or declined.",
      "Up to six photos or plans on a request. Where a photo was taken is removed on arrival.",
      "Quotes in stages: a deposit now, a stage by a date, the rest on site.",
      "Site visits booked beside the request they are for, and confirmed by you.",
      "Requests you take on go into ServiceM8 once, with their photos.",
    ],
    works: ["servicem8"],
    doc: { label: "Trades and projects", href: "/docs/trades/" },
  },
];

/** The systems a case's page lists, in its order. */
export const worksWith = (c: Case): readonly Integration[] => c.works.map(integration);

export const caseHref = (c: Case) => `/inbox/for/${c.slug}/`;
