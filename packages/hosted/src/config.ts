import { dirname, join } from "node:path";
import { outboundDenyFrom } from "@surfingdog/inbox/env";
import {
  type AddressRange,
  cloudflareEmailRestMailOut,
  consoleMailOut,
  type MailOut,
  resendMailOut,
} from "@surfingdog/platform";
import { normalizeHost } from "./host";
import { parseMasterKeys } from "./keys";

/**
 * The runtime's settings, all from the environment. Nothing about where it runs is built in: the
 * parent name, every socket and the data directory are what the operator says.
 *
 * - `HOSTED_SLUG_PARENT`: the name slug hosts sit one label under.
 * - `HOSTED_SHARDS`: how many shards (default 4).
 * - `HOSTED_ROUTER_SOCKET`, `HOSTED_ADMIN_SOCKET`: the router's public and admin sockets.
 * - `HOSTED_SHARD_SOCKET_DIR`: where the shards' sockets go (default: beside the router's).
 * - `HOSTED_CP_SOCKET`: the control plane's socket.
 * - One key for each caller and direction, each process reading only its own: `HOSTED_ADMIN_KEY`
 *   (control plane → router), `HOSTED_SHARD_KEY` (router → shards), `HOSTED_CP_ROUTER_KEY` (router →
 *   control plane) and `HOSTED_CP_SHARD_KEY` (shards → control plane).
 * - `HOSTED_MASTER_KEY`: what every inbox's own key is derived from (comma-separated, newest first);
 *   the shards' alone.
 * - `HOSTED_DATA_DIR`: the inboxes' files and the shared ledger.
 * - `HOSTED_SECURITY_CONTACT`, `HOSTED_ABUSE_CONTACT`: where security reports and reports about an
 *   inbox go. `HOSTED_REPORT_FORM` (optional): an https report form, linked with the inbox's host.
 * - `HOSTED_OPEN_PER_SHARD` (default 64), `HOSTED_MAX_TENANT_MB` (default 200).
 * - `HOSTED_SHARD_HEAP_MB`: a cap on each shard's JavaScript heap when `all` starts them (the
 *   service manager's memory limit is the hard one).
 * - `INBOX_STATIC`: the owner app's build; `INBOX_OUTBOUND_DENY`: more addresses no call reaches.
 * - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (the shards'): the Google client every inbox
 *   signs owners in to Google Calendar with; without both, Google shows as "Soon" (ADR-022).
 * - `HOSTED_OAUTH_RELAY_HOST` (router and shards): the one name Google sends every owner back to,
 *   `https://<it>/oauth/google/callback`, registered once on the Google client; the router passes
 *   the owner on to their own inbox from there. Unset, each inbox uses its own callback.
 * - Mail: the same settings as the inbox's own Node server (`MAIL_FROM` is not needed: every inbox
 *   sends from its own pinned address).
 */
