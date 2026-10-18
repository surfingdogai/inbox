/**
 * Surfing Dog in a person's own AI assistant (ADR-020): the one MCP address, the promise about
 * requests we carry, and how each assistant adds it. Every step and every "not yet" was read in the
 * assistant's own help, or its maker's announcement, on the date below; each row links where. An
 * assistant that cannot add a server of one's own says "not yet", and nothing here says more than we
 * read.
 */

/** The address a person adds: Search and the carried requests, one server. */
export const MCP_URL = "https://surfingdog.ai/mcp";

/** The promise decided on 15 October 2026 (ADR-020), word for word, wherever carried requests are described. */
export const CARRY_PROMISE =
  "Surfing Dog never touches the money and never keeps what anyone writes. When a business allows it, we carry an assistant's request to the business's own inbox and keep only a record that it was delivered.";

/** When the steps below were last read against each assistant's own pages. */
export const STEPS_CHECKED = "18 October 2026";

/** Where a person stands with one assistant today. */
export type Reach = "works" | "paid" | "region" | "not_yet";

export const REACH_WORDS: Record<Reach, string> = {
  works: "Works",
  paid: "Paid plans",
  region: "Some countries",
  not_yet: "Not yet",
};

export interface AssistantSteps {
  readonly slug: string;
  readonly name: string;
  readonly maker: string;
  readonly reach: Reach;
  /** The steps, in a few words each; for "not yet", what there is instead. */
  readonly steps: readonly string[];
  /** One quiet line: plans, places, or what is not confirmed. */
  readonly note?: string;
  readonly source: { readonly label: string; readonly href: string };
}

export const ASSISTANT_STEPS: readonly AssistantSteps[] = [
  {
    slug: "chatgpt",
    name: "ChatGPT",
    maker: "OpenAI",
    reach: "works",
    steps: [
      "Settings, then Apps and connectors: turn on developer mode.",
      `Create a connector named Surfing Dog with ${MCP_URL}, and no sign-in.`,
      "In a chat, choose it from the tools menu and ask.",
    ],
    note: "Developer mode is on the plans OpenAI offers it on.",
    source: { label: "OpenAI Help Center", href: "https://help.openai.com" },
  },
  {
    slug: "claude",
    name: "Claude",
    maker: "Anthropic",
    reach: "works",
    steps: [
      "Settings, then Connectors: Add custom connector.",
      `Name it Surfing Dog and paste ${MCP_URL}. No sign-in.`,
      "In a chat, switch it on from the tools menu and ask.",
    ],
    source: {
      label: "Claude Help Center: custom connectors",
      href: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    },
  },
  {
    slug: "gemini",
    name: "Gemini",
    maker: "Google",
    reach: "works",
    steps: [
      "On a computer, gemini.google.com: Settings, then Connected apps.",
      `Under Custom apps, Add a custom app: paste ${MCP_URL} and approve it.`,
      "It then works in the Gemini app on your phone too.",
    ],
    source: {
      label: "Google: connect custom apps to Gemini",
      href: "https://support.google.com/gemini/answer/17209137",
    },
  },
  {
    slug: "le-chat",
    name: "Le Chat",
    maker: "Mistral",
    reach: "works",
    steps: [
      "Connectors, then Add Connector, then the Custom MCP Connector tab.",
      `Name it SurfingDog, with no space, and paste ${MCP_URL}; Connect. Le Chat finds that it needs no sign-in.`,
      "In a chat, switch its tools on and ask.",
    ],
    note: "An account's owner adds connectors on Free, Pro and Student; on a team plan, its admin.",
    source: {
      label: "Mistral: MCP connectors",
      href: "https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors",
    },
  },
  {
    slug: "grok",
    name: "Grok",
    maker: "xAI",
    reach: "paid",
    steps: [
      "grok.com/connectors: New Connector, then Custom.",
      `Paste ${MCP_URL}. No sign-in.`,
      `In Grok Bot, say: Add a custom MCP server called Surfing Dog at ${MCP_URL}.`,
    ],
    note: "Custom connectors are on xAI's paid plans; Grok Bot is in early beta.",
    source: { label: "xAI: Grok connectors", href: "https://docs.x.ai/grok/connectors" },
  },
  {
    slug: "perplexity",
    name: "Perplexity",
    maker: "Perplexity",
    reach: "paid",
    steps: [
      "In the web app: Settings, then Connectors, then add a custom connector.",
      `Choose remote, and paste ${MCP_URL}.`,
    ],
    note: "On Pro, Max and Enterprise. We have not yet confirmed that it connects to a server with no sign-in.",
    source: {
      label: "Perplexity Help Center: MCP",
      href: "https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity",
    },
  },
  {
    slug: "microsoft-copilot",
    name: "Copilot",
    maker: "Microsoft",
    reach: "not_yet",
    steps: [
      "The Copilot app takes no server of your own yet.",
      `A Copilot Studio agent can: add a tool, choose an existing MCP server, and give it ${MCP_URL}.`,
    ],
    source: {
      label: "Microsoft Learn: MCP in Copilot Studio",
      href: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent",
    },
  },
  {
    slug: "meta-ai",
    name: "Meta AI and Muse",
    maker: "Meta",
    reach: "region",
    steps: [
      `Muse: ask it to use ${MCP_URL}. It can build a connector from a server's address.`,
      "The Meta AI app takes no server of your own yet.",
    ],
    note: "Muse is in the US and Canada.",
    source: { label: "Meta: the Muse developer platform", href: "https://muse.ai/platform" },
  },
  {
    slug: "dots",
    name: "dots",
    maker: "OpenAI",
    reach: "not_yet",
    steps: ["dots work with the apps connected to your account. We found no way to add a server of your own yet."],
    source: { label: "OpenAI: introducing dots", href: "https://openai.com/index/introducing-dots/" },
  },
];

/** Where people write to us, and what each address is for. */
export const SUPPORT = {
  email: "hello@surfingdog.ai",
  privacy: "privacy@surfingdog.ai",
  abuse: "abuse@surfingdog.ai",
} as const;
