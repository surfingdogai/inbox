import type { Faq, Source } from "./faq";

/**
 * /guides/shopify-ai-assistants/: what AI assistants do with a Shopify store, what Shopify publishes
 * on the store's own domain, what our check counts for it under the published rules, and what an
 * owner can add. What Shopify and the assistants do moves monthly, so every line about them says
 * where we read it, and the page says when; what the check counts follows /v1/score-rules (version
 * 3, as amended on 15 October 2026: a UCP profile counts where the store's server answers or its pages
 * show its prices) and the network's next steps for Shopify (vocab/guide.json).
 */
export const SHOPIFY_CHECKED = "12 October 2026";
export const SHOPIFY_AS_OF = "as of October 2026";

export const SHOPIFY = {
  slug: "shopify-ai-assistants",
  /** The page's heading. */
  heading: "Shopify and AI assistants: can ChatGPT order from your store?",
  /** Its title, before " · Surfing Dog". */
  title: "Shopify agentic commerce and AI assistants",
  description:
    "Shopify agentic commerce, as of October 2026: what ChatGPT, Gemini, Copilot and Meta do with your store, what Shopify publishes for you, and what's missing.",
  answer:
    "Often, in part. Shopify publishes agent doors on an eligible store's domain, such as a UCP checkout and an llms.txt. ChatGPT sends buyers to your checkout; Gemini and Copilot check out in the chat for US buyers, Meta for the US, Canada and Mexico. Questions, cancelling and returns need more.",
} as const;

const HELP = "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts";
export const SHOPIFY_SOURCES = {
  storefronts: { label: "Shopify Help Center: agentic storefronts", href: HELP },
  chatgpt: { label: "Shopify Help Center: ChatGPT", href: `${HELP}/chatgpt` },
  google: { label: "Shopify Help Center: Google AI Mode and Gemini", href: `${HELP}/google` },
  microsoft: { label: "Shopify Help Center: Microsoft Copilot", href: `${HELP}/microsoft` },
  meta: { label: "Shopify Help Center: Meta", href: `${HELP}/meta` },
  checkout: {
    label: "Shopify.dev: Checkout MCP",
    href: "https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp",
  },
  order: { label: "Shopify.dev: Order MCP", href: "https://shopify.dev/docs/agents/orders/order-mcp" },
  storefrontMcp: { label: "Shopify.dev: Storefront MCP", href: "https://shopify.dev/docs/apps/build/storefront-mcp" },
  agentsMd: {
    label: "Shopify.dev: agents.md.liquid",
    href: "https://shopify.dev/docs/storefronts/themes/architecture/templates/agents-md-liquid",
  },
  openai: {
    label: "TechCrunch, 24 March 2026",
    href: "https://techcrunch.com/2026/03/24/openais-plans-to-make-chatgpt-more-like-amazon-arent-going-so-well/",
  },
} satisfies Record<string, Source>;

/** What each assistant does with a Shopify store, through Shopify's agentic storefronts. */
export const SHOPIFY_CHANNELS: readonly { readonly name: string; readonly does: string; readonly sources: Source[] }[] =
  [
    {
      name: "ChatGPT",
      does: "Finds and compares your products through Shopify Catalog. The buyer pays in your own checkout, opened in ChatGPT's in-app browser or a new tab. Your store must sell to customers in the US. OpenAI stepped back from checkout inside the chat in March 2026.",
      sources: [SHOPIFY_SOURCES.chatgpt, SHOPIFY_SOURCES.openai],
    },
    {
      name: "Google AI Mode and Gemini",
      does: "A Shopify-powered checkout inside the chat, paid by card, for a store based in the US that sells to US customers and has a Google Merchant Center account.",
      sources: [SHOPIFY_SOURCES.google],
    },
    {
      name: "Microsoft Copilot",
      does: "A checkout inside Copilot, on by default for an eligible store, shown to buyers in the US.",
      sources: [SHOPIFY_SOURCES.microsoft],
    },
    {
      name: "Meta, Muse among its apps once it's available there",
      does: "A checkout on Meta's apps for a store that sells to the US, Canada or Mexico.",
      sources: [SHOPIFY_SOURCES.meta],
    },
  ];

/** What Shopify serves on a store's own domain for agents. */
export const SHOPIFY_DOORS: readonly { readonly path: string; readonly what: string }[] = [
  {
    path: "/.well-known/ucp",
    what: "Your UCP profile: it names checkout, cart, order and catalogue, and the MCP server that serves them.",
  },
  {
    path: "/api/ucp/mcp",
    what: "That server: tools to search your catalogue, build a cart, create and complete a checkout, and read an order an agent placed. An agent identifies itself to Shopify (a token or a signed request) and presents its own UCP profile, and a checkout that needs the buyer hands over to your checkout page.",
  },
  {
    path: "/api/mcp",
    what: "A search of your store's policies and FAQs. Its catalogue and cart tools moved to the UCP server above.",
  },
  {
    path: "/llms.txt",
    what: "One file Shopify keeps for you, also served at /llms-full.txt and /agents.md, telling agents about your store's UCP doors. A theme template, agents.md.liquid or llms.txt.liquid, replaces it.",
  },
];

/** The page's questions, shown folded and given as its FAQPage data in the same words. */
export const SHOPIFY_FAQS: readonly Faq[] = [
  {
    q: "Does Shopify support agentic commerce?",
    a: "Yes. For eligible stores Shopify publishes a UCP checkout on the store's own domain and lists products with AI assistants through agentic storefronts, on by default. Checkout inside Gemini and Copilot is for US buyers, and on Meta for the US, Canada and Mexico; ChatGPT sends buyers to your own checkout.",
  },
  {
    q: "Can I sell on ChatGPT with Shopify?",
    a: "Yes, if your store sells to customers in the US and your products qualify for Shopify Catalog. ChatGPT shows and compares them, and the buyer pays in your own checkout, opened from ChatGPT. Your terms of service, privacy policy and refund policy need to be filled in.",
  },
  {
    q: "Does Shopify make an llms.txt for my store?",
    a: "Yes. Shopify serves one file it keeps for you at /llms.txt, /llms-full.txt and /agents.md, telling agents about your store's UCP doors. A theme template replaces it; if you write your own, keep those lines. llms.txt helps an agent read about you, and on its own it opens no door.",
  },
  {
    q: "Why doesn't my Shopify store score 100?",
    a: "A full score needs the whole journey. Shopify's doors let an agent order, pay and read an order, but not ask you a question, change or cancel an order, start a return or fetch a receipt. Cancelling a cart or a checkout isn't cancelling an order, so it doesn't count.",
  },
];
