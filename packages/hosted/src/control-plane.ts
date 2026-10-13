import { shardOf } from "./host";
import { signHeaders } from "./sign";
import { jsonOf, socketRequest } from "./sockets";
import {
  normalizePolicy,
  type PolicyPayload,
  parseResolveAnswer,
  policyPayloadSchema,
  type ResolveAnswer,
} from "./types";

/**
 * The control plane, as this runtime asks it things: who a host is, what a tenant's policy is, and
 * what happened (an owner's new address, a download, a tenant put into maintenance). The real one
 * listens on a local socket and signs nothing back; tests pass their own.
 */
export interface ControlPlane {
  /** Null: no tenant answers to `host`. `ttlSeconds` is how long that answer may be kept. */
  resolve(host: string): Promise<{ answer: ResolveAnswer | null; ttlSeconds: number }>;
  /** The tenant's policy now. Throws when it cannot be had: nothing is built on a guess. */
  policy(tenantId: string): Promise<PolicyPayload>;
  /** Tells it something happened. Throws when it was not taken, so the caller can try again. */
  event(e: TenantEvent): Promise<void>;
}

export const EVENT_TYPES = [
  "owner_email_changed",
  "owner_email_undone",
  "download",
  "first_agent_item",
  "first_confirmed_item",
  "maintenance",
  "blamed",
  "mail_paused",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface TenantEvent {
  readonly tenant_id: string;
  readonly type: EventType;
  /** ISO 8601. */
  readonly at: string;
  readonly data: Record<string, unknown>;
}

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

/** The negative answer is kept this long unless the control plane says otherwise. */
export const NEGATIVE_TTL_SECONDS = 10;

/** The control plane over its local socket, every call signed with the runtime's key for that direction. */
export function socketControlPlane(o: {
  readonly socketPath: string;
  readonly key: string;
  readonly shards: number;
  readonly timeoutMs?: number | undefined;
}): ControlPlane {
  const call = async (method: string, target: string, body?: unknown) => {
    const bytes = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
    return await socketRequest(o.socketPath, {
      method,
      target,
      headers: {
        ...signHeaders(o.key, method, target, bytes ?? new Uint8Array()),
        ...(bytes ? { "content-type": "application/json" } : {}),
      },
      body: bytes,
      timeoutMs: o.timeoutMs ?? 5_000,
    });
  };
  return {
    async resolve(host) {
      const res = await call("GET", `/internal/v1/resolve?host=${encodeURIComponent(host)}`);
      const body = jsonOf(res.body) as Record<string, unknown> | null;
      if (res.status === 404) {
        const ttl = Number(body?.ttl_seconds ?? body?.ttlSeconds);
        return { answer: null, ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 60) : NEGATIVE_TTL_SECONDS };
      }
      if (res.status !== 200) throw new ControlPlaneError(`resolve answered ${res.status}`, res.status);
      const answer = parseResolveAnswer(host, body, {
        shards: o.shards,
        shardOf: (id) => shardOf(id, o.shards),
      });
      // An answer that does not hold together is no answer: the host gets 404 for a short while.
      if (!answer) return { answer: null, ttlSeconds: NEGATIVE_TTL_SECONDS };
      return { answer, ttlSeconds: answer.resolved.ttlSeconds };
    },
    async policy(tenantId) {
      const res = await call("GET", `/internal/v1/tenants/${encodeURIComponent(tenantId)}/policy`);
      if (res.status !== 200) throw new ControlPlaneError(`policy answered ${res.status}`, res.status);
      const parsed = policyPayloadSchema.safeParse(jsonOf(res.body));
      if (!parsed.success || parsed.data.tenant_id !== tenantId) {
        throw new ControlPlaneError("policy is not a policy for this tenant", 502);
      }
      return normalizePolicy(parsed.data);
    },
    async event(e) {
      const res = await call("POST", "/internal/v1/events", e);
      if (res.status !== 204 && res.status !== 200)
        throw new ControlPlaneError(`events answered ${res.status}`, res.status);
    },
  };
}
