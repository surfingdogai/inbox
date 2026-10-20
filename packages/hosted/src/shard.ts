import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createHandoff,
  ensureNetworkPing,
  HANDOFF_TTL_MS,
  type OwnerEmailChange,
  userFromCookie,
} from "@surfingdog/adapters";
import {
  type Caller,
  createDb,
  type Db,
  ensureLifecycleSweep,
  nextDueAt,
  readSettings,
  WriteError,
} from "@surfingdog/core";
import type { Inbox } from "@surfingdog/inbox/app";
import type { MailOut } from "@surfingdog/platform";
import { type NodeSqliteClient, nodeSqliteClient } from "@surfingdog/platform/node";
import { ownerVerdict, readOnlyAllows } from "./allowlist";
import { type BuildDeps, buildInbox } from "./build";
import type { ControlPlane, EventType } from "./control-plane";
import { isTenantId, normalizeHost, SLUG_LABEL, shardOf } from "./host";
import { tenantSecretKey } from "./keys";
import { BLAME_WINDOW_MS, BLAMES_FOR_MAINTENANCE, type Ledger, monthOf } from "./ledger";
import { Lru } from "./lru";
import { lockedPage, neutralPage, notFound, unavailablePage, wantsHtml } from "./pages";
import { validatePlan } from "./plan";
import { archiveSandbox, probeDoors } from "./probe";
import { normalizePolicy, type PolicyPayload, policyPayloadSchema } from "./types";
import { fileBytes, hasFirst, monthRange, usageOf } from "./usage";
import type { Watchdog } from "./watchdog";

/**
 * A shard: one process that keeps some of the inboxes open and answers for them. Each inbox is one
 * SQLite file in a directory of its own; the shard keeps the ones in use open, up to a cap, closing
 * the least recently used. An inbox is built from its policy, which the shard pulls from the control
 * plane each time it builds one, so a push that was lost never leaves an inbox on old rules; a push
 * (`PUT …/policy`) or a newer version named by the router makes it build again.
 *
 * Jobs run only for inboxes that have one due: the shard keeps when each inbox's next job falls due
 * (core `nextDueAt`), and opens an inbox for its jobs only then.
 *
 * Whatever the router decided, a shard checks again: on a slug host, and for any inbox closed to
 * agents, only the owner's allowlist passes, and `GET /` shows the inbox only to a valid session.
 */

export interface TenantRecord {
  readonly tenant_id: string;
  readonly slug_host: string;
  readonly created_at: string;
}

interface Meta {
  first_agent_item_at?: string;
  first_confirmed_item_at?: string;
}

interface Entry {
  readonly tenantId: string;
  readonly policy: PolicyPayload;
  readonly client: NodeSqliteClient;
  readonly db: Db;
  readonly inbox: Inbox;
  refs: number;
  closing: boolean;
  meta: Meta;
}

export interface ShardOptions {
  readonly index: number;
  readonly shards: number;
  /** Inboxes live in `<dataDir>/tenants/<tenant id>/`. */
  readonly dataDir: string;
  readonly masterKeys: readonly string[];
  readonly controlPlane: ControlPlane;
  readonly ledger: Ledger;
  readonly transport: (from: { address: string; name: string }) => MailOut;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly clientDir?: string | undefined;
  /** The OAuth clients every inbox signs owners in to platforms with, and the one address they come back to. */
  readonly oauth?: BuildDeps["oauth"];
  readonly oauthRedirect?: BuildDeps["oauthRedirect"];
  /** Inboxes kept open at once (default 64). */
  readonly maxOpen?: number | undefined;
  /** An inbox's file, past which it takes no new writes (default 200 MB). */
  readonly maxTenantBytes?: number | undefined;
  readonly watchdog?: Watchdog | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

export const DEFAULT_MAX_OPEN = 64;
export const DEFAULT_MAX_TENANT_BYTES = 200 * 1024 * 1024;

const SYSTEM: Caller = {
  actor: { kind: "system", id: "hosted-setup", channel: "system" },
  tier: "verified_principal",
  sandbox: false,
};

/** Doors through which an agent makes a request; a first real one is told to the control plane. */
const AGENT_CREATES = new Set(["/v1/bookings", "/v1/orders", "/v1/quotes", "/v1/messages", "/mcp"]);

export type AdminAnswer = { readonly status: number; readonly body?: unknown };

const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}): AdminAnswer => ({
  status,
  body: { type: `https://surfingdog.ai/problems/${code}`, title: code, status, code, detail, ...extra },
});

