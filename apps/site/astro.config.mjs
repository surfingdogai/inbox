// @ts-check
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

const GITHUB = "https://github.com/surfingdogai/inbox";

/**
 * surfingdog.ai: a static Astro site. The landing page (the network), the inbox page and the blog are plain Astro pages on the
 * shared design tokens; the docs are Starlight, mounted under /docs. Everything prerenders to
 * apps/site/dist and is served from our own servers.
 */
export default defineConfig({
  site: "https://surfingdog.ai",
  trailingSlash: "ignore",
  // Keep the pre-7 whitespace rules: inline elements separated by a newline keep their space.
  compressHTML: true,
  integrations: [
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
      ],
      social: [{ icon: "github", label: "GitHub", href: GITHUB }],
      editLink: { baseUrl: `${GITHUB}/edit/main/apps/site/` },
      lastUpdated: false,
      credits: false,
      customCss: ["./src/styles/docs.css"],
      sidebar: [
        { label: "Home", link: "/" },
        { label: "Inbox", link: "/inbox/" },
        { label: "How it works", link: "/how-it-works/" },
        {
          label: "Start",
          items: ["docs", "docs/quickstart"],
        },
        {
          label: "Understand",
          items: ["docs/concepts", "docs/your-page", "docs/manifest", "docs/self-hosted-vs-hosted"],
        },
        {
          label: "Integrate",
          items: ["docs/connect-your-ai", "docs/api", "docs/feeds", "docs/webhooks", "docs/receipts"],
        },
        {
          label: "Trust",
          items: ["docs/security-and-privacy", "docs/contributing"],
        },
        { label: "Technical", link: "/technical/" },
        { label: "Blog", link: "/blog/" },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: "Surfing Dog",
          description:
            "Supporting businesses on the agentic internet. An open directory AI assistants can search to find businesses and reach them directly, and an open-source inbox that gives a business a door agents can use.",
          details: [
            "Today the directory lists businesses that run a verified inbox. Search it over MCP at https://network.surfingdog.ai/mcp, over REST at https://network.surfingdog.ai/v1/businesses, or read https://network.surfingdog.ai/llms.txt.",
            "Order: businesses whose inbox answered in the last day first; among them, those with a record of kept promises from signed receipts, then everyone else in a daily shuffle anyone can reproduce. Nobody can pay to move. Rules, versioned: https://network.surfingdog.ai/v1/ranking (version 6).",
            "Being built, not listed yet: a crawler that finds businesses with other agent doors (MCP, A2A, UCP, ACP, OpenAPI). How it behaves: https://network.surfingdog.ai/bot.",
            "The protocol is open: anyone can run a network. MIT example network, network-check, and @surfingdog/sdk on npm. The inbox server is AGPL-3.0: self-host it today; a hosted inbox is not open yet.",
            "Every inbox publishes one discovery manifest at `/.well-known/agent-inbox.json` that lists its REST, OpenAPI and MCP doors. A live instance answers at https://inbox.surfingdog.ai (manifest, OpenAPI at /openapi.json, MCP at /mcp).",
          ].join("\n\n"),
          optionalLinks: [
            { label: "Network MCP", url: "https://network.surfingdog.ai/mcp" },
            { label: "Network llms.txt", url: "https://network.surfingdog.ai/llms.txt" },
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
