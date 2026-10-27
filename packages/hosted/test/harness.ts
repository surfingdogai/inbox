import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SetupPlanInput, ulid } from "@surfingdog/core";
import { type LogMailOut, logMailOut, type OutboundMail } from "@surfingdog/platform";
import type { ControlPlane, TenantEvent } from "../src/control-plane";
import { shardOf } from "../src/host";
import { Ledger } from "../src/ledger";
import { CachedResolver } from "../src/resolver";
import { type Listening, serveRouter, serveShard } from "../src/server";
import { Shard } from "../src/shard";
import { signHeaders } from "../src/sign";
import { jsonOf, socketRequest } from "../src/sockets";
import type { HostedModel } from "../src/spam";
import { levelOf, type PolicyPayload, type TenantState } from "../src/types";

/**
 * A whole runtime in one test process: a fake control plane, a router and shards on real local
 * sockets in a directory of the test's own, and helpers to call the admin API (signed) and to make
 * requests as a browser or an agent would, by host name.
 */

export const PARENT = "example.net";
export const MASTER = "test-master-key-0123456789abcdef0123456789";
export const ADMIN_KEY = "test-admin-key-0123456789abcdef0123456789";
/** The key the router signs again with towards the shards; never the control plane's. */
export const SHARD_KEY = "test-shard-key-0123456789abcdef0123456789";
export const OWNER = "owner@example.com";
/** The key the email gateway signs its deliveries with (ADR-026 §1). */
export const INBOUND_KEY = "test-inbound-key-0123456789abcdef0123456789";
export const INBOUND_HOST = "mail-in.example.net";

export const salon: SetupPlanInput = {
  profile: { name: "Salão Rosa", timezone: "Europe/Lisbon", currency: "EUR", languages: ["pt", "en"] },
  directory: { listed: false, url: "" },
  hours: {
    mon: [["09:00", "18:00"]],
    tue: [["09:00", "18:00"]],
    wed: [["09:00", "18:00"]],
    thu: [["09:00", "18:00"]],
    fri: [["09:00", "18:00"]],
    sat: [["09:00", "18:00"]],
    sun: [["09:00", "18:00"]],
  },
  services: [{ name: "Corte", duration_min: 30 }],
  preset: "appointments",
  booking: { confirm: "owner" },
  doors: ["message", "quote_request", "booking"],
};

export interface FakeTenant {
  tenantId: string;
  slugHost: string;
  ownHost: string | null;
  /** Whether the own host resolves (its hostname is issuing, active or lost). */
  ownResolves: boolean;
  /** Whether the own host's record went (lost, within the grace): its address is the slug host again. */
  ownLost?: boolean;
  state: TenantState;
  prevState: TenantState | null;
  version: number;
  domain: string;
  jwks: { keys: Record<string, unknown>[] } | null;
  /** The policy's `join_networks`, when the test names it; absent, the payload leaves it out. */
  joinNetworks?: string[] | undefined;
  /** The control plane gives the inbox no address of its own (HOSTED_INBOUND_DOMAIN off). */
  noInbound?: boolean;
  /** Sending from the business's own address, as the control plane says it stands (ADR-026 §3). */
  own?: PolicyPayload["mail"]["own"];
  /** The policy's `spam` block (ADR-041 §15.3), when the test names one. */
  spam?: PolicyPayload["spam"];
}

let slugs = 0;
const WORDS = ["quiet", "brave", "amber", "misty", "lucky", "sunny", "rapid", "noble"];
const ANIMALS = ["otter", "heron", "finch", "lynx", "panda", "koala", "gecko", "bison"];
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newSlug(): string {
  const n = slugs++;
  const tail = Array.from({ length: 4 }, (_, i) => B32[(n * 7 + i * 13 + Date.now()) % 32]).join("");
  return `${WORDS[n % WORDS.length]}-${ANIMALS[Math.floor(n / WORDS.length) % ANIMALS.length]}-${tail}`;
}

