import type { ControlPlane } from "./control-plane";
import { classifyHost } from "./host";
import { MAX_TTL_SECONDS, type ResolveAnswer, type Resolved, type TenantResolver } from "./types";

/**
 * Finds the tenant for a host, asking the control plane at most once per host per answer's lifetime:
 * a tenant for up to 60 s (as long as the answer says), no tenant for 10 s. Concurrent requests for
 * one host share one question. Names under the parent that are not slug hosts, and single labels,
 * are never asked about. The cache holds a bounded number of hosts; `invalidate` drops some at once
 * (the control plane asks for it on every change of state).
 */
export class CachedResolver implements TenantResolver {
  private readonly cache = new Map<string, { readonly answer: ResolveAnswer | null; readonly until: number }>();
  private readonly pending = new Map<string, Promise<ResolveAnswer | null>>();
  /** Bumped by every `invalidate`: an answer asked for before it is not kept. */
  private generation = 0;

  constructor(
    private readonly o: {
      readonly controlPlane: ControlPlane;
      readonly parent: string;
      readonly maxEntries?: number | undefined;
      readonly now?: (() => number) | undefined;
    },
  ) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  async resolve(host: string): Promise<Resolved | null> {
    return (await this.lookup(host))?.resolved ?? null;
  }

  /** The whole answer: the tenant, its policy when the control plane sent one, a closed tenant's keys. */
  async lookup(host: string): Promise<ResolveAnswer | null> {
    if (classifyHost(host, this.o.parent).kind === "none") return null;
    const hit = this.cache.get(host);
    if (hit && hit.until > this.now()) {
      // Most recently used last, so the oldest is the first to go when the cache is full.
      this.cache.delete(host);
      this.cache.set(host, hit);
      return hit.answer;
    }
    const waiting = this.pending.get(host);
    if (waiting) return await waiting;
    const generation = this.generation;
    const asked = this.o.controlPlane
      .resolve(host)
      .then(({ answer, ttlSeconds }) => {
        if (generation === this.generation) this.store(host, answer, ttlSeconds);
        return answer;
      })
      .finally(() => this.pending.delete(host));
    this.pending.set(host, asked);
    return await asked;
  }

  private store(host: string, answer: ResolveAnswer | null, ttlSeconds: number): void {
    const ttl = Math.max(1, Math.min(MAX_TTL_SECONDS, ttlSeconds));
    this.cache.delete(host);
    this.cache.set(host, { answer, until: this.now() + ttl * 1000 });
    const max = this.o.maxEntries ?? 50_000;
    while (this.cache.size > max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  invalidate(hosts: readonly string[]): void {
    this.generation++;
    for (const host of hosts) this.cache.delete(host.toLowerCase());
  }

  get size(): number {
    return this.cache.size;
  }
}
