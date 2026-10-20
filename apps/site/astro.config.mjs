// @ts-check
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import { BEACON_HEAD } from "./src/lib/analytics.ts";
import { headingIdsMarkdown } from "./src/lib/heading-ids.ts";
import { HOSTED_LLMS, HOSTED_OWNERSHIP } from "./src/lib/hosted.ts";
import { hostedPilotMarkdown } from "./src/lib/hosted-markdown.ts";
import { alternates, pageAt } from "./src/lib/i18n.ts";
import { freeToolsLlms } from "./src/lib/local.ts";

const GITHUB = "https://github.com/surfingdogai/inbox";

/**
 * The network's own sitemap: the checker, the leaderboards and the result pages it serves on this
 * address. robots.txt names it, and the sitemap index lists it beside this site's pages.
 */
const NETWORK_SITEMAP = "https://surfingdog.ai/sitemap-checks.xml";

/**
 * surfingdog.ai: a static Astro site. The home page, the three product pages (/search, /inbox, /trust) and the blog are plain Astro pages on the
 * shared design tokens; the docs are Starlight, mounted under /docs. Everything prerenders to
 * apps/site/dist and is served from our own servers.
 */
export default defineConfig({
  site: "https://surfingdog.ai",
  trailingSlash: "ignore",
  // Keep the pre-7 whitespace rules: inline elements separated by a newline keep their space.
  compressHTML: true,
  integrations: [
    // Docs written in two versions, one for each state of the hosted pilot, keep the one the switch
    // says (src/lib/hosted-markdown.ts).
    hostedPilotMarkdown(),
    // A heading may name its own id: `### Membership {#subscription}` (src/lib/heading-ids.ts).
    headingIdsMarkdown(),
    // Starlight adds this integration itself when it is missing; given here, it also lists the
    // network's sitemap in sitemap-index.xml. A translated page (src/lib/i18n.ts) carries every
    // version of itself, x-default included, as the same hreflang links its head has.
    sitemap({
      customSitemaps: [NETWORK_SITEMAP],
      serialize(item) {
        const page = pageAt(new URL(item.url).pathname);
        if (page) item.links = alternates(page.id).map((a) => ({ url: a.href, lang: a.hreflang }));
        return item;
      },
    }),
    starlight({
      title: "Surfing Dog Inbox",
      description:
        "Docs for Surfing Dog Inbox: an open-source typed inbox for people and AI agents. Bookings, orders, quotes and messages, from anyone and any agent.",
      // The striped half sun, the same mark the site's bar carries.
      logo: { src: "./public/mark.svg", alt: "Surfing Dog" },
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "icon", href: "/favicon.ico", sizes: "32x32" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://surfingdog.ai/art/og-inbox-v1.png" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://surfingdog.ai/art/og-inbox-v1.png" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        // The theme chosen in the docs reaches the network's pages under this domain, which carry no
        // script and read the sd_theme cookie instead; and a choice made there (their switch writes
        // the cookie) is adopted here. The same rules as src/layouts/Layout.astro.
        {
          tag: "script",
          content:
            '(()=>{try{const h=location.hostname;const rest="; Path=/; SameSite=Lax"+(h==="surfingdog.ai"||h.endsWith(".surfingdog.ai")?"; Domain=surfingdog.ai":"")+(location.protocol==="https:"?"; Secure":"");const write=(v)=>{document.cookie="sd_theme="+v+"; Max-Age=31536000"+rest};const t=localStorage.getItem("starlight-theme");const want=t==="light"||t==="dark"?t:"";const c=(document.cookie.match(/(?:^|; )sd_theme=([^;]*)/)||[])[1]||"";if(c==="light"||c==="dark"||c==="auto"){const chosen=c==="auto"?"":c;if(chosen!==want){localStorage.setItem("starlight-theme",chosen);document.documentElement.dataset.theme=chosen||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark")}}else if(want){write(want)}document.addEventListener("change",(e)=>{const s=e.target;if(s instanceof HTMLSelectElement&&s.closest("starlight-theme-select")){const v=s.value;write(v==="light"||v==="dark"?v:"auto")}})}catch{}})();',
        },
        // Cloudflare Web Analytics, only in the surfingdog.ai build, as on the site's pages
        // (src/lib/analytics.ts).
        ...BEACON_HEAD,
      ],
      social: [{ icon: "github", label: "GitHub", href: GITHUB }],
      editLink: { baseUrl: `${GITHUB}/edit/main/apps/site/` },
      lastUpdated: false,
      credits: false,
      customCss: ["./src/styles/docs.css"],
      sidebar: [
        { label: "Home", link: "/" },
        { label: "Search", link: "/search/" },
        { label: "Inbox", link: "/inbox/" },
        { label: "Trust network", link: "/trust/" },
        { label: "How it works", link: "/how-it-works/" },
        {
          label: "Start",
          items: ["docs", "docs/get-your-agent-inbox", "docs/quickstart", "docs/setting-up-for-agents"],
        },
        {
          label: "Understand",
          items: ["docs/concepts", "docs/your-page", "docs/manifest", "docs/self-hosted-vs-hosted"],
        },
        {
          label: "Integrate",
          items: [
            "docs/mcp",
            "docs/connect-your-ai",
            "docs/api",
            "docs/integrations",
            "docs/calendars",
            "docs/payments",
            // One page per connector, as each is built: docs/connectors/<name>.md, ordered by its own frontmatter.
            { label: "Connectors", collapsed: true, items: [{ autogenerate: { directory: "docs/connectors" } }] },
            "docs/feeds",
            "docs/webhooks",
            "docs/receipts",
          ],
        },
        {
          label: "Trust",
          items: ["docs/security-and-privacy", "docs/contributing"],
        },
        {
          label: "Specs",
          items: [
            { label: "Overview", link: "/spec/" },
            "spec/capabilities",
            "spec/manifest",
            "spec/receipts",
            "spec/census",
            { label: "Check a manifest or a receipt", link: "/spec/check/" },
          ],
        },
        { label: "Technical", link: "/technical/" },
        { label: "Blog", link: "/blog/" },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: "Surfing Dog",
          description: `Surfing Dog lists and tracks agent-ready businesses: the ones AI agents can message, book and buy from. Three products: Search (find and check agent-ready businesses, whatever software they use), Inbox (${HOSTED_LLMS.summary}) and the Trust network (optional and separate: it lists a business and records the receipts its inbox signs, never its messages; the directory's order is made of kept promises, never bought).`,
          // Release order: this line names the "directory" block of /v1/stats, so the site ships only
          // after the network that serves it (wave 1.5, then the directory counts) is deployed and
          // `curl https://surfingdog.ai/v1/stats | jq .directory` is not null (see src/lib/status.ts).
          details: [
            "Search: find businesses an AI agent can reach, with the doors each one opens, whatever software opens them: MCP, A2A, UCP, ACP, an API, or Surfing Dog Inbox. Over MCP at https://surfingdog.ai/mcp, over REST at https://surfingdog.ai/v1/businesses?q=<words>, or in a browser at https://surfingdog.ai/search?q=<words>. The same MCP server carries a person's question, quote request or booking request to a business's own inbox when the business allows it (ask_business, request_quote, request_booking): Surfing Dog never touches the money and never keeps what anyone writes, and keeps only a record that a request was delivered. Live counts (agent-ready businesses, and how many take messages, bookings, orders and payment or have a catalogue) are in the directory block of https://surfingdog.ai/v1/stats. Connecting to it (transport, tools, limits, examples): https://surfingdog.ai/docs/mcp/; each assistant's steps: https://surfingdog.ai/assistants/.",
            `Inbox: the business's own inbox, open source (MIT), for bookings, orders, quote requests and messages over REST, MCP and email. It runs on the business's own subdomain (for example inbox.yourbusiness.com), ${HOSTED_LLMS.where}. Its manifest and doors live on the business's domain and name the business, and customers and their agents write to the business there, directly. ${HOSTED_OWNERSHIP.llms} ${HOSTED_LLMS.get} About it: https://surfingdog.ai/inbox.`,
            "Trust network: optional and separate from the inbox; joining is the business's choice. It lists the business in the directory and records the receipts its inbox signs (bookings confirmed, orders accepted, and how they ended), with no names, no messages and nothing of what was ordered; everything a network receives is listed at https://surfingdog.ai/network#shared. Inboxes check in with signed hourly pings, businesses and agents sign receipts for what was promised, and the directory's order reads kept promises. Nobody can pay for a place. The rules are versioned at https://surfingdog.ai/v1/ranking, the version in force and the next one announced. About it: https://surfingdog.ai/trust.",
            "Setting a business up for agents: guidance from a real installation, recommendations and not rules (a business may use other tools and other ways). The inbox as a business's front door, or as a thin agent door in front of the helpdesk (Intercom, Zendesk, Salesforce, HubSpot, Freshdesk), booking system, checkout or own AI it already has; deciding what handles each door; making doors findable; the full journey after an order or a booking; how agents pay; bridges to helpdesks and chat apps. Plain Markdown for an AI: https://surfingdog.ai/setting-up-for-agents.md; the same page for people: https://surfingdog.ai/docs/setting-up-for-agents/.",
            "Check a business: https://surfingdog.ai/check, or the MCP tool check_business. Results: https://surfingdog.ai/b/<domain>. Agentic score rules, versioned: https://surfingdog.ai/v1/score-rules.",
            "Guides, for any business anywhere and no vendor in particular: what makes a business ready for AI agents, and how to let a customer's AI assistant book, order, message or ask for a quote, and pay; publishing hours, prices and terms as data; making agent doors findable; what llms.txt does and doesn't; robots.txt and content signals. Each says what the check counts and ends with a way to check the change worked: https://surfingdog.ai/guides/.",
            "Leaderboards by category and place, the businesses where an agent can book, order or sign up above the rest, then by agentic score, separate from the directory's search order: https://surfingdog.ai/leaderboard.",
            "Discovery for agents: https://surfingdog.ai/.well-known/ai-catalog.json (ARD), the MCP server card at https://surfingdog.ai/.well-known/mcp/server-card.json and the A2A agent card at https://surfingdog.ai/.well-known/agent-card.json.",
            "Specs, versioned, with JSON Schemas and test vectors (MIT): what an AI agent can do at a business, capability by capability, with the evidence for each and how MCP, A2A, OpenAPI, REST, UCP and ACP doors carry it (https://surfingdog.ai/spec/capabilities.json); the agent inbox manifest; receipts; and the census's method. Index for machines: https://surfingdog.ai/spec/index.json. Check a manifest or a receipt: https://surfingdog.ai/spec/check/.",
            `The protocol is open: anyone can run a network. Everything is MIT: the inbox server, the example network, network-check, and @surfingdog/sdk on npm. ${HOSTED_LLMS.open}`,
            "Every inbox publishes one discovery manifest at `/.well-known/agent-inbox.json` that lists its REST, OpenAPI and MCP doors. A business's inbox answers at its own address; our demo instance answers at https://inbox.surfingdog.ai (manifest, OpenAPI at /openapi.json, MCP at /mcp).",
            // Last, so it reads as the file's first list section, before the plugin's own: the free
            // tools and their guides, a Markdown link a line (src/lib/local.ts). Release order: it
            // names the network's free-tools pages, so this ships after them (src/lib/i18n.ts).
            freeToolsLlms(),
          ].join("\n\n"),
          optionalLinks: [
            { label: "Search", url: "https://surfingdog.ai/search" },
            { label: "Trust network", url: "https://surfingdog.ai/trust" },
            { label: "Install guide for an AI", url: "https://surfingdog.ai/install.md" },
            {
              label: "Setting a business up for agents: guidance",
              url: "https://surfingdog.ai/setting-up-for-agents.md",
            },
            { label: "Surfing Dog Search over MCP", url: "https://surfingdog.ai/mcp" },
            { label: "Directory API", url: "https://surfingdog.ai/v1/businesses" },
            { label: "Agentic score rules", url: "https://surfingdog.ai/v1/score-rules" },
            { label: "Specs and their index", url: "https://surfingdog.ai/spec/index.json" },
            { label: "What an AI agent can do: the vocabulary", url: "https://surfingdog.ai/spec/capabilities.json" },
            { label: "AI catalog (ARD)", url: "https://surfingdog.ai/.well-known/ai-catalog.json" },
            { label: "Live demo manifest", url: "https://inbox.surfingdog.ai/.well-known/agent-inbox.json" },
            { label: "Live OpenAPI document", url: "https://inbox.surfingdog.ai/openapi.json" },
            { label: "Source on GitHub", url: GITHUB },
          ],
        }),
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
