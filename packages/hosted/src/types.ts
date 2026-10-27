import { z } from "zod";
import { isTenantId, normalizeHost } from "./host";

/** Which of a tenant's two names a request asked for. */
export type HostKind = "slug" | "own";

export const TENANT_STATES = [
  "setup",
  "dns_pending",
  "cert_pending",
  "live",
  "suspended",
  "closing",
  "closed",
] as const;
export type TenantState = (typeof TENANT_STATES)[number];

/** A tenant, as the router finds it by the name a request asked for. */
export interface Resolved {
  /** `tn_` + ULID. */
  readonly tenantId: string;
  /** Which of the tenant's hosts was asked for. */
  readonly kind: HostKind;
  readonly state: TenantState;
  /** For a suspended or closing tenant: the state it came from (and returns to, when suspended). */
  readonly prevState: TenantState | null;
  /** 2 when the tenant is live, or suspended or closing from live; 1 otherwise. */
  readonly level: 1 | 2;
  readonly slugHost: string;
  /** The business's own name for it, once chosen; null before. */
  readonly ownHost: string | null;
  /**
   * Where that own name stands, when the control plane says (`issuing`, `active`, `lost`…): while it
   * is `lost` (its record went, within the grace) the owner is served at the slug host again.
   */
  readonly ownHostState?: string | null | undefined;
  /** `ownHost` at level 2, else `slugHost`. */
  readonly canonicalHost: string;
  /** Open only while the tenant is live. */
  readonly agents: "open" | "closed";
  /** Monotonic: a shard holding an instance built under a lower one builds it again. */
  readonly policyVersion: number;
  readonly shard: number;
  /** At most 60. */
  readonly ttlSeconds: number;
}

export interface TenantResolver {
  /** Null: not a tenant of this runtime (the router answers 404). */
  resolve(host: string): Promise<Resolved | null>;
  invalidate(hosts: readonly string[]): void;
}

/** The level a state means, as the router and the shards both work it out. */
export function levelOf(state: TenantState, prevState: TenantState | null): 1 | 2 {
  if (state === "live") return 2;
  if ((state === "suspended" || state === "closing") && prevState === "live") return 2;
  return 1;
}

const host = z.string().transform((value, ctx) => {
  const normal = normalizeHost(value);
  if (normal === null || normal !== value.toLowerCase()) {
    ctx.addIssue({ code: "custom", message: "not a host name" });
    return z.NEVER;
  }
  return normal;
});

const httpsOrigin = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value && normalizeHost(url.hostname) !== null;
    } catch {
      return false;
    }
  },
  { message: "an https origin, like https://inbox.example.com" },
);

const tenantId = z.string().refine(isTenantId, { message: "tn_ and a ULID" });
const state = z.enum(TENANT_STATES);

/** The plans a hosted inbox is on (ADR-041 §15.3). */
export const PLANS = ["free", "pro"] as const;
export type Plan = (typeof PLANS)[number];

/**
 * What the control plane says an inbox may do (its policy), pushed on every change and pulled on
 * every rebuild. `policy_version` only grows. Whatever the payload says, a shard never opens the
 * agents' doors, names a website or writes to customers below level 2 (`normalizePolicy`).
 */
