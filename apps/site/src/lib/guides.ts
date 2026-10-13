/**
 * The guides at /guides/: what a business needs so that a customer's AI assistant can do something
 * with it, one page for each thing the check counts, written for any business anywhere and for no
 * vendor in particular. Each guide's prose is a Markdown file in src/content/guides; its title,
 * answer, options and examples are here, so the hub, the pages and the tests read one list.
 *
 * The slugs are a contract. The network's result pages link each missing step to its guide, and to
 * the anchors below, so a slug never changes once published, and every one of them must answer.
 *
 * Copy rules: plain words, no claim of being first or alone, nothing the check does not count, and
 * our own inbox as one labelled option, in the three guides where it fits, and nowhere else.
 */

import { HOSTED_LINE } from "./hosted";

/** Every guide's address under /guides/, in the order the hub lists them. */
export const GUIDE_SLUGS = [
  "ai-assistant-bookings",
  "sell-through-ai-assistants",
  "ai-assistant-messages-and-quotes",
  "ai-assistant-payments",
  "business-details-for-ai",
  "findable-agent-doors",
  "llms-txt",
  "robots-txt-ai-agents",
] as const;
export type GuideSlug = (typeof GUIDE_SLUGS)[number];

/** Anchors other pages link to, each an id a guide's Markdown (or the hub) writes out. */
export const GUIDE_ANCHORS: Readonly<Record<string, readonly string[]>> = {
  "": ["score"],
  "ai-assistant-bookings": ["platforms", "memberships"],
  "sell-through-ai-assistants": ["after"],
  "ai-assistant-messages-and-quotes": ["quotes"],
  "business-details-for-ai": ["kind"],
};

export const guideHref = (slug: GuideSlug | "") => (slug ? `/guides/${slug}/` : "/guides/");

/** The checker, where every guide ends: a fresh read of the owner's site. */
export const CHECK_HREF = "/check";

/**
 * Pages for one platform's owners, beside the guides and outside their contract: the network's
 * result pages don't link them, so they may be added or renamed. Each is its own page under
 * src/pages/guides/.
 */
export const PLATFORM_PAGES: readonly { readonly slug: string; readonly label: string }[] = [
  { slug: "shopify-ai-assistants", label: "Shopify and AI assistants" },
];

/** What the leaderboards can list (the network's ?can= values), or the agent-ready as a whole. */
export type Examples = { readonly href: string; readonly label: string };

export interface GuideLink {
  readonly label: string;
  readonly href: string;
}

/** One way to do it, a row of a guide's options table. `what` may hold `code` in backticks. */
export interface GuideOption {
  readonly way: string;
  readonly what: string;
  readonly links?: readonly GuideLink[];
  /** Ours: Surfing Dog Inbox, said so in its name. */
  readonly ours?: boolean;
}

export interface Guide {
  readonly slug: GuideSlug;
  /** The page's heading, and its title before " · Surfing Dog": what an owner searches for. */
  readonly title: string;
  /** Its name in the hub's list and in "More guides". */
  readonly short: string;
  /** The meta description, at most 160 characters. */
  readonly description: string;
  /** The answer box at the top, at most 50 words, in plain text. */
  readonly answer: string;
  readonly options: readonly GuideOption[];
  /** Businesses that do it already, on the leaderboards. */
  readonly examples: readonly Examples[];
}

const MCP: GuideLink = { label: "MCP", href: "https://modelcontextprotocol.io" };
const OPENAPI: GuideLink = { label: "OpenAPI", href: "https://www.openapis.org" };
const A2A: GuideLink = { label: "A2A", href: "https://a2a-protocol.org" };
const UCP: GuideLink = { label: "UCP", href: "https://ucp.dev" };
const ACP: GuideLink = { label: "ACP", href: "https://www.agenticcommerce.dev" };

