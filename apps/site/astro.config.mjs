// @ts-check
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

const GITHUB = "https://github.com/surfingdogai/inbox";

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
            "Surfing Dog lists and tracks agent-ready businesses: the ones AI agents can message, book and buy from. Three products: Search (find and check agent-ready businesses), Inbox (an open-source typed inbox a business runs so agents can write to it) and the Trust network (the directory's order, made of kept promises: signed pings and signed receipts, never bought).",
          // Release order: this line names the "directory" block of /v1/stats, so the site ships only
          // after the network that serves it (wave 1.5, then the directory counts) is deployed and
          // `curl https://surfingdog.ai/v1/stats | jq .directory` is not null (see src/lib/status.ts).
          details: [
            "Search: find businesses an AI agent can reach, with the doors each one opens. Over MCP at https://surfingdog.ai/mcp, over REST at https://surfingdog.ai/v1/businesses?q=<words>, or in a browser at https://surfingdog.ai/search?q=<words>. Live counts (businesses checked, agent-ready, and how many take messages, bookings, orders and payment or have a catalogue) are in the directory block of https://surfingdog.ai/v1/stats.",
            "Inbox: an open-source inbox for a business, with bookings, orders, quote requests and messages over REST, MCP and email. To install it, an AI follows https://surfingdog.ai/install.md. About it: https://surfingdog.ai/inbox.",
            "Trust network: inboxes check in with signed hourly pings, businesses and agents sign receipts for what was promised, and the directory's order reads kept promises. Nobody can pay for a place. The rules are versioned at https://surfingdog.ai/v1/ranking, the version in force and the next one announced. About it: https://surfingdog.ai/trust.",
            "Check a business: https://surfingdog.ai/check, or the MCP tool check_business. Results: https://surfingdog.ai/b/<domain>. Agentic score rules, versioned: https://surfingdog.ai/v1/score-rules.",
            "Leaderboards by category and place, the businesses where an agent can book, order or sign up above the rest, then by agentic score, separate from the directory's search order: https://surfingdog.ai/leaderboard.",
            "Discovery for agents: https://surfingdog.ai/.well-known/ai-catalog.json (ARD), the MCP server card at https://surfingdog.ai/.well-known/mcp/server-card.json and the A2A agent card at https://surfingdog.ai/.well-known/agent-card.json.",
            "The protocol is open: anyone can run a network. MIT example network, network-check, and @surfingdog/sdk on npm. The inbox server is AGPL-3.0: self-host it today; a hosted inbox is not open yet.",
            "Every inbox publishes one discovery manifest at `/.well-known/agent-inbox.json` that lists its REST, OpenAPI and MCP doors. A live instance answers at https://inbox.surfingdog.ai (manifest, OpenAPI at /openapi.json, MCP at /mcp).",
          ].join("\n\n"),
          optionalLinks: [
            { label: "Search", url: "https://surfingdog.ai/search" },
            { label: "Trust network", url: "https://surfingdog.ai/trust" },
            { label: "Install guide for an AI", url: "https://surfingdog.ai/install.md" },
            { label: "Directory MCP", url: "https://surfingdog.ai/mcp" },
            { label: "Directory API", url: "https://surfingdog.ai/v1/businesses" },
            { label: "Agentic score rules", url: "https://surfingdog.ai/v1/score-rules" },
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
