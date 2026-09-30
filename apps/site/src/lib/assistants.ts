/**
 * The AI assistants a business's inbox works with, as their makers ship them. Every step and every
 * status here was checked against the assistant's own help or the maker's announcement on the date
 * below; the pages say so, and link there. Nothing is claimed that the inbox cannot do today.
 */
export const CHECKED = "30 September 2026";

export interface Assistant {
  readonly slug: string;
  readonly name: string;
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
}

export const ASSISTANTS: readonly Assistant[] = [
  {
    slug: "meta-muse",
    name: "Meta Muse",
    maker: "Meta",
    title: "Meta Muse connector for bookings, quotes and orders · Surfing Dog",
    heading: "Your business in Meta Muse",
    description:
      "Let Meta Muse book, ask for a quote or place an order with your business, and answer from your own rules. How Muse reaches your inbox, and how to connect your own AI to run it.",
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
  },
  {
    slug: "grok",
    name: "Grok and Grok Bot",
    maker: "xAI",
    title: "Grok connector and Grok Bot MCP server for your business · Surfing Dog",
    heading: "Your business in Grok and Grok Bot",
    description:
      "Add your inbox to Grok as a custom connector, or to Grok Bot as an MCP server, so Grok can book, ask for quotes and order from your business, or run your inbox for you.",
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
  },
  {
    slug: "chatgpt",
    name: "ChatGPT",
    maker: "OpenAI",
    title: "ChatGPT connector for bookings and quotes · Surfing Dog",
    heading: "Your business in ChatGPT",
    description:
      "Connect ChatGPT to your business's inbox so it can book, ask for a quote or order for a customer, or so you can run your inbox from ChatGPT.",
    lede: "ChatGPT connects to MCP servers through connectors. A customer's ChatGPT can book with you through your inbox's public server; yours can run the inbox through the owner server.",
    addSteps: [
      "In ChatGPT's settings, turn on developer mode for connectors.",
      "Create a connector with your inbox's address and choose OAuth: https://inbox.yourdomain.com/mcp/owner to run your inbox, or /mcp for the customer's side.",
      "Sign in on your inbox when ChatGPT sends you there, and approve what it may do.",
    ],
    signIn: "OAuth 2.1, which your inbox runs itself; ChatGPT registers on its own, so there is nothing to set up by hand.",
    plans: "Developer mode is on the plans OpenAI offers it on.",
    notes: [],
    source: { label: "OpenAI Help Center", href: "https://help.openai.com" },
  },
  {
    slug: "claude",
    name: "Claude",
    maker: "Anthropic",
    title: "Claude connector for your business's bookings and quotes · Surfing Dog",
    heading: "Your business in Claude",
    description:
      "Add your inbox to Claude as a custom connector, so Claude can book and ask for quotes for a customer, or run your inbox with you.",
    lede: "Claude connects to remote MCP servers as custom connectors, on every plan. It is the quickest way to try your inbox from both sides.",
    addSteps: [
      "In Claude, go to Settings, then Connectors, and add a custom connector.",
      "Paste https://inbox.yourdomain.com/mcp/owner to run your inbox, or /mcp for the customer's side.",
      "Claude sends you to your inbox to sign in and approve its scopes, then connects.",
    ],
    signIn: "OAuth 2.1 with a Client ID Metadata Document: Claude identifies itself, so nothing needs registering. An owner API key works too, in Claude Code.",
    plans: "Custom connectors are on every Claude plan.",
    notes: [],
    source: { label: "Anthropic Help Center", href: "https://support.claude.com" },
  },
  {
    slug: "gemini",
    name: "Gemini",
    maker: "Google",
    title: "Gemini custom app (MCP) for your business · Surfing Dog",
    heading: "Your business in Gemini",
    description:
      "Add your inbox to the Gemini app as a custom app, so Gemini can book, ask for quotes and order from your business, or run your inbox for you.",
    lede: "The Gemini app connects to MCP servers as custom apps, on the web and then on your phone. Gemini Enterprise adds them for a whole team.",
    addSteps: [
      "On a computer, open gemini.google.com, then Settings, then Connected Apps.",
      "Under Custom apps, choose Add a custom app and paste https://inbox.yourdomain.com/mcp/owner (or /mcp for the customer's side).",
      "Approve it in the browser. Once connected on the web, it works in the Gemini mobile app too.",
      "For a team on Gemini Enterprise: Manage team, Connected apps, Add MCP Server.",
    ],
    signIn: "OAuth 2.0, which your inbox runs itself. Gemini asks for a server with a publicly trusted certificate on a public address, which every inbox has.",
    plans: "Custom apps in the Gemini app; MCP servers in Gemini Enterprise for teams.",
    notes: [],
    source: { label: "Google: Connect and manage custom apps for Gemini", href: "https://support.google.com/gemini/answer/17209137" },
  },
  {
    slug: "microsoft-copilot",
    name: "Microsoft Copilot Studio",
    maker: "Microsoft",
    title: "Copilot Studio agent with your business's inbox (MCP) · Surfing Dog",
    heading: "Your business in a Copilot Studio agent",
    description:
      "Connect a Microsoft Copilot Studio agent to your inbox's MCP server, so it can book, quote and order with your business, or work your inbox.",
    lede: "Copilot Studio agents connect to existing, publicly reachable MCP servers. Microsoft 365 Copilot's own federated connectors read today; writing comes later.",
    addSteps: [
      "In Copilot Studio, open your agent, add a tool, and choose an existing Model Context Protocol server.",
      "Give it https://inbox.yourdomain.com/mcp/owner (or /mcp for the customer's side) and its sign-in: OAuth, or an API key header.",
      "Publish the agent to the channels your team uses.",
    ],
    signIn: "OAuth 2.1 with dynamic client registration, which your inbox runs itself, or an owner API key in the Authorization header.",
    plans: "Copilot Studio. Microsoft 365 Copilot federated connectors are read-only today; Microsoft says writes start rolling out in October 2026.",
    notes: [],
    source: {
      label: "Microsoft Learn: connect an agent to an existing MCP server",
      href: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent",
    },
  },
];

export function assistantBySlug(slug: string): Assistant | undefined {
  return ASSISTANTS.find((a) => a.slug === slug);
}
