import { z } from "zod";
import { MANIFEST_PATH } from "../base";
import { timestampSchema } from "./common";

/**
 * How an AI agent that knows only a business's domain finds its inbox (ADR-002, ADR-022): the inbox
 * answers at its own host (inbox.<domain> by default), and the domain leads to it in one or more
 * ways, each a line the business adds where it already publishes things:
 *
 * - `well_known`: the domain's own `/.well-known/agent-inbox.json`, a copy of the inbox's manifest or a
 *   redirect to it;
 * - `llms_txt`: a line in the domain's `llms.txt` naming the inbox's manifest;
 * - `link`: `<link rel="agent-inbox" href="…/agent-inbox.json">` in the pages' `<head>` (or the same
 *   relation in an HTTP `Link` field);
 * - `schema_org`: a schema.org `potentialAction` whose target is the inbox's manifest;
 * - `dns_txt`: `_agent-inbox.<domain> TXT "v=sdi1; manifest=<url>"`.
 *
 * `discoverySnippets` writes those lines for one business; `vectors/discovery.json` holds what every
 * builder of them gives (the owner app, a hosted inbox's Connect page, a network's discovery check).
 */

/** The link relation a page names its inbox with. */
export const DISCOVERY_REL = "agent-inbox";

/** The DNS pointer's name under the domain, and the version its value starts with. */
export const DISCOVERY_DNS_NAME = "_agent-inbox";
export const DISCOVERY_DNS_VERSION = "v=sdi1";

/**
 * The robots.txt tokens of AI assistants that fetch a page because a person asked: keeping them out
 * keeps people's AIs from the business. Training crawlers are not here; keeping those out is the
 * owner's choice and does not stop an assistant.
 */
export const AI_ASSISTANT_AGENTS = [
  "ChatGPT-User",
  "Claude-User",
  "Google-CloudVertexBot",
  "Perplexity-User",
  "Meta-ExternalFetcher",
  "DuckAssistBot",
  "MistralAI-User",
] as const;

/** The assistants' own search: keeping it out means they find the business less often. */
export const AI_ASSISTANT_SEARCH = ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "YouBot"] as const;

/** The lines a business adds for each way, for its inbox at one host. */
export interface DiscoverySnippets {
  manifest: string;
  llms_line: string;
  llms_file: string;
  link_tag: string;
  link_header: string;
  json_ld: string;
  dns_name: string;
  dns_value: string;
  well_known: string;
  robots: string;
}

/** Text on one line: line breaks and runs of white space as one space. */
const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/**
 * JSON for inside a `<script>`: `<`, `>`, `&`, U+2028 and U+2029 escaped, so a name can never close the
 * element or break the line (what Go's encoding/json writes, byte for byte).
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The lines for the business at `domain` (named `name`, else its domain) whose inbox answers at
 * `host`. The JSON-LD's keys are in code-point order at every level, as a network writes them.
 */
export function discoverySnippets(domain: string, host: string, name = ""): DiscoverySnippets {
  const business = oneLine(name) || domain;
  const manifest = `https://${host}${MANIFEST_PATH}`;
  const line = `- [Agent inbox](${manifest}): send us messages and requests`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: business,
    potentialAction: {
      "@type": "CommunicateAction",
      name: "Message us",
      target: { "@type": "EntryPoint", contentType: "application/json", urlTemplate: manifest },
    },
    url: `https://${domain}/`,
  };
  return {
    manifest,
    llms_line: line,
    llms_file: `# ${business}\n\n## Agents\n\n${line}\n`,
    link_tag: `<link rel="${DISCOVERY_REL}" type="application/json" href="${manifest}">`,
    link_header: `Link: <${manifest}>; rel="${DISCOVERY_REL}"`,
    json_ld: `<script type="application/ld+json">${scriptJson(ld)}</script>`,
    dns_name: DISCOVERY_DNS_NAME,
    dns_value: `${DISCOVERY_DNS_VERSION}; manifest=${manifest}`,
    well_known: `https://${domain}${MANIFEST_PATH}`,
    robots: `${AI_ASSISTANT_AGENTS.map((a) => `User-agent: ${a}`).join("\n")}\nAllow: /\n`,
  };
}