/** The inbox's name wherever a guide lists it: whose it is, and that it is open source. */
export const INBOX_WAY = "Surfing Dog Inbox (ours, open source)";
const INBOX_COST = `On Cloudflare the free plan runs it, and sending email needs a paid Workers plan, about $5 a month; or run it on your own server. ${HOSTED_LINE}`;
const INBOX_LINKS: readonly GuideLink[] = [
  { label: "How it works", href: "/inbox/" },
  { label: "Install it", href: "/install/" },
];
const inbox = (what: string): GuideOption => ({
  way: INBOX_WAY,
  what: `Free software (MIT) you run at your own subdomain, such as inbox.yourbusiness.example. ${what} ${INBOX_COST}`,
  links: INBOX_LINKS,
  ours: true,
});

const can = (key: string, label: string): Examples => ({ href: `/leaderboard?can=${key}`, label });
const READY: Examples = {
  href: "/leaderboard?ready=1",
  label: "Agent-ready businesses, and the doors each one offers",
};

export const GUIDES: readonly Guide[] = [
  {
    slug: "ai-assistant-bookings",
    title: "Let ChatGPT, Gemini and other AI assistants book with your business",
    short: "Bookings",
    description:
      "What an AI assistant needs to book with you: your free times, a booking door on your own site, and a way to change or cancel. Platforms and sign-ups too.",
    answer:
      "An assistant can book with you when your site offers a door that takes a booking: a tool or an API on your own domain, or your booking platform's agent door linked from your site. Give it your free times too, and let it change or cancel later.",
    options: [
      {
        way: "Build it",
        what: "Add `create_booking` beside `check_availability`, `reschedule_booking` and `cancel_booking` on an MCP server, or in an OpenAPI document, on your own domain. That covers the whole journey in one piece of work.",
        links: [MCP, OPENAPI],
      },
      {
        way: "Your booking platform",
        what: "Ask whether it offers an agent door for your customers' assistants, and link that door from your own site. Until it does, its page stays a good way for people to book.",
      },
      {
        way: "Your website builder",
        what: "Wix documents agent tools for the sites it hosts; tools a page adds with a script aren't seen by our check, which never runs JavaScript, so ask Wix how to publish them as a door. For WordPress, Squarespace, Webflow or GoDaddy, ask whether they offer an agent door for bookings.",
        links: [
          {
            label: "Wix: about the Wix Web MCP",
            href: "https://dev.wix.com/docs/develop-websites/articles/get-started/ai-agents/about-the-wix-web-mcp.md",
          },
        ],
      },
      inbox(
        "Agents see free times from your services and opening hours, ask for a booking, and change or cancel it later; you, your rules or your own AI confirm each one. It doesn't sync with another booking calendar, so it suits a business that has none yet.",
      ),
      {
        way: "Others",
        what: "Booking software with an agent door of its own, or a developer who builds one for you. Whichever you choose, keep the door on your own domain, or link to it from there.",
      },
    ],
    examples: [can("book", "Businesses an agent can book with")],
  },
  {
    slug: "sell-through-ai-assistants",
    title: "Agentic commerce readiness: sell through AI assistants",
    short: "Selling",
    description:
      "Agentic commerce readiness for a shop: how Gemini, Copilot and other assistants order through UCP or ACP checkout, and the steps after: cancel, track, return.",
    answer:
      "An assistant can order from you when your shop publishes a checkout it can use, such as a UCP or ACP profile, or an order tool on your own domain. Then let it change, cancel and track the order, fetch a receipt and start a return.",
    options: [
      {
        way: "Build it",
        what: "Publish a UCP or ACP profile, or `create_order` on your own MCP server or API with `update_order`, `cancel_order`, `get_order_status`, `get_invoice` and `request_return` beside it.",
        links: [UCP, ACP, MCP],
      },
      {
        way: "Your shop platform",
        what: "Shopify documents agentic storefronts and agent orders; if your result says no checkout, check that `/.well-known/ucp` answers on your shop's own domain. Wix describes agentic commerce on Wix. For WooCommerce, Squarespace, Webflow or GoDaddy, ask the platform, or the maker of your shop plugin, whether it publishes UCP or ACP for your shop.",
        links: [
          {
            label: "Shopify: agentic storefronts",
            href: "https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts",
          },
          { label: "Shopify: agent orders", href: "https://shopify.dev/docs/agents/orders" },
          { label: "Shopify and AI assistants, in more detail", href: "/guides/shopify-ai-assistants/" },
          { label: "Wix: agentic commerce", href: "https://wix.com/blog/agentic-commerce-on-wix" },
        ],
      },
      inbox(
        "For a business with no checkout an agent can use: agents send orders for products you list or import from a product feed, you accept each one, and payment goes by link to your own checkout. A shop whose checkout already works for agents doesn't need it: one door for each action.",
      ),
      {
        way: "Others",
        what: "A commerce service or a payment provider that publishes UCP or ACP for your shop, or a developer who builds it. Keep it on your own domain, or link to it from there.",
      },
    ],
    examples: [can("order", "Businesses an agent can order from")],
  },
  {
    slug: "ai-assistant-messages-and-quotes",
    title: "Let AI assistants message you or ask for a quote",
    short: "Messages and quotes",
    description:
      "How a customer's AI assistant can ask you a question or a price and come back for the answer: agent doors for messages and quotes, and the helpdesk you use.",
    answer:
      "An assistant can message you when your site offers a door that takes a message: an A2A agent, a message tool, or an agent inbox. For trades, let it ask for a quote too. Email, phone, forms and chat widgets are made for people.",
    options: [
      {
        way: "Build it",
        what: "An A2A agent card at `/.well-known/agent-card.json` for an AI agent of your own, or `send_message` and `request_quote` on an MCP server or in an OpenAPI document on your domain.",
        links: [A2A, MCP, OPENAPI],
      },
      {
        way: "Your helpdesk or chat tool",
        what: "Ask whether it offers a door for customers' agents. If it doesn't, a small bridge does the job: a message to the door opens a ticket, and your reply goes back through the door.",
      },
      inbox(
        "Agents write to you there and ask for quotes; your rules answer routine ones, and you see the rest. An accepted quote can become a booking. You answer from its app, from your helpdesk through a bridge, or with your own AI.",
      ),
      {
        way: "Others",
        what: "Any agent platform that gives you an A2A agent or an MCP server for messages, on your own domain or linked from it.",
      },
    ],
    examples: [
      can("message", "Businesses an agent can message"),
      can("negotiate", "Businesses an agent can ask for a quote"),
    ],
  },
  {
    slug: "ai-assistant-payments",
    title: "How AI assistants pay",
    short: "Payments",
    description:
      "How an AI assistant can pay a business without holding a card number: tokens and mandates made for agents, payment links, and what to ask your provider.",
    answer:
      "An assistant shouldn't type a card number. It pays with a credential made for agents, a token or a mandate the person approved, through your checkout or payment provider. A payment link to your own checkout is a fine start: the agent does the rest, and a person pays.",
    options: [
      {
        way: "Your checkout",
        what: "Add payment handlers to your UCP profile, or delegated payment to your ACP checkout, or a pay tool on your own door that takes an agent's token or mandate.",
        links: [UCP, ACP, { label: "AP2", href: "https://ap2-protocol.org" }],
      },
      {
        way: "Your payment provider",
        what: "Ask whether it supports agent payments, which tokens and mandates it accepts, and in which countries. Several providers publish theirs.",
        links: [
          {
            label: "Stripe's agentic commerce updates (Payment Expert)",
            href: "https://paymentexpert.com/2026/05/01/stripes-agentic-commerce-updates/",
          },
          { label: "Adyen: agentic commerce", href: "https://docs.adyen.com/online-payments/agentic-commerce" },
          { label: "Mollie: agentic commerce", href: "https://www.mollie.com/news/agentic-commerce-mollie-europe" },
        ],
      },
      {
        way: "A payment link",
        what: "Your system sends a link to your own checkout and a person pays. It counts as partly, and it works with the provider you have today.",
      },
      {
        way: "Others",
        what: "x402 settles a payment over HTTP, mostly in stablecoins; it suits software and APIs more than a salon or a shop today.",
        links: [{ label: "x402", href: "https://www.x402.org" }],
      },
    ],
    examples: [can("pay", "Businesses where an agent can pay")],
  },
  {
    slug: "business-details-for-ai",
    title: "Your hours, prices and terms as data AI assistants can read",
    short: "Your details as data",
    description:
      "Who you are, where, when you're open, what you offer for how much, and your terms, as data an AI assistant can read. Plus how we tell your kind of business.",
    answer:
      "Write who you are, where you are, your opening hours, what you offer with prices, and your cancellation and return terms as schema.org markup on pages linked from your homepage. Assistants compare on these before they book or buy.",
    options: [
      {
        way: "Write the markup yourself",
        what: "JSON-LD in your pages, using schema.org's types: `LocalBusiness` (or a more specific type), `Offer`, `MerchantReturnPolicy`. Check it with a structured-data validator.",
        links: [
          { label: "schema.org: LocalBusiness", href: "https://schema.org/LocalBusiness" },
          { label: "schema.org: Offer", href: "https://schema.org/Offer" },
          { label: "Schema Markup Validator", href: "https://validator.schema.org" },
        ],
      },
      {
        way: "Your website builder or shop platform",
        what: "Most builders have a place for business information, opening hours and products, and many publish markup from it. Ask yours where those settings are, then check what it publishes.",
      },
      {
        way: "Your booking or shop platform",
        what: "Copy your terms onto your own site, in words: an assistant reading your site doesn't see the ones on the platform's pages.",
      },
      {
        way: "Others",
        what: "An SEO plugin or a developer. Whoever writes it, keep the data the same as what your pages say.",
      },
    ],
    examples: [can("catalogue", "Businesses whose catalogue an agent can read")],
  },
  {
    slug: "findable-agent-doors",
    title: "Make your agent doors findable",
    short: "Findable doors",
    description:
      "Where assistants and crawlers look for your agent doors: well-known files, MCP server cards, A2A agent cards, AI catalogs and llms.txt lines on your domain.",
    answer:
      "Assistants and crawlers find doors by reading files at known places. Publish each door where readers look: a well-known file, an MCP server card, an A2A agent card, or a line in llms.txt saying what it is. Keep every door on your own domain or a subdomain.",
    options: [
      {
        way: "Publish the files yourself",
        what: "Put the cards and files on your domain, and a line for each door in `llms.txt`.",
        links: [MCP, A2A, { label: "llms.txt", href: "https://llmstxt.org" }],
      },
      {
        way: "Your platform",
        what: "Many platforms publish some of these for you, such as a shop's UCP profile. Ask yours which files it serves on your domain, then look at them from outside.",
      },
      {
        way: "Your listing with us",
        what: "Claim your listing from your own AI and declare your doors. A declared door counts once we've checked it, and a door on another host counts when your site leads to it or its own document names your domain.",
        links: [{ label: "Claiming and correcting a listing", href: "/bot" }],
      },
      {
        way: "Others",
        what: "An AI catalog at `/.well-known/ai-catalog.json` that lists all your doors in one place, alongside the files above.",
      },
    ],
    examples: [READY],
  },
  {
    slug: "llms-txt",
    title: "What llms.txt does, and doesn't",
    short: "llms.txt",
    description:
      "llms.txt helps an AI read about your business and can point it to your doors. On its own it doesn't let an assistant ask, book or order. What to put in it.",
    answer:
      "llms.txt is a Markdown file at the root of your site that tells an AI what your business is. It helps an assistant read about you, and it can name your doors, but on its own it doesn't let an assistant ask, book or order.",
    options: [
      {
        way: "Write it yourself",
        what: "A short Markdown file at `/llms.txt`: your name, a summary, the pages worth reading, and a line for each door.",
        links: [{ label: "llms.txt", href: "https://llmstxt.org" }],
      },
      {
        way: "Your platform or plugin",
        what: "Some website builders and SEO plugins can write one for you. Ask yours, then read what it wrote and add your doors.",
      },
      {
        way: "Others",
        what: "A developer, or your own AI with this page open. Read the file before you publish it.",
      },
    ],
    examples: [READY],
  },
  {
    slug: "robots-txt-ai-agents",
    title: "robots.txt and content signals for AI agents",
    short: "robots.txt",
    description:
      "How robots.txt and content signals tell crawlers and AI systems what they may read and use, how our check reads them, and how to let our crawler in.",
    answer:
      "robots.txt tells crawlers what they may read; content signals in it say whether what they read may be used for search, as AI input or for training. Our check reads robots.txt before anything else and obeys it. Saying no is your choice, and we respect it.",
    options: [
      {
        way: "Edit robots.txt yourself",
        what: "A plain text file at `/robots.txt`: a group for each crawler, and one `Content-Signal` line.",
        links: [
          { label: "RFC 9309", href: "https://www.rfc-editor.org/rfc/rfc9309" },
          { label: "Content signals", href: "https://contentsignals.org" },
        ],
      },
      {
        way: "Your website builder or host",
        what: "Many builders and hosts have a robots.txt setting, and some add content signals for you. Ask yours where it is, then read the file it serves.",
      },
      {
        way: "Your firewall or CDN",
        what: "Bot protection may answer crawlers with a challenge page. If you want assistants to reach you, let signed bots through; ask your provider how.",
        links: [{ label: "About our crawler", href: "/bot" }],
      },
    ],
    examples: [READY],
  },
];

