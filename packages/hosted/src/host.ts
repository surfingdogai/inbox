/**
 * Host names, as the router reads them before it asks anyone who an inbox is.
 *
 * Every inbox here answers at two names: its slug host, `<word>-<word>-<4 base32>` one label under
 * the parent this runtime is given (the setup address, which never serves agents), and, once the
 * business connects it, a name of the business's own that points here. Nothing else under the parent
 * is an inbox: `*.<targets label>.<parent>` names are what a business's record points at, and are
 * never answered as a tenant.
 */

/** A slug: two words and four base32 characters, one label. */
export const SLUG_LABEL = /^[a-z]+-[a-z]+-[a-z2-7]{4}$/;

/** One LDH label: letters, digits and hyphens, 1–63 characters, no hyphen at either end. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host a request asked for, lower-cased, without its port or a trailing dot; null for anything
 * that is not a DNS name of LDH labels (253 characters at most), and for an IP literal. A request
 * with such a `Host` gets 400 from the router.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  // An IPv6 literal, with or without a port, is never an inbox.
  if (host.startsWith("[")) return null;
  const colon = host.indexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (!labels.every((label) => LABEL.test(label))) return null;
  // A name whose last label is all digits is an IPv4 address (or nothing anyone can register).
  if (/^\d+$/.test(labels[labels.length - 1] ?? "")) return null;
  return host;
}

/**
 * What a normalised host is to this runtime:
 * - `slug`: a slug host, exactly one slug label under the parent;
 * - `own`: a name outside the parent, which may be a business's own (only the control plane knows);
 * - `none`: the parent itself, any other name under it (CNAME targets included), or a name of one
 *   label: never a tenant, answered 404 without asking anyone.
 */
export type HostClass = { readonly kind: "slug" | "own"; readonly host: string } | { readonly kind: "none" };

export function classifyHost(host: string, parent: string): HostClass {
  if (host === parent) return { kind: "none" };
  if (host.endsWith(`.${parent}`)) {
    const rest = host.slice(0, -(parent.length + 1));
    return !rest.includes(".") && SLUG_LABEL.test(rest) ? { kind: "slug", host } : { kind: "none" };
  }
  return host.includes(".") ? { kind: "own", host } : { kind: "none" };
}

/** FNV-1a, 32 bits, over the UTF-8 bytes of `s`: the default placement of a tenant on a shard. */
export function fnv1a32(s: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The shard a tenant lives on unless the control plane pins it elsewhere. */
export function shardOf(tenantId: string, shards: number): number {
  if (!Number.isInteger(shards) || shards < 1) throw new Error("shards must be a positive integer");
  return fnv1a32(tenantId) % shards;
}

/** `tn_` and a ULID: the only tenant ids this runtime accepts, from anyone. */
export const TENANT_ID = /^tn_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}