export function policyOf(t: FakeTenant): PolicyPayload {
  const level = levelOf(t.state, t.prevState);
  const live = t.state === "live";
  return {
    tenant_id: t.tenantId,
    policy_version: t.version,
    state: t.state,
    level,
    agents: live ? "open" : "closed",
    address: level === 2 && t.ownHost && !t.ownLost ? `https://${t.ownHost}` : `https://${t.slugHost}`,
    site: level === 2 ? `https://${t.domain}` : null,
    owner_email: OWNER,
    mail: {
      from: `${t.slugHost.split(".")[0]}@mail.${PARENT}`,
      from_name: level === 2 ? "Salão Rosa" : "Surfing Dog Inbox",
      // What the held control plane once set: the owner's own address. The runtime takes it out
      // (ADR-026 §6): a customer's reply goes to its conversation's own address instead.
      reply_to: level === 2 ? OWNER : null,
      customer_mail: live,
      customer_daily_cap: live ? 200 : 0,
      ...(t.noInbound ? {} : { inbound: `${t.slugHost.split(".")[0]}@in.${PARENT}` }),
      ...(t.own !== undefined ? { own: t.own } : {}),
    },
    read_only: t.state === "closing" || t.state === "closed",
    suspended_reason: t.state === "suspended" ? "a test" : null,
    ...(t.joinNetworks ? { join_networks: t.joinNetworks } : {}),
    ...(t.spam ? { spam: t.spam } : {}),
  };
}

/** A control plane that holds its tenants in memory and keeps every event it is told. */
export class FakeControlPlane implements ControlPlane {
  readonly tenants = new Map<string, FakeTenant>();
  readonly events: TenantEvent[] = [];
  resolves = 0;
  policyPulls = 0;
  down = false;
  constructor(private readonly shards: number) {}

  async resolve(host: string) {
    this.resolves++;
    if (this.down) throw new Error("control plane down");
    for (const t of this.tenants.values()) {
      const kind = t.slugHost === host ? "slug" : t.ownHost === host && t.ownResolves ? "own" : null;
      if (!kind) continue;
      const level = levelOf(t.state, t.prevState);
      return {
        answer: {
          resolved: {
            tenantId: t.tenantId,
            kind,
            state: t.state,
            prevState: t.prevState,
            level,
            slugHost: t.slugHost,
            ownHost: t.ownHost,
            ownHostState: t.ownLost ? "lost" : t.ownResolves ? "active" : null,
            canonicalHost: level === 2 && t.ownHost ? t.ownHost : t.slugHost,
            agents: t.state === "live" ? "open" : "closed",
            policyVersion: t.version,
            shard: shardOf(t.tenantId, this.shards),
            ttlSeconds: 60,
          },
          policy: policyOf(t),
          jwks: t.jwks,
        },
        ttlSeconds: 60,
      } as const;
    }
    return { answer: null, ttlSeconds: 10 };
  }

  async policy(tenantId: string) {
    this.policyPulls++;
    if (this.down) throw new Error("control plane down");
    const t = this.tenants.get(tenantId);
    if (!t) throw new Error("no such tenant");
    return policyOf(t);
  }

  async event(e: TenantEvent) {
    if (this.down) throw new Error("control plane down");
    this.events.push(e);
  }
}

export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly json: unknown;
}

export interface Runtime {
  readonly dir: string;
  readonly cp: FakeControlPlane;
  readonly ledger: Ledger;
  readonly shards: Shard[];
  readonly resolver: CachedResolver;
  readonly mail: { from: OutboundMail["from"]; mail: OutboundMail }[];
  /**
   * Every address an inbox here tried to call (a network, a webhook): none is reached. A hosted inbox
   * joins its network once it is live, and a test must never call a real one.
   */
  readonly outbound: string[];
  readonly routerSocket: string;
  readonly shardSocket: (n: number) => string;
  /** Moves the shards' clock (their inboxes' too) forward. */
  later(ms: number): void;
  admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  http(
    host: string,
    method: string,
    path: string,
    o?: { headers?: Record<string, string>; body?: string | undefined },
  ): Promise<Reply>;
  /** Straight to a shard's socket, past the router. */
  direct(
    shard: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string | undefined,
  ): Promise<Reply>;
  createTenant(o?: { domain?: string; plan?: SetupPlanInput | null; joinNetworks?: string[] }): Promise<FakeTenant>;
  /** Moves a tenant to a state as the control plane does: a new policy pushed, the hosts invalidated. */
  setState(
    t: FakeTenant,
    state: TenantState,
    o?: { ownResolves?: boolean; prevState?: TenantState | null; ownLost?: boolean },
  ): Promise<void>;
  /** Signs the owner in at `host` by a handoff; returns the session cookie. */
  signIn(t: FakeTenant, host: string): Promise<string>;
  /** Delivers an email as the gateway does: signed, to the router's inbound name (ADR-026 §1). */
  mailIn(o: { to: string; from: string; raw: string; auth?: string; key?: string }): Promise<Reply>;
  shardOf(t: FakeTenant): Shard;
  close(): Promise<void>;
}

