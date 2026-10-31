import { DICTS } from "../i18n";
import { type Faq, faqPage, type Source } from "./faq";
import { guideHref } from "./guides";
import { type Alternate, type Lang, pagePath } from "./i18n";

/**
 * Topic guides under /guides/, beside the eight guides and outside their contract, like the Shopify
 * page: the network's result pages don't link them. Each answers what owners search for (agentic
 * commerce, selling on ChatGPT, AI hotel booking, agent payments, an AI receptionist…), says what is
 * true as of a month, names where each line about another company's product was read, and links the
 * guides it builds on rather than repeating them. Each is its own page under src/pages/guides/, drawn
 * by src/components/TopicGuide.astro. test/topics.node.test.ts holds them to it.
 *
 * A few are written in Spanish or Portuguese too, natively rather than word for word, where owners
 * search in their own words ("cómo aparecer en ChatGPT"). Such a page names the English one it goes
 * with (`of`), lives under /es/guias/ or /pt/guias/ (src/pages/es, src/pages/pt), and every version
 * names the others as hreflang alternates, English as the x-default, in its head and in the sitemap.
 * They sit beside the translated pages of src/lib/i18n.ts, which are in all six languages; these are
 * in as many as owners search them in.
 *
 * Text may carry [words](/path or https://…) as a link and `code`, as src/lib/inline.ts reads them.
 */

export const TOPICS_AS_OF = "as of October 2026";
/** When the pages were written, and their sources read. */
export const TOPICS_MODIFIED = "2026-10-27";
/** When the pages added on 31 October 2026 were written, and their sources read. */
export const TOPICS_ADDED = "2026-10-31";

/** The languages a topic guide may be written in. */
export const TOPIC_LANGS = ["en", "es", "pt"] as const satisfies readonly Lang[];
export type TopicLang = (typeof TOPIC_LANGS)[number];

/** The words of the frame around a topic guide, in its language. */
export interface TopicWords {
  /** The month the page is true as of, as its words write it: the tests look for it. */
  readonly month: string;
  /** "Sources, as of October 2026". */
  readonly sources: string;
  /** Where the page sits: the eyebrow, the breadcrumb and "all guides". */
  readonly hub: { readonly label: string; readonly href: string };
  readonly inShort: string;
  readonly questions: string;
  readonly readNext: string;
  /** How a page in this language labels our inbox, right after its name. */
  readonly ours: string;
  /** The check at the foot of the page, in the page's language; the checker itself is in English. */
  readonly check?: {
    readonly title: string;
    readonly text: string;
    readonly label: string;
    readonly placeholder: string;
    readonly button: string;
    /** The line under the form; the checker's link is marked as English. */
    readonly fine: string;
  };
}

