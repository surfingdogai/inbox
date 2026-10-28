import { type Faq, faqPage, type Source } from "./faq";
import { guideHref } from "./guides";

/**
 * Topic guides under /guides/, beside the eight guides and outside their contract, like the Shopify
 * page: the network's result pages don't link them. Each answers what owners search for (agentic
 * commerce, selling on ChatGPT, AI hotel booking), says what is true as of a month, names where each
 * line about another company's product was read, and links the guides it builds on rather than
 * repeating them. Each is its own page under src/pages/guides/, drawn by src/components/TopicGuide.astro.
 * test/topics.node.test.ts holds them to it.
 *
 * Text may carry [words](/path or https://…) as a link and `code`, as src/lib/inline.ts reads them.
 */

export const TOPICS_AS_OF = "as of October 2026";
/** When the pages were written, and their sources read. */
export const TOPICS_MODIFIED = "2026-10-27";

export interface TopicBlock {
  readonly text: string;
  readonly sources?: readonly Source[];
}

export interface TopicSection {
  readonly id: string;
  readonly heading: string;
  /** Paragraphs, then a list where there is one. */
  readonly paras: readonly TopicBlock[];
  readonly list?: readonly TopicBlock[];
}

export interface Topic {
  readonly slug: string;
  /** Its title, before " · Surfing Dog". */
  readonly title: string;
  readonly heading: string;
  /** One line under the heading, where it says something the answer doesn't. */
  readonly lede?: string;
  readonly description: string;
  /** At most 50 words, plain text. */
  readonly answer: string;
  readonly sections: readonly TopicSection[];
  readonly faqs: readonly Faq[];
  /** Pages it builds on, here: the guides, the integrations, an assistant. */
  readonly related: readonly { readonly label: string; readonly href: string }[];
}

const src = (label: string, href: string): Source => ({ label, href });
const S = {
  ucp: src("UCP: the Universal Commerce Protocol", "https://ucp.dev/"),
  googleUcp: src(
    "Google Merchant Center Help: checkout with UCP",
    "https://support.google.com/merchants/answer/16837055",
  ),
  googleHotels: src("Google for Developers: hotels and UCP", "https://developers.google.com/hotels/ucp"),
  acp: src("ACP: the Agentic Commerce Protocol", "https://www.agenticcommerce.dev/"),
  shopifyChatgpt: src(
    "Shopify Help Center: ChatGPT",
    "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/chatgpt",
  ),
  shopifyGoogle: src(
    "Shopify Help Center: Google AI Mode and Gemini",
    "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/google",
  ),
  shopifyMeta: src(
    "Shopify Help Center: Meta",
    "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/meta",
  ),
  copilotCheckout: src(
    "Microsoft Advertising: Copilot Checkout",
    "https://about.ads.microsoft.com/en/blog/post/january-2026/conversations-that-convert-copilot-checkout-and-brand-agents",
  ),
  techcrunch: src(
    "TechCrunch, 24 March 2026",
    "https://techcrunch.com/2026/03/24/openais-plans-to-make-chatgpt-more-like-amazon-arent-going-so-well/",
  ),
  macrumors: src("MacRumors, 25 March 2026", "https://macrumors.com/2026/03/25/chatgpt-revamps-shopping-features"),
  woo: src("WooCommerce®: agentic commerce", "https://woocommerce.com/agentic-commerce/"),
  square: src(
    "Square: ChatGPT and Claude integrations, 1 July 2026",
    "https://squareup.com/us/en/press/claude-chatgpt-integrations",
  ),
  hostaway: src("Hostaway: Hostaway AI", "https://www.hostaway.com/features/hostaway-ai/"),
  stripeBooking: src(
    "Stripe Docs: agentic commerce for service bookings",
    "https://docs.stripe.com/agentic-commerce/sellers/use-cases/booking",
  ),
} satisfies Record<string, Source>;

const GUIDE = {
  selling: {
    label: "Agentic commerce readiness: sell through AI assistants",
    href: "/guides/sell-through-ai-assistants/",
  },
  payments: { label: "How AI assistants pay", href: "/guides/ai-assistant-payments/" },
  bookings: { label: "Let AI assistants book with your business", href: "/guides/ai-assistant-bookings/" },
  quotes: {
    label: "Let AI assistants message you or ask for a quote",
    href: "/guides/ai-assistant-messages-and-quotes/",
  },
  shopify: { label: "Shopify and AI assistants", href: "/guides/shopify-ai-assistants/" },
  chatgpt: { label: "Can ChatGPT book or order with your business?", href: "/assistants/chatgpt/" },
  integrations: { label: "Inbox integrations", href: "/integrations/" },
  commerce: { label: "Agentic commerce explained", href: "/guides/agentic-commerce/" },
  sellChatgpt: { label: "How to sell on ChatGPT", href: "/guides/sell-on-chatgpt/" },
  hotels: { label: "AI hotel booking", href: "/guides/ai-hotel-booking/" },
} as const;