export const policyPayloadSchema = z.looseObject({
  tenant_id: tenantId,
  policy_version: z.number().int().min(0),
  state,
  level: z.union([z.literal(1), z.literal(2)]),
  agents: z.enum(["open", "closed"]),
  address: httpsOrigin,
  site: httpsOrigin.nullable(),
  owner_email: z.email(),
  mail: z.looseObject({
    from: z.email(),
    from_name: z.string().min(1).max(200),
    reply_to: z.email().nullable(),
    customer_mail: z.boolean(),
    customer_daily_cap: z.number().int().min(0),
    /**
     * The inbox's own address (ADR-026 §1), e.g. `<slug>@surfingdog.email`: the gateway delivers what
     * is sent or forwarded to it, and each conversation is one of its plus addresses. Absent from a
     * control plane that has none: the inbox then has no address of its own.
     */
    inbound: z.email().optional(),
    /**
     * Sending from the business's own address (ADR-026 §3), as the control plane says it stands: the
     * address asked for, the DNS rows to add with what its last look found, and whether email goes
     * from it now (`verified`, and then `from` is it). Absent or null: not asked for.
     */
    own: z
      .looseObject({
        address: z.email().nullable(),
        state: z.enum(["none", "dns", "verifying", "verified", "failed", "unavailable"]),
        records: z
          .array(
            z.looseObject({
              type: z.enum(["CNAME", "TXT", "MX"]),
              name: z.string().max(253),
              value: z.string().max(1024),
              priority: z.number().int().min(0).max(65_535).optional(),
              ok: z.boolean().optional(),
              purpose: z.string().max(120).optional(),
            }),
          )
          .max(12),
        checked_at: z.string().max(40).nullable().optional(),
        problem: z.string().max(500).nullable().optional(),
        /** Where the business's DNS is run, and its steps for adding the rows (the control plane's providers). */
        dns_provider: z
          .looseObject({ name: z.string().min(1).max(80), steps: z.array(z.string().max(400)).max(10) })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  }),
  read_only: z.boolean(),
  suspended_reason: z.string().max(2_000).nullable(),
  /** The business's own domain, and the control plane's page where the owner connects it: shown in Settings. */
  domain: host.optional(),
  connect_url: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
  /**
   * The networks a new inbox here joins, as https origins: switched on with its very first settings,
   * listed in their directories, held off until it is live at the business's own address (level 2)
   * and on from then, for the owner to switch off. Absent, the inbox's own default network
   * (`DEFAULT_NETWORK`); empty, none. An inbox that already has settings is never changed by it,
   * except by the admin call `POST /admin/v1/tenants/{id}/networks/join`.
   */
  join_networks: z.array(httpsOrigin).max(8).optional(),
  /**
   * The inbox's plan, as the control plane's billing says (ADR-041 §15.3): `pro` includes the spam
   * filters (Sales pitches, Scams, Junk), read by our AI and on from the start; `free` keeps basic
   * protection, with no AI. Absent: free (`planOf`). A beta tester's free month is `pro` for as long
   * as the control plane says so, and `free` again after it.
   */
  // A plan this runtime does not know reads as Free, never as a broken policy.
  plan: z.enum(PLANS).optional().catch(undefined),
  /**
   * The account that owns the inbox, as the control plane keeps it (ADR-041 §16): its id, so two inboxes
   * of one owner count as one owner on the shared list of known spam, and when it was made, so a new
   * account's marks wait their week. Absent: the inbox is its own owner, by its tenant id (never by
   * `owner_email`, which an owner can change), and its age is counted from when this runtime first opened
   * it. One that does not read reads as absent.
   */
  owner_account: z
    .looseObject({ id: z.string().min(1).max(128), created_at: z.iso.datetime({ offset: true }) })
    .optional()
    .catch(undefined),
  /**
   * Pro given for free, with no card (a beta tester's month, ADR-041 §15.3): until when, the moment it
   * ends. Absent while Pro is paid for, or on Free. One that does not read reads as absent.
   */
  gift: z
    .looseObject({ until: z.iso.datetime({ offset: true }) })
    .optional()
    .catch(undefined),
  /**
   * The spam filter's limits on our AI (ADR-041 §15.3), when the control plane sets them: `ai: false`
   * stops our AI reading for this inbox whatever its plan; the AI check's caps a day and a month.
   * `ai_owner: true` (a Pro given for free): the owner switches our AI in Settings → Spam, and `ai` is
   * what they last chose, as the control plane has it; their switch goes to it as a `spam_ai` event.
   * Absent: our AI reads for Pro inboxes, at most 150 checks a day and 1,500 a month.
   */
  spam: z
    .looseObject({
      ai: z.boolean().optional(),
      ai_owner: z.boolean().optional().catch(undefined),
      day_cap: z.number().int().min(0).max(10_000).optional(),
      month_cap: z.number().int().min(0).max(100_000).optional(),
    })
    .optional(),
});
export type PolicyPayload = z.infer<typeof policyPayloadSchema>;

/** The inbox's plan: what the policy says, and Free when it says nothing. */
export function planOf(p: Pick<PolicyPayload, "plan">): Plan {
  return p.plan === "pro" ? "pro" : "free";
}

/**
 * A policy as a shard applies it: the agents' doors open only while the tenant is live (and, for
 * reading only, while it closes after being live: its manifest is still served), the website and
 * customer mail only at level 2, and a closing or closed tenant read-only. Each of these holds even
 * when a payload says otherwise, so one wrong field at the control plane opens nothing.
 */
export function normalizePolicy(p: PolicyPayload): PolicyPayload {
  const level2 = p.level === 2 && (p.state === "live" || p.state === "suspended" || p.state === "closing");
  const open = (p.state === "live" && p.agents === "open") || (p.state === "closing" && level2);
  return {
    ...p,
    level: level2 ? 2 : 1,
    agents: open ? "open" : "closed",
    site: level2 ? p.site : null,
    mail: {
      ...p.mail,
      // Never the address the owner signs in with: a customer never sees it (ADR-026 §6).
      reply_to: level2 && p.mail.reply_to?.toLowerCase() !== p.owner_email.toLowerCase() ? p.mail.reply_to : null,
      customer_mail: level2 && p.state === "live" && p.mail.customer_mail,
      customer_daily_cap: level2 ? p.mail.customer_daily_cap : 0,
    },
    read_only: p.read_only || p.state === "closing" || p.state === "closed",
  };
}

/** The control plane's answer to `GET /internal/v1/resolve?host=`, as it comes over the wire. */
const resolveWireSchema = z.looseObject({
  tenant_id: tenantId,
  kind: z.enum(["slug", "own"]),
  state,
  prev_state: state.nullable().optional(),
  slug_host: host,
  own_host: host.nullable().optional(),
  own_host_state: z.string().max(32).nullable().optional(),
  policy_version: z.number().int().min(0),
  shard: z.number().int().min(0).optional(),
  ttl_seconds: z.number().int().min(0).optional(),
  policy: z.unknown().optional(),
  /** For a closed tenant: the public keys it signed with, which keep serving. */
  jwks: z
    .looseObject({ keys: z.array(z.record(z.string(), z.unknown())) })
    .nullable()
    .optional(),
});

/** A resolve, with what the router needs beyond `Resolved`. */
export interface ResolveAnswer {
  readonly resolved: Resolved;
  readonly policy: PolicyPayload | null;
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] } | null;
}