/** The hub at /guides/: what being ready means, the five steps, the doors, the score, the guides. */
export const HUB = {
  title: "AI agent readiness checklist for small businesses",
  description:
    "An AI agent readiness checklist for small businesses: what a customer's assistant needs to ask, book, order or pay, how the score works, and eight guides.",
  answer:
    "A business is ready for AI agents when a customer's AI assistant can do something with it, not just read about it: ask a question, book, order or sign up, and later change or cancel. That takes a door: a machine address on its own domain.",
  examples: [READY] as readonly Examples[],
} as const;

export function guideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

/** Words as a reader counts them: runs of letters, digits and joining marks between spaces. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * The hub's five steps, as the network names them: the best door found puts a business on a step.
 * A business is named, and its result page may appear in search, from askable up.
 */
export const LEVELS: readonly { readonly name: string; readonly says: string }[] = [
  {
    name: "Listed",
    says: "We found its name, or a page on a booking platform. A person can book there; an assistant can't yet.",
  },
  {
    name: "Readable",
    says: "Its own site says who and where it is, as data (name, address, opening hours), or it publishes llms.txt.",
  },
  { name: "Askable", says: "A door takes a message or a quote request." },
  { name: "Bookable", says: "A door takes a booking or an order." },
  { name: "Payable", says: "That door takes payment as well." },
];

/**
 * How the agentic score is weighed, in words, from the published rules (/v1/score-rules): each group's
 * weight and what is in it. The site's test holds these to the rules file itself.
 */
export const SCORE_GROUPS: readonly { readonly id: string; readonly weight: number; readonly holds: string }[] = [
  { id: "core", weight: 40, holds: "Message, book, order, sign up, pay" },
  { id: "after", weight: 30, holds: "Change, cancel, return or refund, membership, receipt" },
  { id: "state", weight: 10, holds: "Free times or stock, tracking" },
  { id: "readable", weight: 10, holds: "Catalogue with prices, policies" },
  { id: "negotiate", weight: 5, holds: "Quotes and offers" },
  { id: "find", weight: 5, holds: "Who you are, where, opening hours" },
];

/** The grades, from the same rules: the lowest score that earns each. */
export const SCORE_GRADES: readonly { readonly grade: string; readonly min: number }[] = [
  { grade: "A", min: 80 },
  { grade: "B", min: 60 },
  { grade: "C", min: 40 },
  { grade: "D", min: 20 },
  { grade: "E", min: 0 },
];
