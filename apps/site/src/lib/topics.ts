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
/** When the three added on 4 November 2026 were written, and their sources read: true as of their own month. */
export const TOPICS_NOVEMBER = "2026-11-04";

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

/** The topic guides' animated covers, by name: src/components/topic-covers.ts draws each. */
export const TOPIC_COVERS = ["protocols", "pay-routes", "agent-visit"] as const;
export type TopicCover = (typeof TOPIC_COVERS)[number];

export interface Topic {
  readonly slug: string;
  /** The page's language; English when it says none. */
  readonly lang?: TopicLang;
  /** For a page in another language: the slug of the English page it goes with. */
  readonly of?: string;
  /** When it was written, if not with the first three (TOPICS_MODIFIED). */
  readonly modified?: string;
  /** The month it is true as of, as its words write it, when not the frame's (TOPIC_WORDS). */
  readonly month?: string;
  /**
   * Its own explainer, under the heading: the animated cover it shows, what the cover shows in
   * words, and its one idea, which its social card prints beside the cover's rest frame.
   */
  readonly cover?: { readonly anim: TopicCover; readonly alt: string; readonly idea: string };
  /** Its own social card, made from the built page by scripts/og-topic.mjs; the site card when none. */
  readonly og?: string;
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
  // Read for the three guides of November 2026, each in its own documentation.
  acpRepo: src(
    "ACP on GitHub: the specification",
    "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol",
  ),
  acpRelease: src(
    "ACP: version 2026-04-17",
    "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/changelog/2026-04-17.md",
  ),
  acpCheckout: src(
    "ACP: the agentic checkout",
    "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/rfcs/rfc.agentic_checkout.md",
  ),
  openaiPayment: src("OpenAI: the Delegated Payment Spec", "https://developers.openai.com/commerce/specs/payment"),
  ucpOverview: src("UCP: the specification overview", "https://ucp.dev/latest/specification/overview/"),
  ucpRelease: src(
    "UCP on GitHub: release 2026-08-25",
    "https://github.com/Universal-Commerce-Protocol/ucp/releases/tag/v2026-08-25",
  ),
  mcpSpec: src("MCP: the specification", "https://modelcontextprotocol.io/specification/latest"),
  mcpAaif: src(
    "MCP blog: MCP joins the Agentic AI Foundation, 9 December 2025",
    "https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/",
  ),
  mcpCards: src("MCP: SEP-2127, server cards", "https://modelcontextprotocol.io/seps/2127-mcp-server-cards"),
  a2aSpec: src("A2A: the specification", "https://a2a-protocol.org/latest/specification/"),
  a2aAaif: src("AAIF: A2A joins the Agentic AI Foundation, 17 August 2026", "https://aaif.io/blog/a2a-joins-aaif"),
  stripeSpt: src(
    "Stripe Docs: shared payment tokens, for sellers",
    "https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens?agent-seller=seller",
  ),
  stripeMachine: src("Stripe Docs: machine payments", "https://docs.stripe.com/payments/machine"),
  stripeX402: src("Stripe Docs: x402", "https://docs.stripe.com/payments/machine/x402"),
  stripeLinks: src("Stripe Docs: Payment Links", "https://docs.stripe.com/payment-links"),
  mollieLinks: src("Mollie Docs: payment links", "https://docs.mollie.com/docs/payment-links"),
  mpp: src("MPP: the Machine Payments Protocol", "https://mpp.dev/"),
  x402: src("x402", "https://www.x402.org/"),
  x402Repo: src("x402 on GitHub", "https://github.com/x402-foundation/x402"),
  lfX402: src(
    "Linux Foundation: the x402 Foundation, 2 April 2026",
    "https://www.linuxfoundation.org/press/linux-foundation-is-launching-the-x402-foundation-and-welcoming-the-contribution-of-the-x402-protocol",
  ),
  linkAgents: src("Link: a wallet for your agent", "https://link.com/agents"),
  anthropicBots: src(
    "Anthropic: its crawlers",
    "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
  ),
  schemaLocal: src("schema.org: LocalBusiness", "https://schema.org/LocalBusiness"),
  llmstxt: src("llmstxt.org", "https://llmstxt.org/"),
  cfReady: src("Cloudflare: agent readiness, 17 April 2026", "https://blog.cloudflare.com/agent-readiness/"),
  webBotAuth: src(
    "IETF draft: HTTP message signatures for bots",
    "https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth-architecture/",
  ),
  webmcp: src("WebMCP: the Community Group draft", "https://webmachinelearning.github.io/webmcp/"),
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
  protocols: { label: "Agentic commerce protocols", href: "/guides/agentic-commerce-protocols/" },
  payRoutes: { label: "How AI agents pay a business", href: "/guides/how-ai-agents-pay/" },
  agentReady: { label: "What makes a website agent-ready", href: "/guides/agent-ready-website/" },
  findable: { label: "Make your agent doors findable", href: "/guides/findable-agent-doors/" },
  llms: { label: "What llms.txt does, and doesn't", href: "/guides/llms-txt/" },
  readyPost: { label: "Is your website ready for AI agents?", href: "/blog/is-your-website-ready-for-ai-agents/" },
  stripe: { label: "Stripe", href: "/integrations/stripe/" },
  mollie: { label: "Mollie", href: "/integrations/mollie/" },
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
      GUIDE.protocols,
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
    related: [GUIDE.payments, GUIDE.assisted, GUIDE.commerce, GUIDE.products, GUIDE.onChatgpt, GUIDE.payRoutes],
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
            text: "Surfing Dog Inbox (ours, open source) is one, at your own address, such as inbox.yourbusiness.example. Your rules answer the routine requests and you see the rest; your own AI can work it too, through its owner MCP; and [its spam filters](/inbox/spam/), free on your own server or with Pro when we host it, keep sales pitches and scams off your desk without losing a customer. [How it works](/inbox/).",
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
            text: "At I/O in May 2026 Google said people would be able to ask it to call businesses in categories such as home repair, beauty and pet care, and that booking in Search would reach local experiences and services, with links to finish booking with the provider.",
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
    slug: "agentic-commerce-protocols",
    modified: TOPICS_NOVEMBER,
    month: "November 2026",
    title: "Agentic commerce protocols: ACP, UCP, MCP and A2A",
    heading: "Agentic commerce protocols: what ACP, UCP, MCP and A2A each do, and which one you need",
    lede: "The four as of November 2026: who runs each, where an agent finds it, how they stack, and what a business has to do about them.",
    description:
      "What the Agentic Commerce Protocol, UCP, MCP and A2A each do, who runs them, where an agent finds them, and which one a small business needs.",
    answer:
      "The Agentic Commerce Protocol (ACP), from OpenAI and Stripe, and the Universal Commerce Protocol (UCP), co-developed by Google, Shopify and others, describe a checkout an AI agent can use. MCP lets an agent call a business's tools; A2A lets two agents talk. A business usually gets them from its platform.",
    cover: {
      anim: "protocols",
      alt: "A customer's agent and a business, joined by three lanes. A question runs the MCP lane and comes back with free times; a cart runs the checkout lane and comes back as an order; the cart then rides inside the MCP lane; and the business's own agent answers on the A2A lane.",
      idea: "Four protocols, three jobs.\nMost shops get them from their platform.",
    },
    og: "/art/og-agentic-commerce-protocols-v1.png",
    sections: [
      {
        id: "jobs",
        heading: "Four protocols, three jobs",
        paras: [
          {
            text: "They answer different questions. MCP, the Model Context Protocol, is how an agent calls a tool on a server: free times, a booking, a quote. A2A, the Agent2Agent protocol, is how one agent talks to another. ACP and UCP describe shopping: a cart, a checkout and the order. How the money moves sits underneath, in [how AI agents pay](/guides/how-ai-agents-pay/), and the person's signed approval is the [Agent Payments Protocol (AP2)](/guides/agent-payments-protocol/).",
          },
        ],
        list: [
          {
            text: "**ACP, the checkout.** Maintained by OpenAI and Stripe, and in beta; its latest version is 2026-04-17. A seller describes itself at `/.well-known/acp.json`, and the checkout runs over REST or MCP. Open source, under Apache 2.0.",
            sources: [S.acpRepo, S.acpRelease],
          },
          {
            text: "**UCP, the checkout and more of the journey**: a catalogue, a cart, the checkout, identity linking and the order. Co-developed by Google, Shopify and others; its latest release is dated 2026-08-25. A business publishes its profile at `/.well-known/ucp`, and its checkout runs over REST, MCP or A2A, or as the business's own checkout embedded in the agent's app. Under Apache 2.0.",
            sources: [S.ucp, S.ucpOverview, S.ucpRelease],
          },
          {
            text: "**MCP, the tools.** Its current specification is dated 2026-07-28, and since 9 December 2025 it has been a project of the Agentic AI Foundation, under the Linux Foundation. An MCP server card describes a server before an agent connects to it.",
            sources: [S.mcpSpec, S.mcpAaif, S.mcpCards],
          },
          {
            text: "**A2A, agents talking to agents.** Version 1.0.0, and a project of the same foundation since 17 August 2026. An agent describes itself in an agent card at `/.well-known/agent-card.json`, and talks over JSON-RPC, gRPC or HTTP with JSON.",
            sources: [S.a2aSpec, S.a2aAaif],
          },
        ],
      },
      {
        id: "acp",
        heading: "ACP, step by step",
        paras: [
          {
            text: "An ACP checkout is a session the agent opens with the seller. Before it starts, the agent can read the seller's `/.well-known/acp.json`: the address of its API, the versions it speaks, whether it offers REST or MCP, and services such as carts.",
            sources: [S.acpRelease],
          },
          {
            text: "The business stays the seller: the prices, the terms and the order are its own. What happened to ChatGPT's own checkout is in [agentic commerce explained](/guides/agentic-commerce/), and is not repeated here.",
            sources: [S.acp],
          },
        ],
        list: [
          {
            text: "**Products.** In version 2026-04-17 the seller pushes its product records to the agent's platform through a feed, rather than the platform fetching them.",
            sources: [S.acpRelease],
          },
          {
            text: "**Create and update.** The agent creates a session from the items, then updates it with an address and a delivery option. Each time, the seller answers with the session as it now stands, totals included.",
            sources: [S.acpCheckout],
          },
          {
            text: "**Complete.** The agent completes the session with a payment token, and the seller must create an order. OpenAI's Delegated Payment Spec names Stripe's shared payment token as a compatible implementation.",
            sources: [S.acpCheckout, S.openaiPayment],
          },
          {
            text: "**Cancel.** The agent can cancel a session that isn't completed yet.",
            sources: [S.acpCheckout],
          },
        ],
      },
      {
        id: "ucp",
        heading: "UCP: the same job, more of the journey",
        paras: [
          {
            text: "UCP covers the steps around the checkout too: a catalogue to search, a cart, linking a buyer's account with OAuth 2.0, and the order afterwards. Before a checkout, the business compares what it supports with what the agent's platform supports, and keeps only what both do, each at the highest version both know.",
            sources: [S.ucp, S.ucpOverview],
          },
          {
            text: "Payment goes through payment handlers the business lists in its profile, Google Pay or Shop Pay for example, and an extension carries AP2 mandates. Its lodging part is a draft, with Booking.com, Expedia, Marriott and others among its co-developers ([AI hotel booking](/guides/ai-hotel-booking/)).",
            sources: [S.ucp, S.ucpOverview],
          },
          {
            text: "Shopify publishes a UCP profile for eligible stores, so their owners build nothing ([Shopify and AI assistants](/guides/shopify-ai-assistants/)).",
          },
        ],
      },
      {
        id: "mcp",
        heading: "MCP: a door that isn't only for shops",
        paras: [
          {
            text: "Most businesses don't sell from a cart. A salon books, a plumber quotes, a guesthouse answers questions. An MCP server offers whatever tools the business has: free times and a booking, a quote request, a message. What the check counts for each is in [the bookings guide](/guides/ai-assistant-bookings/) and [the guide to messages and quotes](/guides/ai-assistant-messages-and-quotes/).",
          },
          {
            text: "The protocols stack rather than compete. ACP has an MCP binding, and UCP's checkout, cart, catalogue and order run over MCP as well as REST, so one MCP server can carry a shop's checkout beside its other tools.",
            sources: [S.acpRelease, S.ucpOverview],
          },
        ],
      },
      {
        id: "a2a",
        heading: "A2A: when the business has an agent of its own",
        paras: [
          {
            text: "A2A is for an agent that works with other agents as a peer, rather than offering a list of tools. Its agent card says who it is, what it can do, where to reach it and how a caller signs in.",
            sources: [S.a2aSpec],
          },
          {
            text: "A business needs one only if it runs an AI agent of its own, one that plans or negotiates with other agents; AP2 builds on A2A. A business that answers questions, bookings or orders is served by an MCP door or its platform's checkout.",
            sources: [S.ap2],
          },
        ],
      },
      {
        id: "which",
        heading: "Which one you need",
        paras: [
          {
            text: "You don't implement these yourself: you choose a platform, or a door, that publishes them.",
          },
        ],
        list: [
          {
            text: "**Products, on a shop platform**: the platform's UCP or ACP checkout. WooCommerce® lists both as coming soon; ask yours what it publishes, and where.",
            sources: [S.woo],
          },
          {
            text: "**Services and bookings**: an MCP door with tools that finish the job. Surfing Dog Inbox (ours, open source) is one, at an address on your own domain ([what it connects to](/integrations/)).",
          },
          {
            text: "**Your own AI agent**: an A2A agent card, beside your MCP door.",
          },
          {
            text: "**APIs and data, paid per call**: payment inside the request, in [how AI agents pay](/guides/how-ai-agents-pay/).",
          },
        ],
      },
      {
        id: "see",
        heading: "How to see which ones a site publishes",
        paras: [
          {
            text: "Each has an address on the business's own domain: `/.well-known/acp.json`, `/.well-known/ucp`, `/.well-known/agent-card.json`, and for MCP a server card or a link from the site ([where readers look](/guides/findable-agent-doors/)). The [UCP and ACP checker](/check/ucp) and the [MCP server tester](/check/mcp-server) read them for you; [the full check](/check) reads them all, and [the agent-ready checklist](/guides/agent-ready-website/) puts them in order.",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "What is the Agentic Commerce Protocol?",
        a: "An open standard for an AI agent's checkout with a business, maintained by OpenAI and Stripe and still in beta. The agent opens a checkout session, updates it, and completes it with a payment token; the business creates the order. Its latest version is 2026-04-17.",
      },
      {
        q: "Do I need both ACP and UCP?",
        a: "Not by hand. Both describe a checkout an agent can use, and a shop platform that publishes both covers both: ask yours which it publishes. A business that books or quotes rather than selling products may need neither, and an MCP door instead.",
      },
      {
        q: "What is the difference between MCP and A2A?",
        a: "MCP is how an agent calls tools on a server: list free times, book, ask for a quote. A2A is how two agents talk as peers, each with an agent card that says what it can do. A business offers MCP tools to customers' assistants, and needs A2A only if it runs an agent of its own.",
      },
      {
        q: "Can UCP or ACP run over MCP?",
        a: "Yes. ACP added an MCP binding in its 2026-04-17 version, and UCP's checkout, cart, catalogue and order can run over MCP as well as REST. A business can carry its checkout and its other tools on one MCP server.",
      },
      {
        q: "Which agentic commerce protocol does a small shop need?",
        a: "Usually the one its platform publishes: Shopify publishes a UCP profile for eligible stores, and elsewhere ask your platform about UCP and ACP. For questions, quotes, returns and bookings, add an MCP door. Our free check shows which doors your site has today.",
      },
    ],
    related: [
      GUIDE.commerce,
      GUIDE.payRoutes,
      GUIDE.agentReady,
      GUIDE.ap2,
      GUIDE.findable,
      GUIDE.shopify,
      GUIDE.integrations,
    ],
  },
  {
    slug: "how-ai-agents-pay",
    modified: TOPICS_NOVEMBER,
    month: "November 2026",
    title: "How AI agents pay a business: links, tokens and x402",
    heading: "How an AI agent pays a business: four ways the money moves, and what you need for each",
    lede: "The four routes as of November 2026: who says yes, what the agent holds, where the money lands, and what a business needs for each.",
    description:
      "Four ways an AI agent pays a business: a payment link, Stripe's shared payment tokens, payment inside the request with x402 or MPP, or your own checkout.",
    answer:
      "An AI agent pays a business in one of four ways: a payment link its person pays; a Stripe shared payment token, limited to one seller and an amount; payment inside the request, with x402 or MPP; or a checkout made for agents. Each lands in the business's own account.",
    cover: {
      anim: "pay-routes",
      alt: "A customer's agent and a business's account, joined by four roads. A link passes through the person's phone; a token limited to one seller, one amount and an expiry travels; a request is answered 402 and comes back with a coin; a cart passes through a checkout. The account ticks after each.",
      idea: "Four ways an agent pays.\nAll of them land in your account.",
    },
    og: "/art/og-how-ai-agents-pay-v1.png",
    sections: [
      {
        id: "routes",
        heading: "Four routes, side by side",
        paras: [
          {
            text: "What [AI agent-assisted payment](/guides/ai-agent-assisted-payments/) means, and the names of the standards, have a page of their own. This one follows the money: for each route, who says yes, what the agent holds, and where the money lands.",
          },
        ],
        list: [
          {
            text: "**A payment link.** The person says yes by paying on your checkout page. The agent holds only the link. The money lands in your own Stripe, Mollie or other account.",
            sources: [S.stripeLinks, S.mollieLinks],
          },
          {
            text: "**A shared payment token.** The person says yes in their agent or wallet. The agent holds a token limited to your Stripe profile, an amount, a currency and an expiry. You charge it like a card, into your Stripe account.",
            sources: [S.stripeSpt],
          },
          {
            text: "**Payment inside the request.** The agent pays your server's price per call, with x402 or MPP, from a wallet or a card token it was given. The money lands in your Stripe balance or your own wallet.",
            sources: [S.stripeMachine, S.x402],
          },
          {
            text: "**An agent at your checkout.** The person says yes through the agent's platform. The agent holds a token or a mandate. The money lands through your own payment provider, reached through your shop platform.",
          },
        ],
      },
      {
        id: "link",
        heading: "Route 1: the payment link",
        paras: [
          {
            text: "Your door, or you, creates a link in your own payment account; the agent hands it to its person, who pays on your checkout page. Stripe's and Mollie's can both be made through their APIs, and a Mollie link can carry an amount, a description and an expiry date.",
            sources: [S.stripeLinks, S.mollieLinks],
          },
          {
            text: "Nothing about it is new, and that is its strength. It works with every assistant today, the agent never holds a card, and refunds and receipts work as they always have. The cost is one step: the person has to open the link and pay.",
          },
          {
            text: "Surfing Dog Inbox (ours, open source) sends one from your own [Stripe](/integrations/stripe/) or [Mollie](/integrations/mollie/) account when you accept an order, and the money goes straight to you.",
          },
        ],
      },
      {
        id: "tokens",
        heading: "Route 2: Stripe's shared payment tokens",
        paras: [
          {
            text: "The person picks a card or a wallet in their agent. The agent asks Stripe for a shared payment token granted to your Stripe profile, with limits: a currency, a maximum amount set to the order's total, and an expiry. It sends you the token, and you charge it with a PaymentIntent, passing it as `payment_method_data[shared_payment_granted_token]`.",
            sources: [S.stripeSpt],
          },
          {
            text: "You see the card's brand and its last four digits, never its number. Once you charge it, refunds and reporting behave as for any card payment, and Stripe tells you when a token is used up, expires or is revoked. If you take payments with another processor, Stripe's Resolve API turns the token into card credentials for it, once.",
            sources: [S.stripeSpt],
          },
          {
            text: "Shared payment tokens come under Stripe's agentic commerce preview terms, for sellers in the US, Canada and select European countries. Through Stripe's machine payments, a card payment made this way is at least 0.50 USD.",
            sources: [S.stripeSpt, S.stripeMachine],
          },
          {
            text: "This is how the Agentic Commerce Protocol (ACP) pays a seller on Stripe: OpenAI's Delegated Payment Spec names Stripe's token as a compatible implementation, with more payment providers to come.",
            sources: [S.openaiPayment],
          },
        ],
      },
      {
        id: "x402",
        heading: "Route 3: payment inside the request, with x402 or MPP",
        paras: [
          {
            text: "Here the agent pays as part of the request itself. Your server answers HTTP 402, Payment Required, with what the call costs; the agent pays and asks again with proof of payment; your server returns what was asked for. On Stripe, the 402 answer carries a `payment-required` header.",
            sources: [S.stripeX402],
          },
          {
            text: "x402 is an open protocol, under Apache 2.0. On 2 April 2026 the Linux Foundation announced the x402 Foundation to govern it, with the protocol contributed by Coinbase. On Stripe it takes USDC on Base, settled through Coinbase's facilitator and recorded in your Stripe balance.",
            sources: [S.x402Repo, S.lfX402, S.stripeX402],
          },
          {
            text: "MPP, the Machine Payments Protocol, co-authored by Stripe and Tempo, works the same way and takes cards, through shared payment tokens, as well as stablecoins.",
            sources: [S.mpp, S.stripeMachine],
          },
          {
            text: "On Stripe, stablecoin payments are open to businesses in every US state except New York, and in more than 30 other countries on request; the smallest is 0.01 USDC. That suits APIs, data and paid tools, charged per call, more than a haircut or a sofa.",
            sources: [S.stripeMachine],
          },
        ],
      },
      {
        id: "checkout",
        heading: "Route 4: an agent at your checkout",
        paras: [
          {
            text: "When an assistant checks out in the chat, the payment travels inside a checkout made for agents: the payment handlers of the Universal Commerce Protocol (UCP), ACP's delegated payment, Agent Payments Protocol (AP2) mandates, or the card networks' agent tokens. Stripe says it may use tokens from the card networks' programmes, such as Mastercard Agent Pay and Visa Intelligent Commerce, on a seller's behalf.",
            sources: [S.ucpOverview, S.stripeSpt],
          },
          {
            text: "You reach these through your shop platform or payment provider, not one by one. Which protocol does what is in [agentic commerce protocols](/guides/agentic-commerce-protocols/); mandates, in [the AP2 guide](/guides/agent-payments-protocol/); what our check counts as paying, in [how AI assistants pay](/guides/ai-assistant-payments/).",
          },
        ],
      },
      {
        id: "build",
        heading: "If you're building the agent",
        paras: [
          {
            text: "Never give it a card number. Give it a credential made for agents, or let it pass on a link. In practice, adding payments to an AI agent means one of these:",
          },
        ],
        list: [
          {
            text: "**A wallet that issues limited credentials.** Link's wallet for agents lets a person approve each purchase or a budget, and the agent buys without seeing the card; it is available in the US, with a waitlist elsewhere. Its `link-cli` can run as an MCP server in your agent.",
            sources: [S.linkAgents, S.stripeSpt],
          },
          {
            text: "**An x402 or MPP client**, to pay per call: the agent answers a server's 402 from a wallet you fund.",
            sources: [S.x402, S.mpp],
          },
          {
            text: "**A payment link**, when the business sends one: the agent passes it on, and its person pays.",
          },
        ],
      },
      {
        id: "need",
        heading: "What you need, route by route",
        paras: [],
        list: [
          {
            text: "**For a payment link**: an account with a provider that makes them, such as [Stripe](/integrations/stripe/) or [Mollie](/integrations/mollie/), and a door that sends one when you accept an order.",
          },
          {
            text: "**For shared payment tokens**: a Stripe account with a Stripe profile, in a country where they are offered, and a checkout or a door that takes a token.",
          },
          {
            text: "**For x402 or MPP**: an API or a tool worth paying for per call, and a provider or a wallet that settles it.",
          },
          {
            text: "**For an agent at your checkout**: a shop platform or provider that publishes one. The [UCP and ACP checker](/check/ucp) shows what yours publishes.",
          },
          {
            text: "**For all of them**: say how you take payment, in words on your site, and add `paymentAccepted` to your business data ([your details as data](/guides/business-details-for-ai/)). The rest of the list is in [what makes a website agent-ready](/guides/agent-ready-website/).",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "How do AI agents pay for things?",
        a: "In one of four ways: the agent hands its person a payment link; it passes a limited token, such as Stripe's shared payment token; it pays inside the request with x402 or MPP; or it pays through a checkout made for agents. In none of them should the agent hold a card number.",
      },
      {
        q: "What is a Stripe shared payment token?",
        a: "A credential an agent gets from Stripe and passes to a seller. It lets that one seller charge the person's card or wallet, up to a maximum amount, in one currency, before an expiry. The seller sees the card's brand and last four digits, and charges it with a PaymentIntent.",
      },
      {
        q: "What is x402?",
        a: "An open protocol for paying over HTTP: a server answers 402 Payment Required with a price, and the client pays and asks again. Coinbase contributed it to the Linux Foundation's x402 Foundation, and it is used mostly with stablecoins such as USDC.",
      },
      {
        q: "Do I need crypto to be paid by an AI agent?",
        a: "No. A payment link and Stripe's shared payment tokens are ordinary card and wallet payments. Stablecoins come in only with x402, and MPP takes cards too.",
      },
      {
        q: "How do I add payments to an AI agent?",
        a: "Never give it a card number. Use a wallet that issues limited credentials to agents, such as Link's, an x402 or MPP client to pay per call, or let the agent pass a business's payment link to its person.",
      },
    ],
    related: [
      GUIDE.assisted,
      GUIDE.payments,
      GUIDE.ap2,
      GUIDE.protocols,
      GUIDE.agentReady,
      GUIDE.stripe,
      GUIDE.mollie,
      GUIDE.inbox,
    ],
  },
  {
    slug: "agent-ready-website",
    modified: TOPICS_NOVEMBER,
    month: "November 2026",
    title: "Agent-ready website: what it means, and a checklist",
    heading: "What makes a website agent-ready: a checklist in the order an agent meets it",
    lede: "As of November 2026: the addresses an AI agent asks for, what a good answer looks like, and how to test each one yourself.",
    description:
      "What an agent-ready website is, and a checklist in the order an AI agent meets it: let it in, let it understand, let it act, let it follow up. Free check.",
    answer:
      "An agent-ready website is one an AI agent can read and use: it lets the agent in, says what the business is as data, and offers a door, such as an MCP server or a checkout, where the agent can ask, book, order or pay, then change or cancel.",
    cover: {
      anim: "agent-visit",
      alt: "An agent rides a line through four stations: let in, where a closed gate opens; understand, where scattered dashes settle into fields; act, where a booking comes back with a reference; and follow up, where a loop takes it back and the booking moves to 11:00.",
      idea: "Let it in, let it understand, let it act.\nThen let it change its mind.",
    },
    og: "/art/og-agent-ready-website-v1.png",
    sections: [
      {
        id: "ready",
        heading: "Readable isn't the same as ready",
        paras: [
          {
            text: "A site an AI can read is a brochure: the assistant learns about you, and books somewhere else. A site that is ready lets the assistant finish the job its person gave it. [Is your website ready for AI agents?](/blog/is-your-website-ready-for-ai-agents/) explains the two questions and compares two free checks. This page is the list, in the order an agent meets it, with a test for each step.",
          },
        ],
      },
      {
        id: "in",
        heading: "1. Let it in",
        paras: [],
        list: [
          {
            text: "**`/robots.txt` lets the assistants' search and user agents in**: OpenAI's OAI-SearchBot and ChatGPT-User, Anthropic's Claude-SearchBot and Claude-User. GPTBot and ClaudeBot gather pages for training, and are separate settings. Test: [the AI crawler checker](/check/ai-crawlers) shows which line decides each one ([robots.txt and AI agents](/guides/robots-txt-ai-agents/)).",
            sources: [S.openaiBots, S.anthropicBots],
          },
          {
            text: "**Nothing stops it at the door**: no bot blocking or challenge page at your host or firewall for the agents you want. Test: ask an assistant to open your homepage and read out your opening hours, and ask your host what it blocks.",
          },
          {
            text: "**Prices and hours in the HTML itself**, not filled in later by scripts that many crawlers never run. Test: View Page Source, and search for one of your prices ([can AI read your website?](/blog/can-ai-read-your-website/)).",
          },
        ],
      },
      {
        id: "understand",
        heading: "2. Let it understand",
        paras: [],
        list: [
          {
            text: "**Your details as data**: schema.org `LocalBusiness` markup with your name, address, opening hours, `priceRange` and `paymentAccepted`. Test: search the source for `application/ld+json` ([your details as data](/guides/business-details-for-ai/)).",
            sources: [S.schemaLocal],
          },
          {
            text: "**Your terms in plain words**: cancellation, refunds, deposits and delivery, on your own pages. An agent reads them before it commits its person.",
          },
          {
            text: "**An `/llms.txt`**, with a line for each door. It helps an agent read your site and find your doors; it isn't a door itself. Test: [the llms.txt checker](/check/llms-txt) ([what llms.txt does, and doesn't](/guides/llms-txt/)).",
            sources: [S.llmstxt],
          },
          {
            text: "**Markdown when an agent asks for it**, if your host offers it: a page that answers `Accept: text/markdown` with a Markdown version of itself. Cloudflare's agent readiness scanner checks for it.",
            sources: [S.cfReady],
          },
        ],
      },
      {
        id: "act",
        heading: "3. Let it act",
        paras: [],
        list: [
          {
            text: "**A door on your own domain**: an MCP server, a Universal Commerce Protocol (UCP) or Agentic Commerce Protocol (ACP) checkout profile, an OpenAPI document or an agent inbox. Pages, forms and email are made for people, so they aren't doors. Test: [the MCP server tester](/check/mcp-server), [the UCP and ACP checker](/check/ucp) or [the agent inbox checker](/check/agent-inbox).",
          },
          {
            text: "**A door an agent can find**: a well-known address such as `/.well-known/agent-card.json` or `/.well-known/ucp`, an AI catalog at `/.well-known/ai-catalog.json`, or `<link rel=\"mcp\">` on your homepage. MCP's server card describes a server before an agent connects, and an AI catalog lists a domain's cards ([where readers look](/guides/findable-agent-doors/)).",
            sources: [S.mcpCards],
          },
          {
            text: "**Tools that finish the job**: free times, and a booking that comes back with a reference; a quote request with the details you need; an order. A tool that only emails you leaves the agent waiting ([bookings](/guides/ai-assistant-bookings/), [messages and quotes](/guides/ai-assistant-messages-and-quotes/), [selling](/guides/sell-through-ai-assistants/)).",
          },
          {
            text: "**A way to pay**, or a payment link: the four routes are in [how AI agents pay a business](/guides/how-ai-agents-pay/), and the protocols behind the doors in [agentic commerce protocols](/guides/agentic-commerce-protocols/).",
          },
        ],
      },
      {
        id: "follow",
        heading: "4. Let it follow up",
        paras: [],
        list: [
          {
            text: "**Change, cancel, return and track**, as tools beside the booking or the order. People change their minds, and they ask the assistant that booked. Test: ask an assistant to move the booking it just made.",
          },
        ],
      },
      {
        id: "emerging",
        heading: "Emerging, and worth watching",
        paras: [],
        list: [
          {
            text: "**Web Bot Auth**: an IETF draft in which an agent signs each request, so a site or its firewall can tell a real assistant from a scraper that borrows its name.",
            sources: [S.webBotAuth, S.cfReady],
          },
          {
            text: "**WebMCP**: a draft from the W3C's Web Machine Learning Community Group, not a W3C standard, for a page to offer tools to an agent in the browser. The draft is dated 2 November 2026; our check reads WebMCP tools as experimental.",
            sources: [S.webmcp],
          },
          {
            text: "**Content signals**: lines in robots.txt that say whether your pages may be used for search, as input to AI answers, or for training.",
            sources: [S.cfReady],
          },
        ],
      },
      {
        id: "visit",
        heading: "What a finished visit looks like",
        paras: [
          {
            text: "A person asks their assistant to book a haircut at a salon on Saturday morning. The assistant reads the salon's site, finds its MCP server, and lists its tools. It asks for Saturday's free times, books 10:00, and gets back a confirmation with a reference, which it shows its person. On Friday the person asks to make it later; the assistant calls the salon's reschedule tool with that reference, and gets 11:00.",
          },
        ],
      },
      {
        id: "check",
        heading: "Check yours",
        paras: [
          {
            text: "[Our free check](/check) reads your site the way an assistant would: it never runs JavaScript, and never books, orders or pays. It ends in a score from 0 to 100, by [published rules](/guides/#score). One thing at a time: [AI crawlers](/check/ai-crawlers), [llms.txt](/check/llms-txt), [an MCP server](/check/mcp-server), [a UCP or ACP profile](/check/ucp) and [an agent inbox](/check/agent-inbox).",
          },
          {
            text: "If you'd rather not build a door, Surfing Dog Inbox (ours, open source) is one at an address on your own domain, with an MCP server that answers from your rules ([how it works](/how-it-works/)).",
          },
        ],
      },
    ],
    faqs: [
      {
        q: "What is an agent-ready website?",
        a: "One an AI agent can read and use. It lets the agent in, says what the business is as data, and offers a door, such as an MCP server or a checkout, where the agent can ask, book, order or pay, and then change or cancel.",
      },
      {
        q: "Does llms.txt make my site agent-ready?",
        a: "Not on its own. An llms.txt file helps an agent read your site and points it to your doors, but it isn't a door: an agent can't book, order or pay through it.",
      },
      {
        q: "How do I check if my website is agent-ready?",
        a: "Run our free check, which reads your site the way an assistant would and never runs JavaScript or books anything. Then ask an assistant to do what your customers want, with your name in it, and see where it stops.",
      },
      {
        q: "Do I need to rebuild my website to make it agent-ready?",
        a: "Usually not. Most steps are settings and files: robots.txt, markup for your details, an llms.txt. The door can come from your booking or shop platform, or sit beside your site at an address on your own domain.",
      },
      {
        q: "What is the difference between AI-ready and agent-ready?",
        a: "AI-ready usually means an AI can read your site and name you in its answers. Agent-ready goes further: a customer's assistant can do something there for its person, such as book, order or pay, and get an answer it can act on.",
      },
    ],
    related: [
      GUIDE.robots,
      GUIDE.details,
      GUIDE.llms,
      GUIDE.findable,
      GUIDE.bookings,
      GUIDE.protocols,
      GUIDE.payRoutes,
      GUIDE.readyPost,
    ],
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

/** The month a topic is true as of: its own, or its language's frame's. */
export const topicMonth = (t: Topic): string => t.month ?? TOPIC_WORDS[topicLang(t)].month;

/** The line over a topic's sources, dated by its own month. */
export const topicSources = (t: Topic): string => {
  const w = TOPIC_WORDS[topicLang(t)];
  return t.month ? w.sources.replace(w.month, t.month) : w.sources;
};

/** The site's card, for a topic without one of its own. */
const SITE_CARD = "/art/og-network-v1.png";

/** A topic's social card, and what it shows in words: its title and its one idea. */
export function topicCard(t: Topic): { image: string; imageAlt?: string } {
  if (!t.og || !t.cover) return { image: SITE_CARD };
  return { image: t.og, imageAlt: `${t.title}. ${t.cover.idea.replace(/\n/g, " ")}` };
}

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
      image: new URL(topicCard(t).image, site).toString(),
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