export class Shard {
  private readonly open: Lru<string, Entry>;
  private readonly building = new Map<string, Promise<Entry>>();
  /** When each inbox on this shard next has a job due; null when none waits. */
  readonly due = new Map<string, number | null>();
  private ticking = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: ShardOptions) {
    this.open = new Lru<string, Entry>(o.maxOpen ?? DEFAULT_MAX_OPEN);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((line) => console.log(line));
    mkdirSync(this.tenantsDir(), { recursive: true, mode: 0o700 });
  }

  // ---- files -------------------------------------------------------------------------------------

  private tenantsDir(): string {
    return join(this.o.dataDir, "tenants");
  }

  private dir(id: string): string {
    return join(this.tenantsDir(), id);
  }

  dbPath(id: string): string {
    return join(this.dir(id), "inbox.db");
  }

  exists(id: string): boolean {
    return isTenantId(id) && existsSync(join(this.dir(id), "tenant.json"));
  }

  private readJson<T>(id: string, name: string): T | null {
    const file = join(this.dir(id), name);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private writeJson(id: string, name: string, value: unknown): void {
    const file = join(this.dir(id), name);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  }

  record(id: string): TenantRecord | null {
    return this.readJson<TenantRecord>(id, "tenant.json");
  }

  storedPolicy(id: string): PolicyPayload | null {
    const parsed = policyPayloadSchema.safeParse(this.readJson<unknown>(id, "policy.json"));
    return parsed.success && parsed.data.tenant_id === id ? normalizePolicy(parsed.data) : null;
  }

  /** The inboxes on this shard, by their directories. */
  tenants(): string[] {
    if (!existsSync(this.tenantsDir())) return [];
    return readdirSync(this.tenantsDir()).filter(
      (id) => isTenantId(id) && shardOf(id, this.o.shards) === this.o.index && this.exists(id),
    );
  }

  // ---- opening -----------------------------------------------------------------------------------

  /**
   * The policy to build with: the control plane's, pulled now; when it cannot be reached, the last
   * one stored here, but only if it is at least the version the router named. Otherwise nothing is
   * built: no inbox runs on rules older than the ones the router has seen.
   */
  private async policyFor(id: string, minVersion: number): Promise<PolicyPayload> {
    const stored = this.storedPolicy(id);
    let pulled: PolicyPayload | null = null;
    try {
      const answer = policyPayloadSchema.safeParse(await this.o.controlPlane.policy(id));
      if (!answer.success || answer.data.tenant_id !== id) throw new Error("not a policy for this tenant");
      pulled = normalizePolicy(answer.data);
    } catch (error) {
      this.log(
        `shard ${this.o.index}: policy for ${id} not pulled (${error instanceof Error ? error.message : error})`,
      );
    }
    const best = pulled && (!stored || pulled.policy_version >= stored.policy_version) ? pulled : stored;
    if (!best || best.policy_version < minVersion) throw new Error(`no policy of version ${minVersion} for ${id}`);
    if (best !== stored) this.writeJson(id, "policy.json", best);
    return best;
  }

  private async build(id: string, policy: PolicyPayload): Promise<Entry> {
    const raw = nodeSqliteClient(this.dbPath(id));
    const watchdog = this.o.watchdog;
    // Each query names the inbox it runs for, so a query that stalls the shard is blamed on it.
    const client: NodeSqliteClient = watchdog
      ? {
          ...raw,
          raw: raw.raw,
          close: () => raw.close(),
          query: (stmt) => {
            watchdog.setCurrent(id);
            return raw.query(stmt);
          },
          batch: (stmts) => {
            watchdog.setCurrent(id);
            return raw.batch(stmts);
          },
        }
      : raw;
    try {
      const db = createDb(client);
      const inbox = buildInbox({
        tenantId: id,
        policy,
        db,
        client: raw,
        dir: this.dir(id),
        secretKey: tenantSecretKey(this.o.masterKeys, id),
        ledger: this.o.ledger,
        transport: this.o.transport,
        fetchImpl: this.o.fetchImpl,
        clientDir: this.o.clientDir,
        oauth: this.o.oauth,
        oauthRedirect: this.o.oauthRedirect,
        // The tenant's phones are registered through the control plane, which vouches for the tenant.
        pushRegistrar: this.o.controlPlane.pushRegister
          ? (body: unknown) =>
              this.o.controlPlane.pushRegister?.(id, body) ?? Promise.reject(new Error("no control plane"))
          : undefined,
        onOwnerEmailChange: (change: OwnerEmailChange) =>
          this.event(id, change.how === "undone" ? "owner_email_undone" : "owner_email_changed", { to: change.to }),
        now: this.o.now,
      });
      // Migrated and set as the policy says before anything is served or run.
      await inbox.prepare();
      if (!policy.read_only) {
        await ensureLifecycleSweep(db, this.now());
        // Networks are told of an inbox only once it is live, and only if its owner joins one.
        if (policy.level === 2) await ensureNetworkPing(db, this.now());
      }
      const entry: Entry = {
        tenantId: id,
        policy,
        client: raw,
        db,
        inbox,
        refs: 0,
        closing: false,
        meta: this.readJson<Meta>(id, "meta.json") ?? {},
      };
      await this.refreshDue(entry);
      return entry;
    } catch (error) {
      raw.close();
      throw error;
    }
  }

  /** The inbox, open, held until `release`. Built again when its policy is older than `minVersion`. */
  async acquire(id: string, minVersion = 0, given?: PolicyPayload): Promise<Entry> {
    const current = this.open.get(id);
    if (current && !current.closing && current.policy.policy_version >= minVersion && !given) {
      current.refs++;
      return current;
    }
    let pending = this.building.get(id);
    if (!pending) {
      pending = (async () => {
        const policy = given ?? (await this.policyFor(id, minVersion));
        const entry = await this.build(id, policy);
        // A newer policy pushed while this one was being built: this caller gets what it asked
        // for, and nobody after it does.
        if ((this.storedPolicy(id)?.policy_version ?? 0) > policy.policy_version) {
          entry.closing = true;
          return entry;
        }
        const old = this.open.peek(id);
        if (old) this.retire(old);
        for (const [, out] of this.open.set(id, entry)) this.retire(out);
        return entry;
      })().finally(() => this.building.delete(id));
      this.building.set(id, pending);
    }
    const entry = await pending;
    entry.refs++;
    return entry;
  }

  release(entry: Entry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.closing && entry.refs === 0) this.closeEntry(entry);
  }

  private retire(entry: Entry): void {
    if (entry.closing) return;
    entry.closing = true;
    if (this.open.peek(entry.tenantId) === entry) this.open.delete(entry.tenantId);
    if (entry.refs === 0) this.closeEntry(entry);
  }

  private closeEntry(entry: Entry): void {
    try {
      entry.client.close();
    } catch {
      // already closed
    }
  }

  /** Closes the inbox's instance; the next request or job builds it again. */
  evict(id: string): void {
    const entry = this.open.peek(id);
    if (entry) this.retire(entry);
  }

  get openCount(): number {
    return this.open.size;
  }

  // ---- serving -----------------------------------------------------------------------------------

  /** A request the router passed on, with the tenant it found in `X-SD-Tenant`. */
  async handle(request: Request): Promise<Response> {
    const html = wantsHtml(request.headers.get("accept"));
    const id = request.headers.get("x-sd-tenant") ?? "";
    if (!this.exists(id)) return answer(notFound(html));
    const slug = request.headers.get("x-sd-host-kind") !== "own";
    const minVersion = Number.parseInt(request.headers.get("x-sd-policy-version") ?? "0", 10) || 0;
    if (this.o.ledger.maintenance(id)) return answer(unavailablePage(html, "maintenance"));
    let entry: Entry;
    try {
      entry = await this.acquire(id, minVersion);
    } catch (error) {
      this.log(`shard ${this.o.index}: ${id} not opened (${error instanceof Error ? error.message : error})`);
      return answer(unavailablePage(html, "unreachable"));
    }
    let handedOn = false;
    try {
      this.o.watchdog?.setCurrent(id);
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();
      const p = entry.policy;
      if (slug || p.agents === "closed") {
        const verdict = ownerVerdict({
          method,
          path,
          cookie: request.headers.get("cookie"),
          authorization: request.headers.get("authorization"),
        });
        if (verdict === "refuse") return answer(notFound(html));
        if (verdict === "neutral") return answer(neutralPage());
        // A cookie is not a session: `/` shows the inbox only to one that is.
        if (path === "/" && !(await userFromCookie(entry.db, request, this.now(), p.address))) {
          return answer(neutralPage());
        }
      }
      if (p.read_only && !readOnlyAllows(method, path)) return answer(lockedPage(html, "read_only"));
      const writes = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
      if (
        writes &&
        !readOnlyAllows(method, path) &&
        fileBytes(this.dbPath(id)) > (this.o.maxTenantBytes ?? DEFAULT_MAX_TENANT_BYTES)
      ) {
        return Response.json(
          {
            type: "https://surfingdog.ai/problems/storage_full",
            title: "Storage full",
            status: 507,
            code: "storage_full",
            detail: "This inbox has reached its storage limit. Reading, signing in and the download still work.",
          },
          { status: 507, headers: { "content-type": "application/problem+json" } },
        );
      }
      const response = await entry.inbox.app.fetch(request);
      if (writes) await this.afterWrite(entry, request, path, response);
      handedOn = true;
      return this.releasing(entry, response);
    } finally {
      this.o.watchdog?.setCurrent(null);
      if (!handedOn) this.release(entry);
    }
  }

  /** The response, with the inbox held open until its body has been read to the end. */
  private releasing(entry: Entry, response: Response): Response {
    if (!response.body) {
      this.release(entry);
      return response;
    }
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        this.release(entry);
      }
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        flush: finish,
        cancel: finish,
      } as Transformer<Uint8Array, Uint8Array>),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  private async afterWrite(entry: Entry, request: Request, path: string, response: Response): Promise<void> {
    const id = entry.tenantId;
    if (path === "/v1/owner/download" && response.status === 200) this.event(id, "download", {});
    if (
      !entry.meta.first_agent_item_at &&
      AGENT_CREATES.has(path) &&
      (response.status === 201 || response.status === 200) &&
      request.headers.get("x-sandbox") !== "1" &&
      (await hasFirst(entry.db, "agent"))
    ) {
      entry.meta = { ...entry.meta, first_agent_item_at: new Date(this.now()).toISOString() };
      this.writeJson(id, "meta.json", entry.meta);
      this.event(id, "first_agent_item", {});
    }
    await this.checkFirstConfirmed(entry);
    await this.refreshDue(entry);
  }

  private async checkFirstConfirmed(entry: Entry): Promise<void> {
    if (entry.meta.first_confirmed_item_at || !(await hasFirst(entry.db, "confirmed"))) return;
    entry.meta = { ...entry.meta, first_confirmed_item_at: new Date(this.now()).toISOString() };
    this.writeJson(entry.tenantId, "meta.json", entry.meta);
    this.event(entry.tenantId, "first_confirmed_item", {});
  }

  /** Queued in the ledger, so it reaches the control plane even across a restart. */
  event(id: string, type: EventType, data: Record<string, unknown>): void {
    this.o.ledger.queueEvent({ tenant_id: id, type, at: new Date(this.now()).toISOString(), data });
  }

  // ---- jobs --------------------------------------------------------------------------------------

  private async refreshDue(entry: Entry): Promise<void> {
    this.due.set(entry.tenantId, entry.policy.read_only ? null : await nextDueAt(entry.db));
  }

  /**
   * Reads when each inbox on this shard next has a job due, without building any of them, and puts
   * into maintenance any that stalled the shard three times in the last hour.
   */
  async start(): Promise<void> {
    const blames = this.o.ledger.unreportedBlames().filter((b) => shardOf(b.tenant_id, this.o.shards) === this.o.index);
    this.o.ledger.markBlamesReported(blames.map((b) => b.id));
    for (const blame of blames) {
      this.event(blame.tenant_id, "blamed", { at: new Date(blame.at).toISOString() });
      const since = this.now() - BLAME_WINDOW_MS;
      if (
        this.o.ledger.blamesSince(blame.tenant_id, since) >= BLAMES_FOR_MAINTENANCE &&
        this.o.ledger.setMaintenance(blame.tenant_id, "stalled the shard")
      ) {
        this.log(
          `shard ${this.o.index}: ${blame.tenant_id} is in maintenance: it stalled the shard ${BLAMES_FOR_MAINTENANCE} times in an hour`,
        );
        this.event(blame.tenant_id, "maintenance", { reason: "blocked" });
      }
    }
    for (const id of this.tenants()) {
      const policy = this.storedPolicy(id);
      if (!policy || policy.read_only) {
        this.due.set(id, null);
        continue;
      }
      const client = nodeSqliteClient(this.dbPath(id));
      try {
        this.due.set(id, await nextDueAt(createDb(client)).catch(() => this.now()));
      } finally {
        client.close();
      }
    }
  }

  /**
   * Runs the jobs of the inboxes that have one due, a few at a time, and passes on what the control
   * plane has still to be told. Called every second; a tick still running is not started again.
   */
  async tick(): Promise<{ ran: string[] }> {
    if (this.ticking) return { ran: [] };
    this.ticking = true;
    const ran: string[] = [];
    try {
      const now = this.now();
      const due = [...this.due.entries()]
        .filter(([, at]) => at !== null && at <= now)
        .sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0))
        .slice(0, 16)
        .map(([id]) => id);
      for (let i = 0; i < due.length; i += 4) {
        await Promise.all(
          due.slice(i, i + 4).map(async (id) => {
            if (this.o.ledger.maintenance(id) || !this.exists(id)) {
              this.due.set(id, this.o.ledger.maintenance(id) ? now + 60_000 : null);
              return;
            }
            let entry: Entry;
            try {
              entry = await this.acquire(id);
            } catch (error) {
              this.log(
                `shard ${this.o.index}: jobs for ${id} wait (${error instanceof Error ? error.message : error})`,
              );
              this.due.set(id, now + 60_000);
              return;
            }
            try {
              this.o.watchdog?.setCurrent(id);
              if (!entry.policy.read_only) {
                await entry.inbox.runner.runDue(entry.db, {
                  workerId: `shard-${this.o.index}`,
                  join: false,
                  now: this.now(),
                });
                await this.checkFirstConfirmed(entry);
              }
              await this.refreshDue(entry);
              ran.push(id);
            } finally {
              this.o.watchdog?.setCurrent(null);
              this.release(entry);
            }
          }),
        );
      }
      await this.flushEvents();
    } finally {
      this.ticking = false;
    }
    return { ran };
  }

  private async flushEvents(): Promise<void> {
    for (const e of this.o.ledger.claimEvents(20)) {
      try {
        await this.o.controlPlane.event({ tenant_id: e.tenant_id, type: e.type as EventType, at: e.at, data: e.data });
        this.o.ledger.eventDone(e.id);
      } catch {
        this.o.ledger.eventRetry(e.id, e.tries);
      }
    }
  }

  // ---- admin -------------------------------------------------------------------------------------

  /** One call of the admin API (C8.1) for an inbox on this shard, already checked as signed. */
  async admin(method: string, target: string, body: unknown): Promise<AdminAnswer> {
    const url = new URL(target, "http://shard.invalid");
    const parts = url.pathname.split("/").filter(Boolean);
    // /admin/v1/…
    if (parts[0] !== "admin" || parts[1] !== "v1") return problem(404, "not_found", "No such call.");
    const rest = parts.slice(2);
    if (rest[0] === "health" && rest.length === 1 && method === "GET") {
      const tenants = this.tenants();
      return {
        status: 200,
        body: {
          shard: this.o.index,
          tenants: tenants.length,
          open: this.open.size,
          due: [...this.due.values()].filter((at) => at !== null && at <= this.now()).length,
          maintenance: tenants.filter((id) => this.o.ledger.maintenance(id)).length,
        },
      };
    }
    if (rest[0] === "plans" && rest[1] === "validate" && rest.length === 2 && method === "POST") {
      const v = validatePlan(body);
      return v.ok
        ? { status: 200, body: { ok: true } }
        : problem(422, "invalid_input", "The plan is not valid.", { fields: v.fields });
    }
    if (rest[0] !== "tenants") return problem(404, "not_found", "No such call.");
    if (rest.length === 1 && method === "POST") return await this.create(body);
    const id = rest[1] ?? "";
    if (!isTenantId(id)) return problem(404, "not_found", "No such tenant.");
    if (shardOf(id, this.o.shards) !== this.o.index)
      return problem(421, "wrong_shard", "This tenant is on another shard.");
    if (!this.exists(id)) return problem(404, "not_found", "No such tenant.");
    const action = rest.slice(2).join("/");
    if (action === "" && method === "DELETE") return await this.remove(id);
    if (action === "policy" && method === "PUT") return this.putPolicy(id, body);
    if (action === "plan" && method === "POST")
      return await this.plan(id, body, url.searchParams.get("dry_run") === "1");
    if (action === "probe" && method === "POST") return await this.probe(id, body);
    if (action === "sandbox/archive" && method === "POST") return await this.archive(id, body);
    if (action === "handoff" && method === "POST") return await this.handoff(id, body);
    if (action === "usage" && method === "GET") return await this.usage(id, url.searchParams.get("month"));
    if (action === "networks/join" && method === "POST") return await this.joinNetworks(id);
    if (action === "jwks" && method === "GET")
      return await this.withEntry(id, async (e) => ({ status: 200, body: await e.inbox.caps.receipts.jwks() }));
    return problem(404, "not_found", "No such call.");
  }

  private async withEntry(id: string, work: (entry: Entry) => Promise<AdminAnswer>): Promise<AdminAnswer> {
    let entry: Entry;
    try {
      entry = await this.acquire(id);
    } catch (error) {
      return problem(503, "unavailable", error instanceof Error ? error.message : String(error));
    }
    try {
      this.o.watchdog?.setCurrent(id);
      return await work(entry);
    } finally {
      this.o.watchdog?.setCurrent(null);
      this.release(entry);
    }
  }

  private async create(body: unknown): Promise<AdminAnswer> {
    const b = (body ?? {}) as { tenant_id?: unknown; slug_host?: unknown; policy?: unknown };
    const id = typeof b.tenant_id === "string" ? b.tenant_id : "";
    const slugHost = typeof b.slug_host === "string" ? normalizeHost(b.slug_host) : null;
    const parsed = policyPayloadSchema.safeParse(b.policy);
    const fields = [
      ...(isTenantId(id) ? [] : [{ path: "tenant_id", problem: "invalid", message: "tn_ and a ULID" }]),
      ...(slugHost && SLUG_LABEL.test(slugHost.split(".")[0] ?? "")
        ? []
        : [{ path: "slug_host", problem: "invalid", message: "a slug host" }]),
      ...(parsed.success && parsed.data.tenant_id === id
        ? []
        : [{ path: "policy", problem: "invalid", message: "a policy for this tenant" }]),
    ];
    if (fields.length > 0 || !slugHost || !parsed.success) {
      return problem(422, "invalid_input", "The tenant cannot be created as sent.", { fields });
    }
    if (shardOf(id, this.o.shards) !== this.o.index)
      return problem(421, "wrong_shard", "This tenant is on another shard.");
    if (this.exists(id)) {
      const record = this.record(id);
      if (record?.slug_host !== slugHost) {
        return problem(409, "slug_mismatch", "This tenant exists with another slug host.");
      }
      return { status: 200, body: { tenant_id: id, shard: this.o.index } };
    }
    mkdirSync(this.dir(id), { recursive: true, mode: 0o700 });
    const policy = normalizePolicy(parsed.data);
    this.writeJson(id, "policy.json", policy);
    try {
      const entry = await this.acquire(id, 0, policy);
      this.release(entry);
    } catch (error) {
      rmSync(this.dir(id), { recursive: true, force: true });
      return problem(500, "not_created", error instanceof Error ? error.message : String(error));
    }
    // Written last: an inbox whose record exists was made whole.
    this.writeJson(id, "tenant.json", {
      tenant_id: id,
      slug_host: slugHost,
      created_at: new Date(this.now()).toISOString(),
    } satisfies TenantRecord);
    return { status: 201, body: { tenant_id: id, shard: this.o.index } };
  }

  private putPolicy(id: string, body: unknown): AdminAnswer {
    const parsed = policyPayloadSchema.safeParse(body);
    if (!parsed.success || parsed.data.tenant_id !== id) {
      return problem(422, "invalid_input", "Not a policy for this tenant.", {
        fields: parsed.success ? [{ path: "tenant_id", problem: "invalid", message: "this tenant's id" }] : [],
      });
    }
    const stored = this.storedPolicy(id);
    if (stored && parsed.data.policy_version < stored.policy_version) {
      return problem(409, "stale_version", "A newer policy is in place.", { policy_version: stored.policy_version });
    }
    if (stored && parsed.data.policy_version === stored.policy_version) {
      return { status: 200, body: { policy_version: stored.policy_version } };
    }
    const policy = normalizePolicy(parsed.data);
    this.writeJson(id, "policy.json", policy);
    this.evict(id);
    if (policy.read_only) this.due.set(id, null);
    else if (!this.due.has(id) || this.due.get(id) === null) this.due.set(id, this.now());
    return { status: 200, body: { policy_version: policy.policy_version } };
  }

  private async plan(id: string, body: unknown, dryRun: boolean): Promise<AdminAnswer> {
    return await this.withEntry(id, async (entry) => {
      if (entry.policy.read_only && !dryRun) return problem(423, "read_only", "This inbox is read-only.");
      try {
        const result = await entry.inbox.caps.applySetupPlan(SYSTEM, body as never, { dryRun });
        await this.refreshDue(entry);
        return { status: 200, body: result };
      } catch (error) {
        if (error instanceof WriteError) {
          return problem(error.code === "invalid_input" ? 422 : 409, error.code, error.message, {
            fields: error.fields ?? [],
          });
        }
        throw error;
      }
    });
  }

  /**
   * What a new inbox starts with (its policy's networks on and listed, `join_networks`), written to
   * one made before hosted inboxes joined from day one: by hand, never on its own (`join-networks`).
   * Held as any network is until the inbox is live at the business's own address. Twice is once.
   */
  private async joinNetworks(id: string): Promise<AdminAnswer> {
    return await this.withEntry(id, async (entry) => {
      if (entry.policy.read_only) return problem(423, "read_only", "This inbox is read-only.");
      const wrote = await entry.inbox.caps.applyHostSeed(this.now());
      await this.refreshDue(entry);
      const settings = await readSettings(entry.db);
      const networks = Object.entries(settings.networks).map(([origin, n]) => ({
        origin,
        on: n.enabled,
        ...(n.resume !== undefined ? { held: true, on_when_live: n.resume } : {}),
      }));
      return {
        status: 200,
        body: {
          changed: wrote,
          level: entry.policy.level,
          listed: settings.directory.listed,
          ...(settings.directory.resume !== undefined ? { listed_when_live: settings.directory.resume } : {}),
          networks,
        },
      };
    });
  }

  private async probe(id: string, body: unknown): Promise<AdminAnswer> {
    const doors = (body as { doors?: unknown } | null)?.doors;
    if (!Array.isArray(doors) || doors.length > 5 || !doors.every((d) => typeof d === "string")) {
      return problem(422, "invalid_input", 'Send the doors to test, like ["booking", "message"].');
    }
    return await this.withEntry(id, async (entry) => {
      if (entry.policy.read_only) return problem(423, "read_only", "This inbox is read-only.");
      // An instance of its own, with the doors open, over the inbox's file: never served to anyone.
      const tester = buildInbox({
        tenantId: id,
        policy: entry.policy,
        db: entry.db,
        client: entry.client,
        dir: this.dir(id),
        secretKey: tenantSecretKey(this.o.masterKeys, id),
        ledger: this.o.ledger,
        transport: this.o.transport,
        fetchImpl: this.o.fetchImpl,
        agentsOpen: true,
        now: this.o.now,
      });
      const results = await probeDoors(tester, entry.policy.address, doors as string[]);
      await this.refreshDue(entry);
      return { status: 200, body: { results } };
    });
  }

  private async archive(id: string, body: unknown): Promise<AdminAnswer> {
    const keep = (body as { keep?: unknown } | null)?.keep;
    if (keep !== "example" && keep !== "none") return problem(422, "invalid_input", 'keep is "example" or "none".');
    return await this.withEntry(id, async (entry) => ({ status: 200, body: await archiveSandbox(entry.db, keep) }));
  }

  private async handoff(id: string, body: unknown): Promise<AdminAnswer> {
    const b = (body ?? {}) as { email?: unknown; origin?: unknown };
    if (typeof b.email !== "string" || typeof b.origin !== "string") {
      return problem(422, "invalid_input", "Send the owner's email and the origin to sign in at.");
    }
    let origin: string;
    try {
      origin = new URL(b.origin).origin;
    } catch {
      return problem(422, "invalid_input", "origin is not a URL.");
    }
    const email = b.email.trim().toLowerCase();
    return await this.withEntry(id, async (entry) => {
      // A handoff signs in only at the inbox's canonical name: the slug host until it is live, then its own.
      if (origin !== entry.policy.address) {
        return problem(409, "origin_not_canonical", `This inbox is at ${entry.policy.address}.`, {
          address: entry.policy.address,
        });
      }
      const { rows } = await entry.db.client.query({
        sql: "SELECT 1 FROM users WHERE lower(email) = ? LIMIT 1",
        params: [email],
        method: "all",
      });
      if (email !== entry.policy.owner_email.toLowerCase() && rows.length === 0) {
        return problem(409, "not_owner", "That address does not sign in to this inbox.");
      }
      const now = this.now();
      const made = await createHandoff(entry.db, { email, origin, now });
      return { status: 200, body: { url: made.url, expires_at: new Date(now + HANDOFF_TTL_MS).toISOString() } };
    });
  }

  private async usage(id: string, month: string | null): Promise<AdminAnswer> {
    const m = month ?? monthOf(this.now());
    const range = monthRange(m);
    if (!range) return problem(422, "invalid_input", "month is YYYY-MM.");
    return await this.withEntry(id, async (entry) => ({
      status: 200,
      body: {
        ...(await usageOf(entry.db, range)),
        mail_sent: this.o.ledger.mailSent(id, m),
        db_bytes: fileBytes(this.dbPath(id)),
      },
    }));
  }

  /** Deletes a closed inbox's file, after taking its public keys for whoever keeps serving them. */
  private async remove(id: string): Promise<AdminAnswer> {
    const stored = this.storedPolicy(id);
    if (stored?.state !== "closed") return problem(409, "not_closed", "Only a closed inbox is deleted.");
    const jwks = await this.withEntry(id, async (entry) => ({
      status: 200,
      body: await entry.inbox.caps.receipts.jwks(),
    }));
    if (jwks.status !== 200) return jwks;
    this.evict(id);
    // Requests still being answered finish first; nothing new is built for a closed inbox.
    const deadline = this.now() + 10_000;
    while (this.building.has(id) && this.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    rmSync(this.dir(id), { recursive: true, force: true });
    this.due.delete(id);
    return { status: 200, body: { jwks: jwks.body } };
  }
}

function answer(a: { status: number; headers: Record<string, string>; body: string }): Response {
  return new Response(a.body, { status: a.status, headers: a.headers });
}
