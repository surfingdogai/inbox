import type { DiscoveryItem, DiscoveryResult, DiscoverySnippets } from "./types";

/**
 * "Let agents find your inbox" (ADR-022): the words, and the steps where most small businesses' sites are,
 * then any site: the spec's vectors/discovery-words.json, word for word (a hosted inbox's Connect page and
 * the WordPress plugin say the same). The steps were written from each platform's own help pages; they have
 * not been walked through in the platforms' panels yet.
 */

export type Block = "head" | "llms_line" | "llms_file" | "inbox_file";

export interface Platform {
  readonly id: "wordpress" | "shopify" | "wix" | "squarespace" | "other";
  readonly name: string;
  /** Where the platform's plugin is downloaded; with none, `soon` says it is coming, and no step installs it. */
  readonly download: string;
  readonly soon: string;
  readonly steps: readonly string[];
  readonly note: string;
  readonly blocks: readonly Block[];
}

export const PLATFORMS: readonly Platform[] = [
  {
    id: "wordpress",
    name: "WordPress",
    download: "",
    soon: "The Surfing Dog Inbox plugin is coming soon.",
    steps: [
      "For now, paste the head lines in your site's header: with a header-code plugin you already use, or ask your web person.",
    ],
    note: "",
    blocks: ["head"],
  },
  {
    id: "shopify",
    name: "Shopify",
    download: "",
    soon: "",
    steps: [
      "Online Store → Themes → Edit code, and open layout/theme.liquid.",
      "Paste the head lines just before </head>, and save.",
      "If robots.txt keeps assistants out: add the robots.txt template there, with the lines the check gives.",
    ],
    note: "The head lines are enough here: Shopify can't host the other files.",
    blocks: ["head"],
  },
  {
    id: "wix",
    name: "Wix",
    download: "",
    soon: "",
    steps: [
      "Settings → Custom Code → Add Custom Code.",
      "Paste the head lines, choose All pages and Head, and apply.",
      "If robots.txt keeps assistants out: open the Robots.txt Editor in your SEO settings.",
    ],
    note: "Custom code needs a premium Wix site with a domain connected. The head lines are enough here: Wix can't host the other files.",
    blocks: ["head"],
  },
  {
    id: "squarespace",
    name: "Squarespace",
    download: "",
    soon: "",
    steps: [
      "Open Code Injection (Website Tools, or Settings → Advanced).",
      "Paste the head lines in Header, and save.",
      "Squarespace writes robots.txt itself: if it keeps assistants out, look at Settings → Crawlers.",
    ],
    note: "Code Injection isn't on every Squarespace plan: check yours. The head lines are enough here: Squarespace can't host the other files.",
    blocks: ["head"],
  },
  {
    id: "other",
    name: "Another site",
    download: "",
    soon: "",
    steps: [
      "Paste the head lines inside <head> on every page.",
      "Add the llms.txt line to /llms.txt (create the file if there is none).",
      "Serve the inbox file at /.well-known/agent-inbox.json: a copy of your inbox's, or a redirect to it.",
    ],
    note: "",
    blocks: ["head", "llms_line", "llms_file", "inbox_file"],
  },
];

/** A check's state in the owner's words ({ways}, {host} filled in); an unknown state is not ready. */
export const VERDICTS: Readonly<Record<string, string>> = {
  ready: "Your website points agents to your inbox: {ways} of 5 ways in place.",
  dns_only: "Not on your website yet: the DNS record alone points to your inbox.",
  no_way: "Not yet: your website doesn't point to your inbox.",
  unreachable: "Not yet: the inbox doesn't answer at {host}.",
  blocked: "Not yet: robots.txt keeps AI assistants out.",
  robots_unreadable: "Not yet: robots.txt can't be read, so assistants read nothing.",
  not_ready: "Not yet: {ways} of 5 ways in place.",
};

