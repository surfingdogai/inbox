import type { Faq, Source } from "./faq";

/**
 * The AI assistants a business's inbox works with, as their makers ship them. Every step and every
 * status here was checked against the assistant's own help or the maker's announcement on the date
 * below; the pages say so, and link there. Nothing is claimed that the inbox cannot do today.
 */
export const CHECKED = "30 September 2026";

/**
 * When what each assistant does with businesses (its `owner` section) was last read against its
 * maker's own pages, or a report where the maker has none we can read. These things move monthly,
 * so the page says "as of" this month and names its sources beside each line.
 */
export const OWNER_CHECKED = "12 October 2026";
export const OWNER_AS_OF = "as of October 2026";

/** One thing an assistant does with businesses today, and where we read it. */
export interface OwnerFact {
  readonly text: string;
  readonly sources: readonly Source[];
}

/** The owner's question about an assistant, answered: what it does today, and the questions asked. */
export interface Owner {
  /** The section's heading: the question an owner searches for. */
  readonly question: string;
  readonly does: readonly OwnerFact[];
  /** Shown folded on the page, and given as its FAQPage data in the same words. */
  readonly faqs: readonly Faq[];
}

export interface Assistant {
  readonly slug: string;
  readonly name: string;
  /** What owners call it in a sentence: "ChatGPT", "Copilot", "Muse". */
  readonly short: string;
  readonly maker: string;
  /** The page's title and heading: what someone searches for. */
  readonly title: string;
  readonly heading: string;
  readonly description: string;
  readonly lede: string;
  /** How a person adds a remote MCP server as a connector. */
  readonly addSteps: readonly string[];
  /** Sign-in the assistant supports for a connector that needs one. */
  readonly signIn: string;
  /** Which plans can add a custom connector. */
  readonly plans: string;
  /** Anything the reader should know that is particular to this assistant. */
  readonly notes: readonly string[];
  readonly source: { readonly label: string; readonly href: string };
  /** A blog post about this assistant and small businesses, when there is one. */
  readonly post?: { readonly label: string; readonly href: string };
  /** Can it book or buy with a business, and how: for the owner who asks. */
  readonly owner: Owner;
}