/** snake_case keys from camelCase ones, one level deep: the control plane may send either. */
export function snakeKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      v,
    ]),
  );
}

export const MAX_TTL_SECONDS = 60;

/**
 * The control plane's answer for `host`, checked: null when it does not hold together (a slug host
 * that is not the tenant's slug host, an own host that is not its own host). Level, agents and the
 * canonical host are worked out here from the state, never taken from the wire.
 */
export function parseResolveAnswer(
  host: string,
  body: unknown,
  opts: { readonly shards: number; readonly shardOf: (tenantId: string) => number },
): ResolveAnswer | null {
  const parsed = resolveWireSchema.safeParse(snakeKeys(body));
  if (!parsed.success) return null;
  const w = parsed.data;
  const prevState = w.prev_state ?? null;
  const ownHost = w.own_host ?? null;
  if (w.kind === "slug" && w.slug_host !== host) return null;
  if (w.kind === "own" && ownHost !== host) return null;
  const level = levelOf(w.state, prevState);
  if (level === 2 && ownHost === null) return null;
  const shard = w.shard !== undefined && w.shard < opts.shards ? w.shard : opts.shardOf(w.tenant_id);
  const policy = w.policy === undefined || w.policy === null ? null : policyPayloadSchema.safeParse(w.policy);
  return {
    resolved: {
      tenantId: w.tenant_id,
      kind: w.kind,
      state: w.state,
      prevState,
      level,
      slugHost: w.slug_host,
      ownHost,
      ownHostState: w.own_host_state ?? null,
      canonicalHost: level === 2 && ownHost ? ownHost : w.slug_host,
      agents: w.state === "live" ? "open" : "closed",
      policyVersion: w.policy_version,
      shard,
      ttlSeconds: Math.max(1, Math.min(MAX_TTL_SECONDS, w.ttl_seconds ?? MAX_TTL_SECONDS)),
    },
    policy: policy?.success ? normalizePolicy(policy.data) : null,
    jwks: w.jwks ?? null,
  };
}
