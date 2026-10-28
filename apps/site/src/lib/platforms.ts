import type { Faq, Source } from "./faq";
import { APPLE_NOTICE, WOO_NOTICE } from "./integrations";

/**
 * One page for each platform the inbox works with today, at /integrations/<slug>/ (src/pages/
 * integrations/[slug].astro): what a customer's AI assistant can do with a business on that platform
 * through its inbox, what stays on the platform and in the owner's own payment account, what the
 * platform's own AI does and how the inbox sits beside it, how to connect it, and the questions owners
 * ask. Every sentence about the inbox is what its connector and its doc say (`ids`, `doc`); every
 * sentence about the platform's own products says where we read it, and when. Nothing for a platform
 * that is still coming: those are rows of /integrations, no more. test/platforms.node.test.ts holds
 * each page to its connector's status and to its doc.
 *
 * WooCommerce® carries its mark on its first use on a page, with Automattic's notice; iCloud Calendar,
 * Apple's credit. Brand names are text, never a logo, and none implies the owner endorses us. A question
 * a topic guide answers (Google AI Mode and rooms, the merchant of record, selling on ChatGPT) is asked
 * there alone: a page links that guide rather than asking it again.
 */

/** When what each platform does with AI was read from its own pages. */
export const PLATFORMS_CHECKED = "October 2026";
export const PLATFORMS_AS_OF = "as of October 2026";

/** A thing a platform does itself, and where we read it. */
export interface PlatformFact {
  /** Plain text; [words](/path or https://…) as a link. */
  readonly text: string;
  readonly sources: readonly Source[];
}

export interface Platform {
  readonly slug: string;
  /** The platform's name, as its owner writes it, with its mark where it asks for one. */
  readonly name: string;
  /** The entries of src/lib/integrations.ts this page is for. */
  readonly ids: readonly string[];
  /** Its title, before " · Surfing Dog": what an owner searches for. */
  readonly title: string;
  /** Its heading. */
  readonly heading: string;
  readonly description: string;
  /** The answer at the top, at most 50 words. */
  readonly answer: string;
  /** What a customer's assistant can do with the business through its inbox. */
  readonly can: readonly string[];
  /** What stays on the platform and in the owner's own account. */
  readonly stays: { readonly heading: string; readonly points: readonly string[] };
  /** The platform's own AI, and the inbox beside it. */
  readonly theirs: { readonly heading: string; readonly facts: readonly PlatformFact[]; readonly beside: string };
  /** How to connect it, in a sentence or two, and its doc. */
  readonly connect: { readonly text: string; readonly doc: { readonly label: string; readonly href: string } };
  readonly faqs: readonly Faq[];
  /** Other platform pages, by slug. */
  readonly related: readonly string[];
  /** The guides that answer the wider questions a page's owners ask. */
  readonly guides: readonly { readonly label: string; readonly href: string }[];
  /** The check box's title. */
  readonly check: string;
}

const src = (label: string, href: string): Source => ({ label, href });

const SHOPIFY_HELP = "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts";
const S = {
  shopifyStorefronts: src("Shopify Help Center: agentic storefronts", SHOPIFY_HELP),
  shopifyChatgpt: src("Shopify Help Center: ChatGPT", `${SHOPIFY_HELP}/chatgpt`),
  shopifyGoogle: src("Shopify Help Center: Google AI Mode and Gemini", `${SHOPIFY_HELP}/google`),
  shopifyMeta: src("Shopify Help Center: Meta", `${SHOPIFY_HELP}/meta`),
  shopifyMicrosoft: src("Shopify Help Center: Microsoft Copilot", `${SHOPIFY_HELP}/microsoft`),
  shopifyInbox: src("Shopify Help Center: Inbox agent", "https://help.shopify.com/en/manual/inbox/ai"),
  shopifyUcp: src("Shopify.dev: UCP", "https://shopify.dev/docs/ucp"),
  woo: src("WooCommerce: agentic commerce", "https://woocommerce.com/agentic-commerce/"),
  square: src(
    "Square: ChatGPT and Claude integrations, 1 July 2026",
    "https://squareup.com/us/en/press/claude-chatgpt-integrations",
  ),
  squareMcp: src("Square Developer: MCP server", "https://developer.squareup.com/docs/mcp"),
  calendly: src("Calendly: MCP server", "https://calendly.com/blog/mcp-server"),
  hostaway: src("Hostaway: Hostaway AI", "https://www.hostaway.com/features/hostaway-ai/"),
  beds24: src("Beds24: marketplace", "https://beds24.com/en/marketplace"),
  googleHotels: src("Google for Developers: hotels and UCP", "https://developers.google.com/hotels/ucp"),
  gloriafood: src("GloriaFood: service update", "https://www.gloriafood.com/"),
  foodamigos: src("FoodAmigos for GloriaFood customers", "https://gloriafood.foodamigos.io/"),
  flipdish: src("Flipdish: AI Phone Agent", "https://www.flipdish.com/ai-phone-agent"),
  flipdishBlog: src(
    "Flipdish: introducing the AI Phone Agent",
    "https://www.flipdish.com/resources/blog/introducing-flipdish-ai-phone-agent-for-restaurants",
  ),
  servicem8Phone: src(
    "ServiceM8 Help Center: the ServiceM8 Phone Agent",
    "https://support.servicem8.com/help-center/servicem8-add-ons/servicem8-phone-agent/introducing-the-servicem8-phone-agent",
  ),
  servicem8Mcp: src("ServiceM8 Developer: MCP server", "https://developer.servicem8.com/docs/mcp-server"),
  servicem8Connect: src(
    "ServiceM8 Help Center: connect ServiceM8 to ChatGPT or Claude",
    "https://support.servicem8.com/help-center/tips-trick-more/more/how-to-connect-servicem8-to-chatgpt-with-mcp",
  ),
  stripeRetail: src(
    "Stripe Docs: agentic commerce for retail",
    "https://docs.stripe.com/agentic-commerce/sellers/use-cases/retail",
  ),
  stripeBooking: src(
    "Stripe Docs: agentic commerce for service bookings",
    "https://docs.stripe.com/agentic-commerce/sellers/use-cases/booking",
  ),
  mollieAcp: src(
    "Mollie: agentic commerce in Europe, 19 November 2025",
    "https://www.mollie.com/news/agentic-commerce-mollie-europe",
  ),
  mollieMcp: src("Mollie: an MCP server, July 2025", "https://www.mollie.com/news/mollie-launches-ai-ready-mcp-server"),
} satisfies Record<string, Source>;