export const TOPICS: readonly Topic[] = [
  {
    slug: "agentic-commerce",
    title: "Agentic commerce explained: ACP, UCP and AI shopping",
    heading: "Agentic commerce explained: ACP, UCP and what AI shopping needs from a store",
    description:
      "Agentic commerce in plain words: what ACP and UCP are, who runs them, which AI assistants check out where, and what a small shop needs to sell through them.",
    answer:
      "Agentic commerce, or agentic e-commerce, is shopping an AI assistant does for a person: it finds, compares and checks out through doors a shop publishes. The Universal Commerce Protocol (UCP) and the Agentic Commerce Protocol (ACP) are open standards for that checkout; the shop stays the merchant of record.",
    sections: [
      {
        id: "difference",
        heading: "Agentic commerce vs e-commerce",
        paras: [
          {
            text: "In e-commerce a person clicks through a shop's pages. In agentic commerce they ask an assistant, ChatGPT, Gemini, Copilot or another, and the assistant does the clicking, through machine doors: a catalogue it can search, a checkout it can call, and a way to pay without typing a card number. The person still says yes before anything is bought.",
          },
          {
            text: "What the check counts for a shop, door by door, is in [the selling guide](/guides/sell-through-ai-assistants/); how agents pay, in [the payments guide](/guides/ai-assistant-payments/).",
          },
        ],
      },
      {
        id: "ucp",
        heading: "The Universal Commerce Protocol (UCP)",
        paras: [
          {
            text: "UCP is open source, under Apache 2.0. It covers a catalogue, a cart, a checkout, identity linking (OAuth 2.0) and the order, over REST and JSON-RPC, with AP2, A2A and MCP built in. Its site lists co-developers for shopping (Google, Shopify, Etsy, Walmart and Stripe among them), for lodging (Booking.com, Expedia, Marriott and others) and for food (DoorDash, Square, Toast and Uber Eats). The lodging part is a draft, and food is coming.",
            sources: [S.ucp],
          },
          {
            text: "Google's UCP checkout is a Buy button in AI Mode and the Gemini app, paid with Google Pay, for products eligible in the US, Canada and Australia, and for select merchants for now. The merchant stays the seller of record; joining takes an interest form and a technical implementation.",
            sources: [S.googleUcp],
          },
        ],
      },
      {
        id: "acp",
        heading: "The Agentic Commerce Protocol (ACP)",
        paras: [
          {
            text: "ACP is an open standard, under Apache 2.0, from Stripe and OpenAI. ChatGPT implemented it, with Stripe's Shared Payment Token for the payment. Businesses stay the merchant of record, and each AI platform runs its own application process.",
            sources: [S.acp],
          },
          {
            text: "In March 2026 OpenAI deprioritised Instant Checkout, its checkout inside ChatGPT, as a stand-alone feature: merchants use their own checkout, and can still offer one through their own app inside ChatGPT. Walmart's app there has its own payments.",
            sources: [S.techcrunch, S.macrumors],
          },
        ],
      },
      {
        id: "differences",
        heading: "ACP, UCP, MCP and AP2: the difference",
        paras: [
          {
            text: "UCP and ACP describe shopping: a catalogue, a cart, a checkout, an order. MCP, the Model Context Protocol, is a general way for an assistant to call a tool on a server, a checkout among them; UCP can run over it. AP2, the Agent Payments Protocol, is for an agent paying with its person's approval, given as a mandate. A shop may publish more than one: they are doors to the same shop.",
            sources: [S.ucp, S.acp],
          },
        ],
      },
      {
        id: "where",
        heading: "Which assistants check out where",
        paras: [{ text: "What each one does with a shop, as of October 2026:" }],
        list: [
          {
            text: "**Google AI Mode and Gemini**: a checkout through UCP for products eligible in the US, Canada and Australia, with select merchants; Shopify stores that sell there get it as it rolls out.",
            sources: [S.googleUcp, S.shopifyGoogle],
          },
          {
            text: "**ChatGPT**: finds and compares products, and the buyer pays at the shop's own checkout, or inside the shop's own app in ChatGPT, such as Walmart's, or Square's for its US food and beverage sellers, paid with Order by Cash App.",
            sources: [S.shopifyChatgpt, S.macrumors, S.square],
          },
          {
            text: "**Microsoft Copilot**: Copilot Checkout, for people in the US; Shopify stores are in by default, other shops apply, or join through PayPal or Stripe.",
            sources: [S.copilotCheckout],
          },
          {
            text: "**Meta**: a checkout on Meta's apps for Shopify stores that sell to the US, Canada, Mexico, Brazil, Japan or Singapore.",
            sources: [S.shopifyMeta],
          },
        ],
      },
      {
        id: "shop",
        heading: "What a small shop needs",
        paras: [
          {
            text: "**A checkout an assistant can use.** Shopify publishes a UCP profile for eligible stores ([Shopify and AI assistants](/guides/shopify-ai-assistants/)). WooCommerce® lists UCP and ACP as coming soon. Elsewhere, ask your platform, or have one built ([the selling guide](/guides/sell-through-ai-assistants/)).",
            sources: [S.woo],
          },
          {
            text: "**Products, prices and stock an assistant can read**: a product feed, or markup on your pages.",
          },
          {
            text: "**A way to ask you, get a quote, change, cancel and return.** Shop checkouts rarely cover these. An agent inbox is one way: Surfing Dog Inbox (ours, open source) takes questions, quotes and orders at your own address and sends buyers to your shop's checkout ([what it connects to](/integrations/)).",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "What is the difference between ACP and UCP?",
        a: "Both are open standards for an assistant's checkout, and in both the shop stays the merchant of record. ACP, the Agentic Commerce Protocol, comes from Stripe and OpenAI. UCP, the Universal Commerce Protocol, was co-developed by Google, Shopify and others, and covers the catalogue, cart, identity linking and order too.",
      },
      {
        q: "What is the difference between ACP and MCP?",
        a: "ACP describes a checkout. MCP, the Model Context Protocol, is a general way for an assistant to call tools on a server, whatever they do: search a catalogue, book a time, ask a question. A shop can offer both.",
      },
      {
        q: "How do AI agents pay?",
        a: "With a credential made for agents, such as a token or a mandate the person approved, through the shop's checkout or payment provider; or a person pays on a payment link the agent hands them. An agent should never type a card number.",
      },
      {
        q: "Can ChatGPT buy things for you?",
        a: "ChatGPT finds and compares products. Since March 2026 OpenAI lets merchants use their own checkout, opened from ChatGPT, and a shop's own app inside ChatGPT can take payment, as Walmart's and Square's do. Gemini and Copilot check out inside the chat in some countries, with merchants they admit.",
      },
      {
        q: "How do I sell to AI agents?",
        a: "Publish a checkout an assistant can use, through your shop platform or UCP or ACP; keep your products, prices and stock readable; and give assistants a way to ask, get a quote, change, cancel and return. Our free check shows what your site offers today.",
      },
    ],
    related: [GUIDE.sellChatgpt, GUIDE.hotels, GUIDE.selling, GUIDE.payments, GUIDE.shopify, GUIDE.integrations],
  },
  {
    slug: "sell-on-chatgpt",
    title: "How to sell on ChatGPT: products, checkout and questions",
    heading: "How to sell on ChatGPT: getting your products in, and what happens at checkout",
    lede: "ChatGPT shopping in October 2026: how products get in, where the buyer pays, and how a customer's ChatGPT can reach you.",
    description:
      "How products get into ChatGPT shopping, why the buyer pays in your own checkout, what Shopify and WooCommerce® do, and how a customer's ChatGPT can ask you.",
    answer:
      "ChatGPT finds and compares products; the buyer pays at the shop's own checkout, or in the shop's own app inside ChatGPT. Eligible Shopify stores that sell to the US are in; others start at OpenAI's page for merchants. Questions and quotes need a door of yours.",
    sections: [
      {
        id: "how",
        heading: "How ChatGPT shops",
        paras: [
          {
            text: "ChatGPT finds and compares products. On Shopify, the buyer pays in the store's own checkout, opened in ChatGPT's in-app browser or a new tab.",
            sources: [S.shopifyChatgpt],
          },
          {
            text: "In March 2026 OpenAI deprioritised Instant Checkout, its checkout inside the chat, as a stand-alone feature: merchants use their own checkout, and can still offer one through their own app inside ChatGPT. Walmart's app there has its own payments; Square's, for its US food and beverage sellers, takes Order by Cash App.",
            sources: [S.techcrunch, S.macrumors, S.square],
          },
          {
            text: "OpenAI and Stripe publish the Agentic Commerce Protocol (ACP), an open standard for an assistant's checkout: the business stays the merchant of record, and each AI platform runs its own application process ([agentic commerce explained](/guides/agentic-commerce/)).",
            sources: [S.acp],
          },
        ],
      },
      {
        id: "products",
        heading: "Getting your products in",
        paras: [],
        list: [
          {
            text: "**Shopify**: through agentic storefronts, on by default for eligible stores that sell to customers in the US; a store based elsewhere qualifies if it sells to the US. Your terms of service, privacy policy and refund policy need to be filled in.",
            sources: [S.shopifyChatgpt],
          },
          {
            text: "**WooCommerce®**: ACP, through Stripe's Agentic Commerce Suite, is listed as coming soon, as is the Universal Commerce Protocol (UCP).",
            sources: [S.woo],
          },
          {
            text: "**Square**: US food and beverage sellers with an activated Square Online Ordering profile are in Square's own ChatGPT app.",
            sources: [S.square],
          },
          {
            text: "**Any other shop**: OpenAI's page for merchants is chatgpt.com/merchants. Reports differ on whether it is open to every shop, so read it there.",
          },
        ],
      },
      {
        id: "reach",
        heading: "Questions, quotes and orders from a customer's ChatGPT",
        paras: [
          {
            text: "A person can add an MCP server to ChatGPT as a connector, on paid plans in developer mode, and ask, book or order through it ([ChatGPT and your business](/assistants/chatgpt/)). That is how a customer's ChatGPT reaches a business with no shopping app of its own.",
          },
          {
            text: "An agent inbox gives you that door at your own address. Surfing Dog Inbox (ours, open source) takes a customer's ChatGPT's questions, quote requests and orders, and connects to the shop you run ([integrations](/integrations/)). How the check counts messages and quotes: [the guide](/guides/ai-assistant-messages-and-quotes/).",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "How do I sell on ChatGPT?",
        a: "Get your products into ChatGPT's shopping results, through your shop platform or OpenAI's page for merchants; eligible Shopify stores that sell to the US are in already. Keep a checkout that works when ChatGPT opens it, or build your own app inside ChatGPT. Give a customer's assistant a way to ask you things too.",
      },
      {
        q: "How do I get my products on ChatGPT?",
        a: "On Shopify, through agentic storefronts, on by default for eligible stores that sell to the US. WooCommerce lists its ACP support as coming soon. Other shops start at OpenAI's page for merchants, chatgpt.com/merchants.",
      },
      {
        q: "Does ChatGPT have a checkout?",
        a: "Not as a stand-alone feature since March 2026, when OpenAI deprioritised Instant Checkout. The buyer pays at the shop's own checkout, opened from ChatGPT, or inside a shop's own app in ChatGPT, such as Walmart's or Square's, which take payment there.",
      },
      {
        q: "Can I sell on ChatGPT from outside the US?",
        a: "For a Shopify store, yes, if it sells to customers in the US: Shopify says a store based outside the US qualifies. Other shops start at OpenAI's page for merchants, chatgpt.com/merchants.",
      },
      {
        q: "Can a customer's ChatGPT ask my shop a question?",
        a: "Yes, through a door it can use: an app, or an MCP server the customer adds as a connector, on ChatGPT's paid plans. An agent inbox at your own address is one such door, for questions, quotes and orders.",
      },
    ],
    related: [GUIDE.commerce, GUIDE.hotels, GUIDE.chatgpt, GUIDE.selling, GUIDE.quotes, GUIDE.shopify],
  },
  {
    slug: "ai-hotel-booking",
    title: "AI hotel booking: UCP Lodging, Google and your own door",
    heading: "AI agents and hotel booking: what a small place to stay needs",
    lede: "How an AI assistant books a room in October 2026, what Google and the Universal Commerce Protocol are building, and what a guesthouse can do now.",
    description:
      "How AI agents book hotels in October 2026: UCP Lodging and Google's waitlist, who stays merchant of record, and what a small place to stay needs to be bookable.",
    answer:
      "An AI assistant books a room through a door the property, or its system, publishes. The lodging part of the Universal Commerce Protocol (UCP) is a draft; Google has a waitlist, and the property stays the merchant of record. Meanwhile a door of your own takes guests' assistants' requests.",
    sections: [
      {
        id: "how",
        heading: "How an assistant books a room",
        paras: [
          {
            text: "It asks for dates and guests, needs the total with every tax and fee and the cancellation policy for those nights, holds the room while its person decides, books, and pays a deposit or leaves the rest for the property. The room must never be sold twice, so whatever answers has to know what your other channels sold. What the check counts for bookings: [the bookings guide](/guides/ai-assistant-bookings/).",
          },
        ],
      },
      {
        id: "ucp",
        heading: "UCP Lodging and Google",
        paras: [
          {
            text: "The Universal Commerce Protocol lists co-developers for lodging: Amadeus, Booking.com, Expedia, Google, Hilton, Marriott and Trip.com. Its lodging part is a draft.",
            sources: [S.ucp],
          },
          {
            text: "Google says properties remain the merchant of record for bookings through UCP. There is a waitlist, and its detailed onboarding and specs are still to come.",
            sources: [S.googleHotels],
          },
          {
            text: "Stripe's guide for service bookings has agents find, book and pay through a business's own booking API or MCP, citing the UCP Lodging booking capability, without replacing its booking or payment set-up.",
            sources: [S.stripeBooking],
          },
        ],
      },
      {
        id: "now",
        heading: "What a small place to stay can do now",
        paras: [],
        list: [
          {
            text: "**Ask your property system or channel manager** whether it publishes a door guests' assistants can book through, and link it from your own site. Their AI is often for your side of the work: Hostaway's covers replies, a co-host, escalations and revenue management, and its page doesn't mention bookings by guests' assistants.",
            sources: [S.hostaway],
          },
          {
            text: "**An agent inbox of your own.** Surfing Dog Inbox (ours, open source) quotes your rates with every tax and fee, writes each stay to [Beds24](/integrations/beds24/) or [Hostaway](/integrations/hostaway/) first so a room is never sold twice, and takes deposits on your own payment link. Its UCP Lodging is built, and off while the standard is a draft; on your own server you can switch it on.",
          },
          {
            text: "**Your own terms, in words on your site**: an assistant reading your site doesn't see the ones on a platform's pages.",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "Can ChatGPT book hotels?",
        a: "Through a door it can use: an app, a connector to a property's MCP server, or a booking platform it works with. A small property is reached through a door of its own, such as an agent inbox, or its system's door if it has one.",
      },
      {
        q: "Will Google AI Mode book my rooms?",
        a: "Google is building hotel bookings on the Universal Commerce Protocol (UCP), with the property staying the merchant of record; there is a waitlist, and its specs are still to come.",
      },
      {
        q: "What is UCP Lodging?",
        a: "The lodging part of the Universal Commerce Protocol: a draft standard for an AI platform to find a room, get the total and the policy, hold it and book it. Amadeus, Booking.com, Expedia, Google, Hilton, Marriott and Trip.com are listed as co-developers.",
      },
      {
        q: "Do I stay the merchant of record?",
        a: "Google says properties remain the merchant of record for bookings through UCP. Through your own agent inbox, guests pay you, on your own payment link or at the property.",
      },
    ],
    related: [
      GUIDE.commerce,
      GUIDE.sellChatgpt,
      GUIDE.bookings,
      GUIDE.payments,
      { label: "Beds24", href: "/integrations/beds24/" },
      { label: "Hostaway", href: "/integrations/hostaway/" },
    ],
  },
];

export const topicHref = (slug: string) => `/guides/${slug}/`;

export function topicBySlug(slug: string): Topic {
  const t = TOPICS.find((x) => x.slug === slug);
  if (!t) throw new Error(`src/lib/topics.ts has no "${slug}"`);
  return t;
}

/** Whether a page names WooCommerce®, and so carries Automattic's notice. */
export const namesWoo = (t: Topic): boolean => JSON.stringify(t).includes("WooCommerce");

/** A topic page's structured data: the article, where it sits, and its questions in the page's words. */
export function topicLd(t: Topic, site: string): readonly Record<string, unknown>[] {
  const url = new URL(topicHref(t.slug), site).toString();
  const guides = new URL(guideHref(""), site).toString();
  return [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: t.heading,
      description: t.description,
      abstract: t.answer,
      datePublished: TOPICS_MODIFIED,
      dateModified: TOPICS_MODIFIED,
      author: { "@type": "Organization", name: "Surfing Dog", url: site },
      publisher: { "@id": `${site}#org` },
      isPartOf: { "@type": "CollectionPage", name: "Guides", url: guides },
      image: new URL("/art/og-network-v1.png", site).toString(),
      mainEntityOfPage: url,
      url,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: site },
        { "@type": "ListItem", position: 2, name: "Guides", item: guides },
        { "@type": "ListItem", position: 3, name: t.title, item: url },
      ],
    },
    faqPage(t.faqs, url),
  ];
}