export async function startRuntime(
  o: {
    shards?: number;
    maxOpen?: number;
    maxTenantBytes?: number;
    client?: boolean;
    oauthRelayHost?: string;
    /** Our model for the spam filter's AI check (ADR-041 §7.2); none by default. */
    spamModel?: HostedModel | null;
    /** Where the shards' log lines go; nowhere by default. */
    log?: (line: string) => void;
  } = {},
): Promise<Runtime> {
  const n = o.shards ?? 2;
  const dir = mkdtempSync(join(tmpdir(), "sdh-"));
  const cp = new FakeControlPlane(n);
  const ledger = new Ledger(join(dir, "ledger.db"), { hashKey: "ledger-test-key" });
  const mail: { from: OutboundMail["from"]; mail: OutboundMail }[] = [];
  let clientDir: string | undefined;
  if (o.client !== false) {
    clientDir = join(dir, "client");
    mkdirSync(join(clientDir, "assets"), { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>Owner app</title><div id=app></div>");
    writeFileSync(join(clientDir, "assets", "app.js"), "console.log('app')");
    writeFileSync(join(clientDir, "favicon.svg"), "<svg/>");
  }
  const transports = new Map<string, LogMailOut>();
  const outbound: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    outbound.push(input instanceof Request ? input.url : String(input));
    throw new Error("test: no address outside the test is ever called");
  }) as typeof fetch;
  let offset = 0;
  const now = () => Date.now() + offset;
  const shards: Shard[] = [];
  const listening: Listening[] = [];
  const shardSocket = (i: number) => join(dir, `s${i}.sock`);
  const shardAdminSocket = (i: number) => join(dir, `s${i}a.sock`);
  for (let i = 0; i < n; i++) {
    const shard = new Shard({
      index: i,
      shards: n,
      dataDir: join(dir, "data"),
      masterKeys: [MASTER],
      controlPlane: cp,
      ledger,
      transport: (from) => {
        const key = `${from.address}|${from.name}`;
        let t = transports.get(key);
        if (!t) {
          const log = logMailOut(undefined, { delivers: true });
          t = {
            ...log,
            async send(m: OutboundMail) {
              mail.push({ from: m.from, mail: m });
              return await log.send(m);
            },
          } as LogMailOut;
          transports.set(key, t);
        }
        return t;
      },
      clientDir,
      fetchImpl,
      maxOpen: o.maxOpen,
      maxTenantBytes: o.maxTenantBytes,
      now,
      log: o.log ?? (() => {}),
      spamModel: o.spamModel ?? null,
    });
    await shard.start();
    shards.push(shard);
    listening.push(
      await serveShard(shard, { socket: shardSocket(i), adminSocket: shardAdminSocket(i), shardKey: SHARD_KEY }),
    );
  }
  const resolver = new CachedResolver({ controlPlane: cp, parent: PARENT });
  const routerSocket = join(dir, "r.sock");
  listening.push(
    await serveRouter({
      parent: PARENT,
      resolver,
      shards: n,
      shardSocket,
      shardAdminSocket,
      securityContact: "security@example.net",
      abuseContact: "abuse@example.net",
      adminKey: ADMIN_KEY,
      shardKey: SHARD_KEY,
      socket: routerSocket,
      adminSocket: join(dir, "a.sock"),
      oauthRelayHost: o.oauthRelayHost,
      inboundHost: INBOUND_HOST,
      inboundKey: INBOUND_KEY,
      log: () => {},
    }),
  );

  const reply = (r: { status: number; headers: Record<string, string>; body: Uint8Array }): Reply => {
    const text = new TextDecoder().decode(r.body);
    return { status: r.status, headers: r.headers, text, json: jsonOf(r.body) };
  };
  const admin = async (method: string, path: string, body?: unknown) => {
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const r = await socketRequest(join(dir, "a.sock"), {
      method,
      target: path,
      headers: { ...signHeaders(ADMIN_KEY, method, path, bytes), "content-type": "application/json" },
      body: bytes.byteLength ? bytes : undefined,
      timeoutMs: 60_000,
    });
    return { status: r.status, body: r.body.byteLength ? jsonOf(r.body) : undefined };
  };
  const http = async (
    host: string,
    method: string,
    path: string,
    opt: { headers?: Record<string, string>; body?: string | undefined } = {},
  ) =>
    reply(
      await socketRequest(routerSocket, {
        method,
        target: path,
        headers: { host, "cf-connecting-ip": "198.51.100.7", ...(opt.headers ?? {}) },
        body: opt.body === undefined ? undefined : new TextEncoder().encode(opt.body),
        timeoutMs: 60_000,
      }),
    );
  const direct = async (
    shard: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string | undefined,
  ) =>
    reply(
      await socketRequest(shardSocket(shard), {
        method,
        target: path,
        headers,
        body: body === undefined ? undefined : new TextEncoder().encode(body),
        timeoutMs: 60_000,
      }),
    );

  const push = async (t: FakeTenant) => {
    const r = await admin("PUT", `/admin/v1/tenants/${t.tenantId}/policy`, policyOf(t));
    if (r.status !== 200) throw new Error(`policy push answered ${r.status}: ${JSON.stringify(r.body)}`);
    const hosts = [t.slugHost, ...(t.ownHost ? [t.ownHost] : [])];
    const inv = await admin("POST", "/admin/v1/cache/invalidate", { hosts });
    if (inv.status !== 204) throw new Error(`invalidate answered ${inv.status}`);
  };

  const runtime: Runtime = {
    dir,
    cp,
    ledger,
    shards,
    resolver,
    mail,
    outbound,
    routerSocket,
    shardSocket,
    later(ms) {
      offset += ms;
    },
    admin,
    http,
    direct,
    async createTenant(c = {}) {
      const slug = newSlug();
      const domain = c.domain ?? `${slug.split("-")[1]}-${slugs}.example.com`;
      const t: FakeTenant = {
        tenantId: `tn_${ulid()}`,
        slugHost: `${slug}.${PARENT}`,
        ownHost: `inbox.${domain}`,
        ownResolves: false,
        state: "setup",
        prevState: null,
        version: 1,
        domain,
        jwks: null,
        joinNetworks: c.joinNetworks,
      };
      cp.tenants.set(t.tenantId, t);
      const created = await admin("POST", "/admin/v1/tenants", {
        tenant_id: t.tenantId,
        slug_host: t.slugHost,
        policy: policyOf(t),
      });
      if (created.status !== 201) throw new Error(`create answered ${created.status}: ${JSON.stringify(created.body)}`);
      if (c.plan !== null) {
        const planned = await admin("POST", `/admin/v1/tenants/${t.tenantId}/plan?dry_run=0`, c.plan ?? salon);
        if (planned.status !== 200) throw new Error(`plan answered ${planned.status}: ${JSON.stringify(planned.body)}`);
      }
      t.state = "dns_pending";
      t.version++;
      await push(t);
      return t;
    },
    async setState(t, state, s = {}) {
      if (state === "suspended" || state === "closing") t.prevState = s.prevState ?? t.state;
      else t.prevState = s.prevState ?? null;
      t.state = state;
      if (s.ownResolves !== undefined) t.ownResolves = s.ownResolves;
      if (s.ownLost !== undefined) t.ownLost = s.ownLost;
      t.version++;
      await push(t);
    },
    async signIn(t, host) {
      const made = await admin("POST", `/admin/v1/tenants/${t.tenantId}/handoff`, {
        email: OWNER,
        origin: `https://${host}`,
      });
      if (made.status !== 200) throw new Error(`handoff answered ${made.status}: ${JSON.stringify(made.body)}`);
      const url = new URL((made.body as { url: string }).url);
      const token = url.searchParams.get("token") ?? "";
      const posted = await http(host, "POST", "/auth/handoff", {
        headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://${host}` },
        body: new URLSearchParams({ token }).toString(),
      });
      const cookie = /(__Host-sdi_session=[^;]+)/.exec(posted.headers["set-cookie"] ?? "")?.[1];
      if (!cookie) throw new Error(`no session from the handoff (${posted.status}: ${posted.text.slice(0, 200)})`);
      return cookie;
    },
    async mailIn(m) {
      const slug = m.to.split("@")[0]?.split("+")[0] ?? "";
      const q = new URLSearchParams({ to: m.to, from: m.from, ...(m.auth ? { auth: m.auth } : {}) });
      const target = `/v1/inbound/${slug}?${q.toString()}`;
      const bytes = new TextEncoder().encode(m.raw);
      return reply(
        await socketRequest(routerSocket, {
          method: "POST",
          target,
          headers: {
            host: INBOUND_HOST,
            "content-type": "message/rfc822",
            ...signHeaders(m.key ?? INBOUND_KEY, "POST", target, bytes),
          },
          body: bytes,
          timeoutMs: 60_000,
        }),
      );
    },
    shardOf(t) {
      const s = shards[shardOf(t.tenantId, n)];
      if (!s) throw new Error("no shard");
      return s;
    },
    async close() {
      await Promise.all(listening.map((l) => l.close()));
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return runtime;
}

/** Whether a reply names the business anywhere: what a page for strangers below level 2 must never do. */
export function namesBusiness(text: string): boolean {
  return /Salão Rosa|Corte/.test(text);
}