/** The guides a page links, by what they answer. */
const G = {
  commerce: { label: "Agentic commerce explained", href: "/guides/agentic-commerce/" },
  chatgpt: { label: "How to sell on ChatGPT", href: "/guides/sell-on-chatgpt/" },
  hotels: { label: "AI hotel booking", href: "/guides/ai-hotel-booking/" },
  shopify: { label: "Shopify and AI assistants", href: "/guides/shopify-ai-assistants/" },
  bookings: { label: "Let AI assistants book with your business", href: "/guides/ai-assistant-bookings/" },
  payments: { label: "How AI assistants pay", href: "/guides/ai-assistant-payments/" },
  quotes: {
    label: "Let AI assistants message you or ask for a quote",
    href: "/guides/ai-assistant-messages-and-quotes/",
  },
} as const;

export const PLATFORMS: readonly Platform[] = [
  {
    slug: "shopify",
    name: "Shopify",
    ids: ["shopify"],
    title: "Shopify and AI agents: quotes, questions and orders",
    heading: "Shopify and AI agents: questions, quotes and orders from customers' assistants",
    description:
      "Customers' AI assistants ask your Shopify store questions and request quotes; an accepted quote becomes a draft order, paid at your own Shopify checkout.",
    answer:
      "For eligible stores, Shopify already shares your products with ChatGPT, Gemini, Copilot and Meta, and runs the checkout. The inbox adds the rest: customers' assistants ask questions and request quotes at your own address, and an accepted quote or order becomes a draft order, paid at your Shopify checkout.",
    can: [
      "Ask about a product, its stock or your terms, from the products the inbox reads from Shopify every few minutes. You answer, or your rules do.",
      "Ask for a quote: a bulk order, a trade price, something made to order. Once your customer accepts your price, it becomes a draft order in your shop, at that price.",
      "Order a product you list, which you accept like any order. The draft order's own checkout is the link to pay.",
      "Be sent to your Shopify checkout to buy a cart, once you name it as where orders go ([Booked or ordered elsewhere](/docs/connectors/elsewhere/)).",
      "Follow the order as Shopify moves it: paid, fulfilled with its tracking, delivered, refunded.",
    ],
    stays: {
      heading: "What stays on Shopify, and in your own account",
      points: [
        "The checkout, your payment methods and the money: your customer pays on Shopify, to you. No card details, no fee, no share.",
        "Refunds, made in Shopify.",
        "Your customers, and every order the inbox did not make. It keeps the ids of the orders made from its own drafts, nothing else.",
        "Your products: read, never changed. It writes draft orders, tagged inbox, and its own webhooks, and Shopify sends no invoice email of its own for those orders: your customer hears from you once.",
      ],
    },
    theirs: {
      heading: "Shopify Inbox and an inbox for agents: the difference",
      facts: [
        {
          text: "Agentic storefronts are on by default for eligible stores: Shopify Catalog shares your products with ChatGPT, Google AI Mode and Gemini, Microsoft Copilot and Meta, and you manage each in Sales channels › Agentic.",
          sources: [S.shopifyStorefronts],
        },
        {
          text: "Checkout inside the chat depends on where buyers are: Google AI Mode and Gemini for the US, Canada and Australia, rolling out gradually; Meta for the US, Canada, Mexico, Brazil, Japan and Singapore; Copilot for the US. ChatGPT sends buyers to your own checkout, for stores that sell to the US.",
          sources: [S.shopifyGoogle, S.shopifyMeta, S.shopifyMicrosoft, S.shopifyChatgpt],
        },
        {
          text: "Shopify Inbox is Shopify's chat for shoppers on your storefront. Its Inbox agent, which you opt into, answers them from your catalogue, your policies and your knowledge base.",
          sources: [S.shopifyInbox],
        },
      ],
      beside:
        "Surfing Dog Inbox is for other people's AI assistants: it takes their questions, quote requests and orders at your own address, in your name, and sends them to your Shopify checkout to buy. What ChatGPT does with your store: [how to sell on ChatGPT](/guides/sell-on-chatgpt/); what Shopify publishes for agents: [Shopify and AI assistants](/guides/shopify-ai-assistants/).",
    },
    connect: {
      text: "Make a small app for your own shop in Shopify's Dev Dashboard, with three scopes (`read_products`, `read_orders`, `write_draft_orders`), and paste its Client ID and secret in Settings › Integrations › Shopify. Nobody else's app stands between your shop and your inbox.",
      doc: { label: "Connect Shopify, step by step", href: "/docs/connectors/shopify/" },
    },
    faqs: [
      {
        q: "Does ChatGPT work with Shopify?",
        a: "Yes, for stores that sell to the US: ChatGPT finds your products through Shopify Catalog and sends the buyer to your own checkout. A question or a quote request from a customer's assistant needs a door of its own, which the inbox gives you at your own address.",
      },
      {
        q: "Is Shopify Inbox's AI agent the same thing?",
        a: "No. Shopify Inbox's Inbox agent answers shoppers chatting on your storefront. Surfing Dog Inbox is where other people's AI assistants ask questions, request quotes and order, at your own address; buying a cart still happens at your Shopify checkout.",
      },
      {
        q: "Can an AI agent ask for a quote on Shopify?",
        a: "Through the inbox, yes. The request comes to you, you answer with a price, and once your customer accepts it, it becomes a draft order in your shop at that price, with a link to pay at your Shopify checkout.",
      },
      {
        q: "Does Shopify have an MCP server?",
        a: "Yes. Shopify serves a Universal Commerce Protocol (UCP) profile and an MCP server on an eligible store's own domain, for searching the catalogue, building a cart and checking out, and another for searching its policies. Neither sends a question or a quote request to you: that is what the inbox adds beside them.",
      },
      {
        q: "How do I turn off agentic storefronts in Shopify?",
        a: "In your Shopify admin, under Sales channels, Agentic, each channel can be switched off. Shopify says turning off Catalog access can take up to seven days to stop sharing your products.",
      },
    ],
    related: ["woocommerce", "square", "stripe"],
    guides: [G.shopify, G.chatgpt, G.commerce],
    check: "Check your store",
  },
  {
    slug: "woocommerce",
    name: "WooCommerce®",
    ids: ["woocommerce"],
    title: "Inbox for WooCommerce®: AI agents, quotes and orders",
    heading: "An inbox for WooCommerce®: questions, quotes and orders from customers' AI agents",
    description:
      "Customers' AI assistants ask about your WooCommerce® products and stock, request quotes and order; accepted orders go in pending, paid at your own checkout.",
    answer:
      "WooCommerce's own MCP is in beta, and UCP and ACP are coming. The inbox works with your shop today: customers' assistants ask about products and stock and request quotes at your own address, and an order you accept goes into WooCommerce as pending, paid at your shop's own checkout.",
    can: [
      "Ask whether something is in stock, in a size or a colour: products, variations and stock are read from your shop within minutes.",
      "Ask for a quote instead of checking out: a bulk order, a trade price. Once your customer accepts your price, the order goes into WooCommerce at that price; a line your shop has no product for goes in as a fee line.",
      "Order, which you accept. The order goes in as **pending**, and your customer pays with its own link at your shop's checkout.",
      "Follow it: paid when WooCommerce says so, fulfilled when you complete it, refunded when you refund it there.",
    ],
    stays: {
      heading: "What stays in WooCommerce, and in your own account",
      points: [
        "Your checkout, your payment methods and the money. The inbox never sees a card and never adds a fee.",
        "Orders your shop takes at its own checkout, your customers' accounts, your prices, your stock and your settings: never written.",
        "Refunds, made in WooCommerce; one you make there marks the refund your inbox owes as done.",
        "Tax: if your shop adds it at checkout, each order's total comes to you first, and your customer accepts the shop's total or not. Nobody pays more than they accepted.",
      ],
    },
    theirs: {
      heading: "WooCommerce's own agentic commerce, and the inbox beside it",
      facts: [
        {
          text: "WooCommerce lists MCP as Beta, from WooCommerce 10.9, built on WordPress's Abilities API: AI assistants can read your store's products and orders.",
          sources: [S.woo],
        },
        {
          text: "The Universal Commerce Protocol (UCP), with Google, and the Agentic Commerce Protocol (ACP), through Stripe's Agentic Commerce Suite, are both listed as coming soon, and agentic checkout is coming to Stripe for WooCommerce.",
          sources: [S.woo],
        },
      ],
      beside:
        "The inbox doesn't wait for them, and doesn't replace them: it is a door at your own address for customers' assistants to ask, get a quote and order, with your WooCommerce checkout taking the money.",
    },
    connect: {
      text: "Press **Connect your shop** in Settings › Integrations › WooCommerce, then **Approve** on WooCommerce's own page in your WordPress admin. WooCommerce sends your inbox a key of its own; you never copy one.",
      doc: { label: "Connect WooCommerce, step by step", href: "/docs/connectors/woocommerce/" },
    },
    faqs: [
      {
        q: "Can ChatGPT shop my WooCommerce store?",
        a: "Through your inbox, a customer's ChatGPT with a connector to it can ask about your products and stock, request a quote and order, and the order is paid at your own checkout. WooCommerce lists its own UCP and ACP support as coming soon.",
      },
      {
        q: "Does WooCommerce have an MCP server?",
        a: "WooCommerce lists MCP as Beta, from WooCommerce 10.9, built on WordPress's Abilities API, for AI assistants to read your store's products and orders. The inbox is a separate door, for customers' assistants to ask, request quotes and order.",
      },
      {
        q: "Can customers' AIs ask for a quote instead of checking out?",
        a: "Yes. The request comes to your inbox, you answer with a price, and once the customer accepts it the order goes into WooCommerce as pending at that price, with a link to pay at your checkout.",
      },
      {
        q: "Will my customer get two order emails?",
        a: "With the WordPress plugin, WooCommerce's own processing and completed emails stay quiet for orders your inbox made, since the inbox sends its own receipt. Without the plugin, your customer may get both.",
      },
    ],
    related: ["shopify", "square", "stripe"],
    guides: [G.commerce, G.chatgpt, G.quotes],
    check: "Check your shop",
  },
  {
    slug: "square",
    name: "Square",
    ids: ["square"],
    title: "Square and AI agents: bookings, quotes and orders",
    heading: "Square and customers' AI agents: bookings, quotes and orders",
    description:
      "Customers' AI assistants book times Square shows free, ask questions and order your Square items, paid at your own Square checkout. Bookings go into Square.",
    answer:
      "Square's ChatGPT app and Claude plugin take orders for US food and beverage sellers on Square Online Ordering. The inbox works for appointments and retail too: customers' assistants book times Square shows free, ask questions and request quotes, and order your items, paid at your own Square checkout.",
    can: [
      "See the times Square would book, with closed hours, time off and booked team members taken off, and ask for one. A booking you confirm goes into Square, with whoever is free or the team member you chose; moved or cancelled here, it moves or goes there too.",
      "Order your items, priced and counted at your location: a pickup at its time, or a shipment. The order gets its own link to pay at Square's checkout.",
      "Ask a question or request a quote, in the same inbox.",
      "Follow the order: ready, picked up, shipped with its tracking, refunded.",
    ],
    stays: {
      heading: "What stays in Square, and in your own account",
      points: [
        "Square's checkout and the money, paid into your Square account. Refunds are made in Square. No card details, no app fee, no share.",
        "Your Square customers, and every order or booking the inbox did not make: never kept.",
        "Square messages the customer of every booking an app makes, so the inbox files each one under your customer's name and your location's own phone, with no email: Square's messages reach you, and your customer hears from you.",
      ],
    },
    theirs: {
      heading: "Square's own AI, and the inbox beside it",
      facts: [
        {
          text: "Since 1 July 2026, US food and beverage sellers with an activated Square Online Ordering profile take orders through a ChatGPT app and a Claude plugin, paid with Order by Cash App. Eligible sellers are opted in, with no added commission.",
          sources: [S.square],
        },
        {
          text: "Square is co-developing the Universal Commerce Protocol (UCP) for food ordering with Google, to roll out globally over time.",
          sources: [S.square],
        },
        {
          text: "Square's MCP server, in beta, lets an AI you connect work with your own Square account, with the access you grant it.",
          sources: [S.squareMcp],
        },
      ],
      beside:
        "The inbox covers what those don't: bookings on Square Appointments, retail items, questions and quotes, from any customer's assistant that reaches your inbox. How products get into ChatGPT, and where its shoppers pay: [how to sell on ChatGPT](/guides/sell-on-chatgpt/).",
    },
    connect: {
      text: "**Sign in with Square** where it is offered; on a hosted inbox it says Soon. Until then, make a small app in the Square Developer Console and paste its production access token. Bookings from a token need Appointments Plus or Premium.",
      doc: { label: "Connect Square, step by step", href: "/docs/connectors/square/" },
    },
    faqs: [
      {
        q: "Can customers order from my Square restaurant in ChatGPT?",
        a: "Square says US food and beverage sellers with an activated Square Online Ordering profile are opted in to its ChatGPT app and Claude plugin. Elsewhere, or for appointments and retail, the inbox takes customers' assistants' requests and sends orders to your Square checkout.",
      },
      {
        q: "Does Square have an MCP server?",
        a: "Yes, in beta: it lets an AI you connect work with your own Square account, with the access you grant. Customers' assistants need a door of their own to book or order with you, which the inbox gives you at your own address.",
      },
      {
        q: "Does this work with Square Appointments?",
        a: "Yes. Busy times come from Square, and a booking you confirm goes into Square. With an access token that needs Appointments Plus or Premium; on Appointments Free your busy times still come in and no bookings are added. Sign in with Square adds them on every plan.",
      },
      {
        q: "Does Square text my customers about these bookings?",
        a: "No. Square messages the customer of every booking an app makes, so the inbox files each booking under your customer's name and your location's own phone, with no email. Square's messages reach you, and your customer hears from you.",
      },
    ],
    related: ["shopify", "calendly", "stripe"],
    guides: [G.chatgpt, G.commerce, G.bookings],
    check: "Check your website",
  },
  {
    slug: "calendly",
    name: "Calendly",
    ids: ["calendly"],
    title: "Calendly and AI agents: let customers' assistants book",
    heading: "Calendly and AI agents: let customers' assistants book you",
    description:
      "Customers' AI assistants book through your own inbox, not at a time booked on Calendly; on Calendly's paid plans, each confirmed booking is held there too.",
    answer:
      "Calendly's MCP server works your own Calendly account. The inbox is the door for customers' assistants: times booked on Calendly, or busy in a calendar it checks, are not offered, and on Standard and above each booking you confirm is held on Calendly too.",
    can: [
      "See your services and your free times: your opening hours, less what Calendly says is busy, from your Calendly events and the calendars Calendly checks.",
      "Ask for a booking, which you, your rules or your own AI confirm.",
      "Move or cancel it later. On a paid plan Calendly follows: a new event, then the old one cancelled.",
      "Ask a question or request a quote first.",
    ],
    stays: {
      heading: "What stays on Calendly",
      points: [
        "Bookings made on Calendly stay there: they block their time in your inbox and don't become bookings in it.",
        "Your invitees' details: a webhook's ids are kept, never its body.",
        "Calendly emails whoever is booked, so the inbox makes the event in your name, with your customer's name on it: Calendly writes to you, and your customer hears from you.",
        "Payment for a booking: not through the inbox yet. Take it as you do today.",
      ],
    },
    theirs: {
      heading: "Calendly's own AI, and the inbox beside it",
      facts: [
        {
          text: "Calendly's MCP server, at mcp.calendly.com, works on any Calendly plan, the free one included, as a Calendly plugin for ChatGPT and a Calendly connector for Claude. Calendly's examples are about your own account: your availability, your scheduling links, your events.",
          sources: [S.calendly],
        },
      ],
      beside:
        "The inbox is the other side: a door at your own address for your customers' assistants, that knows what Calendly says is busy.",
    },
    connect: {
      text: "**Continue with Calendly** where it is offered; on a hosted inbox it is coming soon. Until then, a token from Calendly's Integrations & apps › API & webhooks, with six scopes. Then choose the event type bookings go to.",
      doc: { label: "Connect Calendly, step by step", href: "/docs/connectors/calendly/" },
    },
    faqs: [
      {
        q: "Can someone else's AI book a time on my Calendly?",
        a: "Through the inbox, yes: it books a time Calendly doesn't show as busy, and on Standard and above the booking is held on Calendly as an event. On Calendly's free plan the inbox reads your busy times only, so block its bookings in Calendly yourself.",
      },
      {
        q: "Does Calendly work with ChatGPT?",
        a: "Calendly's MCP server comes as a Calendly plugin for ChatGPT and a connector for Claude, for working your own account. For your customers' ChatGPT to book with you, it needs a door to your business, such as your inbox's MCP server.",
      },
      {
        q: "Does it need a paid Calendly plan?",
        a: "Busy times work on every plan. Holding bookings on Calendly needs Standard or above, since on Free Calendly lets other apps read but not book. Calendly also limits apps to 10 bookings a minute and 100 a day on a paid plan.",
      },
      {
        q: "Which event types can it use?",
        a: "One-on-one event types booked at once, with no required question and a place you set: an address, a video call or your phone. Group events, polls and event types that ask the customer where to meet are left out.",
      },
    ],
    related: ["calcom", "calendars", "square"],
    guides: [G.bookings],
    check: "Check your website",
  },
  {
    slug: "calcom",
    name: "Cal.com",
    ids: ["calcom"],
    title: "Cal.com and AI agents: bookings through your inbox",
    heading: "Cal.com and AI agents: customers' assistants book through your inbox",
    description:
      "Customers' AI assistants book the times your Cal.com leaves free, through your own inbox; each booking you confirm is created in Cal.com.",
    answer:
      "Connect Cal.com with an API key, and your Cal.com bookings and the calendars it checks take those times off what the inbox offers. Customers' assistants book the rest; each booking you confirm is created in Cal.com, and rescheduled or cancelled there when it changes.",
    can: [
      "See your services and the times Cal.com leaves free: your Cal.com bookings, and the calendars Cal.com checks for conflicts, are not offered. They are read every five minutes, about three months ahead.",
      "Ask for a booking, which you or your rules confirm; it is created on the event type as long as the booking, or the one you choose.",
      "Move or cancel it later: Cal.com reschedules or cancels it too.",
      "Ask a question first, in the same inbox the bookings come to.",
    ],
    stays: {
      heading: "What stays in Cal.com",
      points: [
        "Your event types, and the bookings made on Cal.com.",
        "Your customer's email: Cal.com is given their name and no email, so it sends them nothing. Your inbox has already told them.",
        "A time Cal.com won't take is said on the connection, in Cal.com's own words.",
        "Names on bookings already made: Cal.com can't change them, so a customer you erase keeps their name on the Cal.com bookings made before.",
      ],
    },
    theirs: {
      heading: "A Cal.com you run yourself",
      facts: [],
      beside:
        "Cal.com is open source. The inbox connects to one you run yourself as it does to Cal.com's own: give its API address under More options.",
    },
    connect: {
      text: "In Cal.com, Settings › Developer › API keys › New, with Never expires on. Paste it in Settings › Integrations › Cal.com; it is checked with Cal.com before anything is kept.",
      doc: { label: "Connect Cal.com", href: "/docs/calendars/#calcom" },
    },
    faqs: [
      {
        q: "Can a customer's AI book into my Cal.com?",
        a: "Through your inbox, yes. It sees the times Cal.com leaves free, asks for one, and once you or your rules confirm it, the booking is created in Cal.com on the event type of the same length, or the one you chose.",
      },
      {
        q: "Does it work with a Cal.com I host myself?",
        a: "Yes. Give its API address under More options when you connect, with an API key made in it.",
      },
      {
        q: "Which Cal.com event type does a booking go to?",
        a: "The one as long as the booking, unless you choose one. A booking that moves is rescheduled in Cal.com, and one that is cancelled is cancelled there. A time Cal.com refuses is said on the connection, in Cal.com's own words, so you can fix it there.",
      },
      {
        q: "Will my customer get two confirmations?",
        a: "No. Cal.com is given your customer's name and no email, so it sends them nothing; the inbox has already told them. If Cal.com also adds bookings to a calendar you connected to the inbox, Settings offers to stop one of them, so each shows once.",
      },
    ],
    related: ["calendly", "calendars", "square"],
    guides: [G.bookings],
    check: "Check your website",
  },
  {
    slug: "calendars",
    name: "Calendars",
    ids: ["google-calendar", "icloud", "outlook"],
    title: "Google Calendar, iCloud and Outlook: AI bookings that keep to your calendar",
    heading: "AI bookings that keep to your calendar: Google Calendar, iCloud Calendar, Microsoft Outlook and CalDAV",
    description:
      "AI assistants are offered only times your calendar leaves free. iCloud Calendar and CalDAV calendars take the bookings; Google and Outlook links block times.",
    answer:
      "Your inbox offers times from your opening hours, less what your calendar says is busy, read every five minutes. iCloud Calendar, Fastmail, Nextcloud and any CalDAV calendar connect with an app password and take each booking you confirm; a Google or Outlook calendar's private link blocks busy times only.",
    can: [
      "See only times your calendar leaves free, about three months ahead. An event marked free, or cancelled, blocks nothing; an all-day event blocks the day only when it is marked busy.",
      "Ask for one, which you or your rules confirm. In a CalDAV calendar such as iCloud Calendar it is written within seconds, moved when it moves and taken off when it is cancelled.",
      "Find a class or a group session closed while you are busy: a busy time blocks all of a service's places, since it means you are busy.",
    ],
    stays: {
      heading: "What stays in your calendar",
      points: [
        "Your events: busy times are read, and the inbox writes nothing but the bookings it confirms. Disconnected, those stay as your own entries.",
        "What your events are: Google's permission for busy times sees times only.",
        "App passwords, links and tokens are sealed when stored, and never shown again, to you or to your AI.",
      ],
    },
    theirs: {
      heading: "Signing in with Google",
      facts: [],
      beside:
        "**Continue with Google** reads busy times and writes bookings into your main calendar. On a hosted inbox it says Soon until Google has checked our sign-in; on your own server it works with a Google client of your own, and for your own Google Workspace an Internal app needs no check by Google. Until then, a Google calendar's secret address blocks its busy times. Outlook connects by its published link.",
    },
    connect: {
      text: "iCloud: an app-specific password from your Apple Account, which needs two-factor authentication. Fastmail and Nextcloud: an app password. Google or Outlook: the calendar's secret link that ends in .ics.",
      doc: { label: "Connect a calendar, step by step", href: "/docs/calendars/" },
    },
    faqs: [
      {
        q: "Does it work with Google Calendar?",
        a: "Yes. On every inbox today, through your calendar's secret address in iCal format: your busy times are not offered. Signing in with Google also writes bookings into your main calendar: on your own server with your own Google client, and on a hosted inbox once Google has checked our sign-in.",
      },
      {
        q: "Can an AI book into my iCloud Calendar?",
        a: "Yes. Connect iCloud with an app-specific password, and each booking you or your rules confirm is written into the calendar you choose, moved when it moves and removed when it is cancelled. Your Apple Account needs two-factor authentication.",
      },
      {
        q: "Does it work with Outlook?",
        a: "Through Outlook's published calendar link: your busy times are not offered to agents. Bookings are not written into Outlook yet.",
      },
      {
        q: "Is this Gmail's AI Inbox?",
        a: "No. Gmail's AI Inbox is Google's, inside Gmail, for your own email. Surfing Dog Inbox is a separate inbox at your own address, where customers' AI assistants send bookings, orders, quote requests and messages; it can read your Google Calendar's busy times.",
      },
    ],
    related: ["calendly", "calcom", "square"],
    guides: [G.bookings],
    check: "Check your website",
  },
  {
    slug: "beds24",
    name: "Beds24",
    ids: ["beds24"],
    title: "Beds24 and AI bookings: stays from guests' assistants",
    heading: "Beds24 and AI bookings: stays from guests' assistants, written to Beds24 first",
    description:
      "Guests' AI assistants ask for dates and book at your Beds24 price, for nights Beds24 shows free; each stay is written to Beds24 first, so no room sells twice.",
    answer:
      "Connect Beds24 with an invite code. Guests' assistants ask your inbox for dates and see your total; each stay is written to Beds24 before anything is promised, so the room is off sale on every channel, and deposits are paid on your own Stripe or Mollie link.",
    can: [
      "Ask for dates and guests, and see your Beds24 daily price for nights Beds24 shows free, with every tax and fee you set in the total.",
      "Book. The inbox checks the nights in Beds24, writes the booking, then reads it back; if another channel took the room in that moment, it cancels its own booking and nothing is promised.",
      "Pay a deposit on your own Stripe or Mollie link. Until then the stay sits in Beds24 as confirmed and flagged **Deposit due**, off sale on every channel; not paid in time, it is cancelled.",
      "Change the dates or cancel under your policy. A cancelled stay stays in Beds24, as cancelled.",
    ],
    stays: {
      heading: "What stays in Beds24, and in your own account",
      points: [
        "Your rooms, prices and the bookings from your other channels: the inbox never keeps those guests.",
        "The money: no card, no deposit and no commission is ever sent to Beds24. Deposits go to your own payment account, or are paid at the property.",
        "Beds24's 100 credits per five minutes, shared with your other apps; the inbox always keeps some for bookings.",
      ],
    },
    theirs: {
      heading: "AI in Beds24, and the inbox beside it",
      facts: [
        {
          text: "Beds24's marketplace lists AI apps by other companies, Besty AI, HostBuddy AI and BnB Genius among them.",
          sources: [S.beds24],
        },
      ],
      beside:
        "The inbox is something else: a door at your own address for guests' AI assistants, that asks Beds24 what is free and writes each stay there first. Whether Google AI Mode will book your rooms, and who stays the merchant of record: [AI hotel booking](/guides/ai-hotel-booking/).",
    },
    connect: {
      text: "In Beds24, Settings › Marketplace › API › **Generate invite code**, with read and write on bookings and read on inventory and properties. Paste it within 24 hours, then choose your property and match its rooms.",
      doc: { label: "Connect Beds24, step by step", href: "/docs/connectors/beds24/" },
    },
    faqs: [
      {
        q: "Can a guest's AI assistant book through Beds24?",
        a: "Yes, through your inbox: the assistant asks for dates, sees your Beds24 price and the total, and books; the stay goes into Beds24 first, then is read back. At first you confirm each request; once one stay has gone through, you can let free rooms confirm at once.",
      },
      {
        q: "Do guests pay my Beds24 price?",
        a: "Yes: the daily price in your Beds24 calendar, the whole room's for a night, with every tax and fee you set in your inbox in the total. A room priced per person, for fewer guests than it sleeps or only for some stays is on request: you confirm each one with its price.",
      },
      {
        q: "What if Beds24 also emails my guests?",
        a: "Your inbox already sends the confirmation. Check Beds24's automatic emails, so guests get one confirmation, not two.",
      },
    ],
    related: ["hostaway", "stripe", "mollie"],
    guides: [G.hotels, G.bookings],
    check: "Check your website",
  },
  {
    slug: "hostaway",
    name: "Hostaway",
    ids: ["hostaway"],
    title: "Hostaway and AI bookings: direct stays from guests' AI",
    heading: "Hostaway and AI bookings: direct stays from guests' assistants",
    description:
      "Guests' AI assistants book free nights at your Hostaway price through your own inbox; each booking goes into Hostaway first, as a direct reservation.",
    answer:
      "Hostaway's own AI answers guests and helps run your operations. The inbox takes bookings from guests' assistants: it reads free nights from Hostaway, puts every booking into Hostaway first as a direct reservation, and never takes a card, sets a price or charges a commission.",
    can: [
      "Ask for dates and see your Hostaway nightly price for free nights, less any weekly or monthly discount Hostaway gives.",
      "Book. Each room is a reservation on Hostaway's direct channel, with Surfing Dog Inbox as its source; the nights are checked in Hostaway just before and right after.",
      "Book several rooms at once: one reservation per room, written whole or not at all.",
      "Change the dates, written into Hostaway before they change here, or cancel.",
    ],
    stays: {
      heading: "What stays in Hostaway, and in your own account",
      points: [
        "Your listings, calendars and reservations, and guest messages.",
        "The money: the guest pays you, at your price. Never a card, a payment, a fee line or a commission written to Hostaway.",
        "Hostaway's own automations for direct bookings: look at its messages and payment rules for the direct channel, so a guest is never asked to pay twice.",
      ],
    },
    theirs: {
      heading: "Hostaway's own AI, and the inbox beside it",
      facts: [
        {
          text: "Hostaway AI covers AI Replies, Auto-Reply, AI CoHost, AI Sentiment & Escalations and AI Revenue Management: tools for your messages and your operations. Its page doesn't mention bookings made by guests' AI assistants.",
          sources: [S.hostaway],
        },
      ],
      beside:
        "The inbox is that door: at your own address, writing each booking into Hostaway first, so a night is never sold twice. Whether Google AI Mode will book your rooms, and who stays the merchant of record: [AI hotel booking](/guides/ai-hotel-booking/).",
    },
    connect: {
      text: "In Hostaway, Settings › Hostaway API › Create, with Hostaway Public API as the partner. Paste the account ID and the API key, then choose the property and match each listing to a room.",
      doc: { label: "Connect Hostaway, step by step", href: "/docs/connectors/hostaway/" },
    },
    faqs: [
      {
        q: "Does Hostaway's AI take bookings from other people's AIs?",
        a: "Hostaway describes its AI as replies, auto-replies, a co-host, sentiment and escalations, and revenue management, for your side of the work. Taking bookings from guests' own AI assistants is what the inbox adds, writing each one into Hostaway first.",
      },
      {
        q: "Could a guest be asked to pay twice?",
        a: "It can happen through Hostaway's own automations: a booking from the inbox is a direct reservation in Hostaway, and if Hostaway sends messages or payment requests for direct bookings, the guest may get them too. Look at its automated messages and payment rules for the direct channel.",
      },
      {
        q: "Does it handle multi-unit listings?",
        a: "Not yet: a multi-unit listing is sold one unit at a time. One listing is one room, and listings in the same town, currency and time zone are one property.",
      },
    ],
    related: ["beds24", "stripe", "mollie"],
    guides: [G.hotels, G.bookings],
    check: "Check your website",
  },
  {
    slug: "gloriafood",
    name: "GloriaFood",
    ids: ["gloriafood"],
    title: "GloriaFood is closing: your menu, ready for AI orders",
    heading: "GloriaFood closes on 30 April 2027: bring your menu to your own inbox",
    description:
      "GloriaFood reaches end of life on 30 April 2027. Bring your menu into your own inbox now, and take orders from customers' AI assistants, paid on your own link.",
    answer:
      "GloriaFood says it reaches end of life on 30 April 2027, and points customers to FoodAmigos. The inbox reads your GloriaFood menu to start from, then takes orders from customers' assistants for times your kitchen can make, paid on your own link. It is not an ordering website for people.",
    can: [
      "Read your menu, with its options and what each adds. Allergens are never guessed: only you or your staff confirm them, and until then assistants tell people to ask you.",
      "Order for a time your kitchen can make: collection, delivery in your zones with their own fees, or eating in. A slot is never sold twice.",
      "Add a tip, and pay on your own Stripe or Mollie link.",
      "Be told when you pause for 15, 30 or 60 minutes, and when you take orders again.",
    ],
    stays: {
      heading: "What stays in GloriaFood, and in your own account",
      points: [
        "Your GloriaFood menu: read when you ask, never changed. Dishes you bring in keep your prices and options, and what you add here.",
        "Orders you accept in GloriaFood: shown to you alone if you give that key, with no customer details kept.",
        "The money: on your own payment link. Nobody takes a share of an order.",
      ],
    },
    theirs: {
      heading: "GloriaFood's end of life, and the inbox",
      facts: [
        {
          text: "The notice on gloriafood.com: GloriaFood reaches end of life on 30 April 2027. Oracle offers no direct replacement, and points customers to FoodAmigos, which has onboarding for those who move.",
          sources: [S.gloriafood, S.foodamigos],
        },
      ],
      beside:
        "A menu you bring into the inbox before then is the inbox's own: its dishes stay, whatever happens to GloriaFood, and you edit them in Settings › Menu.",
    },
    connect: {
      text: "In GloriaFood's admin panel, Others › 3rd party integrations › Enabled integrations: add Fetch Menu and paste its key in Settings › Integrations. Then Settings › Menu › **Bring in your menu**, and tick the dishes to keep.",
      doc: { label: "Restaurants, and which tills connect", href: "/docs/ordering/#which-tills" },
    },
    faqs: [
      {
        q: "What happens to my GloriaFood menu after April 2027?",
        a: "GloriaFood says it reaches end of life on 30 April 2027. A menu you bring into your inbox before then is your inbox's own: its dishes, prices and options stay, and you edit them in Settings, Menu. Bring it in while GloriaFood still answers.",
      },
      {
        q: "Is this a GloriaFood alternative?",
        a: "In part. The inbox takes orders from customers' AI assistants, for collection, delivery or eating in, paid on your own link, with your kitchen's slots and a pause. It is not an ordering website or app for people. Oracle points GloriaFood customers to FoodAmigos.",
      },
      {
        q: "Can ChatGPT order food from my restaurant?",
        a: "When a customer's ChatGPT reaches your inbox, through a connector to its MCP server, it can read your menu, pick a time your kitchen can make and order; you accept it, or your rules do. Square says its US food sellers on Square Online Ordering can take orders in ChatGPT too.",
      },
    ],
    related: ["flipdish", "square", "stripe"],
    guides: [G.chatgpt, G.commerce, G.payments],
    check: "Check your website",
  },
  {
    slug: "flipdish",
    name: "Flipdish",
    ids: ["flipdish"],
    title: "Flipdish and AI agents: orders from AI assistants",
    heading: "Flipdish and AI agents: orders from customers' assistants, beside your phone agent",
    description:
      "Bring your Flipdish menu and collection hours into your own inbox; customers' AI assistants order for times your kitchen can make; a pause can close your store.",
    answer:
      "Flipdish's AI Phone Agent answers your calls. The inbox takes what customers' AI assistants write instead: it starts from your Flipdish menu and collection hours, offers only times your kitchen can make, and when you pause, your Flipdish store can close for the same time.",
    can: [
      "Read your menu, with its options and what each adds; allergens only as you or your staff confirm them.",
      "Order for a time your kitchen can make: collection, delivery in your zones, or eating in.",
      "Add a tip from the choices you pick, paid with the order on your own Stripe or Mollie link.",
      "Be told when you pause, and when you take orders again.",
    ],
    stays: {
      heading: "What stays in Flipdish, and in your own account",
      points: [
        "Ordering on your Flipdish page: no order is written into Flipdish, since we found no documented way for another app to put one in.",
        "Your menu, read when you ask and never changed.",
        "Closures you set in Flipdish: resuming opens only what the inbox's pause closed.",
        "The money: on your own payment link. Nobody takes a share.",
      ],
    },
    theirs: {
      heading: "Flipdish's AI Phone Agent, and the inbox beside it",
      facts: [
        {
          text: "Flipdish's AI Phone Agent answers calls, takes orders and sends them to your till or kitchen printer, in the UK, Ireland and select international markets.",
          sources: [S.flipdish, S.flipdishBlog],
        },
        {
          text: "Its page lists it at £99 per location per month (early bird discount available), plus a small transaction fee on every order.",
          sources: [S.flipdish],
        },
      ],
      beside:
        "The inbox doesn't answer the phone. It is the door for customers' AI assistants, which write rather than call: the two sit side by side.",
    },
    connect: {
      text: "In the Flipdish portal, Developer tools › OAuth apps › Add New; paste its Client ID and Secret Key in Settings › Integrations. Then **Bring in your menu**, and choose whether a pause closes your store too.",
      doc: { label: "Restaurants, and which tills connect", href: "/docs/ordering/#which-tills" },
    },
    faqs: [
      {
        q: "Does Flipdish's AI phone agent cover AI assistants?",
        a: "It answers phone calls. A customer's AI assistant that writes instead, through MCP or an API, needs a door like your inbox. The two sit side by side: calls to Flipdish's agent, written requests to your inbox.",
      },
      {
        q: "Are orders written into Flipdish?",
        a: "No. We found no documented way for another app to put an order into Flipdish, so orders from customers' assistants stay in your inbox, paid on your own link. To keep them on Flipdish, name your Flipdish ordering page as where orders go, and agents send people there.",
      },
      {
        q: "What does the pause do?",
        a: "On the inbox's home, Pause for 15, 30 or 60 minutes or the rest of today. With Close my Flipdish store too while paused on, your Flipdish store closes for collection and delivery for the same time; resuming opens only what the pause closed.",
      },
    ],
    related: ["gloriafood", "square", "stripe"],
    guides: [G.commerce, G.payments],
    check: "Check your website",
  },
  {
    slug: "servicem8",
    name: "ServiceM8",
    ids: ["servicem8"],
    title: "ServiceM8 and AI agents: quote requests become jobs",
    heading: "ServiceM8 and AI agents: quote requests from customers' assistants, as ServiceM8 jobs",
    description:
      "Customers' AI assistants send the job, the place, when suits and photos; requests you take on go into ServiceM8 as jobs in Quote status, with their photos.",
    answer:
      "ServiceM8's Phone Agent answers calls, and its MCP server connects your own account to ChatGPT or Claude. The inbox takes written requests from customers' assistants: it checks the site is in your area, and once you quote one, it becomes a ServiceM8 job in Quote status, with its photos.",
    can: [
      "Describe the job, how urgent, where and when suits, with up to six photos or plans. Where a photo was taken is removed on arrival.",
      "Be told whether the site is in your area, by postal code or distance. An emergency comes first in your inbox.",
      "Book a site visit beside the request, which you confirm. Visits scheduled in ServiceM8 are busy times.",
      "Get your quote, in stages if you like: a deposit now, a stage by a date, the rest on site.",
    ],
    stays: {
      heading: "What stays in ServiceM8",
      points: [
        "Your jobs, your quotes, your schedule and your invoicing. A request goes in once, never twice.",
        "Only what the job needs goes in: who to answer, the site and how to find it, what it is, when suits, the customer's words and the photos.",
        "ServiceM8 may charge for the jobs it makes: with Every request on, each request becomes a job.",
      ],
    },
    theirs: {
      heading: "ServiceM8's own AI, and the inbox beside it",
      facts: [
        {
          text: "The ServiceM8 Phone Agent is an add-on to ServiceM8 Phone, released in phases from ServiceM8 14, on the Connect Plus and Unlimited plans.",
          sources: [S.servicem8Phone],
        },
        {
          text: "ServiceM8's MCP server connects your own ServiceM8 account to ChatGPT, through ServiceM8's approved plugin, or to Claude, as a custom connector.",
          sources: [S.servicem8Mcp, S.servicem8Connect],
        },
      ],
      beside:
        "The inbox is the door for your customers' assistants: it writes the requests you take on into ServiceM8, and reads your schedule back.",
    },
    connect: {
      text: "Paste your ServiceM8 API key (Settings › API Keys) in Settings › Integrations › Job tool. Then choose which requests go in: by default, the ones you take on.",
      doc: { label: "Job tools, and what a connection does", href: "/docs/job-tools/" },
    },
    faqs: [
      {
        q: "Can an AI request a job or a quote from my ServiceM8?",
        a: "Through the inbox, yes. A customer's assistant sends the job, the place, when suits and photos; you see it in your inbox, and once you quote it, or press Send to ServiceM8, it becomes a job in Quote status with the photos in its diary.",
      },
      {
        q: "Does ServiceM8 have an AI receptionist?",
        a: "ServiceM8's Phone Agent, an add-on to ServiceM8 Phone on the Connect Plus and Unlimited plans, answers calls. The inbox doesn't take calls: it takes written requests from customers' AI assistants.",
      },
      {
        q: "Can it use my ServiceM8 opening hours?",
        a: "If you want: Settings, Work, Copy opening hours from ServiceM8 shows them beside yours, and Use these hours makes them your inbox's. Nothing changes until you press it.",
      },
      {
        q: "Does it work for plumbers and electricians anywhere?",
        a: "Yes. Postal codes are checked in each country's own shape, or a distance from your premises, and ServiceM8 connects with your own API key.",
      },
    ],
    related: ["calendars", "stripe", "mollie"],
    guides: [G.quotes, G.bookings],
    check: "Check your website",
  },
  {
    slug: "stripe",
    name: "Stripe",
    ids: ["stripe"],
    title: "Stripe and AI agents: get paid into your own account",
    heading: "Stripe and AI agents: orders from customers' assistants, paid into your own Stripe",
    description:
      "Each order you accept from a customer's AI assistant gets a Stripe payment link into your own account, marked paid once Stripe confirms it. No fee, no share.",
    answer:
      "Stripe's Agentic Commerce Suite lets AI platforms check out with sellers. The inbox works with the Stripe you have: each order you accept, and each quote your customer accepts, gets a payment link into your own account, and is marked paid once Stripe confirms it.",
    can: [
      "Order, or accept your quote, and get a link to pay you in your own Stripe, emailed in your name; agents see it on the order too.",
      "Pay a stay's deposit or balance, or a table's deposit, on its own Stripe link.",
      "Get a receipt that carries the amount Stripe confirmed.",
    ],
    stays: {
      heading: "What stays in Stripe, and in your own account",
      points: [
        "The money, straight from your customer to your Stripe account: it never passes the inbox, nor Surfing Dog.",
        "Refunds, made in your Stripe dashboard: the inbox never refunds, charges or moves money.",
        "Your customer's details: no name, email or address goes to Stripe with the link.",
        "Your account: a restricted key with five permissions, never a secret key, and never Stripe Connect.",
      ],
    },
    theirs: {
      heading: "Stripe's agentic commerce, and the inbox beside it",
      facts: [
        {
          text: "Stripe's Agentic Commerce Suite runs a Stripe-managed checkout for AI platforms, available in the US, Canada and select European countries.",
          sources: [S.stripeRetail],
        },
        {
          text: "Stripe's guide for service bookings has agents find, book and pay through a business's own booking API or MCP, without replacing its booking or payment set-up. It cites the Universal Commerce Protocol (UCP) Lodging booking capability, and its Shared Payment Tokens are a preview API.",
          sources: [S.stripeBooking],
        },
      ],
      beside:
        "The inbox makes plain payment links: a person pays on Stripe's page, into your own account. Payment by the customer's assistant itself, with a Shared Payment Token, is in the inbox too, off until you switch it on in Settings.",
    },
    connect: {
      text: "Create a restricted key in Stripe (Developers › API keys) with Payment Links, Products, Prices and Webhook Endpoints set to Write and Checkout Sessions to Read, and paste it in Settings › Integrations › Stripe.",
      doc: { label: "Connect Stripe", href: "/docs/payments/#stripe" },
    },
    faqs: [
      {
        q: "Can AI agents pay into my Stripe account?",
        a: "Through the inbox, an agent gets a payment link for an order you accepted, and a person pays it on Stripe's page, into your own account. Stripe also has Shared Payment Tokens, in preview, for agents that pay with a token; the inbox takes them as well, once you switch that on in Settings.",
      },
      {
        q: "Do I need Stripe's managed checkout?",
        a: "No. Stripe's own guide for service bookings says you don't need to replace your booking or payment set-up. The inbox makes ordinary payment links in your own account with a restricted key, and nothing else in Stripe changes.",
      },
      {
        q: "Which Stripe permissions does it need?",
        a: "A restricted key with Payment Links, Products, Prices and Webhook Endpoints set to Write, and Checkout Sessions to Read. A secret key is refused, and the inbox never uses Stripe Connect.",
      },
    ],
    related: ["mollie", "shopify", "woocommerce"],
    guides: [G.payments, G.commerce],
    check: "Check your website",
  },
  {
    slug: "mollie",
    name: "Mollie",
    ids: ["mollie"],
    title: "Mollie and AI agents: get paid into your own account",
    heading: "Mollie and AI agents: orders from customers' assistants, paid into your own Mollie",
    description:
      "Each order you accept from a customer's AI assistant gets a Mollie payment link into your own account, marked paid once Mollie confirms it. No fee, no share.",
    answer:
      "Mollie says it is ready for the Agentic Commerce Protocol in Europe, and has an MCP server. The inbox works with your Mollie today: each order you accept, and each quote your customer accepts, gets a payment link into your own account, marked paid once Mollie confirms it.",
    can: [
      "Order, or accept your quote, and get a link to pay you in your own Mollie, emailed in your name; agents see it on the order too.",
      "Pay a stay's deposit or balance, or a table's deposit, on its own Mollie link.",
      "Get a receipt that carries the amount Mollie confirmed.",
    ],
    stays: {
      heading: "What stays in Mollie, and in your own account",
      points: [
        "The money, straight from your customer to your Mollie account: it never passes the inbox, nor Surfing Dog.",
        "Refunds, made in your Mollie dashboard; one you make there marks the refund done in your inbox on its own, within about an hour.",
        "Your customer's details: no name, email or address goes to Mollie with the link.",
        "A payment is never believed on a report alone: the inbox asks Mollie, with your key, what was paid.",
      ],
    },
    theirs: {
      heading: "Mollie's agentic commerce, and the inbox beside it",
      facts: [
        {
          text: "In November 2025 Mollie said it is compatible with the Agentic Commerce Protocol's Delegated Payment API, ready for when OpenAI launches ACP in Europe, and that it works with Google on the Agent Payments Protocol (AP2).",
          sources: [S.mollieAcp],
        },
        { text: "Mollie launched an MCP server in July 2025.", sources: [S.mollieMcp] },
      ],
      beside: "The inbox uses plain payment links: a person pays on Mollie's page, into your own account.",
    },
    connect: {
      text: "Paste your profile's API key from Mollie (Developers › API keys): the live key, or the test key to try it first. Each link tells Mollie where to report its payment, so there is nothing else to set up.",
      doc: { label: "Connect Mollie", href: "/docs/payments/#mollie" },
    },
    faqs: [
      {
        q: "Does Mollie work with ChatGPT checkout?",
        a: "Mollie said in November 2025 that it is ready for the Agentic Commerce Protocol's delegated payments, for when OpenAI launches ACP in Europe. Through the inbox, a customer's assistant that reaches you gets a Mollie payment link for an order you accept, and a person pays it.",
      },
      {
        q: "Which Mollie key does it need?",
        a: "Your profile's API key, from Developers, API keys: the live key, or the test key to try it first. Each link tells Mollie where to report its payment, so there is nothing else to set up.",
      },
      {
        q: "Which currencies work?",
        a: "Every currency Mollie lists, each in its own minor unit. A currency Mollie doesn't list, or counts two ways, such as Kenyan shillings, gets no link, and you are told once, with the reason.",
      },
    ],
    related: ["stripe", "woocommerce", "beds24"],
    guides: [G.payments, G.commerce],
    check: "Check your website",
  },
];

export const platformHref = (slug: string) => `/integrations/${slug}/`;

export function platformBySlug(slug: string): Platform | undefined {
  return PLATFORMS.find((p) => p.slug === slug);
}

/** The page for an entry of src/lib/integrations.ts, where it has one. */
export function pageOf(id: string): Platform | undefined {
  return PLATFORMS.find((p) => p.ids.includes(id));
}

/** The credit lines a page needs, for the names it and its related pages carry: Automattic's, Apple's. */
export function platformNotices(p: Platform): readonly string[] {
  const said = [JSON.stringify(p), ...p.related.map((slug) => platformBySlug(slug)?.name ?? "")].join(" ");
  return [...(said.includes("WooCommerce") ? [WOO_NOTICE] : []), ...(said.includes("iCloud") ? [APPLE_NOTICE] : [])];
}
