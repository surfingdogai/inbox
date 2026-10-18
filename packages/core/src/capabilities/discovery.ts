import {
  type DiscoveryResult,
  type DiscoverySnippets,
  discoveryResultSchema,
  discoverySnippets,
  MANIFEST_PATH,
} from "@surfingdog/spec";
import type { Settings } from "../settings/schema";
import { DEFAULT_NETWORK } from "../settings/schema";
import { isPublicHost } from "../util/hosts";
import { WriteError } from "../write/errors";

/**
 * "Let agents find your inbox" (ADR-022): the inbox answers at its own host, and the business's main
 * site leads an agent there in a few lines it publishes where it already publishes things (a link in
 * its pages, schema.org structured data, a line in llms.txt, its own /.well-known/agent-inbox.json,
 * a DNS record). This works out those lines for this inbox, and asks a network's discovery check
 * (`GET /v1/discovery/{domain}`) whether they are in place, when the owner asks.
 */

/** Where the lines go and where they point: the business's own domain and this inbox's host. */
export interface DiscoveryTarget {
  /** The business's own domain, its website's host without www.; null when it has no website named. */
  readonly domain: string | null;
  /** How the domain was known: the website in Settings, the host's record of it, or guessed from the inbox's own host. */
  readonly domainFrom: "website" | "host" | "inbox" | null;
  /** This inbox's own host; null when it has no public address yet. */
  readonly host: string | null;
}

/** The owner's view: where, the lines, and the network that checks them. */
export interface DiscoveryView extends DiscoveryTarget {
  readonly name: string;
  readonly manifest: string | null;
  readonly snippets: DiscoverySnippets | null;
  readonly checker: string;
}

/** A host without its trailing dot, lower case; null for one that is not a public name. */
function cleanHost(h: string): string | null {
  const v = h.trim().toLowerCase().replace(/\.$/, "");
  return v && isPublicHost(v) ? v : null;
}

/**
 * The domain and host for the lines: the inbox's public address (its own host), and the business's
 * website (Settings), else what its host says the business's domain is, else the inbox's host minus
 * its first label when it is a name like inbox.<domain>.
 */
export function discoveryTarget(
  settings: Settings,
  publicUrl: string | undefined,
  hostDomain?: string | null | undefined,
): DiscoveryTarget {
  let host: string | null = null;
  try {
    if (publicUrl) host = cleanHost(new URL(publicUrl).hostname);
  } catch {
    host = null;
  }
  let domain: string | null = null;
  let domainFrom: DiscoveryTarget["domainFrom"] = null;
  try {
    if (settings.directory.url) {
      domain = cleanHost(new URL(settings.directory.url).hostname.replace(/^www\./, ""));
      if (domain) domainFrom = "website";
    }
  } catch {
    domain = null;
  }
  if (!domain && hostDomain) {
    domain = cleanHost(hostDomain);
    if (domain) domainFrom = "host";
  }
  if (!domain && host && host.split(".").length > 2) {
    domain = host.slice(host.indexOf(".") + 1);
    domainFrom = "inbox";
  }
  return { domain, domainFrom, host };
}

/** The view for a target and the business's name. */
export function discoveryView(target: DiscoveryTarget, name: string): DiscoveryView {
  const ready = target.domain && target.host;
  return {
    ...target,
    name,
    manifest: target.host ? `https://${target.host}${MANIFEST_PATH}` : null,
    snippets: ready ? discoverySnippets(target.domain as string, target.host as string, name) : null,
    checker: DEFAULT_NETWORK,
  };
}

const CHECK_TIMEOUT_MS = 25_000;
const CHECK_MAX_BYTES = 256 * 1024;

/**
 * Asks the network's discovery check about the view's domain and host: one GET, https only, no
 * redirect followed, a short timeout, at most 256 KiB read, and the answer held to the published
 * schema before anything is shown. `fetchImpl` is the host's outbound fetch (`pinnedFetch` on Node).
 */
export async function checkDiscovery(view: DiscoveryView, fetchImpl: typeof fetch = fetch): Promise<DiscoveryResult> {
  if (!view.domain || !view.host) {
    throw new WriteError("wrong_state", "Name your website in Settings first: the check reads it.");
  }
  const base = new URL(view.checker);
  if (base.protocol !== "https:" || !isPublicHost(base.hostname)) {
    throw new WriteError("internal", "The checker's address is not a public https one.");
  }
  const url = new URL(`/v1/discovery/${encodeURIComponent(view.domain)}`, base);
  url.searchParams.set("host", view.host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "surfingdog-inbox (+https://surfingdog.ai)" },
    });
  } catch {
    throw new WriteError("internal", "The check could not run just now. Try again in a minute.");
  } finally {
    clearTimeout(timer);
  }
  const text = await readUpTo(res, CHECK_MAX_BYTES);
  if (res.status === 429) throw new WriteError("too_many_attempts", "Checked a moment ago. Try again in a minute.");
  if (res.status === 422) {
    let detail = "This site can't be checked.";
    try {
      const p = JSON.parse(text ?? "") as { detail?: unknown };
      if (typeof p.detail === "string" && p.detail.length < 300) detail = p.detail;
    } catch {
      // the generic sentence stays
    }
    throw new WriteError("wrong_state", detail);
  }
  if (res.status !== 200 || text === null) {
    throw new WriteError("internal", "The check could not run just now. Try again in a minute.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WriteError("internal", "The checker answered something that is not a check.");
  }
  const result = discoveryResultSchema.safeParse(parsed);
  if (!result.success) throw new WriteError("internal", "The checker answered something that is not a check.");
  return result.data;
}

/** The body as text, or null past max bytes. */
async function readUpTo(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