export const TOPIC_WORDS: Readonly<Record<TopicLang, TopicWords>> = {
  en: {
    month: "October 2026",
    sources: `Sources, ${TOPICS_AS_OF}`,
    hub: { label: "Guides", href: guideHref("") },
    inShort: DICTS.en.ui.inShort,
    questions: DICTS.en.ui.questions,
    readNext: "Read next",
    ours: " (ours, open source)",
  },
  es: {
    month: "octubre de 2026",
    sources: "Fuentes, a octubre de 2026",
    hub: { label: DICTS.es.hub.short, href: pagePath("tools", "es") },
    inShort: DICTS.es.ui.inShort,
    questions: DICTS.es.ui.questions,
    readNext: "Sigue leyendo",
    ours: " (la nuestra, de código abierto)",
    check: {
      title: "Revisa tu web",
      text: "Pega la dirección de tu web. La leemos como lo haría el asistente de un cliente y te mostramos qué puede hacer allí, qué falta y por dónde empezar. El resultado está en inglés.",
      label: "Tu web",
      placeholder: "tunegocio.com",
      button: "Revisar",
      fine: "O abre el [comprobador gratuito](/check), sin registro.",
    },
  },
  pt: {
    month: "outubro de 2026",
    sources: "Fontes, em outubro de 2026",
    hub: { label: DICTS.pt.hub.short, href: pagePath("tools", "pt") },
    inShort: DICTS.pt.ui.inShort,
    questions: DICTS.pt.ui.questions,
    readNext: "Continue lendo",
    ours: " (a nossa, de código aberto)",
    check: {
      title: "Verifique seu site",
      text: "Cole o endereço do seu site. Nós o lemos como o assistente de um cliente leria e mostramos o que ele pode fazer ali, o que falta e por onde começar. O resultado sai em inglês.",
      label: "Seu site",
      placeholder: "suaempresa.com",
      button: "Verificar",
      fine: "Ou abra o [verificador gratuito](/check), sem cadastro.",
    },
  },
};

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
  /** The page's language; English when it says none. */
  readonly lang?: TopicLang;
  /** For a page in another language: the slug of the English page it goes with. */
  readonly of?: string;
  /** When it was written, if not with the first three (TOPICS_MODIFIED). */
  readonly modified?: string;
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
  ap2: src("AP2: the Agent Payments Protocol", "https://ap2-protocol.org/"),
  googleAp2: src(
    "Google: AP2 goes to the FIDO Alliance, 28 April 2026",
    "https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/",
  ),
  mastercard: src(
    "Mastercard: Agent Pay, 29 April 2025",
    "https://www.mastercard.com/us/en/news-and-trends/press/2025/april/mastercard-unveils-agent-pay-pioneering-agentic-payments-technology-to-power-commerce-in-the-age-of-ai.html",
  ),
  visa: src(
    "Visa: Intelligent Commerce Connect, 8 April 2026",
    "https://corporate.visa.com/en/sites/visa-perspectives/newsroom/visa-intelligent-commerce-connect-ai-shopping-for-businesses.html",
  ),
  gmailWorkspace: src(
    "Google Workspace Updates: AI Inbox for paid Workspace users",
    "https://workspaceupdates.googleblog.com/2026/10/gmails-ai-inbox-is-rolling-out-to-paid-Workspace-users.html",
  ),
  gmailHelp: src("Gmail Help: AI Inbox", "https://support.google.com/mail/answer/16845247"),
  googleCalls: src(
    "Google Business Profile Help: automated calls",
    "https://support.google.com/business/answer/7690269",
  ),
  googleIo: src(
    "Google: Search at I/O 2026",
    "https://blog.google/products-and-platforms/products/search/search-io-2026/",
  ),
  openaiNotes: src(
    "OpenAI: ChatGPT release notes",
    "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
  ),
  geminiApps: src(
    "Google: new connected apps in Gemini",
    "https://blog.google/innovation-and-ai/products/gemini-app/new-connected-apps-services-gemini-august-2026/",
  ),
  openaiBots: src("OpenAI: its crawlers", "https://developers.openai.com/api/docs/bots"),
  googleAi: src(
    "Google Search Central: AI features and your website",
    "https://developers.google.com/search/docs/appearance/ai-features",
  ),
  merchantFree: src(
    "Google Merchant Center Help: free listings",
    "https://support.google.com/merchants/answer/13889434",
  ),
  schemaProduct: src("schema.org: Product", "https://schema.org/Product"),
  // The same pages for the Spanish and Portuguese guides, named in the page's language, in it where
  // the company publishes one.
  openaiBotsEs: src("OpenAI: sus rastreadores, en inglés", "https://developers.openai.com/api/docs/bots"),
  openaiBotsPt: src("OpenAI: os rastreadores, em inglês", "https://developers.openai.com/api/docs/bots"),
  googleAiEs: src(
    "Google Search Central: las funciones de IA y tu web",
    "https://developers.google.com/search/docs/appearance/ai-features?hl=es",
  ),
  googleAiPt: src(
    "Google Search Central: os recursos de IA e seu site",
    "https://developers.google.com/search/docs/appearance/ai-features?hl=pt-br",
  ),
  merchantFreeEs: src(
    "Ayuda de Google Merchant Center: fichas gratuitas",
    "https://support.google.com/merchants/answer/13889434?hl=es",
  ),
  merchantFreePt: src(
    "Ajuda do Google Merchant Center: listagens gratuitas",
    "https://support.google.com/merchants/answer/13889434?hl=pt-BR",
  ),
  shopifyChatgptEs: src(
    "Centro de ayuda de Shopify: ChatGPT",
    "https://help.shopify.com/es/manual/online-sales-channels/agentic-storefronts/chatgpt",
  ),
  shopifyChatgptPt: src(
    "Central de Ajuda da Shopify: ChatGPT",
    "https://help.shopify.com/pt-BR/manual/online-sales-channels/agentic-storefronts/chatgpt",
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
  assisted: { label: "What is AI agent-assisted payment?", href: "/guides/ai-agent-assisted-payments/" },
  details: { label: "Your hours, prices and terms as data", href: "/guides/business-details-for-ai/" },
  robots: { label: "robots.txt and AI agents", href: "/guides/robots-txt-ai-agents/" },
  ap2: { label: "The Agent Payments Protocol (AP2)", href: "/guides/agent-payments-protocol/" },
  aiInbox: { label: "AI inbox for business", href: "/guides/ai-inbox-for-business/" },
  receptionist: { label: "AI receptionists and AI assistants", href: "/guides/ai-receptionist/" },
  onChatgpt: { label: "Get your business on ChatGPT", href: "/guides/get-your-business-on-chatgpt/" },
  products: { label: "AI product search", href: "/guides/ai-product-search/" },
  add: { label: "Add your website", href: "/add/" },
  inbox: { label: "Surfing Dog Inbox", href: "/inbox/" },
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
    related: [
      GUIDE.sellChatgpt,
      GUIDE.hotels,
      GUIDE.ap2,
      GUIDE.selling,
      GUIDE.payments,
      GUIDE.shopify,
      GUIDE.integrations,
    ],
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
  {
    slug: "agent-payments-protocol",
    modified: TOPICS_ADDED,
    title: "Agent Payments Protocol (AP2) explained for businesses",
    heading: "The Agent Payments Protocol (AP2): what it means for a business that takes payments",
    lede: "What AP2 is as of October 2026, how its mandates work, and what a shop, a salon or a guesthouse can do about it now.",
    description:
      "AP2, the Agent Payments Protocol, in plain words: the mandates a person signs so an AI agent can pay, what it pays with, and what a business does now.",
    answer:
      "AP2, the Agent Payments Protocol, is an open standard for an AI agent paying with its person's signed approval, called a mandate. Google published it and gave it to the FIDO Alliance. A business doesn't adopt it alone: it reaches you through your checkout and your payment provider.",
    sections: [
      {
        id: "what",
        heading: "What AP2 is",
        paras: [
          {
            text: "AP2 is an open protocol for AI agents that pay for people, under the Apache 2.0 licence. It builds on the Agent2Agent protocol (A2A) and the Universal Commerce Protocol (UCP), and lists the Model Context Protocol (MCP) among its integrations.",
            sources: [S.ap2],
          },
          {
            text: "On 28 April 2026 Google gave it to the FIDO Alliance, a standards group, and published version 0.2, which adds payments an agent makes on its own, within instructions its person approved in advance: Google's example is tickets bought the moment they go on sale.",
            sources: [S.googleAp2],
          },
        ],
      },
      {
        id: "mandates",
        heading: "Mandates: how a person says yes",
        paras: [
          {
            text: "A mandate is a signed digital credential. AP2 has two kinds, and each is first open, then closed:",
          },
        ],
        list: [
          {
            text: "**The checkout mandate**: what the agent and the business agreed. Open, it holds the person's limits before the cart is final; closed, their yes to one checkout. The business receives it.",
            sources: [S.ap2],
          },
          {
            text: "**The payment mandate**: the person's yes to paying with one card or account. Open, a budget or the ways to pay allowed; closed, one amount for that checkout. It goes to the provider of the person's payment details, the card network and the business's payment processor.",
            sources: [S.ap2],
          },
          {
            text: "**Verifiable Intent**, which Google and Mastercard made together and also gave to the FIDO Alliance: a record of what a person allowed their agent to do, that can't be changed afterwards.",
            sources: [S.googleAp2],
          },
        ],
      },
      {
        id: "pay",
        heading: "What it pays with, and the card networks",
        paras: [
          {
            text: "Cards today, credit and debit. Real-time bank transfers such as UPI and Pix, e-wallets and digital currencies are on its roadmap. One of its samples pays with x402, payment over HTTP.",
            sources: [S.ap2],
          },
          {
            text: "The card networks run programmes of their own for agents. Mastercard Agent Pay, announced in April 2025, brings agentic tokens to businesses through acquirers and checkout providers. Visa Intelligent Commerce Connect, announced in April 2026 and in pilot with select partners, lets businesses take payments agents start through the Agentic Commerce Protocol (ACP), UCP and other protocols.",
            sources: [S.mastercard, S.visa],
          },
          {
            text: "How these fit with ACP and UCP checkouts: [agentic commerce explained](/guides/agentic-commerce/). The difference between an assisted payment and a fully agentic one: [AI agent-assisted payment](/guides/ai-agent-assisted-payments/).",
          },
        ],
      },
      {
        id: "do",
        heading: "What a business can do now",
        paras: [],
        list: [
          {
            text: "**Ask your payment provider** whether it takes agent payments, AP2 mandates or the card networks' agent tokens, and in which countries. That is where AP2 reaches you.",
          },
          {
            text: "**Publish a checkout an agent can use**, if you sell online: a UCP profile with its payment handlers, or an ACP checkout ([how AI assistants pay](/guides/ai-assistant-payments/)).",
          },
          {
            text: "**Send a payment link** meanwhile. It works with any assistant: the agent does the rest, and a person pays at your own checkout. Surfing Dog Inbox (ours, open source) sends one from your own [Stripe](/integrations/stripe/) or [Mollie](/integrations/mollie/) account when you accept an order, and the money goes straight to you.",
          },
          {
            text: "**Say how you take payment**, in words on your site: pay now, a deposit, on arrival or by invoice. An assistant reads it before it commits its person.",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "What is the Agent Payments Protocol (AP2)?",
        a: "An open standard for an AI agent paying for a person with their signed approval, called a mandate. Google published it, and in April 2026 gave it to the FIDO Alliance, with version 0.2 on GitHub.",
      },
      {
        q: "Is AP2 the same as ACP or UCP?",
        a: "No. The Agentic Commerce Protocol and the Universal Commerce Protocol describe a checkout: a cart and an order. AP2 describes the person's approval of the payment, the mandate, and builds on UCP and A2A.",
      },
      {
        q: "Do I need AP2 to take payments from AI agents?",
        a: "Not to start. A payment link to your own checkout works with any assistant today. AP2 mandates and the card networks' agent tokens reach you through your payment provider: ask yours which it takes, and where.",
      },
      {
        q: "What can an agent pay with through AP2?",
        a: "Credit and debit cards today. Real-time bank transfers such as UPI and Pix, e-wallets and digital currencies are on its roadmap.",
      },
      {
        q: "Can an AI agent pay without asking its person each time?",
        a: "With AP2 version 0.2, within instructions the person approved in advance, such as a budget or a single item. The person's limits travel with the payment as a signed mandate.",
      },
    ],
    related: [GUIDE.payments, GUIDE.assisted, GUIDE.commerce, GUIDE.products, GUIDE.onChatgpt],
  },
  {
    slug: "ai-inbox-for-business",
    modified: TOPICS_ADDED,
    title: "AI inbox for business: the two things it means",
    heading: "AI inbox for business: an AI that reads your email, or an inbox AI assistants write to",
    lede: "What the words mean as of October 2026, what each kind does for a business, and which one a customer's assistant needs.",
    description:
      "Two things are called an AI inbox: AI that sorts and summarises your email, like Gmail's AI Inbox, and an inbox your customers' AI assistants send requests to.",
    answer:
      "An AI inbox usually means AI inside your email: Gmail's AI Inbox, for one, picks out to-dos and sums up topics. Another kind takes requests from customers' AI assistants, bookings, orders and questions, in a form a program reads and answers. Many businesses will want both.",
    sections: [
      {
        id: "email",
        heading: "AI in your email",
        paras: [
          {
            text: "Gmail's AI Inbox is Google's: a view in Gmail that lists to-dos from your mail, such as a bill to pay by a date, and sums up topics such as trips, reservations and purchases.",
            sources: [S.gmailHelp],
          },
          {
            text: "It reads the Primary tab, and leaves out spam and mail you archived, muted or snoozed.",
            sources: [S.gmailHelp],
          },
          {
            text: "Google began rolling it out to paid Google Workspace customers on 12 October 2026, in stages.",
            sources: [S.gmailWorkspace],
          },
          {
            text: "Helpdesks and email tools add AI of their own: summaries, labels, drafted replies. All of it reads what people wrote, in whatever words and order they wrote it, and helps you answer.",
          },
        ],
      },
      {
        id: "agents",
        heading: "An inbox AI assistants write to",
        paras: [
          {
            text: "Assistants already act for people. Since 10 August 2026 ChatGPT books restaurant tables through OpenTable, Resy and Yelp, and Google may phone a business for its users, to book an appointment or check a price.",
            sources: [S.openaiNotes, S.googleCalls],
          },
          {
            text: "When a customer asks ChatGPT, Gemini or Claude to book with you or get a price, the assistant needs somewhere to send it that answers in a form it can read: the time is taken, here is the price, this is the booking's reference. An email it writes waits for a person; a door answers now.",
          },
          {
            text: "An agent inbox is such a door. It publishes a manifest at `/.well-known/agent-inbox.json`, takes bookings, orders, quote requests and messages over MCP and REST, and says what became of each: received, confirmed, declined. What the check counts: [messages and quotes](/guides/ai-assistant-messages-and-quotes/), and [bookings](/guides/ai-assistant-bookings/).",
          },
          {
            text: "Surfing Dog Inbox (ours, open source) is one, at your own address, such as inbox.yourbusiness.example. Your rules answer the routine requests and you see the rest; your own AI can work it too, through its owner MCP; and its spam filter keeps sales pitches and scams off your desk without losing a customer. [How it works](/inbox/).",
          },
        ],
      },
      {
        id: "which",
        heading: "Which one you need",
        paras: [],
        list: [
          {
            text: "**Too much email to read**: AI in your email, or in your helpdesk.",
          },
          {
            text: "**Customers whose assistants book, order or ask for prices**: a door those assistants can use, on your own domain. [Check your website](/check) to see whether it has one.",
          },
          {
            text: "**Both**: they sit side by side. Ours emails you about each new request; the calendars, shops and payment accounts it connects to are on [the integrations page](/integrations/).",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "What is an AI inbox?",
        a: "Usually AI inside your email that sorts, sums up and drafts, such as Gmail's AI Inbox, which is Google's. The words can also mean an inbox customers' AI assistants write to, which takes bookings, orders and quote requests in a form a program reads.",
      },
      {
        q: "Is Surfing Dog's inbox an AI email inbox?",
        a: "No. It doesn't read or sort the email you already get. It is an agent inbox at your own address, where customers and their AI assistants send bookings, orders, quote requests and messages, and your rules answer the routine ones.",
      },
      {
        q: "Do I need an agent inbox if I use Gmail's AI Inbox?",
        a: "They do different jobs. Gmail's AI Inbox helps you read your own mail. An agent inbox gives customers' AI assistants a door to book, order or ask, and answers them in a form they can read.",
      },
      {
        q: "Can AI answer my customers for me?",
        a: "Email tools and helpdesks offer AI that drafts replies, and some send them. An agent inbox answers a customer's assistant by your rules, such as a free time or a price from your list, and leaves the rest for you.",
      },
    ],
    related: [GUIDE.quotes, GUIDE.receptionist, GUIDE.onChatgpt, GUIDE.inbox, GUIDE.integrations],
  },
  {
    slug: "ai-receptionist",
    modified: TOPICS_ADDED,
    title: "AI receptionist: answer callers and their AI assistants",
    heading: "AI receptionists, booking assistants and your customer's own AI: who answers whom",
    lede: "As of October 2026, an AI receptionist answers people who call or chat. More and more often, the one asking is an assistant.",
    description:
      "An AI receptionist answers people who phone or chat; a customer's AI assistant needs a door it can use. What each does, what to ask, and how they fit together.",
    answer:
      "An AI receptionist answers people who call or chat, and books or takes messages for you. A customer's own AI assistant, booking for them, needs a door it can use instead: free times it can read, a booking it can make, an answer it understands. Many businesses will want both.",
    sections: [
      {
        id: "receptionist",
        heading: "What an AI receptionist does",
        paras: [
          {
            text: "It answers your phone or your chat in words like a person's: it gives your hours, takes a message, books from your calendar, and hands on what it can't handle. Before you choose one, try it on your own business, and make sure a caller can always reach a person.",
          },
          {
            text: "Ask any you consider: which calendar or booking system it writes to, what it says when it doesn't know, how a caller gets through to someone, what it records and keeps, and what a month costs when calls are few.",
          },
        ],
      },
      {
        id: "assistants",
        heading: "When the one asking is an AI assistant",
        paras: [
          {
            text: "Assistants already book for people. Since 10 August 2026 ChatGPT finds free tables and books them through OpenTable, Resy and Yelp; Gemini books doctors' appointments with Zocdoc, through apps it connected in August 2026.",
            sources: [S.openaiNotes, S.geminiApps],
          },
          {
            text: "Some phone. Google may call a business for its users, to book an appointment, check a restaurant's wait or confirm a price and whether something is available.",
            sources: [S.googleCalls],
          },
          {
            text: "At I/O in May 2026 Google said people in the US can ask it to call businesses in categories such as home repair, beauty and pet care, and that booking in Search reaches local experiences and services, with links to finish booking with the provider.",
            sources: [S.googleIo],
          },
          {
            text: "You can stop Google's automated calls in your Business Profile's advanced settings, or by telling the caller to stop.",
            sources: [S.googleCalls],
          },
          {
            text: "A call to your receptionist gives an assistant words; a door gives it a booking and its reference. What the check counts for bookings is in [the bookings guide](/guides/ai-assistant-bookings/), and what ChatGPT does today, on [its page](/assistants/chatgpt/).",
          },
        ],
      },
      {
        id: "fit",
        heading: "How they fit together",
        paras: [],
        list: [
          {
            text: "**People who phone**: a receptionist, AI or human, with your booking system behind it.",
          },
          {
            text: "**Assistants that book for people**: a door on your own domain, your booking platform's or [an agent inbox](/guides/ai-inbox-for-business/).",
          },
          {
            text: "**One calendar under both**, so a time is never given twice.",
          },
          {
            text: "Surfing Dog Inbox (ours, open source) is a door for assistants, not a phone line: it offers free times from your services and opening hours, takes bookings and quote requests, and you, your rules or your own AI confirm each one. It can read your Google Calendar's busy times.",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "What is an AI receptionist?",
        a: "Software that answers a business's phone or chat in words like a person's: it gives hours and prices, takes messages, books from a calendar and passes on what it can't handle.",
      },
      {
        q: "Can an AI receptionist book appointments?",
        a: "Many can, once connected to your calendar or booking system. Ask which ones it writes to, and make a booking yourself before your customers do.",
      },
      {
        q: "Can ChatGPT book an appointment with my business?",
        a: "Through a door it can use: an app, a connector to your MCP server, or your booking platform's agent door. Our free check shows whether your website has one.",
      },
      {
        q: "Do I still need a receptionist if AI assistants can book?",
        a: "For people who call, yes, or someone who answers. A door serves assistants and a receptionist serves people, and both can work from one calendar.",
      },
      {
        q: "Can I stop Google's AI from calling my business?",
        a: "Yes. Turn off Google's automated calls and texts in your Business Profile's advanced settings, or tell the caller to stop calling. Google may still call now and then to confirm your details.",
      },
    ],
    related: [GUIDE.bookings, GUIDE.aiInbox, GUIDE.chatgpt, GUIDE.hotels, GUIDE.onChatgpt],
  },
  {
    slug: "get-your-business-on-chatgpt",
    modified: TOPICS_ADDED,
    title: "How to get your business on ChatGPT and in AI answers",
    heading: "How to get your business on ChatGPT, Gemini and other AI assistants",
    lede: "How assistants find a business as of October 2026, and what you can do about it today.",
    description:
      "How ChatGPT, Gemini and other assistants find businesses: their crawlers, your details as data, doors they can use and the directories they search.",
    answer:
      "Assistants find businesses mostly through search. Let their crawlers read your site, say who you are, where, and what you offer in words and data, and give them a door to book, order or ask. Then add your website where assistants look for businesses.",
    sections: [
      {
        id: "how",
        heading: "How assistants find a business",
        paras: [
          {
            text: "ChatGPT's search reads the web with OpenAI's crawler OAI-SearchBot. A site that keeps it out isn't shown in ChatGPT's search answers, though it can still appear as a link; GPTBot, which gathers pages for training, is a separate setting.",
            sources: [S.openaiBots],
          },
          {
            text: "Google says there are no extra requirements to appear in AI Overviews or AI Mode: a page indexed in Search, and shown with a snippet, can appear, and no special markup or file is needed.",
            sources: [S.googleAi],
          },
          {
            text: "Products take their own path: Google's free listings can show them in Gemini, and Shopify stores that sell to the US reach ChatGPT through agentic storefronts ([AI product search](/guides/ai-product-search/)).",
            sources: [S.merchantFree, S.shopifyChatgpt],
          },
        ],
      },
      {
        id: "do",
        heading: "What to do",
        paras: [],
        list: [
          {
            text: "**Let the crawlers in.** Check that your robots.txt and your firewall let OAI-SearchBot and Googlebot read your pages ([robots.txt and AI agents](/guides/robots-txt-ai-agents/)). OpenAI says a change to robots.txt takes about a day to reach it.",
            sources: [S.openaiBots],
          },
          {
            text: "**Say it in words and in data.** Your name, where you are, your opening hours, your prices and your terms, on your pages and as schema.org markup ([your details as data](/guides/business-details-for-ai/)).",
          },
          {
            text: "**Be the same everywhere.** Your name, address and hours on your site, on your maps listing and on the platforms you use should agree.",
          },
          {
            text: "**Give assistants a door.** Being named is a start; a door lets an assistant ask, book or order for its person ([the checklist](/guides/)).",
          },
        ],
      },
      {
        id: "listed",
        heading: "Directories assistants search",
        paras: [
          {
            text: "A person can add a directory to their assistant as a connector, over MCP. Surfing Dog Search is one: an assistant asks it for a florist or a bike repair nearby, and gets businesses an AI can reach, each with its doors.",
          },
          {
            text: "[Add your website](/add/): listing is free, and nobody can pay for a place. The businesses listed are those an AI can already ask, book or buy from; checking your site shows what an assistant finds there today.",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "How do I get my business on ChatGPT?",
        a: "Let OpenAI's search crawler, OAI-SearchBot, read your site, and say who you are, where, and what you offer in words and schema.org data. For products, go through your shop platform or OpenAI's page for merchants. Then give assistants a door to book or order.",
      },
      {
        q: "How do I get ChatGPT to recommend my business?",
        a: "No setting decides it. ChatGPT's search reads the web, so what helps in search helps there: pages its crawler can read, clear details, and a name, address and hours that agree everywhere.",
      },
      {
        q: "Do I need special markup or an llms.txt to appear in AI answers?",
        a: "Google says no special markup or file is needed for AI Overviews or AI Mode. Markup still lets an assistant read your hours and prices exactly, and an llms.txt file can point an AI to your doors.",
      },
      {
        q: "Can I pay to be listed on Surfing Dog?",
        a: "No. Listing is free, and the directory's order comes from published rules, never from payment.",
      },
    ],
    related: [GUIDE.details, GUIDE.robots, GUIDE.products, GUIDE.aiInbox, GUIDE.receptionist, GUIDE.add],
  },
  {
    slug: "ai-product-search",
    modified: TOPICS_ADDED,
    title: "AI product search: how assistants find your products",
    heading: "AI product search: how ChatGPT, Gemini and AI agents find the products you sell",
    lede: "Where assistants read products as of October 2026, what each path needs from a shop, and an open product search any AI agent can use.",
    description:
      "How AI assistants and agents find products: Google's free listings in Gemini, ChatGPT shopping, UCP catalogues, product markup and an open product search.",
    answer:
      "Assistants find products in the feeds and catalogues shops publish: Google's free listings reach Gemini, Shopify stores reach ChatGPT, and a shop's own catalogue for agents lets one search it directly. Keep names, prices, stock and barcodes right in each, and the same everywhere.",
    sections: [
      {
        id: "where",
        heading: "Where assistants read products",
        paras: [],
        list: [
          {
            text: "**Google**: free listings from Merchant Center can show products at no cost in Search, Maps, Gemini, YouTube, Images and Lens. They are usually on by default, and being shown is never promised.",
            sources: [S.merchantFree],
          },
          {
            text: "**ChatGPT**: eligible Shopify stores that sell to the US are in through agentic storefronts; other shops start at OpenAI's page for merchants ([how to sell on ChatGPT](/guides/sell-on-chatgpt/)).",
            sources: [S.shopifyChatgpt],
          },
          {
            text: "**A shop's own catalogue for agents**: the Universal Commerce Protocol (UCP) covers a catalogue an agent can search, a cart and a checkout, at the shop's own address.",
            sources: [S.ucp],
          },
          {
            text: "**Product markup**: schema.org `Product` and `Offer` in your pages, which search engines and assistants read beside your words.",
            sources: [S.schemaProduct],
          },
        ],
      },
      {
        id: "findable",
        heading: "What makes a product easy to find",
        paras: [],
        list: [
          {
            text: "**A barcode** (GTIN, EAN, UPC or ISBN) where the product has one: it tells an agent that two shops sell the same thing.",
          },
          {
            text: "**A price, a currency and stock**, kept current: an agent that finds a price you no longer charge sends you a disappointed customer.",
          },
          {
            text: "**The same facts everywhere**: in the feed, in the markup and on the page.",
          },
          {
            text: "**A way to order, and to ask.** What the check counts for a shop: [selling through AI assistants](/guides/sell-through-ai-assistants/).",
          },
        ],
      },
      {
        id: "search",
        heading: "An open product search for AI agents",
        paras: [
          {
            text: "Surfing Dog Search has a product search agents call over MCP, at `https://surfingdog.ai/mcp`. `search_products` finds products by words, barcode, brand, place and price; `get_offers` lists every business offering one barcode, each with its price as last checked and its own door to order through. Services are in the business search, `search_businesses`, which matches what each business offers.",
          },
          {
            text: "The same barcode is one product, and products are never matched by name. Listing is free, nothing paid moves an offer, and each takes its business's place in the directory's published order. A product shows only while its business is in the directory and its catalogue was confirmed in the last six hours, and never with a stock count.",
          },
          {
            text: "It is new. Products get into it from a business's own agent inbox: Surfing Dog Inbox (ours, open source) imports the product feed your shop already publishes for Google, and lists those products there unless you switch it off. [Add your website](/add/) to be in the business search.",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "How do AI assistants find products?",
        a: "In the feeds and catalogues shops publish: Google's free listings for Gemini, a shop platform's channel for ChatGPT, a shop's own catalogue for agents, and product markup on its pages. An agent can also search a directory of products, such as Surfing Dog's, over MCP.",
      },
      {
        q: "How do I get my products into ChatGPT?",
        a: "On Shopify, through agentic storefronts, on by default for eligible stores that sell to the US. Other shops start at OpenAI's page for merchants, chatgpt.com/merchants.",
      },
      {
        q: "Do I need barcodes for AI shopping?",
        a: "Not always, but they help: a GTIN, EAN, UPC or ISBN tells an agent that two shops sell the same product, so it can compare prices and stock between them.",
      },
      {
        q: "Can an AI agent search products across many shops?",
        a: "Yes, through a product search made for agents. Surfing Dog's search_products and get_offers, over MCP, find a product and every business offering it, by default in the directory's published order, which nobody can pay to change.",
      },
    ],
    related: [GUIDE.selling, GUIDE.sellChatgpt, GUIDE.commerce, GUIDE.shopify, GUIDE.ap2, GUIDE.onChatgpt],
  },
  {
    slug: "aparecer-en-chatgpt",
    lang: "es",
    of: "get-your-business-on-chatgpt",
    modified: TOPICS_ADDED,
    title: "Cómo hacer que ChatGPT recomiende tu negocio",
    heading: "Cómo aparecer en ChatGPT, Gemini y otros asistentes de IA con tu negocio",
    lede: "Cómo encuentran los asistentes un negocio a octubre de 2026, y qué puedes hacer tú hoy.",
    description:
      "Cómo encuentran negocios ChatGPT, Gemini y otros asistentes de IA: sus rastreadores, tus datos, puertas que puedan usar y los directorios donde buscan.",
    answer:
      "Los asistentes encuentran negocios sobre todo a través de la búsqueda. Deja que sus rastreadores lean tu web, di quién eres, dónde estás y qué ofreces con palabras y datos, y dales una puerta para reservar, pedir o preguntar. Después añade tu web donde los asistentes buscan negocios.",
    sections: [
      {
        id: "como",
        heading: "Cómo encuentra un asistente un negocio",
        paras: [
          {
            text: "La búsqueda de ChatGPT lee la web con OAI-SearchBot, el rastreador de OpenAI. Una web que lo bloquea no aparece en las respuestas de búsqueda de ChatGPT, aunque puede salir como enlace; GPTBot, que recoge páginas para entrenar modelos, se configura aparte.",
            sources: [S.openaiBotsEs],
          },
          {
            text: "Google dice que no hay requisitos adicionales para aparecer en las vistas creadas con IA (AI Overviews) ni en el Modo IA: basta con que la página esté indexada en la Búsqueda y pueda mostrarse con un fragmento, sin marcado ni archivos especiales.",
            sources: [S.googleAiEs],
          },
          {
            text: "Los productos van por otro camino: las fichas gratuitas de Google pueden mostrarlos en Gemini, y las tiendas Shopify que venden a Estados Unidos llegan a ChatGPT a través de sus escaparates agénticos ([búsqueda de productos con IA](/guides/ai-product-search/)).",
            sources: [S.merchantFreeEs, S.shopifyChatgptEs],
          },
        ],
      },
      {
        id: "que-hacer",
        heading: "Qué hacer",
        paras: [],
        list: [
          {
            text: "**Deja entrar a los rastreadores.** Comprueba que tu robots.txt y tu cortafuegos dejan leer tus páginas a OAI-SearchBot y a Googlebot: el [comprobador de rastreadores de IA](/es/check/rastreadores-ia) te lo dice, uno por uno. OpenAI dice que un cambio en robots.txt tarda alrededor de un día en llegarle.",
            sources: [S.openaiBotsEs],
          },
          {
            text: "**Dilo con palabras y con datos.** Tu nombre, dónde estás, tu horario, tus precios y tus condiciones, en tus páginas y como marcado schema.org ([tu horario, precios y condiciones como datos](/guides/business-details-for-ai/)).",
          },
          {
            text: "**Que todo coincida.** Tu nombre, tu dirección y tu horario deben ser los mismos en tu web, en tu ficha de mapas y en las plataformas que uses.",
          },
          {
            text: "**Dales una puerta.** Que te nombren es un comienzo; una puerta deja que un asistente pregunte, reserve o pida por su persona ([la lista de comprobación](/guides/)).",
          },
        ],
      },
      {
        id: "directorios",
        heading: "Directorios donde buscan los asistentes",
        paras: [
          {
            text: "Una persona puede añadir un directorio a su asistente como conector, por MCP. Surfing Dog Search es uno: un asistente le pide una floristería o un taller de bicicletas cerca y recibe negocios con los que una IA puede tratar, cada uno con sus puertas.",
          },
          {
            text: "[Añade tu web](/add/): estar en el directorio es gratis y nadie puede pagar por un puesto. Aparecen los negocios con los que una IA ya puede preguntar, reservar o comprar; revisar tu web te muestra qué encuentra hoy un asistente en ella.",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "¿Cómo hago que mi negocio aparezca en ChatGPT?",
        a: "Deja que OAI-SearchBot, el rastreador de búsqueda de OpenAI, lea tu web, y di quién eres, dónde estás y qué ofreces con palabras y datos schema.org. Para productos, usa tu plataforma de tienda o la página de OpenAI para comerciantes. Después da a los asistentes una puerta para reservar o pedir.",
      },
      {
        q: "¿Cómo hago que ChatGPT recomiende mi negocio?",
        a: "No hay un ajuste que lo decida. La búsqueda de ChatGPT lee la web, así que ayuda lo mismo que en la búsqueda: páginas que su rastreador pueda leer, datos claros, y un nombre, una dirección y un horario que coincidan en todas partes.",
      },
      {
        q: "¿Necesito un marcado especial o un llms.txt para aparecer en las respuestas de la IA?",
        a: "Google dice que no hace falta marcado ni archivo especial para las vistas creadas con IA ni para el Modo IA. Aun así, el marcado permite a un asistente leer tu horario y tus precios con exactitud, y un llms.txt puede señalarle tus puertas.",
      },
      {
        q: "¿Puedo pagar por aparecer en Surfing Dog?",
        a: "No. Estar en el directorio es gratis, y su orden sale de reglas publicadas, nunca de un pago.",
      },
    ],
    related: [
      { label: "Ejemplos de llms.txt", href: "/es/guias/ejemplos-llms-txt/" },
      { label: "Pagos asistidos por IA", href: "/es/guias/pagos-agenticos/" },
      { label: "Cómo vender en ChatGPT", href: "/guides/sell-on-chatgpt/" },
      { label: "Añade tu web", href: "/add/" },
    ],
  },
  {
    slug: "aparecer-no-chatgpt",
    lang: "pt",
    of: "get-your-business-on-chatgpt",
    modified: TOPICS_ADDED,
    title: "Como fazer sua empresa aparecer no ChatGPT",
    heading: "Como fazer o ChatGPT, o Gemini e outros assistentes de IA encontrarem sua empresa",
    lede: "Como os assistentes encontram uma empresa em outubro de 2026, e o que você pode fazer hoje.",
    description:
      "Como o ChatGPT, o Gemini e outros assistentes de IA encontram empresas: os rastreadores, seus dados, portas que eles usam e os diretórios onde buscam.",
    answer:
      "Os assistentes encontram empresas sobretudo pela busca. Deixe os rastreadores deles lerem seu site, diga quem você é, onde está e o que oferece, em palavras e em dados, e dê a eles uma porta para reservar, pedir ou perguntar. Depois adicione seu site onde os assistentes procuram empresas.",
    sections: [
      {
        id: "como",
        heading: "Como um assistente encontra uma empresa",
        paras: [
          {
            text: "A busca do ChatGPT lê a web com o OAI-SearchBot, o rastreador da OpenAI. Um site que o bloqueia não aparece nas respostas de busca do ChatGPT, embora possa aparecer como link; o GPTBot, que coleta páginas para treinar modelos, é uma configuração à parte.",
            sources: [S.openaiBotsPt],
          },
          {
            text: "O Google diz que não há requisitos extras para aparecer nas Visões Gerais criadas por IA (AI Overviews) ou no Modo IA: basta a página estar indexada na Pesquisa e poder aparecer com um snippet, sem marcação nem arquivo especial.",
            sources: [S.googleAiPt],
          },
          {
            text: "Produtos seguem outro caminho: as listagens gratuitas do Google podem mostrá-los no Gemini, e as lojas Shopify que vendem para os Estados Unidos chegam ao ChatGPT pelas vitrines agênticas ([busca de produtos com IA](/guides/ai-product-search/)).",
            sources: [S.merchantFreePt, S.shopifyChatgptPt],
          },
        ],
      },
      {
        id: "o-que-fazer",
        heading: "O que fazer",
        paras: [],
        list: [
          {
            text: "**Deixe os rastreadores entrarem.** Confira se seu robots.txt e seu firewall deixam o OAI-SearchBot e o Googlebot lerem suas páginas: o [verificador de rastreadores de IA](/pt/check/rastreadores-ia) mostra isso, um por um. A OpenAI diz que uma mudança no robots.txt leva cerca de um dia para chegar a ela.",
            sources: [S.openaiBotsPt],
          },
          {
            text: "**Diga em palavras e em dados.** Seu nome, onde você está, seus horários, preços e condições, nas suas páginas e como marcação schema.org ([seus horários, preços e condições como dados](/guides/business-details-for-ai/)).",
          },
          {
            text: "**Mantenha tudo igual.** Nome, endereço e horários devem ser os mesmos no seu site, na sua ficha de mapas e nas plataformas que você usa.",
          },
          {
            text: "**Dê uma porta aos assistentes.** Ser citado é um começo; uma porta deixa um assistente perguntar, reservar ou pedir pela pessoa ([o checklist](/guides/)).",
          },
        ],
      },
      {
        id: "diretorios",
        heading: "Diretórios onde os assistentes buscam",
        paras: [
          {
            text: "Uma pessoa pode adicionar um diretório ao assistente dela como conector, via MCP. O Surfing Dog Search é um deles: um assistente pede uma floricultura ou uma oficina de bicicletas por perto e recebe empresas com as quais uma IA consegue falar, cada uma com suas portas.",
          },
          {
            text: "[Adicione seu site](/add/): estar no diretório é grátis e ninguém pode pagar por uma posição. Aparecem as empresas com as quais uma IA já pode perguntar, reservar ou comprar; verificar seu site mostra o que um assistente encontra nele hoje.",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "Como faço minha empresa aparecer no ChatGPT?",
        a: "Deixe o OAI-SearchBot, o rastreador de busca da OpenAI, ler seu site e diga quem você é, onde está e o que oferece, em palavras e em dados schema.org. Para produtos, use sua plataforma de loja ou a página da OpenAI para lojistas. Depois dê aos assistentes uma porta para reservar ou pedir.",
      },
      {
        q: "Como faço o ChatGPT recomendar minha empresa?",
        a: "Nenhuma configuração decide isso. A busca do ChatGPT lê a web, então ajuda o mesmo que na busca: páginas que o rastreador consegue ler, dados claros e nome, endereço e horários iguais em todo lugar.",
      },
      {
        q: "Preciso de marcação especial ou de um llms.txt para aparecer nas respostas da IA?",
        a: "O Google diz que não é preciso marcação nem arquivo especial para as Visões Gerais criadas por IA ou o Modo IA. Mesmo assim, a marcação deixa um assistente ler seus horários e preços com exatidão, e um llms.txt pode indicar suas portas.",
      },
      {
        q: "Posso pagar para aparecer no Surfing Dog?",
        a: "Não. Estar no diretório é grátis, e a ordem dele vem de regras publicadas, nunca de pagamento.",
      },
    ],
    related: [
      { label: "Exemplos de llms.txt", href: "/pt/guias/exemplos-llms-txt/" },
      { label: "Pagamentos assistidos por IA", href: "/pt/guias/pagamentos-agenticos/" },
      { label: "Como vender no ChatGPT", href: "/guides/sell-on-chatgpt/" },
      { label: "Adicione seu site", href: "/add/" },
    ],
  },
];

/** Where each language's topic guides live: English beside the checklist, the others under their language. */
const TOPIC_DIRS: Readonly<Record<TopicLang, string>> = { en: "/guides/", es: "/es/guias/", pt: "/pt/guias/" };

/** A topic's language. */
export const topicLang = (t: Topic): TopicLang => t.lang ?? "en";

/** A topic guide's address, in its own language's place. */
export function topicHref(slug: string): string {
  const t = TOPICS.find((x) => x.slug === slug);
  return `${TOPIC_DIRS[t ? topicLang(t) : "en"]}${slug}/`;
}

/** The source file that builds a topic's page. */
export const topicFile = (t: Topic): string => `src/pages${topicHref(t.slug).replace(/\/$/, "")}.astro`;

export function topicBySlug(slug: string): Topic {
  const t = TOPICS.find((x) => x.slug === slug);
  if (!t) throw new Error(`src/lib/topics.ts has no "${slug}"`);
  return t;
}

/** Every version of a topic, the English one first: one, unless it is written in other languages too. */
export function topicVersions(t: Topic): Topic[] {
  const root = t.of ?? t.slug;
  return TOPICS.filter((x) => x.slug === root || x.of === root).sort(
    (a, b) => TOPIC_LANGS.indexOf(topicLang(a)) - TOPIC_LANGS.indexOf(topicLang(b)),
  );
}

/**
 * Every version of a topic written in more than one language, absolute, English as the x-default
 * last: the same list in its head and in the sitemap. None for a page in one language.
 */
export function topicAlternates(t: Topic, site = "https://surfingdog.ai"): Alternate[] {
  const versions = topicVersions(t);
  if (versions.length < 2) return [];
  const base = site.replace(/\/+$/, "");
  const en = versions.find((v) => topicLang(v) === "en");
  return [
    ...versions.map((v) => ({ hreflang: topicLang(v), href: `${base}${topicHref(v.slug)}` })),
    ...(en ? [{ hreflang: "x-default" as const, href: `${base}${topicHref(en.slug)}` }] : []),
  ];
}

/** The topic at a path, if one lives there. */
export function topicAt(path: string): Topic | undefined {
  const p = `/${path.replace(/^\/+|\/+$/g, "")}/`;
  return TOPICS.find((t) => topicHref(t.slug) === p);
}

/** Whether a page names WooCommerce®, and so carries Automattic's notice. */
export const namesWoo = (t: Topic): boolean => JSON.stringify(t).includes("WooCommerce");

/** A topic page's structured data: the article, where it sits, and its questions in the page's words. */
export function topicLd(t: Topic, site: string): readonly Record<string, unknown>[] {
  const lang = topicLang(t);
  const words = TOPIC_WORDS[lang];
  const url = new URL(topicHref(t.slug), site).toString();
  const hub = new URL(words.hub.href, site).toString();
  const modified = t.modified ?? TOPICS_MODIFIED;
  return [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: t.heading,
      description: t.description,
      abstract: t.answer,
      ...(lang === "en" ? {} : { inLanguage: lang }),
      datePublished: modified,
      dateModified: modified,
      author: { "@type": "Organization", name: "Surfing Dog", url: site },
      publisher: { "@id": `${site}#org` },
      isPartOf: { "@type": "CollectionPage", name: words.hub.label, url: hub },
      image: new URL("/art/og-network-v1.png", site).toString(),
      mainEntityOfPage: url,
      url,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: DICTS[lang].ui.home, item: site },
        { "@type": "ListItem", position: 2, name: words.hub.label, item: hub },
        { "@type": "ListItem", position: 3, name: t.title, item: url },
      ],
    },
    lang === "en" ? faqPage(t.faqs, url) : { ...faqPage(t.faqs, url), inLanguage: lang },
  ];
}
