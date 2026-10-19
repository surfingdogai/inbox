import type { Statement } from "@surfingdog/platform";
import { type PingCarried, pingCarriedSchema } from "@surfingdog/spec";

/**
 * The requests a network carried to this inbox for people's AI assistants, and tried to (ADR-025,
 * network protocol §4.17): the `carried` block a network adds to its answer to a signed ping, counts
 * only over its last 30 days, kept per network for the owner alone. It lives in `network_cache`
 * (kind `carried`): what a network answered, kept for a while, three days past the ping that said
 * it, so a network that stops saying it stops being shown. Read leniently: a count that does not
 * read is left out, a block with no day it runs from is none.
 */

const KEEP_MS = 3 * 86_400_000;

export function readPingCarried(value: unknown): PingCarried | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const since = pingCarriedSchema.shape.since.safeParse(v.since);
  if (!since.success) return null;
  const count = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) < 1e9 ? (x as number) : 0);
  const not: Record<string, number> = {};
  if (typeof v.not_delivered === "object" && v.not_delivered !== null && !Array.isArray(v.not_delivered)) {
    for (const [k, n] of Object.entries(v.not_delivered as Record<string, unknown>).slice(0, 20)) {
      if (/^[a-z_]{1,40}$/.test(k) && count(n) > 0) not[k] = count(n);
    }
  }
  return { since: since.data, delivered: count(v.delivered), confirm: count(v.confirm), not_delivered: not };
}

/** Keeps the block a signed ping's answer carried, for three days; a ping that carries none keeps the last. */
export function networkCarriedStatement(network: string, now: number, carried: PingCarried): Statement {
  return {
    sql: `INSERT INTO network_cache (network, kind, key, value, expires_at, created_at) VALUES (?, 'carried', '', ?, ?, ?)
          ON CONFLICT (network, kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    params: [network, JSON.stringify(carried), now + KEEP_MS, now],
    method: "run",
  };
}