export interface HostedConfig {
  readonly parent: string;
  readonly shards: number;
  readonly routerSocket: string;
  readonly adminSocket: string;
  readonly shardSocketDir: string;
  readonly cpSocket: string;
  readonly adminKey: string;
  readonly shardKey: string;
  readonly cpRouterKey: string;
  readonly cpShardKey: string;
  readonly masterKeys: readonly string[];
  readonly dataDir: string;
  readonly securityContact: string;
  readonly abuseContact: string;
  readonly reportForm: string | undefined;
  readonly openPerShard: number;
  readonly maxTenantBytes: number;
  readonly shardHeapMb: number | undefined;
  readonly clientDir: string | undefined;
  readonly deny: readonly AddressRange[];
  readonly google: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly oauthRelayHost: string | undefined;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`hosted settings: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const positiveInt = (value: string | undefined, fallback: number): number | null => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Which process reads the settings: each needs (and is given) only its own keys. `tool` is a
 * command run by hand on an inbox's files (`maintenance-off`).
 */
export type Role = "router" | "shard" | "all" | "tool";

export function readConfig(env: Record<string, string | undefined>, role: Role = "all"): HostedConfig {
  const problems: string[] = [];
  const router = role === "router" || role === "all";
  const shard = role === "shard" || role === "all";
  const need = (name: string, needed = true): string => {
    const value = env[name]?.trim();
    if (!value && needed) problems.push(`${name} is not set`);
    return value ?? "";
  };
  const parent = normalizeHost(need("HOSTED_SLUG_PARENT", role !== "tool"));
  if (env.HOSTED_SLUG_PARENT && !parent) problems.push("HOSTED_SLUG_PARENT is not a host name");
  const shards = positiveInt(env.HOSTED_SHARDS, 4);
  if (shards === null || shards > 64) problems.push("HOSTED_SHARDS is a whole number from 1 to 64");
  const routerSocket = need("HOSTED_ROUTER_SOCKET", router);
  const keys = {
    HOSTED_ADMIN_KEY: need("HOSTED_ADMIN_KEY", router),
    HOSTED_SHARD_KEY: need("HOSTED_SHARD_KEY", router || shard),
    HOSTED_CP_ROUTER_KEY: need("HOSTED_CP_ROUTER_KEY", router),
    HOSTED_CP_SHARD_KEY: need("HOSTED_CP_SHARD_KEY", shard),
  };
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(keys)) {
    if (!value) continue;
    if (value.length < 32) problems.push(`${name} is shorter than 32 characters`);
    const other = seen.get(value);
    if (other) problems.push(`${other} and ${name} are the same: one key for each caller and direction`);
    seen.set(value, name);
  }
  const masterKeys = parseMasterKeys(need("HOSTED_MASTER_KEY", shard || role === "tool"));
  if (masterKeys[0] !== undefined && masterKeys[0].length < 32)
    problems.push("HOSTED_MASTER_KEY is shorter than 32 characters");
  const open = positiveInt(env.HOSTED_OPEN_PER_SHARD, 64);
  if (open === null) problems.push("HOSTED_OPEN_PER_SHARD is a positive whole number");
  const maxMb = positiveInt(env.HOSTED_MAX_TENANT_MB, 200);
  if (maxMb === null) problems.push("HOSTED_MAX_TENANT_MB is a positive whole number");
  const heap = env.HOSTED_SHARD_HEAP_MB?.trim() ? positiveInt(env.HOSTED_SHARD_HEAP_MB, 0) : undefined;
  if (heap === null) problems.push("HOSTED_SHARD_HEAP_MB is a positive whole number");
  const reportForm = env.HOSTED_REPORT_FORM?.trim() || undefined;
  if (reportForm !== undefined) {
    let ok = false;
    try {
      const u = new URL(reportForm);
      ok = u.protocol === "https:" && u.search === "" && u.hash === "" && normalizeHost(u.hostname) !== null;
    } catch {
      ok = false;
    }
    if (!ok) problems.push("HOSTED_REPORT_FORM is an https address with no query, like https://example.com/report");
  }
  const deny = outboundDenyFrom(env.INBOX_OUTBOUND_DENY);
  const googleId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "";
  const googleSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "";
  if (shard && Boolean(googleId) !== Boolean(googleSecret)) {
    problems.push("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET go together");
  }
  const relayRaw = env.HOSTED_OAUTH_RELAY_HOST?.trim();
  const oauthRelayHost = relayRaw ? (normalizeHost(relayRaw) ?? undefined) : undefined;
  if (relayRaw && !oauthRelayHost) problems.push("HOSTED_OAUTH_RELAY_HOST is not a host name");
  if (deny.bad.length > 0) problems.push(`INBOX_OUTBOUND_DENY: ${deny.bad.join(", ")} is not an address or a range`);
  const shardSocketDir = env.HOSTED_SHARD_SOCKET_DIR?.trim() || (routerSocket ? dirname(routerSocket) : "");
  if (!shardSocketDir && (router || shard)) problems.push("HOSTED_SHARD_SOCKET_DIR is not set");
  const config = {
    parent: parent ?? "",
    shards: shards ?? 4,
    routerSocket,
    adminSocket: need("HOSTED_ADMIN_SOCKET", router),
    shardSocketDir,
    cpSocket: need("HOSTED_CP_SOCKET", router || shard),
    adminKey: keys.HOSTED_ADMIN_KEY,
    shardKey: keys.HOSTED_SHARD_KEY,
    cpRouterKey: keys.HOSTED_CP_ROUTER_KEY,
    cpShardKey: keys.HOSTED_CP_SHARD_KEY,
    masterKeys,
    dataDir: need("HOSTED_DATA_DIR", shard || role === "tool"),
    securityContact: need("HOSTED_SECURITY_CONTACT", router),
    abuseContact: need("HOSTED_ABUSE_CONTACT", router),
    reportForm,
    openPerShard: open ?? 64,
    maxTenantBytes: (maxMb ?? 200) * 1024 * 1024,
    shardHeapMb: heap ?? undefined,
    clientDir: env.INBOX_STATIC?.trim() || undefined,
    deny: deny.ranges,
    google: googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : null,
    oauthRelayHost,
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

export const shardSocket = (c: HostedConfig, shard: number): string => join(c.shardSocketDir, `shard-${shard}.sock`);
export const shardAdminSocket = (c: HostedConfig, shard: number): string =>
  join(c.shardSocketDir, `shard-${shard}-admin.sock`);
export const ledgerPath = (c: HostedConfig): string => join(c.dataDir, "ledger.db");

/**
 * The mail transport for one sender, from the same settings the inbox's Node server reads: a REST
 * transport sends only from the address it is made with, so each inbox gets one made with its own.
 * With no mail service set, mail is written to the log (and is never recorded as delivered).
 */
export function transportFrom(
  env: Record<string, string | undefined>,
): (from: { address: string; name: string }) => MailOut {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_EMAIL_TOKEN?.trim();
  const resend = env.RESEND_API_KEY?.trim();
  if (account && token) return (from) => cloudflareEmailRestMailOut({ accountId: account, token, from });
  if (resend) {
    return (from) => resendMailOut(resend, undefined, from);
  }
  const fallback = consoleMailOut();
  return () => fallback;
}