/** The checker's items in the owner's words. */
export const ITEM_WORDS: Record<DiscoveryItem["id"], string> = {
  cname: "Inbox address",
  manifest: "Your inbox",
  robots: "robots.txt",
  well_known: "Inbox file on your site",
  llms_txt: "llms.txt",
  link: "Link in your pages",
  schema_org: "Structured data",
  dns_txt: "DNS pointer",
};

/** The two groups the items show in. */
export const GROUPS = { inbox: "Your inbox", site: "From {domain}: {ways} of 5" } as const;
export const GROUP_OF: Record<DiscoveryItem["id"], keyof typeof GROUPS> = {
  cname: "inbox",
  manifest: "inbox",
  robots: "inbox",
  well_known: "site",
  llms_txt: "site",
  link: "site",
  schema_org: "site",
  dns_txt: "site",
};

export const ROBOTS_LEAD = "Add these lines at the top of robots.txt:";
export const ROBOTS_NOTE = "Blocking training crawlers is fine: it doesn't stop assistants.";
export const DNS_RECORD = "Also, if you manage DNS: one record";
export const DNS_RECORD_LINE = "A DNS record, next to the one for your inbox";

/** The items whose fix shows under them: the ones the lines on the page do not already give. */
export const FIX_SHOWN: ReadonlySet<DiscoveryItem["id"]> = new Set(["cname", "manifest", "robots"]);

/** The verdict for a check. */
export function verdict(r: Pick<DiscoveryResult, "state" | "ready" | "ways" | "host">): string {
  const v = (r.state && VERDICTS[r.state]) || (r.ready ? VERDICTS.ready : VERDICTS.not_ready) || "";
  return v.replace("{ways}", String(r.ways)).replace("{host}", r.host);
}

/** An item's detail as a row says it: the label it starts with taken off, a missing item not there yet. */
export function shortDetail(detail: string, state: string, domain: string): string {
  if (state === "missing" && !detail.includes("could not be read")) return "Not there yet.";
  for (const p of [
    "robots.txt ",
    "llms.txt ",
    `https://${domain}/.well-known/agent-inbox.json `,
    `_agent-inbox.${domain} `,
    `https://${domain}/robots.txt `,
    `https://${domain}/llms.txt `,
  ]) {
    if (detail.startsWith(p)) {
      const d = detail
        .slice(p.length)
        .replace("keeps out AI assistants that people use", "keeps out assistants people use");
      return d.charAt(0).toUpperCase() + d.slice(1);
    }
  }
  return detail;
}

/** The head lines: the link and the structured data, together. */
export const headLines = (s: DiscoverySnippets) => `${s.link_tag}\n${s.json_ld}`;

/** mailto: percent-encoding (RFC 6068): spaces as %20, never +. */
const mailtoEscape = (s: string) => encodeURIComponent(s);

/** The email for whoever runs the site: nothing is sent from here. */
export function webPersonEmail(domain: string, host: string, s: DiscoverySnippets): string {
  return (
    "Hello,\r\n\r\n" +
    `Our agent inbox is live at ${host}. Could you add these to ${domain}, so that AI agents find it?\r\n\r\n` +
    `1. Inside <head> on every page:\r\n\r\n${s.link_tag}\r\n${s.json_ld}\r\n\r\n` +
    `2. In https://${domain}/llms.txt (create it if there is none):\r\n\r\n${s.llms_line}\r\n\r\n` +
    `3. At ${s.well_known}: a copy of ${s.manifest}, or a redirect to it.\r\n\r\n` +
    `4. A DNS record at ${domain}: type TXT, name ${s.dns_name}, value ${s.dns_value}\r\n\r\n` +
    "And please make sure robots.txt doesn't keep out AI assistants (ChatGPT-User, Claude-User, Perplexity-User and the like).\r\n\r\n" +
    "Thank you\r\n"
  );
}

/** The same email, opened in the owner's own mail. */
export function webPersonMailto(domain: string, host: string, s: DiscoverySnippets): string {
  return `mailto:?subject=${mailtoEscape(`Let AI agents find our inbox at ${host}`)}&body=${mailtoEscape(webPersonEmail(domain, host, s))}`;
}