/* --- GET /v1/discovery/{domain} and check_dns ----------------------------------------------------------------------- */

export const discoveryItemIdSchema = z.enum([
  "cname",
  "manifest",
  "robots",
  "well_known",
  "llms_txt",
  "link",
  "schema_org",
  "dns_txt",
]);

/** The ways that lead from the business's website to its inbox: what a check needs one of to be ready. */
export const DISCOVERY_SITE_WAYS = ["well_known", "llms_txt", "link", "schema_org"] as const;

/**
 * What a check found, as a whole: `ready`; `unreachable`, the inbox does not answer at its host;
 * `blocked`, robots.txt keeps AI assistants out; `robots_unreadable`, robots.txt cannot be read, so crawlers
 * that follow it read nothing; `dns_only`, only the DNS pointer leads to the inbox (few agents read it yet);
 * `no_way`, nothing does. New states may be added: a reader takes one it does not know as not ready.
 */
export const DISCOVERY_STATES = ["ready", "unreachable", "blocked", "robots_unreadable", "dns_only", "no_way"] as const;
export type DiscoveryState = (typeof DISCOVERY_STATES)[number];

/** The platforms a check names, for their steps (vectors/discovery-words.json). */
export const DISCOVERY_PLATFORMS = ["wordpress", "shopify", "wix", "squarespace"] as const;
export type DiscoveryPlatform = (typeof DISCOVERY_PLATFORMS)[number];

/** One thing a discovery check looked at, and when it is not found, the exact fix. */
export const discoveryItemSchema = z.object({
  id: discoveryItemIdSchema,
  need: z
    .enum(["required", "recommended", "optional"])
    .describe(
      "required: the inbox cannot be reached without it; recommended and optional: ways the domain leads to it.",
    ),
  state: z
    .enum(["ok", "missing", "wrong", "blocked", "unreadable"])
    .describe(
      "ok: found as it should be; missing; wrong: there, pointing elsewhere; blocked: robots.txt keeps AI assistants out; unreadable: could not be read, with why.",
    ),
  detail: z.string().describe("One sentence: what was found."),
  fix: z.string().optional().describe("The exact record, line or file to add, when it is not ok."),
  fix_lines: z.string().optional().describe("The text to paste, alone, when the fix is one."),
});
export type DiscoveryItem = z.infer<typeof discoveryItemSchema>;

/**
 * `GET /v1/discovery/{domain}`: whether agents find a business's inbox from its domain. It never says whether a
 * host is a hosted inbox's: that is its owner's to see, on its own Connect page.
 */
export const discoveryResultSchema = z.object({
  domain: z.string().describe("The business's own domain (its registrable domain)."),
  host: z.string().describe("Where the inbox answers: inbox.<domain> unless another was named."),
  manifest: z.url().describe("The inbox's manifest: https://<host>/.well-known/agent-inbox.json."),
  checked_at: timestampSchema,
  ready: z
    .boolean()
    .describe(
      "The inbox answers at its host, robots.txt keeps no AI assistant out, and at least one way on the business's website leads to it (the DNS pointer alone does not).",
    ),
  state: z.enum(DISCOVERY_STATES).describe("What the check found, as a whole; ready is state ready."),
  ways: z.int().min(0).max(5).describe("How many of well_known, llms_txt, link, schema_org and dns_txt lead to it."),
  site_ways: z.int().min(0).max(4).describe("How many of those are on the website (all but dns_txt)."),
  platform: z
    .enum(DISCOVERY_PLATFORMS)
    .optional()
    .describe("The site's platform, when its homepage (or the network's last read of it) shows one of these."),
  next: z.string().describe("The one step worth doing first."),
  items: z.array(discoveryItemSchema),
});
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;

/**
 * A network's answer as an inbox reads it: leniently, since a network grows before the inboxes that ask it
 * are upgraded. An item whose id or state this version does not know is left out, a state it does not know is
 * read as not ready, and ways and site_ways have no ceiling. `discoveryResultSchema` stays the network's own
 * contract.
 */