/** Where the owner sections read what each assistant does: makers' pages first, reports where not. */
const SRC = {
  openaiNotes: {
    label: "OpenAI: ChatGPT release notes",
    href: "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
  },
  tablesReport: {
    label: "Android Authority, August 2026",
    href: "https://www.androidauthority.com/chatgpt-restaurant-reservations-and-waitlists-3696712/",
  },
  openaiShopping: {
    label: "OpenAI: powering product discovery in ChatGPT",
    href: "https://openai.com/index/powering-product-discovery-in-chatgpt/",
  },
  checkoutReport: {
    label: "TechCrunch, 24 March 2026",
    href: "https://techcrunch.com/2026/03/24/openais-plans-to-make-chatgpt-more-like-amazon-arent-going-so-well/",
  },
  openaiApps: { label: "OpenAI: apps in ChatGPT", href: "https://openai.com/index/introducing-apps-in-chatgpt/" },
  openaiDots: { label: "OpenAI: introducing dots", href: "https://openai.com/index/introducing-dots/" },
  shopifyChatgpt: {
    label: "Shopify Help Center: ChatGPT",
    href: "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/chatgpt",
  },
  googleUk: {
    label: "Google: AI Mode restaurant bookings in the UK",
    href: "https://blog.google/company-news/inside-google/around-the-globe/google-europe/united-kingdom/ai-mode-restaurants-uk/",
  },
  diningReport: {
    label: "9to5Google, 10 April 2026",
    href: "https://9to5google.com/2026/04/10/google-ai-mode-redesign/",
  },
  geminiApps: {
    label: "Google: new connected apps in Gemini",
    href: "https://blog.google/innovation-and-ai/products/gemini-app/new-connected-apps-services-gemini-august-2026/",
  },
  googleIo: {
    label: "Google: Search at I/O 2026",
    href: "https://blog.google/products-and-platforms/products/search/search-io-2026/",
  },
  googleUcp: { label: "Google: UCP for merchants", href: "https://developers.google.com/merchant/ucp" },
  shopifyGoogle: {
    label: "Shopify Help Center: Google AI Mode and Gemini",
    href: "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/google",
  },
  resy: {
    label: "Resy: Resy restaurants in Claude",
    href: "https://blog.resy.com/newsroom/resy-restaurants-claude-anthropic/",
  },
  claudeConnectors: {
    label: "Claude Help Center: custom connectors",
    href: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  },
  claudeChrome: {
    label: "Claude: Claude in Chrome is generally available",
    href: "https://claude.com/blog/claude-in-chrome-generally-available",
  },
  claudeCommerce: {
    label: "Claude: building commerce agents",
    href: "https://claude.com/resources/articles/claude-for-commerce-agents",
  },
  copilotCheckout: {
    label: "Microsoft Advertising: Copilot Checkout",
    href: "https://about.ads.microsoft.com/en/blog/post/january-2026/conversations-that-convert-copilot-checkout-and-brand-agents",
  },
  shopifyCopilot: {
    label: "Shopify Help Center: Microsoft Copilot",
    href: "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/microsoft",
  },
  copilotActions: {
    label: "Microsoft: Copilot Actions",
    href: "https://blogs.microsoft.com/blog/2025/04/04/your-ai-companion/",
  },
  copilotStudio: {
    label: "Microsoft Learn: MCP in Copilot Studio",
    href: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent",
  },
  muse: { label: "Meta: introducing Muse", href: "https://about.fb.com/news/2026/09/introducing-muse" },
  museReport: {
    label: "TechCrunch, 23 September 2026",
    href: "https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/",
  },
  shopifyMeta: {
    label: "Shopify Help Center: Meta",
    href: "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/meta",
  },
  musePlatform: { label: "Meta: the Muse developer platform", href: "https://muse.ai/platform" },
  grokBot: { label: "xAI: Grok Bot documentation", href: "https://docs.x.ai/grok-bot/teams-and-enterprises" },
  grokConnectors: { label: "xAI: Grok connectors", href: "https://docs.x.ai/grok/connectors" },
  museCanada: {
    label: "iPhone in Canada, 18 September 2026",
    href: "https://www.iphoneincanada.ca/2026/09/18/metas-muse-ai-agent-is-now-available-in-canada/",
  },
} satisfies Record<string, Source>;

