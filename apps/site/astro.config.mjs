// @ts-check
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

const GITHUB = "https://github.com/surfingdogai/inbox";

/**
 * surfingdog.ai: a static Astro site. The landing page and the blog are plain Astro pages on the
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
      logo: { src: "./public/logo.png", alt: "Surfing Dog" },
      favicon: "/favicon-32.png",
      head: [
        { tag: "link", attrs: { rel: "icon", href: "/favicon.ico", sizes: "32x32" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://surfingdog.ai/art/og.png" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
      ],
      social: [{ icon: "github", label: "GitHub", href: GITHUB }],
      editLink: { baseUrl: `${GITHUB}/edit/main/apps/site/` },
      lastUpdated: false,
      credits: false,
      customCss: ["./src/styles/docs.css"],
      sidebar: [
        { label: "Home", link: "/" },
        {
          label: "Start",
          items: ["docs", "docs/quickstart"],
        },
        {
          label: "Understand",
          items: ["docs/concepts", "docs/manifest", "docs/self-hosted-vs-hosted"],
        },
        {
          label: "Integrate",
          items: ["docs/connect-your-ai", "docs/api"],
        },
        {
          label: "Trust",
          items: ["docs/security-and-privacy", "docs/contributing"],
        },
        { label: "Blog", link: "/blog/" },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: "Surfing Dog Inbox",
          description:
            "An open-source, self-hostable typed inbox for businesses. It receives bookings, orders, quote requests and messages from people and from AI agents through REST, MCP, email and a web form, and turns them into typed items with a lifecycle handled by rules, the owner, or the owner's own AI.",
          details: [
            "Every instance publishes one discovery manifest at `/.well-known/agent-inbox.json` that lists the doors an agent may use.",
            "A live demo instance answers at https://inbox.surfingdog.ai (manifest, OpenAPI at /openapi.json, MCP at /mcp).",
            "The server is AGPL-3.0; the spec and the SDK are MIT. Hosted tenancy and the network's reviews arrive in a later release.",
          ].join("\n\n"),
          optionalLinks: [
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
