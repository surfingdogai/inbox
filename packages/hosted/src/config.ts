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
 * - `HOSTED_ADMIN_KEY` (control plane → runtime), `HOSTED_CP_KEY` (runtime → control plane).
 * - `HOSTED_MASTER_KEY`: what every inbox's own key is derived from (comma-separated, newest first).
 * - `HOSTED_DATA_DIR`: the inboxes' files and the shared ledger.
 * - `HOSTED_SECURITY_CONTACT`, `HOSTED_ABUSE_CONTACT`: where security reports and reports about an
 *   inbox go. `HOSTED_REPORT_FORM` (optional): an https report form, linked with the inbox's host.
 * - `HOSTED_OPEN_PER_SHARD` (default 64), `HOSTED_MAX_TENANT_MB` (default 200).
 * - `HOSTED_SHARD_HEAP_MB`: a cap on each shard's JavaScript heap when `all` starts them (the
 *   service manager's memory limit is the hard one).
 * - `INBOX_STATIC`: the owner app's build; `INBOX_OUTBOUND_DENY`: more addresses no call reaches.
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
  readonly cpKey: string;
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

export function readConfig(env: Record<string, string | undefined>): HostedConfig {
  const problems: string[] = [];
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is not set`);
    return value ?? "";
  };
  const parent = normalizeHost(need("HOSTED_SLUG_PARENT"));
  if (env.HOSTED_SLUG_PARENT && !parent) problems.push("HOSTED_SLUG_PARENT is not a host name");
  const shards = positiveInt(env.HOSTED_SHARDS, 4);
  if (shards === null || shards > 64) problems.push("HOSTED_SHARDS is a whole number from 1 to 64");
  const routerSocket = need("HOSTED_ROUTER_SOCKET");
  const adminKey = need("HOSTED_ADMIN_KEY");
  const cpKey = need("HOSTED_CP_KEY");
  if (adminKey && adminKey.length < 32) problems.push("HOSTED_ADMIN_KEY is shorter than 32 characters");
  if (cpKey && cpKey.length < 32) problems.push("HOSTED_CP_KEY is shorter than 32 characters");
  if (adminKey && adminKey === cpKey)
    problems.push("HOSTED_ADMIN_KEY and HOSTED_CP_KEY are the same: one key per direction");
  const masterKeys = parseMasterKeys(need("HOSTED_MASTER_KEY"));
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
  if (deny.bad.length > 0) problems.push(`INBOX_OUTBOUND_DENY: ${deny.bad.join(", ")} is not an address or a range`);
  const config = {
    parent: parent ?? "",
    shards: shards ?? 4,
    routerSocket,
    adminSocket: need("HOSTED_ADMIN_SOCKET"),
    shardSocketDir: env.HOSTED_SHARD_SOCKET_DIR?.trim() || (routerSocket ? dirname(routerSocket) : ""),
    cpSocket: need("HOSTED_CP_SOCKET"),
    adminKey,
    cpKey,
    masterKeys,
    dataDir: need("HOSTED_DATA_DIR"),
    securityContact: need("HOSTED_SECURITY_CONTACT"),
    abuseContact: need("HOSTED_ABUSE_CONTACT"),
    reportForm,
    openPerShard: open ?? 64,
    maxTenantBytes: (maxMb ?? 200) * 1024 * 1024,
    shardHeapMb: heap ?? undefined,
    clientDir: env.INBOX_STATIC?.trim() || undefined,
    deny: deny.ranges,
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