export const ASSISTANTS: readonly Assistant[] = [
  {
    slug: "meta-muse",
    name: "Meta Muse",
    short: "Muse",
    maker: "Meta",
    title: "Can Meta Muse book or order with your business? · Surfing Dog",
    heading: "Your business in Meta Muse",
    description:
      "What Meta Muse can book and buy as of October 2026, how it reaches a business, and how to add your inbox as a custom connector. Free check of your site.",
    lede: "Muse is Meta's personal AI agent. When someone asks it to book the bike in for a service or get three quotes for a boiler, it needs a way into the business. Your inbox is that way in, in your name and with your rules.",
    addSteps: [
      "Muse works with the services it has connectors for, and a person can ask it to use one it doesn't: give it your inbox's address, https://inbox.yourdomain.com.",
      "Muse can build a custom connector from what a service publishes. Your inbox publishes its API description (/openapi.json) and an MCP server (/mcp) for exactly that.",
      "Meta's own directory lists connectors it has reviewed. That is a separate submission to Meta; until a business is listed there, Muse reaches it as a custom connector.",
    ],
    signIn:
      "Custom connectors use your inbox's public MCP server, which needs no sign-in: a customer's request lands as a booking, quote request, order or message.",
    plans: "Muse and its directory are available in the US and Canada; custom connectors follow Meta's roll-out.",
    notes: [
      "Meta does not review custom connectors. Your inbox is built for that: every request goes through your rules, a priced booking or order binds nobody until the person confirmed its summary, and nothing reaches your calendar without a state you can see.",
    ],
    source: { label: "Meta: the Muse developer platform", href: "https://muse.ai/platform" },
    post: { label: "Muse for Small Business, and your customers' Muse", href: "/blog/muse-for-small-business/" },
    owner: {
      question: "Can Meta Muse book or order with your business?",
      does: [
        {
          text: "Muse launched in the US on 8 September 2026, and in Canada on 18 September. It works in a browser of its own on a secure computer, uses the apps its person connects, and checks with its person before a purchase; it can pay with Link, by Stripe.",
          sources: [SRC.muse, SRC.museCanada],
        },
        {
          text: "Reported on 23 September 2026: Muse searches Shopify's catalogue and buys with Link or Shop Pay; booking an appointment by voice on Meta's glasses is to follow.",
          sources: [SRC.museReport],
        },
        {
          text: "Shopify stores that sell to the US, Canada or Mexico get a direct checkout on Meta's apps, Muse among them once it is available there.",
          sources: [SRC.shopifyMeta],
        },
        {
          text: "Meta reviews the connectors businesses submit for its directory, and lists them in Muse once approved.",
          sources: [SRC.musePlatform],
        },
      ],
      faqs: [
        {
          q: "Can Meta Muse book appointments?",
          a: "Yes, through the apps its person connects or its own browser, checking with them before anything sensitive. A page made for people is slow for it; a door on your own site, such as an MCP server or an agent inbox, lets it finish. Our free check shows which doors your site offers.",
        },
        {
          q: "Can Muse buy things for you?",
          a: "Yes, in the US. It can search Shopify's catalogue and pay with Link or Shop Pay, and it asks its person before a purchase. Another shop needs a checkout an agent can use on its own site, or Muse has to fill in pages made for people.",
        },
      ],
    },
  },
  {
    slug: "grok",
    name: "Grok and Grok Bot",
    short: "Grok",
    maker: "xAI",
    title: "Can Grok book or order with your business? · Surfing Dog",
    heading: "Your business in Grok and Grok Bot",
    description:
      "What Grok and Grok Bot can do with a business as of October 2026, and how to add your inbox as a connector or MCP server. Free check of your site.",
    lede: "Grok takes custom connectors on grok.com, and Grok Bot, xAI's agent that works on a cloud computer, takes MCP servers as plugins. Either can talk to your inbox: as a customer's assistant booking with you, or as your own AI running it.",
    addSteps: [
      "In Grok: go to grok.com/connectors, choose New Connector, then Custom, and paste the server's address.",
      "In Grok Bot: tell it “Add a custom MCP server called My shop at https://inbox.yourdomain.com/mcp/owner” (or /mcp for the customer's side), then complete the sign-in on the card it shows.",
      "Grok Bot's plugins are account-wide: one connection serves every bot you make.",
    ],
    signIn:
      "Grok and Grok Bot sign in with OAuth, which your inbox runs itself (the owner MCP registers Grok on its own), or with an API key sent in a header: give Grok the header Authorization and the value Bearer sdi_own_… .",
    plans: "Custom connectors on grok.com are on xAI's paid plans. Grok Bot is in early beta.",
    notes: [],
    source: { label: "xAI: Grok Bot documentation", href: "https://docs.x.ai/grok-bot/teams-and-enterprises" },
    owner: {
      question: "Can Grok book or order with your business?",
      does: [
        {
          text: "As of October 2026, Grok Bot, xAI's agent, works on a cloud computer of its own: it browses, fills in pages and uses MCP connectors, and its person chooses which actions, payment steps among them, need their say before it acts.",
          sources: [SRC.grokBot],
        },
        {
          text: "Grok on grok.com takes custom connectors, MCP servers: it books, asks or orders through whatever a server offers.",
          sources: [SRC.grokConnectors],
        },
      ],
      faqs: [
        {
          q: "Can Grok book or buy for you?",
          a: "Grok Bot can work through websites in a browser of its own and through MCP connectors, asking its person before the steps they choose, such as paying. A door on your own site, such as an MCP server or a checkout made for agents, lets it finish without guessing its way through a page.",
        },
      ],
    },
  },
  {
    slug: "chatgpt",
    name: "ChatGPT",
    short: "ChatGPT",
    maker: "OpenAI",
    title: "Can ChatGPT book or order with your business? · Surfing Dog",
    heading: "Your business in ChatGPT",
    description:
      "What ChatGPT can book and buy as of October 2026, how it reaches a business, and how to connect it to your inbox. Free check of what it can do with your site.",
    lede: "ChatGPT connects to MCP servers through connectors. A customer's ChatGPT can book with you through your inbox's public server; yours can run the inbox through the owner server.",
    addSteps: [
      "In ChatGPT's settings, turn on developer mode for connectors.",
      "Create a connector with your inbox's address and choose OAuth: https://inbox.yourdomain.com/mcp/owner to run your inbox, or /mcp for the customer's side.",
      "Sign in on your inbox when ChatGPT sends you there, and approve what it may do.",
    ],
    signIn:
      "OAuth 2.1, which your inbox runs itself; ChatGPT registers on its own, so there is nothing to set up by hand.",
    plans: "Developer mode is on the plans OpenAI offers it on.",
    notes: [],
    source: { label: "OpenAI Help Center", href: "https://help.openai.com" },
    post: {
      label: "OpenAI's dots can book a table. Can it book with you?",
      href: "/blog/openai-dots-and-your-business/",
    },
    owner: {
      question: "Can ChatGPT book or order with your business?",
      does: [
        {
          text: "Restaurant tables: since 10 August 2026, ChatGPT finds free tables and books them through OpenTable (worldwide), Resy (US) and Yelp (US and Canada), on mobile, web and desktop.",
          sources: [SRC.openaiNotes, SRC.tablesReport],
        },
        {
          text: "Shopping: ChatGPT finds and compares products, and the buyer pays in the shop's own checkout, or in the shop's own app inside ChatGPT. In March 2026 OpenAI stepped back from Instant Checkout, its checkout inside the chat.",
          sources: [SRC.openaiShopping, SRC.checkoutReport],
        },
        {
          text: "Apps and connectors: a business can build an app for ChatGPT, and a person can add an MCP server as a connector. ChatGPT then books, asks or orders through it.",
          sources: [SRC.openaiApps],
        },
        {
          text: "Agents: dots, OpenAI's always-on agents (from 29 September 2026, on Pro outside the EEA, Switzerland and the UK, and on Business Premium), work through ChatGPT's apps and, where none fits, a browser of their own, and come back to their person when something needs them.",
          sources: [SRC.openaiDots],
        },
      ],
      faqs: [
        {
          q: "Can ChatGPT book appointments?",
          a: "Yes, through a door it can use: an app or connector, a platform it works with, or a door on the business's own website. For a salon, a clinic or a trade, the booking system or the business has to offer one. Our free check shows which doors your site offers.",
        },
        {
          q: "Can ChatGPT make restaurant reservations?",
          a: "Yes. Since August 2026 it books tables through OpenTable worldwide, Resy in the US and Yelp in the US and Canada. A restaurant on none of them can offer a door of its own, such as an MCP server a person adds to ChatGPT as a connector, or a booking page an agent can finish.",
        },
        {
          q: "Can ChatGPT order things for you?",
          a: "It finds and compares products, then the purchase finishes in the shop's own checkout or the shop's own app in ChatGPT; OpenAI stepped back from checkout inside the chat in March 2026. Agents such as dots can also buy through a browser, which goes more smoothly where a shop offers a checkout made for agents.",
        },
        {
          q: "How do I sell on ChatGPT?",
          a: "Get your products into ChatGPT's shopping results, through your shop platform or a product feed under the Agentic Commerce Protocol; eligible Shopify stores that sell to the US are included already. Keep a checkout that works from ChatGPT, and give agents a way to ask, change, cancel and return.",
        },
      ],
    },
  },
  {
    slug: "claude",
    name: "Claude",
    short: "Claude",
    maker: "Anthropic",
    title: "Can Claude book or order with your business? · Surfing Dog",
    heading: "Your business in Claude",
    description:
      "What Claude can book and buy as of October 2026, how it reaches a business through connectors, and how to add your inbox. Free check of your site.",
    lede: "Claude connects to remote MCP servers as custom connectors, on every plan. It is the quickest way to try your inbox from both sides.",
    addSteps: [
      "In Claude, go to Settings, then Connectors, and add a custom connector.",
      "Paste https://inbox.yourdomain.com/mcp/owner to run your inbox, or /mcp for the customer's side.",
      "Claude sends you to your inbox to sign in and approve its scopes, then connects.",
    ],
    signIn:
      "OAuth 2.1 with a Client ID Metadata Document: Claude identifies itself, so nothing needs registering. An owner API key works too, in Claude Code.",
    plans: "Custom connectors are on every Claude plan.",
    notes: [],
    source: { label: "Anthropic Help Center", href: "https://support.claude.com" },
    owner: {
      question: "Can Claude book or order with your business?",
      does: [
        {
          text: "Restaurant tables: since 23 April 2026, Claude shows Resy restaurants in the US with their free tables, through the Resy connector; the booking itself finishes on Resy.com or in the Resy app.",
          sources: [SRC.resy],
        },
        {
          text: "Connectors: Claude adds remote MCP servers as custom connectors, on every plan, and books, asks or orders through whatever a server offers.",
          sources: [SRC.claudeConnectors],
        },
        {
          text: "Browser: Claude in Chrome, on paid plans, reads pages and fills in forms with its person's own logins.",
          sources: [SRC.claudeChrome],
        },
        {
          text: "Shopping: Claude has no checkout of its own. Anthropic's commerce blueprint (2 September 2026) helps a shop build its own shopping agent on Claude, which fills a cart and hands it to the shop's checkout.",
          sources: [SRC.claudeCommerce],
        },
      ],
      faqs: [
        {
          q: "Can Claude book reservations?",
          a: "For US restaurants on Resy, Claude finds free tables and sends you to Resy to book. Anywhere else it books through a connector, an MCP server the business or its booking system offers, or with Claude in Chrome on a page. Our free check shows which doors your site offers.",
        },
        {
          q: "Can Claude buy things for you?",
          a: "Not inside Claude itself: it has no checkout. It can order through a connector that takes orders, or fill a basket in the browser for its person to pay. A shop can also build its own shopping agent on Claude, which hands a cart to its checkout.",
        },
      ],
    },
  },
  {
    slug: "gemini",
    name: "Gemini",
    short: "Gemini",
    maker: "Google",
    title: "Can Gemini book or order with your business? · Surfing Dog",
    heading: "Your business in Gemini",
    description:
      "What Gemini and Google's AI Mode can book and buy as of October 2026, how they reach a business, and how to add your inbox as a custom app. Free check.",
    lede: "The Gemini app connects to MCP servers as custom apps, on the web and then on your phone. Gemini Enterprise adds them for a whole team.",
    addSteps: [
      "On a computer, open gemini.google.com, then Settings, then Connected Apps.",
      "Under Custom apps, choose Add a custom app and paste https://inbox.yourdomain.com/mcp/owner (or /mcp for the customer's side).",
      "Approve it in the browser. Once connected on the web, it works in the Gemini mobile app too.",
      "For a team on Gemini Enterprise: Manage team, Connected apps, Add MCP Server.",
    ],
    signIn:
      "OAuth 2.0, which your inbox runs itself. Gemini asks for a server with a publicly trusted certificate on a public address, which every inbox has.",
    plans: "Custom apps in the Gemini app; MCP servers in Gemini Enterprise for teams.",
    notes: [],
    source: {
      label: "Google: Connect and manage custom apps for Gemini",
      href: "https://support.google.com/gemini/answer/17209137",
    },
    owner: {
      question: "Can Gemini book or order with your business?",
      does: [
        {
          text: "Restaurant tables: AI Mode in Google Search finds restaurants with free tables and links to the reservation platform to book, in the US and, since April 2026, the UK, Canada, Australia, India, South Africa and other markets.",
          sources: [SRC.googleUk, SRC.diningReport],
        },
        {
          text: "Appointments: Google says Gemini can reserve a table with OpenTable in the UK and book a doctor's appointment with Zocdoc in the US, through apps it connected in August 2026; Thumbtack and Angi joined at the same time.",
          sources: [SRC.geminiApps],
        },
        {
          text: "Local services: Google said in May 2026 that AI Mode finds local experiences and services with prices and free times, with links to finish booking with the provider, and, for home repair, beauty and pet care, calls businesses for its users, for everyone in the US over the summer.",
          sources: [SRC.googleIo],
        },
        {
          text: "Shopping: AI Mode and the Gemini app check out through the Universal Commerce Protocol (UCP) with merchants Google admits, starting in the US, and the merchant stays the merchant of record. Shopify stores based in the US have it on by default.",
          sources: [SRC.googleUcp, SRC.shopifyGoogle],
        },
      ],
      faqs: [
        {
          q: "Can Gemini book an appointment?",
          a: "Yes, through apps it connects to, such as Zocdoc in the US and OpenTable in the UK. Google's AI Mode finds free times and links to the booking platform; in the US it can also call some local businesses. A business none of them reach needs a door of its own. Our free check shows which doors your site offers.",
        },
        {
          q: "Can Gemini buy things for you?",
          a: "From merchants who offer checkout through UCP, the Universal Commerce Protocol, in AI Mode and the Gemini app; the merchant stays the merchant of record. Shopify stores based in the US and selling there have it on by default. Other shops can ask to join through Google Merchant Center; there is a waitlist.",
        },
      ],
    },
  },
  {
    slug: "microsoft-copilot",
    name: "Microsoft Copilot Studio",
    short: "Copilot",
    maker: "Microsoft",
    title: "Can Copilot book or order with your business? · Surfing Dog",
    heading: "Your business in a Copilot Studio agent",
    description:
      "What Microsoft Copilot can book and buy as of October 2026, Copilot Checkout, and how a Copilot Studio agent connects to your inbox. Free check of your site.",
    lede: "Copilot Studio agents connect to existing, publicly reachable MCP servers. Microsoft 365 Copilot's own federated connectors read today; writing comes later.",
    addSteps: [
      "In Copilot Studio, open your agent, add a tool, and choose an existing Model Context Protocol server.",
      "Give it https://inbox.yourdomain.com/mcp/owner (or /mcp for the customer's side) and its sign-in: OAuth, or an API key header.",
      "Publish the agent to the channels your team uses.",
    ],
    signIn:
      "OAuth 2.1 with dynamic client registration, which your inbox runs itself, or an owner API key in the Authorization header.",
    plans:
      "Copilot Studio. Microsoft 365 Copilot federated connectors are read-only today; Microsoft says writes start rolling out in October 2026.",
    notes: [],
    source: {
      label: "Microsoft Learn: connect an agent to an existing MCP server",
      href: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent",
    },
    owner: {
      question: "Can Microsoft Copilot book or order with your business?",
      does: [
        {
          text: "Shopping: Copilot Checkout, from January 2026, lets people in the US buy inside Copilot on Copilot.com, and the shop stays the merchant of record. Shopify stores are in by default, with a way to opt out; other shops apply, or join through PayPal or Stripe.",
          sources: [SRC.copilotCheckout, SRC.shopifyCopilot],
        },
        {
          text: "Bookings: Microsoft announced Copilot Actions in April 2025, booking dinner reservations and event tickets with partners such as OpenTable and Booking.com; we couldn't confirm from Microsoft how widely it is available in October 2026.",
          sources: [SRC.copilotActions],
        },
        {
          text: "Agents a business builds in Copilot Studio connect to MCP servers, such as your inbox's, below.",
          sources: [SRC.copilotStudio],
        },
      ],
      faqs: [
        {
          q: "Can Copilot buy things for you?",
          a: "In the US, yes, from shops in Copilot Checkout: Shopify stores by default, and others that apply or join through PayPal or Stripe. The shop stays the merchant of record. For any other shop, a checkout made for agents on its own site is what lets an assistant finish.",
        },
        {
          q: "Can Copilot book a table or tickets?",
          a: "Microsoft announced Copilot Actions in April 2025, booking dinner reservations and event tickets through partners such as OpenTable and Booking.com; we couldn't confirm from Microsoft how widely it is available in October 2026. A business on none of those platforms is easiest to book through a door on its own site.",
        },
      ],
    },
  },
];

export function assistantBySlug(slug: string): Assistant | undefined {
  return ASSISTANTS.find((a) => a.slug === slug);
}