export interface DiscoveryAnswer {
  readonly domain: string;
  readonly host: string;
  readonly manifest: string;
  readonly checked_at: string;
  readonly ready: boolean;
  readonly state?: DiscoveryState | undefined;
  readonly ways: number;
  readonly site_ways?: number | undefined;
  readonly platform?: DiscoveryPlatform | undefined;
  readonly next: string;
  readonly items: readonly DiscoveryItem[];
}

const discoveryAnswerShape = z.object({
  domain: z.string(),
  host: z.string(),
  manifest: z.string(),
  checked_at: z.string(),
  ready: z.boolean(),
  state: z.string().optional(),
  ways: z.int().min(0),
  site_ways: z.int().min(0).optional(),
  platform: z.string().optional(),
  next: z.string(),
  items: z.array(z.unknown()),
});

/** Reads a network's answer as an inbox does (`DiscoveryAnswer`); null for one that is not a check at all. */
export function readDiscoveryAnswer(value: unknown): DiscoveryAnswer | null {
  const r = discoveryAnswerShape.safeParse(value);
  if (!r.success) return null;
  const a = r.data;
  const items: DiscoveryItem[] = [];
  for (const it of a.items) {
    const p = discoveryItemSchema.safeParse(it);
    if (p.success) items.push(p.data);
  }
  const state = (DISCOVERY_STATES as readonly string[]).includes(a.state ?? "")
    ? (a.state as DiscoveryState)
    : undefined;
  const platform = (DISCOVERY_PLATFORMS as readonly string[]).includes(a.platform ?? "")
    ? (a.platform as DiscoveryPlatform)
    : undefined;
  return {
    domain: a.domain,
    host: a.host,
    manifest: a.manifest,
    checked_at: a.checked_at,
    ready: a.ready && (state === undefined ? a.state === undefined : state === "ready"),
    state,
    ways: a.ways,
    site_ways: a.site_ways,
    platform,
    next: a.next,
    items,
  };
}

/** `check_dns`: is the inbox's DNS record in place, and does the domain lead agents to it. */
export const checkDnsInputSchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe("The business's own domain, like salon.example (a URL is read as its domain)."),
  host: z
    .string()
    .max(253)
    .optional()
    .describe("Where the inbox answers, when not inbox.<domain>: the domain itself or a name under it."),
  target: z
    .string()
    .max(253)
    .optional()
    .describe("The CNAME target the host must point to, when known (a hosted inbox's Connect page shows it)."),
});
export type CheckDnsInput = z.infer<typeof checkDnsInputSchema>;
export const checkDnsOutputSchema = discoveryResultSchema;
export type CheckDnsOutput = DiscoveryResult;

/* --- start_inbox ---------------------------------------------------------------------------------------------------- */

/** `start_inbox`: the link where a business's owner sets up a hosted Surfing Dog Inbox themselves. */
export const startInboxInputSchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe("The business's own domain, like salon.example (a URL is read as its domain)."),
});
export type StartInboxInput = z.infer<typeof startInboxInputSchema>;

export const startInboxOutputSchema = z.object({
  domain: z.string(),
  status: z
    .enum(["available", "has_inbox", "unavailable"])
    .describe(
      "available: start_url sets one up; has_inbox: the business already runs one; unavailable: not for this domain now, with why.",
    ),
  start_url: z
    .url()
    .optional()
    .describe(
      "The setup page, with the domain and nothing else in it. The owner opens it and types their own email; nothing is signed up by this call.",
    ),
  host: z
    .string()
    .describe("Where the inbox goes live once the owner adds one DNS record: inbox.<domain> unless they pick another."),
  why: z
    .enum(["ours", "hosting_suffix", "health", "off"])
    .optional()
    .describe(
      "ours: an address of Surfing Dog's; hosting_suffix: an address at a hosting platform, where no DNS record can be added; health: health practices wait for now; off: not offered by this network now.",
    ),
  platform: z.string().optional().describe("The hosting platform's suffix, for hosting_suffix."),
  self_host: z.url().describe("The open-source inbox, to run on the business's own servers instead."),
  detail: z.string().describe("What to tell the owner, in a few sentences."),
});
export type StartInboxOutput = z.infer<typeof startInboxOutputSchema>;
