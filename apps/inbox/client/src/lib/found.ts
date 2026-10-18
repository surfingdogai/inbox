import type { DiscoveryItem, DiscoverySnippets } from "./types";

/**
 * "Let agents find your inbox" (ADR-022): the steps where most small businesses' sites are, then any
 * site, and the email for whoever runs it. The same steps as a hosted inbox's Connect page.
 */

export interface Platform {
  readonly id: "wordpress" | "shopify" | "wix" | "squarespace" | "other";
  readonly name: string;
  readonly steps: readonly string[];
  readonly note?: string;
}

export const PLATFORMS: readonly Platform[] = [
  {
    id: "wordpress",
    name: "WordPress",
    steps: [
      "Install the Surfing Dog Inbox plugin: Plugins → Add New Plugin → Upload Plugin, then Activate.",
      "Settings → Agent inbox: check the address, and save.",
      "It adds the link, the structured data, the llms.txt line and the manifest for you.",
    ],
  },
  {
    id: "shopify",
    name: "Shopify",
    steps: [
      "Online Store → Themes → Edit code, and open layout/theme.liquid.",
      "Paste the head lines just before </head>, and save.",
      "If robots.txt keeps assistants out: add the robots.txt template there, with the lines the check gives.",
    ],
  },
  {
    id: "wix",
    name: "Wix",
    steps: [
      "Settings → Custom Code → Add Custom Code.",
      "Paste the head lines, choose All pages and Head, and apply.",
      "If robots.txt keeps assistants out: open the Robots.txt Editor in your SEO settings.",
    ],
    note: "Custom code needs a premium Wix site with a domain connected.",
  },
  {
    id: "squarespace",
    name: "Squarespace",
    steps: [
      "Open Code Injection (Website Tools, or Settings → Advanced).",
      "Paste the head lines in Header, and save.",
      "Squarespace writes robots.txt itself: if it keeps assistants out, look at Settings → Crawlers.",
    ],
  },
  {
    id: "other",
    name: "Another site",
    steps: [
      "Paste the head lines inside <head> on every page.",
      "Add the llms.txt line to /llms.txt, or create it with the file below.",
      "Serve the inbox's manifest at /.well-known/agent-inbox.json: a copy, or a redirect to it.",
    ],
  },
];

/** The checker's items in the owner's words. */
export const ITEM_WORDS: Record<DiscoveryItem["id"], string> = {
  cname: "DNS record",
  manifest: "Your inbox",
  robots: "robots.txt",
  well_known: "/.well-known/agent-inbox.json",
  llms_txt: "llms.txt",
  link: "Link in your pages",
  schema_org: "Structured data",
  dns_txt: "_agent-inbox record",
};

/** The items whose fix shows under them: the ones the lines on the page do not already give. */
export const FIX_SHOWN: ReadonlySet<DiscoveryItem["id"]> = new Set(["cname", "manifest", "robots"]);

/** The head lines: the link and the structured data, together. */
export const headLines = (s: DiscoverySnippets) => `${s.link_tag}\n${s.json_ld}`;

/** mailto: percent-encoding (RFC 6068): spaces as %20, never +. */
const mailtoEscape = (s: string) => encodeURIComponent(s);

/** The email for whoever runs the site, opened in the owner's own mail: nothing is sent from here. */
export function webPersonMailto(domain: string, host: string, s: DiscoverySnippets): string {
  const body =
    "Hello,\r\n\r\n" +
    `Our agent inbox is live at ${host}. Could you add these to ${domain}, so that AI agents find it?\r\n\r\n` +
    `1. Inside <head> on every page:\r\n\r\n${s.link_tag}\r\n${s.json_ld}\r\n\r\n` +
    `2. In https://${domain}/llms.txt (create it if there is none):\r\n\r\n${s.llms_line}\r\n\r\n` +
    `3. At ${s.well_known}: a copy of ${s.manifest}, or a redirect to it.\r\n\r\n` +
    `4. A DNS record at ${domain}: type TXT, name ${s.dns_name}, value ${s.dns_value}\r\n\r\n` +
    "And please make sure robots.txt doesn't keep out AI assistants (ChatGPT-User, Claude-User, Perplexity-User and the like).\r\n\r\n" +
    "Thank you\r\n";
  return `mailto:?subject=${mailtoEscape(`Let AI agents find our inbox at ${host}`)}&body=${mailtoEscape(body)}`;
}
